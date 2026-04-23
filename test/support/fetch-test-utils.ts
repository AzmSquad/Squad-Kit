/** Narrow `vi.fn` mock.calls for typed fetch assertions. */
export function firstFetchCall(mock: { mock: { calls: unknown[][] } }): { url: string; init?: RequestInit } {
  const raw = mock.mock.calls[0] as [string, RequestInit?] | undefined;
  if (!raw) throw new Error('expected fetch to have been called');
  const [url, init] = raw;
  return { url, init };
}
