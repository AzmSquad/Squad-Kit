const TOKEN_KEY = 'squad.console.token';

/**
 * The project this page shows (ADR-001): every board address starts with /p/<project id>. The app's Home has none.
 * Switching projects loads the page again, so this is read once.
 */
export const PROJECT: string | null = (() => {
  const m = /^\/p\/([^/]+)/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
})();

/** Where this page's project lives in the app: the board's pages and its API sit under it. */
export const PROJECT_BASE = PROJECT ? `/p/${encodeURIComponent(PROJECT)}` : '';

/**
 * Every board call names its project: /api/v1/board on a project's page goes to /p/<project>/api/v1/board. This is
 * the one place that adds it, so every page keeps calling the addresses one board always had. The app's own calls,
 * under /api/v1/app/, go as they are.
 */
export function apiPath(path: string): string {
  if (!PROJECT_BASE || !path.startsWith('/api/') || path.startsWith('/api/v1/app/')) return path;
  return PROJECT_BASE + path;
}

export function bootstrapToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('t');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Session token missing or invalid. Reopen squad console.');
    this.name = 'UnauthorizedError';
  }
}

/** An answer that said no. 400 is a plain-words reason from squad-kit; 500 is a problem squad-kit did not expect. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when the same action may work if sent again: no answer, or a problem squad-kit did not expect. */
export function worthRetrying(err: unknown): boolean {
  return err instanceof Error && (err.message === NO_ANSWER || (err instanceof ApiError && err.status >= 500));
}

/** The app did not answer at all (it stopped, or the computer went to sleep): say so in plain words. */
export const NO_ANSWER = 'squad-kit did not answer, so nothing changed. Check that it still runs in its terminal, then try again.';

async function reach(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(NO_ANSWER);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new UnauthorizedError();
  const res = await reach(apiPath(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return (await res.json()) as T;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

/** API errors carry the server's plain-words message, so the UI can show it as is. */
export async function send<T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', payload: unknown = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new UnauthorizedError();
  const res = await reach(apiPath(path), {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

/** Images can't send a header, so they carry the session token in the query string. */
/** A file the squad made for a ticket (picture, recording, document), served only from the ticket's own folders. */
export function ticketFileUrl(ticketId: string, file: string): string {
  const token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return `${apiPath(`/api/v1/tickets/${encodeURIComponent(ticketId)}/file`)}?path=${encodeURIComponent(file.replace(/^file:\/\//, ''))}&t=${encodeURIComponent(token)}`;
}

export function assetUrl(path: string): string {
  const token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return `${apiPath(path)}?t=${encodeURIComponent(token)}`;
}
