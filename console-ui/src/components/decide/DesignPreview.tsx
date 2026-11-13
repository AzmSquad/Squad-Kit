import type { Ticket } from '../../api/types';
import { Mockup } from '../Attachments';

/**
 * The design card shows the design: the Architect's mockup as a small picture inside the card, the same mockup the
 * plan tab and the chat show, and "Open the mockup" for the full one in the board's own viewer. Never blind.
 */
export function DesignPreview({ t }: { t: Pick<Ticket, 'id' | 'title' | 'mockup'> }) {
  if (!t.mockup) return null;
  return <Mockup ticket={t.id} file={t.mockup} title={`${t.title}: mockup`} preview />;
}
