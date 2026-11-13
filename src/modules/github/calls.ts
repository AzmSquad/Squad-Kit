import { ModuleError, kindOfStatus } from '../errors.js';
import { githubApi, githubGraphql, githubToken } from './auth.js';

/**
 * How the tracker calls GitHub: REST, GraphQL and a file download. The real calls sign in through gh (auth.ts); tests
 * give their own. GraphQL's words for a missing scope or a missing issue become the shared error kinds, so the board's
 * ways out work.
 */

export interface GithubCalls {
  rest<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** A file GitHub keeps (an upload in an issue), with its type. */
  download(url: string): Promise<{ bytes: Buffer; type: string }>;
}

/** What to do when gh may not use Projects. */
const PROJECT_SCOPE = "GitHub's tool, gh, may not use Projects yet. Let it, then try again: gh auth refresh -s project";

function plainGithubError(err: unknown): unknown {
  if (!(err instanceof ModuleError) || err.kind !== 'other') return err;
  if (/required scopes|INSUFFICIENT_SCOPES|read:project/i.test(err.message)) return new ModuleError(PROJECT_SCOPE, 'sign-in');
  if (/Could not resolve to/i.test(err.message)) return new ModuleError(err.message, 'not-found');
  return err;
}

export function withPlainErrors(calls: GithubCalls): GithubCalls {
  return {
    rest: calls.rest,
    download: calls.download,
    graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      try {
        return await calls.graphql<T>(query, variables);
      } catch (err) {
        throw plainGithubError(err);
      }
    },
  };
}

/** At most 10 MB, as for every attachment. The sign-in goes only to github.com itself, never to where it sends on. */
async function download(url: string): Promise<{ bytes: Buffer; type: string }> {
  const token = /^https:\/\/github\.com\//.test(url) ? await githubToken() : null;
  let res: Response;
  try {
    res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'follow' });
  } catch (err) {
    throw new ModuleError(`GitHub could not be reached: ${(err as Error).message}`, 'offline');
  }
  if (!res.ok) throw new ModuleError(`GitHub said ${res.status} for a file in the issue.`, kindOfStatus(res.status), res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new ModuleError('The file is larger than 10 MB.');
  return { bytes, type: res.headers.get('content-type') ?? '' };
}

export const realCalls: GithubCalls = withPlainErrors({ rest: githubApi, graphql: githubGraphql, download });
