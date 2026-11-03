import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { squadHome } from './home.js';

/**
 * Keeps secrets out of what squad-kit writes for people to read or send on: the app log and Report a problem. Known
 * values (the sign-ins in secrets.yaml, the board's private link token, secret-looking environment variables) are
 * taken out by value, and anything shaped like a key, a token or a password by its shape.
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  [/\bsk-ant-[\w-]{10,}/g, '[key removed]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[key removed]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[token removed]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[token removed]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[token removed]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[token removed]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[key removed]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[key removed]'],
  // A signed token (JWT).
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[token removed]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [token removed]'],
  // A password in a link: https://name:password@host.
  [/(\/\/[^/\s:@]+):[^/\s@]+@/g, '$1:[password removed]@'],
  [/([?&](?:t|token|access_token|key|api_key|code|sig|password)=)[^&\s"'<>]+/gi, '$1[removed]'],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pat|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1[removed]'],
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

/** The text with every known secret and everything shaped like one taken out. */
export function scrubSecrets(text: string, known: string[] = knownSecrets()): string {
  let out = text;
  for (const v of known) if (out.includes(v)) out = out.split(v).join('[secret removed]');
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}
