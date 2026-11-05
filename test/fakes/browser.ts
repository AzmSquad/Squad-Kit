import { StepFailure, type Browser, type BrowserModule, type BrowserPage, type BrowserStep, type BrowserTarget } from '../../src/modules/browser/types.js';
import { pngBytes } from '../support/png.js';

/**
 * squad-kit's screenshot browser, faked for tests: a small made-up app of screens by path, each with the parts on it.
 * A step on a part that is not there fails the way the real browser's does, and a screenshot saves a real PNG that is
 * different for each screen (or the picture the test gives).
 */

export interface FakeScreen {
  /** The parts on it: "button:Save", "label:Email", "text:Booked", "placeholder:Search", "testId:x", "css:#a". */
  has?: string[];
  /** A click on one of the parts opens this path. */
  opens?: Record<string, string>;
  /** The picture saved of it; null saves nothing. Default: a page-like PNG at the window's size, its own per path. */
  picture?: (size: { width: number; height: number }) => Buffer | string | null;
  /** The HTTP status it answers with (200). */
  status?: number;
  /** Its accessibility tree. */
  snapshot?: string;
  /** Where opening it ends up (a redirect). */
  redirect?: string;
}

export interface FakeBrowser {
  module: BrowserModule;
  launches: number;
  /** Browsers started and not closed yet. */
  open: number;
  /** Every step and page opened, in words: "goto /", "click button:Save". */
  log: string[];
  /** Window sizes of the pages opened. */
  sizes: { width: number; height: number }[];
}

export function targetKey(t: BrowserTarget): string {
  if (t.role) return `${t.role}:${t.name ?? ''}`;
  for (const k of ['label', 'placeholder', 'text', 'testId', 'css'] as const) if (t[k]) return `${k}:${t[k]}`;
  return '?';
}

function seedOf(p: string): number {
  let n = 0;
  for (const ch of p) n = (n * 31 + ch.charCodeAt(0)) % 17;
  return n + 1;
}

export function fakeBrowser(app: Record<string, FakeScreen>, opts: { fail?: Error; launchMs?: number; pageMs?: number } = {}): FakeBrowser {
  const fake: FakeBrowser = {
    launches: 0,
    open: 0,
    log: [],
    sizes: [],
    module: {
      name: 'fake',
      label: 'Fake browser',
      async launch() {
        if (opts.launchMs) await new Promise((r) => setTimeout(r, opts.launchMs));
        if (opts.fail) throw opts.fail;
        fake.launches += 1;
        fake.open += 1;
        return browser();
      },
    },
  };
  const browser = (): Browser => ({
    async page(o) {
      if (opts.pageMs) await new Promise((r) => setTimeout(r, opts.pageMs));
      fake.sizes.push({ width: o.width, height: o.height });
      let at = 'about:blank';
      const screen = () => app[new URL(at).pathname];
      const page: BrowserPage = {
        async goto(url) {
          const u = new URL(url);
          if (u.origin !== o.origin) throw new StepFailure('blocked', `The page tried to open ${url}`, url);
          fake.log.push(`goto ${u.pathname}${u.search}`);
          const s = app[u.pathname];
          at = s?.redirect ? new URL(s.redirect, o.origin).href : u.href;
          return s ? (s.status ?? 200) : 404;
        },
        async act(step: BrowserStep) {
          const key = step.target ? targetKey(step.target) : '';
          fake.log.push(`${step.action}${key ? ` ${key}` : ''}`);
          if (step.action === 'wait' && !step.target) return;
          if (step.target && !screen()?.has?.includes(key)) throw new StepFailure('missing', `Nothing matches ${key}`);
          const next = step.action === 'click' ? screen()?.opens?.[key] : undefined;
          if (next) at = new URL(next, o.origin).href;
        },
        async settle() {},
        async snapshot() {
          return screen()?.snapshot ?? `- main:\n${(screen()?.has ?? []).map((h) => `  - ${h}`).join('\n')}`;
        },
        url: () => at,
        async screenshot() {
          const p = new URL(at).pathname;
          const made = screen()?.picture ? screen()!.picture!({ width: o.width, height: o.height }) : pngBytes(o.width, o.height, undefined, seedOf(p));
          return made === null ? Buffer.alloc(0) : Buffer.from(made);
        },
        async close() {},
      };
      return page;
    },
    async close() {
      fake.open -= 1;
    },
  });
  return fake;
}
