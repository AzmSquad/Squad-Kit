/**
 * Asking the browser for desktop notices, so that Turn on always gives an answer the person can see. Some browsers
 * never answer the question: Chrome and Arc can show a quiet bell in the address bar instead of a popup, and an
 * embedded browser may not ask at all. After a few seconds squad-kit says so, with what to do, and keeps the choice
 * "on", so notices start once the browser allows them.
 */

/** What came of asking. `timeout`: the browser did not answer in time. `insecure`: the page is not a secure one. */
export type Asked = 'granted' | 'denied' | 'default' | 'timeout' | 'unsupported' | 'insecure' | 'error';

/** The browser's own answer, as Notification.permission says it. */
export type Permission = 'default' | 'granted' | 'denied';

/** The part of the browser's Notification the question needs, so a test can stand in for it. */
export interface NotificationLike {
  readonly permission: Permission;
  requestPermission(callback?: (p: Permission) => void): Promise<Permission> | undefined | void;
}

/** How long the browser gets to answer before squad-kit says what to do. */
export const ASK_MS = 8000;

/**
 * Asks once, after the person pressed Turn on (never when a page loads). Answers through a callback (older browsers)
 * or a promise (newer ones), whichever comes; a browser that throws, or answers with nothing and never calls back,
 * still ends in an answer: at the latest after `timeoutMs`.
 */
export function askPermission(n: NotificationLike | undefined, opts: { secure: boolean; timeoutMs?: number }): Promise<Asked> {
  if (!n) return Promise.resolve('unsupported');
  if (!opts.secure) return Promise.resolve('insecure');
  if (n.permission === 'granted' || n.permission === 'denied') return Promise.resolve(n.permission);
  return new Promise((resolve) => {
    let done = false;
    const end = (a: Asked) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(a);
    };
    const answer = (p: unknown) => end(p === 'granted' || p === 'denied' || p === 'default' ? p : n.permission === 'default' ? 'default' : n.permission);
    const timer = setTimeout(() => end(n.permission === 'default' ? 'timeout' : n.permission), opts.timeoutMs ?? ASK_MS);
    try {
      const p = n.requestPermission(answer);
      if (p && typeof (p as Promise<Permission>).then === 'function') {
        (p as Promise<Permission>).then(answer, () => end(n.permission === 'default' ? 'error' : n.permission));
      }
    } catch {
      end(n.permission === 'default' ? 'error' : n.permission);
    }
  });
}

/** How to allow notices, for any browser: Chrome, Edge, Arc, Firefox and Safari, on a Mac too. */
export const HOW_TO_ALLOW = "Allow notifications for this page in your browser's site settings (the icon next to the address), then reload. On a Mac, also check System Settings › Notifications for your browser.";

/** What the page says and keeps after asking. `choice` null leaves the choice as it was. */
export function afterAsking(a: Asked): { choice: 'on' | 'off' | null; say: string; bad: boolean; test: boolean } {
  switch (a) {
    case 'granted':
      return { choice: 'on', test: true, bad: false, say: "Desktop notices are on. Didn't see one just now? Your computer may block notices for this browser: check the system's notification settings." };
    case 'denied':
      // They wanted them: once the browser allows it, notices start without asking again.
      return { choice: 'on', test: false, bad: true, say: `Your browser blocks notices from this page. ${HOW_TO_ALLOW}` };
    case 'timeout':
      return { choice: 'on', test: false, bad: true, say: `Your browser has not answered. ${HOW_TO_ALLOW} Notices start once it allows them.` };
    case 'error':
      return { choice: 'on', test: false, bad: true, say: `Your browser did not let this page ask. ${HOW_TO_ALLOW}` };
    case 'insecure':
      return { choice: null, test: false, bad: true, say: 'Your browser shows desktop notices only on a secure page. Open the board on this computer, at its 127.0.0.1 or localhost address, to turn them on.' };
    case 'unsupported':
      return { choice: null, test: false, bad: true, say: "This browser can't show desktop notices. The banner and the tab title still show what needs you." };
    default:
      return { choice: 'off', test: false, bad: false, say: 'No desktop notices for now. Turn them on in Settings any time.' };
  }
}

/** While the browser asks: where to look. */
export const ASKING = 'Your browser is asking: look near the address bar.';
