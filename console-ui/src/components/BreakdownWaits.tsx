import { useQueries, useQuery } from '@tanstack/react-query';
import { PROJECT, api } from '../api/client';
import type { AppProjects, Ticket } from '../api/types';
import { shellArg } from '../lib/text';
import { Cmd, ago } from './ui';
import { BreakdownLink, StopTag } from './AutoTicket';
import { requirementsPath, stopKind } from '../lib/auto';
import '../styles/auto.css';

/**
 * Waiting for you, for the breakdowns: one whose Analyst has questions waits for the person like a ticket does, in
 * the banner, the list, the count and the tab title. Terminal: `squad inbox`, `squad requirements answer BR-2`.
 */

/** A breakdown of mine whose Analyst waits for answers (GET /api/v1/requirements/waiting). */
export interface BreakdownWait {
  id: string;
  title: string;
  questions: number;
  since: string;
  /** On Home, where the breakdowns come from every project: the one it is in. */
  project?: { id: string; name: string };
}

export function useBreakdownWaits(): BreakdownWait[] {
  const q = useQuery({
    queryKey: ['requirements', 'waiting'],
    queryFn: () => api<{ breakdowns: BreakdownWait[] }>('/api/v1/requirements/waiting'),
    enabled: Boolean(PROJECT),
    refetchInterval: 3000,
  });
  return q.data?.breakdowns ?? [];
}

/**
 * Home: every open project's breakdowns that wait for answers. Each project answers at its own address
 * (/p/<id>/api/v1/requirements/waiting); one that cannot answer simply adds none.
 */
export function useAllBreakdownWaits(): BreakdownWait[] {
  const projects = useQuery({ queryKey: ['app', 'projects'], queryFn: () => api<AppProjects>('/api/v1/app/projects'), refetchInterval: 2000 });
  const list = (projects.data?.projects ?? []).filter((p) => p.open);
  const waits = useQueries({
    queries: list.map((p) => ({
      queryKey: ['app', 'requirements-waiting', p.id],
      queryFn: () => api<{ breakdowns: BreakdownWait[] }>(`/p/${encodeURIComponent(p.id)}/api/v1/requirements/waiting`),
      refetchInterval: 3000,
      retry: false,
    })),
  });
  return waits.flatMap((q, i) => (q.data?.breakdowns ?? []).map((w) => ({ ...w, project: { id: list[i]!.id, name: list[i]!.name } })));
}

/** The breakdown's page: in this project, or in its own project from Home (another page load). */
function hrefOf(w: BreakdownWait): string {
  return `/p/${encodeURIComponent(w.project!.id)}${requirementsPath(w.id)}`;
}

/** "squad requirements answer BR-2", naming the project on Home. */
function answerCommand(w: BreakdownWait): string {
  return `squad requirements answer ${w.id}${w.project ? ` --project ${shellArg(w.project.name)}` : ''}`;
}

/** "BR-2: the Analyst has 3 questions". */
export function breakdownWaitLine(w: BreakdownWait): string {
  return `The Analyst has ${w.questions} ${w.questions === 1 ? 'question' : 'questions'}`;
}

/** One breakdown in the banner at the top of every page. */
export function BreakdownBannerItem({ w }: { w: BreakdownWait }) {
  return (
    <div className="yitem" title={`${w.project ? `${w.project.name} · ` : ''}${w.id} · ${w.title}\n${breakdownWaitLine(w)}`}>
      <span className="yid">{w.project ? `${w.project.name} · ${w.id}` : w.id}</span>
      <span className="yline">{breakdownWaitLine(w)}</span>
      {w.project ? (
        <a className="btn sm you" href={hrefOf(w)}>
          Answer
        </a>
      ) : (
        <BreakdownLink id={w.id} className="btn sm you">
          Answer
        </BreakdownLink>
      )}
    </div>
  );
}

/** The same, as a card on the Waiting for you page. */
export function BreakdownWaitCard({ w }: { w: BreakdownWait }) {
  return (
    <div className="wcard" style={{ padding: '16px 18px 16px 22px' }}>
      <div className="grow">
        <div className="meta">
          {w.project && <span className="pill sm">{w.project.name}</span>}
          <span className="id">{w.id}</span>
          <span>Requirements</span>
          <span>{ago(w.since)}</span>
        </div>
        <h3>{w.title}</h3>
        <p>{breakdownWaitLine(w)}. It writes the breakdown once you answer.</p>
      </div>
      <Cmd text={answerCommand(w)} />
      {w.project ? (
        <a className="btn pri sm" href={hrefOf(w)}>
          Answer
        </a>
      ) : (
        <BreakdownLink id={w.id} className="btn pri sm">
          Answer
        </BreakdownLink>
      )}
    </div>
  );
}

/** The stop tag in a waiting item, for a story that builds by itself: "Two parts clash". */
export function WaitStopTag({ t }: { t: Ticket }) {
  const kind = stopKind(t);
  return kind ? <StopTag kind={kind} /> : null;
}
