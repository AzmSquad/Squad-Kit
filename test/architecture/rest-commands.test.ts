import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Hono } from 'hono';
import type { Command } from 'commander';
import { buildPaths } from '../../src/core/paths.js';
import { mountApi } from '../../src/console/api/index.js';
import { mountAppApi } from '../../src/console/api/app.js';
import { mountUpdateApi } from '../../src/console/api/update.js';
import { mountSupportApi } from '../../src/console/api/support.js';
import { requirementsCommand } from '../../src/commands/requirements.js';

/**
 * Design rule 3 (ADR-005): every action is one REST call, and every button has a terminal command. Each route that
 * changes something under /api/v1 is in rest-commands.json: with its `squad` command, as allowed with a reason (read
 * only, or the board's own state), or as a known gap with a reason. A new route needs one of the three.
 */

interface Listed {
  route: string;
  reason: string;
}
const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'rest-commands.json'), 'utf8')) as {
  commands: Record<string, string | string[]>;
  allowed: Listed[];
  knownGaps: Listed[];
};

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let dir = '';
let routes: string[] = [];

beforeAll(() => {
  // The routes as the app mounts them: the app's own, then one project's (console/server.ts, console/open-projects.ts).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-routes-'));
  const app = new Hono();
  mountAppApi(app, { projects: {} as never });
  mountUpdateApi(app, {} as never);
  mountSupportApi(app, { projects: {} as never });
  mountApi(app, { paths: buildPaths(dir) });
  routes = [...new Set(app.routes.filter((r) => CHANGES.has(r.method) && r.path.startsWith('/api/v1/')).map((r) => `${r.method} ${r.path}`))];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface CliCommand {
  args: boolean;
  options: Set<string>;
}

/** Every command in src/cli.ts, by its words ("app start"), read from the code: cli.ts runs as soon as it is imported. */
function cliCommands(): Map<string, CliCommand> {
  const file = path.resolve(__dirname, '../../src/cli.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found = new Map<string, CliCommand>([['', { args: false, options: new Set() }]]);
  const vars = new Map<string, string[]>([['program', []]]);
  const longName = (flags: string) => flags.split(/[ ,]+/).find((f) => f.startsWith('--'));
  // What a chain of calls stands for: `program.command('app')` is "app", and `.option(…)` keeps the same command.
  const commandOf = (e: ts.Expression): string[] | null => {
    if (ts.isIdentifier(e)) return vars.get(e.text) ?? null;
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return null;
    const on = commandOf(e.expression.expression);
    const first = e.arguments[0];
    if (!on || !first || !ts.isStringLiteral(first)) return on;
    const [name, ...args] = first.text.split(' ');
    if (e.expression.name.text === 'command') {
      const words = [...on, name!];
      found.set(words.join(' '), { args: args.length > 0, options: new Set() });
      return words;
    }
    if (e.expression.name.text === 'option') {
      const long = longName(first.text);
      if (long) found.get(on.join(' '))?.options.add(long);
    }
    return on;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const words = commandOf(n.initializer);
      if (words) vars.set(n.name.getText(sf), words);
    } else if (ts.isExpressionStatement(n)) commandOf(n.expression);
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  // `squad requirements` is built in its own file and added whole.
  const add = (c: Command, words: string[]) => {
    found.set(words.join(' '), { args: c.registeredArguments.length > 0, options: new Set(c.options.map((o) => o.long).filter((l): l is string => Boolean(l))) });
    for (const sub of c.commands) add(sub, [...words, sub.name()]);
  };
  add(requirementsCommand(), ['requirements']);
  return found;
}

/** Why a written command is not a real one, or null when it is. */
function notReal(line: string, cli: Map<string, CliCommand>): string | null {
  const words = line.split(' ');
  if (words.shift() !== 'squad') return 'it does not start with squad';
  let at: string[] = [];
  while (words.length && /^[a-z]/.test(words[0]!) && cli.has([...at, words[0]!].join(' '))) at = [...at, words.shift()!];
  const command = cli.get(at.join(' '))!;
  // A word right after an option is that option's value.
  const args = words.filter((w, i) => !w.startsWith('-') && !words[i - 1]?.startsWith('-'));
  if (args.length && !command.args) return `squad ${at.join(' ')} takes no ${args[0]}`;
  const flag = words.find((w) => w.startsWith('-') && !command.options.has(w));
  return flag ? `squad ${at.join(' ')} has no ${flag}` : null;
}

describe('every REST action has a terminal command', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('each route that changes something is on the list', () => {
    const listed = new Set([...Object.keys(map.commands), ...map.allowed.map((a) => a.route), ...map.knownGaps.map((g) => g.route)]);
    const missing = routes.filter((r) => !listed.has(r));
    expect(missing, 'Add each to test/architecture/rest-commands.json: its squad command, or why it has none.').toEqual([]);
  });

  it('each route is listed once, and only routes that exist', () => {
    const all = [...Object.keys(map.commands), ...map.allowed.map((a) => a.route), ...map.knownGaps.map((g) => g.route)];
    expect(all.filter((r, i) => all.indexOf(r) !== i)).toEqual([]);
    expect(all.filter((r) => !routes.includes(r))).toEqual([]);
  });

  it('each allowed route and known gap says why', () => {
    expect([...map.allowed, ...map.knownGaps].filter((x) => x.reason.trim().length < 20).map((x) => x.route)).toEqual([]);
  });

  it('each command is a real squad command with real options', () => {
    const cli = cliCommands();
    const wrong = Object.entries(map.commands).flatMap(([route, c]) =>
      (Array.isArray(c) ? c : [c]).flatMap((line) => {
        const why = notReal(line, cli);
        return why ? [`${route} → ${line}: ${why}`] : [];
      }),
    );
    expect(wrong).toEqual([]);
  });
});
