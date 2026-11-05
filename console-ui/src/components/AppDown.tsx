import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { noteAlive, noteNoAnswer } from '../lib/reach';
import { useReach } from '../lib/use-reach';
import { Cmd } from './ui';

/** How often the page looks for the app when nothing else on it is asking. */
const LOOK_MS = 2000;

/**
 * The app stopped, so this page is only a picture of it. Shown over every page and every dialog, with what to do, and
 * gone by itself when the app is back. Nothing typed is lost (lib/drafts.ts). What pulses stands still meanwhile
 * (html[data-app-down] in app.css), so the page no longer looks alive.
 */
export function AppDown() {
  const reach = useReach();
  const qc = useQueryClient();
  useEffect(() => {
    const look = () => {
      void fetch('/healthz', { cache: 'no-store' }).then(
        () => noteAlive(),
        () => noteNoAnswer(),
      );
    };
    const timer = window.setInterval(look, LOOK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const was = useRef(reach);
  useEffect(() => {
    if (reach === 'down') document.documentElement.dataset.appDown = '1';
    else delete document.documentElement.dataset.appDown;
    // Back: every page gets its data again at once.
    if (reach === 'up' && was.current !== 'up') void qc.invalidateQueries();
    was.current = reach;
  }, [reach, qc]);
  if (reach === 'up') return null;
  return (
    <div className="appdown" role="alert">
      <span className="upd-ic">
        <TriangleAlert size={16} />
      </span>
      <div className="upd-main">
        {reach === 'down' ? (
          <>
            <b className="upd-title">squad-kit has stopped, so this page is not up to date</b>
            <span className="upd-sub">Your work and what you typed are safe. Start it again in a terminal. This page comes back by itself.</span>
          </>
        ) : (
          <>
            <b className="upd-title">This page&apos;s link is out of date</b>
            <span className="upd-sub">Run this in a terminal: it opens the board with a fresh link. What you typed is kept.</span>
          </>
        )}
      </div>
      <div className="upd-acts">
        <Cmd text="squad" />
      </div>
    </div>
  );
}
