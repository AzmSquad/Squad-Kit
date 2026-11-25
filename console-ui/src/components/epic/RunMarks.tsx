import { FileText, Plus } from 'lucide-react';
import type { BreakdownRow, BreakdownStory, BreakdownView } from '../../api/requirements-types';
import { fromTracker, needFrom, trackerLabel } from '../../lib/epic-run';
import { langProps } from '../../lib/lang';
import { useReqAct } from '../../lib/requirementsData';
import { TrackerMark } from '../TrackerMark';
import { Cmd, Written } from '../ui';
import '../../styles/epic.css';

/**
 * The marks a run from the tracker gets on the Requirements screens: where a row comes from in the list, the stories
 * added in the tracker since the run began, and where each need came from.
 */

/** A row's second line in the list: the document, or for a run "From Azure DevOps". */
export function RowSource({ r }: { r: BreakdownRow }) {
  // The run says which tracker made it: the project's tracker may have changed since.
  const tracker = r.source.tracker;
  if (r.source.kind !== 'tracker')
    return (
      <span {...langProps(r.source.name)}>
        <FileText size={12} aria-hidden="true" /> <Written text={r.source.name} />
      </span>
    );
  // The project's tracker made the run. Its name is said once: a name that is only the title again is left out.
  const name = r.source.name && r.source.name !== r.title ? r.source.name : '';
  return (
    <span>
      <TrackerMark type={tracker?.module ?? ''} size={12} /> {`From ${tracker?.label ?? 'the tracker'}${name ? ' · ' : ''}`}
      {name && <Written text={name} />}
    </span>
  );
}

/** "1 new story in Azure DevOps": stories added under the run's item since it began. They join only when added here. */
export function TrackerNew({ v }: { v: BreakdownView }) {
  const act = useReqAct();
  const list = v.state.trackerNew ?? [];
  if (!fromTracker(v) || !list.length) return null;
  const one = list.length === 1;
  return (
    <div className="ep-new" role="status">
      <Plus size={15} aria-hidden="true" />
      <span className="ep-newt">
        <b>
          {one ? '1 new story' : `${list.length} new stories`} in {trackerLabel(v)}:
        </b>{' '}
        {list.slice(0, 3).map((s, i) => (
          <span key={s.id}>
            {i > 0 && ', '}
            <span className="mono">{s.ref}</span> <Written text={s.title} />
          </span>
        ))}
        {list.length > 3 && ` and ${list.length - 3} more`}. {one ? 'It joins' : 'They join'} the run only if you say so: the Analyst reads {one ? 'it' : 'them'} first.
      </span>
      {v.mine && (
        <span className="ep-newb">
          <button
            className="btn sm"
            disabled={act.isPending}
            onClick={() => act.mutate({ path: `/api/v1/requirements/${encodeURIComponent(v.id)}/tracker-new`, done: `The Analyst reads ${one ? 'the new story' : 'the new stories'}. You see ${one ? 'it' : 'them'} before ${one ? 'it builds' : 'they build'}.` })}
          >
            {one ? 'Add it to the run' : 'Add them to the run'}
          </button>
          <Cmd text={`squad requirements add-new ${v.id}`} />
        </span>
      )}
    </div>
  );
}

/** A story's needs on its tree row, each with where it came from on a run: "needs S-1 · from Azure DevOps". */
export function NeedChips({ v, s }: { v: BreakdownView; s: BreakdownStory }) {
  return (
    <>
      {s.dependsOn.slice(0, 2).map((n) => {
        const from = needFrom(v, s, n);
        if (!from)
          return (
            <span key={n} className="rq-need">
              needs {n}
            </span>
          );
        return (
          <span key={n} className={`rq-need ep-need ${s.needsFrom?.[n] === 'analyst' ? 'ep-added' : ''}`}>
            needs <b>{n}</b> · {from}
          </span>
        );
      })}
      {s.dependsOn.length > 2 && <span className="rq-need">+{s.dependsOn.length - 2}</span>}
    </>
  );
}

/** Beside a need in a story's panel, on a run: "from Azure DevOps" or "added by the Analyst". */
export function NeedFrom({ v, s, n }: { v: BreakdownView; s: BreakdownStory; n: string }) {
  const from = needFrom(v, s, n);
  return from ? <span className={`ep-from ${s.needsFrom?.[n] === 'analyst' ? 'ep-added' : ''}`}>{from}</span> : null;
}
