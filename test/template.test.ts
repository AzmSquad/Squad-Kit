import { describe, it, expect } from 'vitest';
import { render } from '../src/core/template.js';

describe('render', () => {
  it('substitutes {{var}} tokens', () => {
    expect(render('hello {{name}}', { name: 'world' })).toBe('hello world');
  });
  it('trims whitespace inside tokens', () => {
    expect(render('{{  name  }}', { name: 'x' })).toBe('x');
  });
  it('treats unknown tokens as empty', () => {
    expect(render('a {{missing}} b', {})).toBe('a  b');
  });
  it('coerces numbers to strings', () => {
    expect(render('n={{n}}', { n: 42 })).toBe('n=42');
  });
  it('leaves non-matching braces alone', () => {
    expect(render('{single} {{x-y}} {}', { 'x-y': 'ok' })).toBe('{single} ok {}');
  });
});
