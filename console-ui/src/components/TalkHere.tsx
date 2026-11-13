import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Ticket } from '../api/types';
import { focusBoxIn, useShowsTalk } from '../lib/here';
import { ChatView } from './Chat';
import { DocPane, type OpenDoc } from './ChatFiles';

/**
 * A story's talk on its Conversation tab, in the drawer or the story's full page: the same talk as its popup, with its
 * own box. While the tab shows it, the popup hides and the head brings this box into view (lib/here.ts).
 */
export function TalkHere({ t }: { t: Ticket }) {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useShowsTalk(t.id, () => focusBoxIn(box.current));
  // The talk fills the window under the tabs, so its own box is in view without scrolling the drawer.
  useLayoutEffect(() => {
    const fit = () => {
      const el = box.current;
      if (el) el.style.height = `${Math.max(360, window.innerHeight - el.getBoundingClientRect().top - 20)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div className="talkhere" ref={box}>
      <ChatView id={t.id} size="pop" onOpenDoc={setDoc} />
      {/* A file opened from the talk lies over the page, at its top level: nothing that moves around it can hold it. */}
      {doc &&
        createPortal(
          <div className="talkhere-doc">
            <DocPane doc={doc} onClose={() => setDoc(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
