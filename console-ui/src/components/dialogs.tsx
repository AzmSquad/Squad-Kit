import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bug, Check, Copy, Download, Loader2, Paperclip, Plus, Rocket, Sparkles, X } from 'lucide-react';
import type { Release, Ticket, Track } from '../api/types';
import { api, send } from '../api/client';
import { useAct } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { Cmd, Modal } from './ui';

interface Draft {
  title: string;
  ask: string;
  kind: Ticket['kind'];
  track?: Track;
  priority: Ticket['priority'];
  criteria: string[];
  rules: string[];
  edgeCases: string[];
  gaps: string[];
}

interface PickedFile {
  name: string;
  size: number;
  data: string;
  /** A local preview for pictures. */
  preview?: string;
}

const MAX_FILE = 10 * 1024 * 1024;

function readFile(f: File): Promise<PickedFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ name: f.name, size: f.size, data: url.slice(url.indexOf(',') + 1), ...(f.type.startsWith('image/') ? { preview: url } : {}) });
    };
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.readAsDataURL(f);
  });
}

function quote(x: string): string {
  return `"${x.replace(/"/g, '\\"')}"`;
}

/**
 * A new ticket, written by hand or filled in by the Analyst from a pasted idea or chat message. Either way the person
 * sees every field, with its acceptance criteria, business rules, edge cases and files, before it is created.
 */
export function NewTicketDialog({ onClose, onCreated }: { onClose(): void; onCreated(t: Ticket): void }) {
  const act = useAct<Ticket>();
  const { toast } = usePrefs();
  const [mode, setMode] = useState<'write' | 'paste'>('write');
  const [pasted, setPasted] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [gaps, setGaps] = useState<string[] | null>(null);
  const [title, setTitle] = useState('');
  const [ask, setAsk] = useState('');
  const [kind, setKind] = useState<Ticket['kind']>('feature');
  const [priority, setPriority] = useState<Ticket['priority']>('normal');
  const [track, setTrack] = useState<Track>('full');
  const [suggested, setSuggested] = useState<Track | null>(null);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [edgeCases, setEdgeCases] = useState<string[]>([]);
  const [files, setFiles] = useState<PickedFile[]>([]);

  const addFiles = async (list: FileList | File[]) => {
    const picked = [...list];
    const big = picked.find((f) => f.size > MAX_FILE);
    if (big) toast(`${big.name} is larger than 10 MB.`, 'err');
    const read = await Promise.all(picked.filter((f) => f.size <= MAX_FILE).map(readFile)).catch((err: Error) => {
      toast(err.message, 'err');
      return [];
    });
    setFiles((now) => [...now, ...read].slice(0, 10));
  };
  const upload = files.map(({ name, data }) => ({ name, data }));

  const fill = async () => {
    setDrafting(true);
    try {
      const d = await send<Draft>('/api/v1/tickets/draft', 'POST', { text: pasted, files: upload });
      setTitle(d.title);
      setAsk(d.ask);
      setKind(d.kind);
      setPriority(d.priority);
      if (d.track) {
        setTrack(d.track);
        setSuggested(d.track);
      }
      setCriteria(d.criteria);
      setRules(d.rules);
      setEdgeCases(d.edgeCases);
      setGaps(d.gaps);
      setMode('write');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setDrafting(false);
    }
  };

  const submit = () =>
    act.mutate(
      {
        path: '/api/v1/tickets',
        body: { title, ask, kind, track, priority, criteria, rules, edgeCases, files: upload },
      },
      {
        onSuccess: (t) => {
          onCreated(t);
          onClose();
        },
      },
    );

  const cmd =
    mode === 'paste'
      ? `squad new --from ${quote(pasted.trim().split('\n')[0]?.slice(0, 40) || 'your message')}`
      : [
          `squad new ${quote(title.trim() || 'Your title')}`,
          kind === 'bug' ? '--bug' : '',
          track === 'express' ? '--express' : '',
          ...criteria.filter((x) => x.trim()).map((x) => `--criteria ${quote(x)}`),
          ...rules.filter((x) => x.trim()).map((x) => `--rule ${quote(x)}`),
          ...edgeCases.filter((x) => x.trim()).map((x) => `--edge ${quote(x)}`),
          ...files.map((f) => `--attach ${quote(f.name)}`),
        ]
          .filter(Boolean)
          .join(' ');

  return (
    <Modal
      title="New ticket"
      wide
      onClose={onClose}
      icon={<span className="glyph"><Plus size={15} /></span>}
      footer={
        <>
          {mode === 'paste' ? (
            <button className="btn pri" disabled={(!pasted.trim() && !files.length) || drafting} onClick={() => void fill()}>
              {drafting ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {drafting ? 'The Analyst is reading it…' : 'Fill in the ticket'}
            </button>
          ) : (
            <button className="btn pri" disabled={!title.trim() || act.isPending} onClick={submit}>
              <Plus size={15} /> Create ticket
            </button>
          )}
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={cmd} />
        </>
      }
    >
      <div className="seg" style={{ marginBottom: 14, width: 'fit-content' }}>
        <button className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>Write it</button>
        <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>
          <Sparkles size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
          From an idea or message
        </button>
      </div>

      {mode === 'paste' ? (
        <>
          <p>Paste an idea, a WhatsApp message or one line of business. Add screenshots if you have them. The Analyst fills in the ticket, and you check every field before it is created.</p>
          <div className="field">
            <label htmlFor="nt-paste">The idea or message</label>
            <textarea
              id="nt-paste"
              className="textarea"
              style={{ minHeight: 150 }}
              autoFocus
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onPaste={(e) => {
                // A pasted screenshot becomes a file, so the Analyst can read the chat in it.
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void addFiles(e.clipboardData.files);
                }
              }}
              placeholder="For example: the manager says clerks should not book more than 3 appointments a day for the same person"
            />
          </div>
          <FilePicker files={files} onAdd={addFiles} onRemove={(i) => setFiles((now) => now.filter((_, k) => k !== i))} />
        </>
      ) : (
        <>
          {gaps ? (
            <div className="drafted">
              <b><Sparkles size={13} /> The Analyst filled this in from your message.</b> Check it and change anything.
              {gaps.length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}>Still unclear, so the Analyst will ask you after you create it:</div>
                  <ul>{gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
                </>
              )}
            </div>
          ) : (
            <p>Write it in plain words. Add what you already know; the Analyst asks you about the rest.</p>
          )}
          <div className="field">
            <label htmlFor="nt-title">Title</label>
            <input id="nt-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Show hearing time in local time" />
          </div>
          <div className="field">
            <label htmlFor="nt-ask">What do you want?</label>
            <textarea id="nt-ask" className="textarea" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Who needs it, and why. One or two sentences is enough." />
          </div>
          <ListField label="Acceptance criteria" hint="Each one is something you can check, for example: The clerk sees the time in their own city." items={criteria} onChange={setCriteria} add="Add a criterion" />
          <ListField label="Business rules" hint="Limits and who may do what, for example: Only a team lead can reassign a case." items={rules} onChange={setRules} add="Add a rule" />
          <ListField label="Edge cases" hint="Unusual cases to handle, for example: The person has no cases yet." items={edgeCases} onChange={setEdgeCases} add="Add an edge case" />
          <FilePicker files={files} onAdd={addFiles} onRemove={(i) => setFiles((now) => now.filter((_, k) => k !== i))} />
          <div className="field">
            <label>Kind and priority</label>
            <div className="sevs">
              {(['feature', 'bug'] as const).map((k) => (
                <button key={k} className={`choice ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  <span className="rd" />
                  {k === 'feature' ? 'New feature' : 'Bug'}
                </button>
              ))}
              <span style={{ width: 10 }} />
              {(['high', 'normal', 'low'] as const).map((p) => (
                <button key={p} className={`choice ${priority === p ? 'on' : ''}`} onClick={() => setPriority(p)}>
                  <span className="rd" />
                  {p === 'high' ? 'High' : p === 'normal' ? 'Normal' : 'Low'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Track{suggested && <span className="note" style={{ marginLeft: 8, fontWeight: 400 }}>The Analyst suggests {suggested === 'express' ? 'Express' : 'Full'}</span>}</label>
            <div className="tracks">
              {TRACKS.map((tr) => (
                <button key={tr.id} className={`opt2 ${track === tr.id ? 'pick' : ''}`} onClick={() => setTrack(tr.id)}>
                  <b>
                    {tr.name}
                    {track === tr.id && (
                      <span>
                        <Check size={13} strokeWidth={2.5} /> Chosen
                      </span>
                    )}
                  </b>
                  {tr.note}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

const TRACKS: { id: Track; name: string; note: string }[] = [
  { id: 'full', name: 'Full', note: 'Every step. The Analyst asks questions and you approve the plan.' },
  { id: 'express', name: 'Express', note: 'For a typo or a small urgent fix. No questions, the plan is approved on its own. Build, checks, review and your Looks right still run.' },
];

/** A list of short lines the person can add to, edit and remove. Enter on the last line adds a new one. */
function ListField({ label, hint, items, onChange, add }: { label: string; hint: string; items: string[]; onChange(items: string[]): void; add: string }) {
  const set = (i: number, v: string) => onChange(items.map((x, k) => (k === i ? v : x)));
  return (
    <div className="field">
      <label>{label}</label>
      {items.length === 0 && <p className="note" style={{ margin: '0 0 6px' }}>{hint}</p>}
      {items.map((x, i) => (
        <div className="listrow" key={i}>
          <span className="mono note">{i + 1}</span>
          <input
            className="input"
            value={x}
            autoFocus={x === '' && i === items.length - 1}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && i === items.length - 1 && x.trim()) onChange([...items, '']);
            }}
            aria-label={`${label} ${i + 1}`}
          />
          <button className="iconbtn" onClick={() => onChange(items.filter((_, k) => k !== i))} aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}>
            <X size={14} />
          </button>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange([...items, ''])}>
        <Plus size={13} /> {add}
      </button>
    </div>
  );
}

/** Screenshots, documents, voice or video notes: click to pick, or drop them here. Up to 10 files of 10 MB each. */
const MEDIA_NOTE = /\.(ogg|opus|oga|m4a|mp3|wav|aac|amr|flac|weba|mp4|mov|m4v|webm)$/i;

function FilePicker({ files, onAdd, onRemove }: { files: PickedFile[]; onAdd(list: FileList | File[]): void; onRemove(i: number): void }) {
  const [over, setOver] = useState(false);
  const hasNotes = files.some((f) => MEDIA_NOTE.test(f.name));
  const speech = useQuery({ queryKey: ['speech'], queryFn: () => api<{ hasKey: boolean }>('/api/v1/speech'), enabled: hasNotes });
  return (
    <div className="field">
      <label>Files</label>
      <label
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) onAdd(e.dataTransfer.files);
        }}
        onPaste={(e) => e.clipboardData.files.length && onAdd(e.clipboardData.files)}
      >
        <Paperclip size={15} /> Drop screenshots, documents, voice or video notes here, or click to pick
        <input
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAdd(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {files.length > 0 && (
        <div className="picked">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="pickedfile">
              {f.preview ? <img src={f.preview} alt="" /> : <Paperclip size={13} />}
              <span className="mono">{f.name}</span>
              <span className="note">{f.size < 1024 * 1024 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`}</span>
              <button className="iconbtn" onClick={() => onRemove(i)} aria-label={`Remove ${f.name}`}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      {hasNotes && speech.data && (
        <p className="note" style={{ marginTop: 6 }}>
          {speech.data.hasKey
            ? 'squad-kit writes out voice and video notes with Munsit, and takes pictures of the screen in videos, so every agent knows what was said.'
            : 'Add a Munsit key in Settings so the squad can listen to voice and video notes. Without it they stay attached, unheard.'}
        </p>
      )}
    </div>
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
