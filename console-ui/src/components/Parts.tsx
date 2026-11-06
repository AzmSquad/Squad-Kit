import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ProductPart } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { Cmd } from './ui';

/**
 * Settings: what the product is made of. The Architect found it when it read the project, and an engineer corrects it
 * here. A new read keeps what was corrected. A project with one part does not show this.
 */

interface PartsView {
  parts: ProductPart[];
  repos: string[];
  several: boolean;
}

interface PartForm {
  name: string;
  shared: boolean;
  repo: string;
  folder: string;
  url: string;
  needs: string[];
  off: boolean;
}

const repoName = (repo?: string) => (repo === '.' ? 'The project folder' : (repo ?? ''));

function formOf(p: ProductPart): PartForm {
  return { name: p.name, shared: Boolean(p.shared), repo: p.repo ?? '', folder: p.folder ?? '', url: p.url ?? '', needs: p.needs, off: Boolean(p.off) };
}

function FormFields({ form, set, others, repos, isNew }: { form: PartForm; set(f: PartForm): void; others: ProductPart[]; repos: string[]; isNew: boolean }) {
  return (
    <>
      <div className="maprow part-f">
        <b>Name</b>
        <input className="input" aria-label="Name" value={form.name} placeholder="Web app" onChange={(e) => set({ ...form, name: e.target.value })} />
      </div>
      {isNew && (
        <div className="maprow part-f">
          <b>Kind</b>
          <div className="seg" style={{ justifySelf: 'start' }}>
            <button className={form.shared ? '' : 'on'} onClick={() => set({ ...form, shared: false })}>A part that runs by itself</button>
            <button className={form.shared ? 'on' : ''} onClick={() => set({ ...form, shared: true })}>A service the parts share</button>
          </div>
        </div>
      )}
      {!form.shared && (
        <div className="maprow part-f">
          <b>Where</b>
          <div className="part-where">
            <select className="input mono" aria-label="Repo" value={form.repo} onChange={(e) => set({ ...form, repo: e.target.value })}>
              {!form.repo && <option value="">Pick a repo</option>}
              {repos.map((r) => (
                <option key={r} value={r}>{repoName(r)}</option>
              ))}
            </select>
            <input className="input mono" aria-label="Folder inside the repo" value={form.folder} placeholder="Folder inside it, if any" onChange={(e) => set({ ...form, folder: e.target.value })} />
          </div>
        </div>
      )}
      <div className="maprow part-f">
        <b>Address</b>
        <input className="input mono" aria-label="Address" value={form.url} placeholder="http://localhost:5180" onChange={(e) => set({ ...form, url: e.target.value })} />
      </div>
      <div className="maprow part-f">
        <b>Cannot run without</b>
        <div className="part-needs">
          {others.length === 0 && <span className="note">Nothing else yet.</span>}
          {others.map((o) => (
            <label key={o.id}>
              <input
                type="checkbox"
                checked={form.needs.includes(o.id)}
                onChange={(e) => set({ ...form, needs: e.target.checked ? [...form.needs, o.id] : form.needs.filter((n) => n !== o.id) })}
              />
              {o.name}
            </label>
          ))}
        </div>
      </div>
      {!isNew && (
        <div className="maprow part-f">
          <b>Not used</b>
          <label className="part-off">
            <input type="checkbox" checked={form.off} onChange={(e) => set({ ...form, off: e.target.checked })} />
            No story starts it, like an old app or another product in this folder
          </label>
        </div>
      )}
    </>
  );
}

function PartRow({ part, view }: { part: ProductPart; view: PartsView }) {
  const act = useAct();
  const [form, setForm] = useState<PartForm | null>(null);
  const others = view.parts.filter((p) => p.id !== part.id && (!p.off || part.needs.includes(p.id)));
  const needs = part.needs.map((n) => view.parts.find((p) => p.id === n)?.name ?? n);
  const where = part.shared ? 'Shared by the parts' : [repoName(part.repo), part.folder].filter(Boolean).join(' / ');
  const save = () => act.mutate({ path: `/api/v1/parts/${encodeURIComponent(part.id)}`, method: 'PUT', body: form, done: `Saved ${form!.name}` }, { onSuccess: () => setForm(null) });
  return (
    <div className={`part-row ${part.off ? 'off' : ''}`}>
      <div className="part-head">
        <div className="grow">
          <b>{part.name}</b>
          {part.off && <span className="pill sm" style={{ marginLeft: 8 }}>Not used</span>}
          {part.noRun && !part.off && <span className="pill sm" style={{ marginLeft: 8 }}>Nothing starts here</span>}
          <div className="note">
            {[where, part.url, needs.length > 0 ? `Needs ${needs.join(', ')}` : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        {!form && <button className="btn sm" onClick={() => setForm(formOf(part))}>Correct</button>}
      </div>
      {form && (
        <div className="part-form">
          <FormFields form={form} set={setForm} others={others} repos={view.repos} isNew={false} />
          <div className="part-acts">
            <button className="btn pri sm" disabled={act.isPending} onClick={save}>Save</button>
            <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
            <span className="grow" />
            {part.byHand && (
              <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/parts/${encodeURIComponent(part.id)}/remove`, done: `Took out ${part.name}` }, { onSuccess: () => setForm(null) })}>
                Take it out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddPart({ view }: { view: PartsView }) {
  const act = useAct();
  const blank: PartForm = { name: '', shared: false, repo: view.repos.length === 1 ? view.repos[0]! : '', folder: '', url: '', needs: [], off: false };
  const [form, setForm] = useState<PartForm | null>(null);
  if (!form) return <button className="btn sm" onClick={() => setForm(blank)}>Add a part</button>;
  return (
    <div className="part-row">
      <div className="part-form">
        <FormFields form={form} set={setForm} others={view.parts.filter((p) => !p.off)} repos={view.repos} isNew />
        <div className="part-acts">
          <button className="btn pri sm" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/parts', body: form, done: `Added ${form.name}` }, { onSuccess: () => setForm(null) })}>
            Add it
          </button>
          <button className="btn sm" onClick={() => setForm(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** A product too heavy to run twice on one computer takes one story at a time, whatever the other projects do. */
function StoriesAtOnce() {
  const board = useBoard();
  const act = useAct();
  const now = board.data?.ready ? board.data.meta.atOnce : undefined;
  const set = (atOnce: number | null) => act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { atOnce }, done: atOnce ? `${atOnce === 1 ? 'One story' : `${atOnce} stories`} of this project run at once` : 'This project follows the limit every project shares' });
  return (
    <div className="maprow part-f" style={{ marginTop: 10 }}>
      <b>Stories at once</b>
      <div className="seg" style={{ justifySelf: 'start' }}>
        <button className={now === undefined ? 'on' : ''} onClick={() => set(null)}>As for all projects</button>
        {[1, 2, 3].map((n) => (
          <button key={n} className={now === n ? 'on' : ''} onClick={() => set(n)}>{n}</button>
        ))}
      </div>
    </div>
  );
}

export function PartsSettings() {
  const q = useQuery({ queryKey: ['parts'], queryFn: () => api<PartsView>('/api/v1/parts') });
  const view = q.data;
  if (!view?.several) return null;
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>What the product is made of</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        For engineers. The Architect found these when it read the project, and a new read keeps what you correct here. A story only starts the parts it needs.
      </p>
      {view.parts.map((p) => (
        <PartRow key={p.id} part={p} view={view} />
      ))}
      <div className="part-add">
        <AddPart view={view} />
        <Cmd text="squad parts" />
      </div>
      <StoriesAtOnce />
    </div>
  );
}
