import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { requireTicket } from '../board/store.js';
import { pullRequestView, type PullRequestView } from '../engine/contribution/view.js';
import { fixThese, leaveClosed, leaveNotes } from '../engine/contribution/actions.js';
import { bringCopyUpToDate, contributeChecklist, ideaPage, makeMyCopy, type Checklist } from '../engine/contribution/checklist.js';
import { placeOf } from '../engine/contribution/words.js';
import { board } from './board.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const grey = (s: string) => kleur.gray(s);

const NOTE_STATE = { new: kleur.yellow('waits for you'), fixing: kleur.cyan('the Builder is fixing it'), fixed: kleur.green('fixed'), left: grey('you answer it') } as const;

/** Words from the code host, made safe to print: no terminal control characters, one line. */
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A story's pull request as the terminal prints it: what the board shows. */
function pullRequestLines(v: PullRequestView): string[] {
  if (!v.pr) return [`  ${v.line}`];
  const lines = [`  Pull request ${v.pr.id}${v.into ? ` in ${v.into}, into ${v.base}` : ''}  ${grey(clean(v.pr.url))}`, `  ${kleur.bold(v.line)}`];
  for (const n of v.notes) {
    lines.push(`   - ${clean(placeOf(n))}, ${clean(n.who)}${n.pr !== v.pr.id ? grey(` (pull request ${n.pr})`) : ''}: ${clean(n.text).slice(0, 160)}`);
    lines.push(`     ${NOTE_STATE[n.state]}${n.fixedIn ? grey(` in ${n.fixedIn}${n.answered ? ', answered' : ''}`) : ''}${n.why ? grey(` ${n.why}`) : ''}`);
  }
  for (const a of v.actions) lines.push(`  ${a.name}: ${kleur.green(a.command)}`);
  return lines;
}

/** `squad pr <story>`: its pull request; `--fix` (Fix these), `--leave` (Answer them yourself), `--leave-closed`. */
export async function runPr(id: string, opts: { fix?: boolean; leave?: boolean; leaveClosed?: boolean }): Promise<void> {
  const bp = board();
  if (opts.fix) {
    fixThese(bp, id);
    ui.success("The Builder fixes the owner's notes. Then the checks, the review and your Looks right run as usual, and the fix goes to the same pull request.");
    return;
  }
  if (opts.leave) {
    leaveNotes(bp, id);
    ui.success('You answer the notes on the pull request yourself. squad-kit waits for the owner again.');
    return;
  }
  if (opts.leaveClosed) {
    leaveClosed(bp, id);
    ui.success('Left it closed. The work stays on the story\'s branch.');
    return;
  }
  const t = requireTicket(bp, id);
  out();
  out(`  ${kleur.bold(t.id)} ${t.title}`);
  for (const l of pullRequestLines(pullRequestView(t))) out(l);
  out();
}

const MARK = { done: kleur.green('✓'), todo: kleur.yellow('•'), blocked: grey('·'), info: grey('i') } as const;

function checklistLines(c: Checklist): string[] {
  const lines = [`  ${kleur.bold(clean(c.line))}`];
  for (const i of c.items) {
    lines.push('', `  ${MARK[i.state]} ${kleur.bold(clean(i.title))}`, `    ${clean(i.line)}`);
    i.steps?.forEach((s, n) => lines.push(`    ${n + 1}. ${clean(s)}`));
    i.points?.forEach((s) => lines.push(`    - ${clean(s)}`));
    if (i.file) lines.push(grey(`    Read: ${i.link ?? i.file}`));
    if (i.action && i.state !== 'done') lines.push(`    ${i.action.name}: ${kleur.green(i.action.command)}`);
  }
  return lines;
}

/**
 * `squad contribute`: the contribution checklist of squad-kit's own code. `--fork` makes your own copy, `--sync`
 * brings it up to date, `--idea "<title>" --text "<words>"` prints the page that tells the maintainers first.
 */
export async function runContribute(opts: { fork?: boolean; sync?: boolean; idea?: string; text?: string }): Promise<void> {
  const bp = board();
  if (opts.idea !== undefined) {
    const { link, cut, rest } = ideaPage(bp, opts.idea, opts.text ?? '');
    ui.info('Open this page, read it, and send it yourself. squad-kit posts nothing in your name:');
    out(`  ${link}`);
    if (cut && rest) {
      ui.warning('Your idea was too long for one link, so the page has its start. Paste the whole idea into the issue before you send it:');
      out(rest);
    }
    return;
  }
  const spin = ui.spinner(opts.fork ? 'Making your own copy…' : opts.sync ? 'Bringing your copy up to date…' : 'Looking at your copy…');
  let c: Checklist;
  let line = '';
  try {
    if (opts.fork) ({ line, checklist: c } = await makeMyCopy(bp));
    else if (opts.sync) ({ line, checklist: c } = await bringCopyUpToDate(bp));
    else c = await contributeChecklist(bp);
  } finally {
    spin.stop();
  }
  if (line) ui.success(line);
  out();
  for (const l of checklistLines(c)) out(l);
  out();
}
