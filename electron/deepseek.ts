import { randomUUID } from 'node:crypto';
import type { LocalStore } from './store';
import {
  executeComputerTool,
  executeReadOnlyTool,
  isComputerTool,
  isMutatingTool,
  prepareMutatingTool,
} from './tools';
import { ALL_TOOL_NAMES, getToolDefinitions, validateToolCallArguments } from './tool-schema';
import { saveArtifact } from './artifacts';
import { loadProjectMemoryForPrompt } from './projectMemory';
import { computeRequestCostUsd, isPeakTime, type RequestUsage } from './pricing';
import type {
  AgentEvent,
  AppSettings,
  ApprovalPreview,
  ChatMessage,
  CompactResult,
  SessionRecord,
  ToolJournalEntry,
  ToolJournalStatus,
} from './types';

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface StreamResult {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  promptTokens?: number;
  completionTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

// Not a working limit — the user explicitly asked for no practical cap on large tasks
// (self-upgrade builds, long automations). This is only a last-resort circuit breaker
// against a genuinely runaway loop; no real task should ever come close to it.
const MAX_AGENT_CYCLES = 500;
// Fallback output ceiling used when a settings value is missing or non-positive. Never leave
// max_tokens unset: an unbounded completion is the most expensive request the app can make.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
const MAX_INVALID_TOOL_STREAK = 3;
// COST LEVER: every cycle of the agent loop resends the ENTIRE conversation so far, and DeepSeek
// bills cache-miss tokens on anything past the cached prefix. The bigger the context is allowed
// to grow before compacting, the more that repeated resend costs across a long multi-cycle run —
// this is the single biggest cost driver in the app, not the file/attachment size caps. Compacting
// earlier keeps each cycle's resend small; compaction still preserves everything via a summary +
// verified tool ledger, so it costs nothing in capability, only in token volume.
const CONTEXT_WARNING_RATIO = 0.35;
const CONTEXT_COMPACT_RATIO = 0.5;
const KEEP_VISIBLE_MESSAGES = 8;
const KEEP_API_MESSAGES = 10;

// Hard cap on how much of a single tool result ever enters the API context. A 120k-char build
// log or source dump is ~35k tokens that then gets resent on EVERY later cycle of the same run,
// so the ceiling is deliberately tight. The tail is preserved because build/test errors and
// summaries live at the end of command output.
const MAX_TOOL_RESULT_CHARS = 12_000;
// How many verified tool-ledger lines are re-sent as a system message, and the per-line caps.
// COST LEVER - the ledger is rebuilt on every tool call, so every character in it is
// re-billed as a cache miss on the tail of each request. 12 recent entries is enough to
// remind the model what actually ran; the full transcript is still in the conversation.
const TOOL_LEDGER_ENTRIES = 12;
const TOOL_LEDGER_COMPACT_ENTRIES = 24;
const TOOL_LEDGER_SUMMARY_CHARS = 140;
const TOOL_LEDGER_TARGET_CHARS = 90;
// Vision parts are the priciest tokens in the payload, so a single turn sends at most this many
// images (the user can attach at most 4) even though the store keeps them all for the UI.
const MAX_IMAGES_PER_MESSAGE = 4;
// Cap for the transcript handed to a compaction call, so compacting stays cheap.
const COMPACTION_TRANSCRIPT_CHARS = 120_000;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_FETCH_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 180_000;

// One AbortController per live run, so the UI "Dừng" button can cancel an in-flight request
// instead of leaving the user to wait out a long multi-cycle run (and pay for it).
const activeRunControllers = new Map<string, AbortController>();

export function stopAgentRun(runId: string): boolean {
  const controller = activeRunControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function clearAgentRun(runId: string): void {
  activeRunControllers.delete(runId);
  activeRunSteering.delete(runId);
}

// Steering channel: a message the user types WHILE the agent is already working. Instead of
// waiting for the whole run to finish (the old "queue" behaviour), the interrupt aborts the answer
// currently being streamed, lets the model address the new message right away, and then the loop
// carries on with the original task. `softAbort` is separate from the user's hard "Dung" stop so
// the two can never be confused with each other.
interface SteerItem {
  text: string;
}

interface RunSteering {
  pending: SteerItem[];
  softAbort: AbortController;
}

const activeRunSteering = new Map<string, RunSteering>();

export function hasActiveAgentRun(runId: string): boolean {
  return activeRunSteering.has(runId);
}

/** Queues a mid-run message and interrupts whatever the run is currently streaming. */
export function injectAgentMessage(runId: string, text: string): boolean {
  const steering = activeRunSteering.get(runId);
  const trimmed = text.trim();
  if (!steering || !trimmed) return false;
  steering.pending.push({ text: trimmed });
  if (!steering.softAbort.signal.aborted) steering.softAbort.abort();
  return true;
}

/** Steering messages that never reached the conversation (the run died first). */
export function takePendingInjected(runId: string): SteerItem[] {
  const steering = activeRunSteering.get(runId);
  if (!steering) return [];
  return steering.pending.splice(0, steering.pending.length);
}

// How many tokens of input the app is willing to send in one request: the user's own budget,
// never above the model's real context window.
function effectiveContextLimit(settings: AppSettings): number {
  const budget = settings.maxInputTokens > 0 ? settings.maxInputTokens : settings.contextWindowTokens;
  return Math.max(16_000, Math.min(settings.contextWindowTokens, Math.round(budget)));
}

// Structural subset of Electron's WebContents that runAgent actually needs. A real WebContents
// satisfies this automatically (desktop UI keeps working unchanged); a WebSocket connection to a
// phone can implement the same two methods to receive the exact same event stream.
export interface AgentEventSink {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface AgentRunnerOptions {
  runId: string;
  sessionId: string;
  store: LocalStore;
  webContents: AgentEventSink;
  requestApproval: (
    runId: string,
    toolName: string,
    args: unknown,
    preview: ApprovalPreview,
  ) => Promise<boolean>;
  // Runs JS inside the desktop window's docked web preview <webview> (see webview_fill tool
  // below). Only available on the real desktop window — undefined for the phone remote session,
  // which has no webview of its own.
  execInWebview?: (script: string) => Promise<unknown>;
}

export async function runAgent(options: AgentRunnerOptions): Promise<void> {
  const { runId, sessionId, store, webContents, requestApproval, execInWebview } = options;
  const runController = new AbortController();
  activeRunControllers.set(runId, runController);
  const runSignal = runController.signal;
  const steering: RunSteering = { pending: [], softAbort: new AbortController() };
  activeRunSteering.set(runId, steering);
  const settings = store.getSettings();
  const apiKey = store.getApiKey();
  let session = store.getSession(sessionId);
  const workingDirectory: string | null = session.workingDirectory;
  const fullControl = settings.fullControl;
  const effectiveProjectRoot = workingDirectory ?? process.cwd();

  const storedCompaction = await compactStoredSession({
    sessionId,
    store,
    force: false,
  });
  if (storedCompaction.changed) {
    emit(webContents, {
      runId,
      type: 'context-compacted',
      beforeTokens: storedCompaction.beforeTokens,
      afterTokens: storedCompaction.afterTokens,
      contextLimit: storedCompaction.contextLimit,
      message: storedCompaction.message,
    });
    session = store.getSession(sessionId);
  }

  const projectMemory = session.workingDirectory ? await loadProjectMemoryForPrompt(session.workingDirectory) : null;
  let messages = buildSessionApiMessages(session, settings, projectMemory);
  let displayedContent = '';
  let requestIndex = 0;
  let contextWarningEmitted = false;
  let invalidToolName = '';
  let invalidToolStreak = 0;
  // Hybrid thinking bookkeeping for this run: 'auto' follows the plan (thinking on the first
  // request of a turn only), 'on'/'off' are sticky overrides chosen by the self-healing fallback.
  let thinkingMode: 'auto' | 'on' | 'off' = 'auto';
  let thinkingFallbackUsed = false;

  let stopped = false;
  // Stable id for the assistant message of the CURRENT turn, so the streamed text can be
  // persisted (and updated) while the run is still going.
  let streamingMessageId: string | null = null;
  const persistStreaming = () => {
    const text = displayedContent;
    if (!text.trim()) return;
    if (!streamingMessageId) streamingMessageId = randomUUID();
    try {
      store.upsertStreamingAssistant(sessionId, streamingMessageId, text);
    } catch {
      // Persisting mid-run is best effort; the final write below is authoritative.
    }
  };

  for (let cycle = 0; cycle < MAX_AGENT_CYCLES; cycle += 1) {
    if (runSignal.aborted) {
      stopped = true;
      break;
    }

    // Steering: answer whatever the user typed mid-run before asking the model for a new turn.
    // Done here, at the top of a cycle, because the previous turn is already fully closed
    // (assistant tool_calls + exactly one tool message per call) - the API rejects a user message
    // wedged inside that pair.
    if (steering.pending.length > 0) {
      const partial = displayedContent.trim();
      // Freeze what the model already wrote as a normal stored message so the transcript keeps a
      // sensible order: partial answer, then the user's interruption, then the reply to it.
      if (partial) {
        if (streamingMessageId) store.upsertStreamingAssistant(sessionId, streamingMessageId, partial);
        else store.addMessage(sessionId, 'assistant', partial);
      }
      streamingMessageId = null;
      emit(webContents, { runId, type: 'assistant-committed', finalContent: partial });
      displayedContent = '';
      const injected = steering.pending.splice(0, steering.pending.length);
      for (const item of injected) {
        const stored = store.addMessage(sessionId, 'user', item.text);
        messages.push({ role: 'user', content: item.text });
        emit(webContents, {
          runId,
          type: 'user-injected',
          message: item.text,
          messageId: stored?.id,
        });
      }
    }

    const contextLimit = effectiveContextLimit(settings);
    const beforeEstimate = estimateApiContextTokens(messages);
    if (
      beforeEstimate >= contextLimit * CONTEXT_WARNING_RATIO &&
      !contextWarningEmitted
    ) {
      contextWarningEmitted = true;
      emit(webContents, {
        runId,
        type: 'context-warning',
        beforeTokens: beforeEstimate,
        contextLimit,
        budgetLimit: settings.maxInputTokens,
        message: `Ngữ cảnh gửi đi đang ~${formatTokenCount(beforeEstimate)} token, gần mức trần ${formatTokenCount(contextLimit)}. App sẽ nén phần cũ thành bản tóm tắt để không đẩy chi phí lên.`,
      });
    }

    if (beforeEstimate >= contextLimit * CONTEXT_COMPACT_RATIO) {
      const compacted = await compactApiMessages({
        messages,
        settings,
        apiKey,
        workingDirectory: workingDirectory ?? '(no project folder selected)',
        toolJournal: store.getSession(sessionId).toolJournal,
        sessionId,
        store,
        signal: runSignal,
      });
      if (compacted.changed) {
        messages = compacted.messages;
        emit(webContents, {
          runId,
          type: 'context-compacted',
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          contextLimit,
          budgetLimit: settings.maxInputTokens,
          message: 'Đã tự nén ngữ cảnh giữa lúc chạy để giữ chi phí thấp.',
        });
      }

      // Hard fallback: if the request still does not fit the budget (compaction disabled,
      // oversized tool output, huge screenshots...), drop the oldest turns rather than paying
      // for a giant context on every remaining cycle.
      const afterCompact = estimateApiContextTokens(messages);
      if (afterCompact > contextLimit) {
        const trimmed = trimApiMessagesToBudget(messages, contextLimit);
        if (trimmed.dropped > 0) {
          messages = trimmed.messages;
          emit(webContents, {
            runId,
            type: 'context-trimmed',
            beforeTokens: afterCompact,
            afterTokens: estimateApiContextTokens(messages),
            contextLimit,
            budgetLimit: settings.maxInputTokens,
            message: `Đã bỏ ${trimmed.dropped} lượt cũ khỏi ngữ cảnh gửi đi để giữ chi phí thấp. Toàn bộ nội dung gốc vẫn được lưu trong phiên chat này.`,
          });
        }
      }
    }

    // A fresh interrupt channel per cycle: the steering message that triggered the previous
    // interruption has already been consumed above, so its abort must not leak into this turn.
    const softAbort = new AbortController();
    steering.softAbort = softAbort;
    const cycleSignal = combineAbortSignals(runSignal, softAbort.signal);

    requestIndex += 1;
    let cycleHasText = false;
    let result: StreamResult;

    const callModel = (effort: AppSettings['reasoningEffort'], outbound: ApiMessage[]) =>
      streamChatCompletion({
        baseUrl: settings.baseUrl,
        apiKey,
        model: settings.model,
        temperature: settings.temperature,
        reasoningEffort: effort,
        maxOutputTokens: settings.maxOutputTokens,
        messages: outbound,
        enableTools: (Boolean(workingDirectory) || fullControl) && settings.enabledTools.length > 0,
        fullControl,
        enabledTools: settings.enabledTools,
        signal: cycleSignal,
        onRetry: (message) => emit(webContents, { runId, type: 'retry', message }),
        onDelta: (delta) => {
          if (!delta) return;
          if (!cycleHasText && requestIndex > 1 && displayedContent.trim()) {
            displayedContent += '\n\n';
            emit(webContents, { runId, type: 'assistant-delta', delta: '\n\n' });
          }
          cycleHasText = true;
          displayedContent += delta;
          emit(webContents, { runId, type: 'assistant-delta', delta });
        },
      });

    // COST LEVER - hybrid thinking. thinking mode is the expensive half of a run: DeepSeek bills
    // reasoning tokens as OUTPUT, and on a tool run the chain of thought of every previous turn is
    // replayed back into the context as well, so a 12-round loop pays for its own thoughts a dozen
    // times over. The plan for a turn is worth generating once; the mechanical 'run this tool, look
    // at the result' cycles after it are not. So thinking is on for the first request of the turn
    // and off (thinking:{type:'disabled'}, effort 'none') for the follow-up cycles, which get the
    // same history with the reasoning_content fields stripped.
    const deepSeekProvider = isDeepSeekBaseUrl(settings.baseUrl);
    const hybridThinking = settings.hybridThinking !== false && settings.reasoningEffort !== 'none';
    const thinkingAvailable = deepSeekProvider
      && settings.reasoningEffort !== 'none'
      && !sessionsWithoutThinking.has(sessionId);
    const useThinking = thinkingMode === 'on'
      || (thinkingMode === 'auto' && thinkingAvailable && (!hybridThinking || requestIndex === 1));
    let attemptEffort: AppSettings['reasoningEffort'] = useThinking ? settings.reasoningEffort : 'none';
    // CACHE LEVER - never mutate the message array between cycles of the same run. Stripping
    // reasoning_content for the non-thinking follow-up cycles made the payload differ from the
    // previous request, so the prefix cache missed on every cycle of every run. The array is now
    // sent exactly as built; only the thinking flags below change.
    const attemptMessages: ApiMessage[] = messages;

    try {
      result = await callModel(attemptEffort, attemptMessages);
    } catch (error) {
      if (runSignal.aborted) {
        stopped = true;
        break;
      }
      if (softAbort.signal.aborted) {
        // The user typed a message while this answer was streaming. Drop this partial turn (it is
        // already on screen and will be frozen above) and go answer them on the next loop pass.
        continue;
      }
      // Self-healing: DeepSeek answers 400 when a request carrying tools does not replay the
      // reasoning_content of previous turns, and it also refuses it in the other direction when a
      // conversation started in thinking mode is continued without it. Whichever way the provider
      // complains, flip this one request and remember the direction that worked for the session
      // instead of failing the whole run.
      if (!deepSeekProvider || thinkingFallbackUsed || !isThinkingModeRejection(error)) throw error;
      thinkingFallbackUsed = true;
      if (attemptEffort !== 'none') {
        sessionsWithoutThinking.add(sessionId);
        thinkingMode = 'off';
        emit(webContents, {
          runId,
          type: 'retry',
          message: 'API từ chối lịch sử suy luận cũ; lượt chạy này chuyển sang chế độ không suy luận.',
        });
        attemptEffort = 'none';
      } else {
        sessionsWithoutThinking.delete(sessionId);
        thinkingMode = 'on';
        emit(webContents, {
          runId,
          type: 'retry',
          message: 'API yêu cầu giữ suy luận cho hội thoại này; bật lại thinking mode.',
        });
        attemptEffort = settings.reasoningEffort;
      }
      result = await callModel(attemptEffort, attemptMessages);
    }
    recordUsage(store, sessionId, settings.model, result);
    // The answer so far is real work the user paid for - write it down before the next tool
    // cycle, so closing the app mid-run cannot erase it.
    persistStreaming();

    if (result.toolCalls.length === 0) {
      if (result.finishReason === 'tool_calls') {
        throw new Error('Model báo có gọi tool nhưng không đọc được lệnh gọi hợp lệ. Chưa có thao tác nào được thực thi.');
      }
      if (steering.pending.length > 0) {
        // The user steered us in the exact moment the model was writing its closing answer. Loop
        // once more so their message is answered instead of being silently swallowed.
        continue;
      }
      // 'Done.' used to stand in for a genuinely empty model reply, which read as the agent
      // claiming it finished a task it never touched. Model returned nothing to show — say that
      // plainly instead.
      const finalContent = displayedContent.trim() || result.content.trim() || '(Model không trả về nội dung nào cho lượt này — có thể do câu hỏi khiến model xử lý quá lâu hoặc từ chối ngầm. Thử hỏi lại cụ thể hơn.)';
      if (streamingMessageId) {
        store.upsertStreamingAssistant(sessionId, streamingMessageId, finalContent);
      } else {
        store.addMessage(sessionId, 'assistant', finalContent);
      }
      emit(webContents, { runId, type: 'done', finalContent });
      return;
    }

    // DeepSeek docs (Thinking Mode): when a request carries the `tools` parameter, the
    // reasoning_content of every previous turn MUST be passed back and is concatenated into the
    // context. Dropping it saved almost nothing - after the first send those tokens are cache hits
    // ($0.003/M, the cheapest tier) - while it risked the model losing its own plan mid-run, so it
    // is kept. What actually keeps the bill down is `reasoning_effort: low` plus the fact that
    // only the newest tool results are ever re-read.
    messages.push({
      role: 'assistant',
      content: result.content || '',
      ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
      tool_calls: result.toolCalls,
    });

    // Screenshots captured this cycle. Pushed as a single synthetic user message AFTER every
    // tool_call in this assistant turn has a matching tool response, never interleaved with
    // them — the API rejects a tool_calls turn that isn't immediately followed by exactly one
    // tool message per tool_call_id.
    const pendingScreenshots: string[] = [];

    for (const toolCall of result.toolCalls) {
      if (runSignal.aborted) {
        stopped = true;
        break;
      }
      const toolName = toolCall.function.name;
      const validation = validateToolCallArguments(toolName, toolCall.function.arguments, getToolDefinitions(fullControl, settings.enabledTools));

      if (!validation.ok || !validation.args) {
        if (invalidToolName === toolName) invalidToolStreak += 1;
        else {
          invalidToolName = toolName;
          invalidToolStreak = 1;
        }

        const content = [
          `INVALID TOOL CALL (${invalidToolStreak}/${MAX_INVALID_TOOL_STREAK}).`,
          `Tool: ${toolName || '(empty)'}`,
          validation.error ?? 'Arguments did not match the declared JSON Schema.',
          'No action was executed. Call a valid declared tool again with JSON arguments that match its schema exactly.',
        ].join(' ');
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
        recordTool(store, sessionId, toolName || '(empty)', 'invalid', content, undefined);
        emit(webContents, {
          runId,
          type: 'tool-result',
          toolName: toolName || '(invalid tool)',
          summary: content,
        });

        if (invalidToolStreak >= MAX_INVALID_TOOL_STREAK) {
          throw new Error(
            `Agent stopped after ${MAX_INVALID_TOOL_STREAK} consecutive invalid calls to ${toolName || 'an unknown tool'}. No invalid tool call was executed.`,
          );
        }
        continue;
      }

      invalidToolName = '';
      invalidToolStreak = 0;
      const args = validation.args;
      emit(webContents, { runId, type: 'tool-start', toolName, args });

      let toolResult = '';
      let status: ToolJournalStatus = 'success';
      try {
        if (isComputerTool(toolName)) {
          if (!fullControl) {
            status = 'error';
            toolResult = 'TOOL ERROR: computer_* tools require Full Control mode to be enabled.';
          } else {
            toolResult = await executeComputerTool(toolName, args, { projectRoot: effectiveProjectRoot, fullControl });
          }
        } else if (toolName === 'open_web_preview') {
          const url = typeof args.url === 'string' ? args.url : '';
          let parsed: URL | null = null;
          try {
            parsed = new URL(url);
          } catch {
            parsed = null;
          }
          if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
            status = 'error';
            toolResult = 'TOOL ERROR: open_web_preview requires a full http:// or https:// URL.';
          } else {
            emit(webContents, { runId, type: 'open-preview', previewKind: 'web', previewUrl: parsed.toString() });
            toolResult = `Opened ${parsed.toString()} in the web preview panel for the user.`;
          }
        } else if (toolName === 'webview_fill') {
          if (!fullControl) {
            status = 'error';
            toolResult = 'TOOL ERROR: webview_fill requires Full Control mode to be enabled.';
          } else if (!execInWebview) {
            status = 'error';
            toolResult = 'TOOL ERROR: webview_fill is not available in this session (no desktop web preview panel to run it in).';
          } else {
            try {
              toolResult = await runWebviewFill(execInWebview, args);
            } catch (error) {
              status = 'error';
              toolResult = `TOOL ERROR: ${(error as Error).message}`;
            }
          }
        } else if (toolName === 'open_file_preview') {
          if (!workingDirectory && !fullControl) {
            status = 'error';
            toolResult = 'TOOL ERROR: No project folder is selected for this chat. Tell the user to choose a working directory before you can use file/shell tools.';
          } else {
            const relativePath = typeof args.path === 'string' ? args.path : '';
            const content = await executeReadOnlyTool('read_file', { path: relativePath }, {
              projectRoot: effectiveProjectRoot,
              fullControl,
            });
            emit(webContents, { runId, type: 'open-preview', previewKind: 'file', previewName: relativePath, previewContent: content });
            toolResult = content;
          }
        } else if (toolName === 'web_fetch') {
          toolResult = await executeReadOnlyTool('web_fetch', args, {
            projectRoot: effectiveProjectRoot,
            fullControl,
          });
        } else if (!workingDirectory && !fullControl) {
          status = 'error';
          toolResult = 'TOOL ERROR: No project folder is selected for this chat. Tell the user to choose a working directory before you can use file/shell tools.';
        } else if (isMutatingTool(toolName)) {
          const prepared = await prepareMutatingTool(toolName, args, {
            projectRoot: effectiveProjectRoot,
            fullControl,
          });

          let approved = settings.autoApprove;
          if (!approved) {
            approved = await requestApproval(runId, toolName, args, prepared.preview);
          }

          if (!approved) {
            status = 'denied';
            toolResult = 'DENIED BY USER: The requested side-effecting tool was not executed.';
          } else {
            toolResult = await prepared.execute();
            if (/^Command failed\b/i.test(toolResult)) status = 'error';
          }
        } else {
          toolResult = await executeReadOnlyTool(toolName, args, {
            projectRoot: effectiveProjectRoot,
            fullControl,
          });
        }
      } catch (error) {
        status = 'error';
        toolResult = `TOOL ERROR: ${(error as Error).message}`;
      }

      if (toolName === 'computer_screenshot' && status === 'success' && toolResult.startsWith('data:image/')) {
        // Tool-role content stays plain text (vision image parts are only valid in a user
        // message for this API). The image itself is queued and sent as one synthetic user
        // message after the whole tool_calls batch has been answered — see pendingScreenshots.
        const shortText = 'Screenshot captured. The image will follow as a separate message once all tool calls in this turn are answered — look at it before deciding your next action.';
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: shortText });
        pendingScreenshots.push(toolResult);
        recordTool(store, sessionId, toolName, status, 'Screenshot captured and shown to the model.', undefined);
        emit(webContents, {
          runId,
          type: 'tool-result',
          toolName,
          summary: 'SUCCESS: Screenshot captured.',
          image: toolResult,
        });
        continue;
      }

      let bounded = await boundToolResult(toolResult, { projectRoot: effectiveProjectRoot, toolName });
      if (
        status === 'success' &&
        bounded.length > 1_500 &&
        messages.some((message) => message.role === 'tool' && message.content === bounded)
      ) {
        // Byte-identical to output already earlier in this conversation (typically a repeated
        // read of an unchanged file, or the same command run twice). Resending it would re-bill
        // those tokens on every remaining cycle of the run, so send a pointer to the earlier copy.
        bounded = `[DUPLICATE OUTPUT NOT RESENT: identical content (${bounded.length} characters) is already present earlier in this conversation — reuse that earlier result. Narrow the request (search_files, or read a specific section) if you need a fresh copy.]`;
      }
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: bounded });
      recordTool(store, sessionId, toolName, status, summarizeToolResult(toolResult), toolTarget(args));
      emit(webContents, {
        runId,
        type: 'tool-result',
        toolName,
        summary: `${status.toUpperCase()}: ${summarizeToolResult(toolResult)}`,
      });
    }

    if (stopped) break;

    for (const dataUri of pendingScreenshots) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri } },
          { type: 'text', text: 'This is the current screen (from computer_screenshot). Use it to decide your next action.' },
        ],
      });
    }
  }

  if (stopped) {
    // A stopped run still produced text the user saw - keep it.
    persistStreaming();
    const partial = displayedContent.trim();
    if (partial) store.addMessage(sessionId, 'assistant', partial);
    // Steering messages that arrived but were never answered (the user hit "Dung" first). Keep them
    // in the transcript so nothing the user typed simply disappears.
    for (const item of steering.pending.splice(0, steering.pending.length)) {
      const stored = store.addMessage(sessionId, 'user', item.text);
      emit(webContents, {
        runId,
        type: 'user-injected',
        message: item.text,
        messageId: stored?.id,
      });
    }
    emit(webContents, {
      runId,
      type: 'stopped',
      finalContent: partial,
      message: partial
        ? 'Đã dừng tác vụ theo yêu cầu. Phần trả lời đang viết dở đã được lưu lại.'
        : 'Đã dừng tác vụ theo yêu cầu.',
    });
    return;
  }

  throw new Error(`Agent stopped after ${MAX_AGENT_CYCLES} tool-call rounds to prevent an infinite loop.`);
}

export async function compactStoredSession(input: {
  sessionId: string;
  store: LocalStore;
  force: boolean;
}): Promise<CompactResult> {
  const { sessionId, store, force } = input;
  const settings = store.getSettings();
  const apiKey = store.getApiKey();
  const session = store.getSession(sessionId);
  const contextLimit = effectiveContextLimit(settings);
  const projectMemory = session.workingDirectory ? await loadProjectMemoryForPrompt(session.workingDirectory) : null;
  const beforeMessages = buildSessionApiMessages(session, settings, projectMemory);
  const beforeTokens = estimateApiContextTokens(beforeMessages);

  if (!force && beforeTokens < contextLimit * CONTEXT_COMPACT_RATIO) {
    return {
      changed: false,
      beforeTokens,
      afterTokens: beforeTokens,
      contextLimit,
      message: 'Ngữ cảnh đang dưới ngưỡng nén tự động.',
    };
  }

  const activeMessages = getActiveVisibleMessages(session);
  if (activeMessages.length <= KEEP_VISIBLE_MESSAGES) {
    return {
      changed: false,
      beforeTokens,
      afterTokens: beforeTokens,
      contextLimit,
      message: `Chưa có gì cần nén; ngữ cảnh đang dùng chỉ có ${activeMessages.length} tin nhắn.`,
    };
  }

  const splitIndex = activeMessages.length - KEEP_VISIBLE_MESSAGES;
  const older = activeMessages.slice(0, splitIndex);
  const retained = activeMessages.slice(splitIndex);
  const result = await requestCompactionSummary({
    baseUrl: settings.baseUrl,
    apiKey,
    model: settings.model,
    workingDirectory: session.workingDirectory ?? '(no project folder selected)',
    previousSummary: session.contextSummary,
    transcript: capTranscript(serializeVisibleMessages(older)),
    toolJournal: session.toolJournal,
  });
  recordUsage(store, sessionId, settings.model, result);

  store.setContextSummary(sessionId, result.summary, retained[0]?.id ?? null);
  const refreshed = store.getSession(sessionId);
  const afterTokens = estimateApiContextTokens(buildSessionApiMessages(refreshed, settings, projectMemory));

  return {
    changed: true,
    beforeTokens,
    afterTokens,
    contextLimit,
    message: `Đã nén ngữ cảnh: ~${formatTokenCount(beforeTokens)} → ~${formatTokenCount(afterTokens)} token mỗi request. Toàn bộ chat vẫn được giữ trong máy; API chỉ nhận bản tóm tắt + ${KEEP_VISIBLE_MESSAGES} tin nhắn mới nhất.`,
  };
}

function buildSessionApiMessages(session: SessionRecord, settings: AppSettings, projectMemory: string | null): ApiMessage[] {
  const messages: ApiMessage[] = [
    { role: 'system', content: buildSystemPrompt(session.workingDirectory, settings.fullControl) },
  ];

  if (settings.customInstructions.trim()) {
    messages.push({
      role: 'system',
      content: `USER CUSTOM INSTRUCTIONS (name/persona/preferences set by the user — ):\n${settings.customInstructions.trim()}`,
    });
  }

  if (projectMemory) {
    messages.push({
      role: 'system',
      content: `PROJECT MEMORY (facts you saved with project_memory (action: remember) in earlier sessions on this same project folder — still verify anything time-sensitive rather than assuming it still holds):\n${projectMemory}`,
    });
  }

  if (session.contextSummary) {
    messages.push({
      role: 'system',
      content: [
        'HISTORICAL CONTEXT SUMMARY (older chat compressed by the client):',
        session.contextSummary,
        'Treat this as context, not as proof that a local action succeeded. Only verified tool results prove local actions.',
      ].join('\n'),
    });
  }

  const visible = getActiveVisibleMessages(session);
  // Vision input is the most expensive thing in the payload and it is re-billed on every cycle,
  // so image parts are only sent while the newest user turn IS the turn that carries them: the
  // screenshots the user just pasted, and the ones the agent itself captured during this run.
  // Any older screenshot is downgraded to a one-line text note (the agent can re-capture).
  const lastUserId = [...visible].reverse().find((message) => message.role === 'user')?.id ?? null;
  const newestImageMessageId =
    [...visible].reverse().find((message) => message.images && message.images.length > 0)?.id ?? null;
  const imageMessageIds = new Set<string>(
    lastUserId && newestImageMessageId && lastUserId === newestImageMessageId ? [newestImageMessageId] : [],
  );

  // CACHE LEVER - the role of every historical message must stay byte-identical between two
  // consecutive requests, otherwise DeepSeek's prefix cache misses and the whole history is
  // re-billed at the miss price. Rewriting past assistant turns into `system` messages (which an
  // earlier version did to keep the "final answer only" semantics) changed the payload on every
  // single turn and was the main reason the cache-miss counter kept climbing. The assistant role
  // is kept as-is; the note is folded into the content instead, which is stable per message.
  for (const message of visible) {
    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: message.content,
      });
    } else if (message.role === 'user' && message.images && message.images.length > 0) {
      if (imageMessageIds.has(message.id)) {
        const parts: ContentPart[] = message.images
          .slice(0, MAX_IMAGES_PER_MESSAGE)
          .map((url) => ({ type: 'image_url' as const, image_url: { url } }));
        if (message.content.trim()) parts.push({ type: 'text', text: message.content });
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({
          role: 'user',
          content: [
            message.content.trim(),
            `[${message.images.length} screenshot(s) were attached earlier in this conversation and are omitted from this turn to keep the request cheap. Ask for a fresh screenshot if you need to see the current screen.]`,
          ].filter(Boolean).join('\n\n'),
        });
      }
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }

  return mergeSystemMessages(insertLedgerMessage(messages, session.toolJournal));
}

// Some providers' chat templates (e.g. Qwen's native Jinja template) reject any request where a
// system-role message exists anywhere but index 0 — this app builds several separate system
// messages (base prompt, custom instructions, project memory, context summary, tool ledger) and
// interleaves the ledger message right before the newest user turn, which is exactly what those
// templates reject. DeepSeek and most OpenAI-compatible providers tolerate multiple system
// messages fine, so merging them into one leading message is safe everywhere, not just a
// workaround for the strict providers.
function mergeSystemMessages(messages: ApiMessage[]): ApiMessage[] {
  const systemParts: string[] = [];
  const rest: ApiMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') systemParts.push(message.content);
    else rest.push(message);
  }
  if (systemParts.length === 0) return rest;
  return [{ role: 'system', content: systemParts.join('\n\n---\n\n') }, ...rest];
}

// The ledger records what actually ran, but it changes on every single tool call. DeepSeek only
// caches an exact token PREFIX, so putting this mutable block at the top of the request (as it
// used to be) invalidated the cache for the entire history on every cycle and made nearly every
// token a full-price cache miss. It now goes just before the newest user turn instead.
function buildLedgerMessage(toolJournal: ToolJournalEntry[]): ApiMessage | null {
  const ledger = renderVerifiedToolJournal(toolJournal.slice(-TOOL_LEDGER_ENTRIES));
  if (!ledger) return null;
  return {
    role: 'system',
    content: [
      'VERIFIED LOCAL TOOL LEDGER (most recent verified actions, oldest suppressed):',
      ledger,
      'Only tool calls listed here (and explicit tool results later in this conversation) actually ran. Re-read files when exact current contents matter.',
    ].join('\n'),
  };
}

function insertLedgerMessage(messages: ApiMessage[], toolJournal: ToolJournalEntry[]): ApiMessage[] {
  const ledgerMessage = buildLedgerMessage(toolJournal);
  if (!ledgerMessage) return messages;
  // CACHE LEVER - the ledger is the only block that changes on every tool call, so it is appended
  // at the very END of the request. Everything before it (system prompt, summary, whole history)
  // then stays byte-identical between cycles and keeps hitting the prefix cache; only the tail is
  // re-billed. Inserting it in the middle (as an earlier version did) shifted every message after
  // it and turned the rest of the history into cache misses.
  return [...messages, ledgerMessage];
}

// Last-resort budget enforcement: drop whole turns from the oldest end until the request fits.
// Cuts only at user-turn boundaries so an assistant tool_calls turn is never separated from the
// tool results that must immediately follow it (the API rejects that shape).
// -------------------------------------------------------------------------------------------
// COST LEVERS around DeepSeek thinking mode.
//
// 1. reasoning_content replay. When a request carries tools, DeepSeek requires the chain of
//    thought of every previous assistant turn to be sent back with it. On a long tool run that
//    means each cycle re-sends all the thinking that came before it (billed as input) on top of
//    the thinking it is about to generate (billed as output). Turning thinking off for the
//    mechanical cycles removes both, and keeps the history byte-identical across cycles so the
//    prefix cache keeps hitting.
// 2. hybridThinking (default on): think once per turn - the first request, where the plan is
//    made - then run the tool cycles that follow it with thinking disabled.
// -------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------
// NOTE: the old `stripReasoningContent` helper was removed on purpose. It rewrote the message
// array for the non-thinking follow-up cycles, which broke the byte-identical prefix that
// DeepSeek's context cache needs, so every cycle paid the miss price for the whole history.
// -------------------------------------------------------------------------------------------

function isThinkingModeRejection(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error);
  if (!/\b400\b/.test(text)) return false;
  return /reasoning_content|thinking/i.test(text);
}

// Sessions where DeepSeek already refused a request because of the thinking-mode history rules:
// those stay in non-thinking mode for the rest of the session.
const sessionsWithoutThinking = new Set<string>();

function trimApiMessagesToBudget(
  messages: ApiMessage[],
  budgetTokens: number,
): { messages: ApiMessage[]; dropped: number } {
  if (messages.length <= 4) return { messages, dropped: 0 };

  const header: ApiMessage[] = [];
  let start = 0;
  while (start < messages.length && messages[start].role === 'system') {
    header.push(messages[start]);
    start += 1;
  }
  const rest = messages.slice(start);
  const candidates: number[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].role === 'user') candidates.push(index);
  }
  if (candidates.length <= 1) return { messages, dropped: 0 };

  let chosen = -1;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = [...header, ...rest.slice(candidates[index])];
    if (estimateApiContextTokens(candidate) <= budgetTokens) chosen = candidates[index];
    else break;
  }
  if (chosen < 0) chosen = candidates[candidates.length - 1];

  const next = [...header, ...rest.slice(chosen)];
  return { messages: next, dropped: messages.length - next.length };
}

function getActiveVisibleMessages(session: SessionRecord): ChatMessage[] {
  if (!session.contextSummary || !session.contextStartsAtMessageId) return session.messages;
  const index = session.messages.findIndex((message) => message.id === session.contextStartsAtMessageId);
  return index >= 0 ? session.messages.slice(index) : session.messages;
}

function buildSystemPrompt(workingDirectory: string | null, fullControl: boolean): string {
  if (fullControl) {
    return [
      'You are a desktop coding/automation agent running with FULL CONTROL mode enabled by the user themselves, via a manual toggle they can switch off at any time.',
      workingDirectory
        ? `Nominal working directory: ${workingDirectory} (you are not restricted to it).`
        : 'No specific folder was selected; you may operate anywhere on this computer.',
      'Not every tool mentioned below is necessarily available this request — the user turns individual tools on/off independent of Full Control; your actual function-calling list is the source of truth, not this text.',
      'No folder sandbox, no shell filter: file tools accept absolute paths anywhere; run_command runs anything unrestricted.',
      'GUI tools: computer_screenshot/click/type/key act like a real user. Screenshot before clicking/typing blind and after to confirm — you cannot see the image yourself, so describe your action and ask the user to confirm if precision matters.',
      'For filling a web form, prefer webview_fill (open the page with open_web_preview first) over computer_click: it targets DOM selectors directly, so it cannot land in the wrong field when a cookie banner or popup shifts the page — the failure mode blind coordinate clicking has no defense against.',
      'For back-and-forth interaction (nc, python/gdb/sqlmap/msfconsole prompts, watching a long scan) use the session tool (action: open/write/read/close/list) instead of one-shot run_command. Close when done (max 6 open).',
      'artifact tool (action: save/read/list): park long text (scan output, big responses) out of the conversation instead of re-pasting/re-generating it. Truncated tool results auto-save this way too — read them back instead of re-running.',
      'Multi-day project: project_memory (action: remember) facts worth keeping (scope, credential, endpoint, failed payload, decision) — auto-loaded into every new chat in this project folder (see PROJECT MEMORY above). action: recall searches older history; action: forget corrects stale entries.',
      'recon tool (action: add_target/scan/...): subdomain monitoring via crt.sh — being first to see a new asset often matters more than a deeper bug on a known one.',
      'scope tool (action: add/list/...): if the user gives you an authorized target list for real bounty/pentest work, set it with scope action=add — http_request/recon then refuse out-of-scope hosts automatically. Do not touch scope for casual/local work.',
      'diff_request compares the same request under two header sets (e.g. two session cookies) — an identical body across two identities is the IDOR/BOLA signal. check_tools sees what security tools are actually installed before assuming one. parse_scan_output compacts ffuf/nuclei/dalfox/sqlmap output instead of reading it raw. finding tool (action: add/list/report) tracks vulnerabilities found, action=report writes the full markdown writeup.',
      'open_file_preview/open_web_preview show a file or live URL to the user in a side panel — use proactively when it helps.',
      'web_search then web_fetch for anything time-sensitive or unknown, instead of guessing from stale training knowledge — cite the URL.',
      'Self-upgrade: if the working directory is this app\'s own source ("deepseek-coding-desktop", electron/+src/), you may edit it, `npm run typecheck` + `npm run build` (or `npm run dist:win` for the packaged app — say it takes a minute), then restart_app. Never restart_app without a successful build immediately before it; never self-edit unless asked.',
      'No confirmation dialog on tool calls — you alone are responsible: avoid destructive/irreversible actions unless the user explicitly asked for exactly that.',
      'Cost control: every cycle resends the whole conversation, so what you add each cycle is repaid every cycle after. Prefer search_files/narrow reads over dumping whole files; identical repeated output is auto-replaced by a pointer. Long output is truncated (~16k chars) and older history gets compacted — re-read narrowly when exact current content matters.',
      'Your own text is billed as OUTPUT, the priciest token type. One short line per tool-call cycle stating the action — no paragraphs, no restating tool output. Save real explanation for the final reply, and keep that tight too.',
      'ALWAYS use a real tool call for any local action — never claim a file was read/edited or a command ran unless the tool result confirms it.',
      'When finished: a concise summary of files changed, commands run, and anything unresolved.',
    ].join('\n');
  }
  if (!workingDirectory) {
    return [
      'You are a helpful desktop chat assistant.',
      'No project folder is selected for this chat, so no file or shell tools are available right now.',
      'Answer normally from your own knowledge. If the user asks you to read, edit, or run something on their computer, tell them to click "Choose project folder" first, then ask again.',
    ].join('\n');
  }
  return [
    'You are a desktop coding agent working on the user-selected local project.',
    `Working directory: ${workingDirectory}`,
    'You may only work inside this directory. Never attempt to access parent directories, system paths, network shares, credentials, browser profiles, or unrelated user files.',
    'Not every tool mentioned below is necessarily available this request — the user turns individual tools on/off; your actual function-calling list is the source of truth, not this text.',
    'Tools: read/list/search/write/edit files, run project-scoped shell commands.',
    'open_file_preview/open_web_preview show a file or live URL to the user in a side panel — use proactively when it helps, not only if asked.',
    'web_search then web_fetch for sources you don\'t have a URL for, instead of asking the user to paste them. Internet only — never touches local files outside this project.',
    'artifact tool (action: save/read/list): park long text out of the conversation instead of re-pasting/re-generating it. Truncated tool results auto-save this way too.',
    'project_memory tool (action: remember): facts worth keeping past this chat (decision, finding, failed attempt) — auto-loaded into every new chat in this project folder (see PROJECT MEMORY above). action: recall searches older history; action: forget corrects stale entries.',
    'ALWAYS use a real tool call for any local action — never claim a file was read/edited or a command ran unless the tool result confirms it. If a result says DENIED/INVALID/ERROR, don\'t describe it as successful.',
    'Prefer read_file/list_directory/search_files before editing, to understand the project first.',
    'Cost control: every cycle resends the whole conversation, so what you add each cycle is repaid every cycle after. Prefer search_files/narrow reads/small command output over dumping whole files; identical repeated output is auto-replaced by a pointer. Long output truncated ~16k chars; older history gets compacted.',
    'Your own text is billed as OUTPUT, the priciest token type. One short line per tool-call cycle stating the action — no paragraphs, no restating tool output. Save real explanation for the final reply, and keep that tight too.',
    'edit_file needs an old_string that appears exactly once.',
    'Before write_file/edit_file/run_command, briefly say in normal text what you\'re about to change and why.',
    'Keep destructive actions minimal — don\'t delete unless asked and there\'s no safer edit.',
    'After a tool runs, inspect the real result and continue until the task is actually complete.',
    'When finished: a concise summary of files changed, commands run, and anything unresolved.',
  ].join('\n');
}

async function compactApiMessages(input: {
  messages: ApiMessage[];
  settings: AppSettings;
  apiKey: string;
  workingDirectory: string;
  toolJournal: ToolJournalEntry[];
  sessionId: string;
  store: LocalStore;
  signal?: AbortSignal;
}): Promise<{ changed: boolean; messages: ApiMessage[]; beforeTokens: number; afterTokens: number }> {
  const beforeTokens = estimateApiContextTokens(input.messages);
  if (input.messages.length <= 3) {
    return { changed: false, messages: input.messages, beforeTokens, afterTokens: beforeTokens };
  }

  let recentStart = Math.max(1, input.messages.length - KEEP_API_MESSAGES);
  while (recentStart > 1 && input.messages[recentStart]?.role === 'tool') recentStart -= 1;
  const older = input.messages.slice(1, recentStart);
  if (older.length === 0) {
    return { changed: false, messages: input.messages, beforeTokens, afterTokens: beforeTokens };
  }

  const result = await requestCompactionSummary({
    baseUrl: input.settings.baseUrl,
    apiKey: input.apiKey,
    model: input.settings.model,
    workingDirectory: input.workingDirectory,
    previousSummary: null,
    transcript: capTranscript(serializeApiMessages(older)),
    toolJournal: input.toolJournal,
    signal: input.signal,
  });
  recordUsage(input.store, input.sessionId, input.settings.model, result);

  // Drop the (now stale) ledger copy that lived in the kept tail, then re-insert a fresh one so
  // the model still sees what actually ran after the compaction.
  const kept = input.messages
    .slice(recentStart)
    .filter((message) => !(message.role === 'system' && message.content.startsWith('VERIFIED LOCAL TOOL LEDGER')));
  const next: ApiMessage[] = mergeSystemMessages(insertLedgerMessage(
    [
      input.messages[0],
      {
        role: 'system',
        content: [
          'AUTOMATIC CONTEXT SUMMARY (earlier API/tool turns compressed by the client):',
          result.summary,
          'Only explicit tool result messages and the verified tool ledger count as proof of local actions.',
        ].join('\n'),
      },
      ...kept,
    ],
    input.toolJournal,
  ));
  const afterTokens = estimateApiContextTokens(next);
  return { changed: true, messages: next, beforeTokens, afterTokens };
}

async function requestCompactionSummary(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  workingDirectory: string;
  previousSummary: string | null;
  transcript: string;
  toolJournal: ToolJournalEntry[];
  signal?: AbortSignal;
}): Promise<{
  summary: string;
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}> {
  const link = linkAbort(input.signal, REQUEST_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: input.model,
      stream: false,
      temperature: 0.2,
      max_tokens: 6000,
      messages: [
        {
          role: 'system',
          content: [
            'You compress coding-agent conversation context.',
            'Return a concise factual summary only. Preserve user goals, architectural decisions, unresolved work, exact filenames/paths that matter, important errors, and verified file/command state.',
            'Do not invent completed actions. Distinguish plans from actions confirmed by the VERIFIED TOOL LEDGER.',
            'Do not include chain-of-thought or hidden reasoning.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Working directory: ${input.workingDirectory}`,
            input.previousSummary ? `PREVIOUS SUMMARY:\n${input.previousSummary}` : '',
            `VERIFIED TOOL LEDGER:\n${renderVerifiedToolJournal(input.toolJournal.slice(-TOOL_LEDGER_COMPACT_ENTRIES)) || '(none)'}`,
            `TRANSCRIPT TO COMPRESS:\n${capTranscript(input.transcript)}`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
    };
    // Summarising never benefits from chain-of-thought, so thinking is switched off explicitly
    // (reasoning_effort:"none" is not a valid OpenAI-format value and did not disable it).
    if (isDeepSeekBaseUrl(input.baseUrl)) body.thinking = { type: 'disabled' };

    const response = await fetchCompletion(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, link.signal);

    if (!response.ok) {
      const text = (await response.text()).slice(0, 4000);
      throw new Error(`Context compact request failed (${response.status}): ${text || response.statusText}`);
    }
    const json = await response.json() as any;
    const summary = json?.choices?.[0]?.message?.content;
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error('Yêu cầu nén ngữ cảnh trả về bản tóm tắt rỗng.');
    }
    return {
      summary: summary.trim(),
      promptTokens: typeof json?.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : 0,
      completionTokens: typeof json?.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : 0,
      promptCacheHitTokens: typeof json?.usage?.prompt_cache_hit_tokens === 'number' ? json.usage.prompt_cache_hit_tokens : 0,
      promptCacheMissTokens: typeof json?.usage?.prompt_cache_miss_tokens === 'number' ? json.usage.prompt_cache_miss_tokens : 0,
    };
  } catch (error) {
    if (link.timedOut()) {
      throw new Error('Yêu cầu nén ngữ cảnh quá thời gian chờ (180 giây).');
    }
    throw error;
  } finally {
    link.cleanup();
  }
}

async function streamChatCompletion(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort: AppSettings['reasoningEffort'];
  maxOutputTokens: number;
  messages: ApiMessage[];
  enableTools: boolean;
  fullControl: boolean;
  enabledTools: string[];
  signal?: AbortSignal;
  onRetry?: (message: string) => void;
  onDelta: (delta: string) => void;
}): Promise<StreamResult> {
  const link = linkAbort(input.signal, REQUEST_TIMEOUT_MS);

  try {
    const deepSeek = isDeepSeekBaseUrl(input.baseUrl);
    const deepSeekThinking = deepSeek && input.reasoningEffort !== 'none';
    const body: Record<string, unknown> = {
      model: input.model,
      messages: input.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: input.temperature,
    };
    // Hard ceiling on generated tokens. Output (reasoning + answer) is the priciest line, and
    // before this the main request had no max_tokens at all, so generation was unbounded. The cap
    // is now ALWAYS sent: a settings value of 0 used to mean "no cap", which is exactly the
    // runaway-spend case the user hit, so it falls back to the default ceiling instead.
    body.max_tokens = input.maxOutputTokens > 0 ? input.maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
    if (input.enableTools) body.tools = getToolDefinitions(input.fullControl, input.enabledTools);
    if (deepSeek) {
      // DeepSeek thinking mode is ENABLED BY DEFAULT (at effort "high") and cannot be turned off
      // with reasoning_effort: that parameter only accepts low/high/max in the OpenAI format, so
      // sending "none" silently did nothing and the user kept paying for reasoning tokens (which
      // also get concatenated back into the context, inflating input). The only correct switch is
      // the dedicated thinking toggle, so it is now sent explicitly on every request.
      if (deepSeekThinking) {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = input.reasoningEffort;
      } else {
        body.thinking = { type: 'disabled' };
      }
      // DeepSeek V4 thinking mode rejects tool_choice. Omitting it lets the model
      // decide whether to call a tool, which is the provider's documented path.
      if (!deepSeekThinking && input.enableTools) body.tool_choice = 'auto';
    } else if (input.enableTools) {
      body.tool_choice = 'auto';
    }

    const response = await fetchCompletion(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, link.signal, input.onRetry);

    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 4_000);
      throw new Error(`DeepSeek-compatible API ${response.status}: ${responseBody || response.statusText}`);
    }
    if (!response.body) throw new Error('API không trả về nội dung phản hồi.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let finishReason: string | null = null;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let promptCacheHitTokens: number | undefined;
    let promptCacheMissTokens: number | undefined;
    const toolCallMap = new Map<number, ToolCall>();

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }

      if (typeof chunk?.usage?.prompt_tokens === 'number') {
        promptTokens = chunk.usage.prompt_tokens;
      }
      if (typeof chunk?.usage?.completion_tokens === 'number') {
        completionTokens = chunk.usage.completion_tokens;
      }
      if (typeof chunk?.usage?.prompt_cache_hit_tokens === 'number') {
        promptCacheHitTokens = chunk.usage.prompt_cache_hit_tokens;
      }
      if (typeof chunk?.usage?.prompt_cache_miss_tokens === 'number') {
        promptCacheMissTokens = chunk.usage.prompt_cache_miss_tokens;
      }

      const choice = chunk?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        input.onDelta(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const partial of delta.tool_calls) {
          const index = typeof partial.index === 'number' ? partial.index : 0;
          const current = toolCallMap.get(index) ?? {
            id: partial.id ?? randomUUID(),
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (partial.id) current.id = partial.id;
          if (partial.function?.name) current.function.name += partial.function.name;
          if (partial.function?.arguments) current.function.arguments += partial.function.arguments;
          toolCallMap.set(index, current);
        }
      }

      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }

    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    const toolCalls = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);

    return {
      content,
      reasoningContent,
      toolCalls,
      finishReason,
      promptTokens,
      completionTokens,
      promptCacheHitTokens,
      promptCacheMissTokens,
    };
  } catch (error) {
    if (link.timedOut()) {
      throw new Error('Yêu cầu tới API DeepSeek quá thời gian chờ (180 giây).');
    }
    throw error;
  } finally {
    link.cleanup();
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

// Combines an optional caller signal (the run's "Dừng" controller) with a per-request timeout
// into one signal, and reports whether the timeout — not the caller — fired the abort.
function linkAbort(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** An AbortSignal that fires as soon as ANY of the given signals aborts. */
function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const detach: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    detach.push(() => signal.removeEventListener('abort', onAbort));
  }
  if (controller.signal.aborted) detach.forEach((off) => off());
  else controller.signal.addEventListener('abort', () => detach.forEach((off) => off()), { once: true });
  return controller.signal;
}

function backoffDelayMs(attempt: number): number {
  const base = Math.min(8_000, 600 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 300);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retries transient failures (network errors, 429, 5xx) with exponential backoff, honouring a
// Retry-After header when the API sends one. Only the request itself is retried — never a
// response that already started streaming — so partial tool output is never duplicated.
async function fetchCompletion(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onRetry?: (message: string) => void,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw abortError();
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt >= MAX_FETCH_ATTEMPTS) {
        return response;
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await response.text().catch(() => '');
      const delay = retryAfter ?? backoffDelayMs(attempt);
      onRetry?.(`API trả về ${response.status}. Thử lại lần ${attempt + 1}/${MAX_FETCH_ATTEMPTS} sau ${(delay / 1000).toFixed(1)}s…`);
      await sleep(delay, signal);
    } catch (error) {
      if (signal.aborted || (error as Error).name === 'AbortError') throw error;
      if (attempt >= MAX_FETCH_ATTEMPTS) throw error;
      const delay = backoffDelayMs(attempt);
      onRetry?.(`Lỗi kết nối (${(error as Error).message}). Thử lại lần ${attempt + 1}/${MAX_FETCH_ATTEMPTS} sau ${(delay / 1000).toFixed(1)}s…`);
      await sleep(delay, signal);
    }
  }
}

function recordUsage(store: LocalStore, sessionId: string, model: string, usage: RequestUsage): void {
  const costUsd = computeRequestCostUsd(model, usage, isPeakTime());
  store.addUsage(
    sessionId,
    usage.promptTokens ?? 0,
    usage.completionTokens ?? 0,
    usage.promptCacheHitTokens ?? 0,
    usage.promptCacheMissTokens ?? 0,
    costUsd,
  );
}

function estimateApiContextTokens(messages: ApiMessage[]): number {
  // Worst-case (all tools enabled) on purpose: this only feeds the compaction-trigger estimate,
  // so overestimating a little just compacts slightly earlier — never risks an actual overflow.
  let tokens = estimateTextTokens(JSON.stringify(getToolDefinitions(true, ALL_TOOL_NAMES))) + 80;
  for (const message of messages) {
    tokens += 12;
    if ('content' in message) {
      if (typeof message.content === 'string') {
        tokens += estimateTextTokens(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          // Vision tokenization varies by provider/resolution; this is a deliberately
          // rough flat estimate for a full-screen PNG screenshot, not an exact count.
          if (part.type === 'image_url') tokens += 1500;
          else tokens += estimateTextTokens(part.text);
        }
      }
    }
    if (message.role === 'assistant') {
      if (message.reasoning_content) tokens += estimateTextTokens(message.reasoning_content);
      if (message.tool_calls) tokens += estimateTextTokens(JSON.stringify(message.tool_calls));
    }
    if (message.role === 'tool') tokens += estimateTextTokens(message.tool_call_id);
  }
  return Math.max(1, tokens);
}

function estimateTextTokens(value: string): number {
  if (!value) return 0;
  // DeepSeek does not publish a drop-in JS tokenizer for this app. UTF-8 bytes / 3.5 is a deliberately
  // conservative approximation for mixed English/Vietnamese/code compared with the common chars/4 rule.
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3.5);
}

function serializeVisibleMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n---\n\n');
}

function stringifyUserContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'image_url' ? '[screenshot image]' : part.text)).join(' ');
}

function serializeApiMessages(messages: ApiMessage[]): string {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const calls = message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      return `ASSISTANT:\n${message.content ?? ''}${calls?.length ? `\nTOOL CALLS: ${JSON.stringify(calls)}` : ''}`;
    }
    if (message.role === 'tool') return `TOOL RESULT (${message.tool_call_id}):\n${message.content}`;
    return `${message.role.toUpperCase()}:\n${stringifyUserContent(message.content)}`;
  }).join('\n\n---\n\n');
}

function renderVerifiedToolJournal(entries: ToolJournalEntry[]): string {
  return entries.map((entry) => {
    const time = entry.createdAt.slice(11, 19);
    const target = entry.target ? ` | target=${entry.target}` : '';
    return `${time} | ${entry.toolName} | ${entry.status}${target} | ${entry.summary}`;
  }).join('\n');
}

function recordTool(
  store: LocalStore,
  sessionId: string,
  toolName: string,
  status: ToolJournalStatus,
  summary: string,
  target?: string,
): void {
  store.addToolJournalEntry(sessionId, {
    toolName,
    status,
    summary: summary.slice(0, TOOL_LEDGER_SUMMARY_CHARS),
    ...(target ? { target: target.slice(0, TOOL_LEDGER_TARGET_CHARS) } : {}),
  });
}

function toolTarget(args: Record<string, unknown>): string | undefined {
  if (typeof args.path === 'string') return args.path;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.command === 'string') {
    const cwd = typeof args.cwd === 'string' ? args.cwd : '.';
    return `${cwd} :: ${args.command}`;
  }
  return undefined;
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

// Keeps a compaction request cheap: the transcript is the biggest thing we send for it, and a
// 500k-char transcript can cost more than the compaction saves.
function capTranscript(transcript: string): string {
  if (transcript.length <= COMPACTION_TRANSCRIPT_CHARS) return transcript;
  const head = Math.floor(COMPACTION_TRANSCRIPT_CHARS * 0.35);
  const tail = COMPACTION_TRANSCRIPT_CHARS - head;
  return [
    transcript.slice(0, head),
    `\n\n[TRANSCRIPT TRUNCATED: ${transcript.length - COMPACTION_TRANSCRIPT_CHARS} characters omitted from the middle of this transcript to keep the summarisation request cheap.]\n\n`,
    transcript.slice(transcript.length - tail),
  ].join('');
}

function emit(webContents: AgentEventSink, event: AgentEvent): void {
  if (!webContents.isDestroyed()) webContents.send('agent:event', event);
}

interface WebviewFillField {
  selector: string;
  value: string;
}

// Fills form fields by DOM selector inside the docked web preview <webview> instead of guessing
// screen coordinates with computer_click — immune to the page shifting under a blind click (cookie
// banners, popups) and to screenshot-scale-factor math errors. Uses the native input value setter
// so React/Vue-controlled inputs on the target page actually register the change, not just the
// DOM attribute.
async function runWebviewFill(execInWebview: (script: string) => Promise<unknown>, args: Record<string, unknown>): Promise<string> {
  const rawFields = args.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw new Error('webview_fill requires a non-empty "fields" array of {selector, value}.');
  }
  const fields: WebviewFillField[] = rawFields.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    if (typeof record.selector !== 'string' || !record.selector.trim()) {
      throw new Error(`webview_fill: fields[${index}].selector must be a non-empty string.`);
    }
    if (typeof record.value !== 'string') {
      throw new Error(`webview_fill: fields[${index}].value must be a string.`);
    }
    return { selector: record.selector, value: record.value };
  });
  const submitSelector = typeof args.submit_selector === 'string' && args.submit_selector.trim() ? args.submit_selector : null;

  const script = `
(function() {
  const fields = ${JSON.stringify(fields)};
  const submitSelector = ${JSON.stringify(submitSelector)};
  const results = [];
  const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  for (const field of fields) {
    let el;
    try { el = document.querySelector(field.selector); } catch (e) { results.push({ selector: field.selector, ok: false, error: 'invalid selector: ' + e.message }); continue; }
    if (!el) { results.push({ selector: field.selector, ok: false, error: 'not found' }); continue; }
    try {
      if (el.tagName === 'TEXTAREA') nativeTextareaSetter.call(el, field.value);
      else if (el.tagName === 'SELECT') { el.value = field.value; }
      else nativeInputSetter.call(el, field.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      results.push({ selector: field.selector, ok: true });
    } catch (e) {
      results.push({ selector: field.selector, ok: false, error: String(e && e.message || e) });
    }
  }
  if (submitSelector) {
    const btn = document.querySelector(submitSelector);
    if (btn) { btn.click(); results.push({ submit: submitSelector, ok: true }); }
    else results.push({ submit: submitSelector, ok: false, error: 'not found' });
  }
  return JSON.stringify(results);
})()
`;

  const raw = await execInWebview(script);
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return `webview_fill ran but returned an unparsable result: ${String(raw)}`;
  }
  return `webview_fill result:\n${JSON.stringify(parsed, null, 2)}`;
}

async function boundToolResult(value: string, context: { projectRoot: string; toolName: string }): Promise<string> {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  const head = Math.floor(MAX_TOOL_RESULT_CHARS * 0.6);
  const tail = MAX_TOOL_RESULT_CHARS - head;
  const omitted = value.length - MAX_TOOL_RESULT_CHARS;

  // The truncated middle used to just be gone for good. Saving the full thing as an artifact
  // first means it is still there afterward — page through it with the artifact tool instead of
  // losing it, at the (one-time, local disk) cost of writing the file.
  let artifactNote = '';
  try {
    const meta = await saveArtifact(context.projectRoot, `${context.toolName}-${Date.now()}`, value, 'auto-truncation');
    artifactNote = ` Full output saved as artifact "${meta.id}" — use the artifact tool (action: read) to page through the hidden middle instead of re-running this.`;
  } catch {
    // Best effort: if the save fails (e.g. disk full), fall back to the old truncate-and-lose
    // behavior rather than breaking the tool call over it.
  }

  return [
    value.slice(0, head),
    `\n\n[TRUNCATED: ${omitted} characters omitted from the middle so this result does not get resent (and re-billed) on every remaining cycle.${artifactNote} The end of the output is kept because errors and summaries live there.]\n\n`,
    value.slice(value.length - tail),
  ].join('');
}

function summarizeToolResult(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 280 ? `${compact.slice(0, 280)}…` : compact || 'Completed.';
}
