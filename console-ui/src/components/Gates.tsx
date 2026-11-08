import { Check, CircleAlert } from 'lucide-react';
import type { GateState, Gates, Ticket } from '../api/types';
import { NOT_CHECKED_WHY, notCheckedWhy, oldFailuresWhy, oldShort } from '../lib/gates';
import { Written } from './ui';

/** One gate as it really is: green only when it passed; orange when you continued past it or no tests ran. */
export function GatePill({ state, text }: { state?: GateState; text: string }) {
  const cls = state === 'pass' ? 'ok' : state === 'skipped' ? 'skip' : state === 'unchecked' ? 'unchecked' : 'wait';
  return (
    <span className={`pill ${cls}`} title={state === 'unchecked' ? NOT_CHECKED_WHY : undefined}>
      {state === 'pass' && <Check size={13} strokeWidth={2.5} />}
      {state === 'unchecked' && <CircleAlert size={13} strokeWidth={2.5} />}
      {text}
    </span>
  );
}

/** Under the gates, when old tests also fail on main: which, and the story that fixes them. */
export function OldFailuresNote({ g, className = '' }: { g: Gates | undefined | null; className?: string }) {
  const why = oldFailuresWhy(g);
  if (!why) return null;
  return (
    <p className={`note unchecked-why old-fails ${className}`}>
      <CircleAlert size={14} strokeWidth={2.4} aria-hidden="true" />
      <span>
        <b>{oldShort(g!.oldFailures!.length)}.</b> <Written text={why} />
      </span>
    </p>
  );
}

/** Under the gates, when no tests ran: why it is not a pass, and what did pass. */
export function NotCheckedNote({ g, className = '' }: { g: Gates | undefined | null; className?: string }) {
  const why = notCheckedWhy(g);
  if (!why) return null;
  return (
    <p className={`note unchecked-why ${className}`}>
      <CircleAlert size={14} strokeWidth={2.4} aria-hidden="true" />
      <span>
        <b>Not checked.</b> {why}
      </span>
    </p>
  );
}

const NO_NEW_TESTS = 'Built without new tests';
const NO_NEW_TESTS_WHY = "Write new tests was off when this story was made, so the Builder wrote no new tests. squad-kit still ran your project's own checks, the review and the proof.";

/** The label of a story built without new tests: in the story, on its proof and in the release. */
export function NoNewTestsLabel({ t }: { t: Pick<Ticket, 'noNewTests'> }) {
  if (!t.noNewTests) return null;
  return (
    <span className="prio notests" title={NO_NEW_TESTS_WHY}>
      {NO_NEW_TESTS}
    </span>
  );
}

/** The short form, on a card. */
export function NoNewTestsTag({ t }: { t: Pick<Ticket, 'noNewTests'> }) {
  if (!t.noNewTests) return null;
  return (
    <span className="prio notests" title={`${NO_NEW_TESTS}. ${NO_NEW_TESTS_WHY}`}>
      No new tests
    </span>
  );
}
