import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { PROJECT, api } from '../api/client';
import type { AppProjects, AppWaiting, Ticket } from '../api/types';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import {
  BannerOrder,
  NoticeWatch,
  changeWaits,
  claimNotice,
  itemHref,
  needsYou,
  noticeText,
  noticesOf,
  openChange,
  tabTitle,
  testChangeLine,
  testChangeWaits,
  waitedFor,
  waitingSince,
  type Notice,
} from '../lib/waiting';
import { ASKING, HOW_TO_ALLOW, afterAsking, askPermission, type Asked } from '../lib/notices';
import { Cmd, STAGE_NAME, Written, actionLabel, outdatedLine } from './ui';
import { dropWish, readWishes, readyText, readyToTell } from '../lib/overview';
import { BreakdownBannerItem, WaitStopTag, useAllBreakdownWaits, useBreakdownWaits, type BreakdownWait } from './BreakdownWaits';
import { stopKind } from '../lib/auto';
import { langProps } from '../lib/lang';

/**
 * Waiting for you, loud. A banner at the top of every page while something needs the person, the count in the browser
 * tab, and a desktop notice for each new item, asked for once inside the page. A project's pages show that project's
 * items; Home shows every project's. Terminal: `squad inbox`.
 */

interface Item {
  key: string;
  since: string;
  ticket: Ticket;
  /** Set on Home, where the items come from every project. */
  project?: { id: string; name: string };
}

/** The app's Waiting for you list, every project. Home shows the same list, so the two share one poll. */
function useAppWaiting() {
  return useQuery({ queryKey: ['app', 'waiting'], queryFn: () => api<AppWaiting>('/api/v1/app/waiting'), refetchInterval: 2000 });
}

/**
 * A project's pages: its own items in the banner and the tab title, and desktop notices from every project. The full
 * list page needs no banner over it.
 */
export function ProjectWaiting() {
  const board = useBoard();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const data = board.data?.ready ? board.data : null;
  const items = useMemo<Item[]>(() => (data?.tickets ?? []).filter(needsYou).map((t) => ({ key: t.id, since: waitingSince(t), ticket: t })), [data]);
  // A breakdown whose Analyst has questions waits for you too (components/BreakdownWaits).
  const breakdowns = useBreakdownWaits();
  useTabTitle(data?.meta.project, items.length + breakdowns.length);
  useDesktopNotices();
  if (path.startsWith('/inbox')) return null;
  return <WaitingBanner items={items} breakdowns={breakdowns} />;
}

/** Home: every project's items. "and N more" goes to the list on the same page. */
export function HomeWaiting() {
  const waiting = useAppWaiting();
  const items = useMemo<Item[]>(
    () => (waiting.data?.items ?? []).map(({ project, ticket }) => ({ key: `${project.id}/${ticket.id}`, since: waitingSince(ticket), ticket, project })),
    [waiting.data],
  );
  // Breakdowns whose Analyst has questions, from every project (components/BreakdownWaits).
  const breakdowns = useAllBreakdownWaits();
  useTabTitle('squad-kit', items.length + breakdowns.length);
  useDesktopNotices();
  return <WaitingBanner items={items} breakdowns={breakdowns} home />;
}

function useTabTitle(name: string | undefined, count: number) {
  useEffect(() => {
    if (name) document.title = tabTitle(name, count);
  }, [name, count]);
}

/** Minutes move on even when the board does not, so "waiting 3 min" stays true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The first one or two items with their action, and "and N more". One row, whatever the count, so the page under it
 * never jumps while items come and go.
 */
function WaitingBanner({ items, home, breakdowns = [] }: { items: Item[]; home?: boolean; breakdowns?: BreakdownWait[] }) {
  const [order] = useState(() => new BannerOrder());
  const now = useNow(30_000);
  const sorted = useMemo(() => order.sort(items), [order, items]);
  const total = sorted.length + breakdowns.length;
  if (!total) return null;
  const shown = sorted.slice(0, 2);
  const shownBrds = breakdowns.slice(0, 2 - shown.length);
  const rest = total - shown.length - shownBrds.length;
  const count = total === 1 ? '1 thing needs you' : `${total} things need you`;
  // Beside the items; on a phone, where the items scroll sideways, in the top line.
  const more = (where: string) =>
    rest > 0 &&
    (home ? (
      <button className={`ymore ${where}`} onClick={() => document.getElementById('waiting')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        and {rest} more
      </button>
    ) : (
      <Link to="/inbox" className={`ymore ${where}`}>
        and {rest} more
      </Link>
    ));
  // One slim row: the count, the first two items with their buttons, and the rest behind a link. Calm, so it never
  // takes the page's height; the Waiting for you page has the full list.
  return (
    <section className="ybar" aria-label="Waiting for you">
      <span className="ybar-n" aria-hidden>
        {total}
      </span>
      <b className="ybar-t" aria-live="polite" title={home ? 'The squads keep working on everything else meanwhile.' : 'The squad keeps working on everything else meanwhile.'}>
        {count}
      </b>
      <div className="ybar-items">
        {shown.map((it) => (
          <BannerItem key={it.key} it={it} now={now} />
        ))}
        {shownBrds.map((w) => (
          <BreakdownBannerItem key={`${w.project?.id ?? ''}/${w.id}`} w={w} />
        ))}
      </div>
      {more('ymore-row')}
      <NoticeAsk />
    </section>
  );
}

function BannerItem({ it, now }: { it: Item; now: number }) {
  const t = it.ticket;
  const change = changeWaits(t) ? openChange(t) : undefined;
  const line =
    t.waiting?.summary ??
    (change ? `Change ${change.id} to the spec waits for you` : testChangeWaits(t) ? testChangeLine(t) : t.outdated?.length ? outdatedLine(t) : `Looks stuck: ${t.quiet?.detail ?? 'no progress'}`);
  const label = t.waiting ? actionLabel(t) : change ? 'Check the change' : 'Check it';
  // An agent's question says itself; anything else names the ticket.
  const detail = t.waiting?.kind === 'ask' && t.agentQuestion ? `“${t.agentQuestion.text}”` : t.title;
  const meta = [it.project?.name, t.id, STAGE_NAME[t.stage], waitedFor(it.since, now)].filter(Boolean).join(' · ');
  return (
    <div className="yitem" title={`${meta}\n${line}\n${detail}`}>
      <span className="yid">{it.project ? `${it.project.name} · ${t.id}` : t.id}</span>
      {/* A story that builds by itself says which stop it is at, with its title. */}
      {stopKind(t) ? <span className="yline" {...langProps(t.title)}><WaitStopTag t={t} /><Written text={t.title} /></span> : <Written className="yline" text={line} />}
      {it.project ? (
        <a className="btn sm you" href={itemHref(it.project.id, t)}>
          {label}
        </a>
      ) : t.waiting?.kind === 'proof' ? (
        <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn sm you">
          {label}
        </Link>
      ) : (
        <Link to="/board" search={{ ticket: t.id }} className="btn sm you">
          {label}
        </Link>
      )}
    </div>
  );
}

/* ── Desktop notices ───────────────────────────────────── */

const CHOICE = 'sk.notices';
type Choice = 'on' | 'off' | null;
/** `none`: this browser has no notices; `insecure`: it shows them only on a secure page. */
type Permission = NotificationPermission | 'none' | 'insecure';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readChoice(): Choice {
  const v = storage()?.getItem(CHOICE);
  return v === 'on' || v === 'off' ? v : null;
}

function readPermission(): Permission {
  if (typeof Notification === 'undefined') return window.isSecureContext === false ? 'insecure' : 'none';
  if (window.isSecureContext === false) return 'insecure';
  return Notification.permission;
}

/** The browser is asking the person right now (after Turn on), so both places say where to look. */
let asking = false;
function setAsking(on: boolean) {
  asking = on;
  emit();
}

// One small store, so the banner's question and Settings agree, and a change in another tab or in the browser's own
// site settings shows here too.
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener('storage', l);
  window.addEventListener('focus', l);
  document.addEventListener('visibilitychange', l);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', l);
    window.removeEventListener('focus', l);
    document.removeEventListener('visibilitychange', l);
  };
}
const snapshot = () => `${readChoice() ?? ''}|${readPermission()}|${asking ? 'asking' : ''}`;

function saveChoice(c: 'on' | 'off') {
  try {
    storage()?.setItem(CHOICE, c);
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit only.
  }
  emit();
}

/** One notice at once, so the person sees it working. */
function testNotice() {
  try {
    new Notification('Desktop notices are on', { body: 'squad-kit shows one like this for each new thing that needs you.', tag: 'sk-notices-on', silent: true });
  } catch {
    // A browser that shows notices only from a service worker: the toast says what to check.
  }
}

/** The person's choice for this browser, and what the browser itself allows. */
export function useNotices() {
  const { toast } = usePrefs();
  const [choiceText, permission, askingText] = useSyncExternalStore(subscribe, snapshot).split('|') as [string, Permission, string];
  const choice = (choiceText || null) as Choice;
  const turnOn = async () => {
    if (asking) return;
    // The browser asks only now, after the person pressed Turn on: never when a page loads. It always ends in an
    // answer the person sees, even when the browser never answers (src/lib/notices.ts).
    setAsking(true);
    let got: Asked = 'error';
    try {
      got = await askPermission(typeof Notification === 'undefined' ? undefined : Notification, { secure: window.isSecureContext !== false });
    } finally {
      setAsking(false);
    }
    const r = afterAsking(got);
    if (r.choice) saveChoice(r.choice);
    if (r.test) testNotice();
    toast(r.say, r.bad ? 'err' : undefined);
  };
  return {
    choice,
    permission,
    asking: askingText === 'asking',
    on: choice === 'on' && permission === 'granted',
    /** Asked once: not after an answer, and not when the browser already said no or has no notices. */
    canAsk: choice === null && (permission === 'default' || permission === 'granted'),
    turnOn,
    turnOff: () => {
      saveChoice('off');
      toast('Desktop notices are off');
    },
    notNow: () => {
      saveChoice('off');
      toast('No desktop notices. Turn them on in Settings any time.');
    },
  };
}

/** The question in the banner, the first time something needs the person. */
function NoticeAsk() {
  const n = useNotices();
  if (!n.canAsk && !n.asking) return null;
  return (
    <div className="ybar-ask" aria-live="polite" title={n.asking ? ASKING : 'Get a desktop notice when the squad needs you'}>
      <BellRing size={14} />
      <button className="linkbtn" disabled={n.asking} onClick={() => void n.turnOn()}>
        {n.asking ? 'Waiting for your browser…' : 'Desktop notices'}
      </button>
      {!n.asking && (
        <button className="linkbtn quiet" onClick={n.notNow} aria-label="No desktop notices">
          Not now
        </button>
      )}
    </div>
  );
}

/** Settings: desktop notices on or off, for this browser. */
export function NoticeSetting() {
  const n = useNotices();
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Desktop notices</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {n.permission === 'none' ? (
          <span className="note">This browser can't show desktop notices. The banner and the tab title still show what needs you.</span>
        ) : n.permission === 'insecure' ? (
          <span className="note">Your browser shows desktop notices only on a secure page. Open the board on this computer, at its 127.0.0.1 or localhost address, to turn them on.</span>
        ) : n.permission === 'denied' ? (
          <>
            <span className="pill you">Blocked by your browser</span>
            <span className="note">{HOW_TO_ALLOW}</span>
          </>
        ) : (
          <>
            <button className="btn sm" disabled={n.asking} onClick={() => (n.on ? n.turnOff() : void n.turnOn())}>
              {n.asking ? 'Waiting for your browser…' : n.on ? 'On: turn them off' : 'Off: turn them on'}
            </button>
            <span className="note" aria-live="polite">
              {n.asking
                ? ASKING
                : n.choice === 'on' && n.permission === 'default'
                  ? `You turned them on, but your browser has not allowed them yet. ${HOW_TO_ALLOW}`
                  : 'A notice for each new question, approval, proof and failure, in this browser. No sounds.'}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

// One memory per page load: what was already waiting when the page opened never gets a notice.
const watch = new NoticeWatch();

/** A desktop notice for each new item in any project, when the person turned them on. Clicking one opens the item. */
function useDesktopNotices() {
  useSetupNotices();
  const waiting = useAppWaiting();
  const navigate = useNavigate();
  const data = waiting.data;
  useEffect(() => {
    if (!data) return;
    const fresh = watch.next(noticesOf(data.items), Date.now());
    if (!fresh.length || readChoice() !== 'on' || readPermission() !== 'granted') return;
    const open = (n: Notice) => {
      if (n.project.id !== PROJECT) return window.location.assign(itemHref(n.project.id, n.ticket));
      if (n.ticket.waiting?.kind === 'proof') return void navigate({ to: '/tickets/$id/proof', params: { id: n.ticket.id } });
      void navigate({ to: '/board', search: { ticket: n.ticket.id } });
    };
    for (const n of fresh) if (claimNotice(n.key, Date.now(), storage())) show(n, open);
  }, [data, navigate]);
}

function show(n: Notice, open: (n: Notice) => void) {
  const { title, body } = noticeText(n);
  showNotice(title, body, n.key, () => open(n));
}

function showNotice(title: string, body: string, tag: string, open: () => void) {
  try {
    const note = new Notification(title, { body, tag, silent: true });
    note.onclick = () => {
      window.focus();
      note.close();
      open();
    };
  } catch {
    // A browser that shows notices only from a service worker: the banner and the tab title still say it.
  }
}

/**
 * "Notify me when it is ready" on the setup page: one desktop notice when that project's overview is ready, from any
 * page of the app, so the person can leave the setup page. Clicking it opens the Overview.
 */
function useSetupNotices() {
  const wished = readWishes(storage()).length > 0;
  const projects = useQuery({ queryKey: ['app', 'projects'], queryFn: () => api<AppProjects>('/api/v1/app/projects'), refetchInterval: 2000, enabled: wished });
  const data = projects.data;
  useEffect(() => {
    if (!data) return;
    const store = storage();
    for (const p of readyToTell(data.projects, readWishes(store))) {
      dropWish(store, p.id);
      if (readChoice() !== 'on' || readPermission() !== 'granted' || !claimNotice(`setup/${p.id}`, Date.now(), store)) continue;
      const { title, body } = readyText(p.name);
      showNotice(title, body, `setup/${p.id}`, () => window.location.assign(`/p/${encodeURIComponent(p.id)}/overview`));
    }
  }, [data]);
}
