import path from 'node:path';
import { readTicket } from '../../board/store.js';
import { CHECK_SILENT_MS, runCommand, tail, type CheckResult, type CommandWatch } from '../checks.js';
import { testKey, type FailedTest } from '../failed-tests.js';
import { ON_MAIN_MS, runOnMain, testsToTry, type MainResult } from '../old-tests.js';
import { addSnapshot, dropSnapshot } from '../git.js';
import { placeStoryFiles } from '../local-files.js';
import type { CopyOf } from '../copies.js';
import { workSoFar } from '../handover.js';
import { stepDoing } from '../../board/clock.js';
import { runsEnded } from '../leftovers.js';
import { BEFORE_SHOTS_MS } from './limits.js';
import { projectRoot } from './shared.js';
import type { LiveSquad } from './squad.js';

/** Main's own code beside a ticket's copy: a failed test run again there. */
export const mainCopyPart = {
  /**
   * A failed test check, before a try is counted: its failed tests run on their own on main's code (engine/old-tests.ts),
   * in the Tester's "before" copy. Which fail there too, and which pass there every time. What squad-kit found on the
   * same main stays known for the story, so a later round of checks does not run them there again. Null when it cannot
   * tell (a test it cannot name or run alone, one the story changed, a copy it could not set up): the usual way then.
   */
  async testsOnMain(this: LiveSquad, id: string, c: CopyOf, r: CheckResult): Promise<MainResult | null> {
    if (!c.baseCommit) return null;
    const tests = testsToTry(r.output, c.dir, r.command, await workSoFar(c.dir, c.baseCommit));
    if (!tests) return null;
    // A story made to fix an old test never goes past that test: it is the one thing it must fix.
    const t = readTicket(this.bp, id);
    if (tests.some((x) => t?.oldTests?.includes(testKey(x)))) return null;
    const seen = t?.onMain?.find((m) => m.repo === c.repo.path && m.base === c.baseCommit);
    const found: MainResult = { old: tests.filter((x) => seen?.old.includes(testKey(x))), fine: tests.filter((x) => seen?.fine.includes(testKey(x))), printed: {} };
    const left = tests.filter((x) => !found.old.includes(x) && !found.fine.includes(x));
    if (!left.length) return found;
    const fresh = await this.inMainCopy(id, c, (dir, watch) => runOnMain(dir, r.command, left, (one, ms) => runCommand(dir, one, ms, { silentMs: CHECK_SILENT_MS, ...watch }), Date.now() + ON_MAIN_MS));
    if (!fresh) return null;
    found.old.push(...fresh.old);
    found.fine.push(...fresh.fine);
    Object.assign(found.printed, fresh.printed);
    this.log('info', `Ran the failed tests on main's code (${c.baseCommit.slice(0, 8)}): ${[...fresh.old.map((x) => `failed there too: ${testKey(x)}`), ...fresh.fine.map((x) => `passed there: ${testKey(x)}`)].join('; ')}`, id);
    this.update(id, (x) => {
      const rest = (x.onMain ?? []).filter((m) => m.repo !== c.repo.path);
      const keys = (list: FailedTest[]) => [...new Set(list.map(testKey))];
      x.onMain = [...rest, { repo: c.repo.path, base: c.baseCommit!, old: keys(found.old), fine: keys(found.fine) }];
    });
    return found;
  },

  /**
   * Main's code, in the Tester's "before" copy, made the way the before screenshots make it: at the story's base, with
   * the story's local files and the project's setup, so a test there differs from the story's copy only by the story's
   * change. The before screenshots end first, as they use that copy. `use` runs in it, with the ticket's Stop and a time
   * limit for its runs; the copy goes after. Null when it could not be made or set up.
   */
  async inMainCopy<T>(this: LiveSquad, id: string, c: CopyOf, use: (dir: string, watch: CommandWatch) => Promise<T | null>): Promise<T | null> {
    await this.beforeShotsOf.get(id);
    this.goOn(id);
    const root = path.join(projectRoot(this.bp), c.repo.path);
    const stop = this.stops.get(id)?.signal;
    const within = (ms: number) => (stop ? AbortSignal.any([stop, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
    const said = readTicket(this.bp, id)?.status;
    const doing = (text: string) =>
      this.update(id, (x) => {
        x.status = text;
        stepDoing(x, text);
      });
    let dir: string | null = null;
    try {
      const ready = within(BEFORE_SHOTS_MS);
      dir = await this.makingCopy(id, (how) => addSnapshot(root, `${id.toLowerCase()}-before`, c.baseCommit!, { ...how, signal: ready }));
      placeStoryFiles(this.bp, c.repo.path, dir);
      const setup = c.repo.commands.setup?.trim();
      if (setup) {
        doing("Setting up a copy of main's code for the failed test");
        const s = await runCommand(dir, setup, BEFORE_SHOTS_MS, { ...this.guardedWatch(id, dir), signal: ready });
        if (!s.ok) {
          this.log('warn', `Could not set up a copy of main's code for the failed tests (${setup}): ${tail(s.output, 10)}`, id);
          return null;
        }
        // A setup can write the same files: the values kept for stories go back over them, as in the story's copy.
        placeStoryFiles(this.bp, c.repo.path, dir);
      }
      this.goOn(id);
      // No server left by another of squad-kit's copies may hold a port the test needs.
      await this.clearBeforeApp(id);
      doing("Running the failed test on main's code");
      return await use(dir, { ...this.guardedWatch(id, dir), signal: within(ON_MAIN_MS) });
    } catch (err) {
      if (stop?.aborted) throw err;
      this.log('warn', `Could not run the failed tests on main's code: ${(err as Error).message}`, id);
      return null;
    } finally {
      if (dir) {
        // Nothing the runs started outlives their copy.
        await runsEnded([dir], 6000);
        await this.clearCopies([dir], {}, id).catch(() => undefined);
        await dropSnapshot(root, dir).catch(() => undefined);
      }
      if (said !== undefined) this.update(id, (x) => (x.status = said));
    }
  },
};
