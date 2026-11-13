import { Link } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import type { ChatMessage } from '../../api/types';
import { useAct } from '../../lib/data';
import { WORDS, langOf } from '../../lib/split';
import { Written } from '../ui';
import '../../styles/split.css';

/**
 * Under a text pasted into a story's talk that looks like several stories or a whole requirements document: a talk
 * beside the work changes nothing on the story, so the hint says where it becomes stories. A whole document is one
 * press from Requirements (`squad split <ticket> --chat-requirements`); once sent, the message keeps its breakdown and
 * the hint links to it. squad-kit's own count, no AI.
 */
export function SizeHint({ story, m }: { story: string; m: ChatMessage }) {
  const act = useAct();
  const lang = langOf(m.text);
  const w = WORDS[lang];
  if (!m.big) return null;
  return (
    <div className="sizehint" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <Info size={13} aria-hidden="true" />
      <Written text={m.big === 'brd' ? w.big.brd : w.big.few} />
      {m.big === 'brd' &&
        (m.breakdown ? (
          <Link to="/requirements/$id" params={{ id: m.breakdown }} className="linkbtn">
            {m.breakdown}
          </Link>
        ) : (
          <button className="linkbtn" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${story}/chat/requirements`, body: { at: m.at } })}>
            {w.brd.send}
          </button>
        ))}
    </div>
  );
}
