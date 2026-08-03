'use client';

// ============================================================================
// MarkdownRenderer — рендер markdown через react-markdown + remark-gfm.
// ============================================================================
//
// KB citations: [text](#source:SOURCE_ID) or [text](#source:SOURCE_ID:CHUNK_ID)
// → clickable badges opening SourceDetailModal with optional chunk highlight.

import { memo, useState, useCallback, lazy, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { parseSourceCitationHref } from '@/lib/kb/citation-href';

const SourceDetailModal = lazy(() =>
  import('./source-detail-modal').then(m => ({ default: m.SourceDetailModal })),
);

type MarkdownRendererProps = {
  content: string;
  className?: string;
};

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const [citation, setCitation] = useState<{ sourceId: string; chunkId?: string } | null>(null);

  return (
    <div className={cn('space-y-2 break-words', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className: codeClassName, children, ...props }) => {
            const isInline = !codeClassName;
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-surface-2 text-xs font-mono text-accent"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            const lang = /language-(\w+)/.exec(codeClassName || '')?.[1] ?? 'text';
            const codeStr = String(children).replace(/\n$/, '');
            return <CodeBlock language={lang} code={codeStr} />;
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => {
            if (href && href.startsWith('#source:')) {
              const parsed = parseSourceCitationHref(href);
              if (parsed) {
                return (
                  <button
                    type="button"
                    onClick={() => setCitation(parsed)}
                    className="lia-citation"
                    title={`Открыть источник: ${String(children)}`}
                  >
                    {children}
                  </button>
                );
              }
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:text-accent/80 transition-colors"
              >
                {children}
              </a>
            );
          },
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-medium mt-2 mb-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-xs font-medium mt-2 mb-1">{children}</h4>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="text-sm">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse border border-border">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-surface-2/50 px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
          hr: () => <hr className="border-border my-3" />,
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through text-text-dim">{children}</del>,
        }}
      >
        {content}
      </ReactMarkdown>

      {citation && (
        <Suspense fallback={null}>
          <SourceDetailModal
            sourceId={citation.sourceId}
            highlightChunkId={citation.chunkId}
            onClose={() => setCitation(null)}
          />
        </Suspense>
      )}
    </div>
  );
});

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      /* clipboard may fail in insecure context */
    });
  }, [code]);

  return (
    <div className="rounded-md border border-border bg-background/50 overflow-hidden my-2">
      <div className="px-3 py-1.5 border-b border-border bg-surface-2/50 flex items-center justify-between">
        <span className="text-[10px] font-mono text-text-dim uppercase">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-[10px] text-text-dim hover:text-foreground transition-colors"
        >
          {copied ? 'скопировано' : 'копировать'}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-xs font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
