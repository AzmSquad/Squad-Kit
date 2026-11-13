import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Download, Ellipsis, ExternalLink, ImagePlus, Loader2, MessageCircle, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import type { BrdRef, BreakdownLevel, BreakdownView } from '../api/requirements-types';
import { allStories, findPart, leftOutAsk, needExample, pluralType, refWords, sendCountWords, sendStep, sendStepWords, type SendPlanned } from '../lib/requirements';
import { actionError, rememberSendPlan, reqFileUrl, sendPlanOf, useReqAct, useSendPreview } from '../lib/requirementsData';
import { shellQuote } from '../lib/text';
import { readFile, type PickedFile } from './dialogs';
import { Cmd, Modal, Written } from './ui';
import { useDraft } from '../lib/drafts';
import { isolated, rehypeLang, typedDir } from '../lib/lang';

/**
 * The Requirements page's dialogs: Add a BRD, Send to the tracker, Ask the Analyst, Add a part, the parts left out,
 * and the document itself at the place a part comes from.
 */

const base = (id: string) => `/api/v1/requirements/${encodeURIComponent(id)}`;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 10;

/** An error from the API in plain words: the server's own message when it gave one. */
export function plainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^(\d{3}) [^:]*: ?([\s\S]*)$/.exec(msg);
  if (!m) return actionError(err);
  try {
    const j = JSON.parse(m[2]!) as { error?: string };
    if (j.error && j.error !== 'not found') return j.error;
  } catch {
    // Not JSON: the text itself.
  }
  if (m[1] === '404') return 'This squad-kit cannot do that yet. Update squad-kit, then try again.';
  return m[2]?.trim() || msg;
}

/* ── Add a BRD ──────────────────────────────────────────── */

type Kind = 'pdf' | 'docx' | 'markdown' | 'text';

function kindOf(name: string): Kind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt' || ext === 'text') return 'text';
  return null;
}

const KIND_TAG: Record<Kind, string> = { pdf: 'PDF', docx: 'DOCX', markdown: 'MD', text: 'TXT' };
const KIND_WORD: Record<Kind, string> = { pdf: 'PDF', docx: 'Word document', markdown: 'Markdown', text: 'Text' };

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const stem = (name: string) => name.replace(/\.[^.]+$/, '');

/** A BRD the person picked, once squad-kit can read that kind of file. Throws in plain words. */
export async function readBrd(f: File): Promise<PickedFile> {
  if (!kindOf(f.name)) throw new Error(`${f.name}: squad-kit reads PDF, Word (.docx), Markdown and text files. Save the BRD as one of those, or paste the text.`);
  if (f.size > MAX_FILE) throw new Error(`${f.name} is larger than 10 MB.`);
  return readFile(f);
}

/** Drop or choose the BRD, and the file once it is picked. */
export function BrdDrop({ file, onPick, onClear, hint }: { file: PickedFile | null; onPick(files: FileList | null): void; onClear(): void; hint?: string }) {
  const [over, setOver] = useState(false);
  const kind = file ? kindOf(file.name) : null;
  return (
    <>
      <label
        className={`rq-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onPick(e.dataTransfer.files);
        }}
      >
        <input type="file" className="sr-only" accept=".pdf,.docx,.md,.markdown,.txt" onChange={(e) => onPick(e.target.files)} />
        <Upload size={24} aria-hidden="true" />
        <b>
          Drop your BRD here, or <u>choose a file</u>
        </b>
        <span>{hint ?? 'PDF, Word, Markdown or text, up to 10 MB'}</span>
      </label>
      {file && kind && (
        <div className="rq-file">
          <span className={`rq-ftag ${kind}`}>{KIND_TAG[kind]}</span>
          <div className="grow">
            <b>{file.name}</b>
            <span>
              {sizeWords(file.size)}, {KIND_WORD[kind]}
            </span>
          </div>
          <button className="iconbtn" aria-label="Remove the file" onClick={onClear}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}

/** Add a BRD: drop or choose the document (or paste its text), name it, add mockups. Nothing is built or sent. */
export function AddBrdDialog({ onClose }: { onClose(): void }) {
  const act = useReqAct<BreakdownView>();
  const navigate = useNavigate();
  const [file, setFile] = useState<PickedFile | null>(null);
  // A pasted BRD can be pages long: closing the dialog by accident keeps it. Files ask first (`losing` below).
  const [paste, setPaste, clearPaste] = useDraft('add-brd', 'paste', false);
  const [text, setText, clearText] = useDraft('add-brd', 'text', '');
  const [name, setName, clearName] = useDraft('add-brd', 'name', '');
  const [named, setNamed] = useState(false);
  const [extra, setExtra] = useState<PickedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const extraInput = useRef<HTMLInputElement>(null);

  const pick = async (list: FileList | File[] | null) => {
    const f = list ? [...list][0] : undefined;
    if (!f) return;
    setError(null);
    try {
      const read = await readBrd(f);
      setFile(read);
      setPaste(false);
      if (!named) setName(stem(f.name));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const addExtra = async (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const big = picked.find((f) => f.size > MAX_FILE);
    if (big) setError(`${big.name} is larger than 10 MB.`);
    const read = await Promise.all(picked.filter((f) => f.size <= MAX_FILE).map(readFile)).catch((err: Error) => {
      setError(err.message);
      return [];
    });
    setExtra((now) => [...now, ...read].slice(0, MAX_FILES - 1));
  };

  const can = paste ? Boolean(text.trim()) : Boolean(file);
  const command = paste
    ? `squad requirements add --paste${name.trim() ? ` --name ${shellQuote(name.trim())}` : ''}`
    : `squad requirements add ${file ? shellQuote(file.name) : '<file>'}${file && name.trim() && name.trim() !== stem(file.name) ? ` --name ${shellQuote(name.trim())}` : ''}${extra.map((x) => ` --with ${shellQuote(x.name)}`).join('')}`;
  const submit = () => {
    if (!can) return;
    setError(null);
    const body = paste
      ? { text, ...(name.trim() ? { name: name.trim() } : {}), with: extra.map(({ name: n, data }) => ({ name: n, data })) }
      : { file: { name: file!.name, data: file!.data }, ...(name.trim() ? { name: name.trim() } : {}), with: extra.map(({ name: n, data }) => ({ name: n, data })) };
    act.mutate(
      { path: '/api/v1/requirements', body },
      {
        onSuccess: (v) => {
          clearPaste();
          clearText();
          clearName();
          onClose();
          void navigate({ to: '/requirements/$id', params: { id: v.id } });
        },
        onError: (err) => setError(plainError(err)),
      },
    );
  };

  return (
    <Modal
      title="Add a BRD"
      onClose={onClose}
      losing={file || extra.length ? (file ? `the file ${file.name}` : 'the attached files') : null}
      footer={
        <>
          <span className="rq-fcmd">
            <Cmd text={command} />
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={!can || act.isPending} onClick={submit}>
            {act.isPending && <Loader2 size={14} className="spin" />} Break it down
          </button>
        </>
      }
    >
      <p>The Analyst breaks it into epics, features and stories. Nothing is built or sent anywhere until you approve.</p>
      <div className="rq-add">
        {paste ? (
          <div className="field">
            <label htmlFor="rq-paste">The BRD's text</label>
            <textarea id="rq-paste" className="textarea rq-pastebox" autoFocus dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the whole document here. Headings help the Analyst find its parts." />
            <div className="rq-hint">
              Have the file?{' '}
              <button className="rq-link" onClick={() => setPaste(false)}>
                Choose a file instead
              </button>
            </div>
          </div>
        ) : (
          <>
            <BrdDrop file={file} onPick={(f) => void pick(f)} onClear={() => setFile(null)} />
            <div className="rq-hint">
              No file?{' '}
              <button className="rq-link" onClick={() => setPaste(true)}>
                Paste the text instead
              </button>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="rq-name">Name</label>
          <input
            id="rq-name"
            className="input"
            dir={typedDir(name)}
            value={name}
            placeholder={paste ? 'Named after its first heading' : 'Named after the file'}
            onChange={(e) => {
              setName(e.target.value);
              setNamed(true);
            }}
          />
        </div>
        <div className="rq-hint">
          Screen mockups or other files that go with it?{' '}
          <button className="rq-link" onClick={() => extraInput.current?.click()}>
            Add them
          </button>
          <input ref={extraInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void addExtra(e.target.files)} />
        </div>
        {extra.length > 0 && (
          <div className="rq-extras">
            {extra.map((x, i) => (
              <span key={`${x.name}-${i}`} className="rq-extra">
                <ImagePlus size={13} aria-hidden="true" />
                {x.name}
                <button aria-label={`Remove ${x.name}`} onClick={() => setExtra((now) => now.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {error && (
          <p className="rq-err" role="alert">
            {error}
          </p>
        )}
        <div className="rq-next">
          <div className="rq-next-h">What happens next</div>
          <div className="rq-nstep">
            <span>1</span>The Analyst reads it and asks you only about parts that are missing or that clash.
          </div>
          <div className="rq-nstep">
            <span>2</span>You edit the breakdown and approve it.
          </div>
          <div className="rq-nstep">
            <span>3</span>Send it to your tracker, let the squad build it story by story, or both.
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ── Send to the tracker ────────────────────────────────── */

/** Send to the tracker: what it creates and links, from GET /send. Then its progress, and Send again if it stops. */
export function SendDialog({ v, onClose }: { v: BreakdownView; onClose(): void }) {
  const act = useReqAct<BreakdownView>();
  const preview = useSendPreview(v.id, true);
  const [started, setStarted] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [planned, setPlanned] = useState<SendPlanned | null>(null);
  const label = v.tracker?.label ?? 'the tracker';
  const sync = v.state.sync;
  // Once sent, the squad picks the send up: until its progress shows, it is on its way.
  const sending = started && !postError && (act.isPending || !sync || sync.status === 'running' || sync.status === 'pending');
  const sent = started && sync?.status === 'done' && !act.isPending;
  const failed = (started && sync?.status === 'failed') || Boolean(postError);
  const p = preview.data;
  const example = needExample(v);
  // The progress counts in the numbers this dialog showed: its items, then its links.
  const step = act.isPending ? sendStep(undefined) : sendStep(sync, planned ?? sendPlanOf(v.id));
  const stepWords = sendStepWords(step);
  const send = async () => {
    setPostError(null);
    setStarted(true);
    // Send again carries on with what is left: count from what is left now.
    const fresh = failed ? ((await preview.refetch()).data ?? p) : p;
    const plan = fresh ? { items: fresh.items, links: fresh.first ? fresh.counts.links : fresh.links } : null;
    setPlanned(plan);
    if (plan) rememberSendPlan(v.id, plan);
    act.mutate(
      { path: `${base(v.id)}/send`, quiet: true },
      {
        onSuccess: (r) => plan && r?.state?.sync?.at && rememberSendPlan(v.id, { ...plan, at: r.state.sync.at }),
        onError: (err) => setPostError(plainError(err)),
      },
    );
  };
  const project = p?.tracker.project ?? v.tracker?.project;
  const nothing = p && p.items === 0 && p.links === 0;

  return (
    <Modal
      title={`Send to ${label}`}
      onClose={onClose}
      footer={
        <>
          <span className="rq-fcmd">
            <Cmd text={`squad requirements send ${v.id}`} />
          </span>
          {sending || sent ? (
            <button className="btn" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              {failed ? (
                <button className="btn pri" onClick={() => void send()} disabled={act.isPending}>
                  <RotateCcw size={14} /> Send again
                </button>
              ) : (
                <button className="btn pri" onClick={() => void send()} disabled={!p || Boolean(nothing) || act.isPending}>
                  {p ? (p.first ? `Send ${p.items} items` : 'Send changes') : 'Send'}
                </button>
              )}
            </>
          )}
        </>
      }
    >
      <p>
        Into {project ? <>project <b className="rq-ink">{project}</b></> : `your ${label} project`}, as the item types it uses. They go into the backlog, not a sprint.
      </p>
      {preview.isLoading ? (
        <p className="note">Working out what to send…</p>
      ) : preview.isError ? (
        <div className="rq-err" role="alert">
          squad-kit could not work out what to send. {plainError(preview.error)}{' '}
          <button className="rq-link" onClick={() => void preview.refetch()}>
            Try again
          </button>
        </div>
      ) : p ? (
        <>
          <div className="rq-send">
            <div className="rq-li">
              <b>{p.counts.epics.all}</b>
              {pluralType(p.levels.epic)}
              <span>{sendCountWords(p.counts.epics, p.first)}</span>
            </div>
            {p.counts.features.all > 0 && (
              <div className="rq-li">
                <b>{p.counts.features.all}</b>
                {pluralType(p.levels.feature)}, each under its epic
                <span>{sendCountWords(p.counts.features, p.first)}</span>
              </div>
            )}
            <div className="rq-li">
              <b>{p.counts.stories.all}</b>
              {pluralType(p.levels.story)}, each under its {p.counts.storiesUnderEpic ? (p.counts.features.all ? 'feature or epic' : 'epic') : 'feature'}
              <span>{p.first ? 'with "done when" as acceptance criteria' : sendCountWords(p.counts.stories, false)}</span>
            </div>
            {(p.first ? p.counts.links : p.links) > 0 && (
              <div className="rq-li">
                <b>{p.first ? p.counts.links : p.links}</b>
                {p.first ? 'Links between stories that need each other' : 'New links between stories that need each other'}
                {example && <Written text={`"${example}"`} />}
              </div>
            )}
          </div>
          {nothing && <p className="note">Everything is sent already. Edit the breakdown and Send changes updates the same items.</p>}
        </>
      ) : null}
      <div className="rq-promise">
        <div>
          Each story's number shows in the breakdown. When the squad builds a story, its item moves forward and gets the squad's notes, as tickets from the Backlog do today.
        </div>
        <div>
          Edit the breakdown later and <b>Send changes</b> updates the same items. squad-kit never deletes anything in {label}.
        </div>
      </div>
      {started && (sending || sent || failed) && (
        <div className={`rq-sendprog ${failed ? 'fail' : ''}`} role="status">
          {failed ? (
            <span>
              <b>The send stopped.</b> {postError ?? sync?.error ?? 'Something went wrong on the way.'} What was sent stays sent; Send again carries on without doubles.
            </span>
          ) : sent ? (
            <span>
              <b>Sent.</b> Each item's number shows in the breakdown now.
            </span>
          ) : (
            <>
              <span>
                {step.phase === 'links' ? `${stepWords.charAt(0).toUpperCase()}${stepWords.slice(1)}` : `Sending${stepWords ? ` ${stepWords}` : ''}`}… You can close this: it carries on.
              </span>
              <span className="rq-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={step.pct} aria-label="Sent so far">
                <i style={{ width: `${step.pct || 5}%` }} />
              </span>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ── Ask the Analyst ────────────────────────────────────── */

/** Ask the Analyst to redo a part, or the whole breakdown (its own id), with the person's words. */
export function AskAnalystDialog({ v, item, text: start, onClose }: { v: BreakdownView; item: string; text?: string; onClose(): void }) {
  const act = useReqAct();
  const [text, setText] = useState(start ?? '');
  const whole = item === v.id;
  const part = whole ? null : findPart(v, item);
  const started = v.status === 'approved' && allStories(v).some(({ story }) => story.ticket);
  const send = () =>
    act.mutate(
      { path: `${base(v.id)}/items/${encodeURIComponent(item)}/redo`, body: { ask: text.trim() }, done: `The Analyst is redoing ${whole ? 'the breakdown' : item}.` },
      { onSuccess: onClose },
    );
  return (
    <Modal
      title={whole ? 'Ask the Analyst' : `Ask the Analyst to redo ${item}`}
      onClose={onClose}
      footer={
        <>
          <span className="rq-fcmd">
            <Cmd text={`squad requirements redo ${v.id} ${item} ${shellQuote(text.trim() || 'what to change')}`} />
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={!text.trim() || act.isPending} onClick={send}>
            Ask the Analyst
          </button>
        </>
      }
    >
      <Written
        as="p"
        text={`${
          whole
            ? 'Say what to change in the breakdown, or what to add. The Analyst rewrites it and keeps the keys of what stays.'
            : `Say what to change in ${item} ${part?.item.title ?? ''}. The Analyst rewrites it and keeps its key.`
        }${started ? ' Stories that started stay as they are.' : ''}`}
      />
      <div className="field">
        <label htmlFor="rq-ask">What should change</label>
        <textarea id="rq-ask" className="textarea" autoFocus dir={typedDir(text)} value={text} onChange={(e) => setText(e.target.value)} placeholder={whole ? 'Add a story for staff to export bookings, under Admin and reports.' : 'Split it in two: one for holding the slot, one for freeing it.'} />
      </div>
    </Modal>
  );
}

/* ── Add a part ─────────────────────────────────────────── */

/** "+ Add an epic", "+ Add a feature", "+ Add a story": its title and where it goes. The rest is filled in on its panel. */
export function AddPartDialog({ v, level, under, onClose, onAdded }: { v: BreakdownView; level: BreakdownLevel; under?: string; onClose(): void; onAdded(key: string): void }) {
  const act = useReqAct<{ key: string; breakdown: BreakdownView }>();
  const places = useMemo(
    () =>
      level === 'feature'
        ? v.epics.map((e) => ({ key: e.key, label: `${e.key} ${e.title}` }))
        : level === 'story'
          ? v.epics.flatMap((e) => [...e.features.map((f) => ({ key: f.key, label: `${e.title} › ${f.title}` })), { key: e.key, label: `${e.title}, straight under the epic` }])
          : [],
    [v.epics, level],
  );
  const [where, setWhere] = useState(under && places.some((p) => p.key === under) ? under : (places.at(level === 'story' ? 0 : -1)?.key ?? ''));
  const [title, setTitle, clearTitle] = useDraft(v.id, `add-${level}-title`, '');
  const [about, setAbout, clearAbout] = useDraft(v.id, `add-${level}-about`, '');
  const word = level === 'epic' ? 'an epic' : `a ${level}`;
  const blocked = !title.trim() || (level !== 'epic' && !where) || act.isPending;
  const add = () => {
    if (blocked) return;
    act.mutate(
      {
        path: `${base(v.id)}/items`,
        body: { title: title.trim(), ...(level !== 'epic' ? { under: where, level } : {}), ...(about.trim() ? (level === 'epic' ? { goal: about.trim() } : level === 'feature' ? { summary: about.trim() } : { story: about.trim() }) : {}) },
      },
      {
        onSuccess: (r) => {
          clearTitle();
          clearAbout();
          onAdded(r.key);
          onClose();
        },
      },
    );
  };
  return (
    <Modal
      title={`Add ${word}`}
      onClose={onClose}
      footer={
        <>
          <span className="rq-fcmd">
            <Cmd text={`squad requirements add-item ${v.id}${level !== 'epic' ? ` --under ${where}` : ''}${level === 'feature' ? ' --feature' : ''} --title ${shellQuote(title.trim() || '…')}`} />
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={blocked} onClick={add}>
            Add {word}
          </button>
        </>
      }
    >
      {level !== 'epic' && (
        <div className="field">
          <label htmlFor="rq-under">Under</label>
          <select id="rq-under" className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
            {places.map((p) => (
              <option key={p.key} value={p.key}>
                {isolated(p.label)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="rq-title">Title</label>
        <input id="rq-title" className="input" autoFocus dir={typedDir(title)} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      </div>
      <div className="field">
        <label htmlFor="rq-about">{level === 'epic' ? 'What it is for' : level === 'feature' ? 'What it covers' : 'Story'}</label>
        <textarea id="rq-about" className="textarea" dir={typedDir(about)} value={about} onChange={(e) => setAbout(e.target.value)} placeholder={level === 'story' ? 'As a …, I want …, so that …' : 'One or two sentences'} />
      </div>
      {level === 'story' && <p className="note">Add its "done when" checks on its panel before you approve.</p>}
    </Modal>
  );
}

/* ── Left out ───────────────────────────────────────────── */

/** The parts left out on purpose, each with why, its place in the BRD, and Ask the Analyst to add it. */
export function LeftOutDialog({ v, onClose, onOpenRef, onAsk }: { v: BreakdownView; onClose(): void; onOpenRef(ref: BrdRef): void; onAsk?(text: string): void }) {
  return (
    <Modal title={`${v.leftOut.length} ${v.leftOut.length === 1 ? 'part' : 'parts'} left out`} onClose={onClose}>
      <p>Parts of the BRD the breakdown leaves out on purpose, and why. Ask the Analyst to add one if it should be built.</p>
      <div className="rq-leftout">
        {v.leftOut.map((l, i) => (
          <div key={i} className="rq-lo">
            <Written as="b" text={l.text} />
            <Written text={l.why} />
            <div className="rq-lo-acts">
              {l.ref && (
                <button className="rq-link" onClick={() => onOpenRef(l.ref!)}>
                  <Written text={refWords(l.ref)} />
                </button>
              )}
              {onAsk && (
                <button className="btn sm" onClick={() => onAsk(leftOutAsk(l))} title={`squad requirements redo ${v.id} ${v.id} ${shellQuote(leftOutAsk(l))}`}>
                  <MessageCircle size={13} /> Ask the Analyst to add it
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ── Delete a breakdown ─────────────────────────────────── */

function Lines({ items, ok }: { items: string[]; ok?: boolean }) {
  return (
    <ul className="rmlist">
      {items.map((l) => (
        <li key={l}>
          {ok ? <Check size={16} className="ok" aria-hidden /> : <X size={16} className="x" aria-hidden />}
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Delete a breakdown: what goes and what stays, asked once. squad-kit refuses while its stories build or the Analyst
 * works on it, and the dialog says so in its words. `squad requirements delete BR-1`.
 */
export function DeleteBreakdownDialog({ id, title, sentTo, onClose, onDeleted }: { id: string; title: string; sentTo?: string; onClose(): void; onDeleted?(): void }) {
  const act = useReqAct();
  const [error, setError] = useState<string | null>(null);
  const del = () =>
    act.mutate(
      { path: base(id), method: 'DELETE', quiet: true, done: `Deleted ${id}.` },
      {
        onSuccess: () => {
          onClose();
          onDeleted?.();
        },
        onError: (err) => setError(plainError(err)),
      },
    );
  return (
    <Modal
      title={`Delete ${id}?`}
      icon={
        <span className="glyph">
          <Trash2 size={15} />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" disabled={act.isPending} onClick={del}>
            <Trash2 size={15} /> {act.isPending ? 'Deleting…' : `Delete ${id}`}
          </button>
          <button className="btn" onClick={onClose}>
            {error ? 'Keep it' : 'Cancel'}
          </button>
          <span className="grow" />
          <Cmd text={`squad requirements delete ${id}`} />
        </>
      }
    >
      <Written as="p" text={title} />
      {error && (
        <div className="stuckbox rm-gap" role="alert">
          {error}
        </div>
      )}
      <div className="lbl">This removes</div>
      <Lines items={['The breakdown: its epics, features and stories, and what was decided for you', `The document, its text and its pictures (.squad/requirements/${id})`, "What this computer kept about it: the Analyst's progress and the build switch"]} />
      <div className="lbl">This stays</div>
      <Lines ok items={['Tickets that started from its stories, with their code and history', ...(sentTo ? [`Its items in ${sentTo}: squad-kit never deletes there`] : [])]} />
      <p className="rm-note">It cannot be deleted while its stories build. Wait until they merge, or delete those tickets first.</p>
    </Modal>
  );
}

/** One choice in a breakdown's "…" menu. */
export interface MenuChoice {
  key: string;
  label: ReactNode;
  onPick(): void;
  danger?: boolean;
  /** The same action in the terminal, on hover. */
  title?: string;
}

/** The "…" button of a breakdown, in its header and on its row in the list. */
export function BreakdownMenu({ choices, label = 'More actions' }: { choices: MenuChoice[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    // Escape closes the menu only: it is marked as used, so the page does not close its panel too.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  if (!choices.length) return null;
  return (
    <span className="more rq-more" ref={ref}>
      <button className="iconbtn" aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label} onClick={() => setOpen(!open)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="more-menu" role="menu">
          {choices.map((c) => (
            <button
              key={c.key}
              role="menuitem"
              className={c.danger ? 'danger' : ''}
              title={c.title}
              onClick={() => {
                setOpen(false);
                c.onPick();
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ── The document ───────────────────────────────────────── */

/** The PDF itself, at its page: the browser's own viewer opens it in a new tab. */
export function pdfLink(v: BreakdownView, ref?: BrdRef): string {
  return `${reqFileUrl(v.id, v.source.file)}${ref?.page ? `#page=${ref.page}` : ''}`;
}

async function readPart(id: string, file: string): Promise<string> {
  const res = await fetch(reqFileUrl(id, file));
  if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `${res.status}`);
  return res.text();
}

/** The document's text, as the Analyst read it, opened at the section a part comes from. */
export function BrdViewer({ v, at, onClose }: { v: BreakdownView; at?: BrdRef; onClose(): void }) {
  const [parts, setParts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const count = Math.max(1, v.source.kind === 'pdf' ? 0 : (v.source.pages ?? 1));
  useEffect(() => {
    let live = true;
    const files = Array.from({ length: count }, (_, i) => `text/part-${String(i + 1).padStart(2, '0')}.md`);
    void Promise.all(files.map((f) => readPart(v.id, f).catch(() => '')))
      .then((texts) => {
        if (!live) return;
        if (!texts.some(Boolean)) setError('squad-kit could not open the text of this document. Download the original instead.');
        setParts(texts);
      })
      .catch(() => live && setError('squad-kit could not open the text of this document.'));
    return () => {
      live = false;
    };
  }, [v.id, count]);
  // Opened at a place: scroll to its heading and mark it.
  useEffect(() => {
    if (!parts || !at || !body.current) return;
    const heads = [...body.current.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const wanted = (h: Element) => {
      const t = (h.textContent ?? '').trim().toLowerCase();
      return (at.section && (t === at.section.toLowerCase() || t.startsWith(`${at.section.toLowerCase()} `))) || (at.title && t.includes(at.title.toLowerCase()));
    };
    const hit = heads.find(wanted);
    if (hit) {
      hit.classList.add('rq-hit');
      hit.scrollIntoView({ block: 'start' });
    }
  }, [parts, at]);
  const media = (src: string) => (/^(https?:|data:)/.test(src) ? src : reqFileUrl(v.id, src.replace(/^(\.\.\/)+/, '')));
  return (
    <Modal
      wide
      title={v.source.name}
      onClose={onClose}
      footer={
        <>
          {at && <Written className="note" text={refWords(at)} />}
          <span className="grow" />
          <a className="btn" href={reqFileUrl(v.id, v.source.file)} target="_blank" rel="noreferrer" download={v.source.name}>
            <Download size={14} /> The original
          </a>
          <button className="btn pri" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="rq-doc" ref={body}>
        {error ? (
          <p className="rq-err">{error}</p>
        ) : !parts ? (
          <p className="note">Opening the document…</p>
        ) : (
          parts.map((t, i) => (
            <ReactMarkdown
              key={i}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeLang] as unknown as Options['rehypePlugins']}
              components={{
                img: ({ src, alt }) => <img src={src ? media(src) : ''} alt={alt ?? ''} loading="lazy" />,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children} <ExternalLink size={11} />
                  </a>
                ),
              }}
            >
              {t}
            </ReactMarkdown>
          ))
        )}
      </div>
    </Modal>
  );
}

/** Opens a place in the document: the PDF at its page in a new tab, any other kind in the viewer. */
export function useOpenRef(v: BreakdownView | undefined): { open(ref?: BrdRef): void; viewer: BrdRef | null | undefined; close(): void } {
  const [viewer, setViewer] = useState<BrdRef | null | undefined>(undefined);
  return {
    open: (ref?: BrdRef) => {
      if (!v) return;
      if (v.source.kind === 'pdf') window.open(pdfLink(v, ref), '_blank', 'noopener');
      else setViewer(ref ?? null);
    },
    viewer,
    close: () => setViewer(undefined),
  };
}

/** The stories a story may need: every other story, with its title. */
export function needOptions(v: BreakdownView, key: string, have: string[]): { key: string; label: string }[] {
  return allStories(v)
    .filter(({ story }) => story.key !== key && !have.includes(story.key))
    .map(({ story }) => ({ key: story.key, label: `${story.key} ${story.title}` }));
}
