import { input, password, select } from '@inquirer/prompts';
import * as ui from '../../ui/index.js';
import { loadConfig } from '../../core/config.js';
import { buildPaths } from '../../core/paths.js';
import { git } from '../../engine/git.js';
import { guessTracker } from '../../modules/registry.js';
import type { SetupField, TrackerModule } from '../../modules/tracker/types.js';

/**
 * `squad config set tracker` for a tracker drawn from its module's fields, as the Settings page draws it: values from
 * `--field key=value`, the rest asked for in a terminal, then saved, checked and the sign-in named.
 */

/** "repo=owner/name" pairs, each value kept whole. */
export function parseFields(pairs: string[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`Write each setting as key=value, like repo=owner/name. "${pair}" is not.`);
    values[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return values;
}

function shown(field: SetupField, values: Record<string, string>): boolean {
  return !field.when || field.when.is.includes(values[field.when.key] ?? '');
}

async function ask(mod: TrackerModule, field: SetupField, values: Record<string, string>): Promise<string> {
  if (field.secret) return password({ message: field.label, mask: '*' });
  const options = field.options ?? (field.choice ? (await mod.choices?.(values))?.[field.key] : undefined);
  // A list that only suggests is typed, with the first few named.
  if (options?.length && field.typed) return input({ message: `${field.label} (${options.slice(0, 5).map((o) => o.label).join(', ')}${options.length > 5 ? ', …' : ''})`, default: values[field.key] || options[0]!.value });
  if (options?.length) return select({ message: field.label, choices: options.map((o) => ({ name: o.label, value: o.value })), default: values[field.key] || options[0]!.value });
  return input({ message: field.label, default: values[field.key] ?? '' });
}

export async function setTrackerFromModule(root: string, mod: TrackerModule, fields: string[] | undefined, interactive: boolean): Promise<void> {
  const config = loadConfig(buildPaths(root).configFile);
  const given = parseFields(fields);
  const known = new Set(mod.fields.map((f) => f.key));
  const unknown = Object.keys(given).find((k) => !known.has(k));
  if (unknown) throw new Error(`${mod.label} has no setting "${unknown}". It has: ${[...known].join(', ')}.`);
  const guessed = guessTracker([git(root, ['config', '--get', 'remote.origin.url'], { allowFail: true })]);
  const values: Record<string, string> = {
    ...(guessed?.module === mod ? guessed.values : {}),
    ...(config.tracker.type === mod.name ? mod.read(root).values : {}),
    ...given,
  };
  for (const field of mod.fields) {
    if (!interactive || field.key in given || field.more || !shown(field, values)) continue;
    values[field.key] = await ask(mod, field, values);
  }
  const steps = (await mod.setupSteps?.(values)) ?? [];
  if (steps.length) {
    ui.warning(`Before squad-kit can reach ${mod.label}, on this computer:`);
    steps.forEach((s, i) => ui.info(`${i + 1}) ${s.say}${s.command ? `: ${s.command}` : ''}${s.link ? `: ${s.link}` : ''}`));
    throw new Error(`Do the step${steps.length > 1 ? 's' : ''} above, then run this again.`);
  }
  await mod.save(root, values);
  for (const [key, value] of Object.entries(mod.read(root).values)) if (value) ui.kv(key, value, 18);
  // Connected only once the tracker itself said who is signed in.
  const tracker = mod.open(root);
  if (!tracker) {
    const missing = mod.fields.filter((f) => f.secret).map((f) => f.label.toLowerCase());
    throw new Error(
      `The settings are saved, but squad-kit cannot connect to ${mod.label} yet: it needs the ${missing.join(' and ') || 'sign-in'}. Run squad config set tracker --type ${mod.name} in a terminal to type it in, or add it in Settings.`,
    );
  }
  let who: string;
  try {
    who = await tracker.whoAmI();
  } catch (err) {
    throw new Error(`The settings are saved, but ${mod.label} did not let squad-kit in: ${(err as Error).message}`);
  }
  ui.success(`${mod.label} is connected as ${who}.`);
}
