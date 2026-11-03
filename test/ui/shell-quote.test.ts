import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellQuote, withoutComments } from '../../console-ui/src/lib/text.js';

describe('commands the person copies into a terminal', () => {
  it('plain text keeps its double quotes', () => {
    expect(shellQuote('Log in with Google')).toBe('"Log in with Google"');
    expect(shellQuote("Don't log out")).toBe('"Don\'t log out"');
  });

  it('text a shell would read goes in single quotes', () => {
    expect(shellQuote('Costs $5')).toBe("'Costs $5'");
    expect(shellQuote('Say "hi"')).toBe(`'Say "hi"'`);
    expect(shellQuote("It's `date`")).toBe(`'It'\\''s \`date\`'`);
  });

  it.skipIf(process.platform === 'win32')('a shell reads every value back as it was written, and runs none of it', () => {
    for (const x of ['Log in', "Don't", 'Costs $5 $(echo ran)', 'a `id` b', 'ends in \\', 'Say "hi" !now', "it's $HOME"]) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(x)}`], { encoding: 'utf8' })).toBe(x);
    }
  });
});

describe('template comments', () => {
  it('go, a comment split by another too', () => {
    expect(withoutComments('Use our logger.<!-- a hint -->')).toBe('Use our logger.');
    expect(withoutComments('<!<!-- a -->-- b -->')).toBe('');
  });
});
