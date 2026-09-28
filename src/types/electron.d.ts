import type React from 'react';
import type {
  AgentEvent,
  AppSettings,
  PublicSession,
  PublicSettings,
  SessionRecord,
  ChatMessage,
  CompactResult,
  AttachedFile,
  UsageStats,
} from '../types';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: string;
        partition?: string;
      };
    }
  }
  interface Window {
    desktop: {
      settings: {
        get: () => Promise<PublicSettings>;
        update: (patch: Partial<AppSettings>) => Promise<PublicSettings>;
        setApiKey: (apiKey: string) => Promise<PublicSettings>;
        clearApiKey: () => Promise<PublicSettings>;
      };
      sessions: {
        list: () => Promise<PublicSession[]>;
        getLast: () => Promise<string | null>;
        setLast: (sessionId: string | null) => Promise<boolean>;
        create: () => Promise<SessionRecord>;
        get: (sessionId: string) => Promise<SessionRecord>;
        delete: (sessionId: string) => Promise<void>;
        chooseDirectory: (sessionId: string) => Promise<SessionRecord | null>;
        setPinned: (sessionId: string, pinned: boolean) => Promise<PublicSession[]>;
        rename: (sessionId: string, title: string) => Promise<PublicSession[]>;
      };
      agent: {
        start: (sessionId: string, text: string, runId: string, images?: string[]) => Promise<{ runId: string; userMessage: ChatMessage }>;
        stop: (runId: string) => Promise<boolean>;
        inject: (sessionId: string, runId: string, text: string) => Promise<{ queued: boolean }>;
        resolveApproval: (approvalId: string, approved: boolean) => Promise<boolean>;
        compact: (sessionId: string) => Promise<CompactResult>;
        onEvent: (callback: (event: AgentEvent) => void) => () => void;
      };
      system: {
        openExternal: (url: string) => Promise<void>;
      };
      files: {
        attach: () => Promise<AttachedFile[]>;
        attachFolder: () => Promise<{ rootName: string; files: AttachedFile[] }>;
        readForPreview: () => Promise<{ name: string; content: string; truncated: boolean } | null>;
      };
      usage: {
        lifetime: () => Promise<UsageStats>;
      };
      remote: {
        start: () => Promise<{ running: boolean; url: string | null; candidates: { name: string; url: string }[]; qr: string | null }>;
        stop: () => Promise<{ running: boolean; url: string | null; candidates: { name: string; url: string }[]; qr: string | null }>;
        status: () => Promise<{ running: boolean; url: string | null; candidates: { name: string; url: string }[]; qr: string | null }>;
      };
      webview: {
        onRun: (callback: (requestId: string, script: string) => void) => () => void;
        sendResult: (requestId: string, result: unknown, error: string | null) => void;
      };
    };
  }
}

export {};
