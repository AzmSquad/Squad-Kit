import kleur from 'kleur';
import * as ui from '../ui/index.js';
import { readMeta } from '../board/store.js';
import type { DatabaseSetting } from '../board/types.js';
import { confirmDatabase, databaseView, learnDatabase, makeDbTemplate, setDatabaseOptions, type DatabaseChange } from '../engine/story-db.js';
import { board } from './board.js';

/**
 * `squad db`: the project's database and each story's own copy of it, for engineers, the same as Harness → Safety.
 * `squad db find` looks for it in the project's files again, `squad db confirm` confirms it (and corrects it), `squad db
 * template` makes the template from it. The hiding switch and the sample size: `squad config set db-hide`, `db-sample`.
 */

const out = (s = '') => process.stdout.write(`${s}\n`);
const cmd = (s: string) => kleur.green(s);
const row = (label: string, value: string) => out(`  ${kleur.bold(label.padEnd(14))}${value}`);
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function settingWords(s: DatabaseSetting): string {
  if (s.key && s.file) return `${s.key} in ${s.file}${s.env ? kleur.gray(` (or ${s.env} in the environment)`) : ''}`;
  if (s.env) return `${s.env}${s.file ? ` in ${s.file}` : ''}`;
  return kleur.yellow('not known yet');
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface DbOptions {
  kind?: string;
  name?: string;
  env?: string;
  file?: string;
  key?: string;
  address?: string;
  repo?: string;
}

export async function runDb(action: string | undefined, opts: DbOptions = {}): Promise<void> {
  const bp = board();
  const what = (action ?? 'show').trim().toLowerCase();
  if (what === 'find') {
    const r = learnDatabase(bp, { again: true });
    if (r.later) ui.info(r.later);
    else if (!r.database) ui.info("squad-kit found no database in the project's files. Name it yourself: squad db confirm --kind postgres --env DATABASE_URL --address …");
    else ui.success(r.changed ? 'Found the database again. An engineer confirms it before stories get their own copy.' : 'Found the same database again.');
  } else if (what === 'confirm') {
    const change: DatabaseChange = Object.fromEntries(Object.entries(opts).filter(([k, v]) => ['kind', 'name', 'env', 'file', 'key', 'address', 'repo'].includes(k) && typeof v === 'string'));
    const db = confirmDatabase(bp, readMeta(bp).user.name, change);
    const blocked = databaseView(bp).blocked;
    if (blocked) ui.success(`Confirmed: ${db.name ?? 'the database'}. Stories use it as before, though: ${blocked}`);
    else ui.success(`Confirmed: ${db.name ?? 'the database'}. Stories get their own copy once there is a template: ${cmd('squad db template')}`);
  } else if (what === 'template') {
    out('  Making the template. It only reads your database.');
    const info = await makeDbTemplate(bp, readMeta(bp).user.name);
    const sampled = info.tables.filter((t) => t.kept === 'sampled').length;
    ui.success(`Made the template of ${info.sourceName}: ${size(info.bytes)}, ${info.tables.length} tables${sampled ? `, ${sampled} of them sampled` : ''}.`);
    for (const n of info.notes) out(`  ${kleur.gray(n)}`);
  } else if (what !== 'show') {
    throw new Error(`"${action}" is not something squad db does. Use show, find, confirm or template.`);
  }
  show(bp);
}

function show(bp: ReturnType<typeof board>): void {
  const v = databaseView(bp);
  out();
  const db = v.database;
  if (!db) {
    out(`  ${v.words}`);
    out();
    ui.info(`Look again: ${cmd('squad db find')}   Name it yourself: ${cmd('squad db confirm --kind postgres --env DATABASE_URL --address …')}`);
    return;
  }
  row('Database', `${db.kindName}${db.name ? ` ${db.name}` : ''}  ${db.confirmed ? kleur.green(`confirmed by ${db.confirmed.by}, ${when(db.confirmed.at)}`) : kleur.yellow('not confirmed yet')}`);
  if (db.where) row('Where', db.where);
  row('Setting', settingWords(db.setting));
  row('Address', db.address ? `${db.address}${db.secret ? kleur.gray('  (on this computer only)') : ''}` : kleur.yellow('not known yet'));
  if (db.from?.length) row('Learned from', db.from.join(', '));
  if (v.blocked) row('Own copies', kleur.yellow(v.blocked));
  if (v.making) row('Template', kleur.yellow(`being made, since ${when(v.making.since)}`));
  else if (v.template) {
    const sampled = v.template.tables.filter((t) => t.kept === 'sampled').length;
    row('Template', `${size(v.template.bytes)}, made ${when(v.template.madeAt)} · ${v.template.tables.length} tables${sampled ? `, ${sampled} sampled` : ''}${v.template.hidePersonal ? ', personal data hidden' : ''}`);
  } else row('Template', kleur.yellow('none yet'));
  if (v.failed) row('', kleur.yellow(`The last one was not made: ${v.failed.text}`));
  row('Hide personal', db.hidePersonal ? 'on' : 'off');
  row('Sample size', db.sampleRows ? `${db.sampleRows} rows` : 'the default (1000 rows)');
  if (v.missing.length) row('Tools', kleur.yellow(`this computer has no ${v.missing.join(', ')}`));
  out();
  out(`  ${kleur.bold('Story databases now')}`);
  if (!v.stories.length) out(kleur.gray('    None'));
  for (const s of v.stories) out(`    ${s.story}  ${s.name}  ${kleur.gray(when(s.at))}`);
  if (v.notes.length) {
    out();
    out(`  ${kleur.bold('Notes for engineers')}`);
    for (const n of v.notes.slice(0, 5)) out(`    ${kleur.gray(when(n.at))}  ${n.text}`);
  }
  out();
  ui.info(`${db.confirmed ? '' : `Confirm it: ${cmd('squad db confirm')}   `}${v.template ? 'Make it again' : 'Make the template'}: ${cmd('squad db template')}   Look again: ${cmd('squad db find')}`);
}

/** `squad config set db-hide [on|off]`: personal data hidden in the template, for the whole team. Off by default. */
export async function runDbHide(setting: string | undefined): Promise<void> {
  const bp = board();
  if (setting === undefined) {
    const on = Boolean(readMeta(bp).database?.hidePersonal);
    out(`  ${kleur.bold('Hide personal data in the database template')}  ${on ? 'on' : 'off'}`);
    out(`  ${kleur.gray('On: names, ID numbers, phones, emails and addresses become fake, by column or field name.')}`);
    ui.info(`Change it: ${cmd(`squad config set db-hide ${on ? 'off' : 'on'}`)}`);
    return;
  }
  const s = setting.trim().toLowerCase();
  if (!['on', 'off'].includes(s)) throw new Error(`"${setting}" is not a setting here. Use on or off.`);
  setDatabaseOptions(bp, { hidePersonal: s === 'on' });
  ui.success(`Personal data is ${s === 'on' ? 'hidden' : 'kept as it is'} in the next template. Make it again: ${cmd('squad db template')}`);
}

/** `squad config set db-sample [rows|default]`: how many of a big table's newest rows the template keeps. */
export async function runDbSample(rows: string | undefined): Promise<void> {
  const bp = board();
  if (rows === undefined) {
    const n = readMeta(bp).database?.sampleRows;
    out(`  ${kleur.bold('Rows the template keeps of a big table')}  ${n ? n : 'the default (1000)'}`);
    ui.info(`Change it: ${cmd('squad config set db-sample 5000')}   Back to the default: ${cmd('squad config set db-sample default')}`);
    return;
  }
  const back = rows.trim().toLowerCase() === 'default';
  setDatabaseOptions(bp, { sampleRows: back ? null : Number(rows) });
  ui.success(`${back ? 'The default sample size' : `${Number(rows)} rows`} from the next template. Make it again: ${cmd('squad db template')}`);
}
