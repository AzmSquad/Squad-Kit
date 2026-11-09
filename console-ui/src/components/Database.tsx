import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DatabaseInfo } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd, ago } from './ui';

/**
 * Each story's own copy of the project's database. Everyone reads one plain sentence; under "For engineers": the
 * database squad-kit learned from the project's files (to confirm or correct), the template stories are made from (its
 * size and age, and Make it again), the hiding switch, the sample size, and the story databases there are now. No
 * password passes through here.
 */

const API = '/api/v1/database';

export function useDatabase() {
  return useQuery({ queryKey: ['database'], queryFn: () => api<DatabaseInfo>(API), refetchInterval: (q) => (q.state.data?.making ? 3000 : 30_000) });
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function settingText(s: { env?: string; file?: string; key?: string }): string {
  if (s.key && s.file) return `${s.key} in ${s.file}${s.env ? ` (or ${s.env})` : ''}`;
  if (s.env) return `${s.env}${s.file ? ` in ${s.file}` : ''}`;
  return 'Not known yet';
}

function Fix({ v, done }: { v: NonNullable<DatabaseInfo['database']>; done: () => void }) {
  const act = useAct();
  const [f, setF] = useState({ kind: v.kind as string, name: '', env: '', file: '', key: '', address: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const body = Object.fromEntries(Object.entries(f).filter(([k, x]) => x.trim() && (k !== 'kind' || x !== v.kind)));
  return (
    <div className="part-file-add" style={{ flexWrap: 'wrap' }}>
      <select className="input mono" aria-label="Kind" value={f.kind} onChange={set('kind')}>
        {['postgres', 'mysql', 'mongo', 'sqlite'].map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input className="input mono" aria-label="Name" value={f.name} placeholder={v.name ?? 'name'} onChange={set('name')} />
      <input className="input mono" aria-label="Setting name" value={f.env} placeholder={v.setting.env ?? 'DATABASE_URL'} onChange={set('env')} />
      <input className="input mono" aria-label="Settings file" value={f.file} placeholder={v.setting.file ?? '.env'} onChange={set('file')} />
      <input className="input mono" aria-label="Key in the file" value={f.key} placeholder={v.setting.key ?? 'key in the file'} onChange={set('key')} />
      <input className="input mono" type="password" autoComplete="off" aria-label="Address" value={f.address} placeholder="Address your copy uses" onChange={set('address')} />
      <button className="btn sm pri" disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/confirm`, body, done: 'Confirmed' }, { onSuccess: done })}>
        Confirm these
      </button>
    </div>
  );
}

/** What engineers see and change. */
export function DatabasePanel() {
  const q = useDatabase();
  const act = useAct();
  const [fixing, setFixing] = useState(false);
  const [rows, setRows] = useState('');
  const v = q.data;
  if (!v?.words) return null;
  const db = v.database;
  const find = (
    <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/find`, done: 'Looked again' })}>
      Find it again
    </button>
  );
  if (!db) {
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="note">{v.words}</span>
        {find}
        <Cmd text="squad db" />
      </span>
    );
  }
  const sampled = v.template?.tables.filter((t) => t.kept === 'sampled').length ?? 0;
  return (
    <div>
      <div className="maprow">
        <b>Database</b>
        <span>
          {db.kindName}
          {db.name ? <span className="mono"> {db.name}</span> : null}
          {db.confirmed ? <span className="pill ok sm" style={{ marginLeft: 8 }}>Confirmed by {db.confirmed.by}</span> : <span className="pill you sm" style={{ marginLeft: 8 }}>Not confirmed yet</span>}
          {db.where && <span className="note" style={{ display: 'block' }}>{db.where}</span>}
          {db.from?.length ? <span className="note" style={{ display: 'block' }}>Learned from <span className="mono">{db.from.join(', ')}</span></span> : null}
        </span>
      </div>
      <div className="maprow">
        <b>Setting</b>
        <span className="mono" style={{ fontSize: 13 }}>{settingText(db.setting)}</span>
      </div>
      <div className="maprow">
        <b>Address</b>
        <span>
          <span className="mono" style={{ fontSize: 13 }}>{db.address ?? 'Not known yet'}</span>
          {db.secret && <span className="note"> · kept on this computer only</span>}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {!db.confirmed && (
          <button className="btn sm pri" disabled={act.isPending} onClick={() => act.mutate({ path: `${API}/confirm`, done: 'Confirmed' })}>
            Confirm it
          </button>
        )}
        <button className="btn sm" onClick={() => setFixing(!fixing)}>{fixing ? 'Close' : 'Correct it'}</button>
        {find}
        <span className="grow" />
        <Cmd text="squad db confirm" />
      </div>
      {fixing && <Fix v={db} done={() => setFixing(false)} />}
      <div className="maprow">
        <b>Template</b>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {v.making ? (
            <span className="note">Being made, since {ago(v.making.since)}. It only reads your database.</span>
          ) : v.template ? (
            <span>
              {size(v.template.bytes)}, made {ago(v.template.madeAt)} · {v.template.tables.length} tables{sampled ? `, ${sampled} sampled` : ''}
              {v.template.hidePersonal ? ', personal data hidden' : ''}
            </span>
          ) : (
            <span className="note">None yet. Stories use the database as before until there is one.</span>
          )}
          {v.failed && !v.making && <span className="note">The last one was not made: {v.failed.text}</span>}
          {v.missing.length > 0 && <span className="note">This computer has no {v.missing.join(', ')}.</span>}
          {v.blocked && <span className="note">{v.blocked}</span>}
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn sm" disabled={act.isPending || Boolean(v.making) || !db.confirmed} onClick={() => act.mutate({ path: `${API}/template`, done: 'Making the template' })}>
              {v.template ? 'Make it again' : 'Make the template'}
            </button>
            <Cmd text="squad db template" />
          </span>
        </span>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Hide personal data</b>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`btn sm ${db.hidePersonal ? 'pri' : ''}`} aria-pressed={Boolean(db.hidePersonal)} disabled={act.isPending} onClick={() => act.mutate({ path: API, method: 'PUT', body: { hidePersonal: !db.hidePersonal }, done: db.hidePersonal ? 'Off, from the next template' : 'On, from the next template' })}>
            {db.hidePersonal ? 'On' : 'Off'}
          </button>
          <span className="note">Names, ID numbers, phones, emails and addresses become fake in the template.</span>
          <Cmd text={`squad config set db-hide ${db.hidePersonal ? 'off' : 'on'}`} />
        </span>
      </div>
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Sample size</b>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="input mono" style={{ width: 110 }} aria-label="Rows" inputMode="numeric" value={rows} placeholder={String(db.sampleRows ?? 1000)} onChange={(e) => setRows(e.target.value)} />
          <button className="btn sm" disabled={!rows.trim() || act.isPending} onClick={() => act.mutate({ path: API, method: 'PUT', body: { sampleRows: Number(rows) }, done: 'Saved, from the next template' }, { onSuccess: () => setRows('') })}>
            Save
          </button>
          <span className="note">rows of each big table, the newest. Small tables are kept whole.</span>
        </span>
      </div>
      <div className="maprow">
        <b>Story databases now</b>
        <span>
          {v.stories.length ? (
            v.stories.map((s) => (
              <span key={s.story} style={{ display: 'block' }}>
                <b>{s.story}</b> <span className="mono" style={{ fontSize: 13 }}>{s.name}</span> <span className="note">{ago(s.at)}</span>
              </span>
            ))
          ) : (
            <span className="note">None</span>
          )}
        </span>
      </div>
      {v.notes.length > 0 && (
        <div className="maprow">
          <b>Notes</b>
          <span>
            {v.notes.slice(0, 5).map((n) => (
              <span key={`${n.at}${n.text}`} className="note" style={{ display: 'block' }}>{ago(n.at)}: {n.text}</span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Harness → Safety: the plain sentence for everyone, the details for engineers. */
export function DatabaseBlock() {
  const v = useDatabase().data;
  if (!v?.words) return null;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="note">{v.words}</span>
      <details>
        <summary className="note">For engineers</summary>
        <div style={{ marginTop: 6 }}>
          <DatabasePanel />
        </div>
      </details>
    </span>
  );
}

/** Settings: the same, for engineers. */
export function DatabaseSettings() {
  return (
    <div style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>Each story&apos;s own database</h2>
      <p className="note" style={{ margin: '2px 0 10px' }}>
        For engineers. squad-kit learns the project&apos;s database from its files. Once you confirm it and make a template, each story gets its own copy of
        the database on the same server, and its copy of the code points at it. It goes when the story is merged, released or deleted. Your own database is
        only read, to make the template.
      </p>
      <DatabasePanel />
    </div>
  );
}
