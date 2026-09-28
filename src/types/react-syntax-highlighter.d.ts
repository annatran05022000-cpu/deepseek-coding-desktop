declare module 'react-syntax-highlighter' {
  import type { ComponentType, ReactNode } from 'react';
  export const Prism: ComponentType<{
    language?: string;
    style?: Record<string, unknown>;
    children: ReactNode;
    customStyle?: Record<string, unknown>;
    PreTag?: string | ComponentType<any>;
  }>;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  export const vscDarkPlus: Record<string, unknown>;
}
