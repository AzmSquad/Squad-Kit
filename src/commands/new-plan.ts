import fs from 'node:fs';
import path from 'node:path';
import { confirm, select } from '@inquirer/prompts';
import * as ui from '../ui/index.js';
import { SquadExit } from '../core/cli-exit.js';
import { buildPaths, requireSquadRoot, type SquadPaths } from '../core/paths.js';
import { DEFAULT_PLANNER_MAX_OUTPUT_TOKENS, loadConfig, type SquadConfig } from '../core/config.js';
import { readFile } from '../utils/fs.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { findStoryByIntake, listStories, type StoryRecord } from '../core/stories.js';
import { runPlanner, type RunPlannerOutput } from '../planner/loop.js';
import type { PlannerLimitDecision, PlannerSessionLimitContext } from '../planner/session-limits.js';
import {
  printPlannerApiCostNotice,
  printPlannerLimitExplanation,
  printPlannerLimitNextSteps,
} from '../planner/planner-limit-messages.js';
import { resolveRuntime, extractAnthropicProviderSpecific } from '../planner/runtimes/index.js';
import type { AnthropicProviderSpecific } from '../planner/runtimes/types.js';
import { Budget } from '../planner/budget.js';
import { buildRepoMap } from '../core/repo-map.js';
import { composeSystemPrompt, composeUserPrompt, composeScoutSystemPrompt } from '../planner/system-prompt.js';
import { writePlanFile, buildMetadataHeader } from '../planner/writer.js';
import { buildCopyPlanPromptMarkdown } from '../core/copy-plan-prompt.js';
import { modelFor, readProviderKey, resolvePlannerAuthForCwd } from '../core/planner-models.js';
import { describeAuth, type ResolvedPlannerAuth } from '../core/planner-auth.js';
import { writeLastRun } from '../core/last-run.js';
import { appendRun, newRunId } from '../core/runs.js';
import { formatPlannerCacheLine } from '../ui/planner-cache-summary.js';
import { PlannerEventBus } from '../planner/events.js';
import { buildPlansIndex } from '../core/plans-index.js';
import { summariseIssuesByKind } from '../planner/validation.js';
import { dispatchNewPlanApiPlannerEvent, type NewPlanApiUiDispatchContext } from './new-plan-api-events.js';

export interface NewPlanOptions {
  /** Override `planner.runtime.anthropic` for this run (`agent-sdk` default). */
  anthropicRuntime?: 'agent-sdk' | 'vercel';
  /** Anthropic Agent SDK only: draft-stage effort (`minimal` → API `low`). */
  effort?: 'minimal' | 'medium' | 'high';
  /** Anthropic Agent SDK only: scout-stage effort. */
  scoutEffort?: 'minimal' | 'medium' | 'high';
  /** Anthropic Agent SDK only: disable extended thinking for this run. */
  noThinking?: boolean;
  /** Default true; `--no-clipboard` sets false (copy-paste mode only). */
  clipboard?: boolean;
  /** `--copy` — force copy-paste mode. */
  copy?: boolean;
  feature?: string;
  all?: boolean;
  yes?: boolean;
  api?: boolean;
  /** Disable cheap scout stage (single-stage draft only). */
  noScout?: boolean;
  /** Override scout model id. */
  scoutModel?: string;
  maxScoutFiles?: number;
  /** Disable post-plan validation pass. */
  noValidation?: boolean;
  /** Write `*.partial.md` when validation reports issues. */
  strictValidation?: boolean;
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

/** Header row: `subscription (Claude login)` or `api-key (ANTHROPIC_API_KEY)`. Never a credential. */
function formatAuthRow(auth: ResolvedPlannerAuth): string {
  if (auth.mode === 'subscription') return 'subscription (Claude login)';
  return `api-key (${describeAuth(auth).credentialHint})`;
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
  // Resolved once for the whole run: scout and draft must never disagree, and a token could
  // otherwise rotate between the two stages. `PlannerAuthUnavailableError` already names both
  // recovery paths, so let it propagate unwrapped.
  const auth = resolvePlannerAuthForCwd(planner.provider, planner);

  const modelId = modelFor(planner.provider, 'plan', planner.modelOverride);

  const anthropicRuntimeChoice =
    opts.anthropicRuntime ?? planner.runtime?.anthropic ?? 'agent-sdk';

  const draftRuntime = resolveRuntime({
    provider: planner.provider,
    modelId,
    auth,
    anthropicRuntime: planner.provider === 'anthropic' ? anthropicRuntimeChoice : undefined,
  });

  const thinkingCli = opts.noThinking ? ('off' as const) : undefined;
  const anthropicProviderSpecific: { scout?: AnthropicProviderSpecific; draft?: AnthropicProviderSpecific } | undefined =
    planner.provider === 'anthropic'
      ? {
          draft: extractAnthropicProviderSpecific(planner, 'draft', {
            effort: opts.effort,
            thinking: thinkingCli,
          }),
          scout: extractAnthropicProviderSpecific(planner, 'scout', {
            effort: opts.scoutEffort,
            thinking: thinkingCli,
          }),
        }
      : undefined;

  const budget = new Budget(planner.budget);

  ui.banner();
  ui.step(`planning   ${story.feature} / ${story.id}`);
  ui.kv('provider', planner.provider);
  ui.kv('model', modelId);
  ui.kv('auth', formatAuthRow(auth));
  ui.blank();

  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  if (interactive) {
    printPlannerApiCostNotice(auth.mode);
  }

  const mapSpinner = ui.spinner('building repo map…');
  const repoMap = buildRepoMap(paths.root, { format: 'tree' });
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

  const scoutEnabled = !opts.noScout && planner.stages?.scout?.enabled !== false;
  const validationEnabled = !opts.noValidation && planner.validation?.enabled !== false;
  const strictValidation = !!opts.strictValidation || planner.validation?.strict === true;
  const maxScoutFiles = opts.maxScoutFiles ?? planner.stages?.scout?.maxFiles ?? 12;

  let scoutModelId = '';
  let scoutRuntime: ReturnType<typeof resolveRuntime> | undefined;
  let scoutSystemPrompt: string | undefined;
  if (scoutEnabled) {
    scoutModelId = modelFor(
      planner.provider,
      'scout',
      planner.modelOverride,
      opts.scoutModel ?? planner.stages?.scout?.modelOverride,
    );
    scoutRuntime = resolveRuntime({
      provider: planner.provider,
      modelId: scoutModelId,
      auth,
      anthropicRuntime: planner.provider === 'anthropic' ? anthropicRuntimeChoice : undefined,
    });
    scoutSystemPrompt = composeScoutSystemPrompt({
      projectRoots: config.project.projectRoots ?? ['.'],
      primaryLanguage: config.project.primaryLanguage ?? '',
      trackerType: config.tracker.type,
      repoMap,
      plansIndex: buildPlansIndex(paths),
    });
  }

  const sessionSpinner: { current: ReturnType<typeof ui.spinner> | null } = { current: null };
  const startedAt = Date.now();
  const cacheEnabled = planner.cache?.enabled ?? true;
  const runId = newRunId();
  const bus = new PlannerEventBus();

  const apiUiCtx: NewPlanApiUiDispatchContext = {
    sessionSpinner,
    stageLine: { scout: 'pending', draft: 'pending', validation: 'pending' },
    activePlannerStage: null,
    thinkingBlockChars: 0,
    thinkingState: { running: false, blockStartedAt: 0, totalChars: 0, totalDurationMs: 0 },
    thinkingSpinner: { current: null },
    thinkingTick: { id: null },
    budget,
    budgetCaps: null,
    startedAt,
    interactive,
    stagesIntroPrinted: false,
    lastToolUi: null,
    streamedValidationIssues: { count: 0 },
    validationStreamCappedMsg: false,
    anthropicRuntimeChoice: planner.provider === 'anthropic' ? anthropicRuntimeChoice : undefined,
    usageAcc: { inputTokens: 0, outputTokens: 0 },
  };

  const unsubscribe = bus.subscribe((e) => {
    dispatchNewPlanApiPlannerEvent(apiUiCtx, e);
  });

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

  let result: RunPlannerOutput;
  try {
    result = await runPlanner({
      root: paths.root,
      runtime: draftRuntime,
      provider: planner.provider,
      modelId,
      auth,
      anthropicProviderSpecific,
      systemPrompt,
      userPrompt,
      budget,
      maxOutputTokens: planner.maxOutputTokens,
      cacheEnabled,
      decideOnLimit,
      events: bus,
      runId,
      paths,
      stages: {
        scout: {
          enabled: scoutEnabled,
          runtime: scoutRuntime,
          modelId: scoutModelId,
          maxFiles: maxScoutFiles,
          maxOutputTokens: planner.stages?.scout?.maxOutputTokens ?? 2048,
        },
      },
      validation: { enabled: validationEnabled, strict: strictValidation },
      toolsEnabled: planner.tools,
      scoutSystemPrompt,
    });
  } finally {
    await bus.finalizeEventPersistence?.();
    unsubscribe();
    if (apiUiCtx.thinkingTick.id) {
      clearInterval(apiUiCtx.thinkingTick.id);
      apiUiCtx.thinkingTick.id = null;
    }
    apiUiCtx.thinkingSpinner.current?.stop();
    sessionSpinner.current?.stop();
  }

  if (!result.planText.trim()) {
    throw new Error(
      'Planner returned no plan text. Run `squad doctor` to check provider and models, or `squad new-plan --copy` to avoid the API.',
    );
  }

  const snap = budget.snapshot();
  const elapsedMs = Date.now() - startedAt;
  const issueCount = result.validation?.issues.length ?? 0;
  const issuesByKind = summariseIssuesByKind(result.validation?.issues ?? []);
  const validationBlocks =
    strictValidation && validationEnabled && issueCount > 0;
  const success =
    result.finishedNormally &&
    !result.timedOut &&
    !result.userCancelled &&
    !validationBlocks;

  const header = buildMetadataHeader({
    provider: planner.provider,
    model: modelId,
    reads: snap.reads,
    bytes: snap.bytes,
    inputTokens: snap.usage.inputTokens,
    outputTokens: snap.usage.outputTokens,
    durationMs: elapsedMs,
    planStatus: success ? undefined : 'partial',
    scoutEnabled,
    validationEnabled,
    validationIssueCount: issueCount,
  });

  const { planFile, sequenceNumber, overwrote } = writePlanFile({
    paths,
    config,
    story,
    planBodyMarkdown: result.planText,
    metadataHeader: header,
    partial: !success,
  });

  const relPlan = path.relative(paths.root, planFile);

  try {
    await writeLastRun(paths, {
      stats: result.stats,
      completedAt: new Date().toISOString(),
      provider: planner.provider,
      model: modelId,
    });
    await appendRun(paths, {
      runId,
      provider: planner.provider,
      model: modelId,
      feature: story.feature,
      storyId: story.id,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      success,
      partial: !success,
      planFile: relPlan,
      stats: result.stats,
      cacheEnabled,
      durationMs: elapsedMs,
      scout: {
        enabled: scoutEnabled,
        selectedCount: result.scout?.selected.length,
        tokensUsed: result.scout?.tokensUsed,
        durationMs: result.scout?.durationMs,
      },
      validation: {
        enabled: validationEnabled,
        issuesCount: issueCount,
        issuesByKind,
        durationMs: result.validation?.durationMs,
      },
      plannerRuntime: { kind: draftRuntime.kind, provider: planner.provider },
      providerOptionsSnapshot: anthropicProviderSpecific
        ? { anthropic: anthropicProviderSpecific }
        : undefined,
    });
  } catch {
    // best-effort telemetry
  }

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');
  const budgetCapsForSummary = budget.caps();

  ui.blank();
  ui.summaryBox(success ? ' plan generated ' : ' plan saved (incomplete) ', [
    { key: 'file', value: relPlan },
    { key: 'nn', value: String(sequenceNumber).padStart(2, '0') },
    { key: 'model', value: `${planner.provider}/${modelId}` },
    {
      key: 'runtime',
      value: (() => {
        let chips = '';
        if (planner.provider === 'anthropic') {
          const d = anthropicProviderSpecific?.draft;
          if (d?.effort) chips += ` · effort ${d.effort}`;
          if (d?.thinking && d.thinking !== 'off') chips += ` · thinking ${d.thinking}`;
        }
        const rollup =
          apiUiCtx.thinkingState.totalChars > 0
            ? ` · Σ ${apiUiCtx.thinkingState.totalChars} thinking chars`
            : '';
        return `${draftRuntime.kind} · ${planner.provider}${chips}${rollup}`;
      })(),
    },
    { key: 'events', value: `.squad/runs/${runId}.events.jsonl` },
    {
      key: 'scout',
      value: scoutEnabled
        ? `${result.scout?.selected.length ?? 0} files · ${result.scout?.tokensUsed ?? 0} tok`
        : 'disabled',
    },
    {
      key: 'validation',
      value: validationEnabled ? `${issueCount} issue(s)` : 'disabled',
    },
    {
      key: 'reads',
      value: stripAnsi(
        ui.formatBudgetMeter({
          reads: snap.reads,
          readsCap: budgetCapsForSummary.maxFileReads,
          bytes: snap.bytes,
          bytesCap: budgetCapsForSummary.maxContextBytes,
          elapsedMs,
          durationMsCap: budgetCapsForSummary.maxDurationSeconds * 1000,
        }),
      ),
    },
    {
      key: 'tokens',
      value:
        `${snap.usage.inputTokens} in · ${snap.usage.outputTokens} out` +
        (draftRuntime.kind === 'agent-sdk' ? ' (agent-sdk: aggregate-only)' : ''),
    },
    {
      key: 'cache',
      value: formatPlannerCacheLine({
        cacheEnabled,
        stats: result.stats,
        plannerRuntimeKind: draftRuntime.kind,
      }),
    },
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
        : validationBlocks
          ? 'partial plan (validation issues — review or use --no-validation)'
          : 'partial plan (review limits)',
    },
  ]);

  if (issueCount > 0 && validationEnabled) {
    ui.blank();
    const streamed = interactive && apiUiCtx.streamedValidationIssues.count > 0;
    if (!streamed) {
      ui.warning(`Validation reported ${issueCount} issue(s) (heuristic; first 10 shown):`);
      for (const iss of result.validation!.issues.slice(0, 10)) {
        ui.info(
          `  [${iss.severity}] ${iss.kind}${iss.path ? ` ${iss.path}` : ''} — ${iss.detail}`,
        );
      }
      if (issueCount > 10) {
        ui.info(`  (+${issueCount - 10} more — see metadata header issues=…)`);
      }
    } else {
      ui.warning(`Validation reported ${issueCount} issue(s) (details were streamed during the run).`);
    }
    if (issueCount > 50) {
      ui.warning('Large issue count may mean the validator is misfiring; try `squad new-plan --no-validation` to compare.');
    }
  }

  if (!success) {
    if (!validationBlocks || !result.finishedNormally) {
      printPlannerRunIncompleteSummary(result, relPlan);
    } else {
      ui.blank();
      ui.warning('Plan saved as partial because strict validation reported issues.');
    }
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
  const composed = buildCopyPlanPromptMarkdown(config, intakeContent);

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
