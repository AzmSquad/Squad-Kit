import { FlaskConical } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

/**
 * The Architect's design changes the project's test command. The test command decides what the checks prove, so it
 * never changes on its own: the person uses the new one or keeps the current one. Shown with the design (Plan tab and
 * the design review), and on its own in Now for a ticket whose plan was approved by itself (Express).
 * Terminal: `squad test-command <ticket> --use | --keep`.
 */
export function TestCommandCard({ t, banner }: { t: Ticket; banner?: boolean }) {
  const act = useAct<Ticket>();
  const c = t.testChange;
  if (!c) return null;
  const decide = (use: boolean) =>
    act.mutate({
      path: `/api/v1/tickets/${t.id}/test-command`,
      body: { use },
      done: use ? `The test command is now ${c.to}.` : `Kept the test command ${c.from}.`,
    });
  const card = (
    <div className="outdated-item testchange">
      <div className="outdated-head">
        <span className="ic">
          <FlaskConical size={15} />
        </span>
        <b>
          The Architect suggests changing the test command from <code>{c.from}</code> to <code>{c.to}</code>
        </b>
      </div>
      <p>The test command decides what the checks prove, so only you can change it. The checks keep using <code>{c.from}</code> until you choose.</p>
      <div className="row">
        <button className="btn sm pri" disabled={act.isPending} onClick={() => decide(true)}>
          Use the new command
        </button>
        <button className="btn sm" disabled={act.isPending} onClick={() => decide(false)}>
          Keep the current one
        </button>
        <span className="grow" />
        <Cmd text={`squad test-command ${t.id} --use`} />
      </div>
    </div>
  );
  return banner ? (
    <div className="outdated" aria-label="Change to the test command">
      {card}
    </div>
  ) : (
    card
  );
}
