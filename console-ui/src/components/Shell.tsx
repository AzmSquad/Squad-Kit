import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Bug, ChevronsUpDown, Inbox, LayoutGrid, ListTodo, Menu, MessagesSquare, Moon, Network, Settings, Sun, Terminal, Users } from 'lucide-react';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { UpdateBanner } from './Restart';
import { AppUpdate } from './Update';
import { ProjectWaiting } from './Waiting';
import { needsYou } from '../lib/waiting';
import { ChatDock, useChats, useDocked } from './ChatDock';
import { LimitBanner } from './UsageLimit';
import { Apps } from './Apps';

const NAV = [
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
  const waiting = tickets.filter(needsYou).length;
  const bugs = tickets.filter((t) => t.kind === 'bug').length;
  const initials = (meta?.user.name ?? 'You').slice(0, 2).toUpperCase();
  const chats = useChats().data?.filter((c) => c.open).length ?? 0;
  const docked = useDocked();
  // On a phone the sidebar folds away behind a menu button, and closes again when you go to another page.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);

  // The Conversations page is full screen: the list, the chat and the spec need the whole width.
  if (path.startsWith('/conversations'))
    return (
      <div className="fullpage">
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
        <AppUpdate />
        <LimitBanner />
        {board.data?.ready && board.data.console?.outdated && <UpdateBanner />}
        <ProjectWaiting />
        {/* The page under the banner: a ticket drawer covers the page, never the banner. */}
        <div className="canvas-b">
          <Outlet />
        </div>
      </main>
      <ChatDock />
    </div>
  );
}
