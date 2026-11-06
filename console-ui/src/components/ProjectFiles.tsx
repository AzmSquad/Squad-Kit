import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProjectFile } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

/**
 * Settings: the files agents may not touch. Only names and places pass through here, never what a file holds: an
 * engineer edits a story's values in their own editor.
 */

interface LocalFile extends ProjectFile {
  ready: boolean;
  inFolder: boolean;
  storyFile: string;
}

interface FilesView {
  local: LocalFile[];
  locked: ProjectFile[];
  repos: string[];
  docker: ProjectFile[];
}

const API = '/api/v1/project-files';

function FileRow({ f, many, children }: { f: ProjectFile; many: boolean; children?: React.ReactNode }) {
  const act = useAct();
  return (
    <div className="part-row">
      <div className="part-head">
        <div className="grow">
          <b className="mono" style={{ fontSize: 13 }}>{many ? `${f.repo}/${f.path}` : f.path}</b>
          {children}
        </div>
        <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/remove`, body: f, done: `${f.path} is off the list` })}>
          Take it off
        </button>
      </div>
    </div>
  );
}

function LocalRow({ f, many }: { f: LocalFile; many: boolean }) {
  const act = useAct();
  return (
    <FileRow f={f} many={many}>
      {f.ready ? <span className="pill ok sm" style={{ marginLeft: 8 }}>Ready</span> : <span className="pill you sm" style={{ marginLeft: 8 }}>No values for stories yet</span>}
      <div className="note">
        {f.ready ? 'Stories use the file at ' : 'Stories need their own values, in a file at '}
        <span className="mono">{f.storyFile}</span>
      </div>
      {!f.ready && f.inFolder && (
        <button className="linkbtn" style={{ marginTop: 4 }} disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/use-mine`, body: f, done: `Copied. Change any real values in it to test values` })}>
          Start from the one in my folder
        </button>
      )}
    </FileRow>
  );
}

export function ProjectFiles() {
  const q = useQuery({ queryKey: ['project-files'], queryFn: () => api<FilesView>(API) });
  const act = useAct();
  const [path, setPath] = useState('');
  const [repo, setRepo] = useState('');
  const v = q.data;
  if (!v) return null;
  const many = v.repos.length > 1;
  const body = { repo: repo || (many ? '' : v.repos[0]), path };
  const add = (kind: 'local' | 'locked') => act.mutate({ path: `${API}/${kind}`, body, done: `Added ${path}` }, { onSuccess: () => setPath('') });
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>Files agents may not touch</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        For engineers. <b>Local files</b> are files git does not carry, like .env.dev. squad-kit puts them in each story's copy for the project's own tests and app, and no agent can read them. A
        test could still read and send what is in them, so give stories local test values, never real ones. <b>Locked files</b> are in git: agents can read them and never change them.
      </p>
      {v.local.map((f) => (
        <LocalRow key={`${f.repo}/${f.path}`} f={f} many={many} />
      ))}
      {v.locked.map((f) => (
        <FileRow key={`${f.repo}/${f.path}`} f={f} many={many}>
          <span className="pill sm" style={{ marginLeft: 8 }}>Locked</span>
        </FileRow>
      ))}
      <div className="part-file-add">
        {many && (
          <select className="input mono" aria-label="Repo" value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">Pick a repo</option>
            {v.repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}
        <input className="input mono" aria-label="File" value={path} placeholder=".env.dev" onChange={(e) => setPath(e.target.value)} />
        <button className="btn sm" disabled={!path.trim() || act.isPending} onClick={() => add('local')}>Add as local</button>
        <button className="btn sm" disabled={!path.trim() || act.isPending} onClick={() => add('locked')}>Lock it</button>
      </div>
      <div className="part-add">
        {v.docker.length > 0 ? (
          <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/lock-docker`, done: 'Locked the Docker files' })}>
            Lock {v.docker.length === 1 ? 'the Docker file' : `the ${v.docker.length} Docker files`}
          </button>
        ) : (
          <span />
        )}
        <Cmd text="squad files" />
      </div>
    </div>
  );
}
