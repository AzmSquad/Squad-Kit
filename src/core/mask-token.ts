/** Masks API tokens for display (console secrets UI and GET /api/secrets). */
export function maskToken(t?: string): string | null {
  if (!t) return null;
  if (t.length <= 8) return '••••' + t.slice(-2);
  return t.slice(0, 4) + '…' + t.slice(-4);
}
