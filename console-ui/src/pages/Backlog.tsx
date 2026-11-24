import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { List, ListTree, Plug } from 'lucide-react';
import { api } from '../api/client';
import type { BacklogResponse, TrackerStatus } from '../api/types';
import { folded, nestBacklog } from '../lib/backlog-tree';
import { isolated } from '../lib/lang';
import { shellQuote } from '../lib/text';
import { Cmd } from '../components/ui';
import { GroupRow, ItemRow, LooseRow } from '../components/BacklogRows';
import '../styles/backlog.css';

/** This browser's choices: the tree or the list, and the epics and features folded. Storage may say no. */
const VIEW_KEY = 'sk.backlogView';
const FOLD_KEY = 'sk.backlogFolded';
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window: the choice lasts for this visit.
  }
}

/**
 * The sprint's stories and bugs from the project's tracker, under their epics and features when the tracker has them
 * (Tree), or as a plain list (List). Starting one makes it a ticket the squad works on.
 */
export function BacklogPage() {
  const [sprint, setSprint] = useState<string | undefined>(undefined);
  const [flat, setFlat] = useState(stored(VIEW_KEY) === 'list');
  const [closed, setClosed] = useState<Set<string>>(() => new Set((stored(FOLD_KEY) ?? '').split('\n').filter(Boolean)));
  const backlog = useQuery({
    queryKey: ['backlog', sprint ?? ''],
    queryFn: () => api<BacklogResponse>(`/api/v1/backlog${sprint ? `?sprint=${encodeURIComponent(sprint)}` : ''}`),
    refetchInterval: 15_000,
  });
  const data = backlog.data;
  const label = useQuery({ queryKey: ['tracker'], queryFn: () => api<TrackerStatus>('/api/v1/tracker') }).data?.label ?? 'the tracker';
  const chosen = sprint ?? data?.sprint;
  const sprintName = data?.sprints.find((s) => s.path === chosen)?.name;
  const nested = Boolean(data?.tree);
  const asTree = nested && !flat;
  const lines = useMemo(() => nestBacklog(data?.items ?? [], asTree ? data?.tree : undefined), [data, asTree]);
  const pickView = (list: boolean) => {
    setFlat(list);
    store(VIEW_KEY, list ? 'list' : 'tree');
  };
  const fold = (id: string) =>
    setClosed((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      store(FOLD_KEY, [...next].join('\n'));
      return next;
    });
  const command = [`squad backlog`, sprintName ? `--sprint ${shellQuote(sprintName)}` : '', nested && flat ? '--flat' : ''].filter(Boolean).join(' ');
  return (
    <>
      <div className="top">
        <h1>Backlog</h1>
        {data?.connected && data.sprints.length > 0 && (
          <select className="input" style={{ width: 'auto', marginLeft: 12 }} value={chosen ?? 'all'} onChange={(e) => setSprint(e.target.value)} aria-label="Sprint">
            {data.sprints.map((s) => (
              <option key={s.path} value={s.path}>
                {isolated(s.name)}
                {s.current ? ' (now)' : ''}
              </option>
            ))}
            <option value="all">Everything open</option>
          </select>
        )}
        {nested && (
          <div className="seg bl-view" role="group" aria-label="View">
            <button className={asTree ? 'on' : ''} aria-pressed={asTree} onClick={() => pickView(false)}>
              <ListTree size={14} /> Tree
            </button>
            <button className={!asTree ? 'on' : ''} aria-pressed={!asTree} onClick={() => pickView(true)}>
              <List size={14} /> List
            </button>
          </div>
        )}
        <span className="grow" />
        <Cmd text={command} />
      </div>
      <div className="scroll">
        <div className="page">
          {backlog.isLoading ? (
            <p className="note">Reading the backlog from {label}…</p>
          ) : !data?.connected ? (
            <div className="calm">
              <span className="ring"><Plug size={18} /></span>
              <div>
                <b>Connect a tracker</b>
                <span>
                  {data?.error ?? 'Sign in to your tracker on the Connections page, and your stories and bugs show up here.'}{' '}
                  <Link to="/connections" style={{ fontWeight: 600 }}>Open Connections</Link>
                  {' · '}
                  <Link to="/settings" hash="tracker" style={{ fontWeight: 600 }}>Settings</Link>
                </span>
              </div>
            </div>
          ) : data.error ? (
            <p className="note" style={{ color: 'var(--bug)' }}>{data.error}</p>
          ) : data.items.length === 0 ? (
            <p className="note">Nothing open in {sprintName ?? 'this sprint'}.</p>
          ) : (
            <>
              <p className="note" style={{ marginBottom: 12 }}>
                {data.items.length} open {data.items.length === 1 ? 'item' : 'items'} in {sprintName ?? 'the backlog'}
                {asTree ? ', under their epics and features, in backlog order.' : ', in backlog order.'} Start one and the squad picks it up; {label} follows along.
                {data.capped && ' There are more: only the first 500 are shown. Pick a sprint here, or a view or Status in Settings, to see the rest.'}
              </p>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>ID</th>
                    <th>Title</th>
                    <th style={{ width: 70 }}>Points</th>
                    <th style={{ width: 100 }}>On {label}</th>
                    <th style={{ width: 260 }}>squad-kit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    if (l.kind === 'loose') return <LooseRow key="loose" />;
                    if (folded(l, closed)) return null;
                    if (l.kind === 'group') return <GroupRow key={l.group.id} g={l.group} depth={l.depth} items={l.items} open={!closed.has(l.group.id)} onFold={() => fold(l.group.id)} />;
                    const f = l.hasUnder ? { open: !closed.has(l.item.id), onFold: () => fold(l.item.id) } : undefined;
                    return <ItemRow key={l.item.id} w={l.item} {...(asTree ? { depth: l.depth } : {})} {...(f ? { fold: f } : {})} />;
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </>
  );
}
