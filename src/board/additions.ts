import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import type { BoardPaths } from './store.js';
import type { AddedResult, Ticket } from './types.js';

/**
 * What a team adds to its harness: rules, checklists and gates. One file, `.squad/harness.yaml`, shared through git like
 * the settings, with one shape whether an addition was typed here or came from a folder. The engine reads it fresh at
 * each step from the project's main folder, never from a story's copy, and no agent can change it. Additions can only
 * make the squad stricter: squad-kit's own gates are not in this file and have no off switch.
 */

export const MAX_RULES = 30;
export const MAX_RULE_CHARS = 2000;
export const MAX_CHECKLIST_QUESTIONS = 20;
/** A name, one question or one command. */
export const MAX_TYPED_CHARS = 500;
/** Who holds the file while it is saved, when that program ended without letting go. */
const LOCK_LEFT_MS = 30_000;
const LOCK_WAIT_MS = 5000;

/** Stands for the file itself when it can't be read, where a person's way past it is remembered. */
export const HARNESS_FILE_GATE = 'harness-file';

export type AdditionState = 'try' | 'on' | 'off';
export type GateWhen = 'checks' | 'merge' | 'release';
export type ChecklistAgent = 'reviewer' | 'tester';

interface AdditionBase {
  id: string;
  name: string;
  state: AdditionState;
  /** "typed", or the name of the folder it came from. */
  from: string;
  added_by: string;
  added_at: string;
}
export interface RuleAddition extends AdditionBase {
  kind: 'rule';
  /** "all", or the agents that follow it. */
  agents: string[];
  text: string;
}
export interface ChecklistAddition extends AdditionBase {
  kind: 'checklist';
  agent: ChecklistAgent;
  questions: string[];
}
export interface GateTried {
  at: string;
  by: string;
  result: 'passed' | 'failed';
  seconds: number;
}
export interface GateAddition extends AdditionBase {
  kind: 'gate';
  when: GateWhen;
  command: string;
  part?: string;
  on_fail: 'stop' | 'warn';
  tried?: GateTried;
}
export type Addition = RuleAddition | ChecklistAddition | GateAddition;
export type NewAddition = Omit<RuleAddition, keyof AdditionBase> | Omit<ChecklistAddition, keyof AdditionBase> | Omit<GateAddition, keyof AdditionBase>;

export interface HarnessLogLine {
  at: string;
  by: string;
  did: 'added' | AdditionState | 'removed' | 'tried';
  id: string;
  name: string;
  kind: Addition['kind'];
  from?: string;
}

export interface HarnessData {
  additions: Addition[];
  log: HarnessLogLine[];
  /** Why the file cannot be read, in plain words. Stories do not go on as if it held nothing (engine/gate-run.ts). */
  broken?: string;
}

/** Kept as read, so what a newer squad-kit or a person wrote in the file stays when it is saved. */
type Doc = Record<string, unknown> & { additions?: Addition[]; log?: HarnessLogLine[] };

export const RULE_AGENTS = ['all', 'analyst', 'architect', 'builder', 'reviewer', 'tester'];
export const NOT_AN_ADDITION = "That is not one of your team's additions. squad-kit's own gates can't be changed or turned off.";
const CANT_READ = "Your team's additions can't be read:";
const FIX_IT = 'An engineer can fix the file.';

export const harnessFile = (bp: BoardPaths): string => path.join(bp.squadDir, 'harness.yaml');

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const isTexts = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(isText);

function complete(a: Record<string, unknown>): boolean {
  if (!isText(a.id) || !isText(a.name) || !['try', 'on', 'off'].includes(a.state as string)) return false;
  if (a.kind === 'rule') return isTexts(a.agents) && isText(a.text);
  if (a.kind === 'checklist') return (a.agent === 'reviewer' || a.agent === 'tester') && isTexts(a.questions);
  return ['checks', 'merge', 'release'].includes(a.when as string) && isText(a.command) && (a.on_fail === 'stop' || a.on_fail === 'warn');
}

const isKnown = (a: Record<string, unknown>): boolean => ['rule', 'checklist', 'gate'].includes(a?.kind as string);

function readDoc(file: string): { doc: Doc; broken?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { doc: {} };
    return { doc: {}, broken: `${CANT_READ} squad-kit could not open .squad/harness.yaml. ${FIX_IT}` };
  }
  return parseDoc(raw);
}

function parseDoc(raw: string): { doc: Doc; broken?: string } {
  if (!raw.trim()) return { doc: {} };
  if (/^(<{7}|>{7}|={7})/m.test(raw)) return { doc: {}, broken: `${CANT_READ} .squad/harness.yaml still has a merge clash in it. ${FIX_IT}` };
  try {
    const doc = (yaml.load(raw) ?? {}) as Doc;
    const fine = typeof doc === 'object' && !Array.isArray(doc) && [doc.additions, doc.log].every((l) => l === undefined || l === null || Array.isArray(l)) && (doc.log ?? []).every((l) => typeof l === 'object' && l !== null);
    if (!fine) throw new Error('not lists');
    return { doc };
  } catch {
    return { doc: {}, broken: `${CANT_READ} .squad/harness.yaml is not written correctly. ${FIX_IT}` };
  }
}

/** The file as it is now. Missing or empty is simply no additions. A kind this version does not know is left alone. */
export function readHarness(bp: BoardPaths): HarnessData {
  const { doc, broken } = readDoc(harnessFile(bp));
  if (broken) return { additions: [], log: [], broken };
  const known = ((doc.additions ?? []) as unknown as Record<string, unknown>[]).filter(isKnown);
  if (!known.every(complete)) return { additions: [], log: [], broken: `${CANT_READ} an addition in .squad/harness.yaml is not complete. ${FIX_IT}` };
  return { additions: known as unknown as Addition[], log: doc.log ?? [] };
}

/** One program at a time saves the file. Its callers are quick, so a short wait here holds nothing up. */
function holdFile<T>(lock: string, fn: () => T): T {
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_LEFT_MS) fs.rmSync(lock, { force: true });
      } catch {
        // It went while we looked.
      }
      if (Date.now() > until) throw new Error('Someone else is saving your additions right now. Try again in a moment.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Reads the file again under the lock, so two people never overwrite each other, then replaces it in one step. */
function changeHarness<T>(bp: BoardPaths, change: (doc: Doc & { additions: Addition[]; log: HarnessLogLine[] }) => T): T {
  const file = harnessFile(bp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return holdFile(`${file}.lock`, () => {
    const { doc, broken } = readDoc(file);
    if (broken) throw new Error(`${broken} Nothing was changed.`);
    doc.additions ??= [];
    doc.log ??= [];
    const out = change(doc as Doc & { additions: Addition[]; log: HarnessLogLine[] });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, yaml.dump(doc, { lineWidth: -1, noRefs: true }));
    fs.renameSync(tmp, file);
    return out;
  });
}

/** Two copies of the file as one. The log says who did what last: what was removed stays removed, and each addition is as its latest change left it. */
function mergedDoc(mine: Doc, theirs: Doc): Doc {
  const lines = [...(mine.log ?? []), ...(theirs.log ?? [])];
  const log = [...new Map(lines.map((l) => [`${l.at}|${l.by}|${l.did}|${l.id}`, l])).values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = new Map(log.map((l) => [l.id, l.did]));
  const latest = (d: Doc, id: string) => (d.log ?? []).filter((l) => l.id === id).map((l) => String(l.at)).sort().pop() ?? '';
  const idOf = (a: Addition) => a.id ?? JSON.stringify(a);
  const all = new Map<string, Addition>();
  for (const a of mine.additions ?? []) all.set(idOf(a), a);
  for (const a of theirs.additions ?? []) if (!all.has(idOf(a)) || latest(theirs, idOf(a)) > latest(mine, idOf(a))) all.set(idOf(a), a);
  return { ...theirs, ...mine, additions: [...all.entries()].filter(([id]) => last.get(id) !== 'removed').map(([, a]) => a), log };
}

/**
 * A copy of the file from the base, put together with this computer's, so neither person loses what the other added.
 * Returns the text the base should hold. A copy that can't be read is never mixed in, and never reaches the base.
 */
export function mergeHarness(bp: BoardPaths, theirs: string): string {
  const file = harnessFile(bp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return holdFile(`${file}.lock`, () => {
    const mine = readDoc(file);
    const other = parseDoc(theirs);
    if (mine.broken) return theirs;
    if (other.broken) return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!Object.keys(mine.doc).length && !Object.keys(other.doc).length) return '';
    const text = yaml.dump(mergedDoc(mine.doc, other.doc), { lineWidth: -1, noRefs: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    }
    return text;
  });
}

const logLine = (a: Addition, by: string, did: HarnessLogLine['did']): HarnessLogLine => ({ at: new Date().toISOString(), by, did, id: a.id, name: a.name, kind: a.kind, ...(a.from !== 'typed' ? { from: a.from } : {}) });

const WORD: Record<Addition['kind'], string> = { rule: 'rule', checklist: 'checklist', gate: 'gate' };

/** Adds one. Rules start on; a checklist or a gate starts on Try first, where it stops nothing. */
export function addAddition(bp: BoardPaths, by: string, input: NewAddition & { name: string }, from = 'typed'): Addition {
  const name = input.name?.trim();
  if (!name) throw new Error('Give it a name.');
  if (name.length > MAX_TYPED_CHARS) throw new Error(`Keep the name under ${MAX_TYPED_CHARS} characters.`);
  let fields: NewAddition;
  if (input.kind === 'rule') {
    const text = input.text?.trim();
    if (!text) throw new Error('Write the rule.');
    if (text.length > MAX_RULE_CHARS) throw new Error(`A rule can be up to ${MAX_RULE_CHARS} characters. This one has ${text.length}.`);
    if (!input.agents?.length || !input.agents.every((a) => RULE_AGENTS.includes(a))) throw new Error('Pick who follows it.');
    fields = { kind: 'rule', agents: input.agents, text };
  } else if (input.kind === 'checklist') {
    const questions = (input.questions ?? []).map((q) => q.trim()).filter(Boolean);
    if (input.agent !== 'reviewer' && input.agent !== 'tester') throw new Error('Pick who answers it.');
    if (!questions.length) throw new Error('Write at least one question.');
    if (questions.length > MAX_CHECKLIST_QUESTIONS) throw new Error(`A checklist can have up to ${MAX_CHECKLIST_QUESTIONS} questions. This one has ${questions.length}.`);
    if (questions.some((q) => q.length > MAX_TYPED_CHARS)) throw new Error(`Keep each question under ${MAX_TYPED_CHARS} characters.`);
    fields = { kind: 'checklist', agent: input.agent, questions };
  } else if (input.kind === 'gate') {
    const command = input.command?.trim();
    if (!command || /[\r\n]/.test(command)) throw new Error('Write one command, on one line.');
    if (command.length > MAX_TYPED_CHARS) throw new Error(`Keep the command under ${MAX_TYPED_CHARS} characters.`);
    if (!['checks', 'merge', 'release'].includes(input.when)) throw new Error('Pick when it runs.');
    if (input.on_fail !== 'stop' && input.on_fail !== 'warn') throw new Error('Pick what happens if it fails.');
    fields = { kind: 'gate', when: input.when, command, on_fail: input.on_fail, ...(input.part ? { part: input.part } : {}), ...(input.tried ? { tried: input.tried } : {}) };
  } else {
    throw new Error('Pick a rule, a checklist or a gate.');
  }
  return changeHarness(bp, (doc) => {
    if (doc.additions.some((a) => a.kind === fields.kind && a.name?.trim().toLowerCase() === name.toLowerCase())) throw new Error(`A ${WORD[fields.kind]} named "${name}" is already added.`);
    if (fields.kind === 'rule' && doc.additions.filter((a) => a.kind === 'rule').length >= MAX_RULES) throw new Error(`A project can have up to ${MAX_RULES} rules. Remove one first.`);
    const added = { id: `a-${randomBytes(4).toString('hex')}`, name, state: fields.kind === 'rule' ? 'on' : 'try', from, added_by: by, added_at: new Date().toISOString(), ...fields } as Addition;
    doc.additions.push(added);
    doc.log.push(logLine(added, by, 'added'));
    return added;
  });
}

export function setAdditionState(bp: BoardPaths, by: string, id: string, state: AdditionState): Addition {
  if (!['try', 'on', 'off'].includes(state)) throw new Error('Pick Try first, On or Off.');
  return changeHarness(bp, (doc) => {
    const a = doc.additions.find((x) => x.id === id);
    if (!a) throw new Error(NOT_AN_ADDITION);
    if (a.kind === 'rule' && state === 'try') throw new Error('A rule is on or off. It has no Try first.');
    if (a.kind === 'gate' && state === 'on') {
      if (!a.tried) throw new Error('Press Try it now first, so a broken gate cannot stop every story.');
      if (a.tried.result === 'failed' && a.on_fail === 'stop') throw new Error("It fails on today's code, so it can't must-pass yet. Fix the code and press Try it now again, or leave it on Try first.");
    }
    if (a.state !== state) {
      a.state = state;
      doc.log.push(logLine(a, by, state));
    }
    return a;
  });
}

/** Removed from the list, and still on the record in the log. */
export function removeAddition(bp: BoardPaths, by: string, id: string): void {
  changeHarness(bp, (doc) => {
    const a = doc.additions.find((x) => x.id === id);
    if (!a) throw new Error(NOT_AN_ADDITION);
    doc.additions = doc.additions.filter((x) => x !== a);
    doc.log.push(logLine(a, by, 'removed'));
  });
}

export function setGateTried(bp: BoardPaths, by: string, id: string, tried: GateTried): void {
  changeHarness(bp, (doc) => {
    const a = doc.additions.find((x) => x.id === id);
    if (a?.kind !== 'gate') throw new Error(NOT_AN_ADDITION);
    a.tried = tried;
    doc.log.push(logLine(a, by, 'tried'));
  });
}

/** Asks for what squad-kit does itself. The guard is what really stops it: this only says so when the rule is saved. */
export function ruleNote(text: string): string | undefined {
  return /\b(commit|push|pull request|merge request|gh pr|open (a|your own) pr)\b/i.test(text) ? 'This rule mentions a commit, a push or a pull request. squad-kit does those itself, so agents are told to leave that part out.' : undefined;
}

/** The rules one agent follows, as a section sent after its core prompts. Off means not sent. */
export function rulesFor(bp: BoardPaths, role: string): string {
  const rules = readHarness(bp).additions.filter((a): a is RuleAddition => a.kind === 'rule' && a.state === 'on' && (a.agents.includes('all') || a.agents.includes(role)));
  if (!rules.length) return '';
  return `Your team added these rules. They can only add care. squad-kit's process comes first: where one asks you to skip a step, commit, push or open a pull request, leave that part out.\n${rules.map((r) => `- ${r.name}: ${r.text}`).join('\n')}`;
}

/** The lists one agent answers in this step. */
export function checklistsFor(bp: BoardPaths, agent: ChecklistAgent): ChecklistAddition[] {
  return readHarness(bp).additions.filter((a): a is ChecklistAddition => a.kind === 'checklist' && a.agent === agent && a.state !== 'off');
}

/** The questions, numbered over all the lists, for the agent's prompt. */
export function checklistAsk(lists: ChecklistAddition[]): string {
  if (!lists.length) return '';
  let n = 0;
  const rows = lists.flatMap((l) => l.questions.map((q) => `${(n += 1)}. ${q}`));
  return `\n\nYour team's checklist. Answer every question, in "checklist": its number, "yes" or "no", and one short line why.\n${rows.join('\n')}`;
}

export interface ListNo {
  list: string;
  question: string;
  why?: string;
}

/**
 * The answers on the story, and the noes that count: only those of a list that is on now, whatever it was when the agent
 * started. A list turned off meanwhile says nothing. An answer an agent left out stays as it was, or not answered.
 */
export function answerLists(bp: BoardPaths, t: Ticket, lists: ChecklistAddition[], given: { n?: unknown; answer?: unknown; why?: unknown }[] | undefined): ListNo[] {
  const now = readHarness(bp).additions;
  const at = new Date().toISOString();
  const noes: ListNo[] = [];
  let n = 0;
  for (const l of lists) {
    const answers = l.questions.map((question) => {
      n += 1;
      const said = given?.find((g) => Number(g.n) === n);
      const answer = said?.answer === 'yes' || said?.answer === 'no' ? (said.answer as 'yes' | 'no') : undefined;
      const had = t.added?.find((r) => r.id === l.id)?.answers?.find((a) => a.question === question);
      return answer ? { question, answer, ...(isText(said?.why) ? { why: said.why.trim().slice(0, 600) } : {}) } : (had ?? { question });
    });
    const fresh = now.find((a) => a.id === l.id);
    if (!fresh || fresh.state === 'off') continue;
    const counted = fresh.state === 'on' ? answers.filter((a) => a.answer === 'no') : [];
    noes.push(...counted.map((a) => ({ list: l.name, question: a.question, ...(a.why ? { why: a.why } : {}) })));
    noteAdded(t, { id: l.id, name: l.name, kind: 'checklist', state: fresh.state === 'on' ? 'on' : 'try', at, agent: l.agent, answers, ...(counted.length ? { stopped: at } : {}) });
  }
  return noes;
}

/** The latest result of one addition on a story. Once it stopped the story it stays counted as having done so. */
export function noteAdded(t: Ticket, r: AddedResult): void {
  const had = t.added?.find((x) => x.id === r.id);
  const stopped = had?.stopped ?? r.stopped;
  t.added = [...(t.added ?? []).filter((x) => x.id !== r.id), { ...r, ...(stopped ? { stopped } : {}) }];
}
