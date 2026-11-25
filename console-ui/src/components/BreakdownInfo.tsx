import { ExternalLink } from 'lucide-react';
import type { BreakdownView } from '../api/requirements-types';
import { basisWords, estimateBits } from '../lib/requirements';
import { useBoard } from '../lib/data';
import { fromTracker } from '../lib/epic-run';
import { TrackerMark } from './TrackerMark';
import { Written } from './ui';

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function whoWords(name: string, me: string | undefined): string {
  return me && name.trim().toLowerCase() === me.trim().toLowerCase() ? 'you' : name;
}

function dayWords(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? 'today' : `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** Where a breakdown comes from: the document, which opens in the viewer, or for a run the tracker item, which opens there. */
function Source({ v, onDoc }: { v: BreakdownView; onDoc(): void }) {
  const s = v.source;
  const t = s.tracker;
  if (fromTracker(v) && t)
    return (
      <>
        From <TrackerMark type={t.module} size={12} /> {t.label} ·{' '}
        <a className="rq-link mono" href={t.url} target="_blank" rel="noreferrer" title={`Open ${t.ref} in ${t.label}`}>
          {t.ref} <ExternalLink size={11} aria-hidden="true" />
        </a>
      </>
    );
  return (
    <>
      From{' '}
      <button className="rq-link" onClick={onDoc} title="Open the document">
        <Written text={s.name} />
      </button>
      {s.kind === 'pdf' && s.pages ? `, ${plural(s.pages, 'page')}` : ''}
      {s.pictures ? `, ${plural(s.pictures, 'picture')}` : ''}
    </>
  );
}

/** Where it comes from, its size, the estimate, and links to what was decided and left out. */
export function InfoLine({ v, onDecided, onLeftOut, onDoc }: { v: BreakdownView; onDecided(): void; onLeftOut(): void; onDoc(): void }) {
  const board = useBoard();
  const me = board.data?.ready ? board.data.meta.user?.name : undefined;
  const s = v.source;
  const e = v.estimate;
  const bits = estimateBits(e);
  const c = v.counts;
  const showEstimate = v.status === 'ready';
  return (
    <div className="rq-info">
      <span className="rq-source">
        <Source v={v} onDoc={onDoc} />, added by <Written text={whoWords(s.addedBy, me)} /> {dayWords(s.addedAt)}
      </span>
      <span>
        <b>{c.epics}</b> {c.epics === 1 ? 'epic' : 'epics'}, <b>{c.features}</b> {c.features === 1 ? 'feature' : 'features'}, <b>{c.stories}</b> {c.stories === 1 ? 'story' : 'stories'}
      </span>
      {showEstimate && e.stories > 0 && (
        <span>
          About {bits.cost && <><b>{bits.cost}</b> and </>}
          <b>{bits.time}</b> to build, {e.parallel} at a time <span className="rq-dim">({basisWords(e)})</span>
        </span>
      )}
      {v.decided.length > 0 && (
        <button className="rq-link" onClick={onDecided}>
          {v.decided.length} decided for you
        </button>
      )}
      {v.leftOut.length > 0 && (
        <button className="rq-link" onClick={onLeftOut}>
          {plural(v.leftOut.length, fromTracker(v) ? 'item' : 'part')} left out
        </button>
      )}
      {v.sent && v.tracker && !fromTracker(v) && <span>Sent to {v.tracker.label}</span>}
    </div>
  );
}
