import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, GitBranch, PenLine, Rocket, Undo2 } from 'lucide-react';
import { ApiError, api, send } from '../api/client';
import type { BranchPlan, Release, ReleaseWithItems } from '../api/types';
import { useAct, useBoard, useReleases } from '../lib/data';
import { BrokenTickets } from './Board';
import { partNames } from '../lib/overview';
import { BugDialog, ReleasedDialog } from '../components/dialogs';
import { Cmd, CouldNotLoad, Modal, NotesView, Written, dateShort } from '../components/ui';
import { usePrefs } from '../lib/prefs';
import { shellQuote } from '../lib/text';
import { GatePill } from '../components/Gates';
import { langProps, typedDir } from '../lib/lang';

export function ReleasesPage() {
  const releases = useReleases();
  const board = useBoard();
  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState<Release | null>(null);
  const list = releases.data ?? [];
  const current = list.find((r) => r.version === selected) ?? list.find((r) => r.status === 'draft') ?? list[0];
  const demo = board.data?.ready ? board.data.meta.engine === 'demo' : false;
  const broken = board.data?.brokenRecords?.filter((b) => b.kind === 'release') ?? [];

  return (
    <>
      <div className="top">
        <h1>Releases</h1>
        <span className="grow" />
        <Cmd text="squad release" />
      </div>
      {broken.length > 0 && <BrokenTickets list={broken} label="Releases that could not be read" />}
      <div className="split rel">
        <div className="listcol">
          {list.map((r) => (
            <button key={r.version} className={`litem ${current?.version === r.version ? (r.status === 'draft' ? 'on' : 'on plain') : ''}`} onClick={() => setSelected(r.version)}>
              <b>
                {r.version}
                {r.status === 'draft' ? (
                  <span className="youtag">{r.items.length ? 'Ready' : 'Empty'}</span>
                ) : r.bugs?.length ? (
                  <span className="prio">
                    {r.bugs.length} {r.bugs.length === 1 ? 'bug' : 'bugs'}
                  </span>
                ) : null}
              </b>
              {r.status === 'draft' ? 'Next release' : r.unpushed?.length ? 'Not sent yet' : dateShort(r.date)} · {r.items.length} {r.items.length === 1 ? 'ticket' : 'tickets'}
            </button>
          ))}
        </div>
        {current ? <ReleaseDetail r={current} onReleased={setDone} live={!demo} /> : releases.isError && !releases.data ? <CouldNotLoad what="the releases" error={releases.error} onRetry={() => void releases.refetch()} /> : <div className="center">No releases yet.</div>}
      </div>
      {done && <ReleasedDialog release={done} demo={demo} onClose={() => setDone(null)} />}
    </>
  );
}

function ReleaseDetail({ r, onReleased, live }: { r: ReleaseWithItems; onReleased(r: Release): void; live: boolean }) {
  const act = useAct<Release>();
  const board = useBoard();
  const titleOf = (id: string) => (board.data?.ready ? board.data.tickets.find((t) => t.id === id)?.title : undefined) ?? r.titles?.[id] ?? id;
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(r.notes);
  const [confirming, setConfirming] = useState(false);
  // A product with several parts: the person reads which parts go out, and the branches stay with the engineer's details.
  const meta = board.data?.ready ? board.data.meta : undefined;
  const partsOut = meta?.repos?.length ? [...new Set(r.targets.flatMap((g) => partNames(meta.parts, g.repo)))] : [];
  const [bug, setBug] = useState(false);
  const [marking, setMarking] = useState(false);
  useEffect(() => {
    if (!editing) setNotes(r.notes);
  }, [r.notes, editing]);
  const draft = r.status === 'draft';
  const unpushed = r.unpushed ?? [];
  const part = r.version.endsWith('.0') ? 'New features, nothing breaks for users.' : 'Fixes only, nothing new to learn.';

  return (
    <div className="detail">
      <h2 style={{ fontSize: 24, fontStretch: '88%' }}>{draft ? `Release ${r.version}` : r.version}</h2>
      <p className="note" style={{ marginTop: 2 }}>
        {draft ? 'The squad prepared this release. Read it, edit the notes if you like, then release.' : `Released ${dateShort(r.date)}`}
      </p>

      {unpushed.length > 0 && (
        <div className="box" style={{ marginTop: 10, color: 'var(--you-ink)' }}>
          <b>Not sent yet.</b> The release is made on this computer, but it did not reach your team's shared copy of the code, so its tickets stay open.
          {unpushed.map((u) => (
            <div key={u.repo} style={{ marginTop: 6 }}>
              {u.plain ?? 'An engineer can see why below.'}
              <details style={{ marginTop: 4 }}>
                <summary className="note">For engineers</summary>
                <div className="mono" style={{ fontSize: 12.5, marginTop: 4 }}>
                  {u.repo === '.' ? 'project' : u.repo}: {u.base} → {u.remote}: {u.error}
                </div>
              </details>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <button
              className="btn pri"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { path: `/api/v1/releases/${r.version}/push` },
                  { onSuccess: (rel) => (rel.unpushed?.length ? undefined : onReleased(rel)) },
                )
              }
            >
              <Rocket size={15} /> Send again
            </button>
            <button className="btn quiet" disabled={act.isPending} title="An engineer brought it in by hand, so Send again cannot see it. You say how; its tickets close." onClick={() => setMarking(true)}>
              It reached it another way
            </button>
            <span className="grow" />
            <Cmd text={`squad release ${r.version} --push-again`} />
          </div>
        </div>
      )}

      {draft && r.log && r.log.length > 0 && (
        <div className="box" style={{ marginTop: 10 }}>
          <b>Last time it did not go out.</b>
          {r.log.map((l) => (
            <div className="checkrow" key={l.text} style={l.ok ? undefined : { color: 'var(--you-ink)' }} {...langProps(l.text)}>
              <span className={`cbx ${l.ok ? 'on' : ''}`}>{l.ok ? <Check size={11} strokeWidth={3} /> : '!'}</span>
              <Written text={l.text} />
            </div>
          ))}
        </div>
      )}

      <div className="lbl">What's inside</div>
      {r.items.map((it) => (
        <div className="trow" key={it.id}>
          <span className="mono">{it.id}</span>
          <Written as="b" text={it.title} />
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {it.gates?.checks === 'unchecked' ? (
              <GatePill state="unchecked" text="Not checked · review, proof" />
            ) : (
              it.gates && (
                <span className="pill ok">
                  <Check size={13} strokeWidth={2.5} /> Checks, review, proof
                </span>
              )
            )}
            {draft && r.items.length > 1 && (
              <button
                className="btn sm quiet"
                title={`squad release --without ${it.id}`}
                disabled={act.isPending}
                onClick={() => act.mutate({ path: `/api/v1/releases/${r.version}/take-out`, body: { ticket: it.id }, done: `${it.id} goes out with the next release` })}
              >
                Take out
              </button>
            )}
          </span>
        </div>
      ))}
      {r.items.length === 0 && <p className="note">No tickets yet. Tickets join after you check their proof.</p>}
      {draft && r.items.length > 1 && (
        <div style={{ marginTop: 2 }}>
          <Cmd text={`squad release --without ${r.items[r.items.length - 1]!.id}`} />
        </div>
      )}
      {(r.out?.length ?? 0) > 0 && (
        <>
          <div className="lbl">{draft ? 'Taken out of this release' : 'Left out of this release'}</div>
          {r.out!.map((id) => (
            <div className="trow" key={id}>
              <span className="mono">{id}</span>
              <Written as="b" text={titleOf(id)} />
              {draft ? (
                <button
                  className="btn sm"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ path: `/api/v1/releases/${r.version}/put-back`, body: { ticket: id }, done: `${id} is back in ${r.version}` })}
                >
                  <Undo2 size={13} /> Put back
                </button>
              ) : (
                <span className="note">Goes out with the next release</span>
              )}
            </div>
          ))}
          {draft && <p className="note">Its code stays in the project. This release leaves it out, and it goes out with the next one.</p>}
          {draft && (
            <div style={{ marginTop: 6 }}>
              <Cmd text={`squad release --put-back ${r.out![0]}`} />
            </div>
          )}
        </>
      )}

      {!draft && r.bugs && r.bugs.length > 0 && (
        <>
          <div className="lbl">Bugs found after this release</div>
          {r.bugs.map((b) => (
            <div className="trow" key={b}>
              <span className="mono">{b}</span>
              <Link to="/board" search={{ ticket: b }}>
                <b>Open the bug</b>
              </Link>
              <span />
            </div>
          ))}
        </>
      )}

      <div className="grid2">
        <div>
          <div className="lbl">Version</div>
          <div className="ver">
            <span className="from">{r.from.replace(/^v/, '')}</span>
            <ArrowRight size={20} />
            <span>{r.version.replace(/^v/, '')}</span>
          </div>
          <p className="note" style={{ marginTop: 4 }}>{part}</p>
          <div className="lbl">{draft || !r.log ? 'Also' : 'What the release did'}</div>
          {!draft && r.log
            ? r.log.map((l) => (
                <div className="checkrow" key={l.text} style={l.ok ? undefined : { color: 'var(--you-ink)' }} {...langProps(l.text)}>
                  <span className={`cbx ${l.ok ? 'on' : ''}`}>{l.ok ? <Check size={11} strokeWidth={3} /> : '!'}</span>
                  <Written text={l.text} />
                </div>
              ))
            : [
                ['changelog', 'Update the changelog'],
                ['tag', `Mark the code as ${r.version}`],
                ['pipeline', 'Run your after-release step'],
                ['whatsapp', 'Draft a WhatsApp note for my manager'],
              ].map(([k, label]) => (
                <div className="checkrow" key={k}>
                  <span className={`cbx ${r.addons[k as keyof Release['addons']] ? 'on' : ''}`}>
                    {r.addons[k as keyof Release['addons']] && <Check size={11} strokeWidth={3} />}
                  </span>
                  {label}
                </div>
              ))}
        </div>
        <div>
          <div className="lbl">
            Release notes{draft && ', written by the squad'}
            <span className="grow" style={{ flex: 1 }} />
            {draft && !editing && (
              <button className="btn sm" onClick={() => setEditing(true)}>
                <PenLine size={13} /> Edit
              </button>
            )}
          </div>
          {editing ? (
            <>
              <textarea className="textarea mono" style={{ minHeight: 180, fontSize: 13 }} dir={typedDir(notes)} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn sm pri"
                  onClick={() =>
                    act.mutate(
                      { path: `/api/v1/releases/${r.version}/notes`, method: 'PUT', body: { notes }, done: 'Notes saved' },
                      { onSuccess: () => setEditing(false) },
                    )
                  }
                >
                  Save notes
                </button>
                <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <NotesView notes={r.notes} />
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 26 }}>
        {draft ? (
          <>
            <button className="btn pri" disabled={r.items.length === 0} onClick={() => setConfirming(true)}>
              <Rocket size={15} /> Release {r.version}
            </button>
            <span className="note">You'll be asked once to confirm.</span>
          </>
        ) : (
          <button className="btn" onClick={() => setBug(true)}>Report a bug in {r.version}</button>
        )}
      </div>

      {Boolean(r.gateStop?.length) && <ReleaseGateStop r={r} onReleased={onReleased} />}

      {confirming && (
        <Modal
          title={`Release ${r.version}?`}
          onClose={() => setConfirming(false)}
          icon={<span className="glyph"><Rocket size={15} /></span>}
          footer={
            <>
              <button
                className="btn pri"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate(
                    { path: `/api/v1/releases/${r.version}/release` },
                    {
                      onSuccess: (rel) => {
                        setConfirming(false);
                        onReleased(rel);
                      },
                    },
                  )
                }
              >
                <Rocket size={15} /> Yes, release it
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>Not yet</button>
              <span className="grow" />
              <Cmd text={`squad release ${r.version}`} />
            </>
          }
        >
          <p>
            {r.items.length} tickets go live:{' '}
            {r.items.map((i, k) => (
              <span key={i.id}>
                {k > 0 && ', '}
                <Written text={i.title} />
              </span>
            ))}
            .
          </p>
          {r.targets.length > 0 && (
            <div className="box" style={{ marginBottom: 6 }}>
              {partsOut.length > 0 ? (
                <details>
                  <summary><b>This release changes {partsOut.join(', ')}</b></summary>
                  <div className="note" style={{ marginTop: 6 }}>For engineers:</div>
                  <BranchTargets r={r} />
                </details>
              ) : (
                <details>
                  <summary><b>{r.targets.some((g) => g.remote) ? "This release goes to your team's shared copy of the code" : 'This release stays on this computer: the project has no shared copy'}</b></summary>
                  <div className="note" style={{ marginTop: 6 }}>For engineers:</div>
                  <BranchTargets r={r} />
                </details>
              )}
            </div>
          )}
        </Modal>
      )}
      {!draft && live && <OldBranches />}
      {bug && <BugDialog foundIn={r.version} onClose={() => setBug(false)} />}
      {marking && <MarkSentDialog version={r.version} onClose={() => setMarking(false)} onDone={onReleased} />}
    </div>
  );
}

/**
 * Old ticket branches. After each release squad-kit deletes the released tickets' branches on this computer; the
 * ones on the remote stay until you ask. A branch with work that is not in main always stays.
 */
/** The branches a release changes, and where to correct them. */
function BranchTargets({ r }: { r: ReleaseWithItems }) {
  return (
    <>
      {r.targets.map((g) => (
        <div key={g.repo} className="mono" style={{ fontSize: 12.5, marginTop: 6 }}>
          {g.repo === '.' ? 'project' : g.repo}: {g.branch} {g.remote ? `→ pushed to ${g.remote}` : '(no remote, stays on this computer)'}
        </div>
      ))}
      <p className="note" style={{ marginTop: 6 }}>Change the branch or remote in Settings first if this is not right.</p>
    </>
  );
}

function OldBranches() {
  const act = useAct();
  const plan = useQuery({ queryKey: ['branches'], queryFn: () => api<BranchPlan>('/api/v1/branches'), refetchInterval: 30_000 });
  const p = plan.data;
  if (!p || (!p.here.length && !p.remote.length)) return null;
  return (
    <div className="box" style={{ marginTop: 18 }}>
      <b>
        <GitBranch size={14} /> Left over from released tickets
      </b>
      <p className="note" style={{ margin: '4px 0 8px' }}>
        {[p.here.length ? `${p.here.length} on this computer` : '', p.remote.length ? `${p.remote.length} in your team's shared copy of the code` : ''].filter(Boolean).join(' and ')}. Their work is in the code already, so nothing is lost.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {p.here.length > 0 && (
          <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/branches/clean', body: { remote: false }, done: 'Deleted what was left over on this computer' })}>
            Delete them here
          </button>
        )}
        {p.remote.length > 0 && (
          <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: '/api/v1/branches/clean', body: { remote: true }, done: "Deleted what was left over here and in the shared copy of the code" })}>
            Delete them {p.here.length ? 'here and ' : ''}in the shared copy
          </button>
        )}
        <span className="grow" style={{ flex: 1 }} />
        <Cmd text={p.remote.length ? 'squad branches --clean --remote' : 'squad branches --clean'} />
      </div>
    </div>
  );
}

/**
 * "It reached it another way": its tickets close and nothing checks after this, so the person says how. When squad-kit
 * does not find the release in the shared copy of the code, or cannot reach it, it says so, and only a second press goes on.
 */
function MarkSentDialog({ version, onClose, onDone }: { version: string; onClose(): void; onDone(r: Release): void }) {
  const qc = useQueryClient();
  const { toast } = usePrefs();
  const [reason, setReason] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mark = async (anyway: boolean) => {
    setBusy(true);
    try {
      const rel = await send<Release>(`/api/v1/releases/${version}/mark-sent`, 'POST', { reason, ...(anyway ? { anyway } : {}) });
      void qc.invalidateQueries();
      onDone(rel);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setWarning(err.message);
      else toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="It reached it another way"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {warning ? (
            <button className="btn pri" disabled={busy || !reason.trim()} onClick={() => void mark(true)}>
              Mark it anyway
            </button>
          ) : (
            <button className="btn pri" disabled={busy || !reason.trim()} onClick={() => void mark(false)}>
              {busy ? 'Looking for it…' : 'Mark it as sent'}
            </button>
          )}
        </>
      }
    >
      <p className="note">{version}'s tickets close, and nothing checks after this. squad-kit looks in your team's shared copy of the code first.</p>
      <div className="lbl">How did it get there?</div>
      <textarea className="waynote" rows={2} dir={typedDir(reason)} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Sara merged it by hand" />
      {warning && <div className="box" style={{ marginTop: 10 }}>{warning}</div>}
      <div style={{ marginTop: 10 }}>
        <Cmd text={`squad release ${version} --mark-sent --reason ${shellQuote(reason.trim() || 'how it got there')}${warning ? ' --anyway' : ''}`} />
      </div>
    </Modal>
  );
}

/** A team's release gate held this one back. Nothing moved: try again, let an engineer read it, or go on with a reason. */
function ReleaseGateStop({ r, onReleased }: { r: ReleaseWithItems; onReleased(r: Release): void }) {
  const act = useAct<Release>();
  const [why, setWhy] = useState('');
  const send = (goOn?: string) => act.mutate({ path: `/api/v1/releases/${r.version}/release`, ...(goOn ? { body: { goOn } } : {}) }, { onSuccess: onReleased });
  const printed = r.gateStop!.filter((g) => g.output);
  return (
    <div className="box" role="alert" style={{ marginTop: 12 }}>
      <b>{r.version} did not go out. Nothing changed.</b>
      {r.gateStop!.map((g) => (
        <p key={g.id} dir="auto">
          Your team's check <b>{g.name}</b> {g.result === 'failed' ? 'did not pass.' : `could not run. ${g.why ?? ''}`}
        </p>
      ))}
      {printed.length > 0 && (
        <details>
          <summary>Let an engineer look</summary>
          <pre className="mono" dir="ltr" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{printed.map((g) => `${g.name}:\n${g.output}`).join('\n\n')}</pre>
        </details>
      )}
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="gate-why">To go on without this check, write why. It stays on the stories and the release notes.</label>
        <textarea id="gate-why" className="textarea" dir={typedDir(why)} value={why} onChange={(e) => setWhy(e.target.value)} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn pri sm" disabled={act.isPending} onClick={() => send()}>Try again</button>
        <button className="btn sm" disabled={act.isPending || !why.trim()} onClick={() => send(why.trim())}>Go on without this check</button>
      </div>
    </div>
  );
}
