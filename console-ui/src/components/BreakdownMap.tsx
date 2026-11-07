import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import type { BreakdownView } from '../api/requirements-types';
import { useBoard } from '../lib/data';
import { Written } from './ui';
import { MAP, chipKind, findPart, firstScale, firstSentence, fitScale, mapLayout, popPlace, stopTag, waitingOn, type MapBox } from '../lib/requirements';

/**
 * The same breakdown as a map, for presenting: epics on top, their features under them, each feature's stories as
 * boxes coloured by where they are, and lines from each part to the one above it. Plain boxes and one drawing for
 * the lines; zoom, fit and drag to move around.
 */

const ZOOMS = { min: 0.3, max: 1.6, step: 0.1 };
const round = (x: number) => Math.round(x * 100) / 100;

export function BreakdownMap({ v, selected, onSelect, onDecide }: { v: BreakdownView; selected?: string; onSelect(key: string): void; onDecide(ticket: string): void }) {
  const layout = useMemo(() => mapLayout(v), [v.epics, v.progress]);
  const boxes = useMemo(() => new Map(layout.boxes.map((b) => [b.key, b])), [layout]);
  const view = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const progress = useMemo(() => new Map(v.progress.map((p) => [p.key, p])), [v.progress]);
  const youKeys = v.progress.filter((p) => p.state === 'needs-you').map((p) => p.key);
  const [pop, setPop] = useState<string | null>(youKeys[0] ?? null);
  const board = useBoard();
  const tickets = board.data?.ready ? board.data.tickets : [];

  // The needs-you note sits under the columns it would cover, and the map grows to hold it.
  const popBox = pop ? boxes.get(pop) : undefined;
  const place = popBox ? popPlace(layout, popBox) : null;
  const height = place?.height ?? layout.height;

  const fit = () => {
    const el = view.current;
    if (el) setScale(fitScale({ width: layout.width, height }, { width: el.clientWidth - 16, height: el.clientHeight - 16 }));
  };
  // At first the map shows its full width, as long as the words stay readable; the rows below are a scroll away.
  useLayoutEffect(() => {
    const el = view.current;
    if (el) setScale(firstScale(layout, { width: el.clientWidth - 16 }));
  }, []);
  useEffect(() => {
    if (pop && !youKeys.includes(pop)) setPop(youKeys[0] ?? null);
  }, [youKeys.join()]);

  // Drag the background to move around.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = view.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    view.current!.scrollLeft = d.left - (e.clientX - d.x);
    view.current!.scrollTop = d.top - (e.clientY - d.y);
  };
  const up = () => (drag.current = null);

  // The needs of the story under the pointer, or the chosen one, as lines from what it needs.
  const focus = hover ?? selected ?? null;
  const focusPart = findPart(v, focus ?? undefined);
  const needLines = focusPart?.story
    ? [
        ...focusPart.story.dependsOn.map((n) => ({ from: n, to: focusPart.story!.key })),
        ...waitingOn(v, focusPart.story.key).map((k) => ({ from: focusPart.story!.key, to: k })),
      ].filter((l) => boxes.has(l.from) && boxes.has(l.to))
    : [];

  const popP = pop ? progress.get(pop) : undefined;
  const popT = popP?.ticket ? tickets.find((t) => t.id === popP.ticket) : undefined;
  const popWaits = pop ? waitingOn(v, pop) : [];
  const headline = popT?.agentQuestion?.text ? firstSentence(popT.agentQuestion.text) : (popT?.waiting?.summary ?? findPart(v, pop ?? undefined)?.item.title ?? '');

  const click = (b: MapBox) => {
    if (b.level === 'story' && progress.get(b.key)?.state === 'needs-you') setPop(b.key);
    else {
      setPop(null);
      onSelect(b.key);
    }
  };

  return (
    <div className="rq-map">
      <div className="rq-zoom" role="group" aria-label="Zoom">
        <button className="btn sm" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(ZOOMS.min, round(s - ZOOMS.step)))}>
          −
        </button>
        <button className="btn sm" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(ZOOMS.max, round(s + ZOOMS.step)))}>
          +
        </button>
        <button className="btn sm" onClick={fit}>
          Fit
        </button>
      </div>
      <div className="rq-mapview" ref={view} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="rq-mapsize" style={{ width: layout.width * scale, height: height * scale }}>
          <div className="rq-mapcanvas" style={{ width: layout.width, height, transform: `scale(${scale})` }}>
            <svg className="rq-lines" width={layout.width} height={height} aria-hidden="true">
              {layout.lines.map((l, i) => (
                <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
              ))}
              {needLines.map((l) => {
                const a = boxes.get(l.from)!;
                const b = boxes.get(l.to)!;
                const sameCol = Math.abs(a.x - b.x) < 2;
                const x1 = sameCol ? a.x + a.w : a.x + (b.x > a.x ? a.w : 0);
                const x2 = sameCol ? b.x + b.w : b.x + (b.x > a.x ? 0 : b.w);
                const y1 = a.y + a.h / 2;
                const y2 = b.y + b.h / 2;
                const bend = sameCol ? 34 : Math.max(30, Math.abs(x2 - x1) / 2);
                const c1 = sameCol ? x1 + bend : x1 + (b.x > a.x ? bend : -bend);
                const c2 = sameCol ? x2 + bend : x2 + (b.x > a.x ? -bend : bend);
                return <path key={`${l.from}-${l.to}`} className="rq-needline" d={`M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`} markerEnd="url(#rq-arrow)" />;
              })}
              <defs>
                <marker id="rq-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="rq-arrowhead" />
                </marker>
              </defs>
            </svg>
            {layout.boxes.map((b) => {
              const p = progress.get(b.key);
              const style = { left: b.x, top: b.y, width: b.w, height: b.h };
              if (b.level === 'story')
                return (
                  <button
                    key={b.key}
                    className={`rq-chip ${chipKind(b.state)} ${selected === b.key ? 'sel' : ''}`}
                    style={style}
                    title={`${b.key} ${b.title}${p ? `: ${p.line}` : ''}`}
                    aria-label={`Story ${b.key} ${b.title}${p ? `: ${p.line}` : ''}`}
                    onClick={() => click(b)}
                    onMouseEnter={() => setHover(b.key)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(b.key)}
                    onBlur={() => setHover(null)}
                  >
                    <Written className="rq-chipt" lead={<em>{b.key}</em>} text={b.title} />
                  </button>
                );
              const pct = b.done?.of ? Math.round((b.done.done / b.done.of) * 100) : 0;
              return (
                <button key={b.key} className={`rq-box ${b.level} ${selected === b.key ? 'sel' : ''}`} style={style} onClick={() => click(b)} title={b.title} aria-label={`${b.level === 'epic' ? 'Epic' : 'Feature'} ${b.key} ${b.title}, ${b.done?.done ?? 0} of ${b.done?.of ?? 0} merged`}>
                  <Written className="n" text={b.title} />
                  <span className="p">
                    <i>
                      <b style={{ width: `${pct}%` }} />
                    </i>
                    {b.level === 'epic' ? `${b.done?.done ?? 0} of ${b.done?.of ?? 0}` : `${b.done?.done ?? 0}/${b.done?.of ?? 0}`}
                  </span>
                </button>
              );
            })}
            {popBox && popP && place && (
              <div className="rq-pop" style={{ left: place.left, top: place.top, width: MAP.popW }} role="dialog" aria-label={`${popBox.key} needs you`}>
                <button className="rq-pop-x" aria-label="Close" onClick={() => setPop(null)}>
                  <X size={13} />
                </button>
                <div className="rq-pop-w">{[popBox.key, popP.ticket, stopTag(popP.stop)].filter(Boolean).join(' · ')}</div>
                <Written as="div" className="rq-pop-t" text={headline} />
                <div className="rq-pop-s">
                  {popWaits.length ? `${popWaits.join(', ')} ${popWaits.length === 1 ? 'waits' : 'wait'} for it. ` : ''}
                  {v.state.build?.on ? 'Everything else keeps going.' : ''}
                </div>
                {popP.ticket && (
                  <button className="btn sm you" onClick={() => onDecide(popP.ticket!)}>
                    Decide
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="rq-legend">
        <span className="k">
          <i className="m" />
          Merged
        </span>
        <span className="k">
          <i className="b" />
          Building
        </span>
        <span className="k">
          <i className="y" />
          Needs you
        </span>
        <span className="k">
          <i className="w" />
          Not started
        </span>
        <span>Click a box to open it. Drag to move around.</span>
      </div>
    </div>
  );
}
