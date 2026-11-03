import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { PROJECT, api } from '../api/client';
import type { AppWaiting, Ticket } from '../api/types';
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
  waitedFor,
  waitingSince,
  type Notice,
} from '../lib/waiting';
import { Cmd, STAGE_NAME, actionLabel, outdatedLine } from './ui';

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
  useTabTitle(data?.meta.project, items.length);
  useDesktopNotices();
  if (path.startsWith('/inbox')) return null;
  return <WaitingBanner items={items} />;
}

/** Home: every project's items. "and N more" goes to the list on the same page. */
export function HomeWaiting() {
  const waiting = useAppWaiting();
  const items = useMemo<Item[]>(
    () => (waiting.data?.items ?? []).map(({ project, ticket }) => ({ key: `${project.id}/${ticket.id}`, since: waitingSince(ticket), ticket, project })),
    [waiting.data],
  );
  useTabTitle('squad-kit', items.length);
  useDesktopNotices();
  return <WaitingBanner items={items} home />;
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
function WaitingBanner({ items, home }: { items: Item[]; home?: boolean }) {
  const [order] = useState(() => new BannerOrder());
  const now = useNow(30_000);
  const sorted = useMemo(() => order.sort(items), [order, items]);
  if (!sorted.length) return null;
  const shown = sorted.slice(0, 2);
  const rest = sorted.length - shown.length;
  const count = sorted.length === 1 ? '1 thing needs you' : `${sorted.length} things need you`;
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
  return (
    <section className="ybar" aria-label="Waiting for you">
      <div className="ybar-h">
        <span className="ybar-n" aria-hidden>
          {sorted.length}
        </span>
        <b className="ybar-t" aria-live="polite">{count}</b>
        <span className="sub">{home ? 'The squads keep working on everything else meanwhile.' : 'The squad keeps working on everything else meanwhile.'}</span>
        <span className="grow" />
        {more('ymore-up')}
        <Cmd text="squad inbox" />
      </div>
      <div className={`ybar-items ${shown.length > 1 ? 'n2' : ''} ${rest ? 'more' : ''}`}>
        {shown.map((it) => (
          <BannerItem key={it.key} it={it} now={now} />
        ))}
        {more('ymore-row')}
      </div>
      <NoticeAsk />
    </section>
  );
}

function BannerItem({ it, now }: { it: Item; now: number }) {
  const t = it.ticket;
  const change = changeWaits(t) ? openChange(t) : undefined;
  const line = t.waiting?.summary ?? (change ? `Change ${change.id} to the spec waits for you` : t.outdated?.length ? outdatedLine(t) : `Looks stuck: ${t.quiet?.detail ?? 'no progress'}`);
  const label = t.waiting ? actionLabel(t) : change ? 'Check the change' : 'Check it';
  // An agent's question says itself; anything else names the ticket.
  const detail = t.waiting?.kind === 'ask' && t.agentQuestion ? `“${t.agentQuestion.text}”` : t.title;
  const meta = [it.project?.name, t.id, STAGE_NAME[t.stage], waitedFor(it.since, now)].filter(Boolean).join(' · ');
  return (
    <div className="yitem">
      <div className="grow">
        <div className="meta">{meta}</div>
        <h3 title={line}>{line}</h3>
        <p title={detail}>{detail}</p>
      </div>
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
type Permission = NotificationPermission | 'none';

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
  return typeof Notification === 'undefined' ? 'none' : Notification.permission;
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
const snapshot = () => `${readChoice() ?? ''}|${readPermission()}`;

function saveChoice(c: 'on' | 'off') {
  try {
    storage()?.setItem(CHOICE, c);
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit only.
  }
  emit();
}

/** Older browsers answer the permission question through a callback, newer ones through a promise. */
function askBrowser(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    try {
      const p = Notification.requestPermission(resolve);
      if (p) void p.then(resolve, () => resolve(Notification.permission));
    } catch {
      resolve(Notification.permission);
    }
  });
}

const BLOCKED = 'Your browser blocks notices from this page. To allow them, click the icon left of the address, allow notifications, then reload the page.';

/** The person's choice for this browser, and what the browser itself allows. */
export function useNotices() {
  const { toast } = usePrefs();
  const [choiceText, permission] = useSyncExternalStore(subscribe, snapshot).split('|') as [string, Permission];
  const choice = (choiceText || null) as Choice;
  const turnOn = async () => {
    if (readPermission() === 'none') return toast("This browser can't show desktop notices.", 'err');
    // The browser asks only now, after the person pressed Turn on: never when a page loads.
    const got = Notification.permission === 'default' ? await askBrowser() : Notification.permission;
    if (got === 'granted') {
      saveChoice('on');
      toast('Desktop notices are on. One for each new thing that needs you.');
    } else if (got === 'denied') {
      // They wanted them: once the browser allows it, notices start without asking again.
      saveChoice('on');
      toast(BLOCKED, 'err');
    } else {
      saveChoice('off');
      toast('No desktop notices for now. Turn them on in Settings any time.');
    }
  };
  return {
    choice,
    permission,
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
  if (!n.canAsk) return null;
  return (
    <div className="ybar-ask">
      <BellRing size={15} />
      <span>Get a desktop notice when the squad needs you?</span>
      <button className="btn sm" onClick={() => void n.turnOn()}>
        Turn on
      </button>
      <button className="btn sm quiet" onClick={n.notNow}>
        Not now
      </button>
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
        ) : n.permission === 'denied' ? (
          <>
            <span className="pill you">Blocked by your browser</span>
            <span className="note">To allow them, click the icon left of the address, allow notifications, then reload this page.</span>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => (n.on ? n.turnOff() : void n.turnOn())}>
              {n.on ? 'On: turn them off' : 'Off: turn them on'}
            </button>
            <span className="note">A notice for each new question, approval, proof and failure, in this browser. No sounds.</span>
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
  try {
    const note = new Notification(title, { body, tag: n.key, silent: true });
    note.onclick = () => {
      window.focus();
      note.close();
      open(n);
    };
  } catch {
    // A browser that shows notices only from a service worker: the banner and the tab title still say it.
  }
}
