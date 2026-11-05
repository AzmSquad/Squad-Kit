import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BellRing, Check, ChevronDown, ChevronUp, Square } from 'lucide-react';
import { PROJECT, api } from '../api/client';
import type { Quality } from '../api/types';
import type { SetupStepView, SetupView } from '../api/onboard-types';
import { useAct } from '../lib/data';
import { addWish, readWishes, stepTime } from '../lib/overview';
import { Cmd } from './ui';
import { useNotices } from './Waiting';
import { ReportButton } from './Report';

/**
 * The project's first run, as the person follows it: each step with its time and the usual time, a way out of every
 * failure, the Quality question asked once, and "Notify me when it is ready". The setup page shows it in full, the
 * board and the Overview as a card. Terminal: `squad setup`.
 */

/** The setup, live: every second while it runs. */
export function useSetup() {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ setup: SetupView | null }>('/api/v1/setup'),
    refetchInterval: (q) => (q.state.data?.setup && !q.state.data.setup.ready && !q.state.data.setup.approved ? 1000 : 5000),
  });
}

/** Minutes move on while a step runs, so its time stays true. */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function Mark({ state }: { state: SetupStepView['state'] }) {
  return (
    <i className={`ob-mark ${state}`} aria-hidden>
      {state === 'done' ? <Check size={13} strokeWidth={3} /> : state === 'failed' ? '!' : state === 'skipped' ? '–' : state === 'stopped' ? <Square size={8} fill="currentColor" /> : state === 'now' ? <span className="live" /> : null}
    </i>
  );
}

/** One step: what it is, what it found or does now, its time and the usual time, and the ways out when it failed. */
export function SetupStep({ st, now }: { st: SetupStepView; now: number }) {
  const act = useAct();
  const [output, setOutput] = useState(false);
  const time = stepTime(st, now);
  return (
    <li className={`ob-step ${st.state}`}>
      <Mark state={st.state} />
      <span className="ob-st-t">
        <b>{st.label}</b>
        {st.note && <small title={st.note}>{st.note}</small>}
        {st.state === 'now' && (
          <span className="setup-bar" aria-hidden>
            <i />
          </span>
        )}
        {st.error && <span className="ob-err">{st.error}</span>}
        {st.ways.length > 0 && (
          <span className="ob-ways">
            {st.ways.map((w) =>
              w.do === 'again' ? (
                <span key={w.label} className="ob-way">
                  <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/setup/again', body: { step: w.step }, done: w.step === 'read' ? 'The Architect reads the project again' : 'squad-kit tries it again' })}>
                    {w.label}
                  </button>
                  <Cmd text={w.command} />
                </span>
              ) : w.do === 'output' ? (
                <button key={w.label} className="btn sm quiet" onClick={() => setOutput(!output)} aria-expanded={output}>
                  {output ? 'Hide what failed' : w.label}
                </button>
              ) : (
                <Link key={w.label} to="/settings" className="btn sm quiet">
                  {w.label}
                </Link>
              ),
            )}
            {st.state === 'failed' && (st.id === 'read' || st.id === 'tool') && <ReportButton small />}
          </span>
        )}
        {output && st.output && <pre className="ob-out">{st.output}</pre>}
      </span>
      <time className="ob-time">
        {time}
        {(st.state === 'now' || st.state === 'todo') && <small>{st.usual}</small>}
      </time>
    </li>
  );
}

const QUALITY: { id: Quality; name: string; note: string }[] = [
  { id: 'best', name: 'Best', note: "The strongest model builds and reviews. Uses your plan's limits faster." },
  { id: 'balanced', name: 'Balanced', note: 'The strongest model at medium effort.' },
  { id: 'thrifty', name: 'Thrifty', note: 'A lighter model builds. Cheapest.' },
];

/** Asked once, while the setup runs: how strong the squad's models are. Best is the default. Settings changes it later. */
export function QualityAsk({ s }: { s: SetupView }) {
  const act = useAct();
  const [picked, setPicked] = useState<Quality | null>(null);
  if (s.approved) return null;
  const now = picked ?? s.quality;
  return (
    <section className="ob-quality" aria-label="Quality">
      <div className="ob-q-h">
        <b>How strong should the squad be?</b>
        <span className="note">{s.qualityAsked ? 'Saved. Change it any time in Settings.' : 'Asked once. You can change it any time in Settings.'}</span>
      </div>
      <div className="ob-q-opts" role="radiogroup" aria-label="Quality">
        {QUALITY.map((q) => (
          <button
            key={q.id}
            role="radio"
            aria-checked={q.id === now}
            className={`ob-q ${q.id === now ? 'on' : ''}`}
            onClick={() => {
              setPicked(q.id);
              act.mutate({ path: '/api/v1/setup/quality', body: { quality: q.id }, done: `Quality is ${q.name}. The squad uses it from its first step.` });
            }}
          >
            <b>
              {q.name}
              {q.id === 'best' && <small> · the default</small>}
            </b>
            <span>{q.note}</span>
          </button>
        ))}
      </div>
      <Cmd text={`squad config set quality ${now}`} />
    </section>
  );
}

/** One desktop notice when the overview is ready, asked for once in this browser. */
export function NotifyButton({ s }: { s: SetupView }) {
  const n = useNotices();
  const store = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const [asked, setAsked] = useState(() => (PROJECT ? readWishes(store).includes(PROJECT) : false));
  if (s.ready || s.approved || !PROJECT) return null;
  if (asked && n.on) {
    return (
      <span className="pill ok">
        <BellRing size={13} /> We will tell you when it is ready
      </span>
    );
  }
  return (
    <button
      className="btn"
      onClick={async () => {
        if (!n.on) await n.turnOn();
        addWish(store, PROJECT!);
        setAsked(true);
      }}
    >
      <BellRing size={15} /> Notify me when it is ready
    </button>
  );
}

/** The steps, in order. */
export function SetupSteps({ s }: { s: SetupView }) {
  const now = useTick();
  return (
    <ol className="ob-steps">
      {s.steps.map((st) => (
        <SetupStep key={st.id} st={st} now={now} />
      ))}
    </ol>
  );
}

/** What the Architect read last, for "See what the Architect is reading". */
export function Reads({ s }: { s: SetupView }) {
  const [open, setOpen] = useState(false);
  if (!s.reads.length) return null;
  return (
    <div className="ob-reads">
      <button className="btn sm quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {open ? 'Hide what the Architect read' : 'See what the Architect is reading'}
      </button>
      {open && (
        <ul>
          {s.reads.map((r, i) => (
            <li key={`${i}-${r}`} className="mono">
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The setup on the board and the Overview while it runs: where it is in one line, and the way to the full page. Once
 * every step is over, the way to the Overview to check it.
 */
export function SetupCard() {
  const q = useSetup();
  const s = q.data?.setup;
  const now = useTick();
  if (!s || s.approved) return null;
  if (s.ready) {
    return (
      <div className="ob-card ready">
        <span className="ob-ring">
          <Check size={16} strokeWidth={2.5} />
        </span>
        <span className="grow">
          <b>{s.empty ? 'One question for you' : 'Your project overview is ready'}</b>
          <span>{s.empty ? 'What do you want to build?' : 'squad-kit has read your project. Check what it understood, then start working.'}</span>
        </span>
        <Link to="/overview" className="btn you sm">
          Check it <ArrowRight size={14} />
        </Link>
      </div>
    );
  }
  const cur = s.steps.find((x) => x.id === s.current);
  const n = s.steps.findIndex((x) => x.id === s.current) + 1;
  return (
    <div className={`ob-card ${cur?.state === 'failed' || cur?.state === 'stopped' ? 'stop' : ''}`}>
      <div className="grow">
        <b>Getting to know your project</b>
        <span>
          Step {n} of {s.total}: {cur?.label ?? 'starting'}
          {cur && stepTime(cur, now) ? ` · ${stepTime(cur, now)}` : ''}
        </span>
        {cur?.note && cur.state !== 'todo' && <small title={cur.note}>{cur.note}</small>}
        <span className="ob-dots" aria-hidden>
          {s.steps.map((st) => (
            <i key={st.id} className={st.state} />
          ))}
        </span>
      </div>
      <Link to="/setup" className="btn sm">
        Open the setup <ArrowRight size={14} />
      </Link>
    </div>
  );
}

/** True while the project's setup runs or waits for the person: the board shows the setup card first. */
export function useSetupWaits(): boolean {
  const s = useSetup().data?.setup;
  return Boolean(s && !s.approved);
}

/** The Overview waits for the person: every setup step is over and nobody has checked it yet. */
export function useOverviewWaits(): boolean {
  const s = useSetup().data?.setup;
  return Boolean(s?.ready && !s.approved);
}
