import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SetupChoice, SetupField, SetupStep, TrackerStatus } from '../api/tracker-types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

/**
 * Where stories come from: pick the tracker, then its own settings, drawn from what its module says it needs (ADR-002).
 * A token stays on this computer; a tracker that signs in with its own tool keeps none.
 */

/** The values a little while after the last key, so typing does not ask the tracker for its lists on every letter. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
    // The key stands for the value: a new object with the same values is no change.
  }, [key, ms]);
  return settled;
}

const shown = (f: SetupField, values: Record<string, string>) => !f.when || f.when.is.includes(values[f.when.key] ?? '');

/** The terminal command for these settings: secrets are never typed into a command. */
function commandOf(s: TrackerStatus, values: Record<string, string>): string {
  if (s.fields.some((f) => f.secret)) return 'squad config set tracker';
  const pairs = s.fields.filter((f) => shown(f, values) && values[f.key]).map((f) => `${f.key}=${values[f.key]}`);
  // Plain words go as they are; anything else in single quotes, a ' inside written as '\''.
  const quoted = pairs.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`));
  return `squad config set tracker --type ${s.module}${quoted.length ? ` --field ${quoted.join(' ')}` : ''}`;
}

export function TrackerSettings() {
  const act = useAct();
  const [asked, setAsked] = useState<string | null>(null);
  const status = useQuery({
    queryKey: asked ? ['tracker', asked] : ['tracker'],
    queryFn: () => api<TrackerStatus>(`/api/v1/tracker${asked ? `?module=${encodeURIComponent(asked)}` : ''}`),
    refetchInterval: 60_000,
  });
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const s = status.data;
  const values = form ?? s?.values ?? {};
  const settled = useSettled(Object.fromEntries((s?.fields ?? []).filter((f) => !f.secret).map((f) => [f.key, values[f.key] ?? ''])));
  const listsWanted = Boolean(s?.fields.some((f) => f.choice && shown(f, settled)));
  const lists = useQuery({
    queryKey: ['tracker-choices', s?.module, settled],
    queryFn: () => api<{ lists: Record<string, SetupChoice[]>; error?: string }>(`/api/v1/tracker/choices?${new URLSearchParams({ module: s!.module, ...settled }).toString()}`),
    enabled: Boolean(s && listsWanted),
    placeholderData: (before) => before,
  });
  if (!s) return null;
  const set = (key: string, value: string) => setForm({ ...values, [key]: value });
  const inUse = s.type === s.module;
  const hasSecret = s.fields.some((f) => f.secret);
  const rows = s.fields.filter((f) => shown(f, values));
  const row = (f: SetupField) => <FieldRow key={f.key} f={f} value={values[f.key] ?? ''} hasToken={s.hasToken} list={lists.data?.lists[f.key]} asked={Boolean(lists.data)} onChange={(v) => set(f.key, v)} />;
  return (
    <div id="tracker" style={{ marginBottom: 26 }}>
      <h2 style={{ marginTop: 6 }}>{s.label ?? 'Tracker'}</h2>
      {s.about && (
        <p className="note" style={{ margin: '2px 0 10px' }}>
          {s.about}
        </p>
      )}
      {s.modules.length > 1 && (
        <div className="maprow" style={{ alignItems: 'center' }}>
          <b>Tracker</b>
          <span className="seg" role="radiogroup" aria-label="Tracker" style={{ width: 'fit-content' }}>
            {s.modules.map((m) => (
              <button
                key={m.name}
                role="radio"
                aria-checked={s.module === m.name}
                className={s.module === m.name ? 'on' : ''}
                onClick={() => {
                  setAsked(m.name);
                  setForm(null);
                }}
              >
                {m.label}
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="maprow" style={{ alignItems: 'center' }}>
        <b>Status</b>
        <span>
          {inUse && s.user ? (
            <span className="pill ok">Connected as {s.user}</span>
          ) : inUse ? (
            <span className="pill bug">{s.error ?? (!hasSecret ? 'Not connected' : s.hasToken ? 'Not connected' : 'Needs a token')}</span>
          ) : (
            <span className="pill wait">Not set up</span>
          )}
        </span>
      </div>
      {s.note && (
        <p className="note" role="note" style={{ margin: '6px 0' }}>
          {s.note}
        </p>
      )}
      {s.steps.length > 0 && <Steps steps={s.steps} />}
      {rows.filter((f) => !f.more).map(row)}
      {rows.some((f) => f.more) && (
        <details style={{ margin: '6px 0' }}>
          <summary className="note" style={{ cursor: 'pointer' }}>
            More
          </summary>
          {rows.filter((f) => f.more).map(row)}
        </details>
      )}
      {lists.data?.error && !s.steps.length && (
        <p className="note" role="alert" style={{ color: 'var(--bug)', margin: '6px 0' }}>
          {lists.data.error}
        </p>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn pri sm"
          disabled={(!form && inUse) || act.isPending}
          onClick={() =>
            act.mutate(
              { path: '/api/v1/tracker', method: 'PUT', body: { ...values, module: s.module }, done: `${s.label ?? 'The tracker'} is connected` },
              {
                onSuccess: () => {
                  setForm(null);
                  setAsked(null);
                },
              },
            )
          }
        >
          {act.isPending ? 'Checking…' : 'Save and check'}
        </button>
        {s.hint && <span className="note">{s.hint}</span>}
        <span className="grow" />
        <Cmd text={commandOf(s, values)} />
      </div>
    </div>
  );
}

/** What this computer still needs first, each step with its command or its page. */
function Steps({ steps }: { steps: SetupStep[] }) {
  return (
    <div className="maprow" role="note" aria-label="Before it can connect">
      <b>First</b>
      <span style={{ display: 'grid', gap: 6 }}>
        {steps.map((st, i) => (
          <span key={st.say} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              {i + 1}. {st.say}
            </span>
            {st.command && <Cmd text={st.command} always />}
            {st.link && (
              <a href={st.link} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                {st.link.replace(/^https:\/\//, '')}
              </a>
            )}
          </span>
        ))}
      </span>
    </div>
  );
}

function FieldRow({ f, value, hasToken, list, asked, onChange }: { f: SetupField; value: string; hasToken: boolean; list?: SetupChoice[]; asked: boolean; onChange(v: string): void }) {
  const input = { className: 'input mono', style: { fontSize: 13 } };
  let control;
  if (f.options) {
    control = (
      <span className="seg" role="radiogroup" aria-label={f.label} style={{ width: 'fit-content' }}>
        {f.options.map((o) => (
          <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </span>
    );
  } else if (f.choice && f.typed) {
    // A list that only suggests: the person may type their own, such as a number or an address.
    control = (
      <>
        <input {...input} aria-label={f.label} list={`tracker-${f.key}`} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
        <datalist id={`tracker-${f.key}`}>
          {(list ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </datalist>
      </>
    );
  } else if (f.choice) {
    // The saved value shows before its list arrives, and when the tracker cannot give it; an empty pick says why.
    const options = list ?? (value ? [{ value, label: value }] : []);
    control = (
      <select className="input" style={{ fontSize: 13 }} aria-label={f.label} value={value} onChange={(e) => onChange(e.target.value)}>
        {!options.some((o) => o.value === '') && <option value="">{list || asked ? 'Pick one' : 'Loading…'}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        {...input}
        aria-label={f.label}
        type={f.secret ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        placeholder={f.secret && hasToken ? 'Saved. Paste a new one to replace it' : f.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>{f.label}</b>
      {control}
    </div>
  );
}
