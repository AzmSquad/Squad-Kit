import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Hono } from 'hono';
import { crc32, zip } from '../src/core/zip.js';
import { isSecretFile, scrubSecrets } from '../src/core/scrub.js';
import { logsDir, writeLog } from '../src/core/app-log.js';
import { boardPaths, readMeta, updateTicket, writeMeta, type BoardPaths } from '../src/board/store.js';
import { createTicket } from '../src/board/actions.js';
import { ensureLiveBoard, setupProject } from '../src/engine/setup.js';
import { planReport, reportEntries, reportFolder, reportName, writeReport, type ReportResult, type Versions } from '../src/engine/report.js';
import { endPause, startPause } from '../src/engine/usage-limit.js';
import { mountSupportApi } from '../src/console/api/support.js';
import { runReport } from '../src/commands/support.js';
import { chooseProject } from '../src/core/paths.js';
import { forgetProject, rememberProject } from '../src/core/projects.js';

/**
 * Report a problem (phase 10): one .zip any standard unzip opens, with the ticket's state, its conversations, the log
 * for 24 hours, the versions and a README.txt. Never secrets.yaml, console.json, tokens or .env files.
 */

/** Reads a zip back the way any unzip does: from the central directory. */
function unzipped(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + packed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString('utf8');
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const VERSIONS: Versions = { squadKit: '1.1.0', node: 'v22.11.0', git: 'git version 2.47.0', system: 'macOS 26.0 (darwin 27.0.0, arm64)', tools: [{ name: 'Claude Code', version: '2.1.296 (Claude Code), ACP adapter 0.99.1' }] };

// Secrets this computer holds; none of them may reach a report.
const AZURE_PAT = 'k3q7zlx2v5m4n6b2c7d3f4g5h6j7k2l3m4n5p6q7r2s3t4v5w6x7';
const SPEECH_KEY = 'munsit-live-9f8e7d6c5b4a3210';
const LINK_TOKEN = 'ab'.repeat(32);
const API_KEY = 'sk-ant-api03-ZXCVBNMASDFGHJKLQWERTY123456';

let tmp: string;
let bp: BoardPaths;
let id: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-report-')));
  const dir = path.join(tmp, 'roomflow');
  fs.mkdirSync(dir);
  setupProject(dir);
  ({ bp } = ensureLiveBoard(boardPaths(path.join(dir, '.squad')), 'roomflow'));
  writeMeta(bp, { ...readMeta(bp), scan: { status: 'done' }, runner: 'direct', git: { base: 'main', remote: `https://momen:${AZURE_PAT}@dev.azure.com/org/_git/roomflow` } });
  fs.mkdirSync(bp.localDir, { recursive: true });
  fs.writeFileSync(bp.secretsFile, `tracker:\n  azure:\n    organization: org\n    pat: ${AZURE_PAT}\nspeech:\n  munsit: ${SPEECH_KEY}\n`);
  fs.writeFileSync(bp.consoleFile, JSON.stringify({ pid: 1, port: 4571, token: LINK_TOKEN }));
  fs.writeFileSync(path.join(dir, '.env'), `ANTHROPIC_API_KEY=${API_KEY}\n`);
  const t = createTicket(bp, { title: 'Show room capacity' });
  id = t.id;
  // A conversation that quotes a secret, and a step that stopped with the exact error.
  updateTicket(bp, id, (x) => {
    x.sessions = { build: '11111111-2222-3333-4444-555555555555' };
    x.steps = [
      { title: 'Read the code', status: 'done', minutes: 2 },
      { title: 'Add the capacity column', status: 'done', minutes: 5 },
      { title: 'Show it on the room page', status: 'todo' },
    ];
    x.stage = 'implement';
    x.retryPhase = 'build';
    x.waiting = { kind: 'stuck', summary: 'The squad stopped and needs you' };
    x.stuck = { question: 'Claude Code is not logged in. Run `claude` in a terminal, log in, then press Try again.', detail: `401 {"error":"invalid x-api-key ${API_KEY}"}`, options: [{ do: 'retry', name: 'Try again', note: '' }] };
    x.notes = [{ at: new Date().toISOString(), by: 'Momen', kind: 'note', text: `the staging password is in vault, token=${LINK_TOKEN}` }];
  });
  fs.mkdirSync(bp.chatsDir, { recursive: true });
  fs.writeFileSync(
    path.join(bp.chatsDir, '11111111-2222-3333-4444-555555555555.jsonl'),
    [
      { at: new Date().toISOString(), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `I will use Bearer ${SPEECH_KEY}abcdef to call the API` } } },
      { at: new Date().toISOString(), update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo'.repeat(200) } }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  fs.rmSync(logsDir(), { recursive: true, force: true });
  writeLog({ level: 'error', project: 'roomflow', ticket: id, text: 'Stopped at build: Claude Code is not logged in' });
  writeLog({ text: 'two days ago' }, new Date(Date.now() - 2 * 86_400_000));
  process.env.SQUAD_TEST_API_KEY = 'env-secret-value-123456';
});

afterEach(() => {
  delete process.env.SQUAD_TEST_API_KEY;
  chooseProject(null);
  endPause();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the zip writer', () => {
  it('writes a zip any unzip reads: deflated or stored, UTF-8 names, the right checksums', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const buf = zip([
      { name: 'README.txt', data: 'hello '.repeat(200) },
      { name: 'logs/عربي.txt', data: 'مرحبا' },
      { name: 'tiny.bin', data: Buffer.from([1, 2, 3]) },
    ]);
    const files = unzipped(buf);
    expect(Object.keys(files)).toEqual(['README.txt', 'logs/عربي.txt', 'tiny.bin']);
    expect(files['README.txt']).toBe('hello '.repeat(200));
    expect(files['logs/عربي.txt']).toBe('مرحبا');
    expect(() => zip([{ name: '../x', data: '' }])).toThrow(/safe name/);
    expect(() => zip([{ name: 'a', data: '' }, { name: 'a', data: '' }])).toThrow(/Two files/);
  });

  it.skipIf(!hasUnzip)('opens with the standard unzip', () => {
    const file = path.join(tmp, 'check.zip');
    fs.writeFileSync(file, zip([{ name: 'README.txt', data: 'hello '.repeat(200) }, { name: 'a/b.txt', data: 'b' }]));
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toMatch(/No errors detected/);
    expect(execFileSync('unzip', ['-p', file, 'a/b.txt'], { encoding: 'utf8' })).toBe('b');
  });
});

describe('scrubbing secrets', () => {
  it('takes out known values and anything shaped like a key, a token or a password', () => {
    const text = [
      `pat ${AZURE_PAT}`,
      `https://momen:pass1234@host/repo`,
      'Authorization: Bearer abcdefghijklmnop.qrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'password: hunter2hunter2',
      '"apiKey":"abcdef123456"',
      'commit 0123456789abcdef0123456789abcdef01234567 stays',
      'link ?t=deadbeef',
    ].join('\n');
    const out = scrubSecrets(text, ['my-known-secret-value']);
    for (const gone of [AZURE_PAT, 'pass1234', 'abcdefghijklmnop.qrstuvwx', 'ghp_abc', 'eyJhbGci', 'hunter2hunter2', 'abcdef123456', 'deadbeef']) expect(out).not.toContain(gone);
    expect(out).toContain('0123456789abcdef0123456789abcdef01234567 stays');
    expect(scrubSecrets('a my-known-secret-value b', ['my-known-secret-value'])).toBe('a [secret removed] b');
    for (const name of ['secrets.yaml', 'projects/x/console.json', '.env', '.env.local', 'id_rsa', 'server.pem', 'app.json']) expect(isSecretFile(name), name).toBe(true);
    expect(isSecretFile('ticket/RO-7.yaml')).toBe(false);
  });
});

describe('a corpus of secrets', () => {
  // Made up, and put together here so nothing that scans this repo takes them for real ones.
  const LIVE = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_');
  const RESTRICTED = ['rk', 'test', 'abcdefghijklmnopqrstuvwx'].join('_');
  const HOOK = ['whsec', 'abcdefghijklmnopqrstuvwx'].join('_');
  const NPM = ['npm', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
  const MAIL = ['SG', 'abcdefghijklmnopqrstuv', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

  it.each([
    ['a database password in an env line', 'DB_PASSWORD=hunter2', 'hunter2'],
    ['a short one', 'DB_PASS=abc', 'abc'],
    ['a name with no underscore', 'PGPASSWORD=hunter2', 'hunter2'],
    ['exported', 'export MYSQL_ROOT_PASSWORD=hunter2', 'hunter2'],
    ['in quotes, with a space', 'DB_PASSWORD="my long pass"', 'my long pass'],
    ['with a comma in it', 'DB_PASSWORD=pa,ss;word', 'ss;word'],
    ['a secret', 'JWT_SECRET=abc', 'abc'],
    ['a secret key base', 'SECRET_KEY_BASE=abcdef012345', 'abcdef012345'],
    ['an env key', 'STRIPE_KEY=abcdef', 'abcdef'],
    ['a token', 'GITHUB_TOKEN=abc', 'abc'],
    ['lower case in settings', 'db_password: hunter2', 'hunter2'],
    ['camel case', 'dbPassword: "hunter2"', 'hunter2'],
    ['with dots', '"db.password": "hunter2"', 'hunter2'],
    ['json', '{"clientSecret":"abcdef123456","other":1}', 'abcdef123456'],
    ['a connection string', 'Server=db;User Id=sa;Password=hunter2;', 'hunter2'],
    ['a command option', 'tool --password hunter2 --verbose', 'hunter2'],
    ['a live payment key', LIVE, LIVE],
    ['a restricted test key', RESTRICTED, RESTRICTED],
    ['a webhook secret', HOOK, HOOK],
    ['an npm token', NPM, NPM],
    ['a mail service key', MAIL, MAIL],
    ['a temporary cloud key', ['ASIA', 'ABCDEFGHIJKLMNOP'].join(''), 'ABCDEFGHIJKLMNOP'],
  ])('takes out %s', (_what, line, secret) => {
    const out = scrubSecrets(`before\n${line}\nafter`, []);
    expect(out).not.toContain(secret);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('an empty setting does not take the line after it', () => {
    expect(scrubSecrets('DB_PASSWORD=\nPORT=3000', [])).toContain('PORT=3000');
    expect(scrubSecrets('password:\nnext line stays', [])).toContain('next line stays');
  });

  it('leaves the words engineers need', () => {
    const line = [
      'MAX_TOKENS=4096',
      'NODE_ENV=development',
      'tokens: 1500',
      '"input_tokens": 1234',
      'PORT=3000',
      'PASS  src/login.test.ts',
      'commit 0123456789abcdef0123456789abcdef01234567',
      'password field shows an error',
    ].join('\n');
    expect(scrubSecrets(line, [])).toBe(line);
  });

  it("takes the project's own .env and local file values out by value, even where no shape would catch them", () => {
    const repo = path.join(path.dirname(bp.squadDir), 'api');
    fs.mkdirSync(repo, { recursive: true });
    const root = path.dirname(bp.squadDir);
    fs.writeFileSync(path.join(root, '.env'), ['# local', 'DB_PASSWORD=plainword', 'CUSTOM_THING=a1b2c3d4e5', 'export QUOTED="quoted value 9"', 'NODE_ENV=development', 'PORT=3000', 'DEBUG=true', 'APP_URL=http://localhost:3000'].join('\n'));
    fs.writeFileSync(path.join(root, '.env.local'), 'LOCAL_ONLY=z9y8x7w6v5\n');
    fs.writeFileSync(path.join(root, '.env.example'), 'EXAMPLE_ONE=changeme123\n');
    fs.writeFileSync(path.join(repo, 'appsettings.Development.json'), JSON.stringify({ ConnectionStrings: { Default: 'Server=db1;Database=cases' }, Mail: { Sender: 'mail-sender-77' } }));
    fs.writeFileSync(path.join(repo, 'local.yaml'), 'nested:\n  apiPassword: yamlpass\n');
    const meta = readMeta(bp);
    writeMeta(bp, { ...meta, repos: [{ path: 'api', base: 'main', remote: '', commands: {} } as never], localFiles: [{ repo: 'api', path: 'appsettings.Development.json' }, { repo: 'api', path: 'local.yaml' }] });
    updateTicket(bp, id, (t) => (t.status = 'plainword a1b2c3d4e5 quoted value 9 z9y8x7w6v5 Server=db1;Database=cases mail-sender-77 yamlpass changeme123 development 3000 true http://localhost:3000'));
    const files = unzipped(zip(reportEntries({ bp, ticket: id, versions: VERSIONS })));
    const all = Object.values(files).join('\n');
    for (const value of ['plainword', 'a1b2c3d4e5', 'quoted value 9', 'z9y8x7w6v5', 'Server=db1;Database=cases', 'mail-sender-77', 'yamlpass']) expect(all, value).not.toContain(value);
    // Not every word in those files: a report still reads, and an example file holds nothing real.
    const line = files[`ticket/${id}.yaml`]!.replace(/\s+/g, ' ');
    expect(line).toContain('changeme123 development 3000 true http://localhost:3000');
  });

  it("takes out the values of every project on this computer's list, since the log holds them all", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-other-'));
    fs.writeFileSync(path.join(other, '.env'), 'OTHER_PASSWORD=otherproject77\n');
    rememberProject('other-1', other);
    writeLog({ level: 'error', text: 'the check said otherproject77' });
    const all = Object.values(unzipped(zip(reportEntries({ versions: VERSIONS })))).join('\n');
    forgetProject('other-1');
    fs.rmSync(other, { recursive: true, force: true });
    expect(all).not.toContain('otherproject77');
  });
});

describe('Report a problem', () => {
  it('holds the ticket, its conversations, the log for 24 hours and the versions, and says so in README.txt', () => {
    startPause({ name: 'Claude', resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, { project: 'roomflow', ticket: id });
    const files = unzipped(zip(reportEntries({ bp, ticket: id, note: 'It stopped after I approved the design', versions: VERSIONS })));
    const names = Object.keys(files);
    expect(names[0]).toBe('README.txt');
    expect(names).toEqual(
      expect.arrayContaining(['versions.txt', `ticket/${id}.yaml`, 'conversations/build-11111111.jsonl', 'project/settings.yaml', 'project/tickets.txt', 'usage-limit.json', 'log/squad-kit.log']),
    );
    const readme = files['README.txt']!;
    expect(readme).toContain('It stopped after I approved the design');
    for (const n of names.slice(1)) expect(readme).toContain(n);
    expect(readme).toMatch(/Never included: tokens, passwords, secrets\.yaml, console\.json or \.env files/);
    expect(files['versions.txt']).toMatch(/^Claude Code {2}2\.1\.296/m);
    expect(files['versions.txt']).toMatch(/^Node {9}v22\.11\.0$/m);
    // The ticket's state, with the stuck card's plain words, title, what is safe and the exact error.
    expect(files[`ticket/${id}.yaml`]).toContain('title: The Builder stopped');
    expect(files[`ticket/${id}.yaml`]).toContain('Your work is saved: steps 1 to 2 are done and kept.');
    expect(files[`ticket/${id}.yaml`]).toContain('invalid x-api-key');
    // The conversation, with its picture left out.
    expect(files['conversations/build-11111111.jsonl']).toContain('to call the API');
    expect(files['conversations/build-11111111.jsonl']).toContain('characters of a picture or file left out');
    expect(files['conversations/build-11111111.jsonl']).not.toContain('iVBORw0KGgo');
    // The log of the last 24 hours only.
    expect(files['log/squad-kit.log']).toContain('Stopped at build: Claude Code is not logged in');
    expect(files['log/squad-kit.log']).not.toContain('two days ago');
  });

  it('never holds secrets.yaml, console.json, a .env file, a token or a password', () => {
    const files = unzipped(zip(reportEntries({ bp, ticket: id, versions: VERSIONS })));
    expect(Object.keys(files).some((n) => isSecretFile(n))).toBe(false);
    const all = Object.values(files).join('\n');
    for (const secret of [AZURE_PAT, SPEECH_KEY, LINK_TOKEN, API_KEY, 'env-secret-value-123456']) expect(all).not.toContain(secret);
    expect(all).toContain('[secret removed]');
  });

  it('saves the file where the person finds it, with a name that says what it is, and never over an older one', () => {
    expect(reportName('roomflow', 'ro-7')).toBe('roomflow-RO-7-report.zip');
    expect(reportName('Case portal')).toBe('case-portal-report.zip');
    expect(reportName()).toBe('squad-kit-report.zip');
    // SQUAD_KIT_HOME is set in tests, so reports stay in its folder, never the real Downloads.
    expect(reportFolder()).toBe(path.join(process.env.SQUAD_KIT_HOME!, 'reports'));
    const plan = planReport({ bp, ticket: id });
    expect(plan.holds).toEqual([
      `${id}'s timeline, status and each step's time`,
      'The agent conversations for this ticket',
      "squad-kit's own log for the last 24 hours",
      'Versions: squad-kit, Claude Code, Node, git, the system',
    ]);
    expect(plan.command).toBe(`squad report ${id}`);
    const a = writeReport({ bp, ticket: id, dir: tmp, versions: VERSIONS });
    const b = writeReport({ bp, ticket: id, dir: tmp, versions: VERSIONS });
    expect(path.basename(a.file)).toBe(`roomflow-${id}-report.zip`);
    expect(path.basename(b.file)).toBe(`roomflow-${id}-report-2.zip`);
    expect(unzipped(fs.readFileSync(b.file))['README.txt']).toContain(`ticket ${id}`);
  });

  it('is one REST call for a ticket or for the whole app, and says where the file went', async () => {
    const app = new Hono();
    const projects = { get: (pid: string) => (pid === bp.projectId ? { bp } : undefined), summaries: () => [{ id: bp.projectId, name: 'roomflow', root: bp.root, open: true, tickets: 1, waiting: 1 }] };
    mountSupportApi(app, { projects: projects as never });
    const plan = (await (await app.request(`/api/v1/app/report?project=${bp.projectId}&ticket=${id}`)).json()) as ReportResult;
    expect(plan.name).toBe(`roomflow-${id}-report.zip`);
    expect(plan.never).toMatch(/^Never included/);
    const saved = (await (await app.request('/api/v1/app/report', { method: 'POST', body: JSON.stringify({ project: bp.projectId, ticket: id, note: 'stuck' }), headers: { 'content-type': 'application/json' } })).json()) as ReportResult;
    expect(fs.existsSync(saved.file)).toBe(true);
    expect(path.dirname(saved.file)).toBe(path.join(process.env.SQUAD_KIT_HOME!, 'reports'));
    const whole = (await (await app.request('/api/v1/app/report', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()) as ReportResult;
    expect(whole.name).toBe('squad-kit-report.zip');
    expect(unzipped(fs.readFileSync(whole.file))['projects.txt']).toContain('roomflow');
    const bad = await app.request('/api/v1/app/report', { method: 'POST', body: JSON.stringify({ ticket: id }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
  });

  it('is `squad report <ticket>` in the terminal, which prints where the file is', async () => {
    chooseProject(bp.root);
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    try {
      await runReport(id, { out: tmp, note: 'from the terminal' });
    } finally {
      process.stdout.write = write;
    }
    const text = out.join('');
    expect(text).toContain(path.join(tmp, `roomflow-${id}-report.zip`));
    expect(text).toContain('Send this file to whoever helps you with squad-kit.');
  });
});
