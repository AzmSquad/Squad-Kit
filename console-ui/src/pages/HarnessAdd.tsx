import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check, FileText, FolderOpen, ListChecks, Play, Plus, RefreshCw, Terminal, X } from 'lucide-react';
import { send } from '../api/client';
import type { AdditionState, FolderFind, FolderLook, GateTryAnswer, HarnessAddition, HarnessLogLine, HarnessView } from '../api/types';
import { FolderBrowser, useFolders } from '../components/FolderBrowser';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { ago } from '../components/ui';
import { Result } from './Harness';

/**
 * The Your additions tab: what a team added to its harness, its Try first, On and Off, the record of who did what, and
 * the sheets that add a rule, a checklist, a gate or what a folder holds. Typed words use dir="auto": people type Arabic.
 */

const AGENT_NAME: Record<string, string> = { all: 'All agents', analyst: 'Analyst', architect: 'Architect', builder: 'Builder', reviewer: 'Reviewer', tester: 'Tester' };
const WHEN_NAME = { checks: 'With the checks', merge: 'Before merge', release: 'Before release' } as const;
const WHEN_LINE = { checks: 'with the checks', merge: 'before merge', release: 'before release' } as const;
const DONE = 'It applies from the next step of every story.';
const NO_GUARD = "On this computer it runs without the guard, as your project's own checks do.";
const STATE_NAME: Record<AdditionState, string> = { try: 'Try first', on: 'On', off: 'Off' };
const ASKS_PROCESS = /\b(commit|push|pull request|merge request|gh pr)\b/i;

type Kind = HarnessAddition['kind'];

function kindLine(a: HarnessAddition): string {
  if (a.kind === 'rule') return `Rule, for ${a.agents?.includes('all') ? 'all agents' : `the ${a.agents?.map((x) => AGENT_NAME[x] ?? x).join(' and ')}`}`;
  if (a.kind === 'checklist') return `Checklist, for the ${AGENT_NAME[a.agent ?? 'reviewer']}`;
  return `Gate, ${WHEN_LINE[a.when ?? 'checks']}${a.on_fail === 'warn' ? ', warn only' : ''}`;
}

/** Typed words inside a sentence: Arabic among English keeps its place, and so do the words around it. */
const bidi = (s: string): string => `\u2068${s}\u2069`;

function logWords(l: HarnessLogLine): string {
  const what = `the ${l.kind} "${bidi(l.name)}"`;
  if (l.did === 'added') return `added ${what}${l.from ? `, from the folder ${bidi(l.from)}` : ''}`;
  if (l.did === 'removed') return `removed ${what}`;
  if (l.did === 'tried') return `tried ${what} again`;
  return l.did === 'off' ? `turned off ${what}` : l.did === 'on' ? `turned on ${what}` : `set ${what} to Try first`;
}

const LOG_FIRST = 8;

export function AdditionsTab({ view }: { view: HarnessView }) {
  const [adding, setAdding] = useState(false);
  const [wholeLog, setWholeLog] = useState(false);
  const a = view.additions;
  return (
    <>
      <div className="hn-addhead">
        <div>
          <h2 className="hn-title">What your team added</h2>
          <p className="note">{a.shared ? 'Saved with the project. Your team gets it with your next release.' : 'Saved on this computer. This project keeps its board out of git, so your team does not get it.'} Additions can only make the squad stricter.</p>
        </div>
        <button className="btn pri hn-big" disabled={Boolean(a.broken)} onClick={() => setAdding(true)}><Plus size={16} /> Add to your harness</button>
      </div>
      {a.broken && (
        <div className="hn-box bad" role="alert"><b>{a.broken}</b> Until then, stories stop and ask at each check instead of going on without your team's gates.</div>
      )}
      {!a.broken && (
        <div className="hn-box"><b>Try first</b> lets a new gate or checklist run and tell you what it would have stopped, without stopping anything. Turn it on when you trust it.</div>
      )}
      {a.items.length === 0 && !a.broken && (
        <div className="hn-empty">
          <b>Nothing added yet.</b>
          <p className="note">Your harness is fully working as it is. Add a rule, a checklist or a gate when your team needs one.</p>
          <button className="btn" onClick={() => setAdding(true)}><Plus size={15} /> Add the first one</button>
        </div>
      )}
      {a.items.length > 0 && <div className="hn-card">{a.items.map((x) => <AdditionRow key={x.id} a={x} view={view} />)}</div>}
      <p className="note hn-gap">squad-kit's own gates aren't on this list, because they can't be turned off. <Link className="hn-link" to="/harness" search={{}}>See them on the line.</Link></p>
      {a.log.length > 0 && (
        <>
          <h3 className="hn-sub">Who did what</h3>
          <ul className="hn-log">
            {(wholeLog ? a.log : a.log.slice(0, LOG_FIRST)).map((l, i) => <li key={i}><b>{bidi(l.by)}</b> {logWords(l)} <small>{ago(l.at)}</small></li>)}
          </ul>
          {!wholeLog && a.log.length > LOG_FIRST && <button className="btn sm hn-gap" onClick={() => setWholeLog(true)}>Show all {a.log.length}</button>}
        </>
      )}
      {adding && <AddSheet view={view} close={() => setAdding(false)} />}
    </>
  );
}

function AdditionRow({ a, view }: { a: HarnessAddition; view: HarnessView }) {
  const act = useAct();
  const { toast } = usePrefs();
  const [asking, setAsking] = useState(false);
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<GateTryAnswer | null>(null);
  const set = (state: AdditionState) => act.mutate({ path: `/api/v1/harness/additions/${a.id}/state`, body: { state }, done: state === 'off' ? `${a.name} is off.` : `${a.name} is ${STATE_NAME[state]}. ${DONE}` });
  const tryNow = async () => {
    setTrying(true);
    setTried(null);
    try {
      setTried(await send<GateTryAnswer>('/api/v1/harness/try', 'POST', { id: a.id }));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
    setTrying(false);
  };
  return (
    <article id={`add:${a.id}`} className={`hn-row hn-add ${a.state === 'off' ? 'off' : ''}`}>
      <div className="hn-addtop">
        <div>
          <h3 dir="auto">{a.name}</h3>
          <small>{kindLine(a)}</small>
        </div>
        <div className="hn-seg2" role="group" aria-label={`${a.name}: on or off`}>
          {(a.kind === 'rule' ? (['on', 'off'] as const) : (['try', 'on', 'off'] as const)).map((s) => (
            <button key={s} className={s === a.state ? `s-${s}` : ''} aria-pressed={s === a.state} disabled={act.isPending} onClick={() => s !== a.state && set(s)}>{STATE_NAME[s]}</button>
          ))}
        </div>
      </div>
      {a.text && <p dir="auto" className="hn-said">{a.text}</p>}
      {a.questions && <ol dir="auto" className="hn-qs">{a.questions.map((q) => <li key={q}>{q}</li>)}</ol>}
      {a.command && <code className="term hn-cmd" dir="ltr">{a.command}</code>}
      {a.note && <p className="if">{a.note}</p>}
      {a.kind === 'gate' && !trying && !tried && a.tried && <p className="if">{a.tried.result === 'passed' ? `Passed in ${a.tried.seconds} seconds when tried, ${ago(a.tried.at)}.` : `It fails on today's code, so it can't must-pass yet. Tried ${ago(a.tried.at)}.`}</p>}
      {trying && <TryLine running />}
      {tried && <TryLine answer={tried} />}
      {a.partGone && <p className="if hn-warn">The part it runs in is no longer in the project, so it can't run.</p>}
      {a.kind === 'gate' && !view.additions.guarded && <p className="if hn-warn">{NO_GUARD}</p>}
      {a.seen && <Result s={a.seen} />}
      <p className="hn-from">{a.from === 'typed' ? 'Typed here' : `From the folder ${bidi(a.from)}`}. Added by {bidi(a.added_by)}, {ago(a.added_at)}.</p>
      <div className="hn-acts">
        {a.kind === 'gate' && !view.additions.demo && <button className="btn sm" disabled={trying} onClick={() => void tryNow()}><Play size={13} /> Try it now</button>}
        {asking ? (
          <span className="hn-ask">
            Remove it? It stays on the record.
            <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/harness/additions/${a.id}/remove`, done: `${a.name} is removed.` })}>Yes, remove</button>
            <button className="btn sm" onClick={() => setAsking(false)}>Keep it</button>
          </span>
        ) : (
          <button className="btn sm" onClick={() => setAsking(true)}>Remove</button>
        )}
      </div>
    </article>
  );
}

function TryLine({ running, answer }: { running?: boolean; answer?: GateTryAnswer }) {
  if (running) return <p className="hn-try" aria-live="polite"><RefreshCw size={15} className="spin" /> Running inside the guard, on a clean copy of your code</p>;
  if (!answer) return null;
  const { result, seconds, why, output } = answer;
  return (
    <div aria-live="polite">
      {result === 'passed' && <p className="hn-try ok"><Check size={15} /> Passed in {seconds} seconds</p>}
      {result === 'failed' && <p className="hn-try you">It runs, but it fails on today's code. It can stay on Try first, or be warn only.</p>}
      {result === 'cant-run' && <p className="hn-try bad"><X size={15} /> It can't run, so it can't be saved. {why}</p>}
      {result !== 'passed' && output && <details className="hn-out"><summary>What it printed</summary><pre dir="ltr">{output}</pre></details>}
    </div>
  );
}

/* ── The sheets ───────────────────────────────────────── */

function Sheet({ title, back, close, children, footer }: { title: string; back?: () => void; close: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="hn-veil" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="hn-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            {back && <button className="hn-back" onClick={back}><ArrowLeft size={15} /> Back</button>}
            <h2>{title}</h2>
          </div>
          <button className="iconbtn" aria-label="Close" onClick={close}><X size={18} /></button>
        </header>
        <div className="hn-sheetbody">{children}</div>
        {footer && <footer>{footer}</footer>}
      </aside>
    </div>
  );
}

function Pick<T extends string>({ label, value, options, set }: { label: string; value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="hn-pick" role="group" aria-label={label}>
        {options.map(([v, name]) => <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => set(v)}>{name}</button>)}
      </div>
    </div>
  );
}

type Step = 'pick' | Kind | 'folder';
const STEP_TITLE: Record<Step, string> = { pick: 'Add to your harness', rule: 'Add a rule', checklist: 'Add a checklist', gate: 'Add a gate', folder: 'Bring in from a folder' };

function AddSheet({ view, close }: { view: HarnessView; close: () => void }) {
  const [step, setStep] = useState<Step>('pick');
  const props = { view, close, title: STEP_TITLE[step], back: () => setStep('pick') };
  if (step === 'rule') return <RuleForm {...props} />;
  if (step === 'checklist') return <ChecklistForm {...props} />;
  if (step === 'gate') return <GateForm {...props} />;
  if (step === 'folder') return <FolderForm {...props} />;
  const kinds: [Step, ReactNode, string, string][] = [
    ['rule', <FileText size={20} key="r" />, 'A rule', 'Words one agent or all agents follow.'],
    ['checklist', <ListChecks size={20} key="c" />, 'A checklist', 'Questions the Reviewer or the Tester answers, one by one.'],
    ['gate', <Terminal size={20} key="g" />, 'A gate', 'A command squad-kit runs itself. Must pass, or warn only.'],
    ['folder', <FolderOpen size={20} key="f" />, 'From a folder', "Your team's standard. You see what it holds, and tick what comes in."],
  ];
  return (
    <Sheet title={STEP_TITLE.pick} close={close}>
      <p className="note">Anything you add makes your squad stricter. It can't turn off a locked gate.</p>
      <div className="hn-kinds">
        {kinds.map(([k, icon, name, what]) => (
          <button key={k} onClick={() => setStep(k)}>
            <span>{icon}</span>
            <b>{name}</b>
            <small>{what}</small>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

interface FormProps {
  view: HarnessView;
  close: () => void;
  back: () => void;
  title: string;
}

/** Saves one, says so, and closes. A note from the server comes with the toast. */
function useSave(close: () => void) {
  const { toast } = usePrefs();
  const act = useAct<{ added: { name: string }; note?: string }>();
  return {
    busy: act.isPending,
    save: (body: unknown) => act.mutate({ path: '/api/v1/harness/additions', body }, { onSuccess: (r) => { toast(`${r.added.name} added. ${r.note ?? DONE}`); close(); } }),
  };
}

function RuleForm({ view, close, back, title }: FormProps) {
  const [name, setName] = useState('');
  const [who, setWho] = useState('all');
  const [text, setText] = useState('');
  const { busy, save } = useSave(close);
  const max = view.additions.limits.ruleChars;
  return (
    <Sheet title={title} back={back} close={close} footer={<button className="btn pri" disabled={busy || !name.trim() || !text.trim() || text.length > max} onClick={() => save({ kind: 'rule', name, agents: [who], text })}>Add the rule</button>}>
      <div className="field"><label htmlFor="hn-n">Name</label><input id="hn-n" className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <Pick label="Who follows it" value={who} set={setWho} options={Object.entries(AGENT_NAME)} />
      <div className="field">
        <label htmlFor="hn-t">The rule</label>
        <textarea id="hn-t" className="textarea" dir="auto" value={text} onChange={(e) => setText(e.target.value)} />
        <small className={`hn-n ${text.length > max ? 'over' : ''}`}>{text.length} of {max} characters</small>
      </div>
      {ASKS_PROCESS.test(text) && <p className="hn-box you">This rule mentions a commit, a push or a pull request. squad-kit does those itself, so agents are told to leave that part out.</p>}
      <p className="note">Rules are sent after squad-kit's own words, and can only add care. squad-kit's process comes first.</p>
    </Sheet>
  );
}

function ChecklistForm({ view, close, back, title }: FormProps) {
  const [name, setName] = useState('');
  const [who, setWho] = useState<'reviewer' | 'tester'>('reviewer');
  const [text, setText] = useState('');
  const { busy, save } = useSave(close);
  const questions = text.split('\n').map((q) => q.trim()).filter(Boolean);
  const max = view.additions.limits.questions;
  return (
    <Sheet title={title} back={back} close={close} footer={<button className="btn pri" disabled={busy || !name.trim() || !questions.length || questions.length > max} onClick={() => save({ kind: 'checklist', name, agent: who, questions })}>Add the checklist</button>}>
      <div className="field"><label htmlFor="hn-n">Name</label><input id="hn-n" className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <Pick label="Who answers" value={who} set={setWho} options={[['reviewer', 'Reviewer'], ['tester', 'Tester']]} />
      <div className="field">
        <label htmlFor="hn-q">Questions, one on each line</label>
        <textarea id="hn-q" className="textarea" dir="auto" value={text} onChange={(e) => setText(e.target.value)} />
        <small className={`hn-n ${questions.length > max ? 'over' : ''}`}>{questions.length} of {max} questions</small>
      </div>
      <div className="hn-box">
        <b>If an answer is no.</b> It starts on Try first: the answers show on the story and a no stops nothing. On: {who === 'reviewer' ? 'a no counts as a review finding, and the Builder fixes it.' : 'a no goes the same way as a "done when" not shown.'}
      </div>
    </Sheet>
  );
}

function PartField({ view, part, set }: { view: HarnessView; part: string; set: (p: string) => void }) {
  if (!view.additions.parts.length) return null;
  return <Pick label="Which part it runs in" value={part} set={set} options={view.additions.parts.map((p) => [p.id, p.name] as [string, string])} />;
}

function GateForm({ view, close, back, title }: FormProps) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [when, setWhen] = useState<'checks' | 'merge' | 'release'>('checks');
  const [fail, setFail] = useState<'stop' | 'warn'>('stop');
  const [part, setPart] = useState('');
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<GateTryAnswer | null>(null);
  const [problem, setProblem] = useState('');
  const { busy, save } = useSave(close);
  const parts = view.additions.parts.length > 0;
  const tryNow = async () => {
    setRunning(true);
    setAnswer(null);
    setProblem('');
    try {
      setAnswer(await send<GateTryAnswer>('/api/v1/harness/try', 'POST', { command, ...(part ? { part } : {}) }));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
    setRunning(false);
  };
  const ready = name.trim() && answer && answer.result !== 'cant-run';
  return (
    <Sheet title={title} back={back} close={close} footer={<><button className="btn pri" disabled={busy || !ready} onClick={() => save({ kind: 'gate', name, command, when, on_fail: fail, ...(part ? { part } : {}) })}>Add the gate</button><span className="note">It starts on Try first.</span></>}>
      <p className="note">A command squad-kit runs itself, inside the guard. No agent can change it or talk its way past it.</p>
      <div className="field"><label htmlFor="hn-n">Name</label><input id="hn-n" className="input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="hn-c">Command</label>
        <input id="hn-c" className="input mono" dir="ltr" value={command} onChange={(e) => { setCommand(e.target.value); setAnswer(null); }} />
        <small className="hn-n">No passwords in the command: this file is shared with your team.</small>
      </div>
      <Pick label="When it runs" value={when} set={setWhen} options={Object.entries(WHEN_NAME) as [typeof when, string][]} />
      <Pick label="If it fails" value={fail} set={setFail} options={[['stop', 'Must pass'], ['warn', 'Warn only']]} />
      <PartField view={view} part={part} set={(p) => { setPart(p); setAnswer(null); }} />
      <div className="hn-box">
        <div className="hn-tryrow">
          <span>Try it once first, on your latest code, so a broken gate can't stop every story.</span>
          <button className="btn sm" disabled={running || !command.trim() || (parts && !part)} onClick={() => void tryNow()}><Play size={13} /> Try it now</button>
        </div>
        {running && <TryLine running />}
        {answer && <TryLine answer={answer} />}
        {problem && <p className="hn-try bad" role="alert">{problem}</p>}
      </div>
      {!view.additions.guarded && <p className="note hn-warn">{NO_GUARD}</p>}
    </Sheet>
  );
}

interface FindPick {
  on: boolean;
  agent: string;
  when: 'checks' | 'merge' | 'release';
  part: string;
  answer?: GateTryAnswer;
  running?: boolean;
  problem?: string;
}

function FolderForm({ view, close, back, title }: FormProps) {
  const { at, setAt, listing } = useFolders();
  const { toast } = usePrefs();
  const [look, setLook] = useState<FolderLook | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [picks, setPicks] = useState<Record<string, FindPick>>({});
  const act = useAct<{ added: string[]; left: { name: string; why: string }[] }>();
  const pickOf = (f: FindPick | undefined, kind: Kind): FindPick => f ?? { on: false, agent: kind === 'checklist' ? 'reviewer' : 'all', when: 'checks', part: '' };
  const change = (key: string, kind: Kind, patch: Partial<FindPick>) => setPicks((all) => ({ ...all, [key]: { ...pickOf(all[key], kind), ...patch } }));
  const lookIn = async () => {
    setBusy(true);
    setProblem('');
    try {
      setLook(await send<FolderLook>('/api/v1/harness/folder', 'POST', { path: listing.data?.path ?? at }));
      setPicks({});
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };
  const tryOne = async (f: FolderFind) => {
    const p = pickOf(picks[f.key], f.kind);
    change(f.key, f.kind, { running: true, answer: undefined, problem: '' });
    try {
      const answer = await send<GateTryAnswer>('/api/v1/harness/try', 'POST', { command: f.command, ...(p.part ? { part: p.part } : {}) });
      change(f.key, f.kind, { running: false, answer, on: answer.result !== 'cant-run' });
    } catch (err) {
      change(f.key, f.kind, { running: false, problem: err instanceof Error ? err.message : String(err) });
    }
  };
  if (!look) {
    return (
      <Sheet title={title} back={back} close={close} footer={<button className="btn pri" disabled={busy || !listing.data} onClick={() => void lookIn()}><FolderOpen size={15} /> Look in this folder</button>}>
        <p className="note">Bring in your team's standard. squad-kit shows what it finds, and nothing changes until you add it. Nothing in the folder runs while it looks.</p>
        <FolderBrowser at={at} go={setAt} listing={listing} onError={setProblem} />
        {problem && <p className="hn-try bad" role="alert">{problem}</p>}
      </Sheet>
    );
  }
  const can = look.finds.filter((f) => !f.out && !f.already);
  const words = can.filter((f) => f.kind !== 'gate');
  const commands = can.filter((f) => f.kind === 'gate');
  const already = look.finds.filter((f) => f.already && !f.out);
  const ours = look.finds.filter((f) => f.out);
  const ticked = can.filter((f) => picks[f.key]?.on);
  const add = () =>
    act.mutate(
      { path: '/api/v1/harness/folder/add', body: { path: look.path, picks: ticked.map((f) => { const p = picks[f.key]!; return { key: f.key, agent: p.agent, when: p.when, ...(p.part ? { part: p.part } : {}) }; }) } },
      {
        onSuccess: (r) => {
          toast(`${r.added.length} added from ${look.name}. ${DONE}${r.left.length ? ` Not added: ${r.left.map((l) => `${l.name} (${l.why})`).join(', ')}` : ''}`, r.left.length ? 'err' : undefined);
          close();
        },
      },
    );
  const row = (f: FolderFind) => {
    const p = pickOf(picks[f.key], f.kind);
    const gate = f.kind === 'gate';
    const canTick = !gate || (p.answer && p.answer.result !== 'cant-run');
    return (
      <div className="hn-find" key={f.key}>
        <label>
          <input type="checkbox" checked={p.on} disabled={!canTick} onChange={(e) => change(f.key, f.kind, { on: e.target.checked })} />
          <span>
            <b dir="auto">{f.name}</b>
            <small dir="auto">{f.kind === 'checklist' ? `${f.questions?.length} questions` : f.kind === 'rule' ? 'Rule' : 'Gate'}, from {f.source}</small>
          </span>
        </label>
        {f.text && <p dir="auto" className="hn-said">{f.text}</p>}
        {f.questions && <ol dir="auto" className="hn-qs">{f.questions.map((q) => <li key={q}>{q}</li>)}</ol>}
        {f.command && <code className="term hn-cmd" dir="ltr">{f.command}</code>}
        {f.kind === 'rule' && <select className="select" aria-label="Who follows it" value={p.agent} onChange={(e) => change(f.key, f.kind, { agent: e.target.value })}>{Object.entries(AGENT_NAME).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>}
        {f.kind === 'checklist' && <select className="select" aria-label="Who answers" value={p.agent} onChange={(e) => change(f.key, f.kind, { agent: e.target.value })}><option value="reviewer">Reviewer</option><option value="tester">Tester</option></select>}
        {gate && (
          <>
            <select className="select" aria-label="When it runs" value={p.when} onChange={(e) => change(f.key, f.kind, { when: e.target.value as FindPick['when'] })}>{Object.entries(WHEN_NAME).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
            {view.additions.parts.length > 0 && <select className="select" aria-label="Which part it runs in" value={p.part} onChange={(e) => change(f.key, f.kind, { part: e.target.value, answer: undefined, on: false })}><option value="">Which part?</option>{view.additions.parts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
            <div className="hn-tryrow">
              <span className="note">Each command needs its own try before it can be ticked.</span>
              <button className="btn sm" disabled={p.running || (view.additions.parts.length > 0 && !p.part)} onClick={() => void tryOne(f)}><Play size={13} /> Try it now</button>
            </div>
            {p.running && <TryLine running />}
            {p.answer && <TryLine answer={p.answer} />}
            {p.problem && <p className="hn-try bad" role="alert">{p.problem}</p>}
          </>
        )}
      </div>
    );
  };
  return (
    <Sheet
      title={title}
      back={() => setLook(null)}
      close={close}
      footer={<><button className="btn pri" disabled={!ticked.length || act.isPending} onClick={add}>Add {ticked.length} to your harness</button><span className="note">You can turn each one off later.</span></>}
    >
      <p className="note" dir="auto">What {look.name} holds. {look.left > 0 ? `Left out: ${look.left} too big, not text, keys or links leading out.` : ''} {look.more ? 'It holds more files than squad-kit looks at.' : ''}</p>
      {!look.finds.length && <div className="hn-empty"><b>Nothing to bring in here.</b><p className="note">squad-kit looks for rule files, checkbox lists, a scripts/check and package scripts.</p></div>}
      {words.length > 0 && <><h3 className="hn-sub">Rules and checklists</h3>{words.map(row)}</>}
      {commands.length > 0 && <><h3 className="hn-sub">Commands</h3>{commands.map(row)}</>}
      {already.length > 0 && <><h3 className="hn-sub">Already added</h3>{already.map((f) => <div className="hn-find out" key={f.key}><b dir="auto">{f.name}</b><small>Already added</small></div>)}</>}
      {ours.length > 0 && (
        <>
          <h3 className="hn-sub">squad-kit already does these</h3>
          <p className="note">Adding them would make two processes fight, so they stay out.</p>
          {ours.map((f) => <div className="hn-find out" key={f.key}><b dir="auto">{f.name}</b><small>{f.out}</small></div>)}
        </>
      )}
    </Sheet>
  );
}
