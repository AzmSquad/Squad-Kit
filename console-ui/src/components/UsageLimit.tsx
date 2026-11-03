import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass } from 'lucide-react';
import { api, send } from '../api/client';
import type { UsageLimitStatus } from '../api/types';
import { usePrefs } from '../lib/prefs';
import { Cmd } from './ui';

/**
 * The AI account's usage limit (E5), on Home and every project page: every project waits, because they share one
 * account, and the squad carries on by itself once it resets. Try now carries on at once. Terminal: `squad try-now`.
 */

const KEY = ['app', 'usage-limit'];

export function useUsageLimit() {
  return useQuery({ queryKey: KEY, queryFn: () => api<UsageLimitStatus>('/api/v1/app/usage-limit'), refetchInterval: 5000 });
}

export function LimitBanner() {
  const { data } = useUsageLimit();
  const qc = useQueryClient();
  const { toast } = usePrefs();
  if (!data?.pause || !data.text) return null;
  const tryNow = async () => {
    try {
      qc.setQueryData(KEY, await send<UsageLimitStatus>('/api/v1/app/usage-limit/try-now', 'POST'));
      void qc.invalidateQueries();
      toast('The squad carries on now. If the limit is still there, it waits again by itself.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
  };
  return (
    <section className="upd failed" role="status" aria-label="The usage limit is reached">
      <span className="upd-ic">
        <Hourglass size={16} />
      </span>
      <div className="upd-main">
        <b className="upd-title">{data.text}</b>
        <span className="upd-sub">
          Every project waits, because they share one {data.pause.name} account. Nothing is lost, and the wait does not count as a failed try.
          {data.pause.resetsAt ? '' : ' squad-kit looks again every 10 minutes.'}
        </span>
      </div>
      <div className="upd-acts">
        <button className="btn sm" onClick={() => void tryNow()}>
          Try now
        </button>
        <Cmd text="squad try-now" />
      </div>
    </section>
  );
}
