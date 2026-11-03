import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
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
  readCodeAgain,
  setUpLocalCopy,
  updateForDecision,
  checkTicketsAgainst,
  keepPlan,
  draftTechDecision,
  approveTechDecision,
  discardTechDecision,
  releaseVersion,
  pushReleaseAgain,
  reportBug,
  requestChange,
  addNote,
  chatDone,
  chatRetry,
  chatStop,
  chatWrite,
  sendChat,
  startChat,
  editPlan,
  sendBack,
  startOver,
  giveBack,
  takeOver,
  handOver,
  answerAgent,
  saveReleaseNotes,
  skipQuestions,
  startFromTracker,
  endStuckCommand,
  keepWaiting,
  stopTicket,
  proposeChange,
  approveChange,
  declineChange,
  withdrawChange,
  retryChange,
  changeAfterRelease,
  ReleasedError,
} from '../../board/actions.js';
import { architecture } from '../../board/architecture.js';
import { projectApps } from '../../board/apps.js';
import { boardExists, boardPaths, listDecisions, listReleases, listTickets, readMeta, readRelease, readTicket, writeMeta } from '../../board/store.js';
import { seedDemoBoard } from '../../board/demo.js';
import type { AgentName, PlanComment, PlanEdit } from '../../board/types.js';
import { repoFor } from '../../engine/repos.js';
import type { ProjectCommands, Release } from '../../board/types.js';
import { aiTool, guessTracker, speechModule, trackerFor, trackerModule, TRACKERS } from '../../modules/registry.js';
import type { Tracker } from '../../modules/tracker/types.js';
import { findNestedRepos } from '../../engine/repos.js';
import { git } from '../../engine/git.js';
import { allowedFile, chatSummaries, mimeOf, readConversation, ticketConversations, ticketFolders } from '../../engine/conversations.js';
import { buildStamp } from '../../board/console-info.js';
import { timingSafeEqualHex } from '../auth.js';
import type { NewTicketInput, UploadedFile } from '../../board/actions.js';
import { cancelDraft, currentDraft, dismissDraft, draftFiles, draftJob, startDraft } from '../../engine/draft.js';
import { AGENTS, STEPS, ensureAgents, levelSteps, readAgent, roleForPhase, writeAgent, type AgentRole, type AgentTool } from '../../engine/agents.js';
import { builderLevel, effortOn, parseEffort, parseLevel, parseQuality, personLevels, resolveLevel, setPersonLevel, standardLevel, toolEfforts, type LevelOverrides } from '../../engine/levels.js';
import { MODEL_LEVELS } from '../../modules/ai-tool/types.js';
import { loadConfig } from '../../core/config.js';
import { installedEditors, openInEditor, ticketChanges } from '../../engine/changes.js';
import { corePrompts } from '../../engine/core-prompts.js';
import { boardUsage } from '../../board/usage.js';

const DAY = 86_400_000;

/** Signs mockup links for this run of the board only. */
const MOCKUP_SECRET = randomBytes(32);

function mockupKey(id: string, file: string): string {
  return createHmac('sha256', MOCKUP_SECRET).update(`${id}\0${file}`).digest('hex');
}

/** An HTML file inside the ticket's own folders, at most 5 MB, or null. */
function mockupFile(bp: ReturnType<typeof boardPaths>, id: string, asked: string): string | null {
  const t = readTicket(bp, id);
  if (!t || !/\.html?$/i.test(asked)) return null;
  const file = allowedFile(asked.replace(/^file:\/\//, ''), ticketFolders(t, bp));
  return file && fs.statSync(file).size <= 5 * 1024 * 1024 ? file : null;
}

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
  // Who the tracker sign-in belongs to, checked at most once a minute.
  let connection: { at: number; key: string; user?: string; error?: string } | null = null;

  async function trackerStatus(): Promise<{ tracker: Tracker | null; user?: string; error?: string }> {
    const tracker = trackerFor(bp);
    if (!tracker) return { tracker: null };
    const key = `${tracker.name}/${tracker.identity}`;
    if (!connection || connection.key !== key || Date.now() - connection.at > 60_000) {
      try {
        connection = { at: Date.now(), key, user: await tracker.whoAmI() };
      } catch (err) {
        connection = { at: Date.now(), key, error: (err as Error).message };
      }
    }
    return { tracker: connection.error ? null : tracker, user: connection.user, error: connection.error };
  }

  app.get('/api/v1/tracker', async (c) => {
    const config = fs.existsSync(opts.paths.configFile) ? loadConfig(opts.paths.configFile) : null;
    const root = path.dirname(opts.paths.squadDir);
    const type = config?.tracker.type ?? 'none';
    const mod = trackerModule(type);
    const status = mod ? await trackerStatus() : { user: undefined, error: undefined };
    // Not set up yet: a repo whose remote lives on a tracker's product already says which settings to use.
    const dirs = [root, ...findNestedRepos(root).map((r) => path.join(root, r.path))];
    const guessed = guessTracker(dirs.map((d) => git(d, ['config', '--get', 'remote.origin.url'], { allowFail: true })));
    const saved = mod ? mod.read(root) : { values: {}, hasSecret: false };
    const fieldsOf = mod ?? guessed?.module ?? TRACKERS[0]!;
    const values = Object.fromEntries(fieldsOf.fields.filter((f) => !f.secret).map((f) => [f.key, saved.values[f.key] || guessed?.values[f.key] || '']));
    return c.json({ type, module: fieldsOf.name, label: fieldsOf.label, fields: fieldsOf.fields, ...values, hasToken: saved.hasSecret, user: status.user, error: status.error });
  });

  // The person's own sign-in for their own project, saved on this computer (never in .squad or git).
  app.put('/api/v1/tracker', async (c) => {
    const b = await body<Record<string, string | undefined>>(c);
    return act(c, async () => {
      const config = loadConfig(opts.paths.configFile);
      const mod = trackerModule(b.module ?? config.tracker.type) ?? TRACKERS[0]!;
      mod.save(path.dirname(opts.paths.squadDir), b);
      connection = null;
      const status = await trackerStatus();
      if (status.error) throw new Error(status.error);
      return { ok: true, user: status.user };
    });
  });

  // Speech to text for voice and video notes. The key stays in .squad/secrets.yaml and is never sent back.
  const root = path.dirname(opts.paths.squadDir);
  app.get('/api/v1/speech', (c) => c.json({ hasKey: speechModule().hasKey(root), label: speechModule().label }));

  app.put('/api/v1/speech', async (c) => {
    const b = await body<{ key?: string; munsit?: string; remove?: boolean }>(c);
    return act(c, () => {
      const speech = speechModule();
      if (b.remove) {
        speech.removeKey(root);
        return { ok: true, hasKey: speech.hasKey(root) };
      }
      const key = (b.key ?? b.munsit)?.trim();
      if (!key) throw new Error(`Paste your ${speech.label} key first.`);
      speech.saveKey(root, key);
      return { ok: true, hasKey: true };
    });
  });

  app.get('/api/v1/backlog', async (c) => {
    const status = await trackerStatus();
    const tracker = status.tracker;
    if (!tracker) return c.json({ connected: false, error: status.error ?? null, sprints: [], items: [] });
    try {
      const sprints = tracker.abilities.sprints ? await tracker.sprints() : [];
      const asked = c.req.query('sprint');
      const sprint = asked === 'all' ? null : (sprints.find((s) => s.path === asked) ?? sprints.find((s) => s.current) ?? sprints[0] ?? null);
      const items = await tracker.list(sprint ? { sprint: sprint.path } : {});
      const onBoard = new Map(listTickets(bp).filter((t) => t.source.type === tracker.name).map((t) => [t.source.id ?? tracker.parseRef(t.source.ref ?? ''), t]));
      return c.json({
        connected: true,
        user: status.user,
        sprints,
        sprint: sprint?.path ?? 'all',
        items: items.map((w) => {
          const t = onBoard.get(w.id);
          return { ...w, ticket: t ? { id: t.id, stage: t.stage, status: t.status } : null };
        }),
      });
    } catch (err) {
      return c.json({ connected: true, error: (err as Error).message, sprints: [], items: [] });
    }
  });

  app.post('/api/v1/backlog/:id/start', async (c) =>
    act(c, async () => {
      const status = await trackerStatus();
      if (!status.tracker) throw new Error(status.error ?? 'No tracker is connected. Add it in Settings.');
      return startFromTracker(bp, status.tracker, c.req.param('id'));
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
    return t ? c.json(ticketConversations(t, undefined, bp.chatsDir)) : c.json({ error: 'not found' }, 404);
  });

  // Only a ticket's own sessions can be read, by role, never an arbitrary file. "chat" is a talk beside the work.
  app.get('/api/v1/tickets/:id/conversations/:key', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    const key = c.req.param('key');
    const id = key === 'chat' ? t?.chat?.side : t?.sessions?.[key as 'intake' | 'build' | 'review' | 'tester'];
    if (!id) return c.json({ error: 'not found' }, 404);
    const conv = readConversation(id, Math.min(1000, Number(c.req.query('limit')) || 400), undefined, bp.chatsDir);
    if (!conv) return c.json({ sessionId: id, updates: [], total: 0 });
    return c.json({ ...conv, protocol: 'acp/v1', command: `cd ${conv.cwd ?? '.'} && claude --resume ${id}` });
  });

  // Pictures, recordings and documents the squad made, shown in the conversation. Only files inside the ticket's own
  // folders (its copy of the code, its proof, its attachments) can be read.
  app.get('/api/v1/tickets/:id/file', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    const asked = c.req.query('path') ?? '';
    const file = t && asked ? allowedFile(asked.replace(/^file:\/\//, ''), ticketFolders(t, bp)) : null;
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

  // An HTML mockup an agent made, shown in a sandboxed frame. The frame gets a key for that one file, never the
  // board's token, because the mockup's own scripts can read their address.
  app.get('/api/v1/tickets/:id/mockup-link', (c) => {
    const id = c.req.param('id');
    const file = mockupFile(bp, id, c.req.query('path') ?? '');
    if (!file) return c.json({ error: 'not found' }, 404);
    return c.json({ url: `/mockup/${encodeURIComponent(id)}?path=${encodeURIComponent(file)}&k=${mockupKey(id, file)}` });
  });

  // Outside /api, so no token: the key proves the board handed out this link. Sent with its own sealed policy.
  app.get('/mockup/:id', (c) => {
    const id = c.req.param('id');
    const file = mockupFile(bp, id, c.req.query('path') ?? '');
    const k = c.req.query('k') ?? '';
    if (!file || !timingSafeEqualHex(k, mockupKey(id, file))) return c.text('not found', 404);
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' } });
  });

  app.post('/api/v1/tickets', async (c) => {
    const b = await body<Partial<NewTicketInput>>(c);
    return act(c, () =>
      createTicket(bp, {
        title: b.title ?? '',
        ask: b.ask,
        priority: b.priority,
        kind: b.kind === 'bug' ? 'bug' : 'feature',
        severity: b.severity === 'stops-work' || b.severity === 'annoying' || b.severity === 'small' ? b.severity : undefined,
        track: b.track === 'express' ? 'express' : 'full',
        criteria: b.criteria,
        rules: b.rules,
        edgeCases: b.edgeCases,
        files: b.files,
        talkFirst: Boolean(b.talkFirst),
      }),
    );
  });

  // Fills in a ticket from a pasted idea or chat message. Nothing is saved: the person checks it, then creates it.
  // The Analyst works in the background: this answers at once with the draft's id, and the dialog asks how it goes.
  app.post('/api/v1/tickets/draft', async (c) => {
    const b = await body<{ text?: string; files?: UploadedFile[] }>(c);
    return act(c, () => startDraft(bp, { text: b.text ?? '', files: b.files }));
  });

  // The draft waiting under New ticket, if any, so the dialog opened again shows it.
  app.get('/api/v1/tickets/draft/current', (c) => c.json({ draft: currentDraft(bp) }));
  app.get('/api/v1/tickets/draft/:id', (c) => {
    try {
      return c.json(draftJob(bp, c.req.param('id')));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });
  app.get('/api/v1/tickets/draft/:id/files', (c) => act(c, () => draftFiles(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/draft/:id/cancel', (c) => act(c, () => cancelDraft(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/draft/:id/dismiss', (c) => act(c, () => dismissDraft(bp, c.req.param('id'))));

  app.post('/api/v1/pull', async (c) => {
    const b = await body<{ ref?: string }>(c);
    return act(c, () => pullTicket(bp, b.ref ?? ''));
  });

  app.post('/api/v1/tickets/:id/answers', async (c) => {
    const b = await body<{ answers?: Record<string, { choice: string; value?: string }> }>(c);
    return act(c, () => answerQuestions(bp, c.req.param('id'), b.answers ?? {}));
  });

  app.post('/api/v1/tickets/:id/decision-update', async (c) => {
    const b = await body<{ adr?: string; do?: 'update' | 'keep'; reason?: string }>(c);
    const id = c.req.param('id');
    return act(c, () => (b.do === 'keep' ? keepPlan(bp, id, b.adr ?? '', b.reason ?? '') : updateForDecision(bp, id, b.adr ?? '')));
  });

  app.post('/api/v1/tickets/:id/local-setup', (c) => act(c, () => setUpLocalCopy(bp, c.req.param('id'))));

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

  app.post('/api/v1/tickets/:id/plan/edit', async (c) => {
    const b = await body<PlanEdit>(c);
    return act(c, () => editPlan(bp, c.req.param('id'), b));
  });

  app.post('/api/v1/tickets/:id/plan/send-back', async (c) => {
    const b = await body<{ comments?: PlanComment[] }>(c);
    return act(c, () => sendBack(bp, c.req.param('id'), b.comments ?? []));
  });

  app.post('/api/v1/tickets/:id/plan/start-over', async (c) => {
    const b = await body<{ direction?: string }>(c);
    return act(c, () => startOver(bp, c.req.param('id'), b.direction ?? ''));
  });

  // Talk it through with an agent: start, send (with files), write the spec or design from it, or Done.
  app.post('/api/v1/tickets/:id/chat/start', async (c) => {
    const b = await body<{ with?: AgentName }>(c);
    return act(c, () => startChat(bp, c.req.param('id'), b.with ?? 'analyst'));
  });

  app.post('/api/v1/tickets/:id/chat/send', async (c) => {
    const b = await body<{ text?: string; files?: UploadedFile[] }>(c);
    return act(c, () => sendChat(bp, c.req.param('id'), b.text ?? '', b.files ?? []));
  });

  app.post('/api/v1/tickets/:id/chat/write', (c) => act(c, () => chatWrite(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/chat/done', (c) => act(c, () => chatDone(bp, c.req.param('id'))));

  // A change goes through the spec: propose it (from the ticket or a chat message), then approve or decline what the
  // Analyst wrote, and for a big one the Architect's design update. Accepted work says no with 409 and offers a new
  // linked ticket or a bug report instead.
  app.post('/api/v1/tickets/:id/spec-change', async (c) => {
    const b = await body<{ text?: string; from?: AgentName }>(c);
    try {
      return c.json(proposeChange(bp, c.req.param('id'), b.text ?? '', b.from));
    } catch (err) {
      if (err instanceof ReleasedError) return c.json({ error: err.message, released: true, choices: ['ticket', 'bug'] }, 409);
      if (err instanceof Error) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.post('/api/v1/tickets/:id/spec-change/approve', (c) => act(c, () => approveChange(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/spec-change/decline', async (c) => {
    const b = await body<{ reason?: string }>(c);
    return act(c, () => declineChange(bp, c.req.param('id'), b.reason));
  });

  app.post('/api/v1/tickets/:id/spec-change/retry', (c) => act(c, () => retryChange(bp, c.req.param('id'))));

  // An approved change the squad has not built yet can be taken back: the spec and the work go back to before it.
  app.post('/api/v1/tickets/:id/spec-change/withdraw', async (c) => {
    const b = await body<{ reason?: string }>(c);
    return act(c, () => withdrawChange(bp, c.req.param('id'), b.reason));
  });

  app.post('/api/v1/tickets/:id/spec-change/new-ticket', async (c) => {
    const b = await body<{ text?: string; as?: 'ticket' | 'bug' }>(c);
    return act(c, () => changeAfterRelease(bp, c.req.param('id'), b.text ?? '', b.as === 'bug' ? 'bug' : 'ticket'));
  });

  app.post('/api/v1/tickets/:id/chat/stop', (c) => act(c, () => chatStop(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/chat/retry', (c) => act(c, () => chatRetry(bp, c.req.param('id'))));

  // Every ticket's talk with an agent, released ones too, for the chat tabs and the Conversations page.
  app.get('/api/v1/conversations', (c) => c.json(boardExists(bp) ? chatSummaries(listTickets(bp), c.req.query('q') ?? '') : []));

  app.post('/api/v1/tickets/:id/take-over', (c) => act(c, () => takeOver(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/give-back', async (c) => {
    const b = await body<{ note?: string }>(c);
    return act(c, () => giveBack(bp, c.req.param('id'), b.note));
  });

  // Hand over: push the ticket's branch with its code and documents, and name the new owner.
  app.post('/api/v1/tickets/:id/hand-over', async (c) => {
    const b = await body<{ to?: string; note?: string }>(c);
    return act(c, () => handOver(bp, c.req.param('id'), { to: b.to ?? '', note: b.note }));
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

  // The push of a release failed: it stays open until its commits and tags reach the remote.
  app.post('/api/v1/releases/:v/push', (c) => act(c, () => pushReleaseAgain(bp, c.req.param('v'))));

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

  app.get('/api/v1/apps', async (c) => c.json({ apps: boardExists(bp) ? await projectApps(readMeta(bp)) : [] }));

  app.post('/api/v1/architecture/read', (c) => act(c, () => readCodeAgain(bp)));
  app.post('/api/v1/architecture/impact', async (c) => {
    const b = await body<{ adr?: string }>(c);
    return act(c, () => checkTicketsAgainst(bp, b.adr ?? ''));
  });
  app.post('/api/v1/architecture/decide', async (c) => {
    const b = await body<{ tech?: string; do?: 'write' | 'approve' | 'discard' }>(c);
    const tech = b.tech ?? '';
    if (b.do === 'approve') return act(c, () => approveTechDecision(bp, tech));
    if (b.do === 'discard') return act(c, () => (discardTechDecision(bp, tech), { ok: true }));
    return act(c, () => draftTechDecision(bp, tech));
  });

  app.get('/api/v1/architecture', (c) => {
    if (!boardExists(bp)) return c.json({ decisions: [], tickets: [], map: [], lessons: [], stack: [], patterns: [], impact: [] });
    return c.json(architecture(bp));
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
      documentsInGit?: boolean;
      quality?: string;
      repos?: { path: string; base?: string; remote?: string; commands?: ProjectCommands }[];
    }>(c);
    return act(c, () => {
      const meta = readMeta(bp);
      if (b.quality !== undefined) {
        const q = parseQuality(b.quality);
        if (!q) throw new Error(`"${b.quality}" is not a Quality setting. Use best, balanced or thrifty.`);
        meta.quality = q;
      }
      if (b.commands) {
        meta.commands = Object.fromEntries(
          Object.entries(b.commands).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v),
        ) as ProjectCommands;
      }
      if (b.git) meta.git = { base: b.git.base?.trim() || meta.git?.base || 'main', remote: b.git.remote?.trim() ?? meta.git?.remote ?? '' };
      if (typeof b.parallel === 'number' && b.parallel >= 1 && b.parallel <= 5) meta.parallel = Math.round(b.parallel);
      if (b.runner === 'acp' || b.runner === 'direct') meta.runner = b.runner;
      if (typeof b.documentsInGit === 'boolean') meta.documentsInGit = b.documentsInGit;
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
    const mine = personLevels();
    const quality = readMeta(bp).quality;
    const STEP_NAME: Record<string, string> = { chat: 'Talking it through', draft: 'Filling in a new ticket' };
    return c.json(
      AGENTS.map((a) => {
        const agent = readAgent(bp, a.role);
        const tool = aiTool(agent.tool);
        const floor = a.role === 'reviewer' ? { builder: builderLevel({ quality }, readAgent(bp, 'builder').levels, mine) } : {};
        // Each step's model level now, and who chose it: squad-kit for the Quality setting, the project, or you.
        const levels = levelSteps(a.role).map((step) => {
          const now = resolveLevel({ role: a.role, step, quality, ...floor }, agent.levels, mine);
          const effort = tool ? effortOn(tool, now.effort) : now.effort;
          return {
            step,
            name: STEPS[a.role].find((x) => x.id === step)?.name ?? STEP_NAME[step] ?? step,
            standard: standardLevel({ role: a.role, step, quality }),
            team: agent.levels[`${a.role}.${step}`] ?? null,
            you: mine[`${a.role}.${step}`] ?? null,
            now: { ...now, effort, modelName: now.model || tool?.modelFor(now.level) || '' },
          };
        });
        return {
          ...a,
          ...agent,
          levels,
          teamRole: agent.levels[a.role] ?? null,
          youRole: mine[a.role] ?? null,
          modelOf: Object.fromEntries(MODEL_LEVELS.map((l) => [l, tool?.modelFor(l) ?? ''])),
          supportsEffort: tool?.supportsEffort ?? false,
          efforts: tool ? toolEfforts(tool) : [],
          file: `.squad/board/agents/${a.role}.md`,
          stepList: STEPS[a.role],
        working: tickets.filter((t) => roleForPhase(t.squad?.phase) === a.role).map((t) => ({ id: t.id, title: t.title, status: t.status })),
        };
      }),
    );
  });

  // What the squad used on this board, on this computer: the total, each role at each level, and the project's own line.
  app.get('/api/v1/usage', (c) => (boardExists(bp) ? c.json(boardUsage(bp)) : c.json({ total: { runs: 0 }, project: { runs: 0 }, roles: [], tickets: 0 })));

  // The team's choices go in the agent file, shared with the project.
  app.put('/api/v1/agents/:role', async (c) => {
    const b = await body<{ tool?: AgentTool; model?: string; instructions?: string; steps?: Record<string, string>; levels?: LevelOverrides }>(c);
    return act(c, () =>
      writeAgent(bp, c.req.param('role') as AgentRole, { tool: b.tool, model: b.model?.trim(), instructions: b.instructions, steps: b.steps, ...(b.levels ? { levels: b.levels } : {}) }),
    );
  });

  // This person's own choice for a role or one of its steps, kept on this computer only.
  app.put('/api/v1/me/levels', async (c) => {
    const b = await body<{ key?: string; level?: string; effort?: string; model?: string }>(c);
    return act(c, () => {
      const key = b.key ?? '';
      const [role, step] = key.split('.');
      if (!AGENTS.some((a) => a.role === role) || (step && !levelSteps(role as AgentRole).includes(step))) throw new Error(`"${key}" is not a role or one of its steps.`);
      if (b.level && !parseLevel(b.level)) throw new Error(`"${b.level}" is not a level. Use strongest, balanced or fast.`);
      if (b.effort && !parseEffort(b.effort)) throw new Error(`"${b.effort}" is not an effort. Use xhigh (extra high), high, medium or low.`);
      return setPersonLevel(key, { level: parseLevel(b.level), effort: parseEffort(b.effort), model: b.model });
    });
  });

  // The core prompts, read only, filled in from a real ticket: what each step of the agent reads.
  app.get('/api/v1/agents/:role/prompts', (c) => {
    const role = c.req.param('role') as AgentRole;
    if (!AGENTS.some((a) => a.role === role)) return c.json({ error: 'not found' }, 404);
    return c.json(corePrompts(bp, role, c.req.query('ticket') || undefined));
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
