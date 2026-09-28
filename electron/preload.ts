import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AppSettings } from './types';

contextBridge.exposeInMainWorld('desktop', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
    setApiKey: (apiKey: string) => ipcRenderer.invoke('settings:setApiKey', apiKey),
    clearApiKey: () => ipcRenderer.invoke('settings:clearApiKey'),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    getLast: () => ipcRenderer.invoke('sessions:getLast'),
    setLast: (sessionId: string | null) => ipcRenderer.invoke('sessions:setLast', sessionId),
    create: () => ipcRenderer.invoke('sessions:create'),
    get: (sessionId: string) => ipcRenderer.invoke('sessions:get', sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke('sessions:delete', sessionId),
    chooseDirectory: (sessionId: string) => ipcRenderer.invoke('sessions:chooseDirectory', sessionId),
    setPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke('sessions:setPinned', sessionId, pinned),
    rename: (sessionId: string, title: string) => ipcRenderer.invoke('sessions:rename', sessionId, title),
  },
  agent: {
    start: (sessionId: string, text: string, runId: string, images?: string[]) =>
      ipcRenderer.invoke('agent:start', sessionId, text, runId, images),
    stop: (runId: string) => ipcRenderer.invoke('agent:stop', runId),
    inject: (sessionId: string, runId: string, text: string) =>
      ipcRenderer.invoke('agent:inject', sessionId, runId, text),
    resolveApproval: (approvalId: string, approved: boolean) =>
      ipcRenderer.invoke('approval:resolve', approvalId, approved),
    compact: (sessionId: string) => ipcRenderer.invoke('agent:compact', sessionId),
    onEvent: (callback: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => callback(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
  },
  system: {
    openExternal: (url: string) => ipcRenderer.invoke('system:openExternal', url),
  },
  files: {
    attach: () => ipcRenderer.invoke('files:attach'),
    attachFolder: () => ipcRenderer.invoke('files:attachFolder'),
    readForPreview: () => ipcRenderer.invoke('files:readForPreview'),
  },
  usage: {
    lifetime: () => ipcRenderer.invoke('usage:lifetime'),
  },
  remote: {
    start: () => ipcRenderer.invoke('remote:start'),
    stop: () => ipcRenderer.invoke('remote:stop'),
    status: () => ipcRenderer.invoke('remote:status'),
  },
  webview: {
    onRun: (callback: (requestId: string, script: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, requestId: string, script: string) => callback(requestId, script);
      ipcRenderer.on('webview:run', listener);
      return () => ipcRenderer.removeListener('webview:run', listener);
    },
    sendResult: (requestId: string, result: unknown, error: string | null) =>
      ipcRenderer.send('webview:result', requestId, result, error),
  },
});
