import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FastForward } from 'lucide-react';
import type { BacklogGroup, WorkItemRow } from '../../api/tracker-types';
import { buildCommand, holdsWords, runLine } from '../../lib/epic-run';
import { Cmd } from '../ui';
import { BuildAllDialog } from './BuildAllDialog';
import '../../styles/epic.css';

/**
 * An epic's or feature's squad-kit cell on the Backlog: Build all, or once it has a run, how far the run got and Open
 * the run. `sprint`: the sprint the Backlog shows, for "Only the 3 in Sprint 14".
 */
export function GroupRun({ g, items, sprint, label }: { g: BacklogGroup; items: WorkItemRow[]; sprint?: string; label: string }) {
  const [asking, setAsking] = useState(false);
  if (g.run) {
    const r = runLine(g.run);
    return (
      <span className="ep-run">
        <span className="ep-runline">
          {r.live && <span className="live" aria-hidden="true" />}
          <span>
            <b>{r.state}</b> · {r.merged}
          </span>
          <span className="bl-bar" aria-hidden="true">
            <i style={{ width: `${r.pct}%` }} />
          </span>
        </span>
        {r.you && <span className="pill you ep-tag">{r.you}</span>}
        <Link to="/requirements/$id" params={{ id: g.run.id }} className="btn sm">
          Open the run
        </Link>
        <Cmd text={`squad requirements show ${g.run.id}`} />
      </span>
    );
  }
  const merged = items.filter((i) => i.ticket?.merged).length;
  return (
    <span className="ep-run">
      <button className={`btn sm ${g.level === 'epic' ? 'pri' : ''}`} onClick={() => setAsking(true)} aria-label={`Build all of ${g.title}`}>
        <FastForward size={13} /> Build all
      </button>
      <span className="bl-dim">{merged ? `${merged} of ${items.length} merged` : holdsWords(items)}</span>
      <Cmd text={buildCommand(g.ref)} />
      {asking && <BuildAllDialog g={g} sprint={sprint} label={label} onClose={() => setAsking(false)} />}
    </span>
  );
}
