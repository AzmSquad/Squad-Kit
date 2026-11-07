import { useState } from 'react';
import { Check, GitBranch, GitMerge, Hourglass } from 'lucide-react';
import type { DependencyChoice, Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { Cmd, STAGE_NAME } from './ui';

/**
 * Tickets that depend on unmerged work. The design can say "depends on RO-1"; while RO-1 is not merged, the ticket
 * waits before its build with this card and three ways out. Every way is one call and one terminal command.
 */

type Way = DependencyChoice['way'];

/** Merged into main, or released. */
function merged(t: Ticket): boolean {
  return Boolean(t.mergedAt) || t.stage === 'done';
}

/** The tickets this one depends on, as the board has them now. One no longer on the board is left out. */
function useDeps(t: Ticket): Ticket[] {
  const board = useBoard();
  const all = board.data?.ready ? [...board.data.tickets, ...(board.data.archived ?? [])] : [];
  return (t.dependsOn ?? []).map((id) => all.find((x) => x.id === id)).filter((x): x is Ticket => Boolean(x));
}

/** The base branch's name. */
export function useBase(): string {
  const board = useBoard();
  return (board.data?.ready && board.data.meta.git?.base) || 'main';
}

/** Waiting on the card, or because the person chose to wait. */
export function waitsForDependency(t: Ticket): boolean {
  return t.waiting?.kind === 'depends' || (t.dependency?.way === 'wait' && !t.dependency.started && !t.squad && !t.waiting);
}

const COMMAND: Record<Way, string> = { branch: '--on-branch', anyway: '--anyway', wait: '--wait' };

/** "RO-2 needs RO-1, which is not merged yet", with what RO-1 is doing and the three ways out. */
export function DependsCard({ t }: { t: Ticket }) {
  const act = useAct<Ticket>();
  const board = useBoard();
  // The sample board has no code: any ticket there can be built on.
  const live = board.data?.ready ? board.data.meta.engine === 'live' : true;
  const deps = useDeps(t).filter((d) => !merged(d));
  const waiting = t.dependency?.way === 'wait' && !t.waiting;
  const [pick, setPick] = useState<Way | null>(waiting ? null : 'branch');
  const names = deps.map((d) => d.id).join(' and ') || 'it';
  const one = deps.length === 1 ? deps[0] : undefined;
  const noCode = Boolean(live && one && !one.worktree && !one.branch);
  const ways: { way: Way; label: string; note: string; off?: string }[] = [
    {
      way: 'branch',
      label: one ? `Build on ${one.id}'s work` : 'Build on its work',
      note: `The copy starts from ${names}'s work so far. Once ${names} is merged, the newest work comes in and any clash is settled.`,
      off: !one ? 'A copy can start from one ticket only.' : noCode ? `${one.id} has no code yet.` : undefined,
    },
    { way: 'anyway', label: 'Build anyway', note: `From your team's code, without ${names}. This stays on the ticket's record.` },
    { way: 'wait', label: 'Wait', note: `Starts by itself when ${names} ${deps.length > 1 ? 'are' : 'is'} merged.`, off: waiting ? 'This is what it does now.' : undefined },
  ];
  const chosen = ways.find((w) => w.way === pick && !w.off);
  const done: Record<Way, string> = { branch: `Building on ${names}'s work`, anyway: `Building without ${names}`, wait: `It starts by itself once ${names} is merged` };
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">{waiting ? <Hourglass size={15} /> : <GitBranch size={15} />}</span>
          <div>
            <b>{waiting ? `Waits for ${names} to merge` : (t.waiting?.summary ?? `${t.id} needs ${names}, which is not merged yet`)}</b>
            <span>
              {waiting
                ? `It starts by itself once ${names} ${deps.length > 1 ? 'are' : 'is'} merged. You can still build it another way.`
                : `Its design uses work from ${names}, which is not in the code yet. Choose how to build.`}
            </span>
          </div>
        </div>
        <div className="lbl">What it needs</div>
        {deps.map((d) => (
          <div className="trow" key={d.id}>
            <span className="mono">{d.id}</span>
            <b>{d.title}</b>
            <span className="pill wait">{STAGE_NAME[d.stage]} · not merged yet</span>
          </div>
        ))}
        <div className="lbl">How to build {t.id}</div>
        <div className="opts2" style={{ gridTemplateColumns: '1fr' }}>
          {ways.map((w) => (
            <button key={w.way} className={`opt2 ${pick === w.way && !w.off ? 'pick' : ''}`} disabled={Boolean(w.off)} onClick={() => setPick(w.way)}>
              <b>
                {w.label}
                {pick === w.way && !w.off && (
                  <span>
                    <Check size={13} strokeWidth={2.5} /> Your pick
                  </span>
                )}
              </b>
              {w.off ? `${w.note} ${w.off}` : w.note}
            </button>
          ))}
        </div>
      </div>
      <div className="df">
        <button
          className="btn pri"
          disabled={!chosen || act.isPending}
          onClick={() => chosen && act.mutate({ path: `/api/v1/tickets/${t.id}/build`, body: { way: chosen.way }, done: done[chosen.way] })}
        >
          {chosen?.way === 'wait' ? <Hourglass size={15} /> : <GitBranch size={15} />} {chosen ? chosen.label : 'Pick a way'}
        </button>
        <span className="grow" />
        <Cmd text={`squad build ${t.id} ${COMMAND[chosen?.way ?? 'branch']}`} />
      </div>
    </>
  );
}

const WAY_LINE: Record<Way, (on: string) => string> = {
  branch: (on) => `Built on ${on}'s work. The newest work comes in once ${on} is merged.`,
  anyway: (on) => `Built from your team's code without ${on}, as you chose.`,
  wait: (on) => `Waits for ${on} to merge, then starts by itself.`,
};

/** On the plan: what the design depends on, whether it is merged, and how the person chose to build. */
export function DependsLine({ t }: { t: Ticket }) {
  const deps = useDeps(t);
  if (!t.dependsOn?.length) return null;
  const c = t.dependency;
  return (
    <>
      <div className="lbl">Depends on</div>
      <div className="pills">
        {t.dependsOn.map((id) => {
          const d = deps.find((x) => x.id === id);
          const ok = !d || merged(d);
          return (
            <span key={id} className={`pill ${ok ? 'ok' : 'wait'}`} title={d?.title}>
              {ok && <GitMerge size={13} />}
              {id}
              {d ? ` ${d.title}` : ''} · {!d ? 'left the board' : ok ? 'merged' : 'not merged yet'}
            </span>
          );
        })}
      </div>
      {c && (c.way !== 'wait' || !c.started) && (
        <p className="note" style={{ marginTop: 6 }}>
          {WAY_LINE[c.way](c.on.join(' and '))} {c.by} chose this.
        </p>
      )}
    </>
  );
}

/** On the board's card: "Needs RO-1", "Waits for RO-1" or "On RO-1's branch", while RO-1 is not merged. */
export function DependsTag({ t }: { t: Ticket }) {
  const deps = useDeps(t).filter((d) => !merged(d));
  if (!deps.length || t.waiting?.kind === 'depends' || merged(t)) return null;
  const on = deps.map((d) => d.id).join(', ');
  const c = t.dependency;
  const text = c?.way === 'branch' ? `On ${on}'s work` : c?.way === 'wait' && !c.started ? `Waits for ${on}` : c?.way === 'anyway' ? `Without ${on}` : `Needs ${on}`;
  return (
    <span className="prio owner" title={`Depends on ${on}, which is not merged yet`}>
      {text}
    </span>
  );
}

/** "Bring in latest main" on a ticket being built: one call, `squad bring-in`. */
export function BringInButton({ t }: { t: Ticket }) {
  const act = useAct<Ticket>();
  const board = useBoard();
  const sample = board.data?.ready ? board.data.meta.engine !== 'live' : false;
  if (!['implement', 'test', 'review'].includes(t.stage) || merged(t) || t.takenOver || (t.waiting && !['proof', 'stuck'].includes(t.waiting.kind))) return null;
  const running = !t.waiting && (t.live || Boolean(t.squad));
  return (
    <button
      className="btn sm"
      disabled={Boolean(t.baseWanted) || act.isPending}
      title={`squad bring-in ${t.id}`}
      onClick={() =>
        act.mutate({
          path: `/api/v1/tickets/${t.id}/bring-in`,
          done: sample ? 'The sample board has no code, so nothing changed' : running ? 'The newest work comes in when this step ends, before the checks' : 'Bringing in the newest work',
        })
      }
    >
      <GitMerge size={13} /> {t.baseWanted ? 'The newest work comes in after this step' : 'Bring in the newest work'}
    </button>
  );
}
