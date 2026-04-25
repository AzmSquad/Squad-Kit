import fs from 'node:fs';
import path from 'node:path';
import { confirm, select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { SquadExit } from '../core/cli-exit.js';
import { buildPaths, requireSquadRoot, type SquadPaths } from '../core/paths.js';
import { DEFAULT_PLANNER_MAX_OUTPUT_TOKENS, loadConfig, type SquadConfig } from '../core/config.js';
import { readBundledPrompt, readFile } from '../utils/fs.js';
import { render } from '../core/template.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { findStoryByIntake, listStories, type StoryRecord } from '../core/stories.js';
import { runPlanner, type RunPlannerOutput } from '../planner/loop.js';
import type { PlannerLimitDecision, PlannerSessionLimitContext } from '../planner/session-limits.js';
import {
  printPlannerApiCostNotice,
  printPlannerLimitExplanation,
  printPlannerLimitNextSteps,
} from '../planner/planner-limit-messages.js';
import { providerFor } from '../planner/providers/index.js';
import { Budget } from '../planner/budget.js';
import { buildRepoMap } from '../core/repo-map.js';
import { composeSystemPrompt, composeUserPrompt } from '../planner/system-prompt.js';
import { writePlanFile, buildMetadataHeader } from '../planner/writer.js';
import { modelFor, providerEnvVar, readProviderKey } from '../core/planner-models.js';
import { writeLastRun } from '../core/last-run.js';
import { formatPlannerCacheLine } from '../ui/planner-cache-summary.js';

export interface NewPlanOptions {
  /** Default true; `--no-clipboard` sets false (copy-paste mode only). */
  clipboard?: boolean;
  /** `--copy` — force copy-paste mode. */
  copy?: boolean;
  feature?: string;
  all?: boolean;
  yes?: boolean;
  api?: boolean;
}

function decideMode(opts: NewPlanOptions, config: SquadConfig): 'api' | 'copy' {
  if (opts.api && opts.copy) {
    throw new Error('Pass either --api or --copy, not both. Run `squad new-plan --help` for valid flags.');
  }
  if (opts.api) return 'api';
  if (opts.copy) return 'copy';
  const enabled = config.planner?.enabled;
  const key = enabled && config.planner?.provider ? readProviderKey(config.planner.provider) : undefined;
  return enabled && key ? 'api' : 'copy';
}

export async function runNewPlan(intakePath: string | undefined, opts: NewPlanOptions): Promise<void> {
  const root = requireSquadRoot();
  const paths = buildPaths(root);
  const config = loadConfig(paths.configFile);

  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  const stories = listStories(paths, { feature: opts.feature });

  const story = intakePath
    ? resolveFromPath(intakePath, stories, root)
    : await pickStory(stories, { all: !!opts.all, interactive, feature: opts.feature });

  if (!story) return;

  if (story.planFile) {
    const proceed = await confirmOverwrite(story, interactive, !!opts.yes);
    if (!proceed) return;
  }

  const mode = decideMode(opts, config);

  if (mode === 'api') {
    await emitViaApi(story, paths, config, opts);
  } else {
    await emitCopyPrompt(story, paths, config, opts.clipboard !== false);
  }
}

function resolveFromPath(intakePath: string, stories: StoryRecord[], root: string): StoryRecord {
  const resolved = path.resolve(intakePath.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Intake not found: ${resolved}. Run \`squad list\` to see intakes, or \`squad new-story\` to create one first.`,
    );
  }
  const hit = findStoryByIntake(stories, resolved);
  if (hit) return hit;
  throw new Error(
    `Intake at ${resolved} is not under ${relativeStoriesDir(root)}. ` +
      `Run \`squad new-story\` to create a story, then pass a path like \`squad new-plan .squad/stories/<feature>/<id>/intake.md\`.`,
  );
}

function relativeStoriesDir(root: string): string {
  return path.relative(root, path.join(root, '.squad', 'stories'));
}

async function pickStory(
  stories: StoryRecord[],
  opts: { all: boolean; interactive: boolean; feature?: string },
): Promise<StoryRecord | undefined> {
  const candidates = opts.all ? stories : stories.filter((s) => !s.planFile);

  if (candidates.length === 0) {
    if (stories.length === 0) {
      ui.info('No intakes to plan. Run `squad new-story` to create one first.');
      return undefined;
    }
    const filterNote = opts.feature ? ` in feature "${opts.feature}"` : '';
    ui.info(`All ${stories.length} intakes${filterNote} already have plans.`);
    ui.blank();
    ui.info('Options:');
    ui.info('  squad new-plan --all             pick any intake (replaces existing plan)');
    ui.info('  squad new-plan <intake-path>     regenerate a specific plan');
    ui.info('  squad new-story <feature>        start a new story');
    return undefined;
  }

  if (!opts.interactive) {
    throw new Error(
      'No intake path provided and not running interactively. Run `squad new-plan` with a path to intake.md, or `squad new-plan` in a TTY to pick, or add `--yes` with an explicit path in CI.',
    );
  }

  const pick = await select({
    message: 'Pick a story to plan:',
    pageSize: Math.min(10, candidates.length),
    choices: candidates.map((s) => ({
      name: formatLabel(s),
      value: s.intakePath,
    })),
  });

  return candidates.find((s) => path.resolve(s.intakePath) === path.resolve(pick));
}

function formatLabel(s: StoryRecord): string {
  const head = `${s.feature} / ${s.id}`;
  const tail = s.titleHint ? `  ${ui.theme.dim(`— "${s.titleHint}"`)}` : '';
  const plannedTag = s.planFile ? `  ${ui.theme.warn('(planned)')}` : '';
  return head + tail + plannedTag;
}

async function confirmOverwrite(story: StoryRecord, interactive: boolean, yes: boolean): Promise<boolean> {
  ui.warning(`A plan already exists for this intake:`);
  ui.kv('plan', `.squad/plans/${story.feature}/${story.planFile}`);
  ui.info('Regenerating will replace it when your planner writes the new version.');
  if (yes) return true;
  if (!interactive) {
    throw new Error(
      `Plan already exists (.squad/plans/${story.feature}/${story.planFile}). ` +
        `Run \`squad new-plan\` with \`--yes\` to overwrite non-interactively, or in a TTY to confirm in the prompt.`,
    );
  }
  const go = await confirm({ message: 'Proceed and regenerate?', default: false });
  return go;
}

function printPlannerRunIncompleteSummary(result: RunPlannerOutput, relPlanFile: string): void {
  ui.blank();
  ui.warning('Planning stopped before the model reported a clean completion.');
  ui.kv('saved', relPlanFile, 8);
  if (result.userCancelled) ui.kv('stopped', 'you chose not to continue after a limit', 8);
  if (result.timedOut) ui.kv('timed out', 'yes', 8);
  if (result.budgetExhausted) ui.kv('read budget', 'exhausted (model was asked to finalise)', 8);
  if (result.incompleteKind) ui.kv('detail', result.incompleteKind, 8);
  ui.blank();
  ui.info('The file uses the `.partial.md` suffix and YAML `squad-kit-plan-status: partial`.');
  ui.info('Raise limits in `.squad/config.yaml` (`planner.budget`, `planner.maxOutputTokens`) or re-run when ready.');
}

async function emitViaApi(
  story: StoryRecord,
  paths: SquadPaths,
  config: SquadConfig,
  opts: NewPlanOptions,
): Promise<void> {
  const planner = config.planner;
  if (!planner?.enabled) {
    throw new Error(
      'Direct planner API is not configured. Run `squad init --force` to enable it, or `squad new-plan --copy` for the manual copy-paste flow.',
    );
  }
  const apiKey = readProviderKey(planner.provider);
  if (!apiKey) {
    throw new Error(
      `Missing ${providerEnvVar(planner.provider)}. Run \`squad config set planner\` to save a key to secrets, or export the env var, or run \`squad new-plan --copy\` without the API.`,
    );
  }

  const model = modelFor(planner.provider, 'plan', planner.modelOverride);
  const provider = providerFor(planner.provider);
  const budget = new Budget(planner.budget);

  ui.banner();
  ui.step(`planning   ${story.feature} / ${story.id}`);
  ui.kv('provider', planner.provider);
  ui.kv('model', model);
  ui.kv(
    'budget',
    `${planner.budget.maxFileReads} reads · ${(planner.budget.maxContextBytes / 1024).toFixed(0)} KB · ${planner.budget.maxDurationSeconds}s`,
  );
  ui.blank();

  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  if (interactive) {
    printPlannerApiCostNotice();
  }

  const mapSpinner = ui.spinner('building repo map…');
  const repoMap = buildRepoMap(paths.root);
  mapSpinner.succeed(
    `repo map ready  (${repoMap.split('\n').length - 1} paths · ${(repoMap.length / 1024).toFixed(1)} KB)`,
  );

  ui.divider('planner session');

  const systemPrompt = composeSystemPrompt({
    projectRoots: config.project.projectRoots ?? ['.'],
    primaryLanguage: config.project.primaryLanguage ?? '',
    trackerType: config.tracker.type,
    repoMap,
  });
  const userPrompt = composeUserPrompt({ intakeContent: readFile(story.intakePath) });

  const sessionSpinner: { current: ReturnType<typeof ui.spinner> | null } = { current: null };
  const startedAt = Date.now();
  const cacheEnabled = planner.cache?.enabled ?? true;

  const decideOnLimit = interactive
    ? async (ctx: PlannerSessionLimitContext): Promise<PlannerLimitDecision> => {
        printPlannerLimitExplanation(ctx);
        const ans = await select({
          message: 'Continue this planning session? (Continuing sends more API requests and is billed.)',
          choices: [
            { name: 'Continue — extend limits for this run', value: 'continue' as const },
            { name: 'Stop — save partial plan and exit', value: 'cancel' as const },
          ],
        });
        if (ans === 'cancel') printPlannerLimitNextSteps();
        return ans;
      }
    : undefined;

  const result = await runPlanner({
    root: paths.root,
    provider,
    model,
    apiKey,
    systemPrompt,
    userPrompt,
    budget,
    maxOutputTokens: planner.maxOutputTokens,
    cacheEnabled,
    decideOnLimit,
    onToolCall: (tc, bytes, total) => {
      const p = (tc.input as { path?: string }).path ?? '<unknown>';
      sessionSpinner.current?.succeed(
        `read ${p}  (${(bytes / 1024).toFixed(1)} KB · ${(total / 1024).toFixed(1)} KB / ${(planner.budget.maxContextBytes / 1024).toFixed(0)} KB)`,
      );
      sessionSpinner.current = ui.spinner(`reading next file…`);
    },
    onAssistantText: () => {
      sessionSpinner.current?.succeed('planner thinking complete (this chunk)');
      sessionSpinner.current = ui.spinner('thinking…');
    },
    onRateLimit: (waitSec) => {
      sessionSpinner.current?.stop();
      ui.warning(`${planner.provider} rate limit hit — retrying in ${waitSec}s`);
      sessionSpinner.current = ui.spinner('waiting for rate limit to reset…');
    },
  });
  sessionSpinner.current?.stop();

  if (!result.planText.trim()) {
    throw new Error(
      'Planner returned no plan text. Run `squad doctor` to check provider and models, or `squad new-plan --copy` to avoid the API.',
    );
  }

  const snap = budget.snapshot();
  const elapsedMs = Date.now() - startedAt;
  const success = result.finishedNormally && !result.timedOut && !result.userCancelled;

  const header = buildMetadataHeader({
    provider: planner.provider,
    model,
    reads: snap.reads,
    bytes: snap.bytes,
    inputTokens: snap.usage.inputTokens,
    outputTokens: snap.usage.outputTokens,
    durationMs: elapsedMs,
    costUsd: snap.usage.costUsd,
    planStatus: success ? undefined : 'partial',
  });

  const { planFile, sequenceNumber, overwrote } = writePlanFile({
    paths,
    config,
    story,
    planBodyMarkdown: result.planText,
    metadataHeader: header,
    partial: !success,
  });

  try {
    await writeLastRun(paths, {
      stats: result.stats,
      completedAt: new Date().toISOString(),
      provider: planner.provider,
      model,
    });
  } catch {
    // best-effort telemetry
  }

  const relPlan = path.relative(paths.root, planFile);
  ui.blank();
  ui.summaryBox(success ? ' plan generated ' : ' plan saved (incomplete) ', [
    { key: 'file', value: relPlan },
    { key: 'nn', value: String(sequenceNumber).padStart(2, '0') },
    { key: 'model', value: `${planner.provider}/${model}` },
    { key: 'reads', value: `${snap.reads} files · ${(snap.bytes / 1024).toFixed(1)} KB` },
    {
      key: 'tokens',
      value: `${snap.usage.inputTokens} in · ${snap.usage.outputTokens} out${snap.usage.costUsd !== undefined ? `  ≈ $${snap.usage.costUsd.toFixed(2)}` : ''}`,
    },
    { key: 'cache', value: formatPlannerCacheLine({ cacheEnabled, stats: result.stats }) },
    {
      key: 'max out',
      value: `${planner.maxOutputTokens ?? DEFAULT_PLANNER_MAX_OUTPUT_TOKENS} tok/req`,
    },
    { key: 'time', value: `${Math.round(elapsedMs / 1000)}s` },
    {
      key: 'action',
      value: success
        ? overwrote
          ? 'overwrote existing plan'
          : 'new plan'
        : 'partial plan (review limits)',
    },
  ]);

  if (!success) {
    printPlannerRunIncompleteSummary(result, relPlan);
    throw new SquadExit(2);
  }

  if (result.budgetExhausted) {
    ui.info('Note: file-read budget was reached; the model finalised without further reads.');
  }

  ui.blank();
  ui.info(`next  →  open a new agent chat and attach only ${path.basename(planFile)}`);
}

async function emitCopyPrompt(
  story: StoryRecord,
  paths: SquadPaths,
  config: SquadConfig,
  clipboard: boolean,
): Promise<void> {
  const intakeContent = readFile(story.intakePath);
  const metaPromptTemplate = readBundledPrompt('generate-plan.md');

  const composed = render(metaPromptTemplate, {
    projectRoots: (config.project.projectRoots ?? ['.']).join(', '),
    primaryLanguage: config.project.primaryLanguage ?? '',
    trackerType: config.tracker.type,
    intakeContent,
  });

  const promptFile = path.join(paths.squadDir, '.last-copy-prompt.md');
  fs.writeFileSync(promptFile, composed, 'utf8');
  const relPromptFile = path.relative(paths.root, promptFile);

  const bytes = Buffer.byteLength(composed, 'utf8');
  const estTokens = Math.round(bytes / 4);
  const clipResult = clipboard
    ? await copyToClipboard(composed)
    : { ok: false as const, reason: 'clipboard disabled (--no-clipboard)' };

  ui.blank();
  ui.divider('planner prompt ready');
  ui.kv('mode', 'copy-paste', 10);
  ui.kv('story', `${story.feature} / ${story.id}`, 10);
  ui.kv('prompt', relPromptFile, 10);
  ui.kv('size', `${formatKB(bytes)} · ~${formatCount(estTokens)} tokens (est)`, 10);
  if (clipResult.ok) {
    ui.kv('clipboard', `✓ copied via ${clipResult.tool}`, 10);
  } else {
    ui.kv('clipboard', `! ${clipResult.reason}`, 10);
  }

  printModelBanner(config);

  ui.blank();
  ui.step('Next:');
  ui.info('1) Open your agent chat (Cursor / Claude Code / Copilot / Gemini).');
  ui.info('2) Switch to a strong plan model (Opus 4.x / GPT-5.3 Codex thinking / Gemini deep-think).');
  if (clipResult.ok) {
    ui.info('3) Paste from clipboard and let the agent work. It will read files and write the plan itself.');
  } else {
    ui.info(`3) Open ${relPromptFile}, paste its contents into the agent chat, and let it work.`);
  }
  ui.info(
    `4) The agent writes the plan to .squad/plans/${story.feature}/<nn>-story-${story.id}.md. Review it, then open a fresh chat to implement (attach only the plan file).`,
  );
}

function formatKB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function printModelBanner(config: SquadConfig): void {
  if (!ui.isInteractive()) return;
  ui.blank();
  ui.divider('paste into your agent');
  ui.info('Recommendation: switch to a strong planning model before pasting.');
  const agents = config.agents ?? [];
  const hint = (name: string, msg: string) => {
    if (agents.includes(name)) ui.kv(name, msg, 14);
  };
  hint('cursor', 'model picker → Claude Opus 4.x or GPT-5.3 Codex (thinking)');
  hint('claude-code', '/model claude-opus-4-x');
  hint('copilot', 'chat model picker → the strongest available reasoning model');
  hint('gemini', '/model gemini-deep-think (or the latest strongest)');
  if (agents.length === 0) {
    ui.info('  (any agent) pick the strongest planning model you have access to.');
  }
  ui.divider();
  ui.blank();
}
