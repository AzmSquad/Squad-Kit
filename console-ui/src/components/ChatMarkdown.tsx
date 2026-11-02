import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { Copy } from 'lucide-react';
import { ticketFileUrl } from '../api/client';
import { rehypeLang, type HNode } from '../lib/lang';
import { parseFlowchart, type Flowchart } from '../lib/flowchart';
import { usePrefs } from '../lib/prefs';
import { Lightbox } from './Lightbox';

/**
 * A chat message in Markdown: each paragraph, list item, heading and table cell gets its own language and direction,
 * code stays left to right with a Copy button, a Mermaid flowchart is drawn as a picture, and pictures open big.
 */
export function ChatMarkdown({ text, ticket, stream, caret }: { text: string; ticket: string; stream?: boolean; caret?: boolean }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const plugins = useMemo(() => [[rehypeLang, { stream, caret }]] as unknown as Options['rehypePlugins'], [stream, caret]);
  return (
    <div className="cmd">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            const url = !src ? '' : /^(https?:|data:)/.test(src) ? src : ticketFileUrl(ticket, src);
            return (
              <button className="cimg" onClick={() => setZoom(url)} aria-label={`Open ${alt || 'the picture'} big`}>
                <img src={url} alt={alt ?? ''} loading="lazy" />
              </button>
            );
          },
          table: ({ node, children }) => (
            <div className="ctable">
              <table dir={(node?.properties?.dir as string) ?? undefined}>{children}</table>
            </div>
          ),
          pre: ({ node }) => <Block node={node as unknown as HNode} />,
        }}
      >
        {text}
      </ReactMarkdown>
      {zoom && <Lightbox pictures={[{ src: zoom, caption: 'Picture' }]} start={0} onClose={() => setZoom(null)} />}
    </div>
  );
}

function plain(n: HNode): string {
  return n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(plain).join('');
}

/** A fenced block: a Mermaid flowchart becomes a diagram, anything else is code with its language and Copy. */
function Block({ node }: { node: HNode }) {
  const code = node.children?.find((c) => c.tagName === 'code');
  const cls = (code?.properties?.className as string[] | undefined) ?? [];
  const lang = cls.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
  const text = plain(code ?? node).replace(/\n$/, '');
  if (lang === 'mermaid') {
    const chart = parseFlowchart(text);
    if (chart) return <Diagram chart={chart} />;
  }
  return <CodeBlock lang={lang === 'mermaid' ? 'Diagram (Mermaid)' : lang} code={text} />;
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { theme, toast } = usePrefs();
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(
      () => toast('Code copied'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  return (
    <div className="ccode" dir="ltr">
      <div className="ccode-h">
        <span>{lang || 'text'}</span>
        <button className="cact" onClick={copy} aria-label="Copy the code">
          <Copy size={13} /> Copy
        </button>
      </div>
      <Highlight code={code} language={lang || 'text'} theme={theme === 'dark' ? themes.vsDark : themes.github}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, k) => (
                  <span key={k} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/**
 * A flowchart in the chat's colors: boxes in columns, arrows drawn after the boxes are laid out, so long labels and
 * Arabic text keep their real width.
 */
export function Diagram({ chart }: { chart: Flowchart }) {
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ d: string; x: number; y: number; label?: string; dashed?: boolean }[]>([]);
  const ranks = useMemo(() => {
    const out: Flowchart['nodes'][] = [];
    for (const n of chart.nodes) (out[n.rank] ??= []).push(n);
    return out.map((r) => (r ?? []).sort((a, b) => a.slot - b.slot));
  }, [chart]);
  const sinks = useMemo(() => new Set(chart.nodes.filter((n) => !chart.edges.some((e) => e.from === n.id)).map((n) => n.id)), [chart]);

  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const draw = () => {
      const at = root.getBoundingClientRect();
      const rect = (id: string) => root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      setLines(
        chart.edges.flatMap((e) => {
          const a = rect(e.from);
          const b = rect(e.to);
          if (!a || !b) return [];
          const forward = chart.across ? b.left >= a.right - 1 : b.top >= a.bottom - 1;
          let x1: number, y1: number, x2: number, y2: number, d: string;
          if (chart.across) {
            x1 = (forward ? a.right : a.left) - at.left;
            y1 = a.top + a.height / 2 - at.top;
            x2 = (forward ? b.left : b.right) - at.left;
            y2 = b.top + b.height / 2 - at.top;
            const k = Math.max(24, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
            d = `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
          } else {
            x1 = a.left + a.width / 2 - at.left;
            y1 = (forward ? a.bottom : a.top) - at.top;
            x2 = b.left + b.width / 2 - at.left;
            y2 = (forward ? b.top : b.bottom) - at.top;
            const k = Math.max(18, Math.abs(y2 - y1) / 2) * (forward ? 1 : -1);
            d = `M${x1},${y1} C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`;
          }
          return [{ d, x: (x1 + x2) / 2, y: (y1 + y2) / 2, ...(e.label ? { label: e.label } : {}), ...(e.dashed ? { dashed: true } : {}) }];
        }),
      );
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [chart]);

  return (
    <div className="cdiagram" dir="ltr">
      <div ref={box} className={`cflow ${chart.across ? 'across' : 'down'}`}>
        <svg className="cflow-lines" aria-hidden="true">
          <defs>
            <marker id="cflow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
          {lines.map((l, i) => (
            <path key={i} d={l.d} className={l.dashed ? 'dash' : ''} markerEnd="url(#cflow-arrow)" />
          ))}
        </svg>
        {ranks.map((r, i) => (
          <div key={i} className="cflow-rank">
            {r.map((n) => (
              <span key={n.id} data-node={n.id} className={`cnode ${n.shape} ${sinks.has(n.id) && n.shape !== 'decision' ? 'end' : ''}`}>
                <bdi>{n.text}</bdi>
              </span>
            ))}
          </div>
        ))}
        {lines.map((l, i) =>
          l.label ? (
            <span key={i} className="cflow-label" style={{ left: l.x, top: l.y }}>
              {l.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** Long answers fold after about 20 lines, so the talk stays easy to follow. One click shows all. */
export function Folded({ lines, children }: { lines: number; children: ReactNode }) {
  const [all, setAll] = useState(false);
  if (lines <= 26) return <>{children}</>;
  return (
    <div className={`cfold ${all ? 'open' : ''}`}>
      <div className="cfold-body">{children}</div>
      <button className="btn sm" onClick={() => setAll(!all)}>
        {all ? 'Show less' : `Show all · ${lines} lines`}
      </button>
    </div>
  );
}

/** About how many lines a message takes, counting long paragraphs as several and leaving out empty lines. */
export function lineCount(text: string): number {
  return text.split('\n').reduce((n, l) => n + (l.trim() ? Math.ceil(l.length / 80) : 0), 0);
}
