import type { BoardMeta, NetworkLevel, Ticket } from '../../board/types.js';
import { autoAskRule } from '../auto-prompts.js';

/**
 * The setup command failed in this copy. The person cannot help with that, so the Builder sorts it out, in the project:
 * the next story's copy and the person's own checkout run the same command.
 */
/** The files an engineer keeps agents off, so the Builder does not spend its time on them. */
export function offLimitsText(meta: BoardMeta): string {
  const local = (meta.localFiles ?? []).map((f) => f.path);
  const locked = (meta.lockedFiles ?? []).map((f) => f.path);
  if (!local.length && !locked.length) return '';
  return `\n\nFiles only an engineer changes:${local.length ? `\n- ${local.join(', ')}: these exist, and you cannot read them. Never treat one as missing. squad-kit's run_checks and start_app can use them, so run what needs them with those tools.` : ''}${locked.length ? `\n- ${locked.join(', ')}: you can read these, and a change to one is put back.` : ''}\nIf the story cannot work without changing one, do the rest and say so in notes.`;
}

/** Technical trouble is never the person's: it goes to i_am_stuck. Some asks are never allowed at all. Every ask rule has it. */
export const TECH_RULE = `- Never ask the person a technical question (files, settings, commands, the terminal, ports, installs, the browser,
  permissions, git): squad-kit sends it back to you. When something technical is in your way, call squad-kit's
  i_am_stuck tool. Never ask the person to change squad-kit's settings or its .squad folder, to hand over a password
  or a key, or to change git history: squad-kit refuses it and counts it.`;

const ASK_RULE = `- Ask the person only when something important is unclear and a wrong guess would waste the work or break a business rule:
  then stop, fill "question" (one plain sentence, 2 to 4 short options, and why it matters), and leave the rest for later.
  Say why you ask in question.kind: "gap" (the story misses something that changes what gets built) or "clash" (two
  requirements disagree). They answer in this same conversation. Never ask about code style or small choices.
  To show what you mean, put full paths of files you made in "files": screenshots, a wireframe, or one self-contained
  HTML page as a clickable mockup (inline CSS, no links to other sites).
- Product and technical choices are yours: decide them, and list the ones the person may care about in "decided", in
  short plain sentences.
${TECH_RULE}`;

/** When to ask the person: the usual rule, or on the Builds by itself track only for a gap or a clash. */
export function askRule(t: Ticket): string {
  return t.track === 'auto' ? autoAskRule() : ASK_RULE;
}

/** What every agent with squad-kit's own tools is told about them, beside its step's own instructions. */
export function windowRule(tools: string[]): string {
  const app = tools.includes('take_screenshots');
  const look = !app && tools.includes('look_at_page');
  const checks = tools.includes('run_checks');
  const named = [
    ...(app ? ["take_screenshots and look_at_page (its own browser on this story's app)", "start_app, stop_app and app_status (this story's app, started with the project's own start command)"] : look ? ["look_at_page (its own browser on this story's app, which it starts for you when needed)"] : []),
    ...(checks ? ["run_checks (the project's own saved tests, lint and build, in this story's copy)"] : []),
    'i_am_stuck',
  ];
  return `squad-kit gives you tools of its own in this step: ${named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0]}. squad-kit checks every field and does the work itself.
When something technical is in your way (the app does not start, a port is busy, the browser does not work, a
command or a file is refused), call i_am_stuck: squad-kit tries its fixes and tells you what it did. Never take it to
the person, and never ask them to edit settings or files, run commands, or hand over a password or a key.${app ? '\nFor pictures and pages of the app, use take_screenshots and look_at_page, never a browser of your own.' : look ? '\nFor pages of the app, use look_at_page, never a browser or an app of your own.' : ''}${checks ? "\nA browser cannot start in your shell, so run tests that open a browser with run_checks, never yourself." : ''}`;
}

/** Where a step's shell commands go on each network level, in the agent's words. */
const NETWORK_REACH: Record<NetworkLevel, string> = {
  standard: 'any website except a few closed ones (tunnels, paste and file-drop sites, request catchers)',
  strict: "only the official package and download sites of common tools and this project's own sites",
  off: 'no website at all, only this computer',
};

/**
 * What every sandboxed step is told about the project's network level, and the way around a site its command could
 * not reach: the site is closed on purpose, so the agent goes on without it and never takes it to the person.
 */
export function networkRule(level: NetworkLevel): string {
  const from = level === 'off' ? 'what is already installed and in this copy' : 'an official package registry or what is already in this copy';
  return `Your shell commands reach ${NETWORK_REACH[level]}. A site a command could not reach because it is not allowed is closed for this project on purpose: do not try it again another way, and never ask the person to open it. Use ${from}, or go on without it and say in your answer what is missing.`;
}
