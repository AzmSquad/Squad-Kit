import { useState } from 'react';
import { Bug, Check, Copy, Download, Plus, Rocket } from 'lucide-react';
import type { Release, Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd, Modal } from './ui';

export function NewTicketDialog({ onClose, onCreated }: { onClose(): void; onCreated(t: Ticket): void }) {
  const act = useAct<Ticket>();
  const [title, setTitle] = useState('');
  const [ask, setAsk] = useState('');
  const [priority, setPriority] = useState<Ticket['priority']>('normal');
  const submit = () =>
    act.mutate(
      { path: '/api/v1/tickets', body: { title, ask, priority } },
      {
        onSuccess: (t) => {
          onCreated(t);
          onClose();
        },
      },
    );
  return (
    <Modal
      title="New ticket"
      onClose={onClose}
      icon={<span className="glyph"><Plus size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={!title.trim() || act.isPending} onClick={submit}>
            <Plus size={15} /> Create ticket
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={`squad new "${title.trim() || 'Your title'}"`} />
        </>
      }
    >
      <p>Write it in plain words. The Analyst reads it and asks you anything that is unclear.</p>
      <div className="field">
        <label htmlFor="nt-title">Title</label>
        <input id="nt-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Show hearing time in local time" onKeyDown={(e) => e.key === 'Enter' && title.trim() && submit()} />
      </div>
      <div className="field">
        <label htmlFor="nt-ask">What do you want?</label>
        <textarea id="nt-ask" className="textarea" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Who needs it, and why. One or two sentences is enough." />
      </div>
      <div className="field">
        <label>Priority</label>
        <div className="sevs">
          {(['high', 'normal', 'low'] as const).map((p) => (
            <button key={p} className={`choice ${priority === p ? 'on' : ''}`} onClick={() => setPriority(p)}>
              <span className="rd" />
              {p === 'high' ? 'High' : p === 'normal' ? 'Normal' : 'Low'}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function PullDialog({ onClose, onCreated }: { onClose(): void; onCreated(t: Ticket): void }) {
  const act = useAct<Ticket>();
  const [ref, setRef] = useState('AB#');
  const submit = () =>
    act.mutate(
      { path: '/api/v1/pull', body: { ref } },
      {
        onSuccess: (t) => {
          onCreated(t);
          onClose();
        },
      },
    );
  return (
    <Modal
      title="Pull from Azure DevOps"
      onClose={onClose}
      icon={<span className="glyph"><Download size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={ref.replace(/\D/g, '').length === 0 || act.isPending} onClick={submit}>
            <Download size={15} /> Pull ticket
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={`squad pull ${ref.trim() || 'AB#4133'}`} />
        </>
      }
    >
      <p>Bring a work item in as a ticket, with its description and attachments.</p>
      <div className="field">
        <label htmlFor="pull-ref">Work item</label>
        <input id="pull-ref" className="input mono" autoFocus value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Modal>
  );
}

const SEVERITY: { value: NonNullable<Ticket['severity']>; label: string }[] = [
  { value: 'stops-work', label: 'Stops work' },
  { value: 'annoying', label: 'Annoying' },
  { value: 'small', label: 'Small' },
];

export function BugDialog({ onClose, foundIn }: { onClose(): void; foundIn?: string }) {
  const act = useAct<Ticket>();
  const [what, setWhat] = useState('');
  const [how, setHow] = useState('');
  const [expected, setExpected] = useState('');
  const [severity, setSeverity] = useState<NonNullable<Ticket['severity']>>('annoying');
  const submit = () =>
    act.mutate(
      { path: '/api/v1/bugs', body: { what, how, expected, severity, foundIn }, done: 'Bug reported. Triage is sorting it.' },
      { onSuccess: onClose },
    );
  return (
    <Modal
      title="Report a bug"
      onClose={onClose}
      icon={<span className="glyph" style={{ background: 'var(--bug-soft)', color: 'var(--bug)' }}><Bug size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={!what.trim() || act.isPending} onClick={submit}>
            <Bug size={15} /> Report bug
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={`squad bug "${what.trim() || 'What happened'}"${foundIn ? ` --in ${foundIn}` : ''}`} />
        </>
      }
    >
      <p>It becomes a ticket linked to {foundIn ?? 'the latest release'}, and goes around the same loop. The Tester adds a check so it can't come back.</p>
      <div className="field">
        <label htmlFor="bug-what">What happened?</label>
        <input id="bug-what" className="input" autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="For example: Table text is hard to read in dark mode" />
      </div>
      <div className="field">
        <label htmlFor="bug-how">How can we see it?</label>
        <input id="bug-how" className="input" value={how} onChange={(e) => setHow(e.target.value)} placeholder="The steps, in a line" />
      </div>
      <div className="field">
        <label htmlFor="bug-exp">What did you expect?</label>
        <input id="bug-exp" className="input" value={expected} onChange={(e) => setExpected(e.target.value)} />
      </div>
      <div className="field">
        <label>How bad is it?</label>
        <div className="sevs">
          {SEVERITY.map((s) => (
            <button key={s.value} className={`choice ${severity === s.value ? 'on' : ''}`} onClick={() => setSeverity(s.value)}>
              <span className="rd" />
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function ReleasedDialog({ release, demo, onClose }: { release: Release; demo: boolean; onClose(): void }) {
  const { toast } = usePrefs();
  const copy = () =>
    void navigator.clipboard?.writeText(release.whatsappDraft ?? '').then(() => toast('Message copied. Send it from WhatsApp.'));
  const steps = [
    release.addons.changelog && 'Changelog updated',
    release.addons.tag && `Tagged ${release.version} in git`,
    release.addons.pipeline && 'Azure pipeline started',
  ].filter(Boolean) as string[];
  return (
    <Modal
      title={`${release.version} is released`}
      onClose={onClose}
      icon={<span className="glyph"><Rocket size={15} /></span>}
      footer={
        <>
          {release.addons.whatsapp && (
            <button className="btn pri" onClick={copy}>
              <Copy size={15} /> Copy message
            </button>
          )}
          <button className="btn" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="donelist">
        <div><Check size={16} /> {release.tickets.length} tickets released</div>
        {release.log
          ? release.log.map((l) => (
              <div key={l.text} style={l.ok ? undefined : { color: 'var(--you-ink)' }}>
                {l.ok ? <Check size={16} /> : <span style={{ width: 16, textAlign: 'center', fontWeight: 800 }}>!</span>} {l.text}
              </div>
            ))
          : steps.map((s) => (
              <div key={s}><Check size={16} /> {s}</div>
            ))}
      </div>
      {demo && !release.log && <p className="note" style={{ marginBottom: 12 }}>Demo board: these release steps are shown, not run.</p>}
      {release.addons.whatsapp && release.whatsappDraft && (
        <>
          <div className="lbl" style={{ marginTop: 4 }}>A WhatsApp note for your manager. Copy it and send it yourself.</div>
          <div className="wa">{release.whatsappDraft}</div>
        </>
      )}
    </Modal>
  );
}
