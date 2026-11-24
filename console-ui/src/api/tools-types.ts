/** The Tools page, "What this project needs" (src/engine/tools/index.ts). */
export type ToolAction = 'build' | 'checks' | 'pictures' | 'start-app' | 'try-it' | 'pull-request';
export type ToolState = 'ready' | 'missing' | 'too-old' | 'getting' | 'updating' | 'not-here';

export interface ToolGetting {
  tool: string;
  name: string;
  version?: string;
  startedAt: string;
  /** squad-kit's own download and unpack, its install after (Android), or an update of your own copy. */
  step: 'download' | 'unpack' | 'install' | 'update';
  /** A download: bytes so far and in all. An update: seconds so far and the time it usually takes. */
  done: number;
  total?: number;
  secondsLeft: number;
  /** An update: the step it is at, in plain words. */
  words?: string;
  /** An update past the time it usually takes: still working, with no time left to guess. */
  longer?: true;
}

export interface ToolLine {
  id: string;
  name: string;
  gives: string;
  priority: 'required' | 'recommended' | 'optional';
  state: ToolState;
  version?: string;
  needs?: string;
  why?: string;
  note?: string;
  notHere?: string;
  installer: 'squad-kit' | 'you';
  reason?: string;
  steps: string[];
  link: string;
  usedFor: string;
  actions: ToolAction[];
  blocks: ToolAction[];
  getting?: ToolGetting;
  trouble?: string;
  command: string;
  /** Too old, and squad-kit can update your copy safely: the warning to OK first, the usual time, and the command. */
  update?: { warning: string; seconds: number; command: string };
  /** Too old, and squad-kit can't update your copy: why, in one line. */
  cantUpdate?: string;
  /** Ready, and older than its makers recommend: the version they recommend. It stops nothing; the steps say how to update. */
  recommended?: string;
  /** Its maker's license comes first: whether you accepted it, and the command that shows it and asks. */
  license?: { accepted: boolean; command: string };
  /** squad-kit gets it: how much room it takes ("about 20 GB") and about how long the first time takes, in seconds. */
  size?: string;
  seconds?: number;
  /** Android: the steps that make the person's own Android Studio enough instead, while it is here and lacks something. */
  studioSteps?: string[];
  /** Android: the project's checks build the Android app, and the person may skip those builds here instead. */
  skip?: { command: string };
  /** Android: the person skipped those checks on this computer, who and when, and the command that turns them back on. */
  skipped?: { by: string; at: string; command: string };
}

/** A tool's license in full, from its maker, for you to read before Accept. */
export interface LicenseView {
  tool: string;
  name: string;
  licenses: { id: string; text: string }[];
  accepted: boolean;
}

export interface ToolsView {
  system: 'mac' | 'windows' | 'linux';
  checkedAt: string | null;
  checking: boolean;
  summary: string;
  places: { place: string; part?: string; kinds: string[]; platforms: string[] }[];
  lines: ToolLine[];
  getting: ToolGetting | null;
}

/** A step a Required tool stops: what can't happen, why, and the link to its line. */
export interface ToolBlock {
  action: ToolAction;
  tools: { id: string; name: string; state: ToolState; version?: string; needs?: string }[];
  text: string;
  status: string;
  link: string;
  checking?: true;
  /** Another way on: skip what waits for the tool (the checks that build the Android app), with what that means. */
  skip?: { label: string; note: string; command: string };
  /** The steps that bring what is missing, when they are the person's: an SDK of theirs that lacks a piece. */
  steps?: string[];
}
