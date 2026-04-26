export interface ApiStory {
  feature: string;
  id: string;
  intakePath: string;
  storyDir: string;
  planFile: string | null;
  titleHint: string | null;
}

export interface ApiStoryDetail extends ApiStory {
  intakeContent: string;
}

/** Composed copy-paste plan meta-prompt (same bytes as `squad new-plan --copy`). */
export interface ApiCopyPlanPrompt {
  prompt: string;
  feature: string;
  storyId: string;
  bytes: number;
  estTokensApprox: number;
}

export interface ApiPlan {
  feature: string;
  planFile: string;
  metadata: { provider?: string; model?: string; generatedBy?: string };
}

export interface ApiPlanDetail extends ApiPlan {
  content: string;
  absPath: string;
}

export interface ApiCreatedStory {
  storyDir: string;
  intakePath: string;
  feature: string;
  id: string;
}

export type PlanDiffChange = {
  value: string;
  added?: boolean;
  removed?: boolean;
};

export interface ApiPlanDiff {
  feature: string;
  a: string;
  b: string;
  changes: PlanDiffChange[];
}

export interface ApiMeta {
  version: string;
  root: string;
  project: { name: string; primaryLanguage?: string; projectRoots?: string[] };
  planner: { provider: string; enabled: boolean } | null;
  tracker: { type: string };
  /** Omitted when no `.last-run.json` exists. */
  lastRun?: ApiLastRun | null;
}

export interface ApiDashboardRun {
  runId: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  partial: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheHitRatio: number;
}

export interface ApiDashboard {
  version: string;
  root: string;
  project: ApiMeta['project'];
  planner: ApiMeta['planner'];
  tracker: ApiMeta['tracker'];
  lastRun: ApiLastRun | null;
  runs: ApiDashboardRun[];
  storyCounts: { total: number; planned: number; unplanned: number };
  stories: ApiStory[];
}

export interface ApiRecentProject {
  root: string;
  lastOpenedAt: string;
}

export interface ApiActiveRun {
  runId: string;
  feature: string;
  storyId: string;
  startedAt: number;
}

/** Subset of squad config exposed to the console UI. */
export interface ApiConfig {
  planner?: { enabled: boolean; provider?: string };
  project?: { name: string; primaryLanguage?: string };
  tracker?: { type: string };
  version?: number;
}

export interface ApiLastRun {
  stats: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cacheHitRatio: number;
    durationMs: number;
  };
  completedAt: string;
  provider: string;
  model: string;
  version: 1;
}
