import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Bug, ChevronsUpDown, Compass, Inbox, LayoutGrid, ListTodo, ListTree, Menu, MessagesSquare, Moon, Network, Settings, Sun, Terminal, Users } from 'lucide-react';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { UpdateBanner } from './Restart';
import { AppUpdate } from './Update';
import { ProjectWaiting } from './Waiting';
import { needsYou } from '../lib/waiting';
import { ChatDock, useChats, useDocked } from './ChatDock';
import { LimitBanner } from './UsageLimit';
import { SaveTroubleBanner } from './SaveTrouble';
import { BudgetBanner } from './Usage';
import { Apps } from './Apps';
import { Banners } from './Banners';
import { useOverviewWaits } from './Setup';
import { useBreakdowns } from '../lib/requirementsData';
import { requirementsWaiting } from '../lib/requirements';
import { useBreakdownWaits } from './BreakdownWaits';

const NAV = [
  { to: '/overview', label: 'Overview', icon: Compass, badge: 'setup' as const },
  { to: '/requirements', label: 'Requirements', icon: ListTree, badge: 'reqs' as const },
  { to: '/board', label: 'Board', icon: LayoutGrid },
  { to: '/backlog', label: 'Backlog', icon: ListTodo },
  { to: '/inbox', label: 'Waiting for you', icon: Inbox, badge: 'you' as const },
  { to: '/conversations', label: 'Conversations', icon: MessagesSquare, badge: 'chats' as const },
  { to: '/releases', label: 'Releases', icon: ArrowUp },
  { to: '/architecture', label: 'Architecture', icon: Network },
  { to: '/bugs', label: 'Bugs', icon: Bug, badge: 'bugs' as const },
  { to: '/squad', label: 'Squad and AI', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Shell() {
  const board = useBoard();
  const { theme, toggleTheme, showCommands, toggleCommands } = usePrefs();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const meta = board.data?.ready ? board.data.meta : undefined;
  const tickets = board.data?.ready ? board.data.tickets : [];
  // A breakdown whose Analyst has questions counts as one thing that waits for you.
  const breakdownWaits = useBreakdownWaits().length;
  const waiting = tickets.filter(needsYou).length + breakdownWaits;
  const bugs = tickets.filter((t) => t.kind === 'bug').length;
  const initials = (meta?.user.name ?? 'You').slice(0, 2).toUpperCase();
  const chats = useChats().data?.filter((c) => c.open).length ?? 0;
  const docked = useDocked();
  const setupWaits = useOverviewWaits();
  // Requirements: questions from the Analyst and stories that need the person. "New" until then, in 1.2.
  const breakdowns = useBreakdowns(5000);
  const reqs = requirementsWaiting(breakdowns.data?.breakdowns ?? [], meta?.user.name);
  // On a phone the sidebar folds away behind a menu button, and closes again when you go to another page.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  // The Conversations page is full screen: the list, the chat and the spec need the whole width. So is the setup.
  if (path.startsWith('/conversations') || path.startsWith('/setup'))
    return (
      <div className="fullpage">
        <SaveTroubleBanner />
        <LimitBanner />
        <ProjectWaiting />
        <div className="canvas-b">
          <Outlet />
        </div>
      </div>
    );

  return (
    <div className={`app ${docked ? 'docked' : ''}`}>
      <header className="mtop">
        <button className="iconbtn" onClick={() => setMenu(true)} aria-label="Open the menu" aria-expanded={menu}>
          <Menu size={17} />
        </button>
        <b>{meta?.project ?? 'Your project'}</b>
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
            <b>{meta?.project ?? 'Your project'}</b>
            <span>{tickets.length} open tickets</span>
          </div>
          <ChevronsUpDown size={14} className="sw" />
        </a>
        {NAV.map((n) => {
          const count = n.badge === 'you' ? waiting : n.badge === 'bugs' ? bugs : n.badge === 'chats' ? chats : 0;
          // The overview waits for the person to check it: marked like anything else that waits for them.
          if (n.badge === 'setup')
            return (
              <Link key={n.to} to={n.to} className={`nav ${path.startsWith(n.to) ? 'on' : ''}`} onClick={() => setMenu(false)}>
                <n.icon size={16} />
                {n.label}
                {setupWaits && <span className="badge you" aria-label="Waits for you">1</span>}
              </Link>
            );
          if (n.badge === 'reqs')
            return (
              <Link key={n.to} to={n.to} className={`nav ${path.startsWith(n.to) ? 'on' : ''}`} onClick={() => setMenu(false)}>
                <n.icon size={16} />
                {n.label}
                {reqs > 0 ? <span className="badge you" aria-label={`${reqs} ${reqs === 1 ? 'needs' : 'need'} you`}>{reqs}</span> : <span className="badge new">New</span>}
              </Link>
            );
          const on = path.startsWith(n.to) || (n.to === '/inbox' && path.endsWith('/proof'));
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
      <ChatDock />
    </div>
  );
}
