import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff, X } from 'lucide-react';
import { api } from '../api/client';
import type { SandboxInfo } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

/**
 * The sandbox the Builder's and Tester's commands run in: on the Squad and AI page, whether this computer has it; in
 * Settings, the websites the project lets them reach besides the package registries.
 */

function useSandbox() {
  return useQuery({ queryKey: ['sandbox'], queryFn: () => api<SandboxInfo>('/api/v1/sandbox') });
}

/** Squad and AI: one row per AI tool, saying plainly whether its commands run in a sandbox here. */
export function SandboxRows() {
  const q = useSandbox();
  return (
    <>
      {(q.data?.tools ?? []).map((s) => (
        <div className="toolrow" key={s.tool}>
          <span className="logo">{s.available ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}</span>
          <span style={{ minWidth: 0 }}>
            <b>Sandbox for the Builder and Tester</b>
            <br />
            {s.available ? (
              <span className="note">
                Their commands run in {s.why}: they write only in the ticket&apos;s copy, the proof folder and temp folders, reach only package
                registries and the websites you allow in Settings, and never read your keys, sign-ins or .env files. Packages for .NET, Java and
                Ruby go into the ticket&apos;s own download folder, never into your own caches; it goes when the ticket is released or deleted, so
                a ticket&apos;s first build downloads them again.
              </span>
            ) : (
              <span className="note">
                Not available on this computer: {s.why}. The Builder and Tester run as before, kept in their lane by squad-kit&apos;s own checks.
                {s.fix ? ` To turn it on: ${s.fix}.` : ''}
              </span>
            )}
          </span>
          <span className={`pill ${s.available ? 'ok' : 'wait'}`}>{s.available ? 'On' : 'Not available'}</span>
        </div>
      ))}
      {q.data && q.data.tools.some((s) => !s.available) && (
        <div style={{ marginTop: 8 }}>
          <Cmd text="squad doctor" />
        </div>
      )}
    </>
  );
}

/** Settings: the websites the squad's commands may reach besides the package registries, for the whole team. */
export function AllowedHosts({ hosts }: { hosts: string[] }) {
  const act = useAct();
  const q = useSandbox();
  const [text, setText] = useState('');
  const save = (next: string[], done: string) =>
    act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { allowedHosts: next }, done }, { onSuccess: () => setText('') });
  const add = () => {
    const h = text.trim();
    if (h) save([...hosts, h], `The squad may reach ${h} from its next step`);
  };
  const off = q.data?.tools.length ? q.data.tools.every((s) => !s.available) : false;
  return (
    <div className="maprow">
      <b style={{ paddingTop: 4 }}>Websites the squad may reach</b>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <span className="note">
          The Builder and Tester can download packages from npm, PyPI, Maven and the other package registries, and nothing else. Allow a website
          here when the project needs one, for example your company&apos;s package server. The whole team shares this list.
          {off ? ' This computer has no sandbox, so here they can reach any website.' : ''}
        </span>
        {hosts.length > 0 && (
          <span className="pills">
            {hosts.map((h) => (
              <span className="pill mono" key={h}>
                {h}
                <button className="linkbtn" aria-label={`Stop allowing ${h}`} title={`Stop allowing ${h}`} disabled={act.isPending} onClick={() => save(hosts.filter((x) => x !== h), `The squad no longer reaches ${h}`)}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </span>
        )}
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="input mono"
            style={{ fontSize: 13, flex: '1 1 200px', minWidth: 0 }}
            value={text}
            placeholder="packages.example.com"
            aria-label="A website to allow"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn sm" disabled={!text.trim() || act.isPending} onClick={add}>
            Allow
          </button>
        </span>
        <Cmd text={`squad config set hosts ${[...hosts, text.trim()].filter(Boolean).join(' ') || 'nexus.example.com'}`} />
      </span>
    </div>
  );
}
