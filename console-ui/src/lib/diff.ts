/** A line diff for showing an edit: kept, removed and added lines, with a little context around changes. */

export type DiffLine = { kind: 'same' | 'del' | 'add' | 'gap'; text: string };

export function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText.split('\n');
  // Large edits: show old and new as blocks rather than spending time on a full diff.
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      all.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) all.push({ kind: 'del', text: a[i++]! });
    else all.push({ kind: 'add', text: b[j++]! });
  }
  while (i < n) all.push({ kind: 'del', text: a[i++]! });
  while (j < m) all.push({ kind: 'add', text: b[j++]! });
  // Keep only the changed lines and a few lines of context around them.
  const keep = all.map((l, k) => l.kind !== 'same' || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x.kind !== 'same'));
  const out: DiffLine[] = [];
  all.forEach((l, k) => {
    if (keep[k]) out.push(l);
    else if (out.at(-1)?.kind !== 'gap') out.push({ kind: 'gap', text: '' });
  });
  return out;
}
