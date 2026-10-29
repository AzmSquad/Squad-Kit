import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ArrowUp, Bug, Hexagon, Inbox, LayoutGrid, Moon, Settings, Sun, Terminal, Users } from 'lucide-react';
import { useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';

const NAV = [
  { to: '/board', label: 'Board', icon: LayoutGrid },
  { to: '/inbox', label: 'Waiting for you', icon: Inbox, badge: 'you' as const },
  { to: '/releases', label: 'Releases', icon: ArrowUp },
  { to: '/decisions', label: 'Decisions', icon: Hexagon },
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
  const waiting = tickets.filter((t) => t.waiting).length;
  const bugs = tickets.filter((t) => t.kind === 'bug').length;
  const initials = (meta?.user.name ?? 'You').slice(0, 2).toUpperCase();

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <img src="/logo.svg" alt="" />
          <b>squad-kit</b>
          {meta?.engine === 'demo' && <small title="The squad plays back a recorded run">Demo</small>}
        </div>
        <div className="proj">
          <span className="pm">{(meta?.project ?? 'P').charAt(0)}</span>
          <div>
            <b>{meta?.project ?? 'Your project'}</b>
            <span>{tickets.length} open tickets</span>
          </div>
        </div>
        {NAV.map((n) => {
          const count = n.badge === 'you' ? waiting : n.badge === 'bugs' ? bugs : 0;
          const on = path.startsWith(n.to) || (n.to === '/inbox' && path.endsWith('/proof'));
          return (
            <Link key={n.to} to={n.to} className={`nav ${on ? 'on' : ''}`}>
              <n.icon size={16} />
              {n.label}
              {count > 0 && <span className={`badge ${n.badge === 'you' ? 'you' : ''}`}>{count}</span>}
            </Link>
          );
        })}
        <div className="grow" />
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
        <Outlet />
      </main>
    </div>
  );
}
