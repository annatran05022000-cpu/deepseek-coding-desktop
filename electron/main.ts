import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from './store';
import { closeAllSessions } from './tools';
import { isRemoteRunning, remoteQrCode, remoteUrl, remoteUrlCandidates, startRemoteServer, stopRemoteServer } from './remoteServer';
import {
  clearAgentRun,
  compactStoredSession,
  hasActiveAgentRun,
  injectAgentMessage,
  runAgent,
  stopAgentRun,
} from './deepseek';
import type { ApprovalPreview } from './types';

let mainWindow: BrowserWindow | null = null;
let store: LocalStore;
let rendererReloads = 0;

const approvalWaiters = new Map<
  string,
  { runId: string; resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>();
const activeSessionRuns = new Map<string, string>();

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#111315',
    title: 'DeepSeek Coding Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true breaks Windows IME composition (Vietnamese/CJK typing) in this
      // Electron version. contextIsolation + nodeIntegration:false is the real boundary
      // here; the renderer still has no direct filesystem/shell access either way.
      sandbox: false,
      webSecurity: true,
      // Powers the web-preview side panel (a docked mini browser for the user/agent to
      // preview a URL). <webview> content runs isolated from the app's own renderer context.
      webviewTag: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    appendCrashLog('did-fail-load', `${errorCode} ${errorDescription} ${validatedUrl}`);
  });
  // The renderer dying is what produced the "blank white window" the user saw. Log it and
  // reload at most twice instead of leaving an empty frame on screen.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendCrashLog('render-process-gone', `${details.reason} exitCode=${details.exitCode}`);
    if (rendererReloads < 2 && mainWindow && !mainWindow.isDestroyed()) {
      rendererReloads += 1;
      mainWindow.reload();
    }
  });
  mainWindow.on('unresponsive', () => appendCrashLog('window-unresponsive', 'main window stopped responding'));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// Best-effort crash trail in %APPDATA%\deepseek-coding-desktop\crash.log. Without this, a main
// process exception kills the app silently and leaves no evidence behind.
function appendCrashLog(label: string, detail: unknown): void {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const text = detail instanceof Error
      ? `${detail.message}\n${detail.stack ?? ''}`
      : String(detail);
    fs.appendFileSync(
      path.join(dir, 'crash.log'),
      `\n[${new Date().toISOString()}] ${label}\n${text}\n`,
      'utf8',
    );
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (_event, patch) => store.updateSettings(patch));
  ipcMain.handle('settings:setApiKey', (_event, apiKey: string) => {
    store.setApiKey(apiKey);
    return store.getSettings();
  });
  ipcMain.handle('settings:clearApiKey', () => {
    store.clearApiKey();
    return store.getSettings();
  });

  ipcMain.handle('remote:start', async () => {
    const { url } = startRemoteServer(store);
    store.updateSettings({ remoteEnabled: true });
    return { running: true, url, candidates: remoteUrlCandidates(store), qr: await remoteQrCode(url) };
  });
  ipcMain.handle('remote:stop', () => {
    stopRemoteServer();
    store.updateSettings({ remoteEnabled: false });
    return { running: false, url: null, candidates: [], qr: null };
  });
  ipcMain.handle('remote:status', async () => {
    const running = isRemoteRunning();
    const url = running ? remoteUrl(store) : null;
    return {
      running,
      url,
      candidates: running ? remoteUrlCandidates(store) : [],
      qr: url ? await remoteQrCode(url) : null,
    };
  });

  ipcMain.handle('sessions:list', () => store.listSessions());
  ipcMain.handle('sessions:getLast', () => store.getLastSessionId());
  ipcMain.handle('sessions:setLast', (_event, sessionId: string | null) => {
    store.setLastSessionId(typeof sessionId === 'string' ? sessionId : null);
    return true;
  });
  ipcMain.handle('sessions:create', () => store.createSession());
  ipcMain.handle('sessions:get', (_event, sessionId: string) => store.getSession(sessionId));
  ipcMain.handle('sessions:delete', (_event, sessionId: string) => {
    if (activeSessionRuns.has(sessionId)) throw new Error('Không thể xoá khi agent của phiên này đang chạy.');
    store.deleteSession(sessionId);
  });
  ipcMain.handle('usage:lifetime', () => store.getLifetimeUsage());
  ipcMain.handle('sessions:setPinned', (_event, sessionId: string, pinned: boolean) => store.setPinned(sessionId, pinned));
  ipcMain.handle('sessions:rename', (_event, sessionId: string, title: string) => store.renameSession(sessionId, title));

  ipcMain.handle('sessions:chooseDirectory', async (_event, sessionId: string) => {
    if (activeSessionRuns.has(sessionId)) {
      throw new Error('Không thể đổi thư mục làm việc khi agent đang chạy.');
    }
    const options: OpenDialogOptions = {
      title: 'Chọn thư mục làm việc cho dự án',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    const stat = fs.statSync(selected);
    if (!stat.isDirectory()) throw new Error('Đường dẫn đã chọn không phải là thư mục.');
    return store.setWorkingDirectory(sessionId, selected);
  });

  ipcMain.handle('agent:start', async (event, sessionId: string, userText: string, clientRunId: string, images?: string[]) => {
    const text = userText.trim();
    const validImages = Array.isArray(images)
      ? images.filter((value) => typeof value === 'string' && value.startsWith('data:image/')).slice(0, 4)
      : [];
    if (!text && validImages.length === 0) throw new Error('Tin nhắn không được để trống.');
    if (activeSessionRuns.has(sessionId)) throw new Error('Phiên này đang có agent chạy rồi.');

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRunId)) {
      throw new Error('Mã phiên chạy agent không hợp lệ.');
    }

    const userMessage = store.addMessage(sessionId, 'user', text, validImages);
    const runId = clientRunId;
    activeSessionRuns.set(sessionId, runId);

    setImmediate(() => {
      void runAgent({
        runId,
        sessionId,
        store,
        webContents: event.sender,
        requestApproval,
        execInWebview,
      })
        .catch((error) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('agent:event', {
              runId,
              type: 'error',
              message: (error as Error).message,
            });
          }
        })
        .finally(() => {
          activeSessionRuns.delete(sessionId);
          clearAgentRun(runId);
          denyApprovalsForRun(runId);
        });
    });

    return { runId, userMessage };
  });

  ipcMain.handle('agent:stop', (_event, runId: string) => {
    // Abort the in-flight API request AND release any approval dialog the run is waiting on,
    // otherwise a stopped run could sit blocked on requestApproval for up to 15 minutes.
    denyApprovalsForRun(runId);
    return stopAgentRun(runId);
  });

  ipcMain.handle('agent:inject', (_event, sessionId: string, runId: string, userText: string) => {
    // Steering, not queueing: the message goes into the LIVE run, which interrupts the answer it
    // is currently streaming (soft abort), answers this instead, then continues the original task.
    const text = String(userText ?? '').trim();
    if (!text) throw new Error('Tin nhắn không được để trống.');
    const activeRun = activeSessionRuns.get(sessionId);
    if (!activeRun) throw new Error('Không có agent nào đang chạy trong phiên này.');
    if (activeRun !== runId) throw new Error('Phiên chạy agent đã thay đổi, hãy thử lại.');
    if (!hasActiveAgentRun(runId)) throw new Error('Phiên chạy agent đã kết thúc.');
    if (!injectAgentMessage(runId, text)) throw new Error('Không thể gửi tin nhắn vào phiên đang chạy.');
    // Stored as a real user message only when the run actually consumes it (inside runAgent), so a
    // message that never gets answered is not silently duplicated or lost in the transcript.
    return { queued: true };
  });

  ipcMain.handle('agent:compact', async (_event, sessionId: string) => {
    if (activeSessionRuns.has(sessionId)) {
      throw new Error('Không thể nén ngữ cảnh khi agent đang chạy.');
    }
    return compactStoredSession({ sessionId, store, force: true });
  });

  ipcMain.handle('approval:resolve', (_event, approvalId: string, approved: boolean) => {
    const waiter = approvalWaiters.get(approvalId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    approvalWaiters.delete(approvalId);
    waiter.resolve(Boolean(approved));
    return true;
  });

  ipcMain.on('webview:result', (_event, requestId: string, result: unknown, error: string | null) => {
    const pending = pendingWebviewRuns.get(requestId);
    if (!pending) return;
    pendingWebviewRuns.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve(result);
  });

  ipcMain.handle('system:openExternal', async (_event, url: string) => {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Chỉ cho phép mở link http/https.');
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle('files:attach', async () => {
    const options: OpenDialogOptions = {
      title: 'Đính kèm file vào chat',
      properties: ['openFile', 'multiSelections'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];

    const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
    const attachments: { name: string; content: string; truncated: boolean }[] = [];
    for (const filePath of result.filePaths.slice(0, 50)) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const fd = fs.openSync(filePath, 'r');
        try {
          const bytesToRead = Math.min(stat.size, MAX_ATTACH_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buffer, 0, bytesToRead, 0);
          attachments.push({
            name: path.basename(filePath),
            content: buffer.toString('utf8'),
            truncated: stat.size > MAX_ATTACH_BYTES,
          });
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        attachments.push({ name: path.basename(filePath), content: '', truncated: false });
      }
    }
    return attachments;
  });

  ipcMain.handle('files:readForPreview', async () => {
    const options: OpenDialogOptions = {
      title: 'Chọn file để xem',
      properties: ['openFile'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('Đường dẫn đã chọn không phải là file.');
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesToRead = Math.min(stat.size, MAX_PREVIEW_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, 0);
      return {
        name: path.basename(filePath),
        content: buffer.toString('utf8'),
        truncated: stat.size > MAX_PREVIEW_BYTES,
      };
    } finally {
      fs.closeSync(fd);
    }
  });

  ipcMain.handle('files:attachFolder', async () => {
    const options: OpenDialogOptions = {
      title: 'Đính kèm thư mục vào chat',
      properties: ['openDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { rootName: '', files: [] };

    const root = result.filePaths[0];
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const MAX_FILES = 200;
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
    const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', '.next', 'build', 'coverage', '.venv', '__pycache__']);
    const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.mp4', '.mp3', '.wav', '.zip', '.rar', '.7z', '.exe', '.dll', '.pdf', '.woff', '.woff2', '.ttf', '.bin', '.node']);

    const attachments: { name: string; content: string; truncated: boolean }[] = [];
    let totalBytes = 0;

    async function walk(dir: string): Promise<void> {
      if (attachments.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (attachments.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(path.join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(filePath);
          const bytesToRead = Math.min(stat.size, MAX_FILE_BYTES, Math.max(0, MAX_TOTAL_BYTES - totalBytes));
          if (bytesToRead <= 0) continue;
          const fd = fs.openSync(filePath, 'r');
          try {
            const buffer = Buffer.alloc(bytesToRead);
            fs.readSync(fd, buffer, 0, bytesToRead, 0);
            attachments.push({
              name: path.relative(root, filePath) || entry.name,
              content: buffer.toString('utf8'),
              truncated: stat.size > bytesToRead,
            });
            totalBytes += bytesToRead;
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          // Skip unreadable entries.
        }
      }
    }

    await walk(root);
    return { rootName: path.basename(root) || root, files: attachments };
  });
}

const pendingWebviewRuns = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const WEBVIEW_RUN_TIMEOUT_MS = 15_000;

// Runs JS inside the renderer's docked <webview> preview panel (electron/deepseek.ts webview_fill
// tool) — DOM-precise form filling instead of blind computer_click coordinate guessing, which
// breaks the moment a cookie banner shifts the page. The <webview> element only exists in the
// renderer, so this is a request/response round trip over IPC rather than a direct call.
function execInWebview(script: string): Promise<unknown> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.reject(new Error('Không có cửa sổ app nào đang mở.'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingWebviewRuns.delete(requestId);
      reject(new Error('webview_fill timed out after 15s — is the web preview panel open and loaded?'));
    }, WEBVIEW_RUN_TIMEOUT_MS);
    pendingWebviewRuns.set(requestId, { resolve, reject, timer });
    mainWindow?.webContents.send('webview:run', requestId, script);
  });
}

function requestApproval(
  runId: string,
  toolName: string,
  args: unknown,
  preview: ApprovalPreview,
): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const approvalId = randomUUID();

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      approvalWaiters.delete(approvalId);
      resolve(false);
    }, 15 * 60_000);

    approvalWaiters.set(approvalId, { runId, resolve, timer });
    mainWindow?.webContents.send('agent:event', {
      runId,
      type: 'approval-request',
      toolName,
      args,
      approvalId,
      preview,
    });
  });
}

function denyApprovalsForRun(runId: string): void {
  for (const [approvalId, waiter] of approvalWaiters.entries()) {
    if (waiter.runId !== runId) continue;
    clearTimeout(waiter.timer);
    approvalWaiters.delete(approvalId);
    waiter.resolve(false);
  }
}

// Only one copy of the app may run at a time. Without this lock, clicking the taskbar/shortcut
// icon while the app was already open launched a SECOND process: the two instances then fought
// over the same session file (history appearing to disappear) and the second window rendered
// blank, because Chromium cannot share one userData profile between two live processes.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // User clicked the icon while the app was already running: surface the existing window
    // instead of starting a second, empty copy.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });

  process.on('uncaughtException', (error) => appendCrashLog('uncaughtException', error));
  process.on('unhandledRejection', (reason) => appendCrashLog('unhandledRejection', reason));

  app.whenReady().then(() => {
    // Windows needs an explicit AppUserModelID matching the builder appId, otherwise the shell
    // treats a relaunch as a different application and spawns a new process instead of
    // focusing the running window.
    app.setAppUserModelId('com.local.deepseekcodingdesktop');
    store = new LocalStore(app.getPath('userData'));
    registerIpc();
    createWindow();
    if (store.getSettings().remoteEnabled) {
      try {
        startRemoteServer(store);
      } catch {
        // Best effort: a stale port or LAN issue must never block the app from starting.
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Flush the database on the way out. The store already fsyncs every write, but a final flush
  // covers the case where the window is closed while a streaming answer is still being written.
  app.on('before-quit', () => {
    try {
      store?.flush();
    } catch {
      // Shutdown must never fail because of a flush error.
    }
    try {
      closeAllSessions();
    } catch {
      // Best effort — never block shutdown.
    }
    try {
      stopRemoteServer();
    } catch {
      // Best effort — never block shutdown.
    }
  });
}
