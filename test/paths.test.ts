import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSquadRoot, buildPaths, slugify, SQUAD_DIR } from '../src/core/paths.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-paths-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findSquadRoot', () => {
  it('returns null when no .squad/ exists upward', () => {
    expect(findSquadRoot(tmp)).toBeNull();
  });

  it('finds .squad/ in the start directory', () => {
    fs.mkdirSync(path.join(tmp, SQUAD_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'config.yaml'), 'version: 1\n');
    expect(findSquadRoot(tmp)).toBe(path.resolve(tmp));
  });

  it('walks upward to find .squad/', () => {
    const nested = path.join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(tmp, SQUAD_DIR), { recursive: true });
    fs.writeFileSync(path.join(tmp, SQUAD_DIR, 'config.yaml'), 'version: 1\n');
    expect(findSquadRoot(nested)).toBe(path.resolve(tmp));
  });
});

describe('buildPaths', () => {
  it('produces .squad-relative paths', () => {
    const p = buildPaths('/root');
    expect(p.configFile).toBe(path.join('/root', SQUAD_DIR, 'config.yaml'));
    expect(p.secretsFile).toBe(path.join('/root', SQUAD_DIR, 'secrets.yaml'));
    expect(p.promptsDir).toBe(path.join('/root', SQUAD_DIR, 'prompts'));
    expect(p.storiesDir).toBe(path.join('/root', SQUAD_DIR, 'stories'));
    expect(p.plansDir).toBe(path.join('/root', SQUAD_DIR, 'plans'));
    expect(p.indexFile).toBe(path.join('/root', SQUAD_DIR, 'plans', '00-index.md'));
    expect(p.trashDir).toBe(path.join('/root', SQUAD_DIR, '.trash'));
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add Guest Checkout')).toBe('add-guest-checkout');
  });
  it('strips leading/trailing separators', () => {
    expect(slugify('  ---hello---  ')).toBe('hello');
  });
  it('handles non-ASCII letters', () => {
    expect(slugify('café order')).toBe('café-order');
  });
  it('collapses multiple separators', () => {
    expect(slugify('foo  ---  bar')).toBe('foo-bar');
  });
});
