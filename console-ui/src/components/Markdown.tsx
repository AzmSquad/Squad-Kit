import ReactMarkdown from 'react-markdown';
import { Highlight } from 'prism-react-renderer';

const monoTheme = {
  plain: { color: 'var(--color-text)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-text-dim)', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: 'var(--color-text-muted)' } },
    { types: ['namespace'], style: { opacity: 0.7 } },
    { types: ['property', 'tag', 'boolean', 'number', 'constant', 'symbol', 'deleted'], style: { color: 'var(--color-info)' } },
    { types: ['selector', 'attr-name', 'string', 'char', 'builtin', 'inserted'], style: { color: 'var(--color-ok)' } },
    { types: ['operator', 'entity', 'url', 'variable'], style: { color: 'var(--color-text)' } },
    { types: ['atrule', 'attr-value', 'keyword'], style: { color: 'var(--color-warn)' } },
    { types: ['function', 'class-name'], style: { color: 'var(--color-text)' } },
    { types: ['regex', 'important'], style: { color: 'var(--color-fail)' } },
  ],
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose-docs max-w-none">
      <ReactMarkdown
        components={{
          code({ className, children, ...rest }) {
            const text = String(children);
            const looksBlock = Boolean(className?.startsWith('language-')) || text.includes('\n');
            if (!looksBlock) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            const match = /language-(\w+)/.exec(className ?? '');
            const lang = match?.[1] ?? '';
            const value = String(children).replace(/\n$/, '');
            if (!lang) {
              return (
                <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--gray-2)] p-3 text-[13px]">
                  <code className={className}>{children}</code>
                </pre>
              );
            }
            return (
              <Highlight code={value} language={lang} theme={monoTheme as never}>
                {({ tokens, getLineProps, getTokenProps }) => (
                  <pre className="overflow-x-auto">
                    {tokens.map((line, i) => (
                      <div key={i} {...getLineProps({ line })}>
                        {line.map((token, j) => (
                          <span key={j} {...getTokenProps({ token })} />
                        ))}
                      </div>
                    ))}
                  </pre>
                )}
              </Highlight>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
