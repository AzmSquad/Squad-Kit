import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldAlert, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { api } from '../api/client';
import type { HarnessView, SandboxInfo } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd, ago } from './ui';

/**
 * The sandbox the Builder's and Tester's commands run in. On the Harness page: whether this computer has it, the
 * project's network level, the websites the project lets them reach besides the package registries, the sites refused
 * lately, and "Windows: less protected" where the agents' own commands have no guard. In Settings: what an engineer lets
 * the project's own commands use.
 */

export function useSandbox() {
  return useQuery({ queryKey: ['sandbox'], queryFn: () => api<SandboxInfo>('/api/v1/sandbox') });
}

/** One row per AI tool, saying plainly whether its commands run in a sandbox here. */
export function SandboxRows() {
  const q = useSandbox();
  const note = q.data?.note;
  return (
    <>
      {note && (
        <div className="toolrow">
          <span className="logo">
            <ShieldAlert size={18} />
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{note.title}</b>
            <br />
            <span className="note">{note.text}</span>
          </span>
          <span className="pill wait">Less protected</span>
        </div>
      )}
      {(q.data?.tools ?? []).map((s) => (
        <div className="toolrow" key={s.tool}>
          <span className="logo">{s.available ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}</span>
          <span style={{ minWidth: 0 }}>
            <b>The guard for the Builder and Tester</b>
            <br />
            {s.available ? (
              <span className="note">
                Their commands run in {s.why}: they write only in the ticket&apos;s copy, the proof folder and temp folders, reach only the
                websites the network level under Safety allows, and never read your keys, sign-ins or .env files.
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
      {q.data?.guard && (
        <div className="toolrow">
          <span className="logo">{q.data.guard.on ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}</span>
          <span style={{ minWidth: 0 }}>
            <b>Guard for the project&apos;s own commands</b>
            <br />
            {q.data.guard.on ? (
              <span className="note">
                The project&apos;s own tests, setup and app run in {q.data.guard.why}: they work normally and can reach the internet for packages and
                tests, but they cannot read your keys, sign-ins, squad-kit&apos;s own folder or the project&apos;s .env files. Only the setup after a
                merge reads the .env files of your own folder, as when you run it yourself. An engineer can allow a
                file they truly need in Settings.
              </span>
            ) : (
              <span className="note">
                Not available on this computer: {q.data.guard.why}. The project&apos;s tests, setup and app run as before.{q.data.guard.fix ? ` To turn it on: ${q.data.guard.fix}.` : ''}
              </span>
            )}
          </span>
          <span className={`pill ${q.data.guard.on ? 'ok' : 'wait'}`}>{q.data.guard.on ? 'On' : 'Not available'}</span>
        </div>
      )}
      {q.data && q.data.tools.some((s) => !s.available) && (
        <div style={{ marginTop: 8 }}>
          <Cmd text="squad doctor" />
        </div>
      )}
    </>
  );
}

/**
 * The project's network level on Harness → Safety: the project's own in one sentence, for everyone. Under "For
 * engineers": the three levels to pick from, for the whole team, and the sites refused lately on this computer.
 */
export function NetworkSetting({ net, live }: { net: HarnessView['safety']['network']; live: boolean }) {
  const act = useAct();
  const level = net.levels.find((l) => l.id === net.level) ?? net.levels[0]!;
  return (
    <div className="maprow">
      <b style={{ paddingTop: 4 }}>Network level</b>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <span className="note">
          <b>{level.name}:</b> {level.words}
        </span>
        {net.level === 'off' && net.commands === 'internet' && (
          <span className="note">On this computer, Off closes the internet for the agents only: your project&apos;s own setup, tests and app still reach it.</span>
        )}
        {live && (
          <details>
            <summary className="note">For engineers</summary>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {net.levels.map((l) => (
                  <button
                    key={l.id}
                    className={`btn sm ${l.id === net.level ? 'pri' : ''}`}
                    aria-pressed={l.id === net.level}
                    disabled={act.isPending}
                    onClick={() => l.id !== net.level && act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { network: l.id }, done: `The network level is ${l.name} now, from the next step` })}
                  >
                    {l.name}
                  </button>
                ))}
                <span className="grow" />
                <Cmd text={`squad config set network ${net.level}`} />
              </span>
              {net.levels.map((l) => (
                <span key={l.id} className="note" style={{ fontSize: 12.5, ...(l.id === net.level ? { color: 'var(--text)' } : {}) }}>
                  <b>{l.name}:</b> {l.words}
                </span>
              ))}
              <BlockedSites />
            </span>
          </details>
        )}
      </span>
    </div>
  );
}

/** The sites the squad's commands were refused lately, on this computer. Nothing here stopped a story. */
function BlockedSites() {
  const q = useSandbox();
  const list = q.data?.network?.blocked ?? [];
  const name: Record<string, string> = { standard: 'Standard', strict: 'Strict', off: 'Off' };
  if (!list.length) return <span className="note">No site was refused on this computer yet.</span>;
  return (
    <>
      <span className="note">
        <b>Refused lately.</b> The work went on without each one. Allow a site below when the project truly needs it, or pick another level.
      </span>
      <table className="table">
        <thead>
          <tr><th>Site</th><th>Story</th><th>Level</th><th>When</th></tr>
        </thead>
        <tbody>
          {list.map((b) => (
            <tr key={`${b.host}-${b.story}`}>
              <td className="mono">{b.host}</td>
              <td><Link to="/board" search={{ ticket: b.story }}>{b.story}</Link></td>
              <td>{name[b.level] ?? b.level}</td>
              <td>{ago(b.at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** The websites the squad's commands may reach besides the package registries, for the whole team. */
export function AllowedHosts({ hosts }: { hosts: string[] }) {
  const act = useAct();
  const q = useSandbox();
  const [text, setText] = useState('');
  const save = (next: string[], done: string) =>
    act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { allowedHosts: next }, done }, { onSuccess: () => setText('') });
  const add = () => {
    const h = text.trim();
    if (h && !act.isPending) save([...hosts, h], `The squad may reach ${h} from its next step`);
  };
  const off = q.data?.tools.length ? q.data.tools.every((s) => !s.available) : false;
  return (
    <div className="maprow">
      <b style={{ paddingTop: 4 }}>Websites the squad may reach</b>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <span className="note">
          Allow a website here when the project needs one, for example your company&apos;s package server. The whole team shares this list.
          {q.data?.network?.level === 'standard' ? ' On Standard the squad reaches it already: the list counts on Strict.' : ''}
          {off ? ' This computer has no guard for them, so here they can reach any website.' : ''}
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

/**
 * Settings: files and folders outside its copy that the project's own commands (tests, setup, the app) may use, for
 * engineers, when squad-kit's guard blocked one the project truly needs. The whole team shares it.
 */
export function GuardAllows() {
  const act = useAct();
  const q = useSandbox();
  const guard = q.data?.guard;
  const [read, setRead] = useState('');
  const [write, setWrite] = useState('');
  if (!guard?.on) return null;
  const save = (body: { allowRead?: string[]; allowWrite?: string[] }, done: string, clear: () => void) =>
    act.mutate({ path: '/api/v1/settings', method: 'PUT', body: { guard: { allowRead: guard.allowRead, allowWrite: guard.allowWrite, ...body } }, done }, { onSuccess: clear });
  const row = (kind: 'read' | 'write', list: string[], text: string, setText: (s: string) => void) => {
    const field = kind === 'read' ? 'allowRead' : 'allowWrite';
    const add = () => text.trim() && !act.isPending && save({ [field]: [...list, text.trim()] }, `The project's commands may ${kind} ${text.trim()}`, () => setText(''));
    const drop = (p: string) => save({ [field]: list.filter((x) => x !== p) }, `No longer allowed to ${kind} ${p}`, () => undefined);
    return (
      <div className="maprow">
        <b style={{ paddingTop: 4 }}>{kind === 'read' ? 'Also read' : 'Also write'}</b>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <span className="note">
            {kind === 'read' ? 'Files or folders the project needs to read' : 'Folders the project needs to write in'} outside its copy, such as{' '}
            <span className="mono">~/shared</span>. Add one only when a check stopped because squad-kit blocked a file the project truly needs.
          </span>
          {list.length > 0 && (
            <span className="pills">
              {list.map((p) => (
                <span className="pill mono" key={p}>
                  {p}
                  <button className="linkbtn" aria-label={`Stop allowing ${p}`} title={`Stop allowing ${p}`} disabled={act.isPending} onClick={() => drop(p)}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </span>
          )}
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input mono" style={{ fontSize: 13, flex: '1 1 200px', minWidth: 0 }} value={text} placeholder="~/shared" aria-label={`A path to ${kind}`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="btn sm" disabled={!text.trim() || act.isPending} onClick={add}>Allow</button>
          </span>
          <Cmd text={`squad config set allow-${kind} ${[...list, text.trim()].filter(Boolean).join(' ') || '~/shared'}`} />
        </span>
      </div>
    );
  };
  return (
    <>
      {row('read', guard.allowRead, read, setRead)}
      {row('write', guard.allowWrite, write, setWrite)}
    </>
  );
}
