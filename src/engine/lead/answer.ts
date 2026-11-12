import fs from 'node:fs';
import path from 'node:path';
import { plainArabic } from '../../board/ask.js';
import { listDecisions, listReleases, listTickets, readTicket, type BoardPaths } from '../../board/store.js';
import { isSecretFile } from '../../core/scrub.js';
import { answerProblem } from '../answers.js';
import { makeCard, type CardInput } from './cards.js';
import { MAX_LEAD_CARDS, MAX_LEAD_PICTURES, MAX_LEAD_SOURCES } from './limits.js';
import { NEVER } from './can.js';
import { scrubbed } from './notes.js';
import { proofPictures } from './story.js';
import type { LeadAnswer, LeadCard, LeadEvidence, LeadSource, LeadStep } from './types.js';

/**
 * The lead hands in its answer in a fixed shape, never free text the board must parse: a headline and a short body,
 * the pictures it took or a story's own proof pictures, its sources, its cards and what it learned. squad-kit checks it
 * like every other step's answer and asks once more when it does not fit, or when it offers to do something later
 * instead of giving its card. Then it cleans it: only pictures it really took or the board already shows on a story,
 * sources that exist, and cards it may offer. A card it never offers is refused in its own words.
 */

const STR = { type: 'string' } as const;

const CARD = {
  type: 'object',
  properties: {
    kind: { ...STR, description: 'draft_story, board_action, open_story, send_answer, settings_change or engineer_report' },
    why: STR,
    title: STR,
    ask: STR,
    storyKind: { type: 'string', enum: ['feature', 'bug'] },
    doneWhen: {
      type: 'array',
      maxItems: 8,
      items: { type: 'object', properties: { text: STR, proof: { type: 'string', enum: ['screen', 'api', 'data', 'test'] } }, required: ['text', 'proof'] },
    },
    warnings: { type: 'array', maxItems: 4, items: STR },
    action: STR,
    story: STR,
    minutes: { type: 'integer' },
    app: STR,
    tool: STR,
    tab: { type: 'string', enum: ['proof', 'spec', 'plan', 'questions'] },
    text: STR,
    setting: STR,
    value: STR,
  },
  required: ['kind'],
};

export const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    headline: STR,
    body: STR,
    evidence: {
      type: 'array',
      maxItems: 8,
      items: { type: 'object', properties: { file: STR, caption: STR, story: { ...STR, description: "The story, for one of its own proof pictures; left out for a picture you took" } }, required: ['file', 'caption'] },
    },
    sources: {
      type: 'array',
      maxItems: 16,
      items: { type: 'object', properties: { kind: { type: 'string', enum: ['story', 'decision', 'file', 'release', 'note', 'guide', 'log'] }, ref: STR, label: STR }, required: ['kind', 'ref'] },
    },
    cards: { type: 'array', maxItems: 8, items: CARD },
    learned: { type: 'object', properties: { text: STR, about: { type: 'string', enum: ['sign-in', 'other'] } }, required: ['text', 'about'] },
  },
  required: ['headline', 'body', 'evidence', 'sources', 'cards'],
};

/** The fields a card of each kind needs. A card of a kind squad-kit does not offer is refused later, not here. */
const NEEDS: Record<string, string[]> = {
  draft_story: ['title', 'ask', 'doneWhen'],
  board_action: ['action'],
  open_story: ['story'],
  send_answer: ['story', 'text'],
  settings_change: ['setting', 'value'],
};

/** What is wrong with the answer, in a few words, or null when it fits. */
export function leadAnswerProblem(value: unknown): string | null {
  const shape = answerProblem(LEAD_SCHEMA, value);
  if (shape) return shape;
  const a = value as { headline: string; body: string; cards: CardInput[] };
  if (!a.headline.trim()) return 'headline is empty';
  for (const [i, c] of a.cards.entries()) {
    const missing = (NEEDS[String(c.kind)] ?? []).find((k) => {
      const v = (c as Record<string, unknown>)[k];
      return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
    });
    if (missing) return `cards[${i}].${missing} is missing`;
  }
  return laterOffer(a);
}

/** "Tell me and I'll ...", in English and in Arabic as plainArabic writes it. */
const LATER = /\b(?:tell me|let me know|ask me|say the word|just say)\b[^.!?\n]*\bI(?:'ll| will| can)\b|\bI(?:'ll| will| can)\b[^.!?\n]*\bif you (?:tell|ask) me\b|قل لي|قولي|قلي|اخبرني|خبرني|بلغني|عرفني|اطلب مني|اطلبها مني/i;

/**
 * The answer offers to do something for a story later ("tell me and I'll request them") with no card for that story:
 * the lead acts only through the cards in this answer. Null when it does not.
 */
export function laterOffer(a: { headline: string; body: string; cards: CardInput[] }): string | null {
  const carded = new Set(a.cards.map((c) => (typeof c.story === 'string' ? c.story.trim().toUpperCase() : '')));
  for (const sentence of `${a.headline}\n${a.body}`.split(/(?<=[.!?؟])\s+|\n+/)) {
    if (!LATER.test(plainArabic(sentence))) continue;
    const story = (sentence.match(/\b[A-Z][A-Z0-9]*-\d+\b(?!\.\d)/g) ?? []).find((id) => !carded.has(id));
    if (story) return `the body offers to do something for ${story} later ("tell me and I'll"), but you act only through this answer's cards: give its card now (open_story, or the board_action that fits it), or say what the person can press on the board`;
  }
  return null;
}

export interface Cleaned {
  answer: LeadAnswer;
  refused: string[];
  steps: Omit<LeadStep, 'at'>[];
}

/** A file the lead names, read only and never a secret file: its place in the project, with the line, or null. */
function fileSource(root: string, ref: string): string | null {
  const m = /^(.+?)(?::(\d+)(?:-\d+)?)?$/.exec(ref.trim());
  if (!m) return null;
  const abs = path.resolve(root, m[1]!);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || isSecretFile(rel) || rel.split(path.sep).includes('.git')) return null;
  if (!fs.existsSync(abs)) return null;
  return `${rel.split(path.sep).join('/')}${m[2] ? `:${m[2]}` : ''}`;
}

function sourcesOf(bp: BoardPaths, raw: LeadSource[]): LeadSource[] {
  const decisions = listDecisions(bp);
  const releases = listReleases(bp);
  const out: LeadSource[] = [];
  for (const s of raw) {
    const ref = String(s.ref ?? '').trim();
    if (!ref) continue;
    let found: LeadSource | null = null;
    if (s.kind === 'story') {
      const t = readTicket(bp, ref.toUpperCase());
      found = t ? { kind: 'story', ref: t.id, label: t.title } : null;
    } else if (s.kind === 'decision') {
      const d = decisions.find((x) => x.id.toUpperCase() === ref.toUpperCase());
      found = d ? { kind: 'decision', ref: d.id, label: d.title } : null;
    } else if (s.kind === 'file') {
      const f = fileSource(bp.root, ref);
      found = f ? { kind: 'file', ref: f } : null;
    } else if (s.kind === 'release') {
      const r = releases.find((x) => x.version === ref || `v${x.version}` === ref);
      found = r ? { kind: 'release', ref: r.version } : null;
    } else found = { kind: s.kind, ref: ref.slice(0, 120), ...(s.label ? { label: String(s.label).slice(0, 120) } : {}) };
    if (found && !out.some((o) => o.kind === found!.kind && o.ref === found!.ref)) out.push(found);
    if (out.length >= MAX_LEAD_SOURCES) break;
  }
  return out;
}

/**
 * The story whose proof the board shows this picture on, the one the lead named first: only a picture squad-kit already
 * keeps, never another file. Null when no story's proof has it.
 */
function proofOf(bp: BoardPaths, file: string, named: string): string | null {
  if (!file.endsWith('.png') || !fs.existsSync(path.join(bp.proofDir, file))) return null;
  const first = named ? readTicket(bp, named.toUpperCase()) : null;
  if (first && proofPictures(first).includes(file)) return first.id;
  return listTickets(bp).find((t) => proofPictures(t).includes(file))?.id ?? null;
}

/**
 * The answer as squad-kit keeps it. `taken` is every picture the lead's window took in this answer; any other file is
 * left out, unless it is one of a story's own proof pictures. `prefix` names the cards: "<conversation>.<turn>".
 */
export function cleanAnswer(bp: BoardPaths, raw: unknown, o: { taken: Set<string>; prefix: string; role?: string }): Cleaned {
  const a = raw as { headline: string; body: string; evidence: { file: string; caption: string; story?: string }[]; sources: LeadSource[]; cards: CardInput[]; learned?: { text: string; about: string } };
  const steps: Omit<LeadStep, 'at'>[] = [];
  const refused: string[] = [];
  const evidence: LeadEvidence[] = [];
  for (const e of a.evidence) {
    const file = path.basename(String(e.file ?? ''));
    if (evidence.some((x) => x.file === file)) continue;
    const story = o.taken.has(file) ? null : proofOf(bp, file, String(e.story ?? '').trim());
    if (!o.taken.has(file) && !story) continue;
    evidence.push({ file, caption: scrubbed(bp, String(e.caption ?? '').trim()).slice(0, 240), url: `/api/v1/proof/${encodeURIComponent(file)}`, ...(story ? { story } : {}) });
    if (evidence.length >= MAX_LEAD_PICTURES) break;
  }
  const cards: LeadCard[] = [];
  for (const c of a.cards) {
    if (cards.length >= MAX_LEAD_CARDS) break;
    const made = makeCard(bp, c, `${o.prefix}.${cards.length + 1}`, o.role);
    if ('card' in made) cards.push(made.card);
    else if ('refused' in made) {
      const words = NEVER[made.refused].refusal;
      if (!refused.includes(words)) refused.push(words);
      steps.push({ text: `squad-kit refused a card: ${NEVER[made.refused].name.toLowerCase()}`, kind: 'refused' });
    } else steps.push({ text: `Left out a card: ${made.left}`, kind: 'card' });
  }
  const learned = a.learned?.text?.trim() ? scrubbed(bp, a.learned.text.trim()).slice(0, 1200) : undefined;
  return {
    answer: {
      headline: scrubbed(bp, a.headline.trim()).slice(0, 400),
      body: scrubbed(bp, a.body.trim()).slice(0, 4000),
      evidence,
      sources: sourcesOf(bp, a.sources),
      cards,
      ...(learned ? { learned } : {}),
    },
    refused,
    steps,
  };
}

/** What the lead learned is about signing in. */
export function learnedAbout(raw: unknown): 'sign-in' | 'other' {
  return (raw as { learned?: { about?: string } })?.learned?.about === 'sign-in' ? 'sign-in' : 'other';
}
