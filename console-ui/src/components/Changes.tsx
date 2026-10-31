import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

interface FileChange {
  path: string;
  status: 'added' | 'changed' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  patch: string;
  binary?: boolean;
}

interface TicketChanges {
  from: 'copy' | 'branch' | 'none';
  base?: string;
  branch?: string;
  files: FileChange[];
  cut?: boolean;
}

const EDITOR_NAME: Record<string, string> = { cursor: 'Cursor', code: 'VS Code' };

/** Opens the ticket's copy of the code in the person's editor. */
export function OpenInEditor({ t }: { t: Ticket }) {
  const act = useAct<{ editor: string; folder: string }>();
  const editors = useQuery({ queryKey: ['editors'], queryFn: () => api<{ editors: string[] }>('/api/v1/editors'), staleTime: 300_000 });
  const first = editors.data?.editors[0];
  return (
    <button
      className="btn sm"
      disabled={act.isPending || !t.baseCommit}
      title={t.baseCommit ? undefined : 'Nothing built yet'}
      onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/open-editor`, body: first ? { editor: first } : {}, done: `Opened in ${first ? EDITOR_NAME[first] : 'your editor'}` })}
    >
      <ExternalLink size={13} /> Open in {first ? EDITOR_NAME[first] : 'editor'}
    </button>
  );
}

/** Everything this ticket changed against main, file by file. Your own folder shows it only after Looks right. */
export function ChangesTab({ t }: { t: Ticket }) {
  const changes = useQuery({
    queryKey: ['changes', t.id, t.activity.length],
    queryFn: () => api<TicketChanges>(`/api/v1/tickets/${t.id}/changes`),
    refetchInterval: t.live ? 10_000 : false,
  });
  const c = changes.data;
  const added = c?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const removed = c?.files.reduce((n, f) => n + f.removed, 0) ?? 0;
  return (
    <div className="db">
      <div className="changes-head">
        <div>
          {c && c.files.length > 0 ? (
            <>
              <b>{c.files.length} {c.files.length === 1 ? 'file' : 'files'} changed</b>{' '}
              <span className="add">+{added}</span> <span className="del">−{removed}</span>
            </>
          ) : (
            <b>Changes</b>
          )}
          <p className="note">
            {c?.from === 'branch'
              ? `Read from branch ${c.branch}. The copy was removed after the release.`
              : 'The squad builds in its own copy of the code, so your folder stays yours. These changes reach your folder after Looks right.'}
          </p>
        </div>
        <span className="grow" />
        <OpenInEditor t={t} />
      </div>
      {changes.isLoading && <p className="note">Reading the changes…</p>}
      {changes.error && <p className="note">{(changes.error as Error).message}</p>}
      {c && !c.files.length && <p className="note">{c.from === 'none' ? 'Nothing built yet.' : 'No changes against main yet.'}</p>}
      {c?.cut && <p className="note">This change is very large, so some files show only their name. Open it in your editor to see all of it.</p>}
      {c?.files.map((f) => <FileDiff key={f.path} f={f} />)}
      <div className="pills" style={{ marginTop: 12 }}>
        <Cmd text={`squad changes ${t.id} --full`} />
        <Cmd text={`squad open ${t.id}`} />
      </div>
    </div>
  );
}

function FileDiff({ f }: { f: FileChange }) {
  const lines = f.patch ? f.patch.split('\n') : [];
  const [open, setOpen] = useState(lines.length <= 300);
  return (
    <div className="conv-diff">
      <button className="conv-diff-head mono changes-file" onClick={() => setOpen(!open)}>
        <span className={`fstat ${f.status}`}>{f.status === 'added' ? 'new' : f.status === 'deleted' ? 'deleted' : f.status === 'renamed' ? 'moved' : 'changed'}</span>
        <span style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>{f.path}</span>
        <span className="grow" />
        {f.binary ? <span>binary</span> : <span><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>}
      </button>
      {open && lines.length > 0 && (
        <pre>
          {lines.map((l, i) =>
            l.startsWith('@@') ? (
              <div key={i} className="gap">{l.replace(/^(@@[^@]*@@).*/, '$1')}</div>
            ) : (
              <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'same'}>
                <span className="sign">{l.startsWith('+') ? '+' : l.startsWith('-') ? '−' : ' '}</span>
                {l.slice(1) || ' '}
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  );
}
