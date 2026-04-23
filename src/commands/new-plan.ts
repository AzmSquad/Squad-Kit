import fs from 'node:fs';
import path from 'node:path';
import { confirm, select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { buildPaths, requireSquadRoot, type SquadPaths } from '../core/paths.js';
import { loadConfig, type SquadConfig } from '../core/config.js';
import { readBundledPrompt, readFile } from '../utils/fs.js';
import { render } from '../core/template.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { findStoryByIntake, listStories, type StoryRecord } from '../core/stories.js';
import { runPlanner } from '../planner/loop.js';
import { providerFor } from '../planner/providers/index.js';
import { Budget } from '../planner/budget.js';
import { buildRepoMap } from '../core/repo-map.js';
import { composeSystemPrompt, composeUserPrompt } from '../planner/system-prompt.js';
import { writePlanFile, buildMetadataHeader } from '../planner/writer.js';
import { modelFor, providerEnvVar, readProviderKey } from '../core/planner-models.js';

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

async function emitViaApi(
  story: StoryRecord,
  paths: SquadPaths,
  config: SquadConfig,
  _opts: NewPlanOptions,
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

  const result = await runPlanner({
    root: paths.root,
    provider,
    model,
    apiKey,
    systemPrompt,
    userPrompt,
    budget,
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
  });
  sessionSpinner.current?.stop();

  if (!result.planText.trim()) {
    throw new Error(
      'Planner returned no plan text. Run `squad doctor` to check provider and models, or `squad new-plan --copy` to avoid the API.',
    );
  }

  const snap = budget.snapshot();
  const elapsedMs = Date.now() - startedAt;

  const header = buildMetadataHeader({
    provider: planner.provider,
    model,
    reads: snap.reads,
    bytes: snap.bytes,
    inputTokens: snap.usage.inputTokens,
    outputTokens: snap.usage.outputTokens,
    durationMs: elapsedMs,
    costUsd: snap.usage.costUsd,
  });

  const { planFile, sequenceNumber, overwrote } = writePlanFile({
    paths,
    config,
    story,
    planBodyMarkdown: result.planText,
    metadataHeader: header,
  });

  ui.blank();
  ui.summaryBox(' plan generated ', [
    { key: 'file', value: path.relative(paths.root, planFile) },
    { key: 'nn', value: String(sequenceNumber).padStart(2, '0') },
    { key: 'model', value: `${planner.provider}/${model}` },
    { key: 'reads', value: `${snap.reads} files · ${(snap.bytes / 1024).toFixed(1)} KB` },
    {
      key: 'tokens',
      value: `${snap.usage.inputTokens} in · ${snap.usage.outputTokens} out${snap.usage.costUsd !== undefined ? `  ≈ $${snap.usage.costUsd.toFixed(2)}` : ''}`,
    },
    { key: 'time', value: `${Math.round(elapsedMs / 1000)}s` },
    { key: 'action', value: overwrote ? 'overwrote existing plan' : 'new plan' },
  ]);

  if (result.budgetExhausted) ui.warning('Budget exhausted mid-plan. Review and, if needed, re-run with a larger budget.');
  if (result.timedOut) ui.warning('Planner timed out; plan may be incomplete.');
  if (!result.finishedNormally && !result.budgetExhausted && !result.timedOut) {
    ui.warning('Planner did not reach end_turn. Inspect the plan carefully.');
  }

  ui.blank();
  ui.info(`next  →  open a new agent chat and attach only ${path.basename(planFile)}`);
}

async function emitCopyPrompt(
  story: StoryRecord,
  _paths: SquadPaths,
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

  printModelBanner(config);

  process.stdout.write(composed);
  if (!composed.endsWith('\n')) process.stdout.write('\n');

  if (clipboard) {
    const ok = await copyToClipboard(composed);
    if (ok) ui.info('copied to clipboard');
  }
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
