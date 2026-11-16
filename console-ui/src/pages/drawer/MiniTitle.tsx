import type { Ticket } from '../../api/types';
import { TRACK, Written } from '../../components/ui';

/** The ticket's title and step on its top row, once the big title has scrolled away (drawer/scroll.ts). */
export function MiniTitle({ t }: { t: Ticket }) {
  const stage = t.stage === 'bugs' ? 'tickets' : t.stage;
  const step = stage === 'done' ? 'Done' : TRACK.find((s) => s.stage === stage)?.name;
  const yours = !!t.waiting && !t.now?.merging;
  return (
    <span className="dmini">
      <Written as="b" text={t.title} />
      {step && <span className={`dmini-step ${yours ? 'you' : ''}`}>{yours ? `${step}, your turn` : step}</span>}
    </span>
  );
}
