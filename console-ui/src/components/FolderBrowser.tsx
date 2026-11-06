import { useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ChevronRight, CornerLeftUp, Folder, FolderCheck, FolderGit2, FolderPlus } from 'lucide-react';
import { api, send } from '../api/client';
import type { FolderListing } from '../api/types';

/** The app lists folders itself, because a page cannot read a real folder path. Starts at home. */
export function useFolders(start = '') {
  const [at, setAt] = useState<string>(start);
  const listing = useQuery({
    queryKey: ['app', 'folders', at],
    queryFn: () => api<FolderListing>(`/api/v1/app/folders${at ? `?path=${encodeURIComponent(at)}` : ''}`),
  });
  return { at, setAt, listing };
}

function crumbsOf(p: string): { name: string; path: string }[] {
  const parts = p.split('/').filter(Boolean);
  return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))];
}

/** The folder browser of Add project and New project: places, the folders here, and New folder here. */
export function FolderBrowser({ at, go, listing, onError }: { at: string; go(path: string): void; listing: UseQueryResult<FolderListing>; onError(message: string): void }) {
  const [newName, setNewName] = useState<string | null>(null);
  const l = listing.data;
  // After a folder that cannot be read, Up still leads somewhere: the folder above the one asked for.
  const parentOf = (p: string) => p.replace(/[/\\][^/\\]+[/\\]?$/, '') || '/';
  const up = l?.parent ?? (listing.isError && at ? parentOf(at) : null);
  const open = (p: string) => {
    setNewName(null);
    go(p);
  };

  const makeFolder = async () => {
    if (!l || !newName?.trim()) return;
    try {
      const made = await send<FolderListing>('/api/v1/app/folders', 'POST', { parent: l.path, name: newName.trim() });
      open(made.path);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const crumbs = l ? crumbsOf(l.path) : [];
  return (
    <>
      {l && (
        <div className="places">
          {l.places.map((p) => (
            <button key={p.path} className={`btn sm ${p.path === l.path ? 'pri' : ''}`} onClick={() => open(p.path)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <div className="fb">
        <div className="fb-bar">
          <button className="iconbtn" disabled={!up} onClick={() => up && open(up)} aria-label="Up one folder" title="Up one folder">
            <CornerLeftUp size={15} />
          </button>
          <span className="crumbs mono">
            {crumbs.map((c, i) => (
              <span key={c.path}>
                {i > 0 && <ChevronRight size={12} />}
                <button onClick={() => open(c.path)}>{c.name}</button>
              </span>
            ))}
          </span>
        </div>
        <div className="fb-list" role="list">
          {listing.isError && <p className="note bad">{(listing.error as Error).message}</p>}
          {l && l.folders.length === 0 && <p className="note">No folders inside.</p>}
          {l?.folders.map((f) => (
            <button key={f.path} role="listitem" className="fb-row" onClick={() => open(f.path)}>
              {f.kind === 'project' ? <FolderCheck size={16} /> : f.kind === 'repo' ? <FolderGit2 size={16} /> : <Folder size={16} />}
              <span className="nm">{f.name}</span>
              {f.kind === 'project' && <span className="pill ok sm">squad-kit project</span>}
              {f.kind === 'repo' && <span className="pill sm">code repo</span>}
            </button>
          ))}
        </div>
        <div className="fb-new">
          {newName === null ? (
            <button className="btn sm" disabled={!l} onClick={() => setNewName('')}>
              <FolderPlus size={14} /> New folder here
            </button>
          ) : (
            <>
              <input
                className="input"
                autoFocus
                placeholder="Name of the new folder"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void makeFolder()}
              />
              <button className="btn sm pri" disabled={!newName.trim()} onClick={() => void makeFolder()}>
                Make it
              </button>
              <button className="btn sm" onClick={() => setNewName(null)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
