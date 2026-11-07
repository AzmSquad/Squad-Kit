import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { scrubSecrets } from '../core/scrub.js';
import { MAX_CHECKLIST_QUESTIONS, MAX_RULE_CHARS, MAX_TYPED_CHARS, type Addition, type GateWhen, type NewAddition } from './additions.js';
import type { ProjectCommands } from './types.js';

/**
 * From a folder: what a team's own standard holds that could join its harness. Looking only reads: nothing in the folder
 * ever runs. Text files only, a limited number of them and of limited size, no links leading out, and never a file that
 * holds keys. What it finds is data, and reaches an agent only after a person ticks it.
 */

export const MAX_FOLDER_FILES = 200;
export const MAX_FOLDER_FILE_BYTES = 200_000;
const DEEPEST = 6;
const NOT_LOOKED_IN = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);
const HOLDS_KEYS = /^\.env|\.(pem|key|p12|pfx|jks|keystore|crt|cer|gpg)$|^id_(rsa|dsa|ecdsa|ed25519)|secret|credential|password|token|\.npmrc$|\.netrc$/i;
const OURS = 'squad-kit already does this, and two processes would fight.';
/** Steps of a process squad-kit runs itself: they stay out, with that line, and can't be ticked. */
const OUR_HEADING = /\b(contract|workflow|code review|review process|reviews?|release|deploy|commit|push|pull request|merge request|branch|merging)\b/i;
const OUR_STEP = /\b(git (commit|push|merge|rebase|checkout)|gh pr|open (a|your( own)?) (pull request|pr)\b|create (a|your( own)?) (pull request|pr)\b)/i;
const OUR_SCRIPT = /^(pre|post)?(release|publish|deploy|commit|push|version)\b/i;
const NEVER_A_GATE = /^(pre|post)?(install|prepare|start|dev|serve|watch|preview)\b/i;

export interface FolderFind {
  key: string;
  kind: Addition['kind'];
  name: string;
  /** Where it was found, as a path in the folder. */
  source: string;
  text?: string;
  questions?: string[];
  command?: string;
  when?: GateWhen;
  /** Why it can't be ticked. */
  out?: string;
  already?: boolean;
}

export interface FolderLook {
  name: string;
  path: string;
  finds: FolderFind[];
  /** Files not read: too big, not text, holding keys or a link leading out. */
  left: number;
  /** It stopped at MAX_FOLDER_FILES. */
  more: boolean;
}

function textOf(file: string): string | null {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FOLDER_FILE_BYTES) return null;
  const data = fs.readFileSync(file);
  if (data.includes(0)) return null;
  const text = data.toString('utf8');
  return text.includes('�') ? null : text;
}

/** A markdown file, cut at its headings. */
function sectionsOf(text: string, title: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  let at = { name: title, body: '' };
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      if (at.body.trim()) out.push(at);
      at = { name: h[1]!, body: '' };
    } else at.body += `${line}\n`;
  }
  if (at.body.trim()) out.push(at);
  return out;
}

const boxesOf = (body: string): string[] => [...body.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)].map((m) => m[1]!.trim());
const namedFrom = (file: string): string => path.basename(file).replace(/\.[^.]+$/, '');

function fromMarkdown(source: string, text: string, asRules: boolean): FolderFind[] {
  return sectionsOf(text, namedFrom(source)).flatMap((s, i): FolderFind[] => {
    const key = `${source}#${i}`;
    const name = s.name.slice(0, MAX_TYPED_CHARS).trim();
    const body = scrubSecrets(s.body.trim());
    const boxes = boxesOf(s.body);
    const ours = OUR_HEADING.test(s.name) || OUR_STEP.test(body) ? { out: OURS } : {};
    if (boxes.length >= 2) {
      const questions = boxes.slice(0, MAX_CHECKLIST_QUESTIONS).map((q) => scrubSecrets(q).slice(0, MAX_TYPED_CHARS));
      return [{ key, kind: 'checklist', name, source, questions, ...ours }];
    }
    if (!asRules) return [];
    const tooLong = body.length > MAX_RULE_CHARS ? { out: `Too long for one rule (the limit is ${MAX_RULE_CHARS} characters). You can add a shorter one by hand.` } : {};
    return [{ key, kind: 'rule', name, source, text: body, ...tooLong, ...ours }];
  });
}

function fromOurFormat(source: string, text: string): FolderFind[] {
  let doc: { additions?: Record<string, unknown>[] };
  try {
    doc = (yaml.load(text) ?? {}) as typeof doc;
  } catch {
    return [];
  }
  if (!Array.isArray(doc.additions)) return [];
  return doc.additions.flatMap((a, i): FolderFind[] => {
    const name = typeof a?.name === 'string' ? a.name.trim().slice(0, MAX_TYPED_CHARS) : '';
    const key = `${source}#${i}`;
    if (!name) return [];
    if (a.kind === 'rule' && typeof a.text === 'string') return [{ key, kind: 'rule', name, source, text: scrubSecrets(a.text), ...(a.text.length > MAX_RULE_CHARS ? { out: `Too long for one rule (the limit is ${MAX_RULE_CHARS} characters).` } : {}) }];
    if (a.kind === 'checklist' && Array.isArray(a.questions)) return [{ key, kind: 'checklist', name, source, questions: a.questions.filter((q): q is string => typeof q === 'string').slice(0, MAX_CHECKLIST_QUESTIONS).map((q) => scrubSecrets(q)) }];
    if (a.kind === 'gate' && typeof a.command === 'string') return [{ key, kind: 'gate', name, source, command: a.command.trim(), when: ['checks', 'merge', 'release'].includes(a.when as string) ? (a.when as GateWhen) : 'checks' }];
    return [];
  });
}

function runnerFor(root: string): (s: string) => string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return (s) => `pnpm run ${s}`;
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return (s) => `yarn ${s}`;
  return (s) => `npm run ${s}`;
}

function fromPackage(root: string, source: string, text: string, commands: ProjectCommands): FolderFind[] {
  let scripts: Record<string, unknown>;
  try {
    scripts = ((JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const run = runnerFor(root);
  const own = [commands.test, commands.lint, commands.build].filter(Boolean).join(' ');
  return Object.keys(scripts).filter((s) => !NEVER_A_GATE.test(s)).map((s): FolderFind => ({
    key: `${source}#${s}`,
    kind: 'gate',
    name: s,
    source,
    command: run(s),
    when: 'checks',
    ...(OUR_SCRIPT.test(s) ? { out: OURS } : new RegExp(`\\b${s.replace(/[^\w:-]/g, '')}\\b`).test(own) ? { out: 'squad-kit already runs this with the checks.' } : {}),
  }));
}

/** What one folder holds. `have` is what is already added, by kind and name. */
export function lookInFolder(folder: string, have: Addition[], commands: ProjectCommands): FolderLook {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(folder));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new Error("squad-kit can't open that folder. Check the path and try again.");
  }
  const finds: FolderFind[] = [];
  let left = 0;
  let seen = 0;
  let looked = 0;
  let more = false;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // A folder this program may not open: left out, and the sheet counts it.
      left += 1;
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A person may point at a very big folder: looking stays quick, and it says it stopped.
      if ((looked += 1) > MAX_FOLDER_FILES * 50) more = true;
      if (more) return;
      const at = path.join(dir, e.name);
      const source = path.relative(root, at).split(path.sep).join('/');
      if (HOLDS_KEYS.test(e.name) || NOT_LOOKED_IN.has(e.name)) {
        left += 1;
        continue;
      }
      let real = at;
      if (e.isSymbolicLink()) {
        try {
          real = fs.realpathSync(at);
        } catch {
          real = '';
        }
        if (!real || !`${real}${path.sep}`.startsWith(`${root}${path.sep}`)) {
          left += 1;
          continue;
        }
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(real);
      } catch {
        left += 1;
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < DEEPEST && !e.isSymbolicLink()) walk(at, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      const isScriptCheck = source === 'scripts/check';
      const isMarkdown = /\.(md|mdc|markdown)$/i.test(e.name);
      const isOurs = source === 'harness.yaml' || source === '.squad/harness.yaml';
      if (!isMarkdown && !isOurs && !isScriptCheck && source !== 'package.json' && !(/(^|\/)rules\//.test(source) && /\.txt$/i.test(e.name))) continue;
      if ((seen += 1) > MAX_FOLDER_FILES) {
        more = true;
        return;
      }
      let text: string | null = null;
      try {
        text = textOf(real);
      } catch {
        // It can't be read: left out, as a file too big is.
      }
      if (text === null) {
        left += 1;
        continue;
      }
      if (isOurs) finds.push(...fromOurFormat(source, text));
      else if (source === 'package.json') finds.push(...fromPackage(root, source, text, commands));
      else if (isScriptCheck) finds.push({ key: source, kind: 'gate', name: 'scripts/check', source, command: './scripts/check', when: 'checks' });
      else finds.push(...fromMarkdown(source, text, /^(AGENTS|CLAUDE)\.md$/.test(e.name) || /(^|\/)rules\//.test(source)));
    }
  };
  walk(root, 0);
  const named = new Set(have.map((a) => `${a.kind}\0${a.name.trim().toLowerCase()}`));
  return {
    name: path.basename(root),
    path: root,
    finds: finds.map((f) => (named.has(`${f.kind}\0${f.name.trim().toLowerCase()}`) ? { ...f, already: true } : f)).slice(0, MAX_FOLDER_FILES),
    left,
    more,
  };
}

/** A tick, as an addition. The words come from the folder as it is now, never from the page. */
export function additionOf(f: FolderFind, pick: { agent?: string; on_fail?: 'stop' | 'warn'; when?: GateWhen; part?: string }): NewAddition & { name: string } {
  if (f.kind === 'rule') return { kind: 'rule', name: f.name, agents: [pick.agent || 'all'], text: f.text ?? '' };
  if (f.kind === 'checklist') return { kind: 'checklist', name: f.name, agent: pick.agent === 'tester' ? 'tester' : 'reviewer', questions: f.questions ?? [] };
  return { kind: 'gate', name: f.name, command: f.command ?? '', when: pick.when ?? f.when ?? 'checks', on_fail: pick.on_fail ?? 'stop', ...(pick.part ? { part: pick.part } : {}) };
}
