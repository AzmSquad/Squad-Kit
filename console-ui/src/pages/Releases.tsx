import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Check, PenLine, Rocket } from 'lucide-react';
import type { Release, ReleaseWithItems } from '../api/types';
import { useAct, useBoard, useReleases } from '../lib/data';
import { BugDialog, ReleasedDialog } from '../components/dialogs';
import { Cmd, Modal, NotesView, dateShort } from '../components/ui';

export function ReleasesPage() {
  const releases = useReleases();
  const board = useBoard();
  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState<Release | null>(null);
  const list = releases.data ?? [];
  const current = list.find((r) => r.version === selected) ?? list.find((r) => r.status === 'draft') ?? list[0];
  const demo = board.data?.ready ? board.data.meta.engine === 'demo' : false;

  return (
    <>
      <div className="top">
        <h1>Releases</h1>
        <span className="grow" />
        <Cmd text="squad release" />
      </div>
      <div className="split">
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
              {r.status === 'draft' ? 'Next release' : dateShort(r.date)} · {r.items.length} tickets
            </button>
          ))}
        </div>
        {current ? <ReleaseDetail r={current} onReleased={setDone} /> : <div className="center">No releases yet.</div>}
      </div>
      {done && <ReleasedDialog release={done} demo={demo} onClose={() => setDone(null)} />}
    </>
  );
}

function ReleaseDetail({ r, onReleased }: { r: ReleaseWithItems; onReleased(r: Release): void }) {
  const act = useAct<Release>();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(r.notes);
  const [confirming, setConfirming] = useState(false);
  const [bug, setBug] = useState(false);
  useEffect(() => {
    if (!editing) setNotes(r.notes);
  }, [r.notes, editing]);
  const draft = r.status === 'draft';
  const part = r.version.endsWith('.0') ? 'New features, nothing breaks for users.' : 'Fixes only, nothing new to learn.';

  return (
    <div className="detail">
      <h2 style={{ fontSize: 24, fontStretch: '88%' }}>{draft ? `Release ${r.version}` : r.version}</h2>
      <p className="note" style={{ marginTop: 2 }}>
        {draft ? 'The squad prepared this release. Read it, edit the notes if you like, then release.' : `Released ${dateShort(r.date)}`}
      </p>

      <div className="lbl">What's inside</div>
      {r.items.map((it) => (
        <div className="trow" key={it.id}>
          <span className="mono">{it.id}</span>
          <b>{it.title}</b>
          {it.gates ? (
            <span className="pill ok">
              <Check size={13} strokeWidth={2.5} /> Checks, review, proof
            </span>
          ) : (
            <span />
          )}
        </div>
      ))}
      {r.items.length === 0 && <p className="note">No tickets yet. Tickets join after you check their proof.</p>}

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
                <div className="checkrow" key={l.text} style={l.ok ? undefined : { color: 'var(--you-ink)' }}>
                  <span className={`cbx ${l.ok ? 'on' : ''}`}>{l.ok ? <Check size={11} strokeWidth={3} /> : '!'}</span>
                  {l.text}
                </div>
              ))
            : [
                ['changelog', 'Update the changelog'],
                ['tag', `Tag ${r.version} in git`],
                ['pipeline', 'Run the pipeline'],
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
              <textarea className="textarea mono" style={{ minHeight: 180, fontSize: 13 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
            {r.items.length} tickets go live: {r.items.map((i) => i.title).join(', ')}.
          </p>
          {r.targets.length > 0 && (
            <div className="box" style={{ marginBottom: 6 }}>
              <b>This release changes these branches:</b>
              {r.targets.map((g) => (
                <div key={g.repo} className="mono" style={{ fontSize: 12.5, marginTop: 6 }}>
                  {g.repo === '.' ? 'project' : g.repo}: {g.branch} {g.remote ? `→ pushed to ${g.remote}` : '(no remote, stays on this Mac)'}
                </div>
              ))}
              <p className="note" style={{ marginTop: 6 }}>Change the branch or remote in Settings first if this is not right.</p>
            </div>
          )}
        </Modal>
      )}
      {bug && <BugDialog foundIn={r.version} onClose={() => setBug(false)} />}
    </div>
  );
}
