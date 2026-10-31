import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import {
  BoardActionError,
  answerQuestions,
  approve,
  askAbout,
  composeNotes,
  createTicket,
  decideStuck,
  pullTicket,
  releaseVersion,
  reportBug,
  requestChange,
  addNote,
  giveBack,
  takeOver,
  answerAgent,
  saveReleaseNotes,
  skipQuestions,
  startFromAzure,
  endStuckCommand,
  keepWaiting,
  stopTicket,
} from '../../board/actions.js';
import { boardExists, boardPaths, listDecisions, listReleases, listTickets, readMeta, readRelease, readTicket, writeMeta } from '../../board/store.js';
import { seedDemoBoard } from '../../board/demo.js';
import type { AgentName } from '../../board/types.js';
import { repoFor } from '../../engine/repos.js';
import type { ProjectCommands, Release } from '../../board/types.js';
import { Azure, azureFor, parseAzureRemote } from '../../engine/azure.js';
import { findNestedRepos } from '../../engine/repos.js';
import { git } from '../../engine/git.js';
import { allowedFile, mimeOf, readConversation, ticketConversations, ticketFolders } from '../../engine/conversations.js';
import { buildStamp } from '../../board/console-info.js';
import type { NewTicketInput, UploadedFile } from '../../board/actions.js';
import { draftTicket } from '../../engine/draft.js';
import { AGENTS, ensureAgents, readAgent, roleForPhase, writeAgent, type AgentRole, type AgentTool } from '../../engine/agents.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import { loadSecrets, mergeSecrets, saveSecrets } from '../../core/secrets.js';
import { munsitKey } from '../../engine/media.js';
import { installedEditors, openInEditor, ticketChanges } from '../../engine/changes.js';

const DAY = 86_400_000;

function withNotes(bp: ReturnType<typeof boardPaths>, r: Release): Release {
  return r.status === 'draft' && !r.notes.trim() ? { ...r, notes: composeNotes(bp, r) } : r;
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** Runs a board action and turns a person-facing mistake into a 400 with the message. */
async function act(c: Context, fn: () => unknown) {
  try {
    return c.json(((await fn()) as object) ?? { ok: true });
  } catch (err) {
    if (err instanceof BoardActionError || err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
}

export function mountBoardApi(app: Hono, opts: { paths: SquadPaths; control?: { startedAt: string; build: number; restart(): void } }): void {
  const bp = boardPaths(opts.paths.squadDir);
  // Who the Azure token belongs to, checked at most once a minute.
  let connection: { at: number; key: string; user?: string; error?: string } | null = null;

  async function azureStatus(): Promise<{ az: Azure | null; user?: string; error?: string }> {
    const az = azureFor(bp);
    if (!az) return { az: null };
    const key = `${az.target.organization}/${az.target.project}/${az.target.pat.slice(-6)}`;
    if (!connection || connection.key !== key || Date.now() - connection.at > 60_000) {
      try {
        connection = { at: Date.now(), key, user: await az.whoAmI() };
      } catch (err) {
        connection = { at: Date.now(), key, error: (err as Error).message };
      }
    }
    return { az: connection.error ? null : az, user: connection.user, error: connection.error };
  }

  app.get('/api/v1/tracker', async (c) => {
    const config = fs.existsSync(opts.paths.configFile) ? loadConfig(opts.paths.configFile) : null;
    const type = config?.tracker.type ?? 'none';
    const hasToken = Boolean(loadSecrets(opts.paths.secretsFile).tracker?.azure?.pat || process.env.AZURE_DEVOPS_PAT);
    const status = type === 'azure' ? await azureStatus() : { user: undefined, error: undefined };
    // Not set up yet: a repo that lives on Azure already says which organization and project to use.
    const root = path.dirname(opts.paths.squadDir);
    const dirs = [root, ...findNestedRepos(root).map((r) => path.join(root, r.path))];
    const found = dirs.map((d) => parseAzureRemote(git(d, ['config', '--get', 'remote.origin.url'], { allowFail: true }))).find(Boolean);
    return c.json({
      type,
      organization: config?.tracker.workspace ?? found?.organization ?? '',
      project: config?.tracker.project ?? found?.project ?? '',
      hasToken,
      user: status.user,
      error: status.error,
    });
  });

  // The person's own token for their own project, saved in .squad/secrets.yaml (never in git).
  app.put('/api/v1/tracker', async (c) => {
    const b = await body<{ organization?: string; project?: string; token?: string }>(c);
    return act(c, async () => {
      const organization = b.organization?.trim().replace(/^https:\/\/dev\.azure\.com\//, '').replace(/\/.*$/, '');
      const project = b.project?.trim();
      if (!organization || !project) throw new Error('Enter the Azure organization and project.');
      const config = loadConfig(opts.paths.configFile);
      saveConfig(opts.paths.configFile, { ...config, tracker: { ...config.tracker, type: 'azure', workspace: organization, project } });
      const secrets = loadSecrets(opts.paths.secretsFile);
      saveSecrets(opts.paths.secretsFile, mergeSecrets(secrets, { tracker: { azure: { organization, project, pat: b.token?.trim() || undefined } } }));
      connection = null;
      const status = await azureStatus();
      if (status.error) throw new Error(status.error);
      return { ok: true, user: status.user };
    });
  });

  // Speech to text for voice and video notes. The key stays in .squad/secrets.yaml and is never sent back.
  app.get('/api/v1/speech', (c) => c.json({ hasKey: Boolean(munsitKey(bp)) }));

  app.put('/api/v1/speech', async (c) => {
    const b = await body<{ munsit?: string; remove?: boolean }>(c);
    return act(c, () => {
      const secrets = loadSecrets(opts.paths.secretsFile);
      if (b.remove) {
        delete secrets.speech;
        saveSecrets(opts.paths.secretsFile, secrets);
        return { ok: true, hasKey: Boolean(munsitKey(bp)) };
      }
      const key = b.munsit?.trim();
      if (!key) throw new Error('Paste your Munsit key first.');
      saveSecrets(opts.paths.secretsFile, mergeSecrets(secrets, { speech: { munsit: key } }));
      return { ok: true, hasKey: true };
    });
  });

  app.get('/api/v1/backlog', async (c) => {
    const status = await azureStatus();
    if (!status.az) return c.json({ connected: false, error: status.error ?? null, sprints: [], items: [] });
    try {
      const sprints = await status.az.sprints();
      const asked = c.req.query('sprint');
      const sprint = asked === 'all' ? null : (sprints.find((s) => s.path === asked) ?? sprints.find((s) => s.current) ?? sprints[0] ?? null);
      const items = await status.az.listWorkItems(sprint ? { sprintPath: sprint.path } : {});
      const onBoard = new Map(listTickets(bp).filter((t) => t.source.type === 'azure').map((t) => [t.source.id ?? t.source.ref?.replace(/^AB#/, ''), t]));
      return c.json({
        connected: true,
        user: status.user,
        sprints,
        sprint: sprint?.path ?? 'all',
        items: items.map((w) => {
          const t = onBoard.get(String(w.id));
          return { ...w, ticket: t ? { id: t.id, stage: t.stage, status: t.status } : null };
        }),
      });
    } catch (err) {
      return c.json({ connected: true, error: (err as Error).message, sprints: [], items: [] });
    }
  });

  app.post('/api/v1/backlog/:id/start', async (c) =>
    act(c, async () => {
      const status = await azureStatus();
      if (!status.az) throw new Error(status.error ?? 'Azure is not connected. Add it in Settings.');
      return startFromAzure(bp, status.az, c.req.param('id'));
    }),
  );

  app.get('/api/v1/board', (c) => {
    if (!boardExists(bp)) return c.json({ ready: false });
    const meta = readMeta(bp);
    const all = listTickets(bp);
    const recent = listReleases(bp).filter((r) => r.status === 'released' && r.date && Date.now() - Date.parse(r.date) < 30 * DAY);
    const ctl = opts.control;
    return c.json({
      ready: true,
      meta,
      // A newer squad-kit build on disk than the one this board runs: offer a restart.
      console: ctl ? { startedAt: ctl.startedAt, outdated: ctl.build > 0 && buildStamp() > ctl.build } : null,
      tickets: all.filter((t) => t.stage !== 'done'),
      stats: {
        released30: recent.reduce((n, r) => n + r.tickets.length, 0),
        bugs30: recent.reduce((n, r) => n + (r.bugs?.length ?? 0), 0),
        open: all.filter((t) => t.stage !== 'done').length,
      },
    });
  });

  app.get('/api/v1/tickets/:id', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    return t ? c.json(t) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/v1/tickets/:id/conversations', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    return t ? c.json(ticketConversations(t, undefined, path.join(bp.dir, 'sessions'))) : c.json({ error: 'not found' }, 404);
  });

  // Only a ticket's own sessions can be read, by role, never an arbitrary file.
  app.get('/api/v1/tickets/:id/conversations/:key', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    const id = t?.sessions?.[c.req.param('key') as 'intake' | 'build' | 'review' | 'tester'];
    if (!id) return c.json({ error: 'not found' }, 404);
    const conv = readConversation(id, Math.min(1000, Number(c.req.query('limit')) || 400), undefined, path.join(bp.dir, 'sessions'));
    if (!conv) return c.json({ sessionId: id, updates: [], total: 0 });
    return c.json({ ...conv, protocol: 'acp/v1', command: `cd ${conv.cwd ?? '.'} && claude --resume ${id}` });
  });

  // Pictures, recordings and documents the squad made, shown in the conversation. Only files inside the ticket's own
  // folders (its copy of the code, its proof, its attachments) can be read.
  app.get('/api/v1/tickets/:id/file', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    const asked = c.req.query('path') ?? '';
    const file = t && asked ? allowedFile(asked.replace(/^file:\/\//, ''), ticketFolders(t, bp.dir)) : null;
    if (!file) return c.text('not found', 404);
    const size = fs.statSync(file).size;
    if (size > 100 * 1024 * 1024) return c.text('too large', 413);
    const type = mimeOf(file);
    const inline = /^(image|video|audio)\/|^application\/pdf$|^text\//.test(type) && type !== 'image/svg+xml' && type !== 'text/html';
    return new Response(fs.readFileSync(file), {
      headers: {
        'content-type': type,
        'content-length': String(size),
        // SVG and HTML can carry scripts, so they download instead of opening in the board.
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${path.basename(file).replace(/"/g, '')}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=300',
      },
    });
  });

  app.post('/api/v1/tickets', async (c) => {
    const b = await body<Partial<NewTicketInput>>(c);
    return act(c, () =>
      createTicket(bp, {
        title: b.title ?? '',
        ask: b.ask,
        priority: b.priority,
        kind: b.kind === 'bug' ? 'bug' : 'feature',
        track: b.track === 'express' ? 'express' : 'full',
        criteria: b.criteria,
        rules: b.rules,
        edgeCases: b.edgeCases,
        files: b.files,
      }),
    );
  });

  // Fills in a ticket from a pasted idea or chat message. Nothing is saved: the person checks it, then creates it.
  app.post('/api/v1/tickets/draft', async (c) => {
    const b = await body<{ text?: string; files?: UploadedFile[] }>(c);
    return act(c, () => draftTicket(bp, { text: b.text ?? '', files: b.files }));
  });

  app.post('/api/v1/pull', async (c) => {
    const b = await body<{ ref?: string }>(c);
    return act(c, () => pullTicket(bp, b.ref ?? ''));
  });

  app.post('/api/v1/tickets/:id/answers', async (c) => {
    const b = await body<{ answers?: Record<string, { choice: string; value?: string }> }>(c);
    return act(c, () => answerQuestions(bp, c.req.param('id'), b.answers ?? {}));
  });

  app.post('/api/v1/tickets/:id/skip', (c) => act(c, () => skipQuestions(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/ask', async (c) => {
    const b = await body<{ questionId?: string; text?: string }>(c);
    return act(c, () => askAbout(bp, c.req.param('id'), b.questionId ?? '', b.text ?? ''));
  });

  app.post('/api/v1/tickets/:id/approve', (c) => act(c, () => approve(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/stop', (c) => act(c, () => stopTicket(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/unstick', (c) => act(c, () => endStuckCommand(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/keep-waiting', (c) => act(c, () => keepWaiting(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/change', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => requestChange(bp, c.req.param('id'), b.text ?? ''));
  });

  // Everything the ticket changed against main, read from its own copy.
  app.get('/api/v1/tickets/:id/changes', (c) => act(c, () => ticketChanges(bp, c.req.param('id'))));

  app.get('/api/v1/editors', (c) => c.json({ editors: installedEditors() }));

  app.post('/api/v1/tickets/:id/open-editor', async (c) => {
    const b = await body<{ editor?: string }>(c);
    return act(c, () => openInEditor(bp, c.req.param('id'), b.editor));
  });

  app.post('/api/v1/tickets/:id/reply', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => answerAgent(bp, c.req.param('id'), b.text ?? ''));
  });

  app.post('/api/v1/tickets/:id/notes', async (c) => {
    const b = await body<{ text?: string; kind?: 'note' | 'criterion' | 'rule'; to?: AgentName }>(c);
    return act(c, () => addNote(bp, c.req.param('id'), { text: b.text ?? '', kind: b.kind, to: b.to }));
  });

  app.post('/api/v1/tickets/:id/take-over', (c) => act(c, () => takeOver(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/give-back', async (c) => {
    const b = await body<{ note?: string }>(c);
    return act(c, () => giveBack(bp, c.req.param('id'), b.note));
  });

  app.post('/api/v1/tickets/:id/decide', async (c) => {
    const b = await body<{ choice?: number; note?: string; reason?: string }>(c);
    return act(c, () => decideStuck(bp, c.req.param('id'), Number(b.choice), { note: b.note, reason: b.reason }));
  });

  app.get('/api/v1/releases', (c) => {
    const tickets = listTickets(bp);
    const meta = readMeta(bp);
    const titleOf = (id: string, r: Release) => tickets.find((t) => t.id === id)?.title ?? r.titles?.[id] ?? id;
    /** Where a release will push, per repo, so the person sees it before confirming. */
    const targets = (r: Release) => {
      if (meta.engine !== 'live') return [];
      const seen = new Map<string, { repo: string; branch: string; remote: string }>();
      for (const t of tickets.filter((x) => r.tickets.includes(x.id))) {
        const repo = repoFor(meta, t);
        seen.set(repo.path, { repo: repo.path, branch: repo.base, remote: repo.remote });
      }
      return [...seen.values()];
    };
    return c.json(
      listReleases(bp).map((r) => ({
        ...withNotes(bp, r),
        targets: targets(r),
        items: r.tickets.map((id) => {
          const t = tickets.find((x) => x.id === id);
          return { id, title: titleOf(id, r), gates: t?.gates ?? null, kind: t?.kind ?? 'feature' };
        }),
      })),
    );
  });

  app.put('/api/v1/releases/:v/notes', async (c) => {
    const b = await body<{ notes?: string }>(c);
    return act(c, () => saveReleaseNotes(bp, c.req.param('v'), b.notes ?? ''));
  });

  app.post('/api/v1/releases/:v/release', (c) => act(c, () => releaseVersion(bp, c.req.param('v'))));

  app.get('/api/v1/releases/:v', (c) => {
    const r = readRelease(bp, c.req.param('v'));
    return r ? c.json(withNotes(bp, r)) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/v1/bugs', async (c) => {
    const b = await body<{ what?: string; how?: string; expected?: string; severity?: 'stops-work' | 'annoying' | 'small'; foundIn?: string }>(c);
    return act(c, () => reportBug(bp, { what: b.what ?? '', how: b.how, expected: b.expected, severity: b.severity, foundIn: b.foundIn }));
  });

  app.get('/api/v1/decisions', (c) => {
    if (!boardExists(bp)) return c.json({ decisions: [], map: [], lessons: [] });
    const meta = readMeta(bp);
    return c.json({ decisions: listDecisions(bp), map: meta.map, lessons: meta.lessons });
  });

  app.get('/api/v1/proof/:file', (c) => {
    const name = path.basename(c.req.param('file'));
    const abs = path.join(bp.proofDir, name);
    if (!name.endsWith('.png') || !fs.existsSync(abs)) return c.text('not found', 404);
    return new Response(fs.readFileSync(abs), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
  });

  app.put('/api/v1/settings', async (c) => {
    const b = await body<{
      commands?: ProjectCommands;
      git?: { base?: string; remote?: string };
      parallel?: number;
      runner?: 'acp' | 'direct';
      repos?: { path: string; base?: string; remote?: string; commands?: ProjectCommands }[];
    }>(c);
    return act(c, () => {
      const meta = readMeta(bp);
      if (b.commands) {
        meta.commands = Object.fromEntries(
          Object.entries(b.commands).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v),
        ) as ProjectCommands;
      }
      if (b.git) meta.git = { base: b.git.base?.trim() || meta.git?.base || 'main', remote: b.git.remote?.trim() ?? meta.git?.remote ?? '' };
      if (typeof b.parallel === 'number' && b.parallel >= 1 && b.parallel <= 5) meta.parallel = Math.round(b.parallel);
      if (b.runner === 'acp' || b.runner === 'direct') meta.runner = b.runner;
      if (b.repos && meta.repos) {
        meta.repos = meta.repos.map((r) => {
          const u = b.repos!.find((x) => x.path === r.path);
          if (!u) return r;
          const commands = Object.fromEntries(
            Object.entries(u.commands ?? r.commands).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v),
          ) as ProjectCommands;
          return { ...r, base: u.base?.trim() || r.base, remote: u.remote?.trim() ?? r.remote, commands };
        });
      }
      writeMeta(bp, meta);
      return meta;
    });
  });

  app.get('/api/v1/agents', (c) => {
    if (!boardExists(bp)) return c.json([]);
    if (readMeta(bp).engine === 'live') ensureAgents(bp);
    const tickets = listTickets(bp).filter((t) => t.live && t.squad);
    return c.json(
      AGENTS.map((a) => ({
        ...a,
        ...readAgent(bp, a.role),
        file: `.squad/board/agents/${a.role}.md`,
        working: tickets.filter((t) => roleForPhase(t.squad?.phase) === a.role).map((t) => ({ id: t.id, title: t.title, status: t.status })),
      })),
    );
  });

  app.put('/api/v1/agents/:role', async (c) => {
    const b = await body<{ tool?: AgentTool; model?: string; instructions?: string }>(c);
    return act(c, () => writeAgent(bp, c.req.param('role') as AgentRole, { tool: b.tool, model: b.model?.trim(), instructions: b.instructions }));
  });

  app.post('/api/v1/restart', (c) => {
    if (!opts.control) return c.json({ error: 'This board cannot restart itself. Press Ctrl-C and run: squad console' }, 400);
    opts.control.restart();
    return c.json({ ok: true });
  });

  app.post('/api/v1/scan', (c) =>
    act(c, () => {
      const meta = readMeta(bp);
      if (meta.engine !== 'live') throw new Error('Only a live board reads the project.');
      meta.scan = { status: 'pending' };
      writeMeta(bp, meta);
      return meta;
    }),
  );

  app.post('/api/v1/demo/reset', (c) => {
    if (boardExists(bp) && readMeta(bp).engine !== 'demo') return c.json({ error: 'Only a demo board can be reset.' }, 400);
    const speed = boardExists(bp) ? readMeta(bp).speed : 1;
    const project = boardExists(bp) ? readMeta(bp).project : undefined;
    seedDemoBoard(bp, { speed, project });
    return c.json({ ok: true });
  });
}
