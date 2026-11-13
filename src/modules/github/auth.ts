import { execFile } from 'node:child_process';
import { ModuleError, kindOfStatus } from '../errors.js';

/**
 * GitHub's sign-in for squad-kit: GitHub's own tool, gh, signed in by the person. squad-kit asks it for the token on
 * each call and keeps none. The pull request and tracker modules both call GitHub through here.
 */

const API = 'https://api.github.com';

/** The token gh holds for github.com, or null when gh is missing or not signed in. */
export function githubToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000 }, (err, out) => {
      const token = String(out ?? '').trim();
      resolve(err || !token ? null : token);
    });
  });
}

async function signedIn(): Promise<string> {
  const token = await githubToken();
  if (!token) throw new ModuleError('squad-kit is not signed in to GitHub. Sign in with GitHub\'s own tool: gh auth login', 'sign-in');
  return token;
}

/** One REST call. A path starts with "/"; the answer is JSON, or nothing for 204. */
export async function githubApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await signedIn();
  let res: Response;
  try {
    res = await fetch(API + path, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new ModuleError(`GitHub could not be reached: ${(err as Error).message}`, 'offline');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // Not JSON: the text is the message.
    }
    throw new ModuleError(`GitHub said ${res.status}: ${message.slice(0, 300)}`, kindOfStatus(res.status), res.status);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** One GraphQL call, for what REST cannot do (Projects). */
export async function githubGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const answer = await githubApi<{ data?: T; errors?: { message: string }[] }>('/graphql', { method: 'POST', body: { query, variables } });
  if (answer.errors?.length) throw new ModuleError(`GitHub said: ${answer.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return answer.data as T;
}
