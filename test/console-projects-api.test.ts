import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

describe('console server recent projects', () => {
  let fakeHome: string;
  let prevHome: string | undefined;
  let startConsoleServer: typeof import('../src/console/server.js').startConsoleServer;
  let buildPaths: typeof import('../src/core/paths.js').buildPaths;
  type ConsoleServer = import('../src/console/server.js').ConsoleServer;

  let server: ConsoleServer;
  let baseUrl: string;
  const TOKEN = 'e'.repeat(64);

  beforeAll(async () => {
    prevHome = process.env.HOME;
    fakeHome = await mkdtemp(path.join(tmpdir(), 'squad-fake-home-'));
    process.env.HOME = fakeHome;

    ({ startConsoleServer } = await import('../src/console/server.js'));
    ({ buildPaths } = await import('../src/core/paths.js'));

    const root = await mkdtemp(path.join(tmpdir(), 'squad-proj-touch-'));
    const paths = buildPaths(root);
    await mkdir(paths.squadDir, { recursive: true });
    await mkdir(paths.storiesDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(
      paths.configFile,
      yaml.dump({
        version: 1,
        project: { name: 'touch-test', primaryLanguage: 'ts' },
        tracker: { type: 'none' },
        naming: { includeTrackerId: false, globalSequence: true },
        agents: [],
      }),
      'utf8',
    );

    server = await startConsoleServer({ paths, requestedPort: 0, token: TOKEN });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it('POST /api/projects/touch then GET /api/projects/recent lists project at index 0', async () => {
    const touch = await fetch(`${baseUrl}/api/projects/touch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(touch.status).toBe(200);

    const recent = await fetch(`${baseUrl}/api/projects/recent`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(recent.status).toBe(200);
    const list = (await recent.json()) as { root: string; lastOpenedAt: string }[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]!.root).toContain('squad-proj-touch-');

    const raw = await readFile(path.join(fakeHome, '.squad', 'recent-projects.json'), 'utf8');
    const parsed = JSON.parse(raw) as { root: string }[];
    expect(parsed[0]!.root).toBe(list[0]!.root);
  });
});
