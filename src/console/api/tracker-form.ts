import path from 'node:path';
import type { Hono } from 'hono';
import { guessTracker, trackerModule, TRACKERS } from '../../modules/registry.js';
import { findNestedRepos } from '../../engine/repos.js';
import { git } from '../../engine/git.js';
import { plainWords } from '../../core/for-people.js';

/**
 * The tracker part of Settings, drawn from the modules (ADR-002): the trackers there are, the chosen one's fields and
 * values, what this computer still needs before it can connect, and the lists its choice fields pick from.
 */

export async function trackerForm(root: string, savedType: string, asked?: string) {
  const saved = trackerModule(savedType);
  // Not set up yet: a repo whose remote lives on a tracker's product already says which settings to use.
  const dirs = [root, ...findNestedRepos(root).map((r) => path.join(root, r.path))];
  const guessed = guessTracker(dirs.map((d) => git(d, ['config', '--get', 'remote.origin.url'], { allowFail: true })));
  const mod = trackerModule(asked) ?? saved ?? guessed?.module ?? TRACKERS[0]!;
  const read = mod === saved ? mod.read(root) : { values: {} as Record<string, string>, hasSecret: false };
  const guess = guessed?.module === mod ? guessed.values : {};
  const values = Object.fromEntries(mod.fields.filter((f) => !f.secret).map((f) => [f.key, read.values[f.key] || guess[f.key] || '']));
  const steps = mod.setupSteps ? await mod.setupSteps(values).catch(() => []) : [];
  return {
    module: mod.name,
    label: mod.label,
    about: mod.about,
    hint: mod.hint,
    fields: mod.fields,
    values,
    hasToken: read.hasSecret,
    ...('note' in read && read.note ? { note: read.note } : {}),
    steps,
    modules: TRACKERS.map((m) => ({ name: m.name, label: m.label })),
  };
}

/** GET only: the lists for the values picked so far, such as the boards a tracker has and their states. */
export function mountTrackerChoices(app: Hono): void {
  app.get('/api/v1/tracker/choices', async (c) => {
    const mod = trackerModule(c.req.query('module'));
    if (!mod?.choices) return c.json({ lists: {} });
    const values = Object.fromEntries(mod.fields.filter((f) => !f.secret).map((f) => [f.key, c.req.query(f.key) ?? '']));
    try {
      return c.json({ lists: await mod.choices(values) });
    } catch (err) {
      return c.json({ lists: {}, error: plainWords(err, 'Reading the tracker lists') });
    }
  });
}
