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
  /**
   * The sign-in reaches several places and this project has none yet: the person picks one (`pickSite`). `where`: the
   * line under its name (the site when not given).
   */
  pick?: { site: string; name: string; where?: string }[];
  /**
   * This row also takes the address of the project's place, pasted from the browser (`pickSite` with it): when the list
   * does not have it, or to change it. `now`: the place in use, said on a connected row.
   */
  address?: AddressAsk;
  /** A token pasted on this row (`saveToken`): its steps with real links, and open at once when it is the only way here. */
  token?: TokenAsk;
}

/** The pasted address of a place: an example of one, and where to copy it from. */
export interface AddressAsk {
  now?: string;
  example: string;
  where: Words;
}

/** The token form on a row: the place's address when it has none yet, and the token. */
export interface TokenAsk {
  steps: GuideStep[];
  /** The address the form starts with: the place in use or found, else empty. */
  address?: string;
  /** Open at once: the token is the only way for this place. */
  open?: boolean;
  /** Why a token here, in one line. */
  why: Words;
  /** The terminal's way to save it: a secret is never typed into a command. */
  command: string;
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
 * A sign-in started from the board or the terminal: the tool's one-time code and the page to type it on, or only the
 * page to approve squad-kit on (no code), until the person approves it there, cancels, or it fails.
 */
export interface SignInFlow {
  state: 'waiting' | 'done' | 'failed' | 'cancelled';
  code?: string;
  /** The tool's page for the code, or the page to approve on. A normal link: squad-kit opens no window. */
  url?: string;
  /** The tool's own process, which Cancel stops. */
  pid?: number;
  startedAt: string;
  /** Plain words for a failure, or for what is left to do once it is done. */
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
  /** Where on the tool's own site the person can take squad-kit's access away too: said with Disconnect. */
  revokeAt?: { link: string; words: Words };
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
  /**
   * What Disconnect would end, from this computer's files only (no call goes out): squad-kit's own sign-in left here
   * (with its account when known), 'token' when a pasted token is the way and nothing else is left, or null.
   */
  localSignIn?(root: string): { as?: string } | 'token' | null;
  /** Picks one of the places the sign-in reaches (`ConnectionStatus.pick`) for projects that have none of their own. */
  pickSite?(root: string, site: string): Promise<{ line: string }>;
  /** Saves a token pasted on the row (`ConnectionStatus.token`) with the place's address, then checks it. */
  saveToken?(root: string, input: { address?: string; token: string }): Promise<{ line: string }>;
}
