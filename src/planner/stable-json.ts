/**
 * Recursively sort object keys for deterministic JSON.stringify of nested records.
 * Arrays are preserved; only plain objects (not null, not array) are sorted.
 */
export function sortRecordKeys<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => sortRecordKeys(x)) as T;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    out[k] = sortRecordKeys(o[k]);
  }
  return out as T;
}
