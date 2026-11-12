import fs from 'node:fs';
import path from 'node:path';
import { knownSecrets, localFileSecrets, scrubSecrets } from '../../core/scrub.js';
import { isArabic, plainArabic } from '../../board/ask.js';
import type { BoardPaths } from '../../board/store.js';
import { projectLocalFiles } from '../report.js';
import { leadDir } from './store.js';

/**
 * What the lead learned, kept as notes in squad-kit's own folder for the project on this computer, never in the
 * person's repo. A later question reads them first, before the code or the app, and "How to sign in" also shows next
 * to Open in Your apps. A note never holds a secret: it is scrubbed like the log.
 */

export interface LeadNote {
  /** What it is about: how people sign in, or anything else worth keeping. */
  about: 'sign-in' | 'other';
  text: string;
  /** The question it answered, as asked. */
  question: string;
  /** The conversation it came from. */
  conversation: string;
  at: string;
  /** Where the answer came from: "MA-12", "store.py:12". */
  sources?: string[];
}

/** The most notes kept: the oldest go first, so the notes stay short enough to read before every answer. */
export const MAX_LEAD_NOTES = 40;
/** The longest note. */
const NOTE_CHARS = 1200;

function notesFile(bp: BoardPaths): string {
  return path.join(leadDir(bp), 'notes.json');
}

export function readNotes(bp: BoardPaths): LeadNote[] {
  try {
    const raw = JSON.parse(fs.readFileSync(notesFile(bp), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((n): n is LeadNote => Boolean(n) && typeof (n as LeadNote).text === 'string' && typeof (n as LeadNote).question === 'string') : [];
  } catch {
    return [];
  }
}

/** The text with every secret this computer knows, and anything shaped like one, taken out, as in the log and reports. */
export function scrubbed(bp: BoardPaths, text: string): string {
  const known = [...new Set([...knownSecrets([bp.secretsFile, path.join(bp.squadDir, 'secrets.yaml'), bp.consoleFile]), ...localFileSecrets(projectLocalFiles(bp))])].sort((a, b) => b.length - a.length);
  return scrubSecrets(text, known);
}

/** Keeps a note. A new note about signing in replaces the old one, and the same question keeps only its newest note. */
export function saveNote(bp: BoardPaths, note: Omit<LeadNote, 'at' | 'text'> & { text: string }): LeadNote {
  const clean: LeadNote = { ...note, text: scrubbed(bp, note.text.trim()).slice(0, NOTE_CHARS), at: new Date().toISOString() };
  const same = sameQuestion(note.question);
  const kept = readNotes(bp).filter((n) => !(note.about === 'sign-in' && n.about === 'sign-in') && sameQuestion(n.question) !== same);
  const all = [...kept, clean].slice(-MAX_LEAD_NOTES);
  fs.mkdirSync(leadDir(bp), { recursive: true });
  const file = notesFile(bp);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return clean;
}

/** A question in one form, so the same question asked again finds its note. */
function sameQuestion(text: string): string {
  const s = isArabic(text) ? plainArabic(text) : text.toLowerCase();
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const SIGN_IN_EN = /\b(sign(?:ing)?[\s-]?in|log(?:ging)?[\s-]?in|login|log on|sign on|password|credentials|test account|test user|which user|what (?:should|do) i type|get in(?:to)?|account to use)\b/i;
const SIGN_IN_AR = /(تسجيل الدخول|سجل الدخول|ادخل|الدخول|كلمه المرور|كلمه السر|الحساب|اسم المستخدم)/;

/** The question is about how to sign in to the app. */
export function asksSignIn(text: string): boolean {
  return isArabic(text) ? SIGN_IN_AR.test(plainArabic(text)) : SIGN_IN_EN.test(text);
}

/** The note that answers this question at once: the sign-in note for a sign-in question, or the note of the same question. */
export function noteFor(bp: BoardPaths, question: string): LeadNote | null {
  const newest = readNotes(bp).reverse();
  const same = sameQuestion(question);
  return newest.find((n) => sameQuestion(n.question) === same) ?? (asksSignIn(question) ? (newest.find((n) => n.about === 'sign-in') ?? null) : null);
}

/** "How to sign in", for Your apps: the lead's sign-in note, or nothing yet. */
export function signInNote(bp: BoardPaths): string | undefined {
  return readNotes(bp).reverse().find((n) => n.about === 'sign-in')?.text;
}
