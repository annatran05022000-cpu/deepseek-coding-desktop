import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Check, Copy } from 'lucide-react';

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href && /^https?:\/\//i.test(href)) {
                void window.desktop.system.openExternal(href);
              }
            }}
          >
            {children}
          </a>
        ),
        img: ({ src, alt }) => {
          if (typeof src !== 'string' || !src.startsWith('data:image/')) return null;
          return <img src={src} alt={alt ?? 'screenshot'} className="chat-image" />;
        },
        code: (props: any) => {
          const { className, children, node } = props;
          const text = String(children).replace(/\n$/, '');
          const language = /language-([\w-]+)/.exec(className ?? '')?.[1];
          const isBlock = Boolean(language) || node?.position?.start?.line !== node?.position?.end?.line;
          if (!isBlock) return <code className="inline-code">{children}</code>;
          return <CodeBlock language={language} code={text} />;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || 'text'}</span>
        <button type="button" onClick={copy} className="icon-text-button">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={vscDarkPlus}
        customStyle={{ margin: 0, borderRadius: 0, background: '#0d1117', fontSize: '13px' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
