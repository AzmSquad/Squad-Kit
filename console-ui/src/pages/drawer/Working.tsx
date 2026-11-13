import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUp, Check, Code, Loader2, Play, Square, TriangleAlert } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { Cmd, Glyph, ROLE_NAME, Written, ago, clock, commandFor } from '../../components/ui';
import { OpenInEditor } from '../../components/Changes';
import { TakeOverButton, canTakeOver } from '../../components/TakeOver';
import { TalkButton } from '../../components/Chat';
import { ProposeChangeButton, shipped } from '../../components/ChangeCard';
import { TicketUsage } from '../../components/Usage';
import { isMine, useMe } from '../../components/HandOver';
import { AskBox, NowCard, SlowPanel, WorkSoFar, isRunning } from '../../components/LiveNow';
import { AlsoChanged } from '../../components/Verdict';
import { shellQuote } from '../../lib/text';
import { BringInButton, CheckMerge } from '../../components/Depends';
import { DecidedForYou } from '../../components/AutoTicket';
import { useAskAgent } from '../../components/AskQuestion';
import { useDraft } from '../../lib/drafts';
import { useReach } from '../../lib/use-reach';
import { langProps, typedDir } from '../../lib/lang';
import { ToolBlockCard } from '../../components/ToolBlock';
import { SendAsPr } from '../../components/SendAsPr';
import { GatePills } from './Proof';

/* ── Working, ready, released ──────────────────────────── */

/** On its way in after Looks right: its save, the project's own checks with it, then its merge or its pull request. */
function MergingNow({ t }: { t: Ticket }) {
  return (
    <div className="calm" role="status">
      <span className="ring"><Loader2 size={18} className="spin" /></span>
      <div>
        <Written as="b" text={t.now!.line} />
        <Written text={t.now!.sentence} />
      </div>
    </div>
  );
}

/** Looks right was pressed and the save runs: the proof's buttons would only be refused now. */
export function SavingPanel({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <MergingNow t={t} />
      <RecentActivity t={t} />
    </div>
  );
}

/** The step is slow, or shows no progress: the card says what it does and what squad-kit checked, with the ways on. */
export function QuietPanel({ t }: { t: Ticket }) {
  return (
    <div className="db">
      <SlowPanel t={t} />
      {t.now && <NowCard t={t} />}
      <WorkSoFar t={t} />
      <AskBox t={t} />
    </div>
  );
}

/** The merge moved the person's own checkout; this says whether its packages and database are up to date. */
function LocalSetupLine({ t }: { t: Ticket }) {
  const again = useAct();
  const ls = t.localSetup!;
  const busy = ls.status === 'pending' || ls.status === 'running';
  return (
    <div className={`localsetup ${ls.status}`}>
      <span className="ic">{busy ? <Loader2 size={15} className="spin" /> : ls.status === 'done' ? <Check size={15} strokeWidth={2.5} /> : <TriangleAlert size={15} />}</span>
      <div>
        <b>
          {busy
            ? 'Updating your copy of the code'
            : ls.status === 'done'
              ? 'Your copy of the code is ready to run'
              : 'Your copy of the code needs a hand'}
        </b>
        <span>
          {busy
            ? 'The merge changed your own folder, so the squad installs new packages and runs the database changes there.'
            : ls.status === 'done'
              ? `New packages and database changes are in your own folder${ls.at ? `, ${ago(ls.at)}` : ''}${ls.seconds !== undefined ? ` (${ls.seconds} s)` : ''}.`
              : 'squad-kit could not finish setting it up. Try again, or ask an engineer to look at what failed.'}
        </span>
        {ls.status === 'failed' && (
          <details className="costdetails">
            <summary>See what failed</summary>
            <code>{ls.command}</code>
            {ls.output && <pre>{ls.output}</pre>}
          </details>
        )}
      </div>
      {ls.status === 'failed' && (
        <button className="btn sm" disabled={again.isPending} onClick={() => again.mutate({ path: `/api/v1/tickets/${t.id}/local-setup`, done: 'Running the setup again' })}>
          Try again
        </button>
      )}
    </div>
  );
}

export function WorkingPanel({ t }: { t: Ticket }) {
  const reach = useReach();
  const me = useMe();
  const stop = useAct();
  const start = useAct();
  const asks = useAskAgent(t);
  const calm =
    t.stage === 'release'
      ? /^Waits to merge\b/.test(t.status)
        ? { title: 'Waits to merge', text: 'Your own copy of the code has changes in the same files. Save or undo them there, and it goes in by itself. squad-kit tries again every few minutes.' }
        : t.sendAs
          ? { title: 'Merged on this computer', text: 'It goes on as a pull request: send it below.' }
          : { title: `Ready for ${t.release}`, text: 'It goes out with the next release. Nothing needed from you until then.' }
      : t.stage === 'done'
        ? { title: t.status, text: 'This ticket is live. Found a problem? Report a bug and it comes back around.' }
        : t.waiting?.kind === 'change'
          ? { title: 'The Builder paused for your change', text: 'The Architect updated the design. Approve it above, or decline the change and the Builder carries on.' }
          : t.waitsToStart
            ? { title: 'Waits for you to start it', text: 'squad-kit made this story. Nothing runs and nothing is spent until you press Start. Then the Analyst reads it, as with any new story.' }
            : { title: 'Nothing needed from you', text: `${nowLine(t)} You'll get a card when the squad needs you.` };
  // While the squad works: what it does now, how long, the usual time and what comes next, from the live record.
  const running = isRunning(t);
  return (
    <>
      <div className="db">
        {t.toolWait ? (
          // A tool this step needs is not on this computer: what can't happen, why, and the link to its line. Its step
          // stays planned, so it reads as working, but nothing runs until the tool is there.
          <ToolBlockCard block={t.toolWait} />
        ) : running ? (
          <NowCard t={t} />
        ) : t.now?.merging ? (
          <MergingNow t={t} />
        ) : (
          <div className="calm">
            <span className="ring">{t.stage === 'release' ? <ArrowUp size={18} /> : <Check size={18} strokeWidth={2.5} />}</span>
            <div>
              <Written as="b" text={calm.title} />
              <Written text={calm.text} />
            </div>
            {t.stage === 'release' && !t.sendAs && (
              <>
                <span className="grow" style={{ flex: 1 }} />
                <Link to="/releases" className="btn sm">Open release</Link>
              </>
            )}
          </div>
        )}
        {t.localSetup && <LocalSetupLine t={t} />}
        {t.sendAs && <SendAsPr s={t.sendAs} />}
        {/* Accepted, its change not in the base yet: its pull request waits on the code host, or the person's copy. */}
        {t.stage === 'release' && !t.mergedAt && !running && !t.live && !t.squad && (t.pr || /^Waits to merge\b/.test(t.status)) && (
          <CheckMerge
            t={t}
            text={t.pr ? `Pull request ${t.pr.id} is not merged yet. squad-kit asks the code host by itself every few minutes, or now:` : 'squad-kit tries again by itself every few minutes, or now:'}
          />
        )}
        {t.steps && t.steps.length > 0 && (
          <>
            <div className="lbl">Steps</div>
            <Steps t={t} />
          </>
        )}
        {t.gates && (
          <>
            <div className="lbl">Gates, checked by squad-kit</div>
            <GatePills t={t} />
          </>
        )}
        <AlsoChanged t={t} />
        {(t.stage === 'release' || t.stage === 'done') && t.usage?.length ? <TicketUsage t={t} /> : null}
        <DecidedForYou t={t} />
        {running ? <WorkSoFar t={t} /> : <RecentActivity t={t} />}
        <AskBox t={t} />
      </div>
      <div className="df">
        {t.live && t.stage !== 'release' && t.stage !== 'done' && (
          <button className="btn sm" disabled={t.stopRequested || stop.isPending} onClick={() => stop.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping the squad' })}>
            <Square size={12} /> {t.stopRequested ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {t.waitsToStart && (
          <button className="btn pri sm" disabled={start.isPending} onClick={() => start.mutate({ path: `/api/v1/tickets/${t.id}/start`, done: `${t.id} started` })}>
            <Play size={12} /> Start
          </button>
        )}
        {canTakeOver(t) && <TakeOverButton t={t} />}
        <BringInButton t={t} />
        {/* Asking never stops the work: the chat runs beside it. Ask a question and Open the chat are at the top; the
            Analyst gets its own button only while someone else answers those. */}
        {!t.chat?.open && !t.takenOver && !shipped(t) && asks !== 'analyst' && <TalkButton t={t} agent="analyst" label="Ask the Analyst" />}
        {(isMine(t, me) || !me) && <ProposeChangeButton t={t} />}
        <span className="note">{t.live ? (reach === 'down' ? 'Not updating: squad-kit has stopped.' : 'Updates live as the squad works.') : ''}</span>
        <span className="grow" />
        <Cmd text={t.waitsToStart ? `squad start ${t.id}` : t.live && t.stage !== 'release' ? `squad stop ${t.id}` : commandFor(t)} />
      </div>
    </>
  );
}

/* ── Take over and give back ───────────────────────────── */

/** The ticket is yours: work in the Builder's session, then give it back so the checks and review run again. */
export function YoursPanel({ t }: { t: Ticket }) {
  const act = useAct();
  const [note, setNote, clearNote] = useDraft(t.id, 'give-back', '');
  const k = t.takenOver!;
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring">
            <Code size={15} />
          </span>
          <div>
            <b>You have this ticket</b>
            <span>The squad stopped and waits. Nothing runs until you give it back.</span>
          </div>
        </div>
        <div className="lbl">1. Open the Builder&apos;s session in Claude Code</div>
        <Cmd text={`cd ${shellQuote(k.cwd)} && claude --resume ${k.session}`} />
        <p className="note" style={{ fontSize: 12.5, marginTop: 6 }}>
          It is the same conversation the Builder had, in the ticket&apos;s own copy of the code. Your folder is not touched. Or just edit the files:
        </p>
        <OpenInEditor t={t} />
        <div className="lbl">2. Give it back</div>
        <textarea className="waynote" rows={2} dir={typedDir(note)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you change? (optional, every agent reads it)" />
        <p className="note" style={{ fontSize: 12.5 }}>Then squad-kit runs the checks, the Reviewer reads all the changes, yours too, and the Tester makes the proof again.</p>
        <RecentActivity t={t} />
      </div>
      <div className="df">
        <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/give-back`, body: { note }, done: 'Given back. The checks run on your changes.' }, { onSuccess: clearNote })}>
          <Check size={15} strokeWidth={2.5} /> Give back
        </button>
        <span className="grow" />
        <Cmd text={`squad give-back ${t.id}${note.trim() ? ` ${shellQuote(note.trim())}` : ''}`} />
      </div>
    </>
  );
}

/** A calm sentence for what the squad is doing; raw tool lines stay in the steps list. */
function nowLine(t: Ticket): string {
  const steps = t.steps ?? [];
  const i = steps.findIndex((s) => s.status === 'doing');
  if (t.stage === 'implement' && i >= 0) return `The Builder is on step ${i + 1} of ${steps.length}.`;
  if (t.stage === 'test') return 'squad-kit is running the project checks.';
  if (t.stage === 'review') return 'The Reviewer is checking the work.';
  if (t.stage === 'tickets') return 'The Analyst is reading the ticket.';
  if (t.stage === 'specs') return 'The Architect is writing the plan.';
  return `${t.status}.`;
}

export function Steps({ t }: { t: Ticket }) {
  return (
    <ul className="steps">
      {t.steps!.map((s, i) => (
        <li key={i} className={s.status === 'doing' ? 'now' : s.status === 'todo' ? 'todo' : ''} {...langProps(s.title)}>
          <span className={`sd ${s.status === 'done' ? 'ok' : s.status === 'doing' ? 'now' : ''}`}>
            {s.status === 'done' && <Check size={11} strokeWidth={3} />}
          </span>
          <span>
            <Written as={s.status === 'doing' ? 'b' : 'span'} style={s.status === 'doing' ? { fontWeight: 600 } : undefined} text={s.title} />
            {s.live && (
              <span className="livetxt">
                <span className="live" />
                <Written text={s.live} />
              </span>
            )}
          </span>
          <span className="time" dir="ltr">{s.status === 'done' ? `${s.minutes ?? 1} min` : s.status === 'doing' ? 'now' : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** Lines about how the work is done, in tools and file names. They wait behind "Show every step". */
const WORKING_LINE = /^(Reading|Running|Editing|Writing|Looking|Searching|Listing|Runs on|Started step|Finished step|Stopped a program|Setting up squad-kit's screenshot browser)\b|^squad-kit (asked|ran|started|stopped|is running)\b/;

export function RecentActivity({ t, all }: { t: Ticket; all?: boolean }) {
  const [every, setEvery] = useState(false);
  const plain = t.activity.filter((a) => !WORKING_LINE.test(a.text));
  const items = all ? (every ? t.activity : plain) : plain.slice(0, 4);
  if (!items.length && !(all && t.activity.length)) return null;
  return (
    <>
      {!all && <div className="lbl">Latest activity</div>}
      <div className="feed">
        {items.map((a, i) => (
          <div className="fe" key={a.at + i}>
            <span className="tm">{clock(a.at)}</span>
            <Glyph role={a.who} small />
            <Written lead={<b>{ROLE_NAME[a.who]}</b>} text={a.text.charAt(0).toLowerCase() + a.text.slice(1)} />
          </div>
        ))}
      </div>
      {all && plain.length < t.activity.length && (
        <button className="btn sm ghost" onClick={() => setEvery((v) => !v)}>
          {every ? 'Show only what matters' : 'Show every step'}
        </button>
      )}
    </>
  );
}
