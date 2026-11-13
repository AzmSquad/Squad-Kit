import { useEffect, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { PHONE, maxOpen, notShownHere, popups, shownPops, useMedia, usePopups, useWidth } from '../../lib/popups';
import { useShownHere } from '../../lib/here';
import { DocPane, type OpenDoc } from '../ChatFiles';
import { Heads } from './Heads';
import { LeadPopup } from './LeadPopup';
import { StoryPopup } from './StoryPopup';
import '../../styles/lead.css';
import '../../styles/popups.css';

/**
 * Chat heads and popups on every page of a project: a round head for the Squad lead and one for each open talk, at
 * the bottom right, in a gutter of their own so they never cover the page. A press opens that talk in a popup over
 * the page, up to three side by side; each can be minimised to a bar, closed, or opened on its full page. ⌘K or Ctrl+K
 * opens the lead. A talk the page shows itself has no popup meanwhile (lib/here.ts), and the Squad lead page has no
 * lead head. On a phone-width window one popup at a time fills the screen and the heads stay under it.
 */
export function ChatPopups() {
  const all = usePopups();
  const here = useShownHere();
  const s = notShownHere(all, here);
  const phone = useMedia(PHONE);
  const max = maxOpen(useWidth(), phone);
  const shown = shownPops(s, max);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const onLead = path.startsWith('/lead');
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
      {/* Every open popup keeps its head, a hidden one too: its talk is on this page. */}
      <Heads s={all} here={here} noLead={onLead} />
    </div>
  );
}
