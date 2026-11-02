import yaml from 'js-yaml';
import type { Blueprint, BoardMeta, Criterion, Decision, DecisionDraft, Lesson, ProofShot, Question, Release, Step, Ticket, TicketNote } from './types.js';

/**
 * The project's documents as Markdown (ADR-001). squad-kit writes each in a fixed shape and reads it back from that
 * shape, so the Markdown is the truth and a person can also edit it by hand. Only facts squad-kit must read back
 * sit in a short YAML header. Text keeps its line breaks; a one-line value that would break the shape is written in
 * quotes.
 */

/** One-line slot: plain when safe, else a JSON string. */
export function enc(v: string): string {
  return v.includes('\n') || v.startsWith('"') || v !== v.trim() ? JSON.stringify(v) : v;
}

export function dec(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s;
    }
  }
  return s;
}

/** Free text: a line that looks like part of the shape gets a backslash in front. */
const MARKER = /^(\\*)(#|- \[|\d+\. |Answer:|Chosen:|To:|- (Area|Saved as|Replaces|Check with the client|Before|After|Decision|Where):)/;

function escText(text: string): string {
  return text
    .split('\n')
    .map((l) => (MARKER.test(l) ? `\\${l}` : l))
    .join('\n');
}

function unescText(text: string): string {
  return text
    .split('\n')
    .map((l) => (/^\\+/.test(l) && MARKER.test(l.slice(1)) ? l.slice(1) : l))
    .join('\n');
}

function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function withHeader(header: Record<string, unknown>, body: string): string {
  const head = yaml.dump(clean(header), { lineWidth: 110, noRefs: true }).trimEnd();
  return `---\n${head}\n---\n${body.trimEnd()}\n`;
}

export function splitHeader(text: string): { header: Record<string, any>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { header: {}, body: text };
  return { header: (yaml.load(m[1]!) as Record<string, any>) ?? {}, body: m[2] ?? '' };
}

/** The text under each of the given headings (exact heading lines only), in order. */
function sections(body: string, heads: RegExp): { head: string; match: RegExpMatchArray; text: string }[] {
  const lines = body.split('\n');
  const out: { head: string; match: RegExpMatchArray; text: string }[] = [];
  let cur: { head: string; match: RegExpMatchArray; lines: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(heads);
    if (m) {
      if (cur) out.push({ head: cur.head, match: cur.match, text: cur.lines.join('\n') });
      cur = { head: line, match: m, lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ head: cur.head, match: cur.match, text: cur.lines.join('\n') });
  return out;
}

const block = (text: string) => unescText(text.replace(/^\n+/, '').replace(/\s+$/, ''));

/** List items that start with `start` and go on in lines indented by `indent` spaces. */
function items(text: string, start: RegExp, indent = 3): string[][] {
  const out: string[][] = [];
  for (const line of text.split('\n')) {
    const m = line.match(start);
    if (m) out.push([line]);
    else if (out.length && line.startsWith(' '.repeat(indent)) && line.trim()) out[out.length - 1]!.push(line);
  }
  return out;
}

/* ── One ticket's folder ─────────────────────────────────── */

/** The parts of a ticket that live in its folder, and how they split into files. */
export type TicketDocs = Record<string, string>;

const HEADER_KEYS = [
  'id',
  'title',
  'kind',
  'source',
  'priority',
  'stage',
  'owner',
  'handedOver',
  'track',
  'createdAt',
  'createdBy',
  'builder',
  'reviewer',
  'repo',
  'branch',
  'follows',
  'work',
  'gates',
  'specApproved',
  'overrides',
  'outdated',
  'release',
  'foundIn',
  'severity',
  'pr',
  'mergedAt',
  'brief',
  'mockup',
  'files',
] as const;

export interface TicketDocInput extends Partial<Ticket> {
  id: string;
  title: string;
  /** Attached files, as paths inside the ticket's folder. */
  files?: string[];
}

export function ticketDocs(t: TicketDocInput): TicketDocs {
  const header: Record<string, unknown> = {};
  const all = t as unknown as Record<string, unknown>;
  for (const k of HEADER_KEYS) if (all[k] !== undefined) header[k] = all[k];
  const docs: TicketDocs = { 'ticket.md': withHeader(header, `# ${enc(t.title)}\n\n${t.ask ?? ''}`) };
  if (t.story !== undefined || t.criteria || t.releaseNote !== undefined) docs['spec.md'] = specDoc(t);
  if (t.questions?.length) docs['questions.md'] = questionsDoc(t.title, t.questions);
  if (t.decision || t.steps) docs['design.md'] = designDoc(t.title, t.decision, t.steps);
  if (t.notes?.length) docs['notes.md'] = notesDoc(t.title, t.notes);
  if (t.proof) docs['proof.md'] = proofDoc(t.title, t.proof);
  return docs;
}

export function readTicketDocs(docs: TicketDocs): TicketDocInput {
  const { header, body } = splitHeader(docs['ticket.md'] ?? '');
  const t: TicketDocInput = { ...(header as TicketDocInput) };
  t.ask = body.replace(/^# [^\n]*(\n\n?|$)/, '').replace(/\n$/, '');
  if (docs['spec.md']) Object.assign(t, parseSpec(docs['spec.md']));
  if (docs['questions.md']) t.questions = parseQuestions(docs['questions.md']);
  if (docs['design.md']) Object.assign(t, parseDesign(docs['design.md']));
  if (docs['notes.md']) t.notes = parseNotes(docs['notes.md']);
  if (docs['proof.md']) t.proof = parseProof(docs['proof.md']);
  return t;
}

function specDoc(t: TicketDocInput): string {
  const parts = [`# ${enc(t.title)}: spec`];
  if (t.story !== undefined) parts.push(`## Story\n\n${escText(t.story)}`);
  if (t.criteria) parts.push(`## Done when\n\n${t.criteria.map((c, i) => `${i + 1}. **Given** ${enc(c.given)}, **when** ${enc(c.when)}, **then** ${enc(c.then)}`).join('\n')}`);
  if (t.releaseNote !== undefined) parts.push(`## Release note\n\n${escText(t.releaseNote)}`);
  return `${parts.join('\n\n')}\n`;
}

function parseSpec(text: string): Pick<Ticket, 'story' | 'criteria' | 'releaseNote'> {
  const out: Pick<Ticket, 'story' | 'criteria' | 'releaseNote'> = {};
  for (const s of sections(text, /^## (Story|Done when|Release note)$/)) {
    if (s.match[1] === 'Story') out.story = block(s.text);
    if (s.match[1] === 'Release note') out.releaseNote = block(s.text);
    if (s.match[1] === 'Done when') {
      out.criteria = items(s.text, /^\d+\. /).map((lines): Criterion => {
        const line = lines.map((l, i) => (i ? l.slice(3) : l.replace(/^\d+\. /, ''))).join('\n');
        const m = line.match(/^\*\*Given\*\* ([\s\S]*?), \*\*when\*\* ([\s\S]*?), \*\*then\*\* ([\s\S]*)$/);
        return m ? { given: dec(m[1]!), when: dec(m[2]!), then: dec(m[3]!) } : { given: '', when: '', then: line };
      });
    }
  }
  return out;
}

function questionsDoc(title: string, qs: Question[]): string {
  const parts = [`# ${enc(title)}: questions`];
  for (const q of qs) {
    const lines = [`### ${q.id}, from the ${q.from}`, escText(q.text), ''];
    for (const o of q.options) lines.push(`- [${q.answer?.choice === o ? 'x' : ' '}] ${enc(o)}${o === q.inputOption ? ' <!-- takes a typed answer -->' : ''}`);
    if (q.inputOption !== undefined && !q.options.includes(q.inputOption)) lines.push(`- [ ] ${enc(q.inputOption)} <!-- typed answer only -->`);
    if (q.answer && !q.options.includes(q.answer.choice)) lines.push('', `Chosen: ${enc(q.answer.choice)}`);
    if (q.answer?.value !== undefined) lines.push('', `Answer: ${enc(q.answer.value)}`);
    parts.push(lines.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

function parseQuestions(text: string): Question[] {
  return sections(text, /^### ([\w.-]+), from the (analyst|architect)$/).map((s) => {
    const q: Question = { id: s.match[1]!, from: s.match[2] as Question['from'], text: '', options: [] };
    const textLines: string[] = [];
    let chosen: string | undefined;
    let value: string | undefined;
    let optionsStarted = false;
    for (const line of s.text.split('\n')) {
      const opt = line.match(/^- \[( |x)\] (.*?)( <!-- (takes a typed answer|typed answer only) -->)?$/);
      if (opt) {
        optionsStarted = true;
        const o = dec(opt[2]!);
        if (opt[4] === 'typed answer only') {
          q.inputOption = o;
          continue;
        }
        q.options.push(o);
        if (opt[4]) q.inputOption = o;
        if (opt[1] === 'x') chosen = o;
      } else if (line.startsWith('Chosen: ')) chosen = dec(line.slice(8));
      else if (line.startsWith('Answer: ')) value = dec(line.slice(8));
      else if (!optionsStarted) textLines.push(line);
    }
    q.text = block(textLines.join('\n'));
    if (chosen !== undefined) q.answer = { choice: chosen, ...(value !== undefined ? { value } : {}) };
    return q;
  });
}

function designDoc(title: string, d: DecisionDraft | undefined, steps: Step[] | undefined): string {
  const parts = [`# ${enc(title)}: design`];
  if (d) {
    const facts = [
      ...(d.area !== undefined ? [`- Area: ${enc(d.area)}`] : []),
      ...(d.adr !== undefined ? [`- Saved as: ${enc(d.adr)}`] : []),
      ...(d.replaces !== undefined ? [`- Replaces: ${enc(d.replaces)}`] : []),
      ...(d.clientCheck !== undefined ? [`- Check with the client: ${enc(d.clientCheck)}`] : []),
    ];
    const options = d.options.map((o) => [`- [${o.chosen ? 'x' : ' '}] ${enc(o.name)}`, ...(o.note ? [`  ${enc(o.note)}`] : [])].join('\n'));
    parts.push([`## Decision: ${enc(d.title)}`, ...(facts.length ? ['', ...facts] : [])].join('\n'), `### Options\n\n${options.join('\n')}`, `### Why\n\n${escText(d.why)}`);
  }
  if (steps) parts.push(`## Steps\n\n${steps.map((s, i) => `${i + 1}. ${enc(s.title)}`).join('\n')}`);
  return `${parts.join('\n\n')}\n`;
}

function parseDesign(text: string): Pick<Ticket, 'decision' | 'steps'> {
  const out: Pick<Ticket, 'decision' | 'steps'> = {};
  for (const s of sections(text, /^(## Decision: (.*)|### Options|### Why|## Steps)$/)) {
    if (s.match[2] !== undefined) {
      const d: DecisionDraft = { title: dec(s.match[2]), options: [], why: '' };
      for (const line of s.text.split('\n')) {
        const f = line.match(/^- (Area|Saved as|Replaces|Check with the client): ?(.*)$/);
        if (!f) continue;
        const v = dec(f[2]!);
        if (f[1] === 'Area') d.area = v as DecisionDraft['area'];
        if (f[1] === 'Saved as') d.adr = v;
        if (f[1] === 'Replaces') d.replaces = v;
        if (f[1] === 'Check with the client') d.clientCheck = v;
      }
      out.decision = d;
    } else if (s.head === '### Options' && out.decision) {
      out.decision.options = items(s.text, /^- \[( |x)\] /, 2).map((lines) => ({
        name: dec(lines[0]!.slice(6)),
        note: lines[1] ? dec(lines[1].slice(2)) : '',
        ...(lines[0]![3] === 'x' ? { chosen: true } : {}),
      }));
    } else if (s.head === '### Why' && out.decision) {
      out.decision.why = block(s.text);
    } else if (s.head === '## Steps') {
      out.steps = items(s.text, /^\d+\. /).map((lines): Step => ({ title: dec(lines[0]!.replace(/^\d+\. /, '')), status: 'todo' }));
    }
  }
  return out;
}

function notesDoc(title: string, notes: TicketNote[]): string {
  return `${[`# ${enc(title)}: notes`, ...notes.map((n) => [`### ${n.kind}, by ${enc(n.by)}, ${n.at}`, ...(n.to ? [`To: ${n.to}`] : []), escText(n.text)].join('\n'))].join('\n\n')}\n`;
}

function parseNotes(text: string): TicketNote[] {
  return sections(text, /^### (note|criterion|rule), by (.*), (\S+)$/).map((s) => {
    const lines = s.text.split('\n');
    const to = lines[0]?.match(/^To: (\w+)$/)?.[1];
    return {
      kind: s.match[1] as TicketNote['kind'],
      by: dec(s.match[2]!),
      at: s.match[3]!,
      ...(to ? { to: to as TicketNote['to'] } : {}),
      text: block((to ? lines.slice(1) : lines).join('\n')),
    };
  });
}

function proofDoc(title: string, shots: ProofShot[]): string {
  return `${[
    `# ${enc(title)}: proof`,
    ...shots.map((p) =>
      [`### ${enc(p.criterion)}`, '', `- Before: ${enc(p.before)} (${enc(p.beforeLabel)})`, `- After: ${enc(p.after)} (${enc(p.afterLabel)})`, ...(p.note !== undefined ? ['', escText(p.note)] : [])].join('\n'),
    ),
  ].join('\n\n')}\n`;
}

function parseProof(text: string): ProofShot[] {
  return sections(text, /^### (.*)$/).map((s) => {
    const shot: ProofShot = { criterion: dec(s.match[1]!), before: '', after: '', beforeLabel: '', afterLabel: '' };
    const rest: string[] = [];
    for (const line of s.text.split('\n')) {
      const m = line.match(/^- (Before|After): (.*) \((.*)\)$/);
      if (m && m[1] === 'Before') [shot.before, shot.beforeLabel] = [dec(m[2]!), dec(m[3]!)];
      else if (m && m[1] === 'After') [shot.after, shot.afterLabel] = [dec(m[2]!), dec(m[3]!)];
      else rest.push(line);
    }
    const note = block(rest.join('\n'));
    if (note || rest.some((l) => l.trim())) shot.note = note;
    return shot;
  });
}

/* ── Decisions and releases ──────────────────────────────── */

export function decisionDoc(d: Decision): string {
  const { why, options, chosen, title, ...facts } = d;
  return withHeader(
    { ...facts, title },
    [`# ${enc(d.id)}: ${enc(title)}`, `## Chosen\n\n${escText(chosen)}`, `## Options\n\n${options.map((o) => `- ${enc(o)}`).join('\n')}`, `## Why\n\n${escText(why)}`].join('\n\n'),
  );
}

export function parseDecisionDoc(text: string): Decision {
  const { header, body } = splitHeader(text);
  const d = { ...header, why: '', options: [] as string[], chosen: '' } as Decision;
  for (const s of sections(body, /^## (Chosen|Options|Why)$/)) {
    if (s.match[1] === 'Chosen') d.chosen = block(s.text);
    if (s.match[1] === 'Why') d.why = block(s.text);
    if (s.match[1] === 'Options') d.options = items(s.text, /^- /, 2).map((lines) => dec(lines.join('\n').slice(2)));
  }
  return d;
}

/** A release's log stays on the computer that did it: it tells what happened after the release commit. */
export function releaseDoc(r: Release): string {
  const { notes, log: _log, ...facts } = r;
  return withHeader(facts as Record<string, unknown>, `# ${enc(r.version)}\n\n## Notes\n\n${escText(notes)}`);
}

export function parseReleaseDoc(text: string): Release {
  const { header, body } = splitHeader(text);
  const notes = sections(body, /^## Notes$/)[0];
  return { ...(header as Release), notes: notes ? block(notes.text) : '' };
}

/* ── What the project knows ──────────────────────────────── */

/** knowledge/project.md: what the Architect learned about the project, one area at a time. */
export function projectDoc(summary: string | undefined, map: BoardMeta['map']): string {
  const parts = ['# What the project is'];
  if (summary !== undefined) parts.push(`## Summary\n\n${escText(summary)}`);
  parts.push(`## Map\n\n${map.map((m) => `### ${enc(m.area)}\n\n${escText(m.detail)}`).join('\n\n')}`);
  return `${parts.join('\n\n')}\n`;
}

export function parseProjectDoc(text: string): { summary?: string; map: BoardMeta['map'] } {
  const out: { summary?: string; map: BoardMeta['map'] } = { map: [] };
  const summary = sections(text, /^## (Summary|Map)$/).find((s) => s.match[1] === 'Summary');
  if (summary) out.summary = block(summary.text);
  const mapText = text.split(/^## Map$/m)[1] ?? '';
  out.map = sections(mapText, /^### (.*)$/).map((s) => ({ area: dec(s.match[1]!), detail: block(s.text) }));
  return out;
}

/** knowledge/lessons.md */
export function lessonsDoc(lessons: Lesson[]): string {
  return `${['# Lessons', ...lessons.map((l) => `### ${enc(l.id)}, from ${enc(l.from)}, ${l.date}\n\n${escText(l.text)}`)].join('\n\n')}\n`;
}

export function parseLessonsDoc(text: string): Lesson[] {
  return sections(text, /^### (.*), from (.*), (\S+)$/).map((s) => ({ id: dec(s.match[1]!), from: dec(s.match[2]!), date: s.match[3]!, text: block(s.text) }));
}

/** knowledge/stack.md: the technologies the code uses and the patterns it follows, with the decisions behind them. */
export function stackDoc(b: Pick<Blueprint, 'stack' | 'patterns'>): string {
  const stack = b.stack.map((n) => [`### ${enc(n.name)}`, '', ...(n.decision !== undefined ? [`- Decision: ${enc(n.decision)}`, ''] : []), escText(n.why)].join('\n'));
  const patterns = b.patterns.map((p) =>
    [`### ${enc(p.name)}`, '', ...(p.decision !== undefined ? [`- Decision: ${enc(p.decision)}`] : []), `- Where: ${p.where.map(enc).join(' | ')}`, '', escText(p.what)].join('\n'),
  );
  return `${['# Stack and patterns', `## Stack\n\n${stack.join('\n\n')}`, `## Patterns\n\n${patterns.join('\n\n')}`].join('\n\n')}\n`;
}

export function parseStackDoc(text: string): Pick<Blueprint, 'stack' | 'patterns'> {
  const [, stackText = '', patternText = ''] = text.split(/^## (?:Stack|Patterns)$/m);
  const facts = (body: string) => {
    const lines = body.split('\n');
    const decision = lines.find((l) => l.startsWith('- Decision: '));
    const where = lines.find((l) => l.startsWith('- Where: '));
    const rest = lines.filter((l) => !l.startsWith('- Decision: ') && !l.startsWith('- Where: '));
    return { decision: decision ? dec(decision.slice(12)) : undefined, where: where ? where.slice(9).split(' | ').filter(Boolean).map(dec) : [], text: block(rest.join('\n')) };
  };
  return {
    stack: sections(stackText, /^### (.*)$/).map((s) => {
      const f = facts(s.text);
      return { name: dec(s.match[1]!), why: f.text, ...(f.decision !== undefined ? { decision: f.decision } : {}) };
    }),
    patterns: sections(patternText, /^### (.*)$/).map((s) => {
      const f = facts(s.text);
      return { name: dec(s.match[1]!), what: f.text, where: f.where, ...(f.decision !== undefined ? { decision: f.decision } : {}) };
    }),
  };
}
