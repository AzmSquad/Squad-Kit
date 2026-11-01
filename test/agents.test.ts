import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardPaths, type BoardPaths } from '../src/board/store.js';
import { agentInstructions, ensureAgents, readAgent, roleForPhase, writeAgent } from '../src/engine/agents.js';

let tmp: string;
let bp: BoardPaths;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-agents-'));
  bp = boardPaths(path.join(tmp, '.squad'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('agents', () => {
  it('gives every role an editable file with no instructions yet', () => {
    ensureAgents(bp);
    expect(fs.readdirSync(bp.rulesDir).sort()).toEqual(['analyst.md', 'architect.md', 'builder.md', 'reviewer.md', 'tester.md']);
    const builder = readAgent(bp, 'builder');
    expect(builder).toMatchObject({ tool: 'claude', model: '' });
    expect(agentInstructions(builder)).toBe('');
  });

  it('keeps edits and turns them into system prompt text', () => {
    ensureAgents(bp);
    writeAgent(bp, 'reviewer', { model: 'opus', instructions: 'Check every form for Arabic labels.' });
    const r = readAgent(bp, 'reviewer');
    expect(r).toMatchObject({ tool: 'claude', model: 'opus', instructions: 'Check every form for Arabic labels.' });
    expect(agentInstructions(r)).toContain('for the Reviewer');
    expect(fs.readFileSync(path.join(bp.rulesDir, 'reviewer.md'), 'utf8')).toBe('---\ntool: claude\nmodel: opus\n---\nCheck every form for Arabic labels.\n');
    // An edit made by hand in the file is read the same way.
    fs.writeFileSync(path.join(bp.rulesDir, 'tester.md'), '---\ntool: claude\nmodel: sonnet\n---\nUse a phone-sized screen.\n');
    expect(readAgent(bp, 'tester')).toMatchObject({ model: 'sonnet', instructions: 'Use a phone-sized screen.' });
  });

  it('refuses unknown tools and odd model names', () => {
    expect(() => writeAgent(bp, 'builder', { tool: 'gpt' as never })).toThrow(/not a tool/);
    expect(() => writeAgent(bp, 'builder', { model: 'rm -rf /' })).toThrow(/one word/);
  });

  it('knows which agent runs each step', () => {
    expect(roleForPhase('plan-write')).toBe('architect');
    expect(roleForPhase('review')).toBe('reviewer');
    expect(roleForPhase('publish')).toBeNull();
  });
});
