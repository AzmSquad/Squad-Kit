/**
 * Files in `.squad` are written by people, merges and outside tools too. These checks say whether a file has the shape
 * the pages read, so a wrong type in one field is a plain problem the person sees, never a page that crashes.
 */

export type FieldShape = 'text' | 'texts' | 'object' | 'objects' | 'yes-no' | 'number';

const IS: Record<FieldShape, (x: unknown) => boolean> = {
  text: (x) => typeof x === 'string',
  texts: (x) => Array.isArray(x) && x.every((y) => typeof y === 'string'),
  object: (x) => isPlain(x),
  objects: (x) => Array.isArray(x) && x.every(isPlain),
  'yes-no': (x) => typeof x === 'boolean',
  number: (x) => typeof x === 'number' && Number.isFinite(x),
};

export function isPlain(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** The first field written in the wrong form, in words for engineers, or null. A field that is not there is fine. */
export function wrongField(o: Record<string, unknown>, fields: Record<string, FieldShape>): string | null {
  for (const [key, shape] of Object.entries(fields)) {
    if (o[key] !== undefined && o[key] !== null && !IS[shape](o[key])) return `"${key}" is not in the right form.`;
  }
  return null;
}

/** The marks of a merge both people changed, in their order. A row of equals alone is a Markdown heading. */
export function hasMergeMarks(text: string): boolean {
  return /^<{7}( |$)[\s\S]*?^={7}\s*$[\s\S]*?^>{7}( |$)/m.test(text);
}
