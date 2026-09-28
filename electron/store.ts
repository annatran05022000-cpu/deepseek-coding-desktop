import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { ALL_TOOL_NAMES, DEFAULT_ENABLED_TOOLS } from './tool-schema';
import type {
  AppDatabase,
  AppSettings,
  ChatMessage,
  PublicSession,
  PublicSettings,
  SessionRecord,
  ToolJournalEntry,
  ToolJournalStatus,
  UsageStats,
} from './types';

const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.3,
  autoApprove: false,
  // Reasoning tokens are billed as OUTPUT (peak $1.2/M, i.e. 200x a cache-hit input token),
  // and DeepSeek's own mapping table turns 'high' into the highest real effort tier. Measured on
  // this profile output was 58% of the whole bill, so the default is now the cheap tier; raise it
  // in Settings for a single hard task.
  reasoningEffort: 'low',
  // Hybrid thinking (see electron/deepseek.ts): plan once per turn, run the tool cycles after it
  // with thinking disabled. This is the single biggest lever on the bill.
  hybridThinking: true,
  contextWindowTokens: 1_000_000,
  maxInputTokens: 65_536,
  // Output/reasoning is the priciest billing line; cap generation per reply by default.
  // 0 disables the cap. 4096 tokens is a long answer plus a tool call; output is the
  maxOutputTokens: 4_096,
  theme: 'system',
  fullControl: false,
  customInstructions: '',
  enabledTools: DEFAULT_ENABLED_TOOLS,
  remoteEnabled: false,
  remotePort: 4756,
  remoteToken: '',
  remoteSessionId: null,
};

const EMPTY_USAGE: UsageStats = { promptTokens: 0, completionTokens: 0 };

const MAX_TOOL_JOURNAL_ENTRIES = 500;

export class LocalStore {
  private readonly dataFile: string;
  private readonly backupFile: string;
  private readonly apiKeyFile: string;
  private data: AppDatabase;

  constructor(userDataPath: string) {
    fs.mkdirSync(userDataPath, { recursive: true });
    this.dataFile = path.join(userDataPath, 'app-data.json');
    this.backupFile = path.join(userDataPath, 'app-data.backup.json');
    this.apiKeyFile = path.join(userDataPath, 'deepseek-api-key.bin');
    const loaded = this.load();
    this.data = loaded.data;
    this.applyCostMigrations(userDataPath);
    // Only refresh the snapshot when the live database was actually readable — snapshotting a
    // corrupt or missing file would overwrite the very copy we need to recover from.
    if (loaded.healthy) this.snapshotBeforeLaunch(userDataPath);
  }

  // Chat history is the only thing in this app that cannot be regenerated, and the app gets
  // relaunched by its own build/restart flow (and can be force-killed mid-run), so a copy of the
  // last known-good database is taken before every launch. It costs ~0.5 MB and turns a future
  // "the history is empty" incident into something recoverable instead of permanent.
  // One-time cost migration for profiles created by older builds. It never fights a later manual
  // choice: the marker file makes sure it runs at most once per profile.
  private applyCostMigrations(userDataPath: string): void {
    const marker = path.join(userDataPath, 'migration-low-effort-v1.done');
    if (fs.existsSync(marker)) return;
    try {
      if (this.data.settings.reasoningEffort === 'high') {
        this.data.settings = { ...this.data.settings, reasoningEffort: 'low' };
        this.writeAtomic();
      }
    } catch {
      // A migration must never stop the app from starting.
    }
    try {
      fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    } catch {
      // Best effort.
    }
  }

  private snapshotBeforeLaunch(userDataPath: string): void {
    try {
      if (!fs.existsSync(this.dataFile) || fs.statSync(this.dataFile).size < 4) return;
      fs.copyFileSync(this.dataFile, this.backupFile);
      const day = new Date().toISOString().slice(0, 10);
      const dated = path.join(userDataPath, `app-data.${day}.backup.json`);
      if (!fs.existsSync(dated)) fs.copyFileSync(this.dataFile, dated);
      const datedFiles = fs
        .readdirSync(userDataPath)
        .filter((name) => /^app-data\.\d{4}-\d{2}-\d{2}\.backup\.json$/.test(name))
        .sort();
      for (const stale of datedFiles.slice(0, Math.max(0, datedFiles.length - 7))) {
        try {
          fs.unlinkSync(path.join(userDataPath, stale));
        } catch {
          // Rotation is best-effort.
        }
      }
    } catch {
      // A backup failure must never stop the app from starting.
    }
  }

  private readDatabase(file: string): AppDatabase | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppDatabase>;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => this.normalizeSession(session as Partial<SessionRecord>))
        : [];
      return {
        settings: this.normalizeSettings(parsed.settings),
        sessions,
        lifetimeUsage: this.normalizeUsage(parsed.lifetimeUsage),
        lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : null,
      };
    } catch {
      return null;
    }
  }

  private load(): { data: AppDatabase; healthy: boolean } {
    if (!fs.existsSync(this.dataFile)) {
      // Missing database: if the pre-launch snapshot holds history, restore it instead of
      // starting empty (this is what a wiped profile or a failed atomic rename looks like).
      const restored = this.readDatabase(this.backupFile);
      if (restored && restored.sessions.length > 0) {
        this.writeAtomic(restored);
        return { data: restored, healthy: false };
      }
      const fresh: AppDatabase = { settings: DEFAULT_SETTINGS, sessions: [], lifetimeUsage: { ...EMPTY_USAGE }, lastSessionId: null };
      this.writeAtomic(fresh);
      return { data: fresh, healthy: false };
    }

    const parsed = this.readDatabase(this.dataFile);
    if (parsed) return { data: parsed, healthy: true };

    const corruptCopy = `${this.dataFile}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(this.dataFile, corruptCopy);
    } catch {
      // Best-effort backup only.
    }
    const recovered = this.readDatabase(this.backupFile);
    if (recovered && recovered.sessions.length > 0) {
      this.writeAtomic(recovered);
      return { data: recovered, healthy: false };
    }
    // Last resort: the .bak written just before the previous rename.
    const bak = this.readDatabase(`${this.dataFile}.bak`);
    if (bak && bak.sessions.length > 0) {
      this.writeAtomic(bak);
      return { data: bak, healthy: false };
    }
    const fresh: AppDatabase = { settings: DEFAULT_SETTINGS, sessions: [], lifetimeUsage: { ...EMPTY_USAGE }, lastSessionId: null };
    this.writeAtomic(fresh);
    return { data: fresh, healthy: false };
  }

  private normalizeUsage(value?: Partial<UsageStats>): UsageStats {
    return {
      promptTokens: typeof value?.promptTokens === 'number' && Number.isFinite(value.promptTokens) ? Math.max(0, value.promptTokens) : 0,
      completionTokens: typeof value?.completionTokens === 'number' && Number.isFinite(value.completionTokens) ? Math.max(0, value.completionTokens) : 0,
      promptCacheHitTokens: typeof value?.promptCacheHitTokens === 'number' && Number.isFinite(value.promptCacheHitTokens) ? Math.max(0, value.promptCacheHitTokens) : 0,
      promptCacheMissTokens: typeof value?.promptCacheMissTokens === 'number' && Number.isFinite(value.promptCacheMissTokens) ? Math.max(0, value.promptCacheMissTokens) : 0,
      // Only present when the app actually tracked cost; left undefined for legacy sessions so
      // the UI can tell "no data" apart from "genuinely $0".
      ...(typeof value?.costUsd === 'number' && Number.isFinite(value.costUsd) ? { costUsd: Math.max(0, value.costUsd) } : {}),
    };
  }

  private normalizeSettings(value?: Partial<AppSettings>): AppSettings {
    const merged = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
    return {
      ...merged,
      baseUrl: typeof merged.baseUrl === 'string' && merged.baseUrl.trim()
        ? merged.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULT_SETTINGS.baseUrl,
      model: typeof merged.model === 'string' && merged.model.trim()
        ? merged.model.trim()
        : DEFAULT_SETTINGS.model,
      temperature: typeof merged.temperature === 'number'
        ? Math.min(2, Math.max(0, merged.temperature))
        : DEFAULT_SETTINGS.temperature,
      autoApprove: Boolean(merged.autoApprove),
      // Defaults to ON: the only way to turn it off is an explicit false in the settings file.
      hybridThinking: merged.hybridThinking !== false,
      reasoningEffort: ['none', 'low', 'high', 'max'].includes(merged.reasoningEffort)
        ? merged.reasoningEffort
        : DEFAULT_SETTINGS.reasoningEffort,
      contextWindowTokens:
        typeof merged.contextWindowTokens === 'number' && Number.isFinite(merged.contextWindowTokens)
          ? Math.min(2_000_000, Math.max(16_000, Math.round(merged.contextWindowTokens)))
          : DEFAULT_SETTINGS.contextWindowTokens,
      maxInputTokens: (() => {
        const value = merged.maxInputTokens;
        // One-time migration off the old 150k-token-per-request default: every cycle of a long
        // run resent that budget, which is what made input cost explode. 64k + earlier
        // compaction (72%) keeps runs cheaper; raise it again in Settings if you want it back.
        if (value === 150_000) return 65_536;
        // Hard ceiling on the per-request input budget: every agent cycle re-sends this much, so a
        // large value multiplies straight into the bill on a paid API. Raised to 256k to match
        // self-hosted local models with large native context windows (e.g. Qwen3.8's 262144-token
        // window) — a self-hosted model has no per-token billing, so the old 128k paid-API ceiling
        // no longer applies universally. Still capped so a runaway value can't send unbounded input.
        return typeof value === 'number' && Number.isFinite(value)
          ? Math.min(262_144, Math.max(16_000, Math.round(value)))
          : DEFAULT_SETTINGS.maxInputTokens;
      })(),
      maxOutputTokens: (() => {
        const value = merged.maxOutputTokens;
        if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.maxOutputTokens;
        // HARD CAP. This used to accept 0 as "no cap", which meant an unbounded generation could
        // be billed in full - the single most expensive thing the app can do. Output is now always
        // bounded: 0/negative falls back to the default instead of disabling the ceiling.
        if (value <= 0) return DEFAULT_SETTINGS.maxOutputTokens;
        return Math.min(16_384, Math.max(256, Math.round(value)));
      })(),
      theme: (['system', 'light', 'dark'] as const).includes(merged.theme as never)
        ? merged.theme
        : DEFAULT_SETTINGS.theme,
      fullControl: Boolean(merged.fullControl),
      customInstructions: typeof merged.customInstructions === 'string' ? merged.customInstructions.slice(0, 4000) : '',
      enabledTools: Array.isArray(merged.enabledTools)
        ? [...new Set(merged.enabledTools.filter((name): name is string => typeof name === 'string' && ALL_TOOL_NAMES.includes(name)))]
        : DEFAULT_SETTINGS.enabledTools,
      remoteEnabled: Boolean(merged.remoteEnabled),
      remotePort: typeof merged.remotePort === 'number' && Number.isFinite(merged.remotePort)
        ? Math.min(65_535, Math.max(1_024, Math.round(merged.remotePort)))
        : DEFAULT_SETTINGS.remotePort,
      remoteToken: typeof merged.remoteToken === 'string' ? merged.remoteToken : DEFAULT_SETTINGS.remoteToken,
      remoteSessionId: typeof merged.remoteSessionId === 'string' ? merged.remoteSessionId : null,
    };
  }

  private normalizeSession(value: Partial<SessionRecord>): SessionRecord {
    const now = new Date().toISOString();
    return {
      id: typeof value.id === 'string' && value.id ? value.id : randomUUID(),
      title: typeof value.title === 'string' && value.title ? value.title : 'Cuộc trò chuyện mới',
      workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : null,
      messages: Array.isArray(value.messages) ? value.messages : [],
      usage: this.normalizeUsage(value.usage),
      contextSummary: typeof value.contextSummary === 'string' ? value.contextSummary : null,
      contextStartsAtMessageId:
        typeof value.contextStartsAtMessageId === 'string' ? value.contextStartsAtMessageId : null,
      compactedAt: typeof value.compactedAt === 'string' ? value.compactedAt : null,
      toolJournal: Array.isArray(value.toolJournal) ? value.toolJournal.slice(-MAX_TOOL_JOURNAL_ENTRIES) : [],
      pinned: Boolean(value.pinned),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    };
  }

  // Durability matters more than speed here: the app is force-killed by its own update task
  // (taskkill) and by the user closing the window mid-run. A plain writeFileSync only reaches the
  // OS page cache, so a kill within a few seconds of a write could lose the newest message - which
  // is exactly the "the last message disappeared after relaunch" report. fsync + atomic rename
  // makes every committed write survive an immediate process kill.
  private writeAtomic(data: AppDatabase = this.data): void {
    const temp = `${this.dataFile}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    let fd: number | null = null;
    try {
      fd = fs.openSync(temp, 'w');
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed.
        }
      }
    }
    // Keep the previous good copy as .bak so a torn rename still leaves a recoverable file.
    try {
      if (fs.existsSync(this.dataFile)) fs.copyFileSync(this.dataFile, `${this.dataFile}.bak`);
    } catch {
      // Best effort only.
    }
    fs.renameSync(temp, this.dataFile);
    // fsync the directory so the rename itself is durable on NTFS.
    try {
      const dirFd = fs.openSync(path.dirname(this.dataFile), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not supported everywhere; the file fsync above is the important part.
    }
  }

  /** Force any pending state to disk. Called on quit so a graceful close never loses a message. */
  flush(): void {
    try {
      this.writeAtomic();
    } catch {
      // Never block shutdown on a write failure.
    }
  }

  getSettings(): PublicSettings {
    return {
      ...this.data.settings,
      apiKeyConfigured: fs.existsSync(this.apiKeyFile),
    };
  }

  updateSettings(patch: Partial<AppSettings>): PublicSettings {
    this.data.settings = this.normalizeSettings({ ...this.data.settings, ...patch });
    this.writeAtomic();
    return this.getSettings();
  }

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('API key không được để trống.');
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Electron safeStorage encryption is unavailable on this machine. The key was not saved.',
      );
    }
    const encrypted = safeStorage.encryptString(trimmed);
    fs.writeFileSync(this.apiKeyFile, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  }

  clearApiKey(): void {
    if (fs.existsSync(this.apiKeyFile)) fs.unlinkSync(this.apiKeyFile);
  }

  getApiKey(): string {
    if (!fs.existsSync(this.apiKeyFile)) {
      throw new Error('Chưa cấu hình API key DeepSeek. Vào Cài đặt để nhập key trước.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Không dùng được mã hoá safeStorage của Electron nên không đọc được API key đã lưu.');
    }
    const base64 = fs.readFileSync(this.apiKeyFile, 'utf8');
    return safeStorage.decryptString(Buffer.from(base64, 'base64'));
  }

  listSessions(): PublicSession[] {
    return [...this.data.sessions]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .map(({ messages, toolJournal: _toolJournal, contextSummary: _summary, contextStartsAtMessageId: _start, ...session }) => ({
        ...session,
        messageCount: messages.length,
      }));
  }

  createSession(): SessionRecord {
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID(),
      title: 'Cuộc trò chuyện mới',
      workingDirectory: null,
      messages: [],
      contextSummary: null,
      contextStartsAtMessageId: null,
      compactedAt: null,
      toolJournal: [],
      pinned: false,
      usage: { ...EMPTY_USAGE },
      createdAt: now,
      updatedAt: now,
    };
    this.data.sessions.unshift(session);
    this.writeAtomic();
    return structuredClone(session);
  }

  getSession(id: string): SessionRecord {
    return structuredClone(this.mustFindSession(id));
  }

  deleteSession(id: string): void {
    this.data.sessions = this.data.sessions.filter((item) => item.id !== id);
    if (this.data.lastSessionId === id) this.data.lastSessionId = null;
    this.writeAtomic();
  }

  getLastSessionId(): string | null {
    if (!this.data.lastSessionId) return null;
    return this.data.sessions.some((item) => item.id === this.data.lastSessionId)
      ? this.data.lastSessionId
      : null;
  }

  setLastSessionId(id: string | null): void {
    const next = id && this.data.sessions.some((item) => item.id === id) ? id : null;
    if (this.data.lastSessionId === next) return;
    this.data.lastSessionId = next;
    this.writeAtomic();
  }

  setWorkingDirectory(id: string, directory: string): SessionRecord {
    const session = this.mustFindSession(id);
    session.workingDirectory = directory;
    session.updatedAt = new Date().toISOString();
    this.writeAtomic();
    return structuredClone(session);
  }

  setPinned(id: string, pinned: boolean): PublicSession[] {
    const session = this.mustFindSession(id);
    session.pinned = pinned;
    this.writeAtomic();
    return this.listSessions();
  }

  renameSession(id: string, title: string): PublicSession[] {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Tên cuộc trò chuyện không được để trống.');
    const session = this.mustFindSession(id);
    session.title = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    this.writeAtomic();
    return this.listSessions();
  }

  addMessage(id: string, role: ChatMessage['role'], content: string, images?: string[]): ChatMessage {
    const session = this.mustFindSession(id);
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      ...(images && images.length > 0 ? { images } : {}),
      createdAt: new Date().toISOString(),
    };
    session.messages.push(message);
    session.updatedAt = message.createdAt;

    if (role === 'user' && session.title === 'Cuộc trò chuyện mới') {
      const compact = content.replace(/\s+/g, ' ').trim();
      session.title = compact.length > 44 ? `${compact.slice(0, 44)}…` : compact || (images?.length ? 'Ảnh đính kèm' : 'Cuộc trò chuyện mới');
    }

    this.writeAtomic();
    return structuredClone(message);
  }

  // Persist the assistant answer while it is still streaming. Without this, a close/relaunch
  // during a run dropped the last answer entirely: the text only reached the store when the
  // whole turn finished. The message id is stable so later updates overwrite the same row
  // instead of appending duplicates.
  upsertStreamingAssistant(id: string, messageId: string, content: string): ChatMessage | null {
    const session = this.mustFindSession(id);
    const text = content ?? '';
    if (!text.trim()) return null;
    const existing = session.messages.find((message) => message.id === messageId);
    if (existing) {
      if (existing.content === text) return structuredClone(existing);
      existing.content = text;
      existing.createdAt = new Date().toISOString();
      session.updatedAt = existing.createdAt;
      this.writeAtomic();
      return structuredClone(existing);
    }
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: text,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    this.writeAtomic();
    return structuredClone(message);
  }

  setContextSummary(
    id: string,
    summary: string,
    contextStartsAtMessageId: string | null,
  ): SessionRecord {
    const session = this.mustFindSession(id);
    session.contextSummary = summary.trim() || null;
    session.contextStartsAtMessageId = contextStartsAtMessageId;
    session.compactedAt = new Date().toISOString();
    session.updatedAt = session.compactedAt;
    this.writeAtomic();
    return structuredClone(session);
  }

  addToolJournalEntry(
    id: string,
    entry: Omit<ToolJournalEntry, 'id' | 'createdAt'> & { status: ToolJournalStatus },
  ): ToolJournalEntry {
    const session = this.mustFindSession(id);
    const record: ToolJournalEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
    };
    session.toolJournal.push(record);
    if (session.toolJournal.length > MAX_TOOL_JOURNAL_ENTRIES) {
      session.toolJournal.splice(0, session.toolJournal.length - MAX_TOOL_JOURNAL_ENTRIES);
    }
    session.updatedAt = record.createdAt;
    this.writeAtomic();
    return structuredClone(record);
  }

  addUsage(
    id: string,
    promptTokens: number,
    completionTokens: number,
    promptCacheHitTokens = 0,
    promptCacheMissTokens = 0,
    costUsd = 0,
  ): void {
    if (promptTokens <= 0 && completionTokens <= 0) return;
    const session = this.mustFindSession(id);
    const hit = Math.max(0, promptCacheHitTokens);
    const miss = Math.max(0, promptCacheMissTokens);
    const cost = Math.max(0, costUsd);
    session.usage.promptTokens += Math.max(0, promptTokens);
    session.usage.completionTokens += Math.max(0, completionTokens);
    session.usage.promptCacheHitTokens = (session.usage.promptCacheHitTokens ?? 0) + hit;
    session.usage.promptCacheMissTokens = (session.usage.promptCacheMissTokens ?? 0) + miss;
    session.usage.costUsd = (session.usage.costUsd ?? 0) + cost;
    this.data.lifetimeUsage.promptTokens += Math.max(0, promptTokens);
    this.data.lifetimeUsage.completionTokens += Math.max(0, completionTokens);
    this.data.lifetimeUsage.promptCacheHitTokens = (this.data.lifetimeUsage.promptCacheHitTokens ?? 0) + hit;
    this.data.lifetimeUsage.promptCacheMissTokens = (this.data.lifetimeUsage.promptCacheMissTokens ?? 0) + miss;
    this.data.lifetimeUsage.costUsd = (this.data.lifetimeUsage.costUsd ?? 0) + cost;
    this.writeAtomic();
  }

  getLifetimeUsage(): UsageStats {
    return { ...this.data.lifetimeUsage };
  }

  private mustFindSession(id: string): SessionRecord {
    const session = this.data.sessions.find((item) => item.id === id);
    if (!session) throw new Error('Không tìm thấy phiên chat này.');
    return session;
  }
}
