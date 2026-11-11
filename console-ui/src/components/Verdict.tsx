import { Check, EyeOff, MonitorOff, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { assetUrl } from '../api/client';
import type { AddedResult, ProofShot, Ticket } from '../api/types';
import { pageOf, waitsAtReview } from '../lib/review';
import { isApiProof, notOnScreen, verdictClass, verdictWord } from '../lib/verdict';
import '../styles/verdict.css';
import { ApiProof } from './ApiProof';
import { detect, langProps } from '../lib/lang';
import { Written } from './ui';

/**
 * What each proof picture shows: its "done when" is Met, Not working yet, Not shown yet or Not on a screen, with why.
 * squad-kit decides it from the Tester's verdict and its own check of the picture. Rows from before verdicts show no
 * mark, as before.
 */

/** The row's icon: a check when met (or not judged), a cross when not working, a closed eye when not shown, a screen with a line through it when not on one. */
export function VerdictIcon({ shows, size = 15 }: { shows?: ProofShot['shows']; size?: number }) {
  if (shows === 'broken') return <X size={size} strokeWidth={2.5} className="vx" aria-hidden="true" />;
  if (shows === 'not-shown') return <EyeOff size={size} strokeWidth={2.25} className="vq" aria-hidden="true" />;
  if (shows === 'off-screen') return <MonitorOff size={size} strokeWidth={2.25} className="vo" aria-hidden="true" />;
  return <Check size={size} strokeWidth={2.5} aria-hidden="true" />;
}

/** "Met", "Not working yet", "Not shown yet" or "Not on a screen", next to the "done when". */
export function VerdictTag({ shows }: { shows?: ProofShot['shows'] }) {
  const word = verdictWord(shows);
  if (!word) return null;
  return <span className={`verdict ${verdictClass(shows)}`}>{word}</span>;
}

/**
 * The other pictures of a "done when", one per part or case, each with its note and page: a small row of thumbnails
 * that open in the same viewer as the before and after. `first` is where they begin in the viewer's list.
 */
export function MorePictures({ shot, first, onOpen }: { shot: ProofShot; first: number; onOpen(at: number): void }) {
  if (!shot.more?.length) return null;
  return (
    <div className="proofmore">
      <small>More pictures of this "done when"</small>
      <div className="proofmore-row">
        {shot.more.map((m, i) => (
          <figure key={m.after}>
            {isApiProof(m.after) ? <ApiProof file={m.after} /> : <button className="zoom" onClick={() => onOpen(first + i)} aria-label={`Open picture ${i + 2} of this "done when" full size`}>
              <img src={assetUrl(`/api/v1/proof/${m.after}`)} alt={`${shot.criterion}, ${m.note || `picture ${i + 2}`}`} loading="lazy" />
            </button>}
            <figcaption>
              {m.note && <Written text={m.note} />}
              {pageOf(m) && <code>{pageOf(m)}</code>}
              {m.device && <small className="shotdevice">{m.device}</small>}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/**
 * The pictures are of the app's web version, as its phone tools are missing on this computer: the one plain line, and
 * the way to the Tools page line with what is needed.
 */
export function PicturesNote({ t }: { t: Pick<Ticket, 'picturesNote'> }) {
  if (!t.picturesNote) return null;
  return (
    <p className="critpage picturesnote">
      {t.picturesNote.text}{' '}
      <Link to="/tools" hash={t.picturesNote.link.split('#')[1]}>
        See what's needed
      </Link>
    </p>
  );
}

/** What the change touches that the plan did not include, in the Reviewer's words. It never blocks: the person should see it. */
export function AlsoChanged({ t, className }: { t: Pick<Ticket, 'alsoChanged' | 'added'>; className?: string }) {
  return (
    <>
      {Boolean(t.alsoChanged?.length) && (
        <Written as="p" className={`note alsochanged${className ? ` ${className}` : ''}`} lead={<b>Also changed, not in the plan:</b>} text={`${t.alsoChanged!.join('; ')}.`} />
      )}
      <TeamResults t={t} />
    </>
  );
}

const GATE_WORD: Record<NonNullable<AddedResult['result']>, [string, string]> = {
  passed: ['Passed', 'ok'],
  failed: ['Did not pass', 'bug'],
  warned: ['Did not pass, warn only', 'you'],
  'would-stop': ['Would have stopped', 'you'],
  'cant-run': ['Could not run', 'you'],
};

/** What the team's own gates and checklists did on this story. No record of one, nothing here. */
function TeamResults({ t }: { t: Pick<Ticket, 'added'> }) {
  if (!t.added?.length) return null;
  return (
    <div className="teamres">
      <div className="lbl">Added by your team</div>
      {t.added.map((r) => (
        <div key={r.id}>
          <div className="teamtop">
            <Written as="b" text={r.name} />
            {r.result && <span className={`pill ${GATE_WORD[r.result][1]}`}>{GATE_WORD[r.result][0]}</span>}
            {r.state === 'try' && <small>On Try first, it stops nothing</small>}
          </div>
          {r.why && <Written as="p" className="note" text={r.why} />}
          {r.answers && (
            <ol dir={detect(r.answers.map((a) => a.question).join(' ')).dir}>
              {r.answers.map((a) => (
                <li key={a.question} {...langProps(a.question)}>
                  <Written text={a.question} /> <b className={a.answer === 'no' ? 'no' : ''}>{a.answer === 'yes' ? 'Yes' : a.answer === 'no' ? 'No' : 'Not answered'}</b>
                  {a.why && <Written as="small" text={` ${a.why}`} />}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

/** The "done when" items that show on no screen, with why: they need no picture. At your check, LookYourself lists them. */
export function OffScreenList({ t }: { t: Pick<Ticket, 'offScreen' | 'waiting' | 'stage' | 'stuck'> }) {
  if (!t.offScreen?.length || waitsAtReview(t)) return null;
  return (
    <div className="offscreen">
      <div className="lbl">Not on a screen</div>
      <ul>
        {t.offScreen.map((o) => (
          <li key={o.criterion}>
            <Written as="b" text={o.criterion} />
            <Written text={o.why} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * At your check: each "done when" the screenshots could not show, in full or in part, with why. Nobody saw those on a
 * screen, so they are the ones to look at yourself.
 */
export function LookYourself({ t }: { t: Pick<Ticket, 'proof' | 'offScreen'> }) {
  const rows = notOnScreen(t);
  if (!rows.length) return null;
  return (
    <div className="offscreen">
      <div className="lbl">Not on a screen, so look at these yourself</div>
      <ul>
        {rows.map((o) => (
          <li key={o.criterion}>
            <Written as="b" text={o.criterion} />
            <Written text={o.why} />
          </li>
        ))}
      </ul>
    </div>
  );
}
