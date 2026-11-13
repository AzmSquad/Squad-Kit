import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { ConnectionRow } from '../api/contribution-types';
import { CONNECT } from '../lib/connect-words';
import { readLang } from '../lib/first-story';
import { CouldNotLoad } from '../components/ui';
import { ConnectionCard } from '../components/connect/ConnectionCard';
import { SignInCode } from '../components/connect/SignInCode';
import '../styles/connect.css';

/**
 * Connections: one row per outside tool, the button first and the step-by-step guide folded under it. A sign-in runs
 * the tool's own sign-in (a code typed on its page); a token is pasted; a tool coming in a next version is shown as
 * such. Every action is one REST call and one `squad connect` command.
 */

export function useConnections(every = 30_000) {
  return useQuery({ queryKey: ['connections'], queryFn: () => api<{ rows: ConnectionRow[] }>('/api/v1/connections'), refetchInterval: every });
}

export function ConnectionsPage() {
  const lang = readLang();
  const w = CONNECT[lang];
  const q = useConnections();
  const qc = useQueryClient();
  const [signing, setSigning] = useState<ConnectionRow | null>(null);
  const [checking, setChecking] = useState(false);
  // Check again: each tool is asked afresh, not from what the board kept.
  const check = () => {
    setChecking(true);
    void api<{ rows: ConnectionRow[] }>('/api/v1/connections?again=1')
      .then((r) => qc.setQueryData(['connections'], r))
      .finally(() => setChecking(false));
  };
  return (
    <>
      <div className="top gh-top" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <div>
          <h1>{w.head}</h1>
          <p>{w.sub}</p>
        </div>
      </div>
      <div className="scroll">
        {!q.data ? (
          q.isError ? (
            <CouldNotLoad what="the connections" error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <div className="center">
              <Loader2 size={16} className="spin" />
            </div>
          )
        ) : (
          <div className="page gh-page" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
            <div className="gh-conns">
              {q.data.rows.map((r, i) => (
                <ConnectionCard key={r.name} row={r} at={i} lang={lang} onSignIn={() => setSigning(r)} onCheck={check} checking={checking} />
              ))}
            </div>
          </div>
        )}
      </div>
      {signing && <SignInCode name={signing.name} label={signing.label} onClose={() => setSigning(null)} />}
    </>
  );
}
