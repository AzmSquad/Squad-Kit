import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, LayoutGrid, Moon, Sun } from 'lucide-react';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd } from '../components/ui';
import { NotifyButton, QualityAsk, Reads, SetupSteps, useSetup } from '../components/Setup';

/**
 * After Add project: a full page where the person watches squad-kit get to know the project, step by step. They can
 * leave: the setup keeps going, the board shows it, and a desktop notice says when it is ready. Terminal: `squad setup`.
 */
export function SetupPage() {
  const q = useSetup();
  const act = useAct();
  const { theme, toggleTheme } = usePrefs();
  const s = q.data?.setup;
  const running = s ? s.steps.some((x) => x.state === 'now' || x.state === 'todo') && !s.steps.some((x) => x.state === 'stopped') : false;

  return (
    <div className="ob-setup">
      <header className="cpage-h">
        <Link to="/board" className="btn">
          <LayoutGrid size={15} /> See the board meanwhile
        </Link>
        <span className="grow" />
        <Cmd text="squad setup" />
        <button className="iconbtn" onClick={toggleTheme} aria-label={theme === 'light' ? 'Switch to dark' : 'Switch to light'}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </header>
      <div className="scroll">
        <div className="ob-setup-b">
          {q.isLoading ? null : !s ? (
            <div className="ob-head">
              <h2>This project is set up</h2>
              <p>
                See what squad-kit understood on the <Link to="/overview">Overview</Link>.
              </p>
            </div>
          ) : (
            <>
              <div className="ob-head">
                <div className="ob-proj">{s.project}</div>
                <h2>{s.approved ? 'Your project is set up' : s.ready ? (s.empty ? 'Your new project is ready' : 'squad-kit knows your project now') : 'Getting to know your project'}</h2>
                <p>
                  {s.ready || s.approved
                    ? s.empty
                      ? 'Tell the Architect what you want to build, on the Overview.'
                      : 'Check what it understood on the Overview, then start your first ticket.'
                    : s.kind === 'empty'
                      ? 'A few seconds for a new project. You can leave this page: we will tell you when it is ready.'
                      : 'About 3 to 5 minutes. You can leave this page: we will tell you when it is ready.'}
                </p>
              </div>
              <SetupSteps s={s} />
              {s.ready && !s.approved && (
                <div className="ob-card ready">
                  <span className="ob-ring">
                    <Check size={16} strokeWidth={2.5} />
                  </span>
                  <span className="grow">
                    <b>{s.empty ? 'One question for you' : 'Your project overview is ready'}</b>
                    <span>{s.empty ? 'What do you want to build?' : 'What squad-kit understood, for you to check before the first ticket.'}</span>
                  </span>
                  <Link to="/overview" className="btn pri">
                    {s.empty ? 'Answer it' : 'Check what squad-kit understood'} <ArrowRight size={15} />
                  </Link>
                </div>
              )}
              <div className="ob-acts">
                <NotifyButton s={s} />
                {running && (
                  <button className="btn" disabled={act.isPending || s.stopping} onClick={() => act.mutate({ path: '/api/v1/setup/stop', done: 'Stopped. Start it again any time.' })}>
                    {s.stopping ? 'Stopping…' : 'Stop'}
                  </button>
                )}
                {running && <Cmd text="squad setup --stop" />}
                <span className="grow" />
                <Reads s={s} />
              </div>
              {!s.approved && <QualityAsk s={s} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
