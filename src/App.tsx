import { ClipboardEvent as ReactClipboardEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, UIEvent as ReactUIEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  FileCode2,
  FolderOpen,
  Globe,
  LoaderCircle,
  MessageSquarePlus,
  Minimize2,
  Monitor,
  Moon,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Play,
  Settings,
  ShieldAlert,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  UserRound,
  Wrench,
  X,
} from 'lucide-react';
import { MarkdownMessage } from './components/MarkdownMessage';
import type {
  AgentEvent,
  ApprovalRequest,
  AppSettings,
  AttachedFile,
  ChatMessage,
  PublicSession,
  PublicSettings,
  SessionRecord,
  ThemePreference,
  UsageStats,
} from './types';

// Official DeepSeek pricing, USD per 1M tokens — OFF-PEAK rates, used only as a conservative
// fallback for sessions created before the app started tracking real cost (see costUsd in
// UsageStats). New requests are priced in the main process at the exact model + peak/off-peak
// rate that applied when they were sent (electron/pricing.ts), so the pill shows the real bill
// for anything recorded from now on.
// (api-docs.deepseek.com/quick_start/pricing, verified 19/9/2026: off-peak is exactly half of
// peak; peak = 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday.)
const MODEL_PRICING_USD_PER_M: Record<string, { hit: number; miss: number; output: number }> = {
  'deepseek-flash': { hit: 0.003, miss: 0.15, output: 0.6 },
  'deepseek-v4-pro': { hit: 0.022, miss: 0.66, output: 1.98 },
};

function estimateCostUsd(model: string, usage: UsageStats): number | null {
  const pricing = MODEL_PRICING_USD_PER_M[model];
  if (!pricing) return null;
  const cacheHit = usage.promptCacheHitTokens ?? 0;
  // Cache-hit tracking was added part-way through this app's life, so a session can hold tokens
  // that were never classified. Everything unclassified is billed as a cache miss (the expensive
  // rate) so the estimate errs high instead of quietly under-reporting the real bill.
  const cacheMiss = Math.max(usage.promptCacheMissTokens ?? 0, Math.max(0, usage.promptTokens - cacheHit));
  return (
    (cacheHit / 1_000_000) * pricing.hit +
    (cacheMiss / 1_000_000) * pricing.miss +
    (usage.completionTokens / 1_000_000) * pricing.output
  );
}

// Prefer the real accumulated cost (exact model + peak/off-peak per request). Only fall back to
// the off-peak estimate for legacy sessions that predate cost tracking.
function resolveCostUsd(model: string, usage: UsageStats): { value: number; tracked: boolean } | null {
  if (typeof usage.costUsd === 'number' && usage.costUsd > 0) {
    return { value: usage.costUsd, tracked: true };
  }
  const estimated = estimateCostUsd(model, usage);
  return estimated === null ? null : { value: estimated, tracked: false };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.0001) return '<$0.0001';
  if (value < 0.01) return `${value.toFixed(4)}`;
  if (value < 1) return `${value.toFixed(3)}`;
  return `${value.toFixed(2)}`;
}

// Peak hours are exactly double the off-peak rate, so this clock is a direct, actionable lever:
// moving a heavy session out of a peak window halves its bill without changing any behaviour.
// Windows mirror electron/pricing.ts (01:00-04:00 and 06:00-10:00 UTC, Monday-Friday; all
// weekend is off-peak). Times are shown in Vietnam time (UTC+7).
function isPeakTime(date: Date = new Date()): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const inWindow = (startHour: number, endHour: number) => minutes >= startHour * 60 && minutes < endHour * 60;
  return inWindow(1, 4) || inWindow(6, 10);
}

// The next moment the peak/off-peak state flips, so the badge can say how long the current
// price lasts instead of just naming it.
function nextRateChange(date: Date): Date {
  const next = new Date(date);
  next.setUTCSeconds(0, 0);
  const minutesToday = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const boundary of [1 * 60, 4 * 60, 6 * 60, 10 * 60]) {
    if (boundary > minutesToday) {
      next.setUTCHours(Math.floor(boundary / 60), boundary % 60);
      return next;
    }
  }
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(1, 0);
  return next;
}

function PeakBadge() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const peak = isPeakTime(now);
  const boundary = nextRateChange(now);
  const clock = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' }).format(boundary);
  const minsLeft = Math.max(0, Math.round((boundary.getTime() - now.getTime()) / 60_000));
  const leftText = minsLeft >= 60 ? `${Math.floor(minsLeft / 60)}h${String(minsLeft % 60).padStart(2, '0')}` : `${minsLeft} phút`;
  return (
    <span
      className={`peak-badge ${peak ? 'is-peak' : 'is-offpeak'}`}
      title="Giờ cao điểm: 01:00-04:00 và 06:00-10:00 UTC (08-11h và 13-17h giờ VN) từ thứ Hai tới thứ Sáu. Ngoài khung đó là thấp điểm. Giá thấp điểm bằng đúng một nửa giá cao điểm."
    >
      {peak
        ? `Giờ cao điểm — giá ×2. Còn ${leftText} nữa (tới ${clock} giờ VN) là rẻ đi một nửa.`
        : `Giờ thấp điểm — giá ×1. Còn ${leftText} nữa (tới ${clock} giờ VN) là vào giờ cao điểm.`}
    </span>
  );
}

interface ToolStatus {
  id: string;
  label: string;
  detail?: string;
  image?: string;
  state: 'running' | 'done';
}

// Mirrors electron/tool-schema.ts DEFAULT_ENABLED_TOOLS/ALL_TOOL_NAMES — duplicated here rather
// than imported, since the renderer bundle doesn't pull from electron/. Keep the two in sync.
const CORE_TOOL_NAMES = [
  'read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command',
  'web_fetch', 'web_search', 'open_file_preview', 'open_web_preview',
];
const COMPUTER_TOOL_NAMES = ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'restart_app', 'session', 'webview_fill'];
const TOOL_GROUPS: { label: string; names: string[]; requiresFullControl?: boolean }[] = [
  { label: 'File & Shell', names: ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command'] },
  { label: 'Web', names: ['web_fetch', 'web_search', 'http_request', 'diff_request'] },
  { label: 'Panel xem trước', names: ['open_file_preview', 'open_web_preview'] },
  { label: 'Bộ nhớ & Artifact', names: ['artifact', 'project_memory'] },
  { label: 'Security / Bug bounty / CTF', names: ['recon', 'scope', 'check_tools', 'parse_scan_output', 'finding', 'binary', 'ctf_board', 'codec'] },
  { label: 'GUI & Session (cần Toàn quyền)', names: COMPUTER_TOOL_NAMES, requiresFullControl: true },
];

const DEFAULT_SETTINGS: PublicSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.3,
  autoApprove: false,
  reasoningEffort: 'low',
  hybridThinking: true,
  contextWindowTokens: 1_000_000,
  maxInputTokens: 65_536,
  maxOutputTokens: 8_192,
  theme: 'system',
  fullControl: false,
  customInstructions: '',
  enabledTools: CORE_TOOL_NAMES,
  remoteEnabled: false,
  remotePort: 4756,
  remoteToken: '',
  remoteSessionId: null,
  apiKeyConfigured: false,
};

const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<ThemePreference, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };
const THEME_LABEL: Record<ThemePreference, string> = { system: 'Giao diện: Theo hệ thống', light: 'Giao diện: Sáng', dark: 'Giao diện: Tối' };

export default function App() {
  const [sessions, setSessions] = useState<PublicSession[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_SETTINGS);
  const [composer, setComposer] = useState('');
  // An asked to be able to keep typing AND steering while the agent runs. A message sent mid-run is
  // not queued to wait any more: it interrupts the answer being streamed and is answered immediately.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [lifetimeUsage, setLifetimeUsage] = useState<UsageStats | null>(null);
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerMode, setViewerMode] = useState<'file' | 'web' | null>(null);
  const [viewerFileName, setViewerFileName] = useState<string | null>(null);
  const [viewerFileContent, setViewerFileContent] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerWidth, setViewerWidth] = useState(440);
  const webviewRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dragRef = useRef<'sidebar' | 'viewer' | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  const activeRunRef = useRef<string | null>(null);
  const runSessionRef = useRef<string | null>(null);
  // Synchronous guard against a double send: React state (isRunning) is not updated yet during the
  // same tick, so two fast Enter presses used to start two runs and store the user message twice.
  const sendInFlightRef = useRef(false);
  const currentSessionIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  // Only follow new output while the user is parked at the bottom. If they scrolled up to read
  // older messages, the view must stay exactly where they left it.
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [traceExpanded, setTraceExpanded] = useState(false);

  const isRunning = Boolean(activeRunId);

  useEffect(() => {
    let disposed = false;

    const bootstrap = async () => {
      try {
        const [loadedSettings, loadedSessions, lastSessionId] = await Promise.all([
          window.desktop.settings.get(),
          window.desktop.sessions.list(),
          window.desktop.sessions.getLast().catch(() => null),
        ]);
        if (disposed) return;
        setSettings(loadedSettings);

        let list = loadedSessions;
        if (list.length === 0) {
          const created = await window.desktop.sessions.create();
          list = await window.desktop.sessions.list();
          if (disposed) return;
          setSessions(list);
          await openSession(created.id);
        } else {
          setSessions(list);
          // Reopen the conversation the user was in last time instead of dumping them into an
          // empty window (this is also what a second launch attempt used to look like).
          const target = lastSessionId && list.some((item) => item.id === lastSessionId) ? lastSessionId : list[0].id;
          await openSession(target);
        }
      } catch (bootstrapError) {
        if (!disposed) setError(toMessage(bootstrapError));
      }
    };

    void bootstrap();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    void window.desktop.usage.lifetime().then(setLifetimeUsage).catch(() => {});
  }, [messages.length]);

  useEffect(() => {
    const unsubscribe = window.desktop.agent.onEvent((event) => {
      void handleAgentEvent(event);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(44, el.scrollHeight))}px`;
  }, [composer]);

  useEffect(() => {
    const unsubscribe = window.desktop.webview.onRun((requestId, script) => {
      const webview = webviewRef.current as (HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> }) | null;
      if (!webview || typeof webview.executeJavaScript !== 'function') {
        window.desktop.webview.sendResult(requestId, null, 'Chưa mở web preview panel (open_web_preview trước).');
        return;
      }
      webview.executeJavaScript(script).then(
        (result) => window.desktop.webview.sendResult(requestId, result, null),
        (error) => window.desktop.webview.sendResult(requestId, null, toMessage(error)),
      );
    });
    return unsubscribe;
  }, []);

  const scrollConversationToBottom = (behavior: ScrollBehavior = 'auto') => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  };

  const handleConversationScroll = (event: ReactUIEvent<HTMLElement>) => {
    const element = event.currentTarget;
    const stick = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
    stickToBottomRef.current = stick;
    setShowJumpToBottom((previous) => (previous === !stick ? previous : !stick));
  };

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages, toolStatuses]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = event.clientX - dragStartXRef.current;
      if (dragRef.current === 'sidebar') {
        setSidebarWidth(Math.min(480, Math.max(200, dragStartWidthRef.current + delta)));
      } else {
        setViewerWidth(Math.min(900, Math.max(300, dragStartWidthRef.current - delta)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResize = (which: 'sidebar' | 'viewer') => (event: ReactMouseEvent) => {
    event.preventDefault();
    dragRef.current = which;
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = which === 'sidebar' ? sidebarWidth : viewerWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setViewerMode(null);
    setViewerFileName(null);
    setViewerFileContent(null);
    setViewerUrl(null);
  };

  const openFileInViewer = async () => {
    try {
      const picked = await window.desktop.files.readForPreview();
      if (!picked) return;
      setViewerMode('file');
      setViewerFileName(picked.truncated ? `${picked.name} (đã cắt bớt)` : picked.name);
      setViewerFileContent(picked.content);
      setViewerUrl(null);
      setViewerOpen(true);
    } catch (viewError) {
      setError(toMessage(viewError));
    }
  };

  const openWebInViewer = () => {
    const input = window.prompt('Nhập URL muốn xem (http/https):', 'https://');
    if (!input) return;
    const trimmed = input.trim();
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(withProtocol);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
      setViewerMode('web');
      setViewerUrl(parsed.toString());
      setViewerFileName(null);
      setViewerFileContent(null);
      setViewerOpen(true);
    } catch {
      setError('URL không hợp lệ.');
    }
  };

  const handleAgentEvent = async (event: AgentEvent) => {
    if (event.runId !== activeRunRef.current) return;

    if (event.type === 'assistant-delta' && event.delta) {
      const streamingId = `stream-${event.runId}`;
      setMessages((previous) => {
        const existing = previous.findIndex((message) => message.id === streamingId);
        if (existing === -1) {
          return [
            ...previous,
            {
              id: streamingId,
              role: 'assistant',
              content: event.delta ?? '',
              createdAt: new Date().toISOString(),
            },
          ];
        }
        const next = [...previous];
        next[existing] = { ...next[existing], content: next[existing].content + event.delta };
        return next;
      });
      return;
    }

    if (event.type === 'assistant-committed') {
      // The run froze whatever the model had written so far, because the user interrupted it. Turn
      // the live streaming bubble into a permanent message so the next delta starts a fresh one.
      const streamingId = `stream-${event.runId}`;
      setMessages((previous) => {
        const index = previous.findIndex((message) => message.id === streamingId);
        if (index === -1) return previous;
        const next = [...previous];
        if (!event.finalContent) {
          next.splice(index, 1);
          return next;
        }
        next[index] = {
          ...next[index],
          id: `committed-${event.runId}-${crypto.randomUUID()}`,
          content: event.finalContent,
        };
        return next;
      });
      return;
    }

    if (event.type === 'user-injected' && event.message) {
      // Show the interrupting message in the transcript immediately, right before the answer to it.
      const injectedId = event.messageId ?? `inject-${event.runId}-${crypto.randomUUID()}`;
      setMessages((previous) => {
        if (previous.some((message) => message.id === injectedId)) return previous;
        const next = [...previous];
        const at = next.findIndex((message) => message.id === `stream-${event.runId}`);
        const row = {
          id: injectedId,
          role: 'user' as const,
          content: event.message ?? '',
          createdAt: new Date().toISOString(),
        };
        if (at >= 0) next.splice(at, 0, row);
        else next.push(row);
        return next;
      });
      scrollConversationToBottom();
      return;
    }

    if (event.type === 'context-warning') {
      const before = event.beforeTokens ?? 0;
      const limit = event.contextLimit ?? settings.contextWindowTokens;
      setContextNotice(`Ngữ cảnh gửi đi ~${formatTokenCount(before)} / trần ${formatTokenCount(limit)} token. Vượt ~72% trần là app tự nén phần cũ thành bản tóm tắt.`);
      return;
    }

    if (event.type === 'context-compacted') {
      const before = event.beforeTokens ?? 0;
      const after = event.afterTokens ?? 0;
      setContextNotice(`Đã nén ngữ cảnh: ~${formatTokenCount(before)} → ~${formatTokenCount(after)} token. Toàn bộ chat vẫn được giữ.`);
      return;
    }

    if (event.type === 'context-trimmed') {
      const before = event.beforeTokens ?? 0;
      const after = event.afterTokens ?? 0;
      setContextNotice(`Đã bỏ bớt lượt cũ khỏi ngữ cảnh gửi đi: ~${formatTokenCount(before)} → ~${formatTokenCount(after)} token để chặn chi phí. Nội dung gốc vẫn lưu đầy đủ trong phiên.`);
      return;
    }

    if (event.type === 'retry') {
      setContextNotice(event.message ?? 'Kết nối API bị ngắt, đang thử lại…');
      return;
    }

    if (event.type === 'tool-start' && event.toolName) {
      setToolStatuses((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          label: `Đang gọi ${event.toolName}`,
          detail: compactJson(event.args),
          state: 'running',
        },
      ]);
      return;
    }

    if (event.type === 'tool-result' && event.toolName) {
      setToolStatuses((previous) => {
        const next = [...previous];
        for (let index = next.length - 1; index >= 0; index -= 1) {
          if (next[index].state === 'running' && next[index].label === `Đang gọi ${event.toolName}`) {
            next[index] = {
              ...next[index],
              state: 'done',
              label: `${event.toolName} xong`,
              detail: event.summary,
              image: event.image,
            };
            return next;
          }
        }
        return [
          ...next,
          {
            id: crypto.randomUUID(),
            label: `${event.toolName} xong`,
            detail: event.summary,
            image: event.image,
            state: 'done',
          },
        ];
      });
      return;
    }

    if (
      event.type === 'approval-request' &&
      event.approvalId &&
      event.toolName &&
      event.preview
    ) {
      setApproval({
        approvalId: event.approvalId,
        toolName: event.toolName,
        args: event.args,
        preview: event.preview,
      });
      return;
    }

    if (event.type === 'stopped') {
      const sessionId = runSessionRef.current;
      activeRunRef.current = null;
      runSessionRef.current = null;
      setActiveRunId(null);
      setApproval(null);
      setContextNotice(event.message ?? 'Đã dừng tác vụ.');
      await refreshSessions();
      if (sessionId && currentSessionIdRef.current === sessionId) {
        await openSession(sessionId, true);
      }
      return;
    }

    if (event.type === 'done') {
      const sessionId = runSessionRef.current;
      activeRunRef.current = null;
      runSessionRef.current = null;
      setActiveRunId(null);
      setApproval(null);
      await refreshSessions();
      if (sessionId && currentSessionIdRef.current === sessionId) {
        await openSession(sessionId, true);
      }
      return;
    }

    if (event.type === 'open-preview') {
      if (event.previewKind === 'file') {
        setViewerMode('file');
        setViewerFileName(event.previewName ?? null);
        setViewerFileContent(event.previewContent ?? '');
        setViewerUrl(null);
      } else if (event.previewKind === 'web' && event.previewUrl) {
        setViewerMode('web');
        setViewerUrl(event.previewUrl);
        setViewerFileName(null);
        setViewerFileContent(null);
      }
      setViewerOpen(true);
      return;
    }

    if (event.type === 'error') {
      const sessionId = runSessionRef.current;
      setError(event.message ?? 'Agent chạy lỗi.');
      activeRunRef.current = null;
      runSessionRef.current = null;
      setActiveRunId(null);
      setApproval(null);
      setToolStatuses([]);
      if (sessionId && currentSessionIdRef.current === sessionId) {
        const session = await window.desktop.sessions.get(sessionId);
        setCurrentSession(session);
        setMessages(session.messages);
      }
    }
  };

  const refreshSessions = async () => {
    const list = await window.desktop.sessions.list();
    setSessions(list);
  };

  const openSession = async (sessionId: string, keepToolTrace = false) => {
    const session = await window.desktop.sessions.get(sessionId);
    currentSessionIdRef.current = session.id;
    setCurrentSession(session);
    setMessages(session.messages);
    if (!keepToolTrace) setToolStatuses([]);
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    setError(null);
    void window.desktop.sessions.setLast(session.id).catch(() => {});
  };

  const createSession = async () => {
    if (isRunning) return;
    const created = await window.desktop.sessions.create();
    await refreshSessions();
    await openSession(created.id);
  };

  const deleteSession = async (sessionId: string) => {
    if (isRunning) return;
    if (!window.confirm('Xoá cuộc trò chuyện này?')) return;
    await window.desktop.sessions.delete(sessionId);
    let list = await window.desktop.sessions.list();
    if (list.length === 0) {
      await window.desktop.sessions.create();
      list = await window.desktop.sessions.list();
    }
    setSessions(list);
    if (currentSession?.id === sessionId) await openSession(list[0].id);
  };

  const togglePin = async (session: PublicSession) => {
    try {
      const list = await window.desktop.sessions.setPinned(session.id, !session.pinned);
      setSessions(list);
    } catch (pinError) {
      setError(toMessage(pinError));
    }
  };

  const startRename = (session: PublicSession) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const submitRename = async (sessionId: string) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      const list = await window.desktop.sessions.rename(sessionId, title);
      setSessions(list);
      if (currentSession?.id === sessionId) setCurrentSession({ ...currentSession, title });
    } catch (renameError) {
      setError(toMessage(renameError));
    }
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1500);
    } catch (copyError) {
      setError(toMessage(copyError));
    }
  };

  const chooseWorkingDirectory = async () => {
    if (!currentSession || isRunning) return;
    try {
      const updated = await window.desktop.sessions.chooseDirectory(currentSession.id);
      if (!updated) return;
      setCurrentSession(updated);
      await refreshSessions();
    } catch (directoryError) {
      setError(toMessage(directoryError));
    }
  };

  const attachFiles = async () => {
    if (isRunning || attaching) return;
    setAttaching(true);
    try {
      const picked = await window.desktop.files.attach();
      if (picked.length > 0) setAttachments((previous) => [...previous, ...picked]);
    } catch (attachError) {
      setError(toMessage(attachError));
    } finally {
      setAttaching(false);
    }
  };

  const attachFolder = async () => {
    if (isRunning || attaching) return;
    setAttaching(true);
    try {
      const { rootName, files } = await window.desktop.files.attachFolder();
      if (files.length > 0) {
        const batchId = crypto.randomUUID();
        const tagged = files.map((file) => ({ ...file, batchId, batchLabel: rootName }));
        setAttachments((previous) => [...previous, ...tagged]);
      }
    } catch (attachError) {
      setError(toMessage(attachError));
    } finally {
      setAttaching(false);
    }
  };

  const removeAttachment = (name: string) => {
    setAttachments((previous) => previous.filter((file) => file.name !== name));
  };

  const removeAttachmentBatch = (batchId: string) => {
    setAttachments((previous) => previous.filter((file) => file.batchId !== batchId));
  };

  const removePastedImage = (index: number) => {
    setPastedImages((previous) => previous.filter((_, i) => i !== index));
  };

  // Downscale/recompress a pasted screenshot before it ever leaves the renderer, so a 4K
  // clipboard capture doesn't balloon the saved session JSON or the vision token estimate.
  const resizeImageDataUrl = (dataUrl: string, maxSide = 1280, quality = 0.72): Promise<string> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas 2D context unavailable.')); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Không đọc được ảnh vừa dán.'));
      img.src = dataUrl;
    });

  const onComposerPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    event.preventDefault();
    if (pastedImages.length >= 4) {
      setError('Tối đa 4 ảnh mỗi tin nhắn (mỗi ảnh còn bị gửi lại ở các lượt sau, nên càng ít càng rẻ).');
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) return;
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Không đọc được ảnh vừa dán.'));
        reader.readAsDataURL(file);
      });
      const resized = await resizeImageDataUrl(raw);
      setPastedImages((previous) => [...previous, resized]);
    } catch (pasteError) {
      setError(toMessage(pasteError));
    }
  };

  const buildOutgoingText = (text: string): string => {
    if (attachments.length === 0) return text;
    // Inlined attachments are part of every single request of the run, so a 20 MB folder dump
    // would both blow past the model window and multiply the bill. Cap what is inlined and let
    // the agent read the rest with its own tools (which are cheap, local reads).
    const ATTACHMENT_BUDGET_CHARS = 200_000;
    const blocks: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const file of attachments) {
      const remaining = ATTACHMENT_BUDGET_CHARS - used;
      const note = file.truncated ? ' (đã cắt bớt, giới hạn 300 KB)' : '';
      if (remaining <= 0) {
        omitted += file.content.length;
        continue;
      }
      const content = file.content.length > remaining ? file.content.slice(0, remaining) : file.content;
      used += content.length;
      omitted += file.content.length - content.length;
      const cutNote = content.length < file.content.length ? ' (đã cắt bớt để không vượt ngân sách gửi đi)' : '';
      blocks.push(`File đính kèm: ${file.name}${note}${cutNote}\n\`\`\`\n${content}\n\`\`\``);
    }
    if (omitted > 0) {
      blocks.push(`[Đính kèm quá lớn: ${omitted.toLocaleString('vi-VN')} ký tự còn lại đã được bỏ để không đẩy request vượt ngân sách. Dùng read_file / search_files / list_directory để đọc đúng phần cần thiết.]`);
    }
    return [...blocks, text].filter(Boolean).join('\n\n');
  };

  const sendMessage = async (overrideText?: string) => {
    if (!currentSession) return;
    const text = (overrideText ?? composer).trim();
    if (!text && attachments.length === 0 && pastedImages.length === 0) return;
    // DUPLICATE-SEND GUARD. `isRunning` is React state, so it is still false for the rest of the
    // current tick: two fast Enter presses (or Enter plus a click on Send) both passed the check
    // below and each started its own run, which persisted the same user message twice. This ref is
    // set synchronously, so the second invocation is rejected before it can reach agent:start.
    if (sendInFlightRef.current) return;
    // Snapshots of what the user is sending, so a failed send can always restore it verbatim.
    const outgoingImagesSnapshot = pastedImages;
    const outgoingAttachmentsSnapshot = attachments;
    if (isRunning) {
      // Steering, not queueing: hand the message to the LIVE run. The agent interrupts the answer it
      // is streaming, answers this straight away, then carries on with the original task.
      // If there is no live run to steer (the run just finished but React state has not caught up
      // yet), fall through to a normal send below instead of returning and losing the typed text.
      const liveRunId = activeRunRef.current;
      if (text && liveRunId) {
        const injectedText = buildOutgoingText(text);
        setComposer('');
        setAttachments([]);
        setPastedImages([]);
        setError(null);
        scrollConversationToBottom();
        try {
          await window.desktop.agent.inject(currentSession.id, liveRunId, injectedText);
        } catch (injectError) {
          // Put the text back so nothing the user typed is ever lost.
          setComposer(text);
          setAttachments(attachments);
          setPastedImages(outgoingImagesSnapshot);
          setError(toMessage(injectError));
        }
        return;
      }
    }
    if (!settings.apiKeyConfigured && settings.baseUrl.includes('deepseek.com')) {
      setError('Vào Cài đặt để nhập API key DeepSeek trước.');
      setSettingsOpen(true);
      return;
    }

    const outgoingText = buildOutgoingText(text);
    const outgoingImages = pastedImages;
    sendInFlightRef.current = true;
    setComposer('');
    setAttachments([]);
    setPastedImages([]);
    setError(null);
    setToolStatuses([]);
    scrollConversationToBottom();

    const requestedRunId = crypto.randomUUID();
    activeRunRef.current = requestedRunId;
    runSessionRef.current = currentSession.id;
    setActiveRunId(requestedRunId);

    try {
      const { runId, userMessage } = await window.desktop.agent.start(currentSession.id, outgoingText, requestedRunId, outgoingImages);
      setMessages((previous) => {
        const streamId = `stream-${runId}`;
        const streamIndex = previous.findIndex((message) => message.id === streamId);
        const hasUserMessage = previous.some((message) => message.id === userMessage.id);
        if (streamIndex >= 0) {
          if (hasUserMessage) return previous;
          const next = [...previous];
          next.splice(streamIndex, 0, userMessage);
          return next;
        }
        return [
          ...previous,
          ...(hasUserMessage ? [] : [userMessage]),
          {
            id: streamId,
            role: 'assistant' as const,
            content: '',
            createdAt: new Date().toISOString(),
          },
        ];
      });
      await refreshSessions();
    } catch (sendError) {
      activeRunRef.current = null;
      runSessionRef.current = null;
      setActiveRunId(null);
      setComposer(text);
      setAttachments(outgoingAttachmentsSnapshot);
      setPastedImages(outgoingImagesSnapshot);
      setError(toMessage(sendError));
    } finally {
      // Released once the run has been accepted (or failed), so the next send is allowed again.
      sendInFlightRef.current = false;
    }
  };

  const stopRun = async () => {
    const runId = activeRunRef.current;
    if (!runId) return;
    try {
      setContextNotice('Đang dừng tác vụ…');
      await window.desktop.agent.stop(runId);
    } catch (stopError) {
      setError(toMessage(stopError));
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const resolveApproval = async (approved: boolean) => {
    if (!approval) return;
    const current = approval;
    setApproval(null);
    try {
      await window.desktop.agent.resolveApproval(current.approvalId, approved);
    } catch (approvalError) {
      setError(toMessage(approvalError));
    }
  };

  const compactNow = async () => {
    if (!currentSession || isRunning || isCompacting) return;
    if (!settings.apiKeyConfigured && settings.baseUrl.includes('deepseek.com')) {
      setError('Vào Cài đặt để nhập API key DeepSeek trước khi nén ngữ cảnh.');
      setSettingsOpen(true);
      return;
    }
    setIsCompacting(true);
    setError(null);
    try {
      const result = await window.desktop.agent.compact(currentSession.id);
      setContextNotice(
        result.changed
          ? `Đã nén ngữ cảnh: ~${formatTokenCount(result.beforeTokens)} → ~${formatTokenCount(result.afterTokens)} token. Toàn bộ chat vẫn được giữ.`
          : result.message,
      );
      await refreshSessions();
      await openSession(currentSession.id);
    } catch (compactError) {
      setError(toMessage(compactError));
    } finally {
      setIsCompacting(false);
    }
  };

  const toggleFullControl = async () => {
    const next = !settings.fullControl;
    if (next) {
      const ok = window.confirm(
        'Bật TOÀN QUYỀN: agent hết giới hạn thư mục, hết bộ lọc lệnh shell, hết hỏi duyệt — đọc/ghi/xoá bất kỳ file nào và chạy bất kỳ lệnh nào trên máy này ngay lập tức.\n\nKhông cần chọn thư mục trước nữa. Đây là chế độ rủi ro cao thật sự — chỉ dùng khi bạn thật sự tin tưởng nội dung đang nhờ nó làm.\n\nBấm OK để bật, bấm Cancel để giữ nguyên chế độ an toàn (giới hạn thư mục + duyệt tay).',
      );
      if (!ok) return;
    }
    try {
      const updated = await window.desktop.settings.update({ fullControl: next, autoApprove: next });
      setSettings(updated);
    } catch (toggleError) {
      setError(toMessage(toggleError));
    }
  };

  const cycleTheme = async () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length];
    try {
      const updated = await window.desktop.settings.update({ theme: next });
      setSettings(updated);
    } catch (themeError) {
      setError(toMessage(themeError));
    }
  };

  const changeModel = async (model: string) => {
    try {
      const updated = await window.desktop.settings.update({ model: model as AppSettings['model'] });
      setSettings(updated);
    } catch (modelError) {
      setError(toMessage(modelError));
    }
  };

  const changeReasoningEffort = async (reasoningEffort: string) => {
    try {
      const updated = await window.desktop.settings.update({
        reasoningEffort: reasoningEffort as AppSettings['reasoningEffort'],
      });
      setSettings(updated);
    } catch (effortError) {
      setError(toMessage(effortError));
    }
  };

  const directoryLabel = useMemo(() => {
    if (!currentSession?.workingDirectory) return 'Chọn thư mục làm việc';
    const parts = currentSession.workingDirectory.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || currentSession.workingDirectory;
  }, [currentSession?.workingDirectory]);

  return (
    <div className="app-shell">
      <aside className="sidebar" style={{ width: sidebarOpen ? sidebarWidth : 0 }}>
        <div className="sidebar-brand">
          <div className="brand-mark"><Code2 size={19} /></div>
          <div>
            <strong>DeepSeek Code</strong>
            <span>Trợ lý Desktop</span>
          </div>
        </div>

        <button className="new-chat-button" type="button" onClick={() => void createSession()} disabled={isRunning}>
          <MessageSquarePlus size={17} /> Cuộc trò chuyện mới
        </button>

        <div className="session-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${currentSession?.id === session.id ? 'active' : ''}`}
              onClick={() => !isRunning && renamingId !== session.id && void openSession(session.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isRunning && renamingId !== session.id) void openSession(session.id);
              }}
            >
              <div className="session-copy">
                {session.pinned && <Pin size={11} className="pin-mark" />}
                {renamingId === session.id ? (
                  <input
                    autoFocus
                    className="rename-input"
                    value={renameValue}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => void submitRename(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void submitRename(session.id); }
                      if (event.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <strong>{session.title}</strong>
                )}
                <span>{session.workingDirectory ? lastPathPart(session.workingDirectory) : 'Chưa chọn thư mục'}</span>
              </div>
              <span className="session-actions">
                <span
                  role="button"
                  tabIndex={0}
                  className="session-action-btn"
                  onClick={(event) => { event.stopPropagation(); void togglePin(session); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); void togglePin(session); } }}
                  aria-label={session.pinned ? 'Bỏ ghim' : 'Ghim cuộc trò chuyện'}
                  title={session.pinned ? 'Bỏ ghim' : 'Ghim'}
                >
                  {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="session-action-btn"
                  onClick={(event) => { event.stopPropagation(); startRename(session); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); startRename(session); } }}
                  aria-label="Đổi tên"
                  title="Đổi tên"
                >
                  <Pencil size={13} />
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="session-action-btn danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteSession(session.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.stopPropagation();
                      void deleteSession(session.id);
                    }
                  }}
                  aria-label="Xoá cuộc trò chuyện"
                  title="Xoá"
                >
                  <Trash2 size={13} />
                </span>
              </span>
            </div>
          ))}
        </div>

        <button className="settings-button" type="button" onClick={() => setSettingsOpen(true)}>
          <Settings size={17} /> Cài đặt
          <ChevronRight size={15} />
        </button>
      </aside>

      {sidebarOpen && <div className="resizer" onMouseDown={startResize('sidebar')} />}

      <main className="main-panel">
        <header className="topbar">
          <button className="sidebar-toggle" type="button" onClick={() => setSidebarOpen((value) => !value)} aria-label="Ẩn/hiện thanh bên">
            <Code2 size={17} />
          </button>
          <button className="directory-button" type="button" onClick={() => void chooseWorkingDirectory()} disabled={isRunning}>
            <FolderOpen size={16} />
            <span>{directoryLabel}</span>
          </button>
          <button className="topbar-settings" type="button" onClick={() => void openFileInViewer()} title="Xem file" aria-label="Xem file">
            <FileCode2 size={17} />
          </button>
          <button className="topbar-settings" type="button" onClick={openWebInViewer} title="Xem web preview" aria-label="Xem web preview">
            <Globe size={17} />
          </button>
          <div className="topbar-spacer" />
          {currentSession && (currentSession.usage.promptTokens > 0 || currentSession.usage.completionTokens > 0) && (() => {
            const usage = currentSession.usage;
            const hit = usage.promptCacheHitTokens ?? 0;
            const miss = usage.promptCacheMissTokens ?? Math.max(0, usage.promptTokens - hit);
            const hitRatio = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : null;
            const cost = resolveCostUsd(settings.model, usage);
            const lifetimeCost = lifetimeUsage ? resolveCostUsd(settings.model, lifetimeUsage) : null;
            const tooltip = [
              `Phiên này: ${usage.promptTokens.toLocaleString('vi-VN')} token vào (${formatTokenCount(hit)} cache hit · ${formatTokenCount(miss)} cache miss${hitRatio !== null ? ` · ${hitRatio}% hit` : ''}), ${usage.completionTokens.toLocaleString('vi-VN')} token ra.`,
              cost
                ? cost.tracked
                  ? `Chi phí phiên: ${formatUsd(cost.value)} — giá thật, tính theo model + giờ cao điểm/thấp điểm tại thời điểm gọi.`
                  : `Chi phí phiên: ~${formatUsd(cost.value)} (dữ liệu cũ chưa ghi nhận giá thật, tạm tính ở mức off-peak nên có thể lệch).`
                : 'Model này chưa có trong bảng giá nên chưa tính được chi phí.',
              lifetimeUsage
                ? `Tổng từ trước tới giờ: ${formatTokenCount(lifetimeUsage.promptTokens)} vào / ${formatTokenCount(lifetimeUsage.completionTokens)} ra${lifetimeCost ? ` · ${lifetimeCost.tracked ? formatUsd(lifetimeCost.value) : `~${formatUsd(lifetimeCost.value)} (ước tính)`}` : ''}.`
                : '',
              'Cache hit rẻ hơn cache miss ~50 lần; giờ cao điểm giá gấp đôi giờ thấp điểm (cao điểm: 01:00-04:00 và 06:00-10:00 UTC, T2-T6).',
              `Trần ngữ cảnh mỗi request: ${formatTokenCount(Math.min(settings.contextWindowTokens, settings.maxInputTokens))} token (ngân sách ${formatTokenCount(settings.maxInputTokens)}, cửa sổ model ${formatTokenCount(settings.contextWindowTokens)}). Phần cũ hơn được nén thành tóm tắt thay vì gửi lại.`,
              isPeakTime()
                ? 'Đang trong giờ cao điểm: giá gấp đôi, việc nặng nên dời sang khung thấp điểm.'
                : 'Đang là giờ thấp điểm: giá chỉ bằng một nửa giờ cao điểm.',
            ].filter(Boolean).join(' ');
            return (
              <span className="usage-pill" title={tooltip}>
                {formatTokenCount(usage.promptTokens)} in · {formatTokenCount(usage.completionTokens)} out
                {hitRatio !== null ? ` · ${hitRatio}% hit` : ''}
                {cost ? ` · ${cost.tracked ? '' : '~'}${formatUsd(cost.value)}` : ''}
              </span>
            );
          })()}
          <span className="model-pill"><Bot size={14} /> {settings.model}</span>
          <button
            className={`full-control-button ${settings.fullControl ? 'active' : ''}`}
            type="button"
            onClick={() => void toggleFullControl()}
            title={settings.fullControl ? 'Toàn quyền đang BẬT — bấm để tắt, quay lại chế độ an toàn' : 'Toàn quyền đang TẮT — bấm để bật, hết giới hạn thư mục và lệnh'}
          >
            <ShieldAlert size={15} />
            {settings.fullControl ? 'Toàn quyền: BẬT' : 'Toàn quyền: TẮT'}
          </button>
          <button
            className="topbar-settings"
            type="button"
            onClick={() => void cycleTheme()}
            title={THEME_LABEL[settings.theme]}
            aria-label={THEME_LABEL[settings.theme]}
          >
            {(() => {
              const ThemeIcon = THEME_ICON[settings.theme];
              return <ThemeIcon size={17} />;
            })()}
          </button>
          <button
            className="topbar-settings compact-button"
            type="button"
            onClick={() => void compactNow()}
            disabled={isRunning || isCompacting}
            title="Nén ngữ cảnh ngay"
            aria-label="Nén ngữ cảnh ngay"
          >
            {isCompacting ? <LoaderCircle size={17} className="spin" /> : <Minimize2 size={17} />}
          </button>
          <button className="topbar-settings" type="button" onClick={() => setSettingsOpen(true)} aria-label="Cài đặt">
            <Settings size={17} />
          </button>
        </header>

        <section className="conversation" ref={conversationRef} onScroll={handleConversationScroll}>
          {messages.length === 0 ? (
            <EmptyState hasFolder={Boolean(currentSession?.workingDirectory)} onChooseFolder={chooseWorkingDirectory} />
          ) : (
            <div className="message-stack">
              {messages.map((message) => (
                <article key={message.id} className={`message-row ${message.role}`}>
                  <div className="message-avatar">
                    {message.role === 'assistant' ? <Bot size={16} aria-hidden="true" /> : <UserRound size={16} aria-hidden="true" />}
                  </div>
                  <div className="message-body">
                    {message.role === 'assistant' ? (
                      message.content ? <MarkdownMessage content={message.content} /> : <TypingIndicator />
                    ) : (
                      <>
                        {message.images && message.images.length > 0 && (
                          <div className="user-image-row">
                            {message.images.map((src, index) => (
                              <img key={index} src={src} alt="Ảnh đính kèm" className="chat-image user-attached-image" />
                            ))}
                          </div>
                        )}
                        {message.content && <p className="user-message-text">{message.content}</p>}
                      </>
                    )}
                    {message.content && (
                      <button
                        type="button"
                        className="message-copy-btn"
                        onClick={() => void copyMessage(message)}
                        aria-label="Copy tin nhắn"
                        title="Copy tin nhắn"
                      >
                        {copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    )}
                  </div>
                </article>
              ))}

              {toolStatuses.length > 0 && (
                <div className="tool-trace">
                  {(() => {
                    const running = toolStatuses.some((tool) => tool.state === 'running');
                    const latest = toolStatuses[toolStatuses.length - 1];
                    return (
                      <button
                        type="button"
                        className="tool-line tool-trace-summary"
                        onClick={() => setTraceExpanded((previous) => !previous)}
                        aria-expanded={traceExpanded}
                        title={traceExpanded ? 'Thu gọn danh sách thao tác' : 'Mở danh sách thao tác'}
                      >
                        <span className="tool-chevron">{traceExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                        {running ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
                        <strong>{toolStatuses.length} thao tác</strong>
                        {latest && <span className="tool-trace-hint">{latest.label}</span>}
                      </button>
                    );
                  })()}
                  {traceExpanded &&
                    toolStatuses.slice(-12).map((tool) => {
                      const expanded = Boolean(expandedTools[tool.id]);
                      return (
                        <div className={'tool-line-wrap' + (expanded ? ' open' : '')} key={tool.id}>
                          <button
                            type="button"
                            className="tool-line"
                            onClick={() => setExpandedTools((previous) => ({ ...previous, [tool.id]: !previous[tool.id] }))}
                            title={expanded ? 'Thu gọn chi tiết' : 'Mở chi tiết tool call'}
                            aria-expanded={expanded}
                          >
                            <span className="tool-chevron">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                            {tool.state === 'running' ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}
                            <strong>{tool.label}</strong>
                          </button>
                          {expanded && tool.detail && <div className="tool-detail">{tool.detail}</div>}
                          {expanded && tool.image && <img src={tool.image} alt="screenshot" className="chat-image tool-screenshot" />}
                        </div>
                      );
                    })}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
          {showJumpToBottom && messages.length > 0 && (
            <button type="button" className="jump-to-bottom" onClick={() => scrollConversationToBottom('smooth')}>
              <ChevronDown size={15} /> Xuống tin mới nhất
            </button>
          )}
        </section>

        <footer className="composer-wrap">
          {contextNotice && (
            <div className="context-banner">
              <Minimize2 size={15} /> <span>{contextNotice}</span>
              <button type="button" onClick={() => setContextNotice(null)} aria-label="Đóng thông báo"><X size={14} /></button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <CircleAlert size={16} /> <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Đóng lỗi"><X size={14} /></button>
            </div>
          )}
          <div className="composer">
            {(attachments.length > 0 || pastedImages.length > 0) && (
              <div className="attachment-row">
                {pastedImages.map((src, index) => (
                  <span className="attachment-chip image-chip" key={`img-${index}`}>
                    <img src={src} alt="Ảnh đã dán" />
                    <button type="button" onClick={() => removePastedImage(index)} aria-label="Bỏ ảnh">
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {(() => {
                  const seenBatches = new Set<string>();
                  return attachments.map((file) => {
                    if (file.batchId) {
                      if (seenBatches.has(file.batchId)) return null;
                      seenBatches.add(file.batchId);
                      const batchFiles = attachments.filter((f) => f.batchId === file.batchId);
                      const totalTruncated = batchFiles.filter((f) => f.truncated).length;
                      return (
                        <span
                          className="attachment-chip"
                          key={file.batchId}
                          title={batchFiles.map((f) => f.name).join('\n')}
                        >
                          <FolderOpen size={12} />
                          {file.batchLabel} ({batchFiles.length} file{batchFiles.length > 1 ? '' : ''})
                          {totalTruncated > 0 && <em>({totalTruncated} bị cắt bớt)</em>}
                          <button type="button" onClick={() => removeAttachmentBatch(file.batchId!)} aria-label={`Bỏ thư mục ${file.batchLabel}`}>
                            <X size={12} />
                          </button>
                        </span>
                      );
                    }
                    return (
                      <span className="attachment-chip" key={file.name}>
                        <Paperclip size={12} />
                        {file.name}
                        {file.truncated && <em>(đã cắt bớt)</em>}
                        <button type="button" onClick={() => removeAttachment(file.name)} aria-label={`Bỏ ${file.name}`}>
                          <X size={12} />
                        </button>
                      </span>
                    );
                  });
                })()}
              </div>
            )}
            <textarea
              ref={composerRef}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={onComposerKeyDown}
              onPaste={(event) => void onComposerPaste(event)}
              placeholder={currentSession?.workingDirectory ? 'Nhờ agent kiểm tra, sửa, test hoặc giải thích dự án này… (Ctrl+V để dán ảnh)' : 'Hỏi bất cứ điều gì, hoặc chọn thư mục dự án để agent đọc/sửa file… (Ctrl+V để dán ảnh)'}
              rows={1}
            />
            {isRunning && (
              <div className="composer-queue-hint">
                Agent đang chạy: cứ gõ tin nhắn rồi Enter — agent chen ngang trả lời ngay, rồi làm
                tiếp việc đang dở. Bấm “Dừng” nếu muốn kết thúc hẳn.
              </div>
            )}
            <div className="composer-bottom">
              <button
                className="attach-button"
                type="button"
                onClick={() => void attachFiles()}
                disabled={attaching}
                title="Đính kèm file vào tin nhắn"
                aria-label="Đính kèm file"
              >
                {attaching ? <LoaderCircle size={15} className="spin" /> : <Paperclip size={15} />}
              </button>
              <button
                className="attach-button"
                type="button"
                onClick={() => void attachFolder()}
                disabled={attaching}
                title="Đính kèm cả thư mục vào tin nhắn"
                aria-label="Đính kèm thư mục"
              >
                {attaching ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}
              </button>
              <select
                className="quick-picker"
                value={settings.model}
                onChange={(event) => void changeModel(event.target.value)}
                title="Đổi model"
                aria-label="Đổi model"
              >
                <option value="deepseek-flash">deepseek-flash</option>
                <option value="deepseek-v4-pro">deepseek-v4-pro</option>
              </select>
              <select
                className="quick-picker"
                value={settings.reasoningEffort}
                onChange={(event) => void changeReasoningEffort(event.target.value)}
                title="Độ suy luận — cao hơn thì chính xác hơn với bài khó nhưng tốn tiền hơn (tính theo output)"
                aria-label="Độ suy luận"
              >
                <option value="none">Suy luận: Tắt</option>
                <option value="low">Suy luận: Thấp</option>
                <option value="high">Suy luận: Cao</option>
                <option value="max">Suy luận: Max</option>
              </select>
              <span>Enter để gửi · Shift+Enter xuống dòng</span>
              {isRunning && (
                <button className="stop-button" type="button" onClick={() => void stopRun()}>
                  <Square size={15} /> Dừng
                </button>
              )}
              <button
                className="send-button"
                type="button"
                onClick={() => void sendMessage()}
                disabled={
                  isRunning
                    ? !composer.trim()
                    : !composer.trim() && attachments.length === 0 && pastedImages.length === 0
                }
              >
                <Play size={17} /> {isRunning ? 'Gửi ngay' : 'Gửi'}
              </button>
            </div>
          </div>
        </footer>
      </main>

      {viewerOpen && <div className="resizer" onMouseDown={startResize('viewer')} />}

      {viewerOpen && (
        <aside className="viewer-panel" style={{ width: viewerWidth }}>
          <div className="viewer-header">
            <span className="viewer-header-icon">{viewerMode === 'web' ? <Globe size={14} /> : <FileCode2 size={14} />}</span>
            <span className="viewer-header-title">{viewerMode === 'file' ? viewerFileName : viewerUrl}</span>
            <button type="button" onClick={closeViewer} aria-label="Đóng panel xem">
              <X size={15} />
            </button>
          </div>
          <div className="viewer-body">
            {viewerMode === 'file' && <pre className="viewer-file-content">{viewerFileContent}</pre>}
            {viewerMode === 'web' && viewerUrl && (
              <webview ref={webviewRef} src={viewerUrl} className="viewer-webview" />
            )}
          </div>
        </aside>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => setSettings(next)}
        />
      )}

      {approval && (
        <ApprovalPanel
          request={approval}
          onApprove={() => void resolveApproval(true)}
          onDeny={() => void resolveApproval(false)}
        />
      )}
    </div>
  );
}

function EmptyState({ hasFolder, onChooseFolder }: { hasFolder: boolean; onChooseFolder: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Bot size={28} aria-hidden="true" /></div>
      <h1>Trợ lý lập trình DeepSeek</h1>
      <p>
        Chat bình thường không cần chọn thư mục. Muốn agent đọc/sửa file hay chạy lệnh trong dự án thì chọn 1 thư mục làm việc — ghi/sửa file và chạy lệnh shell mặc định cần bạn duyệt trước.
      </p>
      {!hasFolder && (
        <button type="button" className="primary-button" onClick={onChooseFolder}>
          <FolderOpen size={17} /> Chọn thư mục dự án (không bắt buộc)
        </button>
      )}
      <div className="capability-grid">
        <div><FileCode2 size={18} /><strong>File dự án</strong><span>Đọc, tìm kiếm, ghi và sửa đúng đoạn text.</span></div>
        <div><TerminalSquare size={18} /><strong>Công cụ shell</strong><span>Chạy lệnh npm, Python, Git và lệnh dự án.</span></div>
        <div><ShieldAlert size={18} /><strong>Cổng duyệt</strong><span>Xem diff và lệnh trước khi cho chạy.</span></div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-indicator" aria-label="Trợ lý đang trả lời">
      <span /> <span /> <span />
    </div>
  );
}

function SettingsPanel({
  settings,
  onClose,
  onSaved,
}: {
  settings: PublicSettings;
  onClose: () => void;
  onSaved: (settings: PublicSettings) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>({
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature,
    autoApprove: settings.autoApprove,
    reasoningEffort: settings.reasoningEffort,
    hybridThinking: settings.hybridThinking !== false,
    contextWindowTokens: settings.contextWindowTokens,
    maxInputTokens: settings.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens,
    theme: settings.theme,
    fullControl: settings.fullControl,
    customInstructions: settings.customInstructions,
    enabledTools: settings.enabledTools,
    remoteEnabled: settings.remoteEnabled,
    remotePort: settings.remotePort,
    remoteToken: settings.remoteToken,
    remoteSessionId: settings.remoteSessionId,
  });
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [lifetimeUsage, setLifetimeUsage] = useState<UsageStats | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{ running: boolean; url: string | null; candidates: { name: string; url: string }[]; qr: string | null } | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);

  useEffect(() => {
    void window.desktop.usage.lifetime().then(setLifetimeUsage).catch(() => {});
    void window.desktop.remote.status().then(setRemoteStatus).catch(() => {});
  }, []);

  const toggleRemote = async () => {
    setRemoteBusy(true);
    try {
      const next = remoteStatus?.running ? await window.desktop.remote.stop() : await window.desktop.remote.start();
      setRemoteStatus(next);
    } catch (remoteError) {
      setLocalError(toMessage(remoteError));
    } finally {
      setRemoteBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setLocalError(null);
    try {
      let next = await window.desktop.settings.update(draft);
      if (apiKey.trim()) next = await window.desktop.settings.setApiKey(apiKey.trim());
      onSaved(next);
      onClose();
    } catch (saveError) {
      setLocalError(toMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const clearApiKey = async () => {
    try {
      const next = await window.desktop.settings.clearApiKey();
      onSaved(next);
      setApiKey('');
    } catch (clearError) {
      setLocalError(toMessage(clearError));
    }
  };

  return (
    <div className="overlay">
      <form className="settings-panel" onSubmit={save}>
        <div className="panel-heading">
          <div><h2>Cài đặt</h2><p>Thông tin API và quyền hạn được lưu ngay trên máy bạn.</p></div>
          <button type="button" onClick={onClose} className="close-button"><X size={18} /></button>
        </div>

        {draft.baseUrl.includes('deepseek.com') && (
          <>
            <label>
              <span>API key DeepSeek</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings.apiKeyConfigured ? 'Đã có key được mã hoá — nhập để thay key mới' : 'sk-…'}
                autoComplete="off"
              />
              <small>Key được mã hoá bằng Electron safeStorage, không bao giờ ghi ra file app-data.json dạng chữ thường.</small>
            </label>
            {settings.apiKeyConfigured && (
              <button type="button" className="text-danger-button" onClick={() => void clearApiKey()}>Xoá key đã lưu</button>
            )}
          </>
        )}

        <label>
          <span>Base URL</span>
          <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
        </label>

        <label>
          <span>Model</span>
          <input
            list="model-presets"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
          <datalist id="model-presets">
            <option value="deepseek-flash" />
            <option value="deepseek-v4-pro" />
          </datalist>
          <small>Có sẵn 2 model DeepSeek hiện tại, nhưng có thể gõ tên model khác tương thích chuẩn OpenAI.</small>
        </label>

        <label>
          <span>Temperature: {draft.temperature.toFixed(1)}</span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={draft.temperature}
            onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
          />
          <small>DeepSeek hiện bỏ qua temperature khi đang bật chế độ suy luận (thinking mode).</small>
        </label>

        <label className="toggle-row">
          <div>
            <span>Hybrid thinking: chỉ suy luận ở bước đầu mỗi lượt</span>
            <small>
              Bật: lượt chạy chỉ bật thinking cho lần gọi đầu tiên (lúc lập kế hoạch), các vòng gọi
              tool tiếp theo gửi cờ thinking disabled nên không tính tiền token suy luận nữa — và
              cũng không gửi lại chuỗi suy luận cũ vào context. Đây là mức tiết kiệm lớn nhất cho
              các lượt dùng nhiều tool. Tắt: giữ nguyên hành vi cũ (suy luận mọi vòng).
            </small>
          </div>
          <input
            type="checkbox"
            checked={draft.hybridThinking !== false}
            onChange={(event) => setDraft({ ...draft, hybridThinking: event.target.checked })}
          />
        </label>

        <label>
          <span>Mức độ suy luận</span>
          <select
            value={draft.reasoningEffort}
            onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value as AppSettings['reasoningEffort'] })}
          >
            <option value="none">Tắt — không suy luận (rẻ nhất, trả lời nhanh)</option>
            <option value="low">Thấp</option>
            <option value="high">Cao</option>
            <option value="max">Tối đa</option>
          </select>
          <small>Chỉ áp dụng cho DeepSeek. "Tắt" gửi cờ thinking disabled để chắc chắn không tốn token suy luận (reasoning).</small>
        </label>

        <label>
          <span>Giới hạn ngữ cảnh (token)</span>
          <input
            type="number"
            min="16000"
            max="2000000"
            step="1000"
            value={draft.contextWindowTokens}
            onChange={(event) => setDraft({ ...draft, contextWindowTokens: Number(event.target.value) })}
          />
          <small>Model DeepSeek hiện có 1.000.000 token. Cảnh báo khi ~60%, tự nén khi ~72%. Nếu đổi sang nhà cung cấp khác có thể cần chỉnh số này.</small>
        </label>

        <label>
          <span>Ngân sách ngữ cảnh mỗi request: {formatTokenCount(draft.maxInputTokens)} token</span>
          <input
            type="range"
            min="16000"
            max="600000"
            step="1000"
            value={Math.min(draft.maxInputTokens, 600000)}
            onChange={(event) => setDraft({ ...draft, maxInputTokens: Number(event.target.value) })}
          />
          <small>
            Đây là mức trần thật sự cho chi phí: mỗi vòng agent gửi lại toàn bộ ngữ cảnh, nên ngữ cảnh càng lớn thì mỗi vòng càng đắt. App cảnh báo ở 60% và tự nén phần cũ thành tóm tắt ở 72%; vượt trần thì nó cắt bớt lượt cũ (bản đầy đủ vẫn lưu trong máy). Mặc định 64K token là điểm cân bằng tốt; muốn tiết kiệm hơn nữa thì hạ xuống 32–64K.
          </small>
        </label>

                <label>
          <span>Giới hạn token trả về mỗi lượt (output): {draft.maxOutputTokens === 0 ? 'Không giới hạn' : formatTokenCount(draft.maxOutputTokens)}</span>
          <input
            type="range"
            min="0"
            max="32768"
            step="256"
            value={draft.maxOutputTokens}
            onChange={(event) => setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })}
          />
          <small>
            Trần số token model được sinh ra mỗi lượt (gồm cả token suy luận). Output là phần đắt nhất hoá đơn (giá gấp ~200 lần một token input cache-hit). 0 = để nhà cung cấp tự quyết (không chặn); 4.000–8.000 đủ cho hầu hết lượt trả lời + gọi tool. Đặt quá thấp có thể làm cụt câu trả lời dài.
          </small>
        </label>

<label>
          <span>Tên & tính cách (custom instructions)</span>
          <textarea
            className="custom-instructions"
            rows={3}
            value={draft.customInstructions}
            onChange={(event) => setDraft({ ...draft, customInstructions: event.target.value })}
            placeholder={'Ví dụ: Tên bạn là "Tí". Trả lời ngắn gọn, hài hước, xưng "tui" gọi "sếp".'}
          />
          <small>Nhét thẳng vào system prompt mỗi lần chat — đặt tên, tính cách, giọng văn tuỳ ý.</small>
        </label>

        <div className="tool-toggle-block">
          <span className="usage-block-title">Chat từ điện thoại</span>
          <small>
            Mở 1 trang web nhẹ trên điện thoại (cùng WiFi với máy tính này) để nhắn tin với agent — dùng đúng phiên chat + Toàn quyền/tool đang cấu hình trên máy tính. Chỉ chạy khi app đang mở, tắt app là mất kết nối. Có token bảo vệ trong link, đừng chia sẻ link đó.
          </small>
          <div className="tool-group-header" style={{ marginTop: 8 }}>
            <button type="button" className="attach-button" style={{ width: 'auto', padding: '6px 12px' }} disabled={remoteBusy} onClick={() => void toggleRemote()}>
              {remoteStatus?.running ? 'Tắt' : 'Bật'}
            </button>
          </div>
          {remoteStatus?.running && remoteStatus.qr && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, marginTop: 8 }}>
              <img src={remoteStatus.qr} alt="QR quét bằng điện thoại" width={160} height={160} style={{ borderRadius: 8, background: '#fff', padding: 6 }} />
              <small>Mở Camera trên điện thoại, quét mã này (điện thoại phải cùng WiFi với máy tính).</small>
            </div>
          )}
          {remoteStatus?.running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {remoteStatus.candidates.length === 0 ? (
                <small>Không tìm thấy card mạng LAN/WiFi nào — cắm dây mạng hoặc bật WiFi rồi bấm Tắt/Bật lại.</small>
              ) : (
                <>
                  {remoteStatus.candidates.length > 1 && (
                    <small>Máy có nhiều card mạng — thử link đầu tiên trước, không vào được thì thử link kế tiếp.</small>
                  )}
                  {remoteStatus.candidates.map((candidate) => (
                    <div key={candidate.url} style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                      <span style={{ color: 'var(--muted)' }}>[{candidate.name}]</span> {candidate.url}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div className="tool-toggle-block">
          <span className="usage-block-title">Tool được bật ({draft.enabledTools.length})</span>
          <small>
            Mỗi tool bật thêm tốn dung lượng khai báo trên MỌI request, dùng hay không cũng vậy — chỉ bật cái đang cần cho việc đang làm. Toàn quyền chỉ mở khoá quyền chọn nhóm GUI/Session (bỏ giới hạn đường dẫn/lệnh), không tự bật tool nào cả.
          </small>
          {TOOL_GROUPS.map((group) => (
            <div className="tool-group" key={group.label}>
              <div className="tool-group-header">
                <strong>{group.label}</strong>
                {group.requiresFullControl && !draft.fullControl && <em>cần bật Toàn quyền trước</em>}
              </div>
              <div className="tool-group-items">
                {group.names.map((name) => (
                  <label key={name} className="tool-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.enabledTools.includes(name)}
                      disabled={group.requiresFullControl && !draft.fullControl}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...draft.enabledTools, name]
                          : draft.enabledTools.filter((existing) => existing !== name);
                        setDraft({ ...draft, enabledTools: next });
                      }}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="usage-block">
          <span className="usage-block-title">Token đã dùng (tổng từ trước tới giờ)</span>
          {lifetimeUsage ? (
            <div className="usage-numbers">
              <span>Vào: <strong>{lifetimeUsage.promptTokens.toLocaleString('vi-VN')}</strong></span>
              <span>Ra: <strong>{lifetimeUsage.completionTokens.toLocaleString('vi-VN')}</strong></span>
              {(() => {
                const cost = resolveCostUsd(draft.model, lifetimeUsage);
                return cost !== null ? <span>{cost.tracked ? 'Chi phí thật' : 'Ước tính'}: <strong>{cost.tracked ? '' : '~'}{formatUsd(cost.value)}</strong></span> : null;
              })()}
            </div>
          ) : (
            <span className="usage-numbers">Đang tải…</span>
          )}
          <PeakBadge />
          <small>Chi phí ghi nhận theo giá thật từng request (model + giờ cao điểm/thấp điểm tại thời điểm gọi). Riêng dữ liệu cũ trước khi bật tính giá thì hiện "ước tính" ở mức off-peak. Cache hit rẻ hơn cache miss ~50 lần, giờ cao điểm giá gấp đôi.</small>
        </div>

        <label className="toggle-row">
          <div>
            <span>Tự động duyệt các thao tác</span>
            <small>Bật lên thì ghi/sửa file và chạy lệnh shell sẽ chạy luôn, không hiện bảng xác nhận nữa.</small>
          </div>
          <input
            type="checkbox"
            checked={draft.autoApprove}
            onChange={(event) => setDraft({ ...draft, autoApprove: event.target.checked })}
          />
        </label>

        {draft.autoApprove && (
          <div className="warning-card"><ShieldAlert size={17} /> Bật tự động duyệt là bỏ luôn lớp xác nhận của bạn. Các lớp chặn lệnh shell chỉ là phòng ngừa, không phải sandbox hệ điều hành thật sự.</div>
        )}
        {localError && <div className="form-error">{localError}</div>}

        <div className="panel-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Huỷ</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu cài đặt'}</button>
        </div>
      </form>
    </div>
  );
}

function ApprovalPanel({ request, onApprove, onDeny }: { request: ApprovalRequest; onApprove: () => void; onDeny: () => void }) {
  const { preview } = request;
  return (
    <div className="overlay approval-overlay">
      <div className="approval-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow"><Wrench size={14} /> Cần bạn duyệt</span>
            <h2>{preview.title}</h2>
            <p>{preview.warning}</p>
          </div>
        </div>

        {preview.kind === 'file' ? (
          <div className="diff-section">
            <div className="diff-title"><FileCode2 size={16} /> {preview.path}</div>
            <div className="diff-grid">
              <div><span>Trước</span><pre>{preview.before || '(file mới)'}</pre></div>
              <div><span>Sau</span><pre>{preview.after || '(file rỗng)'}</pre></div>
            </div>
          </div>
        ) : (
          <div className="command-preview">
            <div><TerminalSquare size={16} /> <strong>thư mục:</strong> {preview.cwd}</div>
            <pre>{preview.command}</pre>
          </div>
        )}

        <details className="raw-args">
          <summary>Tham số tool</summary>
          <pre>{JSON.stringify(request.args, null, 2)}</pre>
        </details>

        <div className="panel-actions sticky-actions">
          <button type="button" className="secondary-button" onClick={onDeny}>Từ chối</button>
          <button type="button" className="approve-button" onClick={onApprove}>Duyệt & chạy</button>
        </div>
      </div>
    </div>
  );
}

function lastPathPart(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || value;
}

function compactJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return '';
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
