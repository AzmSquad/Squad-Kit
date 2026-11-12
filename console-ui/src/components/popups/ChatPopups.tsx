import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { PHONE, maxOpen, popups, shownPops, useMedia, usePopups, useWidth } from '../../lib/popups';
import { DocPane, type OpenDoc } from '../ChatFiles';
import { Heads } from './Heads';
import { LeadPopup } from './LeadPopup';
import { StoryPopup } from './StoryPopup';
import '../../styles/lead.css';
import '../../styles/popups.css';

/**
 * Chat heads and popups on every page of a project: a round head for the Squad lead and one for each open talk, at
 * the bottom right. A press opens that talk in a popup over the page, up to three side by side; each can be minimised
 * to a bar, closed, or opened on its full page. The board keeps its whole width. ⌘K or Ctrl+K opens the lead.
 * On a phone-width window one popup at a time fills the screen and the heads stay under it.
 */
export function ChatPopups() {
  const s = usePopups();
  const phone = useMedia(PHONE);
  const max = maxOpen(useWidth(), phone);
  const shown = shownPops(s, max);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      // On the Squad lead page the keys go to its own box.
      const own = path.startsWith('/lead') ? document.getElementById('lead-page-ask') : null;
      if (own) return own.focus();
      popups.toggle('lead');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [path]);
  return (
    <div className={`chatpops ${phone ? 'phone' : ''} ${shown.some((p) => !p.min) ? 'has-open' : ''}`}>
      <div className="pops">
        {shown.map((p) => (p.id === 'lead' ? <LeadPopup key="lead" pop={p} /> : <StoryPopup key={p.id} pop={p} onOpenDoc={setDoc} />))}
      </div>
      {doc && <DocPane doc={doc} onClose={() => setDoc(null)} />}
      {!s.open.length && !phone && (
        <button className="asklabel" onClick={() => popups.open('lead')}>
          Ask the lead <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      )}
      <Heads s={s} />
    </div>
  );
}
