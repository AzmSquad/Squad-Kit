import { FlaskConical } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct } from '../lib/data';
import { Cmd } from './ui';

/**
 * squad-kit settles a change to the test command by itself, by trying it. This card only shows when it cannot tell: one
 * plain sentence and two choices, with the commands under the details, for engineers. Shown with the design (Plan tab
 * and the design review), and on its own in Now.
 * Terminal: `squad test-command <ticket> --use | --keep`.
 */
export function TestCommandCard({ t, banner }: { t: Ticket; banner?: boolean }) {
  const act = useAct<Ticket>();
  const c = t.testChange;
  if (!c?.ask) return null;
  const decide = (use: boolean) =>
    act.mutate({
      path: `/api/v1/tickets/${t.id}/test-command`,
      body: { use },
      done: use ? 'squad-kit tests this project the new way from now on.' : 'squad-kit keeps the current way of testing.',
    });
  const card = (
    <div className="outdated-item testchange">
      <div className="outdated-head">
        <span className="ic">
          <FlaskConical size={15} />
        </span>
        <b>The way this project&apos;s tests run changed, and squad-kit cannot tell if the new way checks as much as the current one.</b>
      </div>
      <div className="row">
        <button className="btn sm pri" disabled={act.isPending} title="The checks stay as they are, and the Builder fixes what they find." onClick={() => decide(false)}>
          Keep the current way
        </button>
        <button className="btn sm" disabled={act.isPending} title="The checks use the new way from now on." onClick={() => decide(true)}>
          Use the new way
        </button>
        <span className="grow" />
        <Cmd text={`squad test-command ${t.id} --keep`} />
      </div>
      <details className="costdetails">
        <summary>Details for engineers</summary>
        <p className="note">
          Current: <code>{c.from}</code>
          <br />
          New: <code>{c.to}</code>
          {c.ran ? (
            <>
              <br />
              {c.ran}
            </>
          ) : null}
        </p>
      </details>
    </div>
  );
  return banner ? (
    <div className="outdated" aria-label="A choice about the tests">
      {card}
    </div>
  ) : (
    card
  );
}
