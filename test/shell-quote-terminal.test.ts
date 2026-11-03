import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellArg, shellQuote } from '../src/utils/text.js';
import { shellArg as boardArg, shellQuote as boardQuote } from '../console-ui/src/lib/text.js';
import { offerCommand } from '../src/commands/now.js';

/**
 * Commands squad-kit shows for the person to copy, with their own words in them: a question, a name, an address. A
 * shell reads each value back exactly as written and runs none of it, on the terminal and on the board alike.
 */

const TRICKY = ['Log in', "Don't", 'Costs $5 $(echo ran)', 'a `id` b', 'ends in \\', 'Say "hi" !now', "it's $HOME", '; rm -rf ~', '#not a comment', 'a\nb', ''];

/** What /bin/sh hands the program as its arguments, one per line. */
const argsOf = (line: string) => execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' });

describe('quoting for a shell, on the terminal side', () => {
  it('quotes plain text in double quotes, and text a shell would read in single quotes', () => {
    expect(shellQuote('Log in with Google')).toBe('"Log in with Google"');
    expect(shellQuote('Costs $5')).toBe("'Costs $5'");
    expect(shellQuote("It's `date`")).toBe(`'It'\\''s \`date\`'`);
  });

  it('leaves a plain name or address as one bare word, and quotes the rest', () => {
    expect(shellArg('Sara')).toBe('Sara');
    expect(shellArg('http://localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(shellArg('AB#4133')).toBe('AB#4133');
    expect(shellArg('Sara Ali')).toBe('"Sara Ali"');
    expect(shellArg('#4133')).toBe('"#4133"');
    expect(shellArg('http://x.test/?a=1&b=2')).toBe('"http://x.test/?a=1&b=2"');
  });

  it.skipIf(process.platform === 'win32')('a shell reads every value back as it was written, and runs none of it', () => {
    for (const x of TRICKY) {
      expect(argsOf(shellQuote(x))).toBe(`${x}\n`);
      expect(argsOf(shellArg(x))).toBe(`${x}\n`);
    }
  });

  it('is the same rule as the board uses', () => {
    for (const x of TRICKY) {
      expect(shellQuote(x)).toBe(boardQuote(x));
      expect(shellArg(x)).toBe(boardArg(x));
    }
  });
});

describe('squad ask: the ways on an answer', () => {
  it.skipIf(process.platform === 'win32')('keep the question as one argument a shell never runs', () => {
    const t = { id: 'SK-12' };
    for (const question of ['is it "done"? $(touch /tmp/x)', 'why `whoami`', 'ends in \\']) {
      const propose = offerCommand(t, { do: 'propose', label: 'Propose a change', note: '' }, question);
      expect(propose.startsWith('squad propose SK-12 ')).toBe(true);
      expect(argsOf(propose.slice('squad propose SK-12 '.length))).toBe(`${question}\n`);
      const note = offerCommand(t, { do: 'note', label: 'Tell the Builder', note: '', to: 'builder' }, question);
      expect(argsOf(note.slice('squad message SK-12 --to builder '.length))).toBe(`${question}\n`);
    }
  });
});
