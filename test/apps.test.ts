import { describe, it, expect } from 'vitest';
import { projectApps } from '../src/board/apps.js';
import type { BoardMeta } from '../src/board/types.js';

const meta = (extra: Partial<BoardMeta>) => ({ project: 'Mawid', commands: {}, git: { base: 'main', remote: '' }, ...extra }) as BoardMeta;

describe('your apps', () => {
  it('lists every repo with a web address, and which ones answer', async () => {
    const m = meta({
      repos: [
        { path: 'web', base: 'main', remote: '', commands: { start: 'npm run dev', url: 'http://localhost:3000' } },
        { path: 'api', base: 'main', remote: '', commands: { start: 'dotnet run', url: ' http://localhost:5000 ' } },
        { path: 'docs', base: 'main', remote: '', commands: {} },
      ],
    });
    const apps = await projectApps(m, async (url) => url.endsWith('3000'));
    expect(apps).toEqual([
      { name: 'web', repo: 'web', url: 'http://localhost:3000', start: 'npm run dev', up: true },
      { name: 'api', repo: 'api', url: 'http://localhost:5000', start: 'dotnet run', up: false },
    ]);
  });

  it('a one-repo project is named after the project', async () => {
    const apps = await projectApps(meta({ commands: { url: 'http://localhost:3000' } }), async () => false);
    expect(apps).toEqual([{ name: 'Mawid', repo: '.', url: 'http://localhost:3000', up: false }]);
  });
});
