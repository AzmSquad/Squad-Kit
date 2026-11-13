import {
  addActivity,
  draftRelease,
  latestRelease,
  listTickets,
  now,
  readMeta,
  readRelease,
  updateTicket,
  writeRelease,
  removeRelease,
  listReleases,
  type BoardPaths,
  readTicket,
} from '../store.js';
import fs from 'node:fs';
import path from 'node:path';
import { NO_NEW_TESTS_LABEL, type Release, type Ticket, type UnpushedRelease } from '../types.js';
import { plainWords } from '../../core/for-people.js';
import {
  PullRequestClash,
  basesNow,
  liveRelease,
  onTheRemote,
  pushAgain,
  versionOnRemote,
} from '../../engine/release.js';
import { git } from '../../engine/git.js';
import { holdRelease, releaseGoingOut, takingOutDone } from '../lock.js';
import { repoFor, reposOf } from '../../engine/repos.js';
import { alsoChangedLine } from '../also-changed.js';
import { firstCodeMerged } from '../first-story.js';
import { afterRelease, settleRelease } from '../release-tidy.js';
import { clearJournal, readJournal } from '../../engine/release-resume.js';
import { copyViews } from '../../engine/copies.js';
import { noteGates, releaseGatesDue, runReleaseGates } from '../../engine/gate-run.js';
import { SELF_NO_RELEASE, isSelfProject } from '../../engine/self-project.js';
import { BoardActionError, tellLater } from './errors.js';
import { pullRequestClashed } from './save.js';

function bump(version: string, part: 'minor' | 'patch'): string {
  const [maj = 0, min = 0, pat = 0] = version.replace(/^v/, '').split('.').map(Number);
  return part === 'minor' ? `v${maj}.${min + 1}.0` : `v${maj}.${min}.${pat + 1}`;
}

export function ensureDraftRelease(bp: BoardPaths, part: 'minor' | 'patch'): Release {
  // The release going out takes no more tickets: what is accepted meanwhile goes into the one after it.
  const going = releaseGoingOut(bp);
  const draft = listReleases(bp).find((r) => r.status === 'draft' && r.version !== going);
  if (draft) return draft;
  const meta = readMeta(bp);
  const live = meta.engine === 'live';
  const last = latestRelease(bp);
  // The first release on a live board continues the project's own version, not 0.0.0.
  const done = last?.version ?? (live ? projectVersion(bp.root, meta) : 'v0.0.0');
  const from = going ? newer(going, done) : done;
  // A file that cannot be read holds its version, and is never written over.
  let version = bump(from, part);
  while (fs.existsSync(path.join(bp.releasesDir, `${version}.md`))) version = bump(version, part);
  const release: Release = {
    version,
    status: 'draft',
    from,
    tickets: [],
    notes: '',
    addons: {
      changelog: true,
      tag: true,
      pipeline: live ? reposOf(meta).some((r) => r.commands.deploy) || Boolean(meta.commands?.deploy) : true,
      whatsapp: true,
    },
  };
  writeRelease(bp, release);
  return release;
}

function versionKey(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
}

function newer(a: string, b: string): string {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? a : b;
  return a;
}

/** The highest version a project already has: a git tag like v2.3.1, or package.json. */
function projectVersion(root: string, meta: ReturnType<typeof readMeta>): string {
  let best = 'v0.0.0';
  for (const repo of reposOf(meta)) {
    const dir = path.join(root, repo.path);
    for (const tag of git(dir, ['tag', '--list', 'v*'], { allowFail: true }).split('\n')) {
      if (/^v\d+\.\d+\.\d+$/.test(tag.trim())) best = newer(best, tag.trim());
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const v = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string }).version;
        if (v && /^\d+\.\d+\.\d+/.test(v)) best = newer(best, `v${v.split('-')[0]}`);
      } catch {
        // A broken package.json says nothing about the version.
      }
    }
  }
  return best;
}

/** Release notes written from the tickets inside, in plain words. */
export function composeNotes(bp: BoardPaths, release: Release): string {
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  const lines = tickets.map((t) => `- ${[t.releaseNote ?? `**${t.title}.**`, alsoChangedLine(t.alsoChanged), t.noNewTests ? `_${NO_NEW_TESTS_LABEL}._` : ''].filter(Boolean).join(' ')}`);
  const skipped = tickets.flatMap((t) =>
    (t.overrides ?? []).filter((o) => !o.release).map((o) => `- ${t.id} ${t.title}: went out ${o.added ? `without your team's check "${o.added}"` : o.weakened?.length ? 'with weakened tests' : o.gate === 'checks' ? 'with failing checks' : o.gate === 'proof' ? 'with an unfinished proof' : o.gate === 'hooks' ? "without the project's own check" : 'with open review notes'}. ${o.by}: ${o.reason}`),
  );
  return [`### What's new in ${release.version.replace(/^v/, '')}`, '', ...lines, ...(skipped.length ? ['', '### Continued anyway', '', ...skipped] : [])].join('\n');
}

export function saveReleaseNotes(bp: BoardPaths, version: string, notes: string): Release {
  const release = readRelease(bp, version);
  if (!release || release.status !== 'draft') throw new BoardActionError(`${version} is not a draft release.`);
  if (releaseGoingOut(bp) === release.version) throw new BoardActionError(`${release.version} is going out right now with the notes it had. Edit the notes of the next release instead.`);
  release.notes = notes;
  writeRelease(bp, release);
  return release;
}

/**
 * The team's release gates, on squad-kit's own copy of what is about to go out, before anything changes. What holds the
 * release back stays on it for the page, with its ways out: Try again, or go on with a reason.
 */
async function gatesBeforeRelease(bp: BoardPaths, release: Release, tickets: Ticket[], reason?: string): Promise<void> {
  const done = await runReleaseGates(bp, tickets);
  for (const t of tickets) updateTicket(bp, t.id, (x) => noteGates(x, done, (text) => addActivity(x, 'release', text)));
  const stops = done.filter((d) => d.stops && d.result !== 'passed');
  const saved = readRelease(bp, release.version)!;
  delete saved.gateStop;
  if (stops.length && !reason) {
    saved.gateStop = stops.map((d) => ({ id: d.id, name: d.name, result: d.result as 'failed' | 'cant-run', ...(d.why ? { why: d.why } : {}), ...(d.output ? { output: d.output } : {}) }));
    writeRelease(bp, saved);
    throw new BoardActionError(`${release.version} did not go out: ${stops.map((d) => `"${d.name}"`).join(' and ')} ${stops.some((d) => d.result === 'failed') ? 'did not pass' : 'could not run'}. Nothing changed.`);
  }
  if (stops.length) {
    const by = readMeta(bp).user.name;
    const at = now();
    const lines = stops.map((d) => `- Went out without your team's check "${d.name}". ${by}: ${reason}`);
    release.notes = `${release.notes.trim()}\n\n### Continued anyway\n\n${lines.join('\n')}`;
    saved.notes = release.notes;
    for (const t of tickets) updateTicket(bp, t.id, (x) => (x.overrides = [...(x.overrides ?? []), ...stops.map((d) => ({ gate: 'checks' as const, added: d.name, release: release.version, reason: reason!, by, at }))]));
  }
  delete release.gateStop;
  writeRelease(bp, saved);
}

/**
 * A teammate released this number from their computer, since each one numbers its drafts alone. A number on the remote
 * is never used twice or moved, so this release takes the next free one, and every ticket in it follows.
 */
async function goAroundTakenVersion(bp: BoardPaths, release: Release): Promise<{ release: Release; was?: string }> {
  const tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  if (readMeta(bp).engine !== 'live' || !(await versionOnRemote(bp, release, tickets))) return { release };
  const part = /\.0$/.test(release.version) ? 'minor' : 'patch';
  let version = bump(release.version, part);
  while (fs.existsSync(path.join(bp.releasesDir, `${version}.md`)) || (await versionOnRemote(bp, { ...release, version }, tickets))) version = bump(version, part);
  // A ticket accepted while the remote was asked may have made this number's draft: that draft moves up one, whole.
  const accepted = readRelease(bp, version);
  if (accepted) {
    let after = bump(version, part);
    while (fs.existsSync(path.join(bp.releasesDir, `${after}.md`))) after = bump(after, part);
    writeRelease(bp, { ...accepted, version: after, from: version });
    for (const id of accepted.tickets) moveToRelease(bp, id, version, after);
  }
  const next: Release = { ...release, version, from: release.version };
  writeRelease(bp, next);
  removeRelease(bp, release.version);
  for (const t of tickets) moveToRelease(bp, t.id, t.release, version);
  return { release: next, was: release.version };
}

export async function releaseVersion(bp: BoardPaths, version?: string, goOn?: string): Promise<Release> {
  // squad-kit's own code: a release there publishes to npm, and that is for its maintainers (engine/self-project.ts).
  if (isSelfProject(bp)) throw new BoardActionError(SELF_NO_RELEASE);
  // A ticket being taken out of a release goes first: what its check says decides what goes out.
  const out = takingOutDone(bp);
  if (out) await out;
  const asked = version ? readRelease(bp, version) : draftRelease(bp);
  if (!asked || asked.status !== 'draft') throw new BoardActionError('There is no release ready to go out.');
  if (asked.tickets.length === 0) throw new BoardActionError(`${asked.version} has no tickets yet.`);
  // One going out now, or cut off half-way, may have put this tag there itself: it keeps its number.
  const keepsNumber = Boolean(releaseGoingOut(bp) || readJournal(bp));
  // One release at a time, and "Looks right" meanwhile knows this one takes no more tickets. Held before the remote is
  // asked about its number, which takes a while.
  let free: () => void;
  try {
    free = holdRelease(bp, asked.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    // What it sends is read once the lock is held: a ticket accepted just before still goes with it, and one accepted
    // from here on waits for the next release, its code too: the copy for the release takes a while on a big project.
    const sending = readRelease(bp, asked.version) ?? asked;
    const from = basesNow(bp);
    const { release, was } = keepsNumber ? { release: sending, was: undefined } : await goAroundTakenVersion(bp, sending);
    if (release.version !== asked.version) {
      free();
      free = holdRelease(bp, release.version);
    }
    // A release cut off by a restart is finished or undone first (board/release-tidy.ts).
    if (readJournal(bp)) {
      const cut = await settleRelease(bp, `${readJournal(bp)!.version} was cut off while it went out (the app closed or the computer restarted).`);
      if (cut?.version === release.version && cut.status === 'released') return cut;
      return await sendRelease(bp, readRelease(bp, release.version) ?? release, basesNow(bp), goOn?.trim(), was);
    }
    return await sendRelease(bp, release, from, goOn?.trim(), was);
  } finally {
    free();
  }
}

async function sendRelease(bp: BoardPaths, release: Release, from: Map<string, string>, goOn?: string, numberWas?: string): Promise<Release> {
  const meta = readMeta(bp);
  if (!release.notes.trim()) release.notes = composeNotes(bp, release);
  let tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  // No gate due, no wait: nothing changes for a project with none. What the gates wrote on the stories goes out with them.
  if (meta.engine === 'live' && (release.gateStop || releaseGatesDue(bp))) {
    await gatesBeforeRelease(bp, release, tickets, goOn);
    tickets = listTickets(bp).filter((t) => release.tickets.includes(t.id));
  }
  // Set before it goes out, so the release commit carries the release as the board will keep it.
  release.date = now();
  release.whatsappDraft = [
    `Hello, version ${release.version.replace(/^v/, '')} of ${meta.project} is now live.`,
    '',
    "What's new:",
    ...tickets.map((t) => `- ${t.title}`),
    '',
    'Release notes are in the changelog.',
  ].join('\n');
  let unpushed: UnpushedRelease[] = [];
  if (meta.engine === 'live') {
    try {
      const done = await liveRelease(bp, release, tickets, from);
      release.log = [...(numberWas ? [{ ok: true, text: `A teammate already released ${numberWas}, so this one went out as ${release.version}.` }] : []), ...done.log];
      unpushed = done.unpushed;
      // A pull request merged only now, as the release went out: the first code came in this way.
      firstCodeMerged(bp);
    } catch (err) {
      // Stopped half-way: what reached the remote is finished, the rest undone, so nothing stays half-done.
      const settled = await settleRelease(bp, `The release stopped: ${(err as Error).message}`).catch(() => null);
      if (settled?.status === 'released') return settled;
      foldNewerDrafts(bp, release.version);
      if (err instanceof PullRequestClash) {
        // Nothing changed yet: the clashing tickets leave the release with a way out, and the rest can go.
        const withPr = err.tickets.every((id) => readTicket(bp, id)?.pr);
        for (const id of err.tickets) pullRequestClashed(bp, id);
        const one = err.tickets.length === 1;
        const left = readRelease(bp, release.version)?.tickets.length ?? 0;
        throw new BoardActionError(
          `The release did not go out: ${withPr ? 'the pull request of ' : ''}${err.tickets.join(', ')} ${one || withPr ? 'clashes' : 'clash'} with newer changes in ${err.base}. ${one ? 'It' : 'They'} left ${release.version} and ${one ? 'waits' : 'wait'} for you with ways out.${left ? ' Press Release again to send the rest.' : ''}`,
        );
      }
      throw new BoardActionError(`The release did not go out: ${plainWords(err, 'A release stopped', 'something technical stopped it, and nothing was lost. Press Release to try again. If it happens again, an engineer can see why in the log.')}`);
    }
  }
  // Read again before saving: a ticket that joined the file while the release went out is not in it, so it waits for
  // the next release instead of being dropped or marked released.
  const later = (readRelease(bp, release.version)?.tickets ?? []).filter((id) => !release.tickets.includes(id));
  release.status = 'released';
  if (unpushed.length) release.unpushed = unpushed;
  else delete release.unpushed;
  writeRelease(bp, release);
  if (later.length) joinNextRelease(bp, later);
  closeReleased(bp, release);
  clearJournal(bp);
  afterRelease(bp, release);
  return release;
}

/**
 * The release's tickets close once their repo has the release, and the tracker hears it then. A repo whose push
 * failed keeps its tickets open, waiting for Push again.
 */
export function closeReleased(bp: BoardPaths, release: Release): void {
  const meta = readMeta(bp);
  for (const id of release.tickets) {
    const t = readTicket(bp, id);
    if (!t || t.stage === 'done') continue;
    const waits = release.unpushed?.length ? release.unpushed.find((u) => copyViews(meta, t).some((v) => repoFor(meta, v).path === u.repo)) : undefined;
    updateTicket(bp, id, (x) => {
      x.live = false;
      if (waits) {
        const status = `In ${release.version} · not sent yet`;
        if (x.status === status) return;
        x.status = status;
        addActivity(x, 'release', `Released in ${release.version} on this computer only: it did not reach your team's shared copy of the code. Send again sends it`);
        return;
      }
      x.stage = 'done';
      x.status = `Released in ${release.version}`;
      addActivity(x, 'release', `Released in ${release.version}`);
      tellLater(x, meta.engine, { kind: 'released', version: release.version });
    });
  }
}

/** Tickets accepted while a release went out: they go into the next draft, which says so on each of them. */
export function joinNextRelease(bp: BoardPaths, ids: string[]): void {
  const tickets = ids.map((id) => readTicket(bp, id)).filter((t): t is Ticket => Boolean(t));
  if (!tickets.length) return;
  const next = ensureDraftRelease(bp, tickets.every((t) => t.kind === 'bug') ? 'patch' : 'minor');
  writeRelease(bp, { ...next, tickets: [...new Set([...next.tickets, ...tickets.map((t) => t.id)])] });
  for (const t of tickets) moveToRelease(bp, t.id, t.release, next.version);
}

function moveToRelease(bp: BoardPaths, id: string, from: string | undefined, to: string): void {
  updateTicket(bp, id, (x) => {
    x.release = to;
    if (from && from !== to) x.status = x.status.split(from).join(to);
    addActivity(x, 'release', `Moved to release ${to}`);
  });
}

/**
 * A release that did not go out takes back the tickets accepted while it was going: they went into a newer draft,
 * which is folded into this one, so there is only one release to send.
 */
function foldNewerDrafts(bp: BoardPaths, version: string): void {
  for (const d of listReleases(bp).filter((r) => r.status === 'draft' && r.version !== version && newer(r.version, version) === r.version)) {
    const into = readRelease(bp, version);
    if (!into) return;
    writeRelease(bp, { ...into, tickets: [...new Set([...into.tickets, ...d.tickets])] });
    removeRelease(bp, d.version);
    for (const id of d.tickets) moveToRelease(bp, id, d.version, version);
  }
}

/**
 * "Push again" on a release whose push failed: the release commits and tags go to their remotes now, and the
 * tickets of every repo that got them close.
 */
export async function pushReleaseAgain(bp: BoardPaths, version: string): Promise<Release> {
  const release = readRelease(bp, version);
  if (!release) throw new BoardActionError(`There is no release ${version}.`);
  if (!release.unpushed?.length) throw new BoardActionError(`${release.version} is pushed already. Nothing is left to send.`);
  let free: () => void;
  try {
    free = holdRelease(bp, release.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    const done = await pushAgain(bp, release);
    release.log = [...(release.log ?? []), ...done.log];
    if (done.unpushed.length) release.unpushed = done.unpushed;
    else delete release.unpushed;
    writeRelease(bp, release);
    closeReleased(bp, release);
    return release;
  } finally {
    free();
  }
}

/** squad-kit looked, and the release is not on its remote, or it could not ask: it goes only on a second, clear yes. */
export class SentNotSure extends BoardActionError {}

/**
 * "It reached the remote another way": an engineer merged the release by hand, or squashed it, so Push again can never
 * see it. Its tickets close, and nothing checks after this, so the person says why, and squad-kit looks on the
 * remote first. Not there, or no answer: it says so, and only `anyway` goes on. The release's log keeps who said it,
 * why, and what squad-kit found.
 */
export async function markReleaseSent(bp: BoardPaths, version: string, input: { reason?: string; anyway?: boolean } = {}): Promise<Release> {
  const first = readRelease(bp, version);
  if (!first) throw new BoardActionError(`There is no release ${version}.`);
  if (!first.unpushed?.length) throw new BoardActionError(`${first.version} is pushed already. Nothing is left to send.`);
  const why = input.reason?.trim();
  if (!why) throw new BoardActionError("Write how it got there. It stays in the release's log, and its tickets close.");
  let free: () => void;
  try {
    free = holdRelease(bp, first.version);
  } catch (err) {
    throw new BoardActionError((err as Error).message);
  }
  try {
    const looks = await Promise.all(first.unpushed.map(async (u) => ({ u, ...(await onTheRemote(bp, u)) })));
    const absent = looks.filter((l) => l.there === 'no');
    const silent = looks.filter((l) => l.there === 'no-answer');
    if ((absent.length || silent.length) && !input.anyway) {
      throw new SentNotSure(
        silent.length
          ? `squad-kit could not reach your team's shared copy of the code, so it cannot check that ${first.version} is there. Its tickets close if you mark it. Do that only if you are sure.`
          : `squad-kit looked in your team's shared copy of the code and did not find ${first.version} there. A merge by hand can look like this too, so you can still mark it. Its tickets close if you do.`,
      );
    }
    const found = silent.length ? ' squad-kit could not check that' : absent.length ? ' squad-kit did not find it there' : ' squad-kit found it there';
    const meta = readMeta(bp);
    const release = readRelease(bp, version)!;
    // Marking it sends nothing: a version tag made here stays here until someone sends it, and the record says so.
    const tags = first.unpushed.filter((u) => u.tag);
    release.log = [
      ...(release.log ?? []),
      { ok: true, text: `${meta.user.name} said it reached the shared copy of the code another way: ${why}.${found}` },
      ...(tags.length ? [{ ok: false, text: `Its version tag is only on this computer: squad-kit sent nothing. An engineer can send it: ${tags.map((u) => `git push ${u.remote} ${u.tag}`).join(' ; ')}` }] : []),
    ];
    delete release.unpushed;
    writeRelease(bp, release);
    closeReleased(bp, release);
    return release;
  } finally {
    free();
  }
}
