export type ChatRole = 'user' | 'assistant';
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  images?: string[];
  createdAt: string;
}

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  // Real accumulated cost in USD, computed per API response at the exact model + peak/off-peak
  // rate that applied when the request was sent. Absent on sessions created before this was
  // tracked, in which case the UI falls back to a conservative estimate.
  costUsd?: number;
}

export type ToolJournalStatus = 'success' | 'error' | 'denied' | 'invalid';

export interface ToolJournalEntry {
  id: string;
  toolName: string;
  status: ToolJournalStatus;
  summary: string;
  target?: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  workingDirectory: string | null;
  messages: ChatMessage[];
  contextSummary: string | null;
  contextStartsAtMessageId: string | null;
  compactedAt: string | null;
  toolJournal: ToolJournalEntry[];
  pinned: boolean;
  usage: UsageStats;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSession {
  id: string;
  title: string;
  workingDirectory: string | null;
  compactedAt: string | null;
  pinned: boolean;
  usage: UsageStats;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface AppSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  autoApprove: boolean;
  reasoningEffort: ReasoningEffort;
  // COST LEVER: DeepSeek bills reasoning tokens as output, and on tool runs the chain of thought of
  // every previous turn is replayed into the context on top of that. With this on, thinking is
  // enabled for the first request of a turn (where the plan is made) and switched off for the
  // mechanical tool cycles that follow it.
  hybridThinking: boolean;
  contextWindowTokens: number;
  // Self-imposed ceiling on how many tokens of history the app is willing to send per API
  // request. This is the real cost lever: every agent cycle resends the whole context, so a
  // 900k-token context costs ~50x more per cycle than a 20k-token one when the prefix is not
  // cached. Older history is compacted into a summary (and hard-trimmed as a fallback) instead
  // of being resent forever. Never allowed to exceed contextWindowTokens.
  maxInputTokens: number;
  // Ceiling on tokens the model may GENERATE per reply (the "output" side of the bill).
  // Output/reasoning is the priciest line (peak ~$1.2/M). 0 = provider default (uncapped).
  maxOutputTokens: number;
  theme: ThemePreference;
  // Full Control only removes path/shell restrictions and unlocks the GUI-automation/session
  // tools for selection — it no longer implies "every tool is sent." Which tools are actually
  // offered to the model each request is enabledTools, independent of this.
  fullControl: boolean;
  customInstructions: string;
  // Tool names actually sent to the model this request. Every added tool costs schema tokens on
  // every request whether used or not (see tool-schema.ts), so this defaults to a lean core set —
  // turn on the rest only for the task that needs them.
  enabledTools: string[];
  // Phone remote chat (electron/remoteServer.ts). LAN-only web+WebSocket server so a phone browser
  // on the same WiFi can chat with the same agent/session this desktop app is using. OFF by
  // default since it opens a network port with Full Control-level access if that's also on.
  remoteEnabled: boolean;
  remotePort: number;
  // Random token required to load the page or open the WS connection — the only thing standing
  // between "phone on the same WiFi" and anyone else on that WiFi. Regenerated on request.
  remoteToken: string;
  // Which chat session the phone page talks to, remembered across toggles/restarts.
  remoteSessionId: string | null;
}

export interface PublicSettings extends AppSettings {
  apiKeyConfigured: boolean;
}

export interface AppDatabase {
  settings: AppSettings;
  sessions: SessionRecord[];
  lifetimeUsage: UsageStats;
  // Last chat the user had open, so relaunching the app (or clicking the tray/taskbar icon)
  // returns to the same conversation instead of an empty window.
  lastSessionId: string | null;
}

export interface CompactResult {
  changed: boolean;
  beforeTokens: number;
  afterTokens: number;
  contextLimit: number;
  message: string;
}

export interface AgentEvent {
  runId: string;
  type:
    | 'assistant-delta'
    | 'tool-start'
    | 'tool-result'
    | 'approval-request'
    | 'context-warning'
    | 'context-compacted'
    | 'context-trimmed'
    | 'retry'
    | 'stopped'
    | 'error'
    | 'done'
    | 'open-preview'
    | 'assistant-committed'
    | 'user-injected';
  delta?: string;
  toolName?: string;
  args?: unknown;
  summary?: string;
  approvalId?: string;
  preview?: ApprovalPreview;
  message?: string;
  messageId?: string;
  finalContent?: string;
  beforeTokens?: number;
  afterTokens?: number;
  contextLimit?: number;
  budgetLimit?: number;
  image?: string;
  previewKind?: 'file' | 'web';
  previewName?: string;
  previewContent?: string;
  previewUrl?: string;
}

export interface ApprovalPreview {
  kind: 'file' | 'command';
  title: string;
  path?: string;
  before?: string;
  after?: string;
  patch?: string;
  command?: string;
  cwd?: string;
  warning?: string;
}
