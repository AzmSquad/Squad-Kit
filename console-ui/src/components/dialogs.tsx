import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bug, Check, Copy, Download, Loader2, Paperclip, PenLine, Plus, Rocket, RotateCcw, Sparkles, X } from 'lucide-react';
import type { DraftJob, Release, Ticket, TicketDraft as Draft, Track, TrackerStatus } from '../api/types';
import { api, send, PROJECT } from '../api/client';
import { useAct, useBoard } from '../lib/data';
import { usePrefs } from '../lib/prefs';
import { shellArg, shellQuote } from '../lib/text';
import { Cmd, Modal, DraftNote, Written, WrittenLines } from './ui';
import { OutsideNewButton } from './Outside';
import { ErrorCard } from './ErrorCard';
import { clearDrafts, keptOnce, useDraft } from '../lib/drafts';
import { langProps, typedDir } from '../lib/lang';
import { WORDS, draftShows, langOf } from '../lib/split';
import { DraftSizeButtons, DraftSuggestion } from './split/DraftSize';

export interface PickedFile {
  name: string;
  size: number;
  data: string;
  /** A local preview for pictures. */
  preview?: string;
}

const MAX_FILE = 10 * 1024 * 1024;

export function readFile(f: File): Promise<PickedFile> {
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

/** A local preview for a picture that came back from the server, as the picker makes for a picked one. */
function previewOf(f: { name: string; data: string }): { preview?: string } {
  const ext = /\.(png|jpe?g|gif|webp)$/i.exec(f.name)?.[1]?.toLowerCase();
  return ext ? { preview: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${f.data}` } : {};
}

/**
 * A new ticket, written by hand or filled in by the Analyst from a pasted idea or chat message. Either way the person
 * sees every field, with its acceptance criteria, business rules, edge cases and files, before it is created.
 */
const NEW_TICKET = 'new-ticket';

function oneTimeKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function NewTicketDialog({ onClose, onCreated }: { onClose(): void; onCreated(t: Ticket): void }) {
  const act = useAct<Ticket>();
  const { toast } = usePrefs();
  // Closing it by accident loses nothing: it opens again with what was typed. Files cannot be kept that way, so Esc, the
  // cross and a click outside ask first when there are any.
  const [mode, setMode] = useDraft<'write' | 'paste'>(NEW_TICKET, 'mode', 'write');
  const [pasted, setPasted] = useDraft(NEW_TICKET, 'pasted', '');
  // The Analyst's draft, kept on the server: closing the dialog leaves it working, and it waits here next time.
  const [job, setJob] = useState<DraftJob | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const drafting = job?.status === 'working';
  const [gaps, setGaps] = useState<string[] | null>(null);
  // How its size was settled, sent with Create: judged one story, or made as one over the Analyst's suggestion.
  const [sized, setSized] = useState<'checked' | 'kept' | 'brd' | null>(null);
  const [title, setTitle] = useDraft(NEW_TICKET, 'title', '');
  const [ask, setAsk] = useDraft(NEW_TICKET, 'ask', '');
  const [kind, setKind] = useDraft<Ticket['kind']>(NEW_TICKET, 'kind', 'feature');
  const [priority, setPriority] = useDraft<Ticket['priority']>(NEW_TICKET, 'priority', 'normal');
  const [track, setTrack] = useDraft<Track>(NEW_TICKET, 'track', 'full');
  const [talkFirst, setTalkFirst] = useState(false);
  // "Write new tests", on by default, on any track. An engineer can keep it on for every story of the project.
  const [newTests, setNewTests] = useDraft(NEW_TICKET, 'new-tests', true);
  const board = useBoard();
  const testsAlways = Boolean(board.data?.ready && board.data.meta.alwaysNewTests);
  const noNewTests = !newTests && !testsAlways;
  const [suggested, setSuggested] = useState<Track | null>(null);
  const [criteria, setCriteria] = useDraft<string[]>(NEW_TICKET, 'criteria', []);
  const [rules, setRules] = useDraft<string[]>(NEW_TICKET, 'rules', []);
  const [edgeCases, setEdgeCases] = useDraft<string[]>(NEW_TICKET, 'edge-cases', []);
  // The bug template: what happens, how to see it, what should happen, where, and how bad.
  const [what, setWhat] = useDraft(NEW_TICKET, 'what', '');
  const [steps, setSteps] = useDraft<string[]>(NEW_TICKET, 'steps', []);
  const [expected, setExpected] = useDraft(NEW_TICKET, 'expected', '');
  const [where, setWhere] = useDraft(NEW_TICKET, 'where', '');
  const [severity, setSeverity] = useDraft<NonNullable<Ticket['severity']>>(NEW_TICKET, 'severity', 'annoying');
  const isBug = kind === 'bug';
  // Create is safe to send again: a lost reply, Try again or this window opened again gets the ticket it made.
  const [createKey, setCreateKey] = useState(() => keptOnce(NEW_TICKET, 'create-key', oneTimeKey));
  const closedWhileMaking = useRef(false);
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

  const takeDraft = (d: Draft) => {
    setTitle(d.title);
    setAsk(d.ask);
    if (d.kind === 'bug') setWhat(d.ask);
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
  };

  // Opened again: the draft that waits under New ticket comes back, with the text and files it was made from.
  useEffect(() => {
    let live = true;
    void api<{ draft: DraftJob | null }>('/api/v1/tickets/draft/current')
      .then(async ({ draft }) => {
        if (!live || !draft) return;
        setPasted(draft.text);
        setMode('paste');
        setJob(draft);
        if (draft.files.length) {
          const back = await api<{ files: { name: string; data: string }[] }>(`/api/v1/tickets/draft/${draft.id}/files`).catch(() => ({ files: [] }));
          if (live) setFiles(back.files.map((f, i) => ({ ...f, size: draft.files[i]?.size ?? 0, ...previewOf(f) })));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // While the Analyst works, ask how it goes every second.
  const poll = useQuery({
    queryKey: ['ticket-draft', job?.id],
    queryFn: () => api<DraftJob>(`/api/v1/tickets/draft/${job!.id}`),
    enabled: drafting,
    refetchInterval: 1000,
    retry: false,
  });
  useEffect(() => {
    // An answer still on its way after Cancel does not bring the draft back to life.
    if (poll.data && job?.status === 'working' && poll.data.id === job.id) setJob(poll.data);
  }, [poll.data]);
  useEffect(() => {
    // The app restarted and forgot it: say so where the person is looking, with the text still here.
    if (poll.isError && drafting) setJob((j) => j && { ...j, status: 'failed', error: 'squad-kit lost this draft, maybe because it restarted.' });
  }, [poll.isError]);
  const used = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status === 'done' && job.draft && used.current !== job.id) {
      used.current = job.id;
      // More than one story: its suggestion waits here, and the form only after "as one".
      if (draftShows(job.draft) === 'one') {
        takeDraft(job.draft);
        setSized('checked');
      }
    }
  }, [job]);

  const fill = async () => {
    setStartError(null);
    try {
      setJob(await send<DraftJob>('/api/v1/tickets/draft', 'POST', { text: pasted, files: upload }));
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  };
  const cancel = async () => {
    if (!job) return;
    try {
      setJob(await send<DraftJob>(`/api/v1/tickets/draft/${job.id}/cancel`, 'POST'));
    } catch {
      setJob({ ...job, status: 'cancelled' });
    }
  };
  /** The draft no longer waits under New ticket: it was used, or put aside. */
  const letGo = () => {
    if (job) void send(`/api/v1/tickets/draft/${job.id}/dismiss`, 'POST').catch(() => undefined);
    setJob(null);
  };
  // The Analyst could not help: the person writes the ticket, starting from what they pasted.
  const writeMyself = () => {
    letGo();
    setStartError(null);
    if (!ask.trim()) setAsk(pasted.trim());
    if (!what.trim()) setWhat(pasted.trim());
    setMode('write');
  };
  const discard = () => {
    letGo();
    setGaps(null);
    setSized(null);
    setSuggested(null);
    for (const clear of [setTitle, setAsk, setWhat, setExpected, setWhere]) clear('');
    for (const clear of [setCriteria, setRules, setEdgeCases, setSteps]) clear([]);
    setMode('paste');
  };
  /** Clear on the draft line: an empty form again. */
  const clearAll = () => {
    discard();
    setPasted('');
    setFiles([]);
    setMode('write');
    setKind('feature');
    setPriority('normal');
    setTrack('full');
    setNewTests(true);
    setSeverity('annoying');
    clearDrafts(PROJECT, NEW_TICKET);
    setCreateKey(keptOnce(NEW_TICKET, 'create-key', oneTimeKey));
  };
  const typed = Boolean(pasted || title || ask || what || expected || where || criteria.length || rules.length || edgeCases.length || steps.length);

  const bugSteps = steps.filter((x) => x.trim());
  const bugAsk = [
    what.trim() && `What happens:\n${what.trim()}`,
    bugSteps.length && `Steps to see it:\n${bugSteps.map((x, i) => `${i + 1}. ${x.trim()}`).join('\n')}`,
    expected.trim() && `What should happen:\n${expected.trim()}`,
    where.trim() && `Where: ${where.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const body = isBug
    ? { title, ask: bugAsk, kind, severity, priority: severity === 'stops-work' ? 'high' : severity === 'small' ? 'low' : 'normal', track, files: upload, talkFirst: talkFirst && track === 'full', noNewTests, key: createKey, ...(sized ? { sized } : {}) }
    : { title, ask, kind, track, priority, criteria, rules, edgeCases, files: upload, talkFirst: talkFirst && track === 'full', noNewTests, key: createKey, ...(sized ? { sized } : {}) };

  const submit = () =>
    act.mutate(
      {
        path: '/api/v1/tickets',
        body,
        // The effects saving the fields ran already, and nothing changes them again before the dialog goes.
        after: () => {
          letGo();
          clearDrafts(PROJECT, NEW_TICKET);
        },
        done: (t) => (closedWhileMaking.current ? `${t.id} is on the board.` : null),
      },
      {
        onSuccess: (t) => {
          onCreated(t);
          onClose();
        },
      },
    );
  // Create cannot be called back once it is on its way, so closing says what really happens to it.
  const close = () => {
    if (act.isPending) {
      closedWhileMaking.current = true;
      toast('Your ticket is still being made. Closing this does not stop it: it comes onto the board in a moment.');
    }
    onClose();
  };

  // The Analyst stopped (an error, or the person pressed Cancel): the ways on show inside the dialog, not in a toast.
  const stuck = Boolean(startError) || job?.status === 'failed' || job?.status === 'cancelled';
  // More than one story, for the text as it is now: the suggestion and its own buttons, before anything is created.
  const bigDraft = mode === 'paste' && job?.status === 'done' && draftShows(job.draft) !== 'one' && job.text === pasted ? job : null;
  const cmd =
    mode === 'paste'
      ? `squad new --from ${shellQuote(pasted.trim().split('\n')[0]?.slice(0, 40) || 'your message')}`
      : [
          `squad new ${shellQuote(title.trim() || 'Your title')}`,
          isBug ? `--bug --severity ${severity}` : '',
          isBug && what.trim() ? `--ask ${shellQuote(what.trim())}` : '',
          track === 'express' ? '--express' : '',
          talkFirst && track === 'full' ? '--talk' : '',
          noNewTests ? '--no-new-tests' : '',
          ...(isBug ? [] : criteria.filter((x) => x.trim()).map((x) => `--criteria ${shellQuote(x)}`)),
          ...(isBug ? [] : rules.filter((x) => x.trim()).map((x) => `--rule ${shellQuote(x)}`)),
          ...(isBug ? [] : edgeCases.filter((x) => x.trim()).map((x) => `--edge ${shellQuote(x)}`)),
          ...files.map((f) => `--attach ${shellQuote(f.name)}`),
        ]
          .filter(Boolean)
          .join(' ');

  return (
    <Modal
      title="New ticket"
      wide
      onClose={close}
      losing={files.length && !act.isPending ? (files.length === 1 ? 'the attached file' : `the ${files.length} attached files`) : null}
      icon={<span className="glyph"><Plus size={15} /></span>}
      footer={
        bigDraft ? (
          <DraftSizeButtons
            job={bigDraft}
            onOne={(as) => {
              setSized(as);
              takeDraft(bigDraft.draft!);
            }}
            onCancel={close}
            onMade={(first) => {
              clearDrafts(PROJECT, NEW_TICKET);
              if (first) onCreated(first);
              onClose();
            }}
          />
        ) : (
          <>
            {mode === 'paste' ? (
              stuck ? null : (
                <button className="btn pri" disabled={(!pasted.trim() && !files.length) || drafting} onClick={() => void fill()}>
                  {drafting ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {drafting ? 'Filling in…' : 'Fill in the ticket'}
                </button>
              )
            ) : (
              <button className="btn pri" disabled={!title.trim() || act.isPending} onClick={submit}>
                <Plus size={15} /> Create ticket
              </button>
            )}
            {/* While the Analyst works, Cancel stops it; closing the window (the cross) leaves it working. */}
            <button className="btn" onClick={drafting ? () => void cancel() : close}>{act.isPending ? 'Close' : 'Cancel'}</button>
            {typed && !drafting && <DraftNote onClear={clearAll} />}
            {!typed && !drafting && <OutsideNewButton />}
            <span className="grow" />
            <Cmd text={cmd} />
          </>
        )
      }
    >
      <div className="seg" style={{ marginBottom: 14, width: 'fit-content' }}>
        {/* The draft fills in this form when it is ready, so writing it waits until the Analyst is done or cancelled. */}
        <button className={mode === 'write' ? 'on' : ''} disabled={drafting} title={drafting ? 'Press Cancel first to write it yourself' : undefined} onClick={() => setMode('write')}>
          Write it
        </button>
        <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>
          <Sparkles size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
          From an idea or message
        </button>
      </div>

      {mode === 'paste' ? (
        <>
          {!drafting && !bigDraft && <p>Paste an idea, a WhatsApp message or one line of business. Add screenshots if you have them. The Analyst fills in the ticket, and you check every field before it is created.</p>}
          <div className="field">
            <label htmlFor="nt-paste">The idea or message</label>
            <textarea
              id="nt-paste"
              className="textarea"
              style={{ minHeight: drafting || bigDraft ? 70 : 150 }}
              autoFocus
              readOnly={drafting}
              dir={typedDir(pasted)}
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
          {drafting && job ? (
            <>
              {files.length > 0 && <p className="note" style={{ margin: '-6px 0 12px' }}>With {files.map((f) => f.name).join(', ')}</p>}
              <DraftProgress job={job} />
            </>
          ) : bigDraft ? (
            files.length > 0 && <p className="note" style={{ margin: '-6px 0 12px' }}>With {files.map((f) => f.name).join(', ')}</p>
          ) : (
            <FilePicker files={files} onAdd={addFiles} onRemove={(i) => setFiles((now) => now.filter((_, k) => k !== i))} />
          )}
          {bigDraft && <DraftSuggestion job={bigDraft} />}
          {stuck && (
            <DraftStopped
              error={startError ?? (job?.status === 'failed' ? (job.error ?? 'Something went wrong.') : null)}
              onRetry={() => void fill()}
              onWrite={writeMyself}
            />
          )}
        </>
      ) : (
        <>
          {gaps ? (
            <div className="drafted">
              <b><Sparkles size={13} /> The Analyst filled this in from your message.</b> Check it and change anything.{' '}
              <button className="linkbtn" onClick={discard}>Discard this draft</button>
              {sized === 'brd' && <div style={{ marginTop: 6 }}>{WORDS[langOf(pasted)].brd.also}</div>}
              {gaps.length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}>Still unclear, so the Analyst will ask you after you create it:</div>
                  <ul>{gaps.map((g, i) => <Written as="li" key={i} text={g} />)}</ul>
                </>
              )}
            </div>
          ) : (
            <p>{isBug ? 'Say what goes wrong and how to see it. The squad finds the cause and fixes it.' : 'Write it in plain words. Add what you already know; the Analyst asks you about the rest.'}</p>
          )}
          <div className="field">
            <label>Kind</label>
            <div className="sevs">
              {(['feature', 'bug'] as const).map((k) => (
                <button key={k} className={`choice ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  <span className="rd" />
                  {k === 'feature' ? 'New feature' : 'Bug'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="nt-title">Title</label>
            <input
              id="nt-title"
              className="input"
              autoFocus
              dir={typedDir(title)}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isBug ? 'For example: A price written as 1,500 is refused' : 'For example: Show hearing time in local time'}
            />
          </div>
          {isBug ? (
            <>
              <div className="field">
                <label htmlFor="nt-what">What happens</label>
                <textarea id="nt-what" className="textarea" dir={typedDir(what)} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="For example: the form says the price is not valid." />
              </div>
              <ListField label="Steps to see it" hint="One step per line, for example: Open Services and add a service." items={steps} onChange={setSteps} add="Add a step" />
              <div className="field">
                <label htmlFor="nt-expected">What should happen</label>
                <textarea id="nt-expected" className="textarea" dir={typedDir(expected)} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="For example: the price is saved as 1,500 SAR." />
              </div>
              <div className="field">
                <label htmlFor="nt-where">Where</label>
                <input id="nt-where" className="input" dir={typedDir(where)} value={where} onChange={(e) => setWhere(e.target.value)} placeholder="The page or link, for example: Setup, Services" />
              </div>
              <FilePicker files={files} onAdd={addFiles} onRemove={(i) => setFiles((now) => now.filter((_, k) => k !== i))} />
              <div className="field">
                <label>How bad is it?</label>
                <div className="sevs">
                  {SEVERITY.map((x) => (
                    <button key={x.value} className={`choice ${severity === x.value ? 'on' : ''}`} onClick={() => setSeverity(x.value)}>
                      <span className="rd" />
                      {x.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="nt-ask">What do you want?</label>
                <textarea id="nt-ask" className="textarea" dir={typedDir(ask)} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Who needs it, and why. One or two sentences is enough." />
              </div>
              <ListField label="Acceptance criteria" hint="Each one is something you can check, for example: The clerk sees the time in their own city." items={criteria} onChange={setCriteria} add="Add a criterion" />
              <ListField label="Business rules" hint="Limits and who may do what, for example: Only a team lead can reassign a case." items={rules} onChange={setRules} add="Add a rule" />
              <ListField label="Edge cases" hint="Unusual cases to handle, for example: The person has no cases yet." items={edgeCases} onChange={setEdgeCases} add="Add an edge case" />
              <FilePicker files={files} onAdd={addFiles} onRemove={(i) => setFiles((now) => now.filter((_, k) => k !== i))} />
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
            </>
          )}
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
          {track === 'full' && (
            <label className="talkfirst">
              <input type="checkbox" checked={talkFirst} onChange={(e) => setTalkFirst(e.target.checked)} />
              <span>
                <b>Talk it through first.</b> The Analyst opens a chat instead of sending questions. The spec is written from your talk when you say so.
              </span>
            </label>
          )}
          {!testsAlways && (
            <label className="talkfirst">
              <input type="checkbox" checked={newTests} onChange={(e) => setNewTests(e.target.checked)} />
              <span>
                <b>Write new tests.</b> The Builder writes tests for every "done when". Turn it off for a demo, a small text or colour change, or a
                project with no tests yet: squad-kit still runs your project's own checks, the review and the proof, and the story says "Built
                without new tests".
              </span>
            </label>
          )}
        </>
      )}
    </Modal>
  );
}

/** The usual time a draft takes, said up front; past this the dialog says it is taking longer. */
const USUAL_SECONDS = 60;

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The Analyst at work: three steps, what it is looking at, and a clock against the usual time. */
function DraftProgress({ job }: { job: DraftJob }) {
  const now = useNow(true);
  const seconds = Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000));
  const order = ['read', 'look', 'write'] as const;
  const at = order.indexOf(job.step);
  const state = (i: number) => (i < at ? 'done' : i === at ? 'now' : 'todo');
  const shown = job.looked.slice(-3);
  const more = job.looked.length - shown.length;
  return (
    <div className="drafting" role="status" aria-live="polite">
      <div className="drafting-head">
        <b>The Analyst is filling in your ticket</b>
        <span className="grow" />
        <span className="mono drafting-clock" aria-label={`${seconds} seconds so far`}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </div>
      <DraftStep state={state(0)}>Read your message</DraftStep>
      <DraftStep state={state(1)}>
        Looking at the project
        {shown.length > 0 && (
          <span className="note">
            : {shown.join(', ')}
            {more > 0 ? ` and ${more} more` : ''}
          </span>
        )}
      </DraftStep>
      <DraftStep state={state(2)}>Writing the ticket for you to check</DraftStep>
      <p className="note">
        {seconds > 2 * USUAL_SECONDS ? 'This one is taking longer than usual. You can wait, or press Cancel.' : 'Usually under a minute.'} You can close this window: the draft
        waits for you under New ticket.
      </p>
    </div>
  );
}

function DraftStep({ state, children }: { state: 'done' | 'now' | 'todo'; children: ReactNode }) {
  return (
    <div className={`dstep ${state}`}>
      <span className="dot" aria-hidden="true">
        {state === 'done' ? <Check size={12} strokeWidth={3} /> : state === 'now' ? <Loader2 size={12} className="spin" /> : null}
      </span>
      <span>
        {children}
        <span className="sr-only">{state === 'done' ? ' (done)' : state === 'now' ? ' (now)' : ''}</span>
      </span>
    </div>
  );
}

/** The Analyst stopped. The error stays here until the person picks a way on; the text they pasted is kept. */
function DraftStopped({ error, onRetry, onWrite }: { error: string | null; onRetry(): void; onWrite(): void }) {
  if (error) {
    return (
      <ErrorCard
        title="The Analyst could not finish"
        what={error}
        safe={['Your text and files are kept.', 'No ticket was made yet.']}
        ways={[
          { label: 'Try again', primary: true, icon: <RotateCcw size={14} />, onClick: onRetry },
          { label: 'Write it myself with what I typed', icon: <PenLine size={14} />, onClick: onWrite },
        ]}
      />
    );
  }
  return (
    <div className="drafterr calm" role="status">
      <b>You stopped the Analyst</b>
      <div>Nothing was saved. Your text is kept.</div>
      <div className="drafterr-ways">
        <button className="btn pri" onClick={onRetry}>
          <RotateCcw size={14} /> Try again
        </button>
        <button className="btn" onClick={onWrite}>
          <PenLine size={14} /> Write it myself with what I typed
        </button>
      </div>
    </div>
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
            dir={typedDir(x)}
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
  const speech = useQuery({ queryKey: ['speech'], queryFn: () => api<{ hasKey: boolean; video?: boolean }>('/api/v1/speech'), enabled: hasNotes });
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
            ? speech.data.video === false
              ? 'squad-kit writes out voice notes with Munsit, so every agent knows what was said. Video notes need a Mac: on this computer they stay attached, unheard.'
              : 'squad-kit writes out voice and video notes with Munsit, and takes pictures of the screen in videos, so every agent knows what was said.'
            : 'Add a Munsit key in Settings so the squad can listen to voice and video notes. Without it they stay attached, unheard.'}
        </p>
      )}
    </div>
  );
}

export function PullDialog({ onClose, onCreated }: { onClose(): void; onCreated(t: Ticket): void }) {
  const act = useAct<Ticket>();
  // The connected tracker says how its items are written: AB#40, #40.
  const tracker = useQuery({ queryKey: ['tracker'], queryFn: () => api<TrackerStatus>('/api/v1/tracker') }).data;
  const example = tracker?.example ?? 'AB#40';
  const [ref, setRef] = useState(example.replace(/\d+$/, ''));
  const blocked = ref.replace(/\D/g, '').length === 0 || act.isPending;
  const submit = () => {
    if (blocked) return;
    act.mutate({ path: '/api/v1/pull', body: { ref } }, { onSuccess: (t) => (onCreated(t), onClose()) });
  };
  return (
    <Modal
      title={`Pull from ${tracker?.label ?? 'the tracker'}`}
      onClose={onClose}
      icon={<span className="glyph"><Download size={15} /></span>}
      footer={
        <>
          <button className="btn pri" disabled={blocked} onClick={submit}>
            <Download size={15} /> Pull ticket
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <Cmd text={`squad pull ${shellArg(ref.trim() || example)}`} />
        </>
      }
    >
      <p>Bring an item in as a ticket, with its description and attachments.</p>
      <div className="field">
        <label htmlFor="pull-ref">Item</label>
        <input id="pull-ref" className="input mono" autoFocus value={ref} placeholder={example} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
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
  // Closing it by accident loses nothing: it opens again with what was typed.
  const [what, setWhat, clearWhat] = useDraft('report-bug', 'what', '');
  const [how, setHow, clearHow] = useDraft('report-bug', 'how', '');
  const [expected, setExpected, clearExpected] = useDraft('report-bug', 'expected', '');
  const [severity, setSeverity] = useState<NonNullable<Ticket['severity']>>('annoying');
  const clear = () => {
    clearWhat();
    clearHow();
    clearExpected();
  };
  const submit = () =>
    act.mutate(
      { path: '/api/v1/bugs', body: { what, how, expected, severity, foundIn }, done: 'Bug reported. Triage is sorting it.' },
      {
        onSuccess: () => {
          clear();
          onClose();
        },
      },
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
          {(what || how || expected) && <DraftNote onClear={clear} />}
          <span className="grow" />
          <Cmd text={`squad bug ${shellQuote(what.trim() || 'What happened')}${foundIn ? ` --in ${foundIn}` : ''}`} />
        </>
      }
    >
      <p>It becomes a ticket linked to {foundIn ?? 'the latest release'}, and goes around the same loop. The Tester adds a check so it can't come back.</p>
      <div className="field">
        <label htmlFor="bug-what">What happened?</label>
        <input id="bug-what" className="input" autoFocus dir={typedDir(what)} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="For example: Table text is hard to read in dark mode" />
      </div>
      <div className="field">
        <label htmlFor="bug-how">How can we see it?</label>
        <input id="bug-how" className="input" dir={typedDir(how)} value={how} onChange={(e) => setHow(e.target.value)} placeholder="The steps, in a line" />
      </div>
      <div className="field">
        <label htmlFor="bug-exp">What did you expect?</label>
        <input id="bug-exp" className="input" dir={typedDir(expected)} value={expected} onChange={(e) => setExpected(e.target.value)} />
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
    release.addons.tag && `Marked the code as ${release.version}`,
    release.addons.pipeline && 'After-release step started',
  ].filter(Boolean) as string[];
  return (
    <Modal
      title={release.unpushed?.length ? `${release.version} is made, but not sent yet` : `${release.version} is released`}
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
        {release.unpushed?.length ? (
          <div style={{ color: 'var(--you-ink)' }}>
            <span style={{ width: 16, textAlign: 'center', fontWeight: 800 }}>!</span> It did not reach your team's shared copy of the code, so its tickets stay open. Press Send again on the release once it can.
          </div>
        ) : (
          <div><Check size={16} /> {release.tickets.length} tickets released</div>
        )}
        {release.log
          ? release.log.map((l) => (
              <div key={l.text} style={l.ok ? undefined : { color: 'var(--you-ink)' }} {...langProps(l.text)}>
                {l.ok ? <Check size={16} /> : <span style={{ width: 16, textAlign: 'center', fontWeight: 800 }}>!</span>} <Written text={l.text} />
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
          <WrittenLines className="wa" text={release.whatsappDraft} />
        </>
      )}
    </Modal>
  );
}
