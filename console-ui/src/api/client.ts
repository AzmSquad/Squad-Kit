const TOKEN_KEY = 'squad.console.token';

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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new UnauthorizedError();
  const res = await fetch(path, {
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
export async function send<T>(path: string, method: 'POST' | 'PUT', payload: unknown = {}): Promise<T> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) throw new UnauthorizedError();
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw new UnauthorizedError();
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

/** Images can't send a header, so they carry the session token in the query string. */
export function assetUrl(path: string): string {
  const token = sessionStorage.getItem(TOKEN_KEY) ?? '';
  return `${path}?t=${encodeURIComponent(token)}`;
}
