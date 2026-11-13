import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bug, ExternalLink, Play, Plug } from 'lucide-react';
import { api } from '../api/client';
import type { BacklogResponse, TrackerStatus, WorkItemRow } from '../api/types';
import { useAct } from '../lib/data';
import { isolated, langProps } from '../lib/lang';
import { shellQuote } from '../lib/text';
import { Cmd, STAGE_NAME, Written } from '../components/ui';

/** The sprint's stories and bugs from the project's tracker. Starting one makes it a ticket the squad works on. */
export function BacklogPage() {
  const [sprint, setSprint] = useState<string | undefined>(undefined);
  const backlog = useQuery({
    queryKey: ['backlog', sprint ?? ''],
    queryFn: () => api<BacklogResponse>(`/api/v1/backlog${sprint ? `?sprint=${encodeURIComponent(sprint)}` : ''}`),
    refetchInterval: 15_000,
  });
  const data = backlog.data;
  const label = useQuery({ queryKey: ['tracker'], queryFn: () => api<TrackerStatus>('/api/v1/tracker') }).data?.label ?? 'the tracker';
  const chosen = sprint ?? data?.sprint;
  const sprintName = data?.sprints.find((s) => s.path === chosen)?.name;
  return (
    <>
      <div className="top">
        <h1>Backlog</h1>
        {data?.connected && data.sprints.length > 0 && (
          <select className="input" style={{ width: 'auto', marginLeft: 12 }} value={chosen ?? 'all'} onChange={(e) => setSprint(e.target.value)} aria-label="Sprint">
            {data.sprints.map((s) => (
              <option key={s.path} value={s.path}>
                {isolated(s.name)}
                {s.current ? ' (now)' : ''}
              </option>
            ))}
            <option value="all">Everything open</option>
          </select>
        )}
        <span className="grow" />
        <Cmd text={sprintName ? `squad backlog --sprint ${shellQuote(sprintName)}` : 'squad backlog'} />
      </div>
      <div className="scroll">
        <div className="page">
          {backlog.isLoading ? (
            <p className="note">Reading the backlog from {label}…</p>
          ) : !data?.connected ? (
            <div className="calm">
              <span className="ring"><Plug size={18} /></span>
              <div>
                <b>Connect a tracker</b>
                <span>
                  {data?.error ?? 'Connect your tracker in Settings, and your stories and bugs show up here.'}{' '}
                  <Link to="/settings" style={{ fontWeight: 600 }}>Open Settings</Link>
                </span>
              </div>
            </div>
          ) : data.error ? (
            <p className="note" style={{ color: 'var(--bug)' }}>{data.error}</p>
          ) : data.items.length === 0 ? (
            <p className="note">Nothing open in {sprintName ?? 'this sprint'}.</p>
          ) : (
            <>
              <p className="note" style={{ marginBottom: 12 }}>
                {data.items.length} open {data.items.length === 1 ? 'item' : 'items'} in {sprintName ?? 'the backlog'}, in backlog order. Start one and the squad picks it up; {label} follows along.
                {data.capped && ' There are more: only the first 500 are shown. Pick a sprint here, or a view or Status in Settings, to see the rest.'}
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 80 }}>ID</th>
                    <th>Title</th>
                    <th style={{ width: 70 }}>Points</th>
                    <th style={{ width: 100 }}>On {label}</th>
                    <th style={{ width: 260 }}>squad-kit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((w) => (
                    <Row key={w.id} w={w} />
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ w }: { w: WorkItemRow }) {
  const act = useAct();
  return (
    <tr>
      <td className="mono">
        <a href={w.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {w.ref} <ExternalLink size={11} />
        </a>
      </td>
      <td {...langProps(w.title)}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {w.isBug && <span className="pill bug" style={{ padding: '2px 8px' }}><Bug size={12} /> Bug</span>}
          <Written style={{ fontWeight: 600 }} text={w.title} />
        </span>
      </td>
      <td>{w.points ?? ''}</td>
      <td>{w.state}</td>
      <td>
        {w.ticket ? (
          <Link to="/board" search={{ ticket: w.ticket.id }} style={{ color: 'var(--muted)' }}>
            <b className="mono" style={{ color: 'var(--text)' }}>{w.ticket.id}</b> {w.ticket.stage === 'done' ? 'Released' : STAGE_NAME[w.ticket.stage]}
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
