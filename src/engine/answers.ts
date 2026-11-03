/**
 * An agent's answer, checked against the shape its step asked for before squad-kit uses it. The shapes are the small
 * part of JSON Schema the steps use (type, properties, required, items, enum, minItems, maxItems); anything else in a
 * schema is not checked.
 */

interface Shape {
  type?: string;
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
}

/** What is wrong with the answer, in a few words ("comments is missing"), or null when it fits. */
export function answerProblem(schema: object, value: unknown): string | null {
  if (value === undefined || value === null) return 'there is no answer';
  return problem(schema as Shape, value, '');
}

function problem(shape: Shape, value: unknown, at: string): string | null {
  const name = at || 'the answer';
  if (shape.type && !fits(shape.type, value)) return `${name} is not ${KIND[shape.type] ?? shape.type}`;
  if (shape.enum && !shape.enum.includes(value)) return `${name} is not one of ${shape.enum.join(', ')}`;
  if (Array.isArray(value)) {
    if (shape.minItems !== undefined && value.length < shape.minItems) return `${name} has fewer than ${shape.minItems} items`;
    if (shape.maxItems !== undefined && value.length > shape.maxItems) return `${name} has more than ${shape.maxItems} items`;
    if (shape.items) {
      for (const [i, item] of value.entries()) {
        const p = problem(shape.items, item, `${at || 'item'}[${i}]`);
        if (p) return p;
      }
    }
  } else if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    for (const key of shape.required ?? []) if (o[key] === undefined || o[key] === null) return `${at ? `${at}.` : ''}${key} is missing`;
    for (const [key, sub] of Object.entries(shape.properties ?? {})) {
      // An empty optional part is the same as one left out.
      if (o[key] === undefined || o[key] === null) continue;
      const p = problem(sub, o[key], at ? `${at}.${key}` : key);
      if (p) return p;
    }
  }
  return null;
}

const KIND: Record<string, string> = {
  object: 'an object',
  array: 'a list',
  string: 'text',
  boolean: 'true or false',
  integer: 'a whole number',
  number: 'a number',
  null: 'empty',
};

function fits(type: string, v: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

/**
 * The design's "depends on" list, checked against the board: each name must be another open ticket, not this one.
 * A wrong name is asked for once more, like a broken answer; after that, names that are not open tickets are left out.
 */
export function dependsProblem(value: unknown, open: string[], self: string): string | null {
  const list = (value as { dependsOn?: unknown } | null)?.dependsOn;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return 'dependsOn is not a list';
  const known = new Set(open.map((x) => x.toUpperCase()));
  for (const item of list) {
    if (typeof item !== 'string') return 'dependsOn has an item that is not text';
    const name = item.trim().toUpperCase();
    if (name === self.toUpperCase()) return `dependsOn names ${self}, this ticket itself`;
    if (!known.has(name)) return `dependsOn names ${item.trim() || 'an empty name'}, which is not an open ticket on this board${open.length ? ` (open: ${open.join(', ')})` : ' (there are none)'}`;
  }
  return null;
}

/** What the overview needs from the read of a project that has code. */
const OVERVIEW_PARTS = ['users', 'can', 'worth', 'ideas', 'parts', 'links'] as const;

/**
 * What the shapes cannot say about the first read of a project: a project with code hands in the overview's parts
 * (who uses it, what it can do, what is worth knowing, ticket ideas, the parts of the code and their links), no two
 * parts share an id, and every link joins two parts the answer has. Null when it holds. squad-kit asks once more;
 * after that it keeps what fits, so an answer in the older shape still works.
 */
export function scanProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.empty !== true) for (const key of OVERVIEW_PARTS) if (v[key] === undefined || v[key] === null) return `${key} is missing`;
  return partsProblem(value);
}

/** No two parts of the code share an id, and every link joins two parts the answer has. */
export function partsProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { parts?: unknown; links?: unknown };
  const ids = (Array.isArray(v.parts) ? v.parts : []).map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined));
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return `two parts have the id "${String(twice)}"`;
  const known = new Set(ids);
  for (const [i, l] of (Array.isArray(v.links) ? v.links : []).entries()) {
    const link = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    for (const end of ['from', 'to'] as const) {
      if (!known.has(link[end])) return `links[${i}].${end} names no part ("${String(link[end])}")`;
    }
  }
  return null;
}
