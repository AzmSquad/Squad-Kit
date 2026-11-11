import type { Platform, ProjectKind } from './kinds.js';

/**
 * Every tool line of the Tools page, as data: what it gives, which projects need it and how much, what it is used for,
 * the oldest version that works, and who installs it, with the steps and the official page. This is the one place
 * that names the outside tools a project needs (rule 6): the rest of squad-kit asks here by id.
 */

/** What squad-kit does that a tool can be needed for. Phase A stops `build` and `checks` only. */
export type ToolAction = 'build' | 'checks' | 'pictures' | 'start-app' | 'try-it';
export type Priority = 'required' | 'recommended' | 'optional';
export type System = 'mac' | 'windows' | 'linux';
export type ToolId = 'git' | 'ai-tool' | 'flutter' | 'xcode' | 'simulator' | 'cocoapods' | 'maestro' | 'java' | 'android-studio' | 'docker';
/** Another tool that looks after a copy you installed, and updates it itself. */
export type ManagedBy = 'homebrew' | 'fvm' | 'snap';

export interface ToolNeed {
  /** The kinds of project part that need it; 'any' is every project. */
  kinds: ProjectKind[] | 'any';
  /** Only for a part that builds for this phone. */
  platform?: Platform;
  priority: Priority;
  /** The actions that use it. A Required tool that is missing or too old stops these, and only these. */
  for: ToolAction[];
}

export interface ToolEntry {
  id: ToolId;
  name: string;
  /** What it gives, in plain words: "the real iPhone, for pictures and Try it yourself". */
  gives: string;
  needs: ToolNeed[];
  /** The oldest version that works, for everything it is used for. */
  min?: string;
  /**
   * The version its makers recommend, newer than the oldest that works. An older one stays Ready and stops nothing: its
   * line says an update is recommended, with the update steps.
   */
  recommended?: string;
  /** The systems it can run on at all. Missing: every system. */
  systems?: System[];
  /** Why it is not on this computer when the system can't have it: "needs a Mac". */
  notHere?: string;
  installer: 'squad-kit' | 'you';
  /** You install it: why squad-kit can't, in one line. */
  why?: string;
  /** You install it: short numbered steps, per system. `all` is used when the system has none of its own. */
  steps?: Partial<Record<System | 'all', string[]>>;
  link: string;
  /** squad-kit gets it: how long it usually takes the first time, in seconds, until squad-kit measured it here. */
  getSeconds?: number;
  /** squad-kit gets these with it, when they are missing. */
  with?: ToolId[];
  /** A line to read before the steps: "Android pictures and Start come in the next update". */
  note?: string;
  /**
   * You installed it, and squad-kit can update your copy when that is safe, after you OK it: whose work it changes
   * beyond this project, how much it downloads, and how long it usually takes in seconds, until squad-kit measured it here.
   */
  update?: { reaches: string; size: string; seconds: number };
  /** Too old: the steps to update it yourself, by the tool that looks after your copy. `all` is every other copy. */
  updateSteps?: Partial<Record<ManagedBy | 'all', string[]>>;
  /**
   * Checked as today, by "Is your computer ready?" and by the step that uses it: shown here, never a new stop. Its check
   * cannot always be sure (a sign-in), and it never stops anyone.
   */
  asToday?: true;
}

const MOBILE: ProjectKind[] = ['flutter', 'react-native', 'ios', 'android'];
const CROSS: ProjectKind[] = ['flutter', 'react-native'];
const ON_PHONE: ToolAction[] = ['pictures', 'start-app', 'try-it'];
const CHECK_AGAIN = 'Come back here and press Check again.';
// On Mac and Linux, Check again reads your terminal's PATH, so a new tool is seen at once. Not yet on Windows.
const OPEN_AGAIN = 'Close squad-kit and open it again, so it sees the new tool. Then press Check again.';

export const CATALOG: ToolEntry[] = [
  {
    id: 'git',
    name: 'Git',
    gives: 'keeps every version of your work safe',
    needs: [{ kinds: 'any', priority: 'required', for: ['build', 'checks'] }],
    min: '2.38',
    installer: 'you',
    why: "it installs for the whole computer, which needs your computer's password",
    steps: {
      all: ["Open Git's official download page.", 'Get Git for your computer and install it.', CHECK_AGAIN],
      windows: ["Open Git's official download page.", 'Get Git for your computer and install it.', OPEN_AGAIN],
    },
    link: 'https://git-scm.com/downloads',
    asToday: true,
  },
  {
    id: 'ai-tool',
    name: 'An AI tool',
    gives: 'the squad itself: the Analyst, Architect, Builder, Reviewer and Tester',
    needs: [{ kinds: 'any', priority: 'required', for: ['build'] }],
    installer: 'you',
    why: 'it works on your own AI account, which only you can sign in to',
    steps: { all: ['Open a terminal.', 'Run: npm install -g @anthropic-ai/claude-code', 'Run: claude, and sign in once.', CHECK_AGAIN] },
    link: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    asToday: true,
  },
  {
    id: 'flutter',
    name: 'Flutter',
    gives: 'builds and tests the Flutter app',
    needs: [{ kinds: ['flutter'], priority: 'required', for: ['build', 'checks', ...ON_PHONE] }],
    installer: 'you',
    why: "it becomes part of your computer's own setup, and Flutter's installer walks you through it",
    steps: {
      mac: ["Open Flutter's official install page.", 'Pick macOS, then iOS, and follow the steps there.', 'In a terminal, run: flutter doctor, to see that it works.', CHECK_AGAIN],
      windows: ["Open Flutter's official install page.", 'Pick Windows, then Android, and follow the steps there.', 'In a terminal, run: flutter doctor, to see that it works.', OPEN_AGAIN],
      linux: ["Open Flutter's official install page.", 'Pick Linux, then Android, and follow the steps there.', 'In a terminal, run: flutter doctor, to see that it works.', CHECK_AGAIN],
    },
    link: 'https://docs.flutter.dev/get-started/install',
    // One Flutter serves every Flutter project on the computer: updating it changes theirs too, so it is asked first.
    update: { reaches: 'every Flutter project', size: 'about 1 GB', seconds: 300 },
    updateSteps: {
      all: ['Open a terminal.', 'Run: flutter upgrade', CHECK_AGAIN],
      homebrew: ['Open a terminal.', 'Run: brew upgrade --cask flutter', CHECK_AGAIN],
      fvm: ['Open a terminal.', 'Run: fvm install stable', 'Run: fvm global stable', CHECK_AGAIN],
    },
  },
  {
    id: 'xcode',
    name: 'Xcode',
    gives: 'the real iPhone, for pictures and Try it yourself',
    needs: [
      { kinds: CROSS, platform: 'ios', priority: 'required', for: ON_PHONE },
      { kinds: ['ios'], priority: 'required', for: ['build', 'checks', ...ON_PHONE] },
    ],
    systems: ['mac'],
    notHere: 'needs a Mac',
    installer: 'you',
    why: 'it comes from the App Store and needs your Apple ID',
    steps: { mac: ['Open the App Store and get Xcode. It is free, and big: it can take an hour.', 'Open Xcode once and let it finish setting up.', CHECK_AGAIN] },
    link: 'https://apps.apple.com/app/xcode/id497799835',
  },
  {
    id: 'simulator',
    name: 'iPhone simulator',
    gives: 'an iPhone on this Mac, for pictures, Start and Try it yourself',
    needs: [
      { kinds: CROSS, platform: 'ios', priority: 'required', for: ON_PHONE },
      { kinds: ['ios'], priority: 'required', for: ['checks', ...ON_PHONE] },
    ],
    systems: ['mac'],
    notHere: 'needs a Mac',
    installer: 'you',
    why: 'it comes with Xcode, from Apple',
    steps: { mac: ['Open Xcode.', 'Go to Xcode, then Settings, then Components.', 'Get the newest iOS.', CHECK_AGAIN] },
    link: 'https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components',
  },
  {
    id: 'cocoapods',
    name: 'CocoaPods',
    gives: "brings in the app's iPhone libraries when it builds for the iPhone",
    needs: [{ kinds: CROSS, platform: 'ios', priority: 'required', for: ON_PHONE }],
    // Flutter's own: below 1.16.2 its doctor says "CocoaPods 1.15.2 out of date (1.16.2 is recommended)", and iPhone
    // builds still work (cocoaPodsRecommendedVersion in flutter_tools/lib/src/macos/cocoapods.dart, read in Flutter 3.47.9).
    recommended: '1.16.2',
    systems: ['mac'],
    notHere: 'needs a Mac',
    installer: 'you',
    why: "it may need your computer's password",
    steps: { mac: ['Open a terminal.', "Run: sudo gem install cocoapods. It asks for your computer's password.", CHECK_AGAIN] },
    link: 'https://guides.cocoapods.org/using/getting-started.html',
    // A copy from RubyGems may be the person's own Ruby, or the Mac's, which only the computer's password changes.
    updateSteps: {
      all: ['Open a terminal.', 'Run: gem update cocoapods', "If it says you don't have write permissions, run: sudo gem update cocoapods. It asks for your computer's password.", CHECK_AGAIN],
      homebrew: ['Open a terminal.', 'Run: brew upgrade cocoapods', CHECK_AGAIN],
    },
  },
  {
    id: 'maestro',
    name: 'Maestro',
    gives: 'taps through the phone app by itself, for the pictures',
    needs: [{ kinds: MOBILE, priority: 'required', for: ['pictures'] }],
    installer: 'squad-kit',
    link: 'https://maestro.dev',
    getSeconds: 80,
    with: ['java'],
  },
  {
    id: 'java',
    name: 'Java',
    gives: 'runs Maestro',
    needs: [{ kinds: MOBILE, priority: 'required', for: ['pictures'] }],
    min: '17',
    installer: 'squad-kit',
    link: 'https://adoptium.net',
    getSeconds: 30,
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    gives: 'an Android phone on this computer',
    needs: [
      { kinds: CROSS, platform: 'android', priority: 'recommended', for: ON_PHONE },
      { kinds: ['android'], priority: 'recommended', for: ON_PHONE },
    ],
    installer: 'you',
    why: 'it is a big app with its own setup',
    steps: { all: ['Open the official download page and get Android Studio.', 'Open it once and follow its setup.', CHECK_AGAIN] },
    link: 'https://developer.android.com/studio',
    note: 'Android pictures and Start come in the next squad-kit update.',
  },
  {
    id: 'docker',
    name: 'Docker',
    gives: "runs the services the app starts with, like its database",
    needs: [{ kinds: ['docker'], priority: 'recommended', for: ['start-app'] }],
    installer: 'you',
    why: "it installs for the whole computer, which needs your computer's password",
    steps: { all: ['Open the official page and get Docker Desktop.', 'Open it once and let it start.', CHECK_AGAIN] },
    link: 'https://docs.docker.com/get-started/get-docker/',
  },
];

export function toolEntry(id: string): ToolEntry | undefined {
  return CATALOG.find((t) => t.id === id);
}

/** What each kind of project is called on the page. */
export const KIND_WORDS: Record<ProjectKind, string> = {
  web: 'web or Node.js code',
  flutter: 'a Flutter app',
  'react-native': 'a React Native app',
  ios: 'an iPhone app',
  android: 'an Android app',
  docker: 'Docker files',
};

export const PLATFORM_WORDS: Record<Platform, string> = { ios: 'iPhone', android: 'Android', web: 'web' };

/** What each action is called on a line's "Used for". */
export const ACTION_WORDS: Record<ToolAction, string> = {
  build: 'Building',
  checks: 'Checks',
  pictures: 'Phone pictures',
  'start-app': 'Start',
  'try-it': 'Try it yourself',
};

/** What can't happen, for a block's message: "squad-kit can't build this story yet". */
export const ACTION_DOING: Record<ToolAction, string> = {
  build: 'build this story',
  checks: "run this story's checks",
  pictures: 'take the phone pictures',
  'start-app': 'start the app on a phone',
  'try-it': 'open Try it yourself on a phone',
};

/**
 * Where squad-kit gets its own tools, from the official source only. Maestro is pinned to one release, with the
 * checksum its release publishes; Java is the newest Eclipse Temurin runtime of this line, from Adoptium's own API.
 */
export const OWN_SOURCES = {
  maestro: {
    version: '2.12.1',
    url: 'https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/maestro.zip',
    checksums: 'https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/checksums_sha256.txt',
    file: 'maestro.zip',
    sha256: '54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7',
    // 334 MB; measured on the real file, whose sha256 is the one above.
    size: 349_832_427,
    /** Its usage numbers stay off, on every run. */
    env: { MAESTRO_CLI_NO_ANALYTICS: '1' },
  },
  java: {
    feature: 21,
    api: 'https://api.adoptium.net/v3/assets/latest',
  },
} as const;
