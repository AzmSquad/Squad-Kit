import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { Written } from '../../components/ui';
import { useDraft } from '../../lib/drafts';
import { typedDir } from '../../lib/lang';

/** A decision approved after this ticket was planned changes it. The person updates the plan or keeps it, with a reason. */
export function OutdatedBanner({ t }: { t: Ticket }) {
  const act = useAct<Ticket>();
  const [keeping, setKeeping] = useState<string | null>(null);
  const [reason, setReason, clearReason] = useDraft(t.id, 'keep-reason', '');
  const merged = Boolean(t.mergedAt) || t.stage === 'done';
  return (
    <div className="outdated">
      {t.outdated!.map((o) => (
        <div key={o.adr} className="outdated-item">
          <div className="outdated-head">
            <span className="ic"><TriangleAlert size={15} /></span>
            <b>
              <Link to="/architecture" search={{ adr: o.adr }}>{o.adr}</Link> came after this plan and changes it
            </b>
          </div>
          <Written as="p" text={o.why} />
          <Written as="p" lead={<span className="note">{merged ? 'What a follow-up would change:' : 'What would change:'}</span>} text={o.change} />
          {keeping === o.adr ? (
            <div className="row">
              <input className="input" autoFocus dir={typedDir(reason)} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why the plan stays as it is" />
              <button className="btn sm" disabled={!reason.trim() || act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/decision-update`, body: { adr: o.adr, do: 'keep', reason }, done: 'Kept the plan. The reason is on the ticket.' }, { onSuccess: () => { setKeeping(null); clearReason(); } })}>
                Keep it
              </button>
              <button className="btn sm quiet" onClick={() => setKeeping(null)}>Cancel</button>
            </div>
          ) : (
            <div className="row">
              <button
                className="btn sm pri"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/api/v1/tickets/${t.id}/decision-update`,
                    body: { adr: o.adr, do: 'update' },
                    done: merged ? 'Made a follow-up ticket.' : 'The Architect is updating the plan.',
                  })
                }
              >
                {merged ? 'Make a follow-up ticket' : 'Update the plan'}
              </button>
              <button className="btn sm" onClick={() => { setKeeping(o.adr); setReason(''); }}>
                Keep it as is
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
