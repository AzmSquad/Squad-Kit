/**
 * A connection: the person's sign-in to an outside tool on this computer, for the Connections page (ADR-002). squad-kit
 * keeps no password. A tool signs in through its own way (a code the person types on the tool's page), with a pasted
 * token as the other way for some, takes a token the person pastes, or is shown as coming in a next version. Each
 * product's words come in English and Arabic, so the board names no product.
 */

/** Words for people, in both of the board's languages. */
export interface Words {
  en: string;
  ar: string;
}

/**
 * connected: signed in. not-connected: the tool is here, not signed in. missing: the tool is not on this computer.
 * unknown: the tool did not answer just now; never taken as signed out.
 */
export type ConnectionState = 'connected' | 'not-connected' | 'missing' | 'unknown' | 'soon';

/** One step of the step-by-step guide under the button. */
export interface GuideStep {
  text: Words;
  /** The command to run in a terminal, when the step is one. */
  command?: string;
  /** Already done on this computer: "Found gh 2.98.0". */
  done?: Words;
  /** The board page that helps with it: the Tools page's line. */
  page?: string;
  /** A page on the tool's own site for this step, opened in a new tab. */
  link?: string;
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** Who is signed in, when connected. */
  account?: string;
  /**
   * For a sign-in of squad-kit's own (`ownSignIn`): one is left in its folder, which Disconnect ends, whatever else is
   * true here (a token used instead, its tool gone, no access). `as`: its account, when its tool says.
   */
  signedIn?: { as?: string };
  steps: GuideStep[];
  /**
   * For a sign-in that also takes a pasted token: 'token' when the token is the way here, because one is saved (it
   * wins), or because this place cannot sign in (an Azure DevOps organization of personal Microsoft accounts). No
   * sign-in button and no Disconnect then: the token is changed in Settings.
   */
  by?: 'token';
  /** One plain line for this case: "Signed in as …, which has no access to …". */
  line?: Words;
}

/** The page the one-time code is typed on, when it is not the tool's own: Microsoft's, for Azure DevOps. */
export interface CodePage {
  /** "Microsoft": the button says "Sign in with Microsoft". */
  name: string;
  /** What to do on that page once the code is typed: "pick your work account, then press Continue". */
  then: Words;
  /** What squad-kit gets, under the code. */
  foot: Words;
}

/**
 * A sign-in started from the board or the terminal: the tool's one-time code and the page to type it on, until the
 * person approves it there, cancels, or it fails.
 */
export interface SignInFlow {
  state: 'waiting' | 'done' | 'failed' | 'cancelled';
  code?: string;
  /** The tool's page for the code. A normal link: squad-kit opens no window. */
  url?: string;
  /** The tool's own process, which Cancel stops. */
  pid?: number;
  startedAt: string;
  /** Plain words for a failure. */
  line?: string;
  account?: string;
}

export interface ConnectionModule {
  /** Used in commands: `squad connect github`. */
  name: string;
  label: string;
  /** What it brings. */
  what: Words;
  /** sign-in: a button that signs in through the tool. token: a token the person pastes. soon: shown, not working yet. */
  how: 'sign-in' | 'token' | 'soon';
  /** What squad-kit can do once it is connected. */
  can: Words[];
  /** The tracker module whose Settings take this connection's token: for `token`, and for a sign-in that takes one instead. */
  tracker?: string;
  /** The page the code is typed on, when it is not the tool's own. */
  codePage?: CodePage;
  /**
   * The sign-in is squad-kit's own, kept apart from the person's own sign-ins with the same tool: Disconnect signs only
   * squad-kit out.
   */
  ownSignIn?: boolean;
  /** That sign-in's folder inside squad-kit's own (core/home.ts privateFolder), which agents never reach. */
  privateFolder?: string;
  /** The next way to connect, shown as coming: "Sign in with Atlassian". */
  next?: Words;
  /** "owner/name" of a git remote on this tool, so the page can say what it is for. */
  repoName?(remoteUrl: string): string | null;
  status(root: string): Promise<ConnectionStatus>;
  /** Forget what was kept, so the next status asks the tool again. */
  forget?(): void;
  signIn?: {
    start(root: string): Promise<SignInFlow>;
    now(): SignInFlow | null;
    cancel(): SignInFlow | null;
  };
  signOut?(account: string): Promise<void>;
}
