import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Bug, ChevronsUpDown, Compass, GitPullRequestArrow, Inbox, LayoutGrid, ListTodo, ListTree, Menu, MessagesSquare, Moon, Network, Settings, ShieldCheck, Sun, Terminal, Wrench } from 'lucide-react';
import { Written } from './ui';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { UpdateBanner } from './Restart';
import { AppUpdate } from './Update';
import { FirstWin } from './FirstStory';
import { ProjectWaiting } from './Waiting';
import { useWaitingCount } from '../lib/waiting-count';
import { ChatPopups } from './popups/ChatPopups';
import { useChats } from '../lib/chats';
import { LimitBanner } from './UsageLimit';
import { SaveTroubleBanner } from './SaveTrouble';
import { BudgetBanner } from './Usage';
import { Apps } from './Apps';
import { Banners } from './Banners';
import { useOverviewWaits } from './Setup';
import { useBreakdowns } from '../lib/requirementsData';
import { requirementsWaiting } from '../lib/requirements';
import { useTools } from '../pages/Tools';
import { LeadMark } from './LeadMark';
import { useLead } from '../lib/leadData';
import { JourneyBar } from './Journey';

const NAV = [
  { to: '/overview', label: 'Overview', icon: Compass, badge: 'setup' as const },
  // squad-kit's own code only: the contribution assistant, reachable after its setup too.
  { to: '/contribute', label: 'Contribute', icon: GitPullRequestArrow, badge: 'self' as const },
  { to: '/requirements', label: 'Requirements', icon: ListTree, badge: 'reqs' as const },
  { to: '/board', label: 'Board', icon: LayoutGrid },
  { to: '/backlog', label: 'Backlog', icon: ListTodo },
  { to: '/inbox', label: 'Waiting for you', icon: Inbox, badge: 'you' as const },
  { to: '/lead', label: 'Squad lead', icon: LeadMark, badge: 'lead' as const },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare, badge: 'chats' as const },
  { to: '/releases', label: 'Releases', icon: ArrowUp },
  { to: '/architecture', label: 'Architecture', icon: Network },
  { to: '/bugs', label: 'Bugs', icon: Bug, badge: 'bugs' as const },
  { to: '/harness', label: 'Harness', icon: ShieldCheck },
  { to: '/tools', label: 'Tools', icon: Wrench, badge: 'tools' as const },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Shell() {
  const board = useBoard();
  const { theme, toggleTheme, showCommands, toggleCommands } = usePrefs();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The story open in the drawer, or on its proof page: the contribution bar follows it.
  const open = useRouterState({ select: (s) => (s.location.search as { ticket?: string }).ticket ?? /\/tickets\/([^/]+)\/proof/.exec(s.location.pathname)?.[1] });
  const meta = board.data?.ready ? board.data.meta : undefined;
  const tickets = board.data?.ready ? board.data.tickets : [];
  const openCount = tickets.filter((t) => !t.mergedAt && t.stage !== 'done' && !t.archived).length;
  // The one number of what needs you, the same in the top bar and on the lead's head (lib/waiting-count).
  const waiting = useWaitingCount();
  const bugs = tickets.filter((t) => t.kind === 'bug').length;
  const initials = (meta?.user.name ?? 'You').slice(0, 2).toUpperCase();
  const chats = useChats().data?.filter((c) => c.open).length ?? 0;
  const setupWaits = useOverviewWaits();
  // Required tools not on this computer yet (or too old): the Tools item counts them.
  const toolsData = useTools(60_000).data;
  const toolsMissing = toolsData?.lines.filter((l) => l.priority === 'required' && l.state !== 'ready' && l.state !== 'not-here').length ?? 0;
  // Requirements: questions from the Analyst and stories that need the person. "New" until then, in 1.2.
  const breakdowns = useBreakdowns(5000);
  const reqs = requirementsWaiting(breakdowns.data?.breakdowns ?? [], meta?.user.name);
  // The Squad lead's dot: it is answering a question now, maybe one asked from another page.
  const answering = useLead(5000).data?.conversations.some((c) => c.thinking) ?? false;
  // On a phone the sidebar folds away behind a menu button, and closes again when you go to another page.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  // The Conversations page is full screen: the list, the chat and the spec need the whole width. So is the setup,
  // which has no chats yet.
  if (path.startsWith('/conversations') || path.startsWith('/setup'))
    return (
      <div className="fullpage">
        <SaveTroubleBanner />
        <LimitBanner />
        <ProjectWaiting />
        <div className="canvas-b">
          <Outlet />
        </div>
        {!path.startsWith('/setup') && <ChatPopups />}
      </div>
    );

  return (
    <div className="app">
      <header className="mtop">
        <button className="iconbtn" onClick={() => setMenu(true)} aria-label="Open the menu" aria-expanded={menu}>
          <Menu size={17} />
        </button>
        <Written as="b" text={meta?.project ?? 'Your project'} />
        {waiting > 0 && (
          <Link to="/inbox" className="badge you" aria-label={`${waiting} waiting for you`}>
            {waiting}
          </Link>
        )}
      </header>
      {menu && <div className="side-veil" onClick={() => setMenu(false)} />}
      <aside className={`side ${menu ? 'open' : ''}`}>
        {/* Home and the other projects are other pages of the app, outside this project's board. */}
        <a className="brand" href="/" title="All your projects">
          <img src="/logo.svg" alt="" />
          <b>squad-kit</b>
          {meta?.engine === 'demo' && <small title="The squad plays back a recorded run">Demo</small>}
        </a>
        <a className="proj" href="/" title="All your projects">
          <span className="pm">{(meta?.project ?? 'P').charAt(0)}</span>
          <div>
            <Written as="b" text={meta?.project ?? 'Your project'} />
            <span>{openCount === 1 ? '1 open ticket' : `${openCount} open tickets`}</span>
          </div>
          <ChevronsUpDown size={14} className="sw" />
        </a>
        {NAV.map((n) => {
          const count = n.badge === 'you' ? waiting : n.badge === 'bugs' ? bugs : n.badge === 'chats' ? chats : n.badge === 'tools' ? toolsMissing : 0;
          // The overview waits for the person to check it: marked like anything else that waits for them.
          if (n.badge === 'setup')
            return (
              <Link key={n.to} to={n.to} className={`nav ${path.startsWith(n.to) ? 'on' : ''}`} onClick={() => setMenu(false)}>
                <n.icon size={16} />
                {n.label}
                {setupWaits && <span className="badge you" aria-label="Waits for you">1</span>}
              </Link>
            );
          if (n.badge === 'self' && !(board.data?.ready && board.data.self)) return null;
          if (n.badge === 'reqs')
            return (
              <Link key={n.to} to={n.to} className={`nav ${path.startsWith(n.to) ? 'on' : ''}`} onClick={() => setMenu(false)}>
                <n.icon size={16} />
                {n.label}
                {reqs > 0 ? <span className="badge you" aria-label={`${reqs} ${reqs === 1 ? 'needs' : 'need'} you`}>{reqs}</span> : <span className="badge new">New</span>}
              </Link>
            );
          const on = path.startsWith(n.to) || (n.to === '/inbox' && path.endsWith('/proof')) || (n.to === '/tools' && path.startsWith('/connections'));
          if (n.badge === 'lead')
            return (
              <Link key={n.to} to={n.to} className={`nav navlead ${on ? 'on' : ''}`} onClick={() => setMenu(false)} title="Ask from any page with ⌘K or Ctrl+K">
                <n.icon size={16} />
                {n.label}
                {answering && <span className="leaddot" aria-label="The lead is answering" />}
              </Link>
            );
          return (
            <Link key={n.to} to={n.to} className={`nav ${on ? 'on' : ''}`} onClick={() => setMenu(false)}>
              <n.icon size={16} />
              {n.label}
              {count > 0 && <span className={`badge ${n.badge === 'you' ? 'you' : n.badge === 'chats' ? 'talk' : ''}`}>{count}</span>}
            </Link>
          );
        })}
        <div className="grow" />
        <Apps />
        <div className="engines">
          {(meta?.tools ?? []).map((t) => (
            <div className="row" key={t.name}>
              <span>{t.name}</span>
              <span className={`dot ${t.ready ? '' : 'off'}`}>{t.ready ? 'Ready' : 'Not installed'}</span>
            </div>
          ))}
        </div>
        <button className="switch" onClick={toggleCommands} aria-pressed={showCommands}>
          <span>
            <Terminal size={15} />
            Show commands
          </span>
          <span className={`tog ${showCommands ? 'on' : ''}`} />
        </button>
        <div className="me">
          <span className="av">{initials}</span>
          <div>
            {meta?.user.name ?? 'You'}
            <small>{meta?.user.role ?? ''}</small>
          </div>
          <button className="theme" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
            {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </div>
      </aside>
      <main className="canvas">
        <JourneyBar {...(open ? { ticket: decodeURIComponent(open) } : {})} />
        <Banners>
          <SaveTroubleBanner />
          <AppUpdate />
          <LimitBanner />
          {board.data?.ready && <BudgetBanner />}
          {board.data?.ready && board.data.console?.outdated && <UpdateBanner />}
          <ProjectWaiting />
        </Banners>
        {/* The page under the banner: a ticket drawer covers the page, never the banner. */}
        <div className="canvas-b">
          <Outlet />
        </div>
      </main>
      <FirstWin />
      <ChatPopups />
    </div>
  );
}
