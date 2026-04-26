import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';

interface RecentProject {
  root: string;
  lastOpenedAt: string;
}

const MAX = 10;

function recentFilePath(): string {
  return path.join(os.homedir(), '.squad', 'recent-projects.json');
}

async function loadRecent(): Promise<RecentProject[]> {
  const RECENT_FILE = recentFilePath();
  try {
    const raw = await fs.readFile(RECENT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as RecentProject[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

async function saveRecent(list: RecentProject[]): Promise<void> {
  const RECENT_FILE = recentFilePath();
  await fs.mkdir(path.dirname(RECENT_FILE), { recursive: true });
  await fs.writeFile(RECENT_FILE, JSON.stringify(list.slice(0, MAX), null, 2) + '\n', 'utf8');
}

export function mountProjectsApi(app: Hono, opts: { paths: SquadPaths }): void {
  app.get('/api/projects/recent', async (c) => c.json(await loadRecent()));

  app.post('/api/projects/touch', async (c) => {
    const list = await loadRecent();
    const filtered = list.filter((p) => p.root !== opts.paths.root);
    filtered.unshift({ root: opts.paths.root, lastOpenedAt: new Date().toISOString() });
    await saveRecent(filtered);
    return c.json({ ok: true });
  });
}
