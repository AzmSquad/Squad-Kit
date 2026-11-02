import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { demoFolder } from '../src/commands/board.js';

describe('squad demo', () => {
  it('keeps the sample board in its own folder on this computer, never in the project the terminal is in', () => {
    expect(demoFolder()).toBe(path.join(process.env.SQUAD_KIT_HOME!, 'demo'));
    expect(demoFolder().startsWith(process.cwd())).toBe(false);
  });
});
