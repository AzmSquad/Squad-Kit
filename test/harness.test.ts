import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { harnessView } from '../src/engine/harness.js';
import { AGENTS } from '../src/engine/agents.js';
import { QUALITIES, QUALITY_PRESETS } from '../src/engine/levels.js';
import { MAX_CHECK_TRIES, MAX_REVIEW_ROUNDS } from '../src/engine/live.js';
import { MAX_PICTURES, MAX_PICTURES_PER_DONE_WHEN, MAX_PROOF_ROUNDS, MAX_RETAKES } from '../src/engine/proof-verdict.js';
import { REFUSALS_TO_STOP } from '../src/engine/window.js';
import { PACKAGE_HOSTS, PRIVATE } from '../src/engine/sandbox.js';
import { isPlain } from '../src/engine/shots.js';
import { mountBoardApi } from '../src/console/api/board.js';
import { buildPaths } from '../src/core/paths.js';
import { boardPaths, writeMeta } from '../src/board/store.js';
import { seedDemoBoard } from '../src/board/demo.js';

/**
 * The Harness page must really show everything, and stay that way. Every gate, stop and limit in the engine has a row
 * on the page or a written reason here why a person doesn't need it, so a new one with neither fails this test.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Every source file of the engine and the board. A demo board's files only play a recording back. */
function sources(): { file: string; text: string }[] {
  return ['src/engine', 'src/board'].flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.ts') && !f.startsWith('demo') && !f.startsWith('harness'))
      .map((f) => ({ file: f, text: read(`${dir}/${f}`) })),
  );
}

const view = harnessView();
const rows = [...view.stages.flatMap((s) => s.gates), ...view.alwaysOn];
const rowIds = new Set(rows.map((r) => r.id));

/** What a name in the engine looks like when it is a limit: a most, a time, a number of tries. */
const LIMIT_NAME = /^MAX_|_(MS|TRIES|ROUNDS|TO_STOP|MIN|S|AFTER|LIMIT)$/;

/** Limits a person doesn't need to see, by file and name, each with why. */
const EXCUSED: Record<string, string> = {
  'gate-run.ts:OLD_COPY_MS': 'When a copy left by an app that ended gets cleaned up. Nobody waits on this, and it stops nothing.',
  'sandbox.ts:MAX_BLOCKED_SITES': 'How many refused sites the log on Harness → Safety keeps. A refused site stops nothing.',
  'additions.ts:LOCK_LEFT_MS': 'A lock a closed program left behind. A save takes a moment, and nobody waits on this.',
  'additions.ts:LOCK_WAIT_MS': 'How long one save waits for another. It ends in a plain "try again".',
  // How often squad-kit looks at something. Nothing waits on them, and nothing stops at them.
  'try-app.ts:WATCH_MS': 'How often it looks at a copy someone is trying.',
  'product-lock.ts:LOOK_EVERY_MS': 'How often a waiting story looks again. WAIT_LIMIT_MS is the limit.',
  'auto.ts:LANDING_LOOK_MS': 'How often a waiting story looks again. MAX_LANDING_WAIT_MS is the limit.',
  'save-trouble.ts:SAVE_CHECK_MS': 'How often a held project tries its test write.',
  'free-port.ts:LOOK_MS': 'How often it looks at who holds the app port.',
  'live.ts:PICK_UP_MS': 'How often it looks for stories teammates pushed.',
  'watchdog.ts:SLEEP_MS': 'Tells a computer that slept from a step that went quiet.',
  'watchdog.ts:NO_LOOK_MS': 'Tells a computer that slept from a step that went quiet.',
  'watchdog.ts:IDLE_MS': 'Part of the same look as QUIET_MS and LONG_MS, which are on the page.',
  'usage-limit.ts:AFTER_RESET_MS': 'A short pause after your AI limit ends, so the first try does not land just before it.',
  'usage-limit.ts:LONGEST_MS': 'A reset time further off than this is not believed. RETRY_MS takes over.',
  // Inside one step. The step's own limit, on the page, is the one a person can feel.
  'window.ts:API_WAIT_MS': 'One call inside a proof step. PROOF_STEP_MS is the limit.',
  'shots.ts:CALL_MS': 'One call inside a proof step. PROOF_STEP_MS is the limit.',
  'shots.ts:STEP_MS': 'One click inside one picture.',
  'shots.ts:MAX_STEPS': 'Clicks before one picture. More is a call in the wrong shape, and MISTAKES_TO_STOP is on the page.',
  'shots.ts:MAX_PAUSE_MS': 'One pause on a page, inside one picture.',
  'shots.ts:MAX_NAME': 'The length of one field in a call.',
  'shots.ts:MAX_PAGE': 'The length of one field in a call.',
  'shots.ts:MAX_VALUE': 'The length of one field in a call.',
  'window.ts:MAX_ONLY': 'The length of one field in a call.',
  'window-server.ts:KEEP_IDLE_MS': 'A connection detail inside one run.',
  'window-server.ts:MAX_BODY': 'The size of one call. Real calls are far smaller.',
  'window.ts:MAX_API_ANSWER': 'What is kept of one API answer. A file it answers with is saved whole.',
  'window.ts:MAX_API_BODY': 'The size of one call.',
  'window.ts:MAX_API_FILE': 'A file this big is not a proof.',
  'window.ts:MAX_IMAGE_BYTES': 'A bigger picture is saved and named, not sent back to the agent.',
  'window.ts:MAX_IMAGE_BYTES_SENT': 'After this, pictures are saved and named, not sent back to the agent.',
  'proof-check.ts:MAX_BYTES': 'A file this big is no screenshot. The story says so in plain words.',
  'proof-check.ts:MAX_PIXELS': 'A picture this big is no screenshot. The story says so in plain words.',
  'proof-check.ts:SLACK_MS': 'Clocks and file systems round. It keeps a real picture from looking old.',
  'process-group.ts:KILL_AFTER_MS': 'Seconds a stopped program gets to end by itself.',
  'compose-run.ts:DOCKER_STOP_MS': 'How long a database gets to stop cleanly. Nothing waits on it.',
  'git.ts:STALE_LOCK_MS': 'Cleans up after a crash.',
  'git.ts:SHORT_HOOK_MS': 'The same check as HOOK_MS, on a small save.',
  'hook-git.ts:WORDS_LIMIT': "What is kept of a hook's words for an engineer.",
  'acp-runner.ts:RUN_MS': 'A fallback for a run that names no limit of its own. Every step on the page names one.',
  'lock.ts:RELEASE_LOCK_MAX_MS': 'An older lock was left behind by a crash. Nothing ever waits on it.',
  // Small helpers beside the work, where a late answer only asks you to try again.
  'live.ts:ANSWER_STEP_MS': 'The Analyst explains one of its questions. A late answer says to ask again.',
  'breakdown-job.ts:BRD_ANSWER_MS': 'The Analyst explains one of its questions. A late answer says to ask again.',
  'draft.ts:DRAFT_MS': 'Filling in the new ticket form from pasted text. The form stays yours either way.',
  'draft.ts:KEEP_MS': 'How long a draft nobody came back for is kept.',
  'payment.ts:KEEP_MS': 'How long a finding about how you pay is remembered.',
  'apps.ts:NEW_FOR_MS': 'How long Your apps offers a new version.',
  'shots.ts:SETUP_MS': 'Getting the picture browser, the first time only. The story says so while it happens.',
  // What is kept or read, not what the squad may do.
  'conversations.ts:MAX_IMAGE': 'What the conversation log keeps.',
  'conversations.ts:MAX_RESULT': 'What the conversation log keeps.',
  'conversations.ts:MAX_TEXT': 'What the conversation log keeps.',
  'report.ts:MAX_CONVERSATION': 'What a report file keeps of one conversation.',
  'changes.ts:MAX_PATCH': 'How much of one change the Changes tab shows.',
  'changes.ts:MAX_DIFF_READ': 'How much of a change the Changes tab reads to show that much. Past it the tab lists the files.',
  'git.ts:LOCK_WAITS_MS': 'How long a git beside everything else waits for one holding a lock. It ends in the same words as a git that failed.',
  'git.ts:LOCK_WAITS_NOW_MS': 'The same for a git that cannot wait long. Nobody sees this.',
  'depends.ts:MAX_FILES': 'How many files per open story go to the agents.',
  'first-look.ts:MAX_FILES': 'Where counting a project stops.',
  'review-look.ts:MAX_FILES': "How many files go into a chat's opening. The agent reads the rest itself.",
  'weakened.ts:MAX_FILES': 'How much the weakened tests check reads, so it takes a moment.',
  'weakened.ts:MAX_BYTES': 'How much the weakened tests check reads, so it takes a moment.',
  'auto.ts:MAX_SOURCES': 'How many sources one stop names.',
  'project-files.ts:MAX_DOCKER_FILES': 'How many Docker files Settings offers to lock.',
  'new-project.ts:MAX_NAME': "The length of a project's name.",
  'spreadsheet.ts:MAX_ROWS': 'How much of an Excel answer an agent reads.',
  'spreadsheet.ts:MAX_COLUMNS': 'How much of an Excel answer an agent reads.',
  'spreadsheet.ts:MAX_SHEETS': 'How much of an Excel answer an agent reads.',
  'spreadsheet.ts:MAX_ENTRIES': 'Keeps a broken Excel file from filling the computer.',
  'spreadsheet.ts:MAX_UNPACKED': 'Keeps a broken Excel file from filling the computer.',
  'requirements-text.ts:MAX_UNPACKED': 'Keeps a broken document from filling the computer. You get a plain refusal.',
  'requirements-text.ts:MAX_ENTRIES': 'Keeps a broken document from filling the computer. You get a plain refusal.',
  'requirements-text.ts:MAX_XML': 'Keeps a broken document from filling the computer. You get a plain refusal.',
  'requirements-text.ts:MAX_DEPTH': 'Keeps a broken document from filling the computer. You get a plain refusal.',
  // Not limits at all.
  'clock.ts:SLOW_FLOOR_S': 'Only when a card may say a step is slow. Nothing stops at it.',
  'now.ts:LONG_WAIT_S': 'Only when the tracker says a stage waited long, on a small line. Nothing stops at it.',
  'cost.ts:QUALITY_AFTER': 'When the averages on the Agents tab start to show.',
  'usual.ts:LEARN_AFTER': 'When the usual times come from your project.',
  'setup-state.ts:LEARN_AFTER': 'When the usual times come from your project.',
  'requirements-tracker.ts:DEMO_WRITE_MS': "Only the demo board's pretend tracker.",
  'merged-outside.ts:FIRST_LOOK_MS': 'How soon after the board opens it first looks for merges on the code host. Nothing waits for it.',
};

/** Rules with no name a scan could find, and why they have no row. Each must still be in the code it names. */
const NO_ROW: { file: string; word: string; why: string }[] = [
  { file: 'src/engine/live.ts', word: 'TURNS_BEFORE_BANNER', why: 'The board says it itself, and only when something is really wrong.' },
  { file: 'src/engine/live.ts', word: 'holdNewRuns', why: "An update's own card says what it waits for." },
  { file: 'src/board/lock.ts', word: 'claimSquad', why: 'Keeps a terminal from starting a second squad. Nobody ever meets it.' },
  { file: 'src/board/owner.ts', word: 'isMine', why: 'A story stays with its owner. It only matters between teammates, and Hand over says so.' },
  { file: 'src/engine/port-ask.ts', word: 'inTheWay', why: 'A busy port is the engine to settle. A person never needs to know.' },
  { file: 'src/engine/live.ts', word: 'answerAgainPrompt', why: 'An agent is asked once more for a complete answer. If that fails it is a stop like any other.' },
  { file: 'src/engine/branches.ts', word: 'cleanBranches', why: 'Tidying after a release. It never deletes work that is not merged.' },
];

/** Stops with no name of their own: each is a plain card with ways out, the row "Every stop has a way out". */
const STOPS_PER_FILE: Record<string, number> = {
  'actions.ts': 3,
  'breakdown-job.ts': 5,
  'budget.ts': 1,
  'live.ts': 31,
  'sync.ts': 1,
};

/** Times written where they are used, each with why it needs no row. */
const INLINE_TIMES: Record<string, string> = {
  'live.ts: 2 * 60_000': 'How often it looks again at a merge that waits.',
  'live.ts: 10 * 60_000': 'Tells a step that was waiting a long time from one cut off just now.',
  'checks.ts: 3 * 60_000': 'The same as APP_WAIT_MS, as a default.',
  'media.ts: 5 * 60_000': 'Pulling the sound out of a video note, beside the work.',
  'media.ts: 3 * 60_000': 'Pulling pictures out of a video note, beside the work.',
  'release.ts: 30_000': 'A quick look at the code host before a push.',
  'handover.ts: 60_000': 'A look on the remote for new work, beside the work. Offline, the last look counts.',
  'sync.ts: 30 * 60_000': 'The longest wait before trying the tracker again.',
  'sync.ts: 10 * 60_000': 'How often the wiki is copied.',
};

describe('limits', () => {
  const declared = sources().flatMap(({ file, text }) => [...text.matchAll(/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b/gm)].filter((m) => LIMIT_NAME.test(m[1]!)).map((m) => ({ file, name: m[1]!, key: `${file}:${m[1]!}` })));
  const shown = new Set(view.limits.map((l) => l.id));

  it('every limit in the engine has a row, or a written reason why not', () => {
    const missing = declared.filter((d) => !EXCUSED[d.key] && !shown.has(d.name)).map((d) => d.key);
    expect(missing, 'Give each of these a row in src/engine/harness.ts, or a reason in EXCUSED').toEqual([]);
  });

  it('a row stands for one limit, and every row and reason is about one that still exists', () => {
    const open = declared.filter((d) => !EXCUSED[d.key]);
    for (const id of shown) {
      if (id === 'parallel') continue;
      expect(open.filter((d) => d.name === id).map((d) => d.key), id).toHaveLength(1);
    }
    expect(Object.keys(EXCUSED).filter((k) => !declared.some((d) => d.key === k))).toEqual([]);
    for (const [key, why] of Object.entries(EXCUSED)) expect(why.length, key).toBeGreaterThan(10);
  });

  it('a time is named where a person can see it, not written where it is used', () => {
    const found = sources().flatMap(({ file, text }) =>
      text
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !/^\s*(export )?const [A-Z]/.test(l))
        .flatMap((l) => [...l.matchAll(/\b\d+ \* (?:60_000|MINUTE)\b|timeoutMs(?::| =) \d[\d_]*/g)].map((m) => `${file}: ${m[0].replace(/timeoutMs(?::| =) /, '')}`)),
    );
    expect([...new Set(found)].filter((t) => !INLINE_TIMES[t]), 'Name it as a constant, with a row or a reason in EXCUSED').toEqual([]);
    expect(Object.keys(INLINE_TIMES).filter((t) => !found.includes(t))).toEqual([]);
  });

  it('shows the real numbers from the engine', () => {
    const n = (id: string) => view.limits.find((l) => l.id === id)?.n;
    expect(n('MAX_CHECK_TRIES')).toBe(String(MAX_CHECK_TRIES));
    expect(n('MAX_REVIEW_ROUNDS')).toBe(String(MAX_REVIEW_ROUNDS));
    expect(n('MAX_RETAKES')).toBe(String(MAX_RETAKES));
    expect(n('MAX_PROOF_ROUNDS')).toBe(String(MAX_PROOF_ROUNDS - 1));
    expect(n('MAX_PICTURES')).toBe(String(MAX_PICTURES));
    expect(n('MAX_PICTURES_PER_DONE_WHEN')).toBe(String(MAX_PICTURES_PER_DONE_WHEN));
    expect(n('REFUSALS_TO_STOP')).toBe(String(REFUSALS_TO_STOP));
    const gate = (id: string) => rows.find((r) => r.id === id)!;
    expect(gate('checks').fail).toContain(`${MAX_CHECK_TRIES} tries`);
    expect(gate('review').fail).toContain(`${MAX_REVIEW_ROUNDS} rounds`);
    expect(gate('not-shown').fail).toContain(`${MAX_RETAKES} retakes`);
    expect(gate('proof').what).toContain(`${MAX_PICTURES_PER_DONE_WHEN} for each`);
    expect(gate('window').fail).toContain(`${REFUSALS_TO_STOP} refusals`);
    // The agent's job line is written in agents.ts, and the page shows it.
    expect(AGENTS.find((x) => x.role === 'reviewer')!.job).toContain(`${MAX_REVIEW_ROUNDS} rounds`);
  });

  it('shows every step of the most one run can use, on the project\'s Quality', () => {
    for (const quality of QUALITIES) {
      const caps = QUALITY_PRESETS[quality].caps;
      const page = harnessView({ quality } as never).caps;
      expect(page.map((c) => c.key).sort()).toEqual(Object.keys(caps).sort());
      for (const c of page) expect({ turns: c.turns, spendUsd: c.spendUsd }).toEqual(caps[c.key]);
    }
  });
});

describe('gates', () => {
  const types = read('src/board/types.ts');
  const union = (after: string) => [...new RegExp(`${after}\\s*([^;]+);`).exec(types)![1]!.matchAll(/'([\w-]+)'/g)].map((m) => m[1]!);
  /** A name in the types whose row goes by another name. */
  const ROW_OF: Record<string, string> = { hooks: 'hook', ticket: 'budget', month: 'budget', stuck: 'ways-out', yours: 'take-over' };

  it('every gate and stop in the types has a row', () => {
    const named = [
      ...union('gate\\?:'),
      ...union("kind\\?:(?= 'weakened')"),
      ...union('budget\\?:'),
      ...union('export interface GateOverride \\{[^}]*?gate:'),
      ...[...new RegExp('export interface Gates \\{([^}]*)\\}').exec(types)![1]!.matchAll(/^\s+(\w+): GateState;/gm)].map((m) => m[1]!),
    ];
    expect(named).toContain('weakened');
    expect(named).toContain('cap');
    expect(named).toContain('hooks');
    expect(named.filter((n) => !rowIds.has(ROW_OF[n] ?? n))).toEqual([]);
  });

  it('everything a story can wait for you on has a row', () => {
    const kinds = union('export type WaitingKind =');
    expect(kinds).toContain('depends');
    // Your check waits under the name of what it looks at.
    const row: Record<string, string> = { ...ROW_OF, proof: 'looks-right' };
    expect(kinds.filter((k) => !rowIds.has(row[k] ?? k))).toEqual([]);
    expect(rows.find((r) => r.id === 'looks-right')!.you).toBe(true);
  });

  it('a stop with no name of its own is counted, so a new one gets a look', () => {
    const now = Object.fromEntries(sources().map(({ file, text }) => [file, [...text.matchAll(/\bnew StepError\(|\.stuck = \{/g)].length]).filter(([, n]) => n));
    expect(now, 'A new stop: give it a row if a person should know it, then change STOPS_PER_FILE').toEqual(STOPS_PER_FILE);
  });

  it('rules with no row say why, and are still there', () => {
    for (const { file, word, why } of NO_ROW) {
      expect(read(file), word).toContain(word);
      expect(why.length, word).toBeGreaterThan(10);
      expect(rowIds.has(word)).toBe(false);
    }
  });

  it('the line runs from Setup to Release, and says what each track does at each stage', () => {
    expect(view.stages.map((s) => s.name)).toEqual(['Setup', 'Breakdown', 'Story', 'Plan', 'Build', 'Checks', 'Review', 'Proof', 'Your check', 'Merge', 'Release']);
    expect(view.tracks.map((t) => t.id)).toEqual(['full', 'express', 'auto']);
    for (const s of view.stages) {
      expect(s.gates.length, s.name).toBeGreaterThan(0);
      for (const t of view.tracks) expect(s.on[t.id as 'full'].sub, `${s.name} on ${t.id}`).toBeTruthy();
    }
    expect(rowIds.size).toBe(rows.length);
  });

  it('a gate a track skips is at a stage that track goes through on its own', () => {
    const skips = (id: string) => rows.find((r) => r.id === id)?.skip ?? [];
    expect(skips('plan')).toEqual(['express', 'auto']);
    expect(skips('questions')).toEqual(['express', 'auto']);
    expect(skips('spec')).toEqual(['express', 'auto']);
    expect(skips('looks-right')).toEqual(['auto']);
    for (const s of view.stages) {
      for (const g of s.gates) {
        for (const t of g.skip ?? []) expect(s.on[t].kind, `${g.id} on ${t}`).toBe('skip');
      }
    }
    // These never skip: the engine never waves a story past them.
    for (const id of ['checks', 'weakened', 'review', 'proof', 'merge', 'release']) expect(skips(id), id).toEqual([]);
  });

  it('says the same as the engine about the tracks', () => {
    const live = read('src/engine/live.ts');
    expect(live).toContain("if (x.track === 'auto') return acceptNext(x, 0.2, 1);");
    expect(live).toContain("if (track === 'express' || track === 'auto') {");
    expect(read('src/board/actions.ts')).toContain("return t.track !== 'express' && !t.specApproved;");
  });
});

describe('safety', () => {
  it('names every hidden place and package site in plain words', () => {
    expect(view.safety.hidden.filter((h) => PRIVATE.includes(h))).toEqual([]);
    expect(view.safety.sites.filter((s) => PACKAGE_HOSTS.includes(s) && s !== 'crates.io')).toEqual([]);
  });

  it('says what each agent may do as its steps really run', () => {
    const live = read('src/engine/live.ts');
    const runs = [...live.matchAll(/runAgent\(\{[\s\S]*?permissions: \[([^\]]*)\]/g)].map((m) => ({ role: /role: '(\w+)'/.exec(m[0])?.[1], perms: m[1]! })).filter((r) => r.role);
    expect(new Set(runs.map((r) => r.role))).toEqual(new Set(AGENTS.map((a) => a.role)));
    for (const a of AGENTS) {
      const can = new Map(view.agents[a.role].can);
      const given = runs.filter((r) => r.role === a.role).map((r) => r.perms).join(' ');
      expect(can.get('Change code'), a.role).toBe(given.includes("'edit'"));
      expect(can.get('Run commands'), a.role).toBe(given.includes("'edit'"));
      expect(given.includes("'run'"), a.role).toBe(false);
    }
  });

  it('an engineer\'s own files show by name', () => {
    const page = harnessView({ localFiles: [{ repo: '.', path: 'a/.env.dev' }], lockedFiles: [{ repo: '.', path: 'docker-compose.yml' }] } as never);
    expect(page.safety.local).toEqual(['a/.env.dev']);
    expect(page.safety.lockedByYou).toEqual(['docker-compose.yml']);
  });
});

describe('the words', () => {
  it('are plain, and name no AI tool', () => {
    const words = [...rows.flatMap((r) => [r.name, r.what, r.fail ?? '', r.then ?? '', ...Object.values(r.note ?? {})]), ...view.limits.flatMap((l) => [l.name, l.what]), ...view.stages.map((s) => s.about)].filter(Boolean);
    // Three words a project manager already meets on the board and in the design.
    expect(words.filter((w) => !isPlain(w.replace(/\.env|\bAPI\b|secrets\.yaml|console\.json/g, '')))).toEqual([]);
    // Only the details name what really runs on this computer, in the AI tool module's own words.
    expect(JSON.stringify(view, (k, v) => (k === 'd' ? undefined : v))).not.toMatch(/claude|codex|gemini|opus|sonnet/i);
  });
});

describe('the board', () => {
  it('answers with the project\'s own Quality and files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-harness-'));
    try {
      const bp = boardPaths(path.join(tmp, '.squad'));
      seedDemoBoard(bp, { speed: 1 });
      const app = new Hono();
      mountBoardApi(app, { paths: buildPaths(tmp) });
      const before = (await (await app.request('/api/v1/harness')).json()) as ReturnType<typeof harnessView>;
      expect(before.stages).toHaveLength(11);
      expect(before.caps.find((c) => c.key === 'builder')).toMatchObject(QUALITY_PRESETS.best.caps.builder!);
      const meta = (await (await app.request('/api/v1/board')).json()) as { meta: Parameters<typeof writeMeta>[1] };
      writeMeta(bp, { ...meta.meta, quality: 'thrifty', localFiles: [{ repo: '.', path: 'b/.env.test' }] });
      const after = (await (await app.request('/api/v1/harness')).json()) as ReturnType<typeof harnessView>;
      expect(after.quality).toBe('thrifty');
      expect(after.caps.find((c) => c.key === 'builder')).toMatchObject(QUALITY_PRESETS.thrifty.caps.builder!);
      expect(after.safety.local).toEqual(['b/.env.test']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the old page is gone and its links open the Agents tab; the allowed websites moved', () => {
    const router = read('console-ui/src/router.tsx');
    expect(router).toMatch(/path: '\/squad',\s+beforeLoad: \(\) => \{\s+throw redirect\(\{ to: '\/harness', search: \{ tab: 'agents' \} \}\);/);
    const shell = read('console-ui/src/components/Shell.tsx');
    expect(shell).toContain("{ to: '/harness', label: 'Harness'");
    expect(shell).not.toContain("'/squad'");
    expect(read('console-ui/src/pages/Pages.tsx')).not.toMatch(/AllowedHosts|SquadPage/);
    expect(read('console-ui/src/pages/Harness.tsx')).toContain('<AllowedHosts');
    const words = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? words(p) : /\.(ts|tsx|css)$/.test(e.name) && /Squad and AI|Squad page/.test(read(p)) ? [p] : [];
      });
    expect([...words('src'), ...words('console-ui/src')]).toEqual([]);
  });
});
