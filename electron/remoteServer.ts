import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import QRCode from 'qrcode';
import type { LocalStore } from './store';
import { clearAgentRun, runAgent, stopAgentRun, type AgentEventSink } from './deepseek';

// LAN-only phone chat: no separate server process, no cloud relay — this Electron process itself
// listens on the local network so a phone browser on the same WiFi can talk to the exact same
// agent/session as the desktop window. Runs only while the desktop app is open; closing it stops
// this too, same as everything else in this app.

let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;

export function isRemoteRunning(): boolean {
  return httpServer !== null;
}

// Dev machines commonly carry several virtual adapters (VirtualBox host-only, Hyper-V vEthernet,
// Docker, WSL) alongside the real WiFi one — os.networkInterfaces() has no notion of which is
// "the LAN a phone could actually reach," so picking the first non-internal IPv4 address is a coin
// flip that lands on a virtual adapter as often as not. Score by interface name instead: real
// WiFi/Ethernet adapters win, known-virtual ones are excluded outright.
const VIRTUAL_ADAPTER_PATTERN = /virtualbox|vmware|hyper-v|vethernet|docker|wsl|loopback|bluetooth|npcap|tap-|tun-/i;
const WIFI_ADAPTER_PATTERN = /wi-?fi|wlan|wireless/i;

export interface LanCandidate {
  address: string;
  name: string;
}

export function listLanCandidates(): LanCandidate[] {
  const nets = os.networkInterfaces();
  const candidates: LanCandidate[] = [];
  for (const name of Object.keys(nets)) {
    if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue;
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ address: net.address, name });
    }
  }
  // Real WiFi/Ethernet adapter names first, since that's almost always the one a phone on the
  // same network can reach.
  candidates.sort((a, b) => Number(WIFI_ADAPTER_PATTERN.test(b.name)) - Number(WIFI_ADAPTER_PATTERN.test(a.name)));
  return candidates;
}

function getLanAddress(): string {
  return listLanCandidates()[0]?.address ?? '127.0.0.1';
}

export function remoteUrl(store: LocalStore): string {
  const settings = store.getSettings();
  return `http://${getLanAddress()}:${settings.remotePort}/?t=${settings.remoteToken}`;
}

export function remoteUrlCandidates(store: LocalStore): { name: string; url: string }[] {
  const settings = store.getSettings();
  return listLanCandidates().map((candidate) => ({
    name: candidate.name,
    url: `http://${candidate.address}:${settings.remotePort}/?t=${settings.remoteToken}`,
  }));
}

/** PNG data URI QR code for a URL, so the phone can scan with its camera instead of copy-pasting. */
export async function remoteQrCode(url: string): Promise<string> {
  return QRCode.toDataURL(url, { margin: 1, width: 256 });
}

export function startRemoteServer(store: LocalStore): { url: string } {
  if (httpServer) stopRemoteServer();

  let settings = store.getSettings();
  if (!settings.remoteToken) {
    settings = store.updateSettings({ remoteToken: crypto.randomBytes(16).toString('hex') });
  }
  const token = settings.remoteToken;
  const port = settings.remotePort;

  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found.');
      return;
    }
    if (url.searchParams.get('t') !== token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Sai token — mở lại đúng link từ máy tính.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderPage());
  });

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.searchParams.get('t') !== token) {
      ws.close(4001, 'bad token');
      return;
    }
    void handleConnection(ws, store);
  });

  httpServer.listen(port, '0.0.0.0');
  return { url: remoteUrl(store) };
}

export function stopRemoteServer(): void {
  wss?.close();
  wss = null;
  httpServer?.close();
  httpServer = null;
}

function getOrCreateRemoteSession(store: LocalStore): string {
  const settings = store.getSettings();
  const existing = settings.remoteSessionId;
  if (existing && store.listSessions().some((session) => session.id === existing)) return existing;
  const session = store.createSession();
  store.updateSettings({ remoteSessionId: session.id });
  return session.id;
}

async function handleConnection(ws: WebSocket, store: LocalStore): Promise<void> {
  const sessionId = getOrCreateRemoteSession(store);
  let activeRunId: string | null = null;

  const sink: AgentEventSink = {
    isDestroyed: () => ws.readyState !== ws.OPEN,
    send: (channel, payload) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ channel, payload }));
    },
  };

  try {
    const session = store.getSession(sessionId);
    ws.send(JSON.stringify({ channel: 'init', payload: { session } }));
  } catch {
    ws.close(1011, 'session load failed');
    return;
  }

  ws.on('message', (raw) => {
    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'send') {
      const text = String(msg.text ?? '').trim();
      if (!text || activeRunId) return;
      const userMessage = store.addMessage(sessionId, 'user', text);
      const runId = randomUUID();
      activeRunId = runId;
      sink.send('agent:event', { type: 'user-echo', message: userMessage });
      void runAgent({
        runId,
        sessionId,
        store,
        webContents: sink,
        // No phone-side approval UI exists, so a mutating tool call that needs approval (i.e.
        // autoApprove is off) fails closed here rather than being silently rubber-stamped or
        // left hanging forever.
        requestApproval: async () => false,
      })
        .catch((error) => sink.send('agent:event', { type: 'error', message: (error as Error).message }))
        .finally(() => {
          activeRunId = null;
          clearAgentRun(runId);
        });
    } else if (msg.type === 'stop' && activeRunId) {
      stopAgentRun(activeRunId);
    }
  });

  ws.on('close', () => {
    if (activeRunId) stopAgentRun(activeRunId);
  });
}

function renderPage(): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Lục Trầm — Remote</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #111315; color: #e8e8e8; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 10px 14px; border-bottom: 1px solid #2a2d31; font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: space-between; }
  #status { font-size: 11px; color: #8a8f98; }
  #log { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { padding: 8px 10px; border-radius: 10px; max-width: 90%; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #7c5cff; color: #fff; }
  .msg.assistant { align-self: flex-start; background: #1c1f22; }
  .msg.tool { align-self: flex-start; background: transparent; color: #8a8f98; font-size: 12px; font-family: monospace; }
  .msg.error { align-self: center; background: #3a1c1c; color: #ff8a8a; font-size: 12px; }
  form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #2a2d31; }
  textarea { flex: 1; resize: none; border-radius: 10px; border: 1px solid #2a2d31; background: #1c1f22; color: #e8e8e8; padding: 10px; font: inherit; font-size: 14px; }
  button { border: 0; border-radius: 10px; background: #7c5cff; color: #fff; padding: 0 16px; font-weight: 700; }
  button:disabled { opacity: 0.5; }
</style>
</head>
<body>
<header><span>Lục Trầm — Remote</span><span id="status">đang kết nối…</span></header>
<div id="log"></div>
<form id="form">
  <textarea id="input" rows="1" placeholder="Nhắn gì đó…"></textarea>
  <button id="send" type="submit">Gửi</button>
</form>
<script>
const log = document.getElementById('log');
const status = document.getElementById('status');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
let currentAssistantEl = null;

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + location.search);
ws.onopen = () => { status.textContent = 'đã kết nối'; };
ws.onclose = () => { status.textContent = 'mất kết nối'; sendBtn.disabled = true; };
ws.onerror = () => { status.textContent = 'lỗi kết nối'; };

ws.onmessage = (event) => {
  const { channel, payload } = JSON.parse(event.data);
  if (channel === 'init') {
    for (const m of payload.session.messages) addMsg(m.role, m.content);
    return;
  }
  if (channel !== 'agent:event') return;
  const type = payload.type;
  if (type === 'user-echo') return; // already shown optimistically
  if (type === 'assistant-delta') {
    if (!currentAssistantEl) currentAssistantEl = addMsg('assistant', '');
    currentAssistantEl.textContent += payload.delta;
    log.scrollTop = log.scrollHeight;
  } else if (type === 'tool-start') {
    addMsg('tool', '→ ' + payload.toolName);
  } else if (type === 'tool-result') {
    addMsg('tool', payload.summary || '');
  } else if (type === 'error') {
    addMsg('error', payload.message || 'Lỗi không rõ.');
    currentAssistantEl = null;
    sendBtn.disabled = false;
  } else if (type === 'run-complete' || type === 'final') {
    currentAssistantEl = null;
    sendBtn.disabled = false;
  }
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMsg('user', text);
  ws.send(JSON.stringify({ type: 'send', text }));
  input.value = '';
  currentAssistantEl = null;
  sendBtn.disabled = true;
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
</script>
</body>
</html>`;
}
