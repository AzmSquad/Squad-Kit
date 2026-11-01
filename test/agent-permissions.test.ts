import { describe, it, expect } from 'vitest';
import { WRITE_TOOLS, deniedTools } from '../src/engine/claude.js';
import { answerPermission } from '../src/engine/acp-runner.js';
import { READ_ONLY } from '../src/engine/live.js';

const OPTIONS = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'always', kind: 'allow_always' },
  { optionId: 'no', kind: 'reject_once' },
];

describe('agents only get the tools their step gives them', () => {
  it('says no to every permission question', () => {
    expect(answerPermission({ options: OPTIONS })).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    expect(answerPermission({ options: [{ optionId: 'never', kind: 'reject_always' }, { optionId: 'yes', kind: 'allow_once' }] })).toEqual({ outcome: { outcome: 'selected', optionId: 'never' } });
    expect(answerPermission({ options: [{ optionId: 'yes', kind: 'allow_once' }] })).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('denies the file-changing tools to a step that only reads', () => {
    const denied = deniedTools({ cwd: '/app', prompt: '', allowedTools: READ_ONLY });
    for (const t of WRITE_TOOLS) expect(denied).toContain(t);
    expect(denied).not.toContain('Bash');
  });

  it('leaves them to a step that builds', () => {
    const denied = deniedTools({ cwd: '/app', prompt: '', allowedTools: ['Read', 'Edit', 'Write', 'Bash'], disallowedTools: ['Bash(git push:*)'] });
    expect(denied).toEqual(['Bash(git push:*)']);
  });

  it('lets a reading step look around with the shell, but not change anything with it', () => {
    expect(READ_ONLY).toContain('Bash(cat:*)');
    expect(READ_ONLY).toContain('Bash(git diff:*)');
    expect(READ_ONLY).not.toContain('Bash');
    expect(READ_ONLY.some((t) => /Bash\((rm|mv|cp|touch|sed|find|node|npm|npx|git (commit|push|checkout|reset)):/.test(t))).toBe(false);
  });
});
