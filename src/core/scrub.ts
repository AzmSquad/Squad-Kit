import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from './home.js';

/**
 * Keeps secrets out of what squad-kit writes for people to read or send on: the app log and Report a problem. Known
 * values (the sign-ins in secrets.yaml, the board's private link token, secret-looking environment variables, a
 * project's own .env and local files) are taken out by value, and anything shaped like a key, a token or a password by
 * its shape.
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  [/\bsk-ant-[\w-]{10,}/g, '[key removed]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[key removed]'],
  // A payment service's secret keys (sk_live_…, rk_test_…) and its webhook secrets.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[key removed]'],
  [/\bwhsec_[A-Za-z0-9]{8,}/g, '[key removed]'],
  [/\bnpm_[A-Za-z0-9]{20,}/g, '[token removed]'],
  [/\bSG\.[\w-]{16,}\.[\w-]{16,}/g, '[key removed]'],
  [/\bya29\.[\w-]{20,}/g, '[token removed]'],
  [/\bhooks\.slack\.com\/services\/[\w/]+/g, 'hooks.slack.com/services/[removed]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[token removed]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[token removed]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[token removed]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[token removed]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[key removed]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[key removed]'],
  // A signed token (JWT).
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[token removed]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [token removed]'],
  // A password in a link: https://name:password@host.
  [/(\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:[password removed]@'],
  [/([?&](?:t|token|access_token|key|api_key|code|sig|password)=)[^&\s"'<>]+/gi, '$1[removed]'],
  // An environment setting, with any name around the word: DB_PASSWORD=…, JWT_SECRET=…, STRIPE_KEY="…". Any length.
  [/\b([A-Z0-9_.-]{0,64}(?:PASSWORD|PASSWD|PASSPHRASE|PWD|_PASS|SECRET|TOKEN(?!S)|APIKEY|API_KEY|_KEY|_PAT|CREDENTIALS?)[A-Z0-9_]{0,32}["']?\s*[:=][ \t]*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1[removed]'],
  // The same in settings and code, in any case: dbPassword: …, "db.password": "…". A password of any length.
  [/\b([\w.-]{0,64}(?:password|passwd|passphrase|pwd)["']?\s*[:=][ \t]*)(?:"[^"\n]+"|'[^'\n]+'|[^\s"',;}]+)/gi, '$1[removed]'],
  [/\b([\w.-]{0,64}(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|private[_-]?key)["']?\s*[:=][ \t]*)(?:"[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"',;}]{6,})/gi, '$1[removed]'],
  [/(?<![A-Za-z])(pat["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1[removed]'],
  // The same as a command's option: --password …, --api-key=….
  [/(--(?:password|passwd|token|secret|api-key)[= ])\S+/gi, '$1[removed]'],
  // The board's link token and other long hex secrets. Git commits (40 characters) stay.
  [/\b[a-f0-9]{64,}\b/gi, '[token removed]'],
  // An Azure DevOps personal access token.
  [/\b[a-z2-7]{52}\b/g, '[token removed]'],
];

/** Files that are never put in a report, whatever folder they are in. */
const SECRET_FILE = /(^|[\\/])(secrets\.ya?ml|console\.json|app\.json|\.env(\.[\w.-]*)?|\.npmrc|\.netrc|id_[a-z0-9]+|[^\\/]*\.(pem|key|p12|pfx))$/i;

export function isSecretFile(name: string): boolean {
  return SECRET_FILE.test(name);
}

/** Every string in a YAML or JSON value, deep. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

function readQuietly(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

let cache: { at: number; values: string[] } | null = null;

/**
 * The secret values on this computer: every sign-in in squad-kit's secrets files, the board's link tokens, and
 * environment variables named like a key or token. Read again at most once a minute.
 */
export function knownSecrets(extraFiles: string[] = []): string[] {
  if (cache && Date.now() - cache.at < 60_000 && !extraFiles.length) return cache.values;
  const found = new Set<string>();
  const home = squadHome();
  const files = [path.join(home, 'secrets.yaml'), path.join(home, 'app.json'), ...extraFiles];
  try {
    for (const id of fs.readdirSync(path.join(home, 'projects'))) {
      files.push(path.join(home, 'projects', id, 'secrets.yaml'), path.join(home, 'projects', id, 'console.json'));
    }
  } catch {
    // No projects yet.
  }
  for (const file of files) {
    const text = readQuietly(file);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = file.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
    } catch {
      continue;
    }
    // console.json and app.json hold one secret, the link token; a secrets file holds nothing else.
    const values = file.endsWith('.json') ? [(parsed as { token?: unknown })?.token].filter((t): t is string => typeof t === 'string') : strings(parsed);
    for (const v of values) if (v.trim().length >= 8) found.add(v.trim());
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY|_PAT)$/i.test(name)) found.add(value);
  }
  const values = [...found].sort((a, b) => b.length - a.length);
  if (!extraFiles.length) cache = { at: Date.now(), values };
  return values;
}

/** A setting's name that says its value is private, whatever the value looks like. */
const PRIVATE_NAME = /pass|pwd|secret|token|key|credential|salt|private/i;
/** A value nobody needs hidden and many lines may hold: a plain word, a number, a local address, a folder. */
const PLAIN_VALUE = /^(?:[a-z]+(?:[-_ ][a-z]+)*|[\d.,:]+|(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/\S*)?|(?:~|\.{0,2})\/[\w./-]*)$/i;

/** Every "name = value" in a project's own local file: a .env file's lines, or the settings in JSON or YAML. */
function settingsIn(file: string, text: string): [string, string][] {
  const walk = (v: unknown, name = ''): [string, string][] => {
    if (typeof v === 'string') return [[name, v]];
    if (Array.isArray(v)) return v.flatMap((x) => walk(x, name));
    if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => walk(x, k));
    return [];
  };
  try {
    if (/\.json$/i.test(file)) return walk(JSON.parse(text));
    if (/\.ya?ml$/i.test(file)) return walk(yaml.load(text));
  } catch {
    // Not what its name says: read as lines, below.
  }
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) return [];
    const value = /^(["']).*\1$/.test(m[2]!) ? m[2]!.slice(1, -1) : m[2]!.replace(/\s+#.*$/, '');
    return [[m[1]!, value] as [string, string]];
  });
}

/**
 * The private values in a project's own local files (its .env files and the files it keeps on this computer), to take
 * out by value. A value a shape would not catch, like a database password of plain letters, goes because of its name;
 * the rest goes unless it is plainly nothing private, or "development" would vanish from every line of a report.
 */
export function localFileSecrets(files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const text = readQuietly(file);
    if (!text) continue;
    for (const [name, raw] of settingsIn(file, text)) {
      const value = raw.trim();
      if (value.length < 4 || /^(?:\d+|true|false|null|none)$/i.test(value)) continue;
      if (PRIVATE_NAME.test(name) || (value.length >= 8 && !PLAIN_VALUE.test(value))) found.add(value);
    }
  }
  return [...found];
}

/** The text with every known secret and everything shaped like one taken out. */
export function scrubSecrets(text: string, known: string[] = knownSecrets()): string {
  let out = text;
  for (const v of known) if (out.includes(v)) out = out.split(v).join('[secret removed]');
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}
