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
export type ToolId = 'git' | 'ai-tool' | 'flutter' | 'xcode' | 'simulator' | 'cocoapods' | 'android' | 'maestro' | 'java' | 'android-studio' | 'docker';
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
  /** squad-kit gets these first, when they are missing: it needs them to get this one (Java runs Google's Android tools). */
  before?: ToolId[];
  /**
   * Its maker's license must be accepted first, by you: the board shows it in full, and Get it waits for your Accept.
   * squad-kit never accepts it for you.
   */
  license?: true;
  /** How much room it takes once it is in, for its Get it: "about 20 GB". */
  size?: string;
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
    id: 'android',
    name: 'Android phone tools',
    gives: "Google's own Android emulator and build tools: an Android phone on this computer, for pictures, Start and Try it yourself",
    needs: [
      { kinds: CROSS, platform: 'android', priority: 'required', for: ON_PHONE },
      { kinds: ['android'], priority: 'required', for: ON_PHONE },
    ],
    notHere: "needs a Mac, or a computer with an Intel or AMD chip: Google's Android emulator doesn't run on this one yet",
    installer: 'squad-kit',
    link: 'https://developer.android.com/studio#command-line-tools-only',
    // About 3.6 GB from Google at 6 MB/s, then unpacking: 10 to 15 minutes the first time on a 16 GB Mac.
    getSeconds: 720,
    license: true,
    size: 'about 20 GB',
    before: ['java'],
    with: ['maestro'],
  },
  {
    id: 'java',
    name: 'Java',
    gives: "runs Maestro, and Google's Android build tools",
    needs: [
      { kinds: MOBILE, priority: 'required', for: ['pictures'] },
      { kinds: CROSS, platform: 'android', priority: 'required', for: ON_PHONE },
      { kinds: ['android'], priority: 'required', for: ON_PHONE },
    ],
    min: '17',
    installer: 'squad-kit',
    link: 'https://adoptium.net',
    getSeconds: 30,
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    gives: "Google's app for building Android apps by hand. squad-kit doesn't need it: its Android phone tools are enough",
    needs: [
      { kinds: CROSS, platform: 'android', priority: 'optional', for: ON_PHONE },
      { kinds: ['android'], priority: 'optional', for: ON_PHONE },
    ],
    installer: 'you',
    why: 'it is a big app with its own setup',
    steps: { all: ['Open the official download page and get Android Studio.', 'Open it once and follow its setup.', CHECK_AGAIN] },
    link: 'https://developer.android.com/studio',
    note: 'When its Android tools have everything squad-kit needs, squad-kit uses them as they are and never changes them.',
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
  /**
   * Google's Android tools: the command-line tools pinned to one build, by the checksum Google's own manifest gives
   * (repository2-3.xml, checked 2026-11-11; the Mac arm64 file's SHA-256 also matches developer.android.com), then the
   * packages sdkmanager installs from Google's site. API 36 (Android 16) is what Flutter 3.47 builds for; its NDK is the
   * one Flutter's template names, got here so a first build doesn't fetch it silently.
   */
  android: {
    /** The folder's version: the API level of its system. */
    version: '36',
    api: 36,
    system: '16',
    base: 'https://dl.google.com/android/repository/',
    manifests: ['https://dl.google.com/android/repository/repository2-3.xml', 'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-4.xml'],
    tools: {
      'mac-arm64': { file: 'commandlinetools-mac_arm64-15859902_latest.zip', size: 156_083_281, sha1: 'c4e0dbc53f1a4ce04fc2b11d4e2c4675001a95af', sha256: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e' },
      'mac-x64': { file: 'commandlinetools-mac_x86_64-15859902_latest.zip', size: 156_281_494, sha1: '1a79e61677b99cb0ce622792713cbea7ff2dc5de' },
      'windows-x64': { file: 'commandlinetools-win-15859902_latest.zip', size: 155_655_386, sha1: 'b9862337a13e2809a5159dc3a08d058091bd59f6' },
      'linux-x64': { file: 'commandlinetools-linux-15859902_latest.zip', size: 181_833_628, sha1: '040d3996a65543d22ec4bf73e4c37aa37a8d4af4' },
    },
    /** What sdkmanager installs, with each download's size on each system, for the progress line. */
    packages: {
      'platform-tools': { mac: 16_597_640, linux: 9_571_024, windows: 8_188_595 },
      emulator: { 'mac-arm64': 420_630_743, 'mac-x64': 487_646_420, linux: 350_070_672, windows: 456_614_209 },
      'platforms;android-36': { all: 65_878_410 },
      'build-tools;36.0.0': { mac: 79_121_749, linux: 63_737_259, windows: 58_699_878 },
      'ndk;28.2.13676358': { mac: 952_495_160, linux: 722_261_334, windows: 748_118_221 },
    },
    images: {
      arm64: { id: 'system-images;android-36;google_apis;arm64-v8a', size: 1_872_691_175 },
      x64: { id: 'system-images;android-36;google_apis;x86_64', size: 1_895_447_397 },
    },
    /** Free room squad-kit asks for before Get it: the tools, a phone with its snapshot, and Gradle's first build. */
    diskBytes: 20 * 1000 ** 3,
  },
} as const;
