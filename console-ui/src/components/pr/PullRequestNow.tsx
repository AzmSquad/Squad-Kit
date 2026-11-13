import { useQuery } from '@tanstack/react-query';
import { Check, ExternalLink, GitMerge, GitPullRequest, Loader2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Ticket } from '../../api/types';
import type { OwnerNote, PullRequestView, SentTicket, TrackStep } from '../../api/contribution-types';
import { PR, type TrackWords } from '../../lib/contribute-words';
import { readLang, type Lang } from '../../lib/first-story';
import { useAct } from '../../lib/data';
import { AskLeadButton } from '../LeadAsk';
import { StuckCard } from '../ErrorCard';
import { Cmd, CouldNotLoad, clock } from '../ui';
import '../../styles/contribute.css';

/**
 * A story whose pull request went to someone else's repo (ADR-008): its steps from Looks right to the owner's merge,
 * and beside them what is up now: waiting for the owner, the owner's notes with Fix these, the notes fixed and answered,
 * or merged by the owner. From GET /tickets/:id/pull-request, asked again whenever the story changes, so a look the
 * engine makes by itself every 3 minutes shows at once.
 */

/** "13 Nov", or "13 نوفمبر" with Latin digits, as the rest of the page writes numbers. */
const day = (iso: string, lang: Lang) => (iso ? new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' }) : '');

/** A note of this pull request: one written on an older one (before Send it again) stays out. */
const thisPr = (n: OwnerNote, v: PullRequestView) => n.pr === undefined || n.pr === v.pr?.id;

const sent = (t: Ticket) => (t as Ticket & SentTicket).contribution;

/** The story's page shows this panel: sent to the owner, and nothing for the Builder to do now. */
export function showsPullRequest(t: Ticket): boolean {
  const c = sent(t);
  if (!c || !t.pr || c.state === 'fixing') return false;
  return !t.waiting || t.stuck?.kind === 'owner-notes' || t.stuck?.kind === 'owner-closed';
}

function stepWords(s: TrackStep, v: PullRequestView, lang: Lang): TrackWords {
  const w = PR[lang];
  const tr = v.track;
  switch (s.id) {
    case 'looks-right':
      return w.step['looks-right']();
    case 'pushed':
      return w.step.pushed(tr?.copy, tr?.branch);
    case 'opened':
      return w.step.opened(v.into);
    case 'review':
      if (s.state === 'closed') return { title: w.closedTitle, sub: w.reviewSub.closed };
      return { title: w.step.review, sub: s.state === 'now' ? w.reviewSub[v.state as keyof typeof w.reviewSub] : '' };
    default:
      return { title: w.step.merged };
  }
}

function Track({ v, lang }: { v: PullRequestView; lang: Lang }) {
  const w = PR[lang];
  const host = v.track?.host ?? '';
  return (
    <div className="pr-panel">
      <h3>
        <GitPullRequest size={16} aria-hidden="true" />
        {w.head} <span className="mono">#{v.pr?.id}</span>
        {v.pr && (
          <a href={v.pr.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> {w.open(host)}
          </a>
        )}
      </h3>
      <ol className="pr-track">
        {(v.track?.steps ?? []).map((s) => {
          const words = stepWords(s, v, lang);
          return (
            <li key={s.id} className={s.state === 'done' ? '' : s.state}>
              <span className="pr-dot" aria-hidden="true">
                {s.state === 'done' && <Check size={12} strokeWidth={2.8} />}
                {s.state === 'closed' && <X size={12} strokeWidth={2.8} />}
              </span>
              <div>
                {words.title}
                {words.sub && <small>{words.sub}</small>}
              </div>
              <span className="t">{s.at ? clock(s.at) : ''}</span>
            </li>
          );
        })}
      </ol>
      <p className="pr-note">{w.note}</p>
    </div>
  );
}

function Note({ n, lang, fixed }: { n: OwnerNote; lang: Lang; fixed?: boolean }) {
  const w = PR[lang];
  return (
    <div className="pr-cmt">
      <span className="av" aria-hidden="true" dir="ltr">{n.who.slice(0, 2).toUpperCase()}</span>
      <div>
        <small>
          <b dir="ltr">{n.who}</b>
          {n.file && (
            <>
              {' · '}
              <a className="file" href={n.url} target="_blank" rel="noreferrer" dir="ltr">{n.file}</a>
            </>
          )}
          {n.line ? ` · ${w.line(n.line)}` : ''}
        </small>
        <p dir="auto">{n.text}</p>
        {fixed && n.fixedIn && (
          <span className="pr-fixed">
            <Check size={12} strokeWidth={2.8} aria-hidden="true" />
            {w.fixedIn} <code>{n.fixedIn}</code>
          </span>
        )}
      </div>
    </div>
  );
}

/** The owner's notes: Fix these, answer on the code host, or ask the lead first. */
function NotesCard({ t, v, lang }: { t: Ticket; v: PullRequestView; lang: Lang }) {
  const w = PR[lang];
  const act = useAct();
  const host = v.track?.host ?? '';
  const open = v.notes.filter((n) => n.state === 'new' && thisPr(n, v));
  const fix = v.actions.find((a) => a.id === 'fix');
  const leave = v.actions.find((a) => a.id === 'leave');
  const quoted = open.map((n) => `> ${[n.file, n.line ? `line ${n.line}` : ''].filter(Boolean).join(' ') || n.who}: ${n.text.replace(/\s+/g, ' ')}`).join('\n');
  return (
    <div className="pr-card">
      <div className="ch">
        <span className="mono">#{v.pr?.id}</span>
        {w.notesHead}
        <em>{w.notesTag}</em>
      </div>
      <div className="cb">
        {open.map((n) => (
          <Note key={n.id} n={n} lang={lang} />
        ))}
      </div>
      <div className="cf">
        <div className="pr-row">
          {fix && (
            <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/pull-request/fix`, done: 'The Builder fixes the owner’s notes' })}>
              {w.fix}
            </button>
          )}
          {open[0] && (
            <a className="btn" href={open[0].url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> {w.reply(host)}
            </a>
          )}
          <AskLeadButton label={w.ask} text={w.askText(t.id, quoted)} context={{ from: 'problem', problem: 'waiting', story: t.id }} />
        </div>
        {fix && <Cmd text={fix.command} always />}
        <span className="pr-small">{w.fixNote}</span>
        {leave && (
          <span className="pr-small">
            <button className="btn quiet sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/pull-request/leave`, done: w.leaveNote })}>
              {w.leave(host)}
            </button>{' '}
            {w.leaveNote}
            <Cmd text={leave.command} />
          </span>
        )}
      </div>
    </div>
  );
}

function FixedCard({ v, lang }: { v: PullRequestView; lang: Lang }) {
  const w = PR[lang];
  const fixed = v.notes.filter((n) => n.state === 'fixed' && thisPr(n, v));
  return (
    <div className="pr-card done">
      <div className="ch">
        <span className="mono">#{v.pr?.id}</span>
        {w.fixedHead}
        <em>{w.fixedTag}</em>
      </div>
      <div className="cb">
        {fixed.map((n) => (
          <Note key={n.id} n={n} lang={lang} fixed />
        ))}
      </div>
      <div className="cf">
        <span className="pr-small">{fixed.every((n) => n.answered) ? w.pushed : w.pushedSome}</span>
      </div>
    </div>
  );
}

function Waiting({ t, v, lang }: { t: Ticket; v: PullRequestView; lang: Lang }) {
  const w = PR[lang];
  const act = useAct<{ line?: string }>();
  const check = v.actions.find((a) => a.id === 'check');
  return (
    <>
      <div className="pr-box wait">
        <span className="big" aria-hidden="true">
          <GitMerge size={17} />
        </span>
        <div>
          <b>{w.step.review}</b>
          <small>{w.reviewSub.waiting}</small>
        </div>
      </div>
      {check && (
        <div className="pr-row">
          <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/check-merge`, done: (r) => r.line ?? null })}>
            {w.check}
          </button>
          <Cmd text={check.command} />
        </div>
      )}
      <span className="pr-small">{v.lookedAt ? w.looked(clock(v.lookedAt)) : w.notLooked}</span>
    </>
  );
}

function Merged({ v, lang }: { v: PullRequestView; lang: Lang }) {
  const w = PR[lang];
  const at = v.track?.steps.find((s) => s.id === 'merged')?.at ?? v.since ?? '';
  return (
    <>
      <div className="pr-box">
        <span className="big" aria-hidden="true">
          <GitMerge size={17} />
        </span>
        <div>
          <b>{w.mergedHead}</b>
          <small>{w.mergedSub(v.into ?? '', v.pr?.id ?? 0, day(at, lang), at ? clock(at) : '')}</small>
        </div>
      </div>
      <p className="pr-small" dir="auto">{v.track?.catchUp ?? w.syncLater}</p>
    </>
  );
}

export function PullRequestNow({ t }: { t: Ticket }) {
  const lang = readLang();
  const c = sent(t);
  // Asked again whenever the story changes: a look by the engine writes to the story.
  const stamp = `${t.status}|${t.mergedAt ?? ''}|${t.stuck?.kind ?? ''}|${t.activity.length}|${c?.state ?? ''}|${c?.lookedAt ?? ''}`;
  const q = useQuery({ queryKey: ['pull-request', t.id, stamp], queryFn: () => api<PullRequestView>(`/api/v1/tickets/${t.id}/pull-request`), refetchInterval: 30_000 });
  const v = q.data;
  // Never an empty Now tab: loading, a failed load with Try again, or the engine's own line.
  if (!v)
    return q.isError ? (
      <CouldNotLoad what="the pull request" error={q.error} onRetry={() => void q.refetch()} />
    ) : (
      <div className="db center">
        <Loader2 size={16} className="spin" aria-label="Loading the pull request" />
      </div>
    );
  if (v.to !== 'owner')
    return (
      <div className="db">
        <p className="pr-note">{v.line}</p>
      </div>
    );
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  // Closed without merging: the stop card's ways out first (Send it again, Leave it closed), the steps under it.
  if (v.state === 'closed' && t.stuck)
    return (
      <StuckCard
        t={t}
        extra={
          <div className="prw" dir={dir} lang={lang}>
            <Track v={v} lang={lang} />
          </div>
        }
      />
    );
  const hasFixed = v.notes.some((n) => n.state === 'fixed' && thisPr(n, v));
  let side = null;
  if (v.state === 'notes') side = <NotesCard t={t} v={v} lang={lang} />;
  else if (v.state === 'merged') side = <Merged v={v} lang={lang} />;
  // Still open: the fixed notes, and under them what squad-kit does while the owner reviews.
  else if (v.state === 'waiting')
    side = (
      <>
        {hasFixed && <FixedCard v={v} lang={lang} />}
        <Waiting t={t} v={v} lang={lang} />
      </>
    );
  return (
    <div className="db prw" dir={dir} lang={lang}>
      <div className="pr-grid">
        <Track v={v} lang={lang} />
        <div className="pr-side">{side}</div>
      </div>
    </div>
  );
}
