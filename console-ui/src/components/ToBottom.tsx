import { ArrowDown } from 'lucide-react';
import type { Stick } from '../lib/stick-to-bottom';
import '../styles/chat-scroll.css';

/**
 * Scrolled up in a chat: "3 new messages" takes you down to them; with nothing new, a small arrow takes you to the
 * newest. It sits at the bottom of the chat's view, over the messages, and goes once you are at the bottom.
 */
export function ToBottom({ s }: { s: Stick }) {
  if (s.pinned) return null;
  const words = s.unseen ? `${s.unseen} new ${s.unseen === 1 ? 'message' : 'messages'}` : '';
  return (
    <div className="tobottom-w">
      <button className={`tobottom ${words ? 'has' : ''}`} onClick={() => s.toBottom(true)} aria-label={words ? `${words}: go down to them` : 'Go to the newest message'}>
        <ArrowDown size={14} strokeWidth={2.4} aria-hidden="true" />
        {words && <span>{words}</span>}
      </button>
    </div>
  );
}

/** The line above the first message you have not read yet, where a talk opens. */
export function NewLine() {
  return (
    <div className="newline" data-new-line role="separator" aria-label="New messages from here">
      <span>New</span>
    </div>
  );
}
