/**
 * The name, or with -2, -3 before its extension when it is taken, so two files never overwrite each other. Compared
 * without case, as a Mac's disk does.
 */
export function freeName(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i += 1) out = name.replace(/(\.[^.]*)?$/, (ext) => `-${i}${ext}`);
  taken.add(out.toLowerCase());
  return out;
}
