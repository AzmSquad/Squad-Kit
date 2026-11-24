import path from 'node:path';
import { readMeta, type BoardPaths } from '../board/store.js';
import { BoardActionError } from '../board/actions/errors.js';
import { CONNECTIONS, connectionModule } from '../modules/registry.js';
import type { AddressAsk, CodePage, ConnectionModule, ConnectionState, ConnectionStatus, GuideStep, SignInFlow, TokenAsk, Words } from '../modules/connection/types.js';
import { git } from './git.js';
import { reposOf } from './repos.js';
import { selfRepo, selfUpstream } from './self-project.js';

/**
 * The Connections page: one row per outside tool, with its state on this computer, what it is for in this project, the
 * button first and the step-by-step guide under it. Every action is one REST call and one terminal command
 * (`squad connect`, `squad disconnect`). The rows come from the modules, so nothing here names a product.
 */

export interface ConnectionAction {
  id: 'sign-in' | 'disconnect' | 'check';
  name: string;
  command: string;
}

export interface ConnectionRow {
  name: string;
  label: string;
  what: Words;
  how: ConnectionModule['how'];
  can: Words[];
  next?: Words;
  tracker?: string;
  codePage?: CodePage;
  ownSignIn?: boolean;
  state: ConnectionState;
  account?: string;
  steps: GuideStep[];
  /** 'token': the token in Settings is the way here (saved, or the only way for this place). */
  by?: 'token';
  line?: Words;
  /** A sign-in of squad-kit's own left here, which Disconnect ends. */
  signedIn?: { as?: string };
  /** Where on the tool's own site squad-kit's access can be taken away too. */
  revokeAt?: { link: string; words: Words };
  /** The places the sign-in reaches, to pick this project's from. */
  pick?: { site: string; name: string; where?: string }[];
  /** The place's address, pasted: when the list does not have it, or to change the one in use (`now`). */
  address?: AddressAsk;
  /** A token pasted on this row, with its steps. */
  token?: TokenAsk;
  /** What it is for in this project: the repo on this tool, and the repo its pull requests go to when that is not it. */
  for?: { repo: string; into?: string; self: boolean };
  /** A sign-in started from the board or the terminal, while it waits or just ended. */
  flow?: SignInFlow;
  actions: ConnectionAction[];
}

const remoteOf = (dir: string, name: string) => git(dir, ['config', '--get', `remote.${name}.url`], { allowFail: true }).trim();

/** The first of the project's repos that lives on this tool, and where its pull requests go. */
function forOf(bp: BoardPaths, m: ConnectionModule): ConnectionRow['for'] {
  if (!m.repoName) return undefined;
  const meta = readMeta(bp);
  const self = selfRepo(bp.root, meta);
  for (const r of reposOf(meta)) {
    const dir = path.join(bp.root, r.path);
    const repo = m.repoName(remoteOf(dir, r.remote || 'origin'));
    if (!repo) continue;
    if (r.path !== self) return { repo, self: false };
    const into = m.repoName(selfUpstream(dir, r.remote || 'origin')) ?? repo;
    return { repo, into, self: true };
  }
  return undefined;
}

/**
 * The sign-in Disconnect would end: squad-kit's own one left here, else the tool's own when it is connected with it (not
 * with a pasted token). Null: nothing to sign out of.
 */
function toEnd(s: ConnectionStatus): { as?: string } | null {
  if (s.signedIn) return s.signedIn;
  return s.state === 'connected' && s.account && s.by !== 'token' ? { as: s.account } : null;
}

function actionsOf(m: ConnectionModule, s: ConnectionStatus): ConnectionAction[] {
  if (m.how === 'soon') return [];
  const list: ConnectionAction[] = [];
  // Only a tool that is here and signed out gets the button: missing, or not answering, the guide comes first. When the
  // token is the way here, Settings is: no sign-in; nor while a place is left to pick. Disconnect is there while there is
  // a sign-in to end.
  if (m.signIn && s.state === 'not-connected' && s.by !== 'token' && !s.pick?.length) list.push({ id: 'sign-in', name: `Sign in with ${m.codePage?.name ?? m.label}`, command: `squad connect ${m.name}` });
  if (m.signOut && toEnd(s)) list.push({ id: 'disconnect', name: 'Disconnect', command: `squad disconnect ${m.name}` });
  list.push({ id: 'check', name: 'Check again', command: 'squad connect --status' });
  return list;
}

async function rowOf(bp: BoardPaths, m: ConnectionModule): Promise<ConnectionRow> {
  const s = await m.status(bp.root);
  const flow = m.signIn?.now() ?? undefined;
  const there = forOf(bp, m);
  return {
    name: m.name,
    label: m.label,
    what: m.what,
    how: m.how,
    can: m.can,
    ...(m.next ? { next: m.next } : {}),
    ...(m.tracker ? { tracker: m.tracker } : {}),
    ...(m.codePage ? { codePage: m.codePage } : {}),
    ...(m.ownSignIn ? { ownSignIn: true } : {}),
    ...(m.ownSignIn && m.revokeAt ? { revokeAt: m.revokeAt } : {}),
    state: s.state,
    ...(s.account ? { account: s.account } : {}),
    steps: s.steps,
    ...(s.by ? { by: s.by } : {}),
    ...(s.line ? { line: s.line } : {}),
    ...(s.signedIn ? { signedIn: s.signedIn } : {}),
    ...(s.pick?.length ? { pick: s.pick } : {}),
    ...(m.pickSite && s.address ? { address: s.address } : {}),
    ...(m.saveToken && s.token ? { token: s.token } : {}),
    ...(there ? { for: there } : {}),
    ...(flow ? { flow } : {}),
    actions: actionsOf(m, s),
  };
}

/** Every row. `again`: ask each tool afresh (Check again). */
export async function connectionsOf(bp: BoardPaths, opts: { again?: boolean } = {}): Promise<{ rows: ConnectionRow[] }> {
  if (opts.again) CONNECTIONS.forEach((m) => m.forget?.());
  return { rows: await Promise.all(CONNECTIONS.map((m) => rowOf(bp, m))) };
}

function moduleFor(name: string): ConnectionModule {
  const m = connectionModule(name);
  if (!m) throw new BoardActionError(`squad-kit has no connection called ${name}. squad connect --status lists them.`);
  return m;
}

function signInOf(name: string): NonNullable<ConnectionModule['signIn']> {
  const m = moduleFor(name);
  if (!m.signIn) throw new BoardActionError(m.how === 'soon' ? `Signing in to ${m.label} comes in a next version.` : `${m.label} connects with a token you paste, not a sign-in button.`);
  return m.signIn;
}

/** Sign in: runs the tool's own sign-in and gives its one-time code and page as soon as the tool prints them. */
export async function startSignIn(bp: BoardPaths, name: string): Promise<SignInFlow> {
  return signInOf(name).start(bp.root);
}

/** The sign-in as it stands: waiting for the person on the tool's page, done, failed or cancelled. */
export function signInNow(name: string): SignInFlow | null {
  return signInOf(name).now();
}

/** Cancel: stops the tool's own sign-in process, the one this sign-in started. */
export function cancelSignIn(name: string): SignInFlow {
  const f = signInOf(name).cancel();
  if (!f) throw new BoardActionError('No sign-in is running.');
  return f;
}

/**
 * Picks the place a sign-in reaches for projects that have none of their own yet: one of the row's `pick` list, by its
 * name there (a Jira site, an Azure DevOps organization/project), or a pasted address where the row takes one. In a
 * terminal, `squad connect <tool> --site <site>`, or a number from the list.
 */
export async function pickSite(bp: BoardPaths, name: string, site: string): Promise<{ line: string }> {
  const m = moduleFor(name);
  if (!m.pickSite) throw new BoardActionError(`${m.label} has nothing to pick here.`);
  if (!site?.trim()) throw new BoardActionError('Say which one to use.');
  return m.pickSite(bp.root, site.trim());
}

/**
 * A token pasted on the row, with the address of the place when it has none yet: checked, then saved for this project on
 * this computer. In a terminal, `squad config set tracker`: a secret is never typed into a command.
 */
export async function saveToken(bp: BoardPaths, name: string, input: { address?: string; token?: string }): Promise<{ line: string }> {
  const m = moduleFor(name);
  if (!m.saveToken) throw new BoardActionError(`${m.label} takes its token in Settings.`);
  if (!input.token?.trim()) throw new BoardActionError('Paste the token first.');
  return m.saveToken(bp.root, { ...(input.address?.trim() ? { address: input.address.trim() } : {}), token: input.token });
}

/** Whose sign-in Disconnect ends, and the page the code is typed on, for the terminal's own words. */
export function connectionInfo(name: string): { label: string; ownSignIn: boolean; codePage?: CodePage } {
  const m = moduleFor(name);
  return { label: m.label, ownSignIn: Boolean(m.ownSignIn), ...(m.codePage ? { codePage: m.codePage } : {}) };
}

/**
 * Disconnect: signs the tool out on this computer, for the account signed in now. A sign-in that is squad-kit's own
 * ends for squad-kit only; the tool's own sign-in ends for every app that uses it.
 */
export async function disconnect(bp: BoardPaths, name: string): Promise<{ line: string }> {
  const m = moduleFor(name);
  if (!m.signOut) throw new BoardActionError(`${m.label} has nothing to sign out of here.`);
  // From this computer's files when the module can tell (works offline, asks nobody); else from its status.
  const local = m.localSignIn?.(bp.root);
  let end: { as?: string } | null;
  let byToken: boolean;
  if (local !== undefined) {
    end = local === 'token' ? null : local;
    byToken = local === 'token';
  } else {
    m.forget?.();
    const s = await m.status(bp.root);
    end = toEnd(s);
    byToken = s.by === 'token';
  }
  if (!end && byToken) throw new BoardActionError(`${m.label} is connected with the token saved in Settings. Change it there.`);
  if (!end) throw new BoardActionError(`${m.label} is not signed in on this computer.`);
  await m.signOut(end.as ?? '');
  m.forget?.();
  const as = end.as ? `, as ${end.as}` : '';
  const revoke = m.revokeAt ? ` ${m.revokeAt.words.en.replace(/\.$/, '')}: ${m.revokeAt.link}` : '';
  if (m.ownSignIn) return { line: `squad-kit is signed out of ${m.label} on this computer${as}. Your other sign-ins on this computer stay as they are.${revoke}` };
  return { line: `${m.label} is signed out on this computer${as}. Every app that uses its tool here is signed out too.` };
}
