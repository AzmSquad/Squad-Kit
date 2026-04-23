import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Budget } from '../src/planner/budget.js';
import { readFileTool } from '../src/planner/tools.js';

let tmp: string;
let budget: Budget;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-tools-'));
  budget = new Budget({
    maxFileReads: 10,
    maxContextBytes: 100_000,
    maxDurationSeconds: 60,
  });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('readFileTool', () => {
  it('returns file content for a repo-relative path', () => {
    fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello world');
    const r = readFileTool(tmp, budget, { path: 'hello.txt' });
    expect(r.isError).toBe(false);
    expect(r.content).toBe('hello world');
  });

  it('refuses absolute paths outside the project', () => {
    const outsideAbs = path.resolve(path.dirname(tmp), `outside-abs-${Date.now()}.txt`);
    fs.writeFileSync(outsideAbs, 'x');
    const r = readFileTool(tmp, budget, { path: outsideAbs });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/escapes the project root/);
  });

  it('refuses path traversal via relative segments', () => {
    const outside = path.join(path.dirname(tmp), `outside-rel-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret');
    const rel = path.relative(tmp, outside);
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);
    const r = readFileTool(tmp, budget, { path: rel });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/escapes the project root/);
  });

  it('refuses directories', () => {
    fs.mkdirSync(path.join(tmp, 'dir'), { recursive: true });
    const r = readFileTool(tmp, budget, { path: 'dir' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/directory/);
  });

  it('refuses missing files', () => {
    const r = readFileTool(tmp, budget, { path: 'nope.txt' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not found/);
  });

  it('refuses files larger than per-read cap', () => {
    const big = Buffer.alloc(33_000, 97);
    fs.writeFileSync(path.join(tmp, 'big.txt'), big);
    const r = readFileTool(tmp, budget, { path: 'big.txt' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/33000 bytes/);
  });

  it('refuses binary content', () => {
    fs.writeFileSync(path.join(tmp, 'bin.dat'), Buffer.from([0x48, 0x00, 0x49]));
    const r = readFileTool(tmp, budget, { path: 'bin.dat' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/binary/);
  });

  it('returns error without reading when budget is exhausted', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    const b = new Budget({
      maxFileReads: 0,
      maxContextBytes: 100_000,
      maxDurationSeconds: 60,
    });
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const r = readFileTool(tmp, b, { path: 'a.txt' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/max file reads/);
    expect(readSpy).not.toHaveBeenCalled();
  });
});
