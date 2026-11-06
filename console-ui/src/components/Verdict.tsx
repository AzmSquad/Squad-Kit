import { Check, EyeOff, MonitorOff, X } from 'lucide-react';
import { assetUrl } from '../api/client';
import type { ProofShot, Ticket } from '../api/types';
import { pageOf, waitsAtReview } from '../lib/review';
import { isApiProof, notOnScreen, verdictClass, verdictWord } from '../lib/verdict';
import '../styles/verdict.css';
import { ApiProof } from './ApiProof';

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
              {m.note && <span>{m.note}</span>}
              {pageOf(m) && <code>{pageOf(m)}</code>}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** What the change touches that the plan did not include, in the Reviewer's words. It never blocks: the person should see it. */
export function AlsoChanged({ t, className }: { t: Pick<Ticket, 'alsoChanged'>; className?: string }) {
  if (!t.alsoChanged?.length) return null;
  return (
    <p className={`note alsochanged${className ? ` ${className}` : ''}`}>
      <b>Also changed, not in the plan:</b> {t.alsoChanged.join('; ')}.
    </p>
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
            <b>{o.criterion}</b>
            <span>{o.why}</span>
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
            <b>{o.criterion}</b>
            <span>{o.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
