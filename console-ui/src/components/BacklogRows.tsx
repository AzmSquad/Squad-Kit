import { Link } from '@tanstack/react-router';
import { Bug, ChevronDown, ChevronRight, ExternalLink, Play } from 'lucide-react';
import type { BacklogGroup, WorkItemRow } from '../api/types';
import { useAct } from '../lib/data';
import { langProps } from '../lib/lang';
import { STAGE_NAME, Written } from './ui';

/**
 * The Backlog's rows: an item with its Start button or its ticket, and, in the tree, an epic or feature with how far
 * its items got. A row's depth indents its title; a fold button opens and closes what is under it.
 */

const INDENT = 26;

function Fold({ title, open, onFold }: { title: string; open: boolean; onFold: () => void }) {
  return (
    <button className="bl-fold" onClick={onFold} aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} ${title}`}>
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
    </button>
  );
}

function RefLink({ w }: { w: Pick<WorkItemRow, 'url' | 'ref'> }) {
  // A key like PAY-40 stays on one line.
  return (
    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
      {w.url ? (
        <a href={w.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {w.ref} <ExternalLink size={11} />
        </a>
      ) : (
        w.ref
      )}
    </td>
  );
}

/** An epic or feature: its type in the tracker's words, and how many of its items in this list are merged. */
export function GroupRow({ g, depth, items, open, onFold }: { g: BacklogGroup; depth: number; items: WorkItemRow[]; open: boolean; onFold: () => void }) {
  const merged = items.filter((i) => i.ticket?.merged).length;
  const points = items.reduce((n, i) => n + (i.points ?? 0), 0);
  return (
    <tr className={`bl-group ${g.level}`}>
      <RefLink w={g} />
      {/* The tree keeps its own side; the title alone runs its language's way (Written). */}
      <td>
        <span className="bl-t" style={{ paddingInlineStart: depth * INDENT }}>
          <Fold title={g.title} open={open} onFold={onFold} />
          <span className={`bl-lv ${g.level}`}>{g.type || (g.level === 'epic' ? 'Epic' : 'Feature')}</span>
          <Written className="bl-gt" text={g.title} />
        </span>
      </td>
      <td className="bl-dim">{points || ''}</td>
      <td>{g.state}</td>
      <td>
        <span className="bl-prog">
          {merged > 0 ? (
            <>
              <span className="bl-dim">
                <b>{merged}</b> of {items.length} merged
              </span>
              <span className="bl-bar" aria-hidden="true">
                <i style={{ width: `${Math.round((merged / items.length) * 100)}%` }} />
              </span>
            </>
          ) : (
            <span className="bl-dim">{items.length === 1 ? '1 item' : `${items.length} items`}</span>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * A story or bug: its ticket on the board, or Start. In the tree (`depth` given), an item with something under it folds
 * too; one with nothing to fold lines up with the titles beside the folds.
 */
export function ItemRow({ w, depth, fold }: { w: WorkItemRow; depth?: number; fold?: { open: boolean; onFold: () => void } }) {
  const act = useAct();
  const inTree = depth !== undefined;
  const pad = inTree ? depth * INDENT + (fold ? 0 : 22 + 8) : 0;
  return (
    <tr>
      <RefLink w={w} />
      {/* A plain list's cell runs the title's way, as before; in the tree, only the title does. */}
      <td {...(inTree ? {} : langProps(w.title))}>
        <span className="bl-t" style={{ paddingInlineStart: pad }}>
          {fold && <Fold title={w.title} open={fold.open} onFold={fold.onFold} />}
          {w.isBug && <span className="pill bug" style={{ padding: '2px 8px' }}><Bug size={12} /> Bug</span>}
          <Written style={{ fontWeight: 600 }} text={w.title} />
        </span>
      </td>
      <td>{w.points ?? ''}</td>
      <td>{w.state}</td>
      <td>
        {w.ticket ? (
          <Link to="/board" search={{ ticket: w.ticket.id }} style={{ color: 'var(--muted)' }}>
            <b className="mono" style={{ color: 'var(--text)' }}>{w.ticket.id}</b> {w.ticket.stage === 'done' ? 'Released' : w.ticket.merged ? 'Merged' : STAGE_NAME[w.ticket.stage]}
          </Link>
        ) : (
          <button
            className="btn sm pri"
            disabled={act.isPending}
            onClick={() => act.mutate({ path: `/api/v1/backlog/${encodeURIComponent(w.id)}/start`, done: `${w.ref} is on the board. The Analyst is reading it.` })}
          >
            <Play size={13} /> Start
          </button>
        )}
      </td>
    </tr>
  );
}

export function LooseRow() {
  return (
    <tr className="bl-loose">
      <td colSpan={5}>Not in an epic</td>
    </tr>
  );
}
