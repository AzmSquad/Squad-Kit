import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, CircleAlert, ExternalLink, FastForward } from 'lucide-react';
import { api } from '../../api/client';
import type { EpicPreview } from '../../api/epic-types';
import type { BacklogGroup } from '../../api/tracker-types';
import { buildCommand, previewLines, squadTimeWords } from '../../lib/epic-run';
import { useReqAct } from '../../lib/requirementsData';
import { plainError } from '../BreakdownDialogs';
import { Cmd, Modal, Written } from '../ui';
import '../../styles/requirements.css';
import '../../styles/epic.css';

/**
 * Build all on an Epic or Feature: what it would build and in which order, how the run goes, and where it stops. Read
 * them first makes the run (`squad backlog build AB#2001`) and opens it on Requirements, where the Analyst reads.
 */

const STEPS: { who: 'squad' | 'you'; tag: string; text: (n: number) => string }[] = [
  { who: 'squad', tag: 'Squad', text: (n) => `The Analyst reads ${n === 1 ? 'the story' : `all ${n} stories`}` },
  { who: 'you', tag: 'You, once', text: () => 'Answer its questions, all at once' },
  { who: 'you', tag: 'You, once', text: () => 'Approve the order and the "done when"' },
  { who: 'squad', tag: 'Squad', text: () => 'Each story builds, is checked and merges by itself' },
  { who: 'you', tag: 'You', text: () => 'Send the release when you like' },
];

export function BuildAllDialog({ g, sprint, label, onClose }: { g: BacklogGroup; sprint?: string; label: string; onClose(): void }) {
  const navigate = useNavigate();
  const act = useReqAct<{ id: string; already?: string }>();
  const qc = useQueryClient();
  const [only, setOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/v1/backlog/${encodeURIComponent(g.id)}/build`;
  const preview = useQuery({
    queryKey: ['epic-preview', g.id, sprint ?? ''],
    queryFn: () => api<EpicPreview>(`${path}${sprint ? `?sprint=${encodeURIComponent(sprint)}` : ''}`),
    retry: false,
    staleTime: 0,
  });
  const p = preview.data;
  const inSprint = p?.sprint && p.sprint.count > 0 && p.sprint.count < p.stories.length ? p.sprint : undefined;
  const sprintOnly = Boolean(inSprint && only);
  const lines = p ? previewLines(p.stories, sprintOnly, label) : [];
  const count = lines.filter((l) => l.kind === 'story').length;
  const level = g.level === 'epic' ? 'epic' : 'feature';
  const open = (id: string) => void navigate({ to: '/requirements/$id', params: { id } });
  const start = () => {
    setError(null);
    act.mutate(
      { path, body: sprintOnly ? { onlySprint: inSprint!.name } : {}, quiet: true, done: 'The Analyst is reading the stories.' },
      {
        // The group's row shows its run at once. An item with a run already opens that run: new stories join there.
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: ['backlog'] });
          if (r?.id) open(r.id);
        },
        onError: (err) => setError(plainError(err)),
      },
    );
  };
  return (
    <Modal
      wide
      title={`Build all of this ${level}?`}
      onClose={onClose}
      footer={
        <>
          <Cmd text={buildCommand(g.ref, sprintOnly ? inSprint!.name : undefined)} />
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          {p?.run ? (
            <button className="btn pri" onClick={() => open(p.run!)}>Open the run</button>
          ) : (
            <button className="btn pri" disabled={!count || act.isPending} onClick={start}>
              <FastForward size={14} /> {act.isPending ? 'Starting…' : 'Read them first'}
            </button>
          )}
        </>
      }
    >
      <div className="ep-head">
        <span className={`bl-lv ${g.level}`}>{g.type || (g.level === 'epic' ? 'Epic' : 'Feature')}</span>
        <Written as="b" className="ep-name" text={g.title} />
        {g.url ? (
          <a className="mono ep-ref" href={g.url} target="_blank" rel="noreferrer">
            {g.ref} <ExternalLink size={11} />
          </a>
        ) : (
          <span className="mono ep-ref">{g.ref}</span>
        )}
      </div>
      <p>The squad builds its stories one after another, in a sensible order, and stops only when it really needs you.</p>
      {preview.isLoading ? (
        <p className="note">Reading {g.ref} and everything under it from {label}…</p>
      ) : preview.isError ? (
        <div className="rq-err" role="alert">
          squad-kit could not read {g.ref}. {plainError(preview.error)}{' '}
          <button className="rq-link" onClick={() => void preview.refetch()}>Try again</button>
        </div>
      ) : p?.run ? (
        <div className="calm">
          <div>
            <b>It is building already</b>
            <span>Build all of {g.ref} runs as {p.run}. Open the run to see where its stories are.</span>
          </div>
        </div>
      ) : p ? (
        <>
          <div className="lbl">What it builds, in this order</div>
          {count ? (
            <ul className="ep-list">
              {lines.map((l, i) =>
                l.kind === 'feature' ? (
                  <li key={`f${i}`} className="ep-feat">
                    <span className="bl-lv feature">Feature</span>
                    <Written text={l.title} />
                  </li>
                ) : (
                  <li key={l.story.id}>
                    <span className="ep-n">{l.n}</span>
                    <span className="mono ep-sref">{l.story.ref}</span>
                    {l.story.isBug && <span className="pill bug ep-tag"><Bug size={12} /> Bug</span>}
                    <Written className="ep-st" text={l.story.title} />
                    {(l.needs || l.story.onBoard) && <span className="grow" />}
                    {l.story.onBoard && <span className="pill ok ep-tag">On the board · {l.story.onBoard}</span>}
                    {l.needs && <span className="pill wait ep-tag">{l.needs}</span>}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <p className="note">Nothing open under {g.ref} to build.</p>
          )}
          <p className="ep-small">
            {p.leftOut.length > 0 && (
              <>
                Left out:{' '}
                {p.leftOut.map((l, i) => (
                  <span key={l.ref}>
                    {i > 0 && '; '}
                    <b className="mono">{l.ref}</b> <Written text={l.why} />
                  </span>
                ))}
                .{' '}
              </>
            )}
            The Analyst may add a need it finds, with its reason. You see it before you approve.
          </p>
          {inSprint && (
            <label className="ep-only">
              <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />
              <span>
                Only the {inSprint.count} in <Written text={inSprint.name} />
              </span>
            </label>
          )}
          <div className="lbl">How it goes</div>
          <ol className="ep-steps">
            {STEPS.map((s, i) => (
              <li key={i} className={s.who}>
                <span className="ep-k">{i + 1}</span>
                <span className="ep-who">{s.tag}</span>
                <b>{s.text(count)}</b>
              </li>
            ))}
          </ol>
          <div className="ep-stops">
            <CircleAlert size={15} aria-hidden="true" />
            <span>
              It stops a story only for something missing in it, two stories that clash, or a check that still fails after three tries. That story waits for you; the others go on. Up to{' '}
              <b>{p.atOnce} at a time</b>, your "at once" setting.{p.estimate && ` ${squadTimeWords(p.estimate)}.`}
            </span>
          </div>
        </>
      ) : null}
      {error && (
        <div className="rq-err" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
