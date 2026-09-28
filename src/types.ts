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
  costUsd?: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  workingDirectory: string | null;
  messages: ChatMessage[];
  contextSummary: string | null;
  contextStartsAtMessageId: string | null;
  compactedAt: string | null;
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
  // COST LEVER: with this on, thinking is enabled for the first request of a turn (where the plan is
  // made) and switched off for the mechanical tool cycles that follow it.
  hybridThinking: boolean;
  contextWindowTokens: number;
  // Ceiling on how many tokens of history the app sends per request (older history gets
  // compacted into a summary instead of being resent on every agent cycle).
  maxInputTokens: number;
  // Hard ceiling on generated tokens per reply (output/reasoning = the priciest line). 0 = uncapped.
  maxOutputTokens: number;
  theme: ThemePreference;
  fullControl: boolean;
  customInstructions: string;
  // Which tool names are actually sent to the model. Independent from fullControl — turn on only
  // what the current task needs, since every offered tool costs schema tokens every request.
  enabledTools: string[];
  // Phone remote chat: LAN-only web+WebSocket server so a phone browser on the same WiFi can chat
  // with this same agent/session. OFF by default.
  remoteEnabled: boolean;
  remotePort: number;
  remoteToken: string;
  remoteSessionId: string | null;
}

export interface AttachedFile {
  name: string;
  content: string;
  truncated: boolean;
  // Set when this file came from "attach folder" so the composer can show every file from the
  // same folder pick as one compact chip instead of one chip per file.
  batchId?: string;
  batchLabel?: string;
}

export interface PublicSettings extends AppSettings {
  apiKeyConfigured: boolean;
}

export interface CompactResult {
  changed: boolean;
  beforeTokens: number;
  afterTokens: number;
  contextLimit: number;
  message: string;
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

export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  args: unknown;
  preview: ApprovalPreview;
}
