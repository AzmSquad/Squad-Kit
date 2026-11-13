import kleur from 'kleur';
import { select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import type { UploadedFile } from '../board/actions.js';
import { requireTicket, type BoardPaths } from '../board/store.js';
import type { SplitSuggestion } from '../board/types.js';
import { andWords } from '../board/requirements.js';
import { chatToRequirements, createParts, decideSplit, partsFromDraft, sendToRequirements } from '../board/split.js';
import type { TicketDraft } from '../engine/draft.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const grey = (s: string) => kleur.gray(s);

/** S, M and L in the words the board shows. */
const SIZE_WORDS = { S: 'About a day', M: 'A few days', L: 'A week or more' } as const;

/** A suggestion as the terminal prints it: the parts in build order with their size and needs, or the areas of a whole document. */
export function splitLines(s: SplitSuggestion): string[] {
  const lines: string[] = [];
  if (s.why) lines.push(`  ${s.why}`);
  if (s.size === 'brd') {
    const total = (s.areas ?? []).reduce((n, a) => n + a.stories, 0);
    lines.push(`  ${kleur.bold('Too big for one story')}${total ? `: about ${total} stories in ${s.areas!.length} parts` : ''}`);
    for (const a of s.areas ?? []) lines.push(`    ${a.name}  ${grey(`${a.stories} ${a.stories === 1 ? 'story' : 'stories'}`)}`);
  } else {
    lines.push(`  ${kleur.bold(`Split into ${s.parts.length} stories`)}, in the order to build them:`);
    s.parts.forEach((p, i) => lines.push(`    ${i + 1}. ${kleur.bold(p.title)}  ${grey(`${SIZE_WORDS[p.size]}${p.needs.length ? `, needs ${p.needs.join(' and ')}` : ''}`)}${p.line ? `\n       ${p.line}` : ''}`));
  }
  if (s.found.length) lines.push(grey(`  squad-kit's own count: ${s.found.join(', ')}`));
  return lines;
}

/**
 * `squad split <ticket>`: the Analyst's suggestion on a story, and the person's choice, the same buttons as its card:
 * `--yes` splits it, `--keep` keeps it as one, `--change "<note>"` asks for another split, `--requirements` sends a
 * whole document to Requirements. `--chat-requirements` sends the document pasted into its talk, as the hint there does.
 */
export async function runSplit(id: string, opts: { yes?: boolean; keep?: boolean; change?: string; requirements?: boolean; chatRequirements?: boolean }): Promise<void> {
  const bp = board();
  if (opts.chatRequirements) {
    const { breakdown } = chatToRequirements(bp, id);
    ui.success(`Sent the document from ${id.toUpperCase()}'s talk to Requirements as ${breakdown.id}. The Analyst reads it first: squad requirements show ${breakdown.id}`);
    return;
  }
  const choice = opts.yes ? 'split' : opts.keep ? 'keep' : opts.change !== undefined ? 'change' : opts.requirements ? 'requirements' : null;
  if (!choice) {
    const t = requireTicket(bp, id);
    const s = t.split?.suggestion;
    out();
    if (t.waiting?.kind !== 'split' || !s) {
      const d = t.split?.decided;
      out(`  ${kleur.bold(t.id)} has no split waiting for you.${d ? grey(` ${d.choice === 'split' ? `It was split into ${andWords(d.made ?? [])}` : d.choice === 'keep' ? 'It was kept as one story' : `It went to Requirements as ${d.breakdown}`}.`) : ''}`);
      out();
      return;
    }
    out(`  ${kleur.bold(t.id)} ${t.title}`);
    for (const l of splitLines(s)) out(l);
    out();
    if (s.size === 'few') {
      out(`  ${cmd(`squad split ${t.id} --yes`)}  ${grey(`split it: ${t.id} keeps the first one`)}`);
      out(`  ${cmd(`squad split ${t.id} --keep`)}  ${grey('keep it as one story')}`);
      out(`  ${cmd(`squad split ${t.id} --change "<how>"`)}  ${grey('the Analyst splits it again')}`);
    } else {
      out(`  ${cmd(`squad split ${t.id} --requirements`)}  ${grey('send it to Requirements')}`);
      out(`  ${cmd(`squad split ${t.id} --keep`)}  ${grey('keep it as one story')}`);
    }
    out(grey('  Nothing changes until you choose.'));
    out();
    return;
  }
  const t = decideSplit(bp, id, { choice, ...(opts.change !== undefined ? { note: opts.change } : {}) });
  const d = t.split?.decided;
  if (choice === 'split') ui.success(`Split into ${d?.made?.length ?? 0}. ${andWords((d?.made ?? []).slice(1))} wait in Tickets. The Analyst reads ${t.id} again: ${t.title}.`);
  else if (choice === 'keep') ui.success(`Kept ${t.id} as one story. ${t.status}.`);
  else if (choice === 'change') ui.success(`The Analyst writes the split of ${t.id} again with your note.`);
  else ui.success(`Sent ${t.id} to Requirements as ${d?.breakdown}. ${t.id} waits in Tickets: delete it, or start it to build it as one story.`);
}

/** `squad new --from "<text>" --requirements`: straight to Requirements, with no draft, the same as the dialog's REST call. */
export function newToRequirements(bp: BoardPaths, text: string, files: UploadedFile[]): void {
  const b = sendToRequirements(bp, { text, files });
  ui.success(`Sent to Requirements as ${b.id}. The Analyst reads it first: squad requirements show ${b.id}`);
}

/**
 * `squad new --from "<text>"` when the Analyst found more than one story: prints the suggestion and takes the person's
 * choice, the same buttons as the dialog (`--split` or `--one`, or asked here). Returns how to make it as one story, or
 * null when it made the stories, sent it to Requirements, or was cancelled.
 */
export async function chooseDraftSize(bp: BoardPaths, d: TicketDraft, text: string, files: UploadedFile[], opts: { split?: boolean; one?: boolean }): Promise<'kept' | 'brd' | null> {
  const s = d.split!;
  out();
  out(`  ${kleur.bold(s.size === 'brd' ? 'The Analyst read it: this is a whole requirements document, not one story.' : `The Analyst read it: this is ${s.parts.length} stories in one.`)}`);
  for (const l of splitLines(s)) out(l);
  out();
  if (opts.split && s.size !== 'few') throw new Error('This is a whole requirements document, so there is no split: use --requirements, or --one to make it one story anyway.');
  const pick = opts.split
    ? 'split'
    : opts.one
      ? 'one'
      : await select({
          message: s.size === 'brd' ? (files.length ? 'Your text and file go with it.' : 'Your text goes with it.') : 'You check each one before it starts.',
          choices: [
            s.size === 'few' ? { name: `Create ${s.parts.length} stories`, value: 'split' } : { name: 'Send to Requirements', value: 'requirements' },
            { name: s.size === 'brd' ? 'Make one story anyway' : 'Create as one story', value: 'one' },
            { name: 'Cancel', value: 'cancel' },
          ],
        });
  if (pick === 'split') {
    const made = createParts(bp, s, partsFromDraft(d, text, files), { startFirst: true, key: `new:${Date.now()}` });
    ui.success(`Created ${andWords(made.map((t) => t.id))}. ${made[0]!.id} starts now; the others wait in Tickets until you start them.`);
    return null;
  }
  if (pick === 'requirements') {
    newToRequirements(bp, text, files);
    return null;
  }
  if (pick === 'cancel') {
    ui.info('Nothing was created.');
    return null;
  }
  return s.size === 'brd' ? 'brd' : 'kept';
}
