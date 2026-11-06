import type { ChatMessage, Quality } from './types';

// The first run and the Overview. Mirrors src/board/setup-state.ts, src/board/overview.ts and src/board/first-run.ts.

export type FolderKind = 'project' | 'repo' | 'repos' | 'empty' | 'files' | 'older';

/** What Add project found in a folder, and what adding it does. */
export interface FirstLook {
  kind: FolderKind;
  title: string;
  found: string;
  next: string;
  safe: string;
  takes: string;
  files: number;
  language?: string;
  web: boolean;
  tests: boolean;
  branch?: string;
  unsaved: number;
  repos: string[];
}

export type SetupStepId = 'files' | 'tool' | 'read' | 'commands' | 'tests' | 'app' | 'overview';
export type SetupStepState = 'todo' | 'now' | 'done' | 'failed' | 'skipped' | 'stopped';

export type SetupWay = { do: 'again'; step: SetupStepId; label: string; command: string } | { do: 'output'; label: string } | { do: 'settings'; label: string };

export interface SetupStepView {
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  note?: string;
  error?: string;
  output?: string;
  since?: string;
  seconds?: number;
  usual: string;
  ways: SetupWay[];
}

export interface SetupView {
  project: string;
  engine: 'demo' | 'live';
  kind: FolderKind;
  startedAt: string;
  steps: SetupStepView[];
  done: number;
  total: number;
  current?: SetupStepId;
  ready: boolean;
  approved: boolean;
  stopping: boolean;
  reads: string[];
  quality: Quality;
  qualityAsked: boolean;
  tool: string;
  empty: boolean;
  /** On a project with no code: the person already said what they want to build, so nothing is asked. */
  idea: boolean;
  /** New project with a BRD, until its first release: the BRD the Analyst has. */
  brd?: { id: string; title: string };
}

export interface SetupTestRun {
  ok: boolean;
  command: string;
  repo?: string;
  passed?: number;
  seconds?: number;
  output?: string;
}

export interface SetupProof {
  files?: number;
  read?: number;
  branch?: string;
  unsaved?: number;
  tests?: SetupTestRun[];
  app?: { ok: boolean; url?: string; command?: string; repo?: string; shot?: string; error?: string };
}

export type PartKind = 'people' | 'screens' | 'server' | 'logic' | 'data' | 'tests' | 'outside';

export interface CodePart {
  id: string;
  name: string;
  what: string;
  files: string[];
  kind?: PartKind;
}

export interface PartLink {
  from: string;
  to: string;
  label?: string;
}

export interface TicketIdea {
  title: string;
  why: string;
  ticket?: string;
}

export interface OverviewTalk {
  open: boolean;
  thinking: boolean;
  messages: ChatMessage[];
  stopping?: boolean;
  reread?: boolean;
  idea?: string;
}

export interface OverviewRule {
  id: string;
  title: string;
  chosen: string;
  why: string;
  proposed: boolean;
  fromScan: boolean;
}

export interface OverviewView {
  project: string;
  engine: 'demo' | 'live';
  user: string;
  summary?: string;
  readAt?: string;
  refreshedAt?: string;
  users?: string;
  can: string[];
  worth: string[];
  ideas: TicketIdea[];
  parts: CodePart[];
  links: PartLink[];
  /** The product's parts in one sentence, when it has several. */
  product?: string;
  map: { area: string; detail: string }[];
  rules: OverviewRule[];
  proposed: number;
  proof?: SetupProof;
  handover: 'reading' | 'ready' | 'approved' | 'none';
  approved?: { by: string; at: string };
  since: { id: string; title: string; at: string }[];
  setup?: { done: number; total: number; line: string };
  /** New project with a BRD, until its first release: there is nothing to check here yet, and the work starts there. */
  brd?: { id: string; title: string };
  talk?: OverviewTalk;
  empty: boolean;
  /** On a project with no code: what the person said they want to build. */
  idea?: string;
  old: boolean;
  command: string;
}
