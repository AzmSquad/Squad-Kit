import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { send } from '../api/client';
import { usePrefs } from '../lib/prefs';
import { expectRestart } from '../lib/reach';

/** Restart the board in place: it stops, a fresh one starts on the same link, and this page comes back by itself. */
export function useRestart() {
  const { toast } = usePrefs();
  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    setRestarting(true);
    expectRestart(true);
    const before = await fetch('/healthz').then((r) => r.json() as Promise<{ startedAt?: string }>).catch(() => ({ startedAt: undefined }));
    try {
      await send('/api/v1/restart', 'POST');
    } catch (err) {
      setRestarting(false);
      expectRestart(false);
      toast(err instanceof Error ? err.message : String(err), 'err');
      return;
    }
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await fetch('/healthz').then((r) => r.json() as Promise<{ startedAt?: string }>).catch(() => null);
      if (now?.startedAt && now.startedAt !== before.startedAt) {
        window.location.reload();
        return;
      }
    }
    setRestarting(false);
    expectRestart(false);
    toast('The board did not come back. Run squad console in your terminal.', 'err');
  };
  return { restarting, restart };
}

export function UpdateBanner() {
  const { restarting, restart } = useRestart();
  return (
    <div className="updatebar" role="status">
      <RefreshCw size={15} />
      <span>
        <b>squad-kit was updated.</b> Restart the board to use the new version. Running work picks up where it stopped.
      </span>
      <span className="grow" />
      <button className="btn sm pri" disabled={restarting} onClick={() => void restart()}>
        {restarting ? 'Restarting…' : 'Restart now'}
      </button>
    </div>
  );
}
