import { describe, it, expect } from 'vitest';
import { appNews, findApp, projectApps, withAppCommands } from '../src/board/apps.js';
import { addressIn, busyIn, onPort } from '../src/engine/run-app.js';
import type { BoardMeta, Ticket } from '../src/board/types.js';

const meta = (extra: Partial<BoardMeta>) => ({ project: 'Mawid', engine: 'live', commands: {}, git: { base: 'main', remote: '' }, ...extra }) as BoardMeta;

describe('your apps', () => {
  it('lists every repo with a web address or a start command', () => {
    const m = meta({
      repos: [
        { path: 'web', base: 'main', remote: '', commands: { start: 'npm run dev', url: 'http://localhost:3000', setup: 'npm ci' } },
        { path: 'api', base: 'develop', remote: '', commands: { start: 'dotnet run', url: ' http://localhost:5000 ' } },
        { path: 'docs', base: 'main', remote: '', commands: {} },
      ],
    });
    expect(projectApps(m)).toEqual([
      { name: 'web', repo: 'web', base: 'main', url: 'http://localhost:3000', start: 'npm run dev', setup: 'npm ci' },
      { name: 'api', repo: 'api', base: 'develop', url: 'http://localhost:5000', start: 'dotnet run' },
    ]);
  });

  it('a one-repo project is named after the project', () => {
    expect(projectApps(meta({ commands: { url: 'http://localhost:3000' } }))).toEqual([{ name: 'Mawid', repo: '.', base: 'main', url: 'http://localhost:3000' }]);
  });

  it('a live project that knows no start command yet still shows its app, so the person can ask or type it', () => {
    expect(projectApps(meta({}))).toEqual([{ name: 'Mawid', repo: '.', base: 'main' }]);
    // A sample board, or a project with no code yet, shows nothing to start.
    expect(projectApps(meta({ engine: 'demo' }))).toEqual([]);
    expect(projectApps(meta({ scan: { status: 'done', empty: true } }))).toEqual([]);
  });

  it('finds the app a person names, and needs no name with one app', () => {
    const m = meta({ repos: [{ path: 'web', base: 'main', remote: '', commands: { start: 'npm run dev' } }, { path: 'api', base: 'main', remote: '', commands: { start: 'dotnet run' } }] });
    expect(findApp(m, 'API').repo).toBe('api');
    expect(() => findApp(m)).toThrow('This project has 2 apps: web, api. Name one, for example: squad app start web');
    expect(() => findApp(m, 'admin')).toThrow('There is no app called "admin"');
    expect(findApp(meta({ commands: { start: 'npm start' } })).name).toBe('Mawid');
  });

  it('"Type it" saves the start command and address in the project settings, keeping the rest', () => {
    const one = withAppCommands(meta({ commands: { test: 'npm test' } }), '.', { start: ' npm run dev ', url: 'http://localhost:5173' });
    expect(one.commands).toEqual({ test: 'npm test', start: 'npm run dev', url: 'http://localhost:5173' });
    const many = withAppCommands(meta({ repos: [{ path: 'web', base: 'main', remote: '', commands: { url: 'http://localhost:3000' } }] }), 'web', { start: 'pnpm dev' });
    expect(many.repos![0]!.commands).toEqual({ url: 'http://localhost:3000', start: 'pnpm dev' });
    expect(() => withAppCommands(meta({}), '.', { start: ' ' })).toThrow('Type the command that starts the app');
    expect(() => withAppCommands(meta({}), '.', { start: 'npm start', url: 'localhost' })).toThrow('is not a web address');
  });

  it('says which merged tickets the running app holds, and offers the one merged since', () => {
    const m = meta({ commands: { start: 'npm start' } });
    const t = (id: string, mergedAt?: string) => ({ id, title: `Ticket ${id}`, mergedAt, release: 'v0.2.0' }) as Ticket;
    const tickets = [t('RO-3', '2026-11-03T09:00:00Z'), t('RO-5', '2026-11-03T11:00:00Z'), t('RO-6')];
    const running = { repo: '.', state: 'running', startedAt: '2026-11-03T10:00:00Z' };
    expect(appNews(m, tickets, running)).toEqual({
      includes: [{ id: 'RO-3', title: 'Ticket RO-3' }],
      fresh: { id: 'RO-5', title: 'Ticket RO-5', base: 'main', release: 'v0.2.0' },
    });
    // Not now hides it; an app started after the merge has nothing new.
    expect(appNews(m, tickets, running, ['RO-5']).fresh).toBeUndefined();
    expect(appNews(m, tickets, { ...running, startedAt: '2026-11-03T12:00:00Z' }).fresh).toBeUndefined();
    // Not running: a merge of the last day is offered; an older one is not.
    const now = Date.parse('2026-11-03T12:00:00Z');
    expect(appNews(m, tickets, { repo: '.', state: 'not-running' }, [], now).fresh?.id).toBe('RO-5');
    expect(appNews(m, tickets, { repo: '.', state: 'not-running' }, [], now + 2 * 86_400_000).fresh).toBeUndefined();
    // The person ran it after the merge, then stopped it: nothing new to offer.
    expect(appNews(m, tickets, { repo: '.', state: 'stopped', startedAt: '2026-11-03T11:30:00Z' }, [], now).fresh).toBeUndefined();
  });
});

describe('reading what an app says', () => {
  it('moves a start command to another port only when it takes a port setting', () => {
    expect(onPort('uvicorn app:app --port 8000', 8000, 8001)).toBe('uvicorn app:app --port 8001');
    expect(onPort('vite --port=5173', 5173, 5174)).toBe('vite --port=5174');
    expect(onPort('rails s -p 3000', 3000, 3001)).toBe('rails s -p 3001');
    expect(onPort('PORT=3000 node server.js', 3000, 3001)).toBe('PORT=3001 node server.js');
    expect(onPort('python manage.py runserver 0.0.0.0:8000', 8000, 8001)).toBe('python manage.py runserver 0.0.0.0:8001');
    expect(onPort('node server.js --port $PORT', 3000, 3001)).toBe('node server.js --port $PORT');
    expect(onPort('npm run dev', 3000, 3001)).toBeNull();
    expect(onPort('python -m roomflow', 8000, 8001)).toBeNull();
  });

  it('finds the address a dev server prints and a busy port', () => {
    expect(addressIn('  VITE v5 ready\n  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[39m\n')).toBe('http://localhost:5173');
    expect(addressIn('Listening on http://0.0.0.0:8000')).toBe('http://127.0.0.1:8000');
    expect(busyIn('Error: listen EADDRINUSE: address already in use :::3000')).toBe(3000);
    expect(busyIn('Error: That port is already in use.\nPort 8000 is in use')).toBe(8000);
  });
});
