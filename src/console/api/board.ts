import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import type { SquadPaths } from '../../core/paths.js';
import {
  BoardActionError,
  answerQuestions,
  approveBeside,
  isSaving,
  askAbout,
  composeNotes,
  createTicket,
  decideStuckBeside,
  decideTestCommand,
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
  markReleaseSent,
  SentNotSure,
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
  askQuestion,
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
  restartStep,
  startTicket,
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
import { copyViews } from '../../engine/copies.js';
import { isSavedProof } from '../../engine/proof-kinds/saved.js';
import { addPart, changePart, partsOf, removePart, repoPaths, severalParts, type PartChange } from '../../board/parts.js';
import { addLocalFile, addLockedFile, lockDockerFiles, projectFilesView, removeProjectFile, useMyFile } from '../../board/project-files.js';
import { videoNotesWork } from '../../engine/media.js';
import { boardExists, boardPaths, brokenDecisions, brokenReleases, brokenTickets, listDecisions, listReleases, listTickets, readMeta, readRelease, readTicket, settingsProblem, ticketProblem, writeMeta, requireTicket } from '../../board/store.js';
import { brokenBreakdowns } from '../../board/requirements.js';
import { seedDemoBoard } from '../../board/demo.js';
import type { AgentName, PlanComment, PlanEdit, Ticket } from '../../board/types.js';
import { repoFor, reposOf } from '../../engine/repos.js';
import type { ProjectCommands, Release } from '../../board/types.js';
import { aiTool, guessTracker, speechModule, trackerFor, trackerModule, TRACKERS } from '../../modules/registry.js';
import type { Tracker } from '../../modules/tracker/types.js';
import { findNestedRepos } from '../../engine/repos.js';
import { git } from '../../engine/git.js';
import { allowedFile, chatSummaries, dispositionOf, mimeOf, readConversation, ticketConversations, ticketFolders } from '../../engine/conversations.js';
import { buildStamp } from '../../board/console-info.js';
import { mountMockupApi } from './mockup.js';
import type { NewTicketInput, UploadedFile } from '../../board/actions.js';
import { cancelDraft, currentDraft, dismissDraft, draftFiles, draftJob, startDraft } from '../../engine/draft.js';
import { AGENTS, STEPS, ensureAgents, levelSteps, readAgent, roleForPhase, writeAgent, type AgentRole, type AgentTool } from '../../engine/agents.js';
import { builderLevel, effortOn, parseEffort, parseLevel, personLevels, resolveLevel, setPersonLevel, standardLevel, toolEfforts, type LevelOverrides } from '../../engine/levels.js';
import { MODEL_LEVELS } from '../../modules/ai-tool/types.js';
import { loadConfig } from '../../core/config.js';
import { installedEditors, openInEditor, ticketChanges } from '../../engine/changes.js';
import { corePrompts } from '../../engine/core-prompts.js';
import { harnessView } from '../../engine/harness.js';
import { addAddition, readHarness, removeAddition, ruleNote, setAdditionState, type AdditionState, type NewAddition } from '../../board/additions.js';
import { additionOf, lookInFolder } from '../../board/additions-folder.js';
import { addTriedGate, tryGate } from '../../engine/gate-run.js';
import { boardUsage } from '../../board/usage.js';
import { liveNow } from '../../board/now.js';
import { readUsual, type UsualBook } from '../../board/usual.js';
import { answerAsk } from '../../board/ask.js';
import { withProblem } from '../../board/problem.js';
import { expectWait, withKey } from '../../board/wait-key.js';
import { createSized } from '../../board/split.js';
import { DEFAULT_NETWORK, PACKAGE_HOSTS, blockedSites, guardNote, networkPolicy, parseNetwork, sandboxStatus } from '../../engine/sandbox.js';
import { guardSupport } from '../../engine/project-guard.js';
import { windowStartNote } from '../../engine/checks.js';
import { mountCostApi } from './cost.js';
import { saveSettings, type SettingsInput } from '../../board/settings.js';
import { freePortAndRetry } from '../../engine/free-port.js';
import { changeDecided } from '../../board/auto.js';
import { lookAgain } from '../../engine/try-app.js';
import { takeBack } from '../../engine/handover.js';
import { plainWords } from '../../core/for-people.js';
import { act } from './act.js';
import { toolWaitOf } from '../../engine/tools/index.js';
import { confirmDatabase, databaseView, learnDatabase, makeTemplateBeside, setDatabaseOptions, type DatabaseChange } from '../../engine/story-db.js';
import { bringBack, checkOutside, workOutside } from '../../board/outside.js';
import { outsidePrompt } from '../../engine/outside-guide.js';
import { SELF_DOCS_OFF, SELF_NOTE, SELF_RELEASES, isSelfProject } from '../../engine/self-project.js';
import { sendAsOf } from '../../engine/send-as-pr.js';

const DAY = 86_400_000;

/** The role behind each of a ticket's conversations. */
const SESSION_ROLE: Record<string, AgentRole> = { intake: 'analyst', build: 'builder', review: 'reviewer', tester: 'tester' };

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

export function mountBoardApi(app: Hono, opts: { paths: SquadPaths; control?: { startedAt: string; build: number; restart(): void } }): void {
  const bp = boardPaths(opts.paths.squadDir);
  const tried = <T>(t: T): T => {
    lookAgain(bp);
    return t;
  };
  // What is happening on a ticket now. One being saved after Looks right says so: only this board's memory knows.
  const nowOf = (t: Ticket, usual: UsualBook) => liveNow(t, usual, Date.now(), isSaving(bp, t.id));
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
        connection = { at: Date.now(), key, error: plainWords(err, 'Checking the tracker sign-in') };
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
  app.get('/api/v1/speech', (c) => c.json({ hasKey: speechModule().hasKey(root), label: speechModule().label, video: videoNotesWork() }));

  app.put('/api/v1/speech', async (c) => {
    const b = await body<{ key?: string; munsit?: string; remove?: boolean }>(c);
    return act(c, async () => {
      const speech = speechModule();
      if (b.remove) {
        speech.removeKey(root);
        return { ok: true, hasKey: speech.hasKey(root) };
      }
      const key = (b.key ?? b.munsit)?.trim();
      if (!key) throw new Error(`Paste your ${speech.label} key first.`);
      const said = await speech.checkKey(key);
      if (said === 'wrong') throw new BoardActionError(`${speech.label} did not accept this key, so it was not saved. Copy it again from your ${speech.label} account.`);
      speech.saveKey(root, key);
      return { ok: true, hasKey: true, ...(said === 'no-answer' ? { unchecked: true } : {}) };
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
      return c.json({ connected: true, error: plainWords(err, 'Reading the backlog'), sprints: [], items: [] });
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
    if (!boardExists(bp)) {
      const settings = settingsProblem(bp);
      return c.json({ ready: false, ...(settings ? { settings } : {}) });
    }
    const meta = readMeta(bp);
    const all = listTickets(bp);
    const broken = brokenTickets(bp, all);
    const records = [...brokenDecisions(bp), ...brokenReleases(bp), ...brokenBreakdowns(bp)];
    const recent = listReleases(bp).filter((r) => r.status === 'released' && r.date && Date.now() - Date.parse(r.date) < 30 * DAY);
    const ctl = opts.control;
    const usual = readUsual(bp);
    return c.json({
      ready: true,
      meta,
      // squad-kit's own code: the plain notes its pages show (engine/self-project.ts).
      ...(isSelfProject(bp, meta) ? { self: { note: SELF_NOTE, releases: SELF_RELEASES, docs: SELF_DOCS_OFF } } : {}),
      // A newer squad-kit build on disk than the one this board runs: offer a restart.
      console: ctl ? { startedAt: ctl.startedAt, outdated: ctl.build > 0 && buildStamp() > ctl.build } : null,
      // Each ticket with what is happening on it now, in words: the card's line, its time and its usual time.
      // A story that waits for a tool on this computer says which, with the link to its line on the Tools page.
      // `waitKey` marks what each one waits on the person for now, so a decision card in a chat can tell it changed.
      tickets: all.filter((t) => t.stage !== 'done' && !t.archived).map((t) => ({ ...t, now: nowOf(t, usual), ...toolWaitOf(bp, t), ...withKey(t) })),
      // Archived tickets leave the board; "Show archived" shows them again.
      archived: all.filter((t) => t.stage !== 'done' && t.archived),
      ...(broken.length ? { broken } : {}),
      // Decisions, releases and breakdowns whose file cannot be read: their own pages show them too.
      ...(records.length ? { brokenRecords: records } : {}),
      stats: {
        released30: recent.reduce((n, r) => n + r.tickets.length, 0),
        bugs30: recent.reduce((n, r) => n + (r.bugs?.length ?? 0), 0),
        open: all.filter((t) => t.stage !== 'done' && !t.mergedAt && !t.archived).length,
      },
    });
  });

  app.get('/api/v1/tickets/:id', (c) => {
    const problem = ticketProblem(bp, c.req.param('id'));
    if (problem) return c.json({ error: problem }, 409);
    const t = readTicket(bp, c.req.param('id'));
    // Looking at a story that waits for a tool checks this computer again beside, so it goes on soon after the install.
    if (!t) return c.json({ error: 'not found' }, 404);
    // Merged here, with its work going on by pull request: how to send it (engine/send-as-pr.ts).
    const sendAs = sendAsOf(bp, t);
    return c.json({ ...withProblem(t), now: nowOf(t, readUsual(bp)), ...toolWaitOf(bp, t, true), ...withKey(t), ...(sendAs ? { sendAs } : {}) });
  });

  // What is happening on a ticket now, from its live record. Asking about it is answered from the same record, at
  // once and with no AI cost; anything it cannot answer offers a talk with an agent instead.
  app.get('/api/v1/tickets/:id/status', (c) => {
    const t = readTicket(bp, c.req.param('id'));
    return t ? c.json(nowOf(t, readUsual(bp))) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/v1/tickets/:id/status/ask', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => {
      const t = readTicket(bp, c.req.param('id'));
      if (!t) throw new Error(`No ticket ${c.req.param('id').toUpperCase()} on this board.`);
      const text = (b.text ?? '').trim();
      if (!text) throw new Error('Write your question first.');
      const usual = readUsual(bp);
      return answerAsk(t, nowOf(t, usual), usual, text);
    });
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
    // The AI tool that ran the role says how to open the session in a terminal.
    const role: AgentRole = key === 'chat' ? (t?.chat?.with ?? 'analyst') : (SESSION_ROLE[key] ?? 'builder');
    const tool = aiTool(readAgent(bp, role).tool);
    const open = tool?.resumeCommand ? { command: tool.resumeCommand(id, conv?.cwd), tool: tool.label } : {};
    if (!conv) return c.json({ sessionId: id, updates: [], total: 0, ...open });
    return c.json({ ...conv, protocol: 'acp/v1', ...open });
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
        'content-disposition': dispositionOf(inline ? 'inline' : 'attachment', file),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=300',
      },
    });
  });

  // An agent's HTML mockup, in its sealed frame (api/mockup.ts).
  mountMockupApi(app, bp);

  // `sized`: made from a draft whose size was judged (board/split.ts): `checked` one story, `kept` or `brd` as one anyway.
  app.post('/api/v1/tickets', async (c) => {
    const b = await body<Partial<NewTicketInput> & { sized?: string }>(c);
    const sized = b.sized === 'checked' || b.sized === 'kept' || b.sized === 'brd' ? b.sized : null;
    const input: NewTicketInput = {
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
      ...(b.noNewTests === true ? { noNewTests: true } : {}),
      ...(typeof b.key === 'string' && b.key ? { key: b.key.slice(0, 80) } : {}),
    };
    return act(c, () => (sized ? createSized(bp, input, sized) : createTicket(bp, input)));
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
      return c.json({ error: plainWords(err, 'Reading a draft') }, 404);
    }
  });
  app.get('/api/v1/tickets/draft/:id/files', (c) => act(c, () => draftFiles(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/draft/:id/cancel', (c) => act(c, () => cancelDraft(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/draft/:id/dismiss', (c) => act(c, () => dismissDraft(bp, c.req.param('id'))));

  app.post('/api/v1/pull', async (c) => {
    const b = await body<{ ref?: string }>(c);
    return act(c, () => pullTicket(bp, b.ref ?? ''));
  });

  // `expect` (here and on approve, change and reply below): pressed on a decision card in a chat, the story must still
  // wait on what the card showed (board/wait-key.ts). The board's own buttons leave it out.
  app.post('/api/v1/tickets/:id/answers', async (c) => {
    const b = await body<{ answers?: Record<string, { choice: string; value?: string }>; expect?: string }>(c);
    return act(c, () => {
      expectWait(bp, c.req.param('id'), b.expect);
      return answerQuestions(bp, c.req.param('id'), b.answers ?? {});
    });
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

  // Looks right, and Something's wrong below, stop the copy of the app being tried at once (engine/try-app.ts).
  app.post('/api/v1/tickets/:id/approve', async (c) => {
    const b = await body<{ expect?: string }>(c);
    return act(c, async () => {
      expectWait(bp, c.req.param('id'), b.expect);
      return tried(await approveBeside(bp, c.req.param('id')));
    });
  });
  app.post('/api/v1/tickets/:id/stop', (c) => act(c, () => stopTicket(bp, c.req.param('id'))));
  // A story squad-kit made waits on the board until the person starts it.
  app.post('/api/v1/tickets/:id/start', (c) => act(c, () => startTicket(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/unstick', (c) => act(c, () => endStuckCommand(bp, c.req.param('id'))));
  // Free the port and try again: only a program squad-kit started on the app's port (src/engine/free-port.ts).
  app.post('/api/v1/tickets/:id/free-port', (c) => act(c, () => freePortAndRetry(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/keep-waiting', async (c) => {
    const b = await body<{ minutes?: number }>(c);
    return act(c, () => keepWaiting(bp, c.req.param('id'), b.minutes ?? 10));
  });
  app.post('/api/v1/tickets/:id/restart', (c) => act(c, () => restartStep(bp, c.req.param('id'))));

  app.post('/api/v1/tickets/:id/change', async (c) => {
    const b = await body<{ text?: string; expect?: string }>(c);
    return act(c, () => {
      expectWait(bp, c.req.param('id'), b.expect);
      return tried(requestChange(bp, c.req.param('id'), b.text ?? ''));
    });
  });

  // Everything the ticket changed against main, read from its own copy.
  app.get('/api/v1/tickets/:id/changes', (c) => act(c, () => ticketChanges(bp, c.req.param('id'))));

  app.get('/api/v1/editors', (c) => c.json({ editors: installedEditors() }));

  app.post('/api/v1/tickets/:id/open-editor', async (c) => {
    const b = await body<{ editor?: string }>(c);
    return act(c, () => openInEditor(bp, c.req.param('id'), b.editor));
  });

  app.post('/api/v1/tickets/:id/reply', async (c) => {
    const b = await body<{ text?: string; expect?: string }>(c);
    return act(c, () => {
      expectWait(bp, c.req.param('id'), b.expect);
      return answerAgent(bp, c.req.param('id'), b.text ?? '');
    });
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

  // Talk it through with an agent: start, send (with files), write the spec or design from it, or Done. `ask` is Ask a
  // question: questions only in every state, with whoever knows the story best unless `with` names the agent.
  app.post('/api/v1/tickets/:id/chat/start', async (c) => {
    const b = await body<{ with?: AgentName; ask?: boolean }>(c);
    return act(c, () => (b.ask ? askQuestion(bp, c.req.param('id'), b.with) : startChat(bp, c.req.param('id'), b.with ?? 'analyst')));
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
      return act(c, () => {
        throw err;
      });
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

  // Change what the squad decided for you (Builds by itself): a small change on the ticket, or a new linked ticket
  // once it is accepted.
  app.post('/api/v1/tickets/:id/decided/:did', async (c) => {
    const b = await body<{ text?: string }>(c);
    return act(c, () => changeDecided(bp, c.req.param('id'), c.req.param('did'), b.text ?? ''));
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

  // A conversation in any AI tool, outside squad-kit: move it there, the words to paste, bring it back, and Check.
  app.get('/api/v1/outside-prompt', (c) => act(c, () => ({ prompt: outsidePrompt(bp) })));
  app.get('/api/v1/tickets/:id/outside-prompt', (c) => act(c, () => ({ prompt: outsidePrompt(bp, requireTicket(bp, c.req.param('id'))) })));
  app.post('/api/v1/tickets/:id/outside', (c) =>
    act(c, async () => {
      const t = await workOutside(bp, c.req.param('id'));
      return { ...t, prompt: outsidePrompt(bp, t) };
    }),
  );
  app.post('/api/v1/tickets/:id/bring-back', (c) => act(c, () => bringBack(bp, c.req.param('id'))));
  app.post('/api/v1/tickets/:id/check-outside', (c) => act(c, () => checkOutside(bp, c.req.param('id'))));

  // Hand over: push the ticket's branch with its code and documents, and name the new owner.
  app.post('/api/v1/tickets/:id/hand-over', async (c) => {
    const b = await body<{ to?: string; note?: string }>(c);
    return act(c, () => handOver(bp, c.req.param('id'), { to: b.to ?? '', note: b.note }));
  });

  // A ticket nobody can touch: handed to a misspelled name, or to someone who left.
  app.post('/api/v1/tickets/:id/take-back', async (c) => {
    const b = await body<{ reason?: string }>(c);
    return act(c, () => takeBack(bp, c.req.param('id'), b.reason ?? ''));
  });

  app.post('/api/v1/tickets/:id/decide', async (c) => {
    const b = await body<{ choice?: number; note?: string; reason?: string }>(c);
    return act(c, () => decideStuckBeside(bp, c.req.param('id'), Number(b.choice), { note: b.note, reason: b.reason }));
  });

  // The Architect's change to the test command: { use: true } takes it, { use: false } keeps the current one.
  app.post('/api/v1/tickets/:id/test-command', async (c) => {
    const b = await body<{ use?: boolean }>(c);
    return act(c, () => {
      if (typeof b.use !== 'boolean') throw new BoardActionError('Say { "use": true } to use the new test command, or { "use": false } to keep the current one.');
      return decideTestCommand(bp, c.req.param('id'), b.use);
    });
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
        for (const view of copyViews(meta, t)) {
          const repo = repoFor(meta, view);
          seen.set(repo.path, { repo: repo.path, branch: repo.base, remote: repo.remote });
        }
      }
      return [...seen.values()];
    };
    return c.json(
      listReleases(bp).map((r) => ({
        ...withNotes(bp, r),
        targets: targets(r),
        items: r.tickets.map((id) => {
          const t = tickets.find((x) => x.id === id);
          return { id, title: titleOf(id, r), gates: t?.gates ?? null, kind: t?.kind ?? 'feature', ...(t?.outside ? { outside: t.outside } : {}), ...(t?.noNewTests ? { noNewTests: true } : {}) };
        }),
      })),
    );
  });

  app.put('/api/v1/releases/:v/notes', async (c) => {
    const b = await body<{ notes?: string }>(c);
    return act(c, () => saveReleaseNotes(bp, c.req.param('v'), b.notes ?? ''));
  });

  app.post('/api/v1/releases/:v/release', async (c) => {
    const { goOn } = await body<{ goOn?: string }>(c);
    return act(c, () => releaseVersion(bp, c.req.param('v'), goOn));
  });

  // The push of a release failed: it stays open until its commits and tags reach the remote.
  app.post('/api/v1/releases/:v/push', (c) => act(c, () => pushReleaseAgain(bp, c.req.param('v'))));
  // It reached the remote another way (merged by hand, or a pull request squashed it): the person says so.
  // Not there, or no answer from the remote: 409, with the words to show. The same call with `anyway` is the second yes.
  app.post('/api/v1/releases/:v/mark-sent', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { reason?: string; anyway?: boolean };
    try {
      return c.json(await markReleaseSent(bp, c.req.param('v'), { ...(b.reason ? { reason: b.reason } : {}), ...(b.anyway === true ? { anyway: true } : {}) }));
    } catch (err) {
      if (err instanceof SentNotSure) return c.json({ error: err.message }, 409);
      return act(c, () => {
        throw err;
      });
    }
  });

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
    const broken = brokenDecisions(bp);
    return c.json({ decisions: listDecisions(bp), map: meta.map, lessons: meta.lessons, ...(broken.length ? { broken } : {}) });
  });

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
    if (!fs.existsSync(abs)) return c.text('not found', 404);
    // What the API answered, saved by squad-kit: the record to read, and a file it answered with to download, never to show.
    if (isSavedProof(name)) return new Response(fs.readFileSync(abs), { headers: { 'content-type': 'application/json' } });
    if (/-api-\d+-answer\.[a-z]+$/.test(name)) return new Response(fs.readFileSync(abs), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` } });
    if (!name.endsWith('.png')) return c.text('not found', 404);
    return new Response(fs.readFileSync(abs), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
  });

  // What Settings says beside a typed start command that opens a window: the start squad-kit runs instead. The rule is the
  // engine's (windowStartNote in engine/checks.ts). It reads the code folder asked for when it is one of the project's,
  // else the project's own folder. Nothing is saved.
  app.get('/api/v1/settings/start', (c) => {
    const repo = c.req.query('repo') ?? '.';
    const folder = boardExists(bp) && readMeta(bp).repos?.some((r) => r.path === repo) ? path.join(root, repo) : root;
    return c.json({ note: windowStartNote(folder, c.req.query('command')) });
  });

  app.put('/api/v1/settings', async (c) => {
    const b = await body<SettingsInput>(c);
    return act(c, () => saveSettings(bp, b));
  });

  // What the product is made of. An engineer corrects it here; the Architect found it when it read the project.
  const partChange = (b: Record<string, unknown>): PartChange => ({
    ...(typeof b.name === 'string' ? { name: b.name } : {}),
    ...(typeof b.shared === 'boolean' ? { shared: b.shared } : {}),
    ...(typeof b.repo === 'string' ? { repo: b.repo } : {}),
    ...(typeof b.folder === 'string' ? { folder: b.folder } : {}),
    ...(Array.isArray(b.needs) ? { needs: b.needs.map(String) } : {}),
    ...(typeof b.url === 'string' ? { url: b.url } : {}),
    ...(typeof b.off === 'boolean' ? { off: b.off } : {}),
  });
  app.get('/api/v1/parts', (c) => {
    if (!boardExists(bp)) return c.json({ parts: [], repos: [], several: false });
    const meta = readMeta(bp);
    return c.json({ parts: partsOf(meta), repos: repoPaths(meta), several: severalParts(meta) });
  });
  app.post('/api/v1/parts', async (c) => {
    const b = await body<Record<string, unknown>>(c);
    return act(c, () => addPart(bp, partChange(b)));
  });
  app.put('/api/v1/parts/:id', async (c) => {
    const b = await body<Record<string, unknown>>(c);
    return act(c, () => changePart(bp, c.req.param('id'), partChange(b)));
  });
  app.post('/api/v1/parts/:id/remove', (c) =>
    act(c, () => {
      removePart(bp, c.req.param('id'));
      return { ok: true };
    }),
  );

  // The files agents may not touch: names only. What a file holds never passes through here.
  app.get('/api/v1/project-files', (c) => (boardExists(bp) ? c.json(projectFilesView(bp)) : c.json({ local: [], locked: [], repos: [], docker: [] })));
  const fileRoute = (route: string, run: (repo: string | undefined, file: string | undefined) => unknown) =>
    app.post(`/api/v1/project-files/${route}`, async (c) => {
      const b = await body<{ repo?: unknown; path?: unknown }>(c);
      return act(c, () => run(typeof b.repo === 'string' ? b.repo : undefined, typeof b.path === 'string' ? b.path : undefined));
    });
  fileRoute('local', (repo, file) => addLocalFile(bp, repo, file));
  fileRoute('locked', (repo, file) => addLockedFile(bp, repo, file));
  fileRoute('use-mine', (repo, file) => useMyFile(bp, repo, file));
  fileRoute('remove', (repo, file) => removeProjectFile(bp, repo, file));
  app.post('/api/v1/project-files/lock-docker', (c) => act(c, () => ({ locked: lockDockerFiles(bp) })));

  // The project's database and each story's own copy of it, for engineers. An address's password never passes through here.
  const noDatabase = { database: null, template: null, stories: [], notes: [], missing: [], words: 'squad-kit has not found a database in this project.' };
  app.get('/api/v1/database', (c) => (boardExists(bp) ? c.json(databaseView(bp)) : c.json(noDatabase)));
  app.post('/api/v1/database/find', (c) =>
    act(c, () => {
      learnDatabase(bp, { again: true });
      return databaseView(bp);
    }),
  );
  app.post('/api/v1/database/confirm', async (c) => {
    const b = await body<Record<string, unknown>>(c);
    const change: DatabaseChange = Object.fromEntries(['kind', 'name', 'repo', 'env', 'file', 'key', 'address'].filter((k) => typeof b[k] === 'string').map((k) => [k, b[k] as string]));
    return act(c, () => {
      confirmDatabase(bp, readMeta(bp).user.name, change);
      return databaseView(bp);
    });
  });
  app.post('/api/v1/database/template', (c) =>
    act(c, () => {
      makeTemplateBeside(bp, readMeta(bp).user.name);
      return databaseView(bp);
    }),
  );
  app.put('/api/v1/database', async (c) => {
    const b = await body<{ hidePersonal?: unknown; sampleRows?: unknown }>(c);
    return act(c, () => {
      setDatabaseOptions(bp, {
        ...(typeof b.hidePersonal === 'boolean' ? { hidePersonal: b.hidePersonal } : {}),
        ...(typeof b.sampleRows === 'number' || b.sampleRows === null ? { sampleRows: b.sampleRows as number | null } : {}),
      });
      return databaseView(bp);
    });
  });

  // Whether the Builder's and Tester's commands run in a sandbox on this computer, and the hosts they may reach.
  app.get('/api/v1/sandbox', (c) => {
    const tools = sandboxStatus();
    const note = guardNote(process.platform, tools);
    const g = guardSupport();
    const allow = boardExists(bp) ? readMeta(bp).guard : undefined;
    const guard = { on: g.on, why: g.why, ...(g.fix ? { fix: g.fix } : {}), allowRead: allow?.allowRead ?? [], allowWrite: allow?.allowWrite ?? [] };
    // The project's network level, what it does to the project's own commands on this computer, and the sites refused lately.
    const level = (boardExists(bp) ? parseNetwork(readMeta(bp).network) : null) ?? DEFAULT_NETWORK;
    const network = { level, commands: networkPolicy(level).commands, blocked: boardExists(bp) ? blockedSites(bp).slice(0, 20) : [] };
    return c.json({ tools, registries: PACKAGE_HOSTS, allowedHosts: boardExists(bp) ? (readMeta(bp).allowedHosts ?? []) : [], guard, network, ...(note ? { note } : {}) });
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

  // Every gate, limit and safety rule, with the engine's real values and what really happened, for the Harness page.
  // What a team adds to its harness. squad-kit's own gates are not in that file, so every attempt on one is refused here.
  const addOne = (input: NewAddition & { name: string }, from?: string) => {
    const meta = readMeta(bp);
    const by = meta.user.name;
    if (input.kind !== 'gate') {
      const added = addAddition(bp, by, input, from);
      return { added, ...(added.kind === 'rule' && ruleNote(added.text) ? { note: ruleNote(added.text) } : {}) };
    }
    if (severalParts(meta) && !input.part) throw new Error('Pick which part it runs in.');
    const { added, failsToday } = addTriedGate(bp, by, input, from);
    return { added, ...(failsToday ? { note: "It fails on today's code, so it stays on Try first until that is fixed." } : {}) };
  };
  app.post('/api/v1/harness/additions', async (c) => {
    const input = await body<NewAddition & { name: string }>(c);
    return act(c, () => addOne(input));
  });
  app.post('/api/v1/harness/additions/:id/state', async (c) => {
    const { state } = await body<{ state: AdditionState }>(c);
    return act(c, () => setAdditionState(bp, readMeta(bp).user.name, c.req.param('id'), state));
  });
  app.post('/api/v1/harness/additions/:id/remove', (c) => act(c, () => removeAddition(bp, readMeta(bp).user.name, c.req.param('id'))));
  app.post('/api/v1/harness/try', async (c) => {
    const input = await body<{ command?: string; part?: string; id?: string }>(c);
    return act(c, () => tryGate(bp, readMeta(bp).user.name, input));
  });
  const lookIn = (folder: string | undefined) => {
    if (!folder?.trim()) throw new Error('Choose a folder first.');
    return lookInFolder(folder, readHarness(bp).additions, reposOf(readMeta(bp))[0]?.commands ?? {});
  };
  app.post('/api/v1/harness/folder', async (c) => {
    const { path: folder } = await body<{ path?: string }>(c);
    return act(c, () => lookIn(folder));
  });
  app.post('/api/v1/harness/folder/add', async (c) => {
    const { path: folder, picks } = await body<{ path?: string; picks?: ({ key: string } & Parameters<typeof additionOf>[1])[] }>(c);
    return act(c, () => {
      const look = lookIn(folder);
      const added: string[] = [];
      const left: { name: string; why: string }[] = [];
      for (const pick of picks ?? []) {
        const f = look.finds.find((x) => x.key === pick.key);
        // Only what the folder holds now, and what can be ticked. An import can only add.
        if (!f || f.out || f.already) continue;
        try {
          added.push(addOne(additionOf(f, pick), look.name).added.name);
        } catch (err) {
          left.push({ name: f.name, why: plainWords(err, 'Adding from a folder') });
        }
      }
      return { added, left };
    });
  });
  app.get('/api/v1/harness', (c) => c.json(boardExists(bp) ? harnessView(readMeta(bp), bp) : harnessView()));

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
  app.get('/api/v1/agents/:role/prompts', async (c) => {
    const role = c.req.param('role') as AgentRole;
    if (!AGENTS.some((a) => a.role === role)) return c.json({ error: 'not found' }, 404);
    return c.json(await corePrompts(bp, role, c.req.query('ticket') || undefined));
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

  mountCostApi(app, bp);

  app.post('/api/v1/demo/reset', (c) => {
    if (boardExists(bp) && readMeta(bp).engine !== 'demo') return c.json({ error: 'Only a demo board can be reset.' }, 400);
    const speed = boardExists(bp) ? readMeta(bp).speed : 1;
    const project = boardExists(bp) ? readMeta(bp).project : undefined;
    seedDemoBoard(bp, { speed, project });
    return c.json({ ok: true });
  });
}
