import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { Ticket } from '../../api/types';
import { detect, textClass } from '../../lib/lang';

/**
 * "Something's wrong" or "Ask for changes" on a decision card asks for the words in the chat's own box, which then
 * sends them to the board as the story's own "send back", not to the agent or the lead.
 */

/** "Something's wrong" asks for the words in the chat's own box; the box sends them to the board, not to the chat. */
export interface BoxAsk {
  /** What the box says while it waits for the words. */
  placeholder: string;
  /** The small line over the box: where the words go. */
  label: string;
  send(text: string): void;
}

/** The chat's box, when the card sits in one: a card asks it for the words, and lets go of its own ask only. */
export interface ChatBoxDoor {
  ask(b: BoxAsk): void;
  release(b: BoxAsk): void;
}

/** The chat's box, when the card sits in one. Without it, the card asks for the words itself. */
export const ChatBox = createContext<ChatBoxDoor | null>(null);

/**
 * The chat's side: what its box asks for now, if anything, and the door its cards use. The door stays the same from
 * one render to the next, so a card never lets go of an ask by accident. `onAsk` runs when a card asks (focus the box).
 */
export function useBoxAsk(onAsk?: () => void): { box: BoxAsk | null; cancel(): void; door: ChatBoxDoor } {
  const [box, setBox] = useState<BoxAsk | null>(null);
  const focus = useRef(onAsk);
  focus.current = onAsk;
  const ask = useCallback((b: BoxAsk) => {
    setBox(b);
    focus.current?.();
  }, []);
  const release = useCallback((b: BoxAsk) => setBox((now) => (now === b ? null : now)), []);
  const cancel = useCallback(() => setBox(null), []);
  const door = useMemo(() => ({ ask, release }), [ask, release]);
  return { box, cancel, door };
}

/** A card's side: it asks the chat's box for the words, and lets go of its own ask when it is done or goes away. Null without a box. */
export function useCardBox(): { ask(b: BoxAsk): void; done(): void } | null {
  const door = useContext(ChatBox);
  const mine = useRef<BoxAsk | null>(null);
  useEffect(
    () => () => {
      if (mine.current) door?.release(mine.current);
    },
    [door],
  );
  const ask = useCallback(
    (b: BoxAsk) => {
      mine.current = b;
      door?.ask(b);
    },
    [door],
  );
  const done = useCallback(() => {
    if (mine.current) door?.release(mine.current);
    mine.current = null;
  }, [door]);
  return useMemo(() => (door ? { ask, done } : null), [door, ask, done]);
}

/** "Goes back to the Builder on MA-17", over the box, while the box asks what is wrong. */
export function BoxLine({ box, onCancel }: { box: BoxAsk; onCancel(): void }) {
  return (
    <div className="boxask" role="status">
      <span>{box.label}</span>
      <button className="linkbtn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** A talk that is over, or none yet, while the decision card asks what is wrong: the box only sends that. */
export function BoxOnly({ t, box, onCancel }: { t: Ticket; box: BoxAsk; onCancel(): void }) {
  const [words, setWords] = useState('');
  const d = detect(words);
  return (
    <div className="ccomp">
      <BoxLine box={box} onCancel={onCancel} />
      <div className="cbox">
        <textarea
          className={`cta ${words ? textClass(d) : 't-en'}`}
          dir={words ? d.dir : 'auto'}
          rows={1}
          autoFocus
          value={words}
          placeholder={box.placeholder}
          aria-label={`What is wrong with ${t.id}`}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && words.trim()) {
              e.preventDefault();
              box.send(words.trim());
            }
          }}
        />
        <div className="crow">
          <span className="grow" />
          <button className="csend" onClick={() => words.trim() && box.send(words.trim())} disabled={!words.trim()} aria-label="Send">
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
