import type { PortAsk } from '../board/types.js';

/**
 * An agent may stop to ask about something technical in its way: a port another program holds, a server left
 * running, a process to stop. That is the engine's to settle, not a project manager's. squad-kit reads the question
 * for the ports and process numbers it names. When what holds them is a squad-kit leftover, it stops it and answers the
 * agent itself. When it is a program squad-kit did not start, it tells the agent to go around it, with a free port.
 * Only if the agent says again that it cannot does the person get one plain choice, and the port and the process stay
 * in the engineer details. A program squad-kit did not start is never stopped without the person's press. Whatever AI
 * tool asks, the words are the same, so nothing here knows a tool.
 */

export interface InTheWay {
  ports: number[];
  pids: number[];
}

/** The words of a question about a busy port or a program in the way. */
const ABOUT = /\b(in use|busy|held|holds|holding|occupied|taken|eaddrinuse|already running|still running|left ?over|left running|orphan\w*|stuck|stop|kill|free (up )?the port|blocking|in the way|listening)\b/i;

/** The ports and process numbers a question names, when it is about a busy port or a program in the way; else null. */
export function inTheWay(text: string): InTheWay | null {
  if (!ABOUT.test(text)) return null;
  const ports = new Set<number>();
  for (const m of text.matchAll(/\bports?\s*:?\s*(\d{2,5})\b|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*):(\d{2,5})\b|-p\s+(\d{2,5})\b|--port[= ](\d{2,5})\b/gi)) {
    const n = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (n > 0 && n < 65536) ports.add(n);
  }
  const pids = new Set<number>();
  for (const m of text.matchAll(/\bkill(?:\s+-\w+)*\s+(\d{2,7})\b|\b(?:pid|process(?:\s+id)?)\s*[:#]?\s*(\d{2,7})\b/gi)) pids.add(Number(m[1] ?? m[2]));
  return ports.size || pids.size ? { ports: [...ports], pids: [...pids] } : null;
}

/** squad-kit stopped the leftover: what the agent is told, in the same conversation. */
export function settledAnswer(what: { port?: number }): string {
  return what.port
    ? `squad-kit stopped the leftover server on port ${what.port}; carry on. It was a program left running in one of squad-kit's own copies of this project. Run what you needed the port for again, then go on with the work.`
    : "squad-kit stopped the leftover program; carry on. It was left running in one of squad-kit's own copies of this project. Go on with the work.";
}

/** A way around a busy port: a free one near it, and the app's own settings to set it in. */
export interface AroundIt {
  port?: number;
  free?: number;
  /** The app's own port settings, beside PORT. */
  vars?: string[];
}

/** "Port 4310 is free now: run it there, with PORT=4310." */
function freeWords(a: AroundIt): string {
  if (!a.free) return 'Use another free port: set PORT, or the setting the project has for it.';
  const set = ['PORT', ...(a.vars ?? [])].map((name) => `${name}=${a.free}`).join(' and ');
  return `Port ${a.free} is free right now: run your server there, with ${set}, and point what needs it at that port.`;
}

/** A program squad-kit did not start holds the port: what the agent is told, the first time. Never to stop it. */
export function goAroundAnswer(a: AroundIt): string {
  const lead = a.port ? `A program squad-kit did not start holds port ${a.port}.` : 'That program is not squad-kit\'s.';
  const way = a.port ? freeWords(a) : 'Work around it.';
  return `${lead} Leave it alone: do not stop it. ${way} If you have start_app, use it for the app: it picks a free port by itself. Ask again only if the work truly cannot go on while that program runs.`;
}

/** squad-kit's own work on another ticket holds the port: what the agent is told. It may not stop that either. */
export function ownWorkAnswer(a: AroundIt): string {
  const what = a.port ? `Port ${a.port} is` : 'The program is';
  return `${what} used by squad-kit's own work right now (another ticket's step, or squad-kit itself). Leave it alone. ${a.port ? freeWords(a) : 'Work around it.'} If you cannot, skip what needs it for now and go on with the rest.`;
}

/** The choices on the person's card, and what the agent is told for each. */
export const STOP_IT = 'Stop it';
export const SKIP_BROWSER = 'Skip the browser tests';
export const LEAVE_IT = 'Leave it running';

/**
 * The person's card for a program squad-kit did not start, once going around it did not work: plain words, with no
 * port and no process number (those are in the details).
 */
export function portCard(p: PortAsk): { text: string; options: string[]; why: string } {
  const needs = 'what the browser tests need';
  // A program the system will not name (another user's): squad-kit cannot stop it, so the way on is to go without it.
  if (p.port && !p.pid) {
    return {
      text: `Another program on this computer is using ${needs}, and squad-kit cannot stop it.`,
      options: [SKIP_BROWSER],
      why: 'squad-kit tried to go around it first. The Builder can go on without the browser tests. An engineer can see which program it is in the details.',
    };
  }
  if (p.port) {
    return {
      text: `${p.app ? `Your app ${p.app}, which runs from Your apps,` : 'Another program on this computer'} is using ${needs}.`,
      options: [STOP_IT, SKIP_BROWSER],
      why: 'squad-kit tried to go around it first. It did not start that program, so it leaves it alone unless you say so.',
    };
  }
  return {
    text: "Another program on this computer is in the Builder's way.",
    options: [STOP_IT, LEAVE_IT],
    why: 'squad-kit tried to go around it first. It did not start that program, so it leaves it alone unless you say so.',
  };
}

/** What the agent is told after the person's choice on that card. */
export function cardAnswer(p: PortAsk, choice: string, stopped: boolean | null): string {
  const port = p.port ? `port ${p.port}` : 'the program in your way';
  if (choice === STOP_IT && stopped) return `The person agreed, and squad-kit stopped the program that held ${port}; carry on. Run what you needed it for again, then go on with the work.`;
  if (choice === STOP_IT) return `squad-kit could not stop the program that holds ${port}. Leave it alone: do not try to stop it yourself. ${p.port ? 'Skip the browser tests for now and' : 'Work around it and'} go on with the rest of the work; say so in your summary.`;
  if (choice === SKIP_BROWSER) return `The person keeps that program running, so ${port} stays busy. Skip the browser tests for now: do not run them and do not try to free the port. Go on with the rest of the work, and say in your summary that the browser tests did not run.`;
  return `The person keeps that program running. Do not try to stop it. Work around it and go on with the rest of the work.`;
}
