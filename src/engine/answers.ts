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
