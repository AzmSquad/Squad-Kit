import { useState } from 'react';
import { Check, Copy, MessagesSquare, Square, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { Ticket } from '../api/types';
import { useAct, useBoard } from '../lib/data';
import { waitsAtReview } from '../lib/review';
import { Cmd, Modal } from './ui';
import { isMine } from './HandOver';

/**
 * A story worked on in a conversation in any AI tool, outside squad-kit (src/board/outside.ts). Copy prompt moves it there,
 * Bring it back ends that, and the label stays on its record. squad-kit trusts only what it ran itself: Check runs it.
 */

export function canWorkOutside(t: Ticket, me: string | undefined, live: boolean): boolean {
  return live && (!me || isMine(t, me)) && !t.takenOver && !t.deleting && !t.archived && t.stage !== 'release' && t.stage !== 'done' && !(t.chat?.open && !t.chat.beside);
}

async function copied(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The words, in full: the clipboard can say no, and a person may want to read them first. */
function PromptWords({ prompt, inClipboard }: { prompt: string; inClipboard: boolean }) {
  return (
    <>
      <p className="note" role="status">{inClipboard ? 'Copied. Paste it in a conversation in any AI tool.' : 'Select these words, copy them, and paste them in a conversation in any AI tool.'}</p>
      <textarea className="waynote prompt-box" rows={9} readOnly value={prompt} aria-label="The prompt" onFocus={(e) => e.target.select()} />
    </>
  );
}

const WHAT_IT_MEANS = [
  'What you spend there is yours: squad-kit does not count it.',
  "squad-kit's guard and limits do not apply there.",
  'When it comes back it keeps a label on its record. You can ask squad-kit to check the work.',
];

export function OutsideDialog({ t, onClose }: { t: Ticket; onClose(): void }) {
  const act = useAct<{ prompt: string }>();
  const stop = useAct();
  const [words, setWords] = useState<{ prompt: string; inClipboard: boolean } | null>(null);
  // A running step would go on writing in the story: it finishes, or it stops first.
  const working = !words && Boolean(t.live || t.squad || t.stopRequested);
  const go = () => act.mutate({ path: `/api/v1/tickets/${t.id}/outside` }, { onSuccess: async (data) => setWords({ prompt: data.prompt, inClipboard: await copied(data.prompt) }) });
  return (
    <Modal
      title={`Work on ${t.id} in another AI tool`}
      onClose={onClose}
      icon={<span className="glyph"><MessagesSquare size={15} /></span>}
      footer={
        words ? (
          <button className="btn pri" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn pri" disabled={act.isPending || working} onClick={go}>
              <Copy size={15} /> {act.isPending ? 'Getting it ready…' : 'Copy prompt'}
            </button>
            {working && (
              <button className="btn" disabled={stop.isPending || t.stopRequested} onClick={() => stop.mutate({ path: `/api/v1/tickets/${t.id}/stop`, done: 'Stopping the squad' })}>
                <Square size={13} /> {t.stopRequested ? 'Stopping…' : 'Stop'}
              </button>
            )}
            <button className="btn" onClick={onClose}>Cancel</button>
            <span className="grow" />
            <Cmd text={`squad outside start ${t.id}`} />
          </>
        )
      }
    >
      {words ? (
        <PromptWords prompt={words.prompt} inClipboard={words.inClipboard} />
      ) : (
        <>
          <p>Paste the prompt in a conversation in any AI tool. It goes on from where this story is now, by this project&apos;s own structure, and this page shows it at its real step.</p>
          <p className="note">{working ? 'The squad is working on it right now. Press Stop first, or wait until it needs you.' : 'The squad keeps off this story until you bring it back.'}</p>
          <ul className="note">{WHAT_IT_MEANS.map((w) => <li key={w}>{w}</li>)}</ul>
        </>
      )}
    </Modal>
  );
}

/** A new story, made from the conversation. Nothing changes here until it starts there. */
export function OutsideNewButton() {
  const board = useBoard();
  const [words, setWords] = useState<{ prompt: string; inClipboard: boolean } | null>(null);
  const [failed, setFailed] = useState('');
  if (!(board.data?.ready && board.data.meta.engine === 'live')) return null;
  const go = async () => {
    setFailed('');
    try {
      const { prompt } = await api<{ prompt: string }>('/api/v1/outside-prompt');
      setWords({ prompt, inClipboard: await copied(prompt) });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <button className="btn" onClick={() => void go()} title="Copy a prompt, and start this story in a conversation in any AI tool">
        <MessagesSquare size={15} /> Start in another AI tool
      </button>
      {failed && <span className="note" role="alert">{failed}</span>}
      {words && (
        <Modal title="Start a story in another AI tool" onClose={() => setWords(null)} icon={<span className="glyph"><MessagesSquare size={15} /></span>} footer={<button className="btn pri" onClick={() => setWords(null)}>Done</button>}>
          <PromptWords prompt={words.prompt} inClipboard={words.inClipboard} />
          <ul className="note">{WHAT_IT_MEANS.map((w) => <li key={w}>{w}</li>)}</ul>
        </Modal>
      )}
    </>
  );
}

/** While a conversation has it: the words again, and the way back. */
export function OutsidePanel({ t, extra }: { t: Ticket; extra?: ReactNode }) {
  const act = useAct();
  const [words, setWords] = useState<{ prompt: string; inClipboard: boolean } | null>(null);
  const [failed, setFailed] = useState('');
  const again = async () => {
    setFailed('');
    try {
      const { prompt } = await api<{ prompt: string }>(`/api/v1/tickets/${t.id}/outside-prompt`);
      setWords({ prompt, inClipboard: await copied(prompt) });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring"><MessagesSquare size={15} /></span>
          <div>
            <b>In a conversation outside squad-kit</b>
            <span>The squad waits. This page reads the story&apos;s files, so it shows the real step.</span>
          </div>
        </div>
        <p className="note" style={{ fontSize: 12.5, marginTop: 8 }}>
          When you are done, bring it back. It comes back at its real step: with code, you can check it and accept it here. With only a spec or a design, you approve that and the squad carries on. If nothing changed, it is as it was.
        </p>
        {failed && <p className="note" role="alert">{failed}</p>}
        {words && <PromptWords prompt={words.prompt} inClipboard={words.inClipboard} />}
        {extra}
      </div>
      <div className="df">
        <button className="btn pri" disabled={act.isPending} onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/bring-back`, done: `${t.id} is back on the board.` })}>
          <Undo2 size={15} /> {act.isPending ? 'Looking at the work…' : 'Bring it back'}
        </button>
        <button className="btn" onClick={() => void again()}>
          <Copy size={15} /> Copy prompt
        </button>
        <span className="grow" />
        <Cmd text={`squad outside back ${t.id}`} />
      </div>
    </>
  );
}

function outsideWords(o: NonNullable<Ticket['outside']>): string {
  return o.from ? `Continued outside from ${o.from}` : 'Worked outside squad-kit';
}

const LABEL_WHY = 'squad-kit trusts only what it ran itself. This story was worked on in a conversation outside it.';

/** The label on the story, its tiny Check, and Checked once squad-kit's own checks, review and proof passed. */
export function OutsideLabel({ t }: { t: Ticket }) {
  const act = useAct();
  const o = t.outside;
  if (!o) return null;
  const canCheck = !o.checked && !t.takenOver && t.stage !== 'release' && t.stage !== 'done' && waitsAtReview(t);
  return (
    <span className="outlabel">
      <span className="prio outside" title={LABEL_WHY}>{outsideWords(o)}</span>
      {o.checked && !t.takenOver ? (
        <span className="prio outside checked" title={o.checked.noTests ? "squad-kit's checks ran, but the project has no tests. The review and the proof passed." : "squad-kit's own checks, review and proof passed."}>
          <Check size={11} strokeWidth={3} /> {o.checked.noTests ? 'Checked, no tests ran' : 'Checked'}
        </span>
      ) : canCheck ? (
        <button
          className="btn sm tiny"
          disabled={act.isPending}
          title="squad-kit runs its own checks, review and proof on this work. They use AI, like on any story."
          onClick={() => act.mutate({ path: `/api/v1/tickets/${t.id}/check-outside`, done: 'squad-kit is checking the work.' })}
        >
          Check
        </button>
      ) : null}
    </span>
  );
}

/** The short form, on a card. */
export function OutsideTag({ t }: { t: Ticket }) {
  if (!t.outside && !t.takenOver?.free) return null;
  const checked = Boolean(t.outside?.checked) && !t.takenOver;
  const words = t.takenOver?.free ? 'In a conversation outside squad-kit' : outsideWords(t.outside!);
  return <span className={`prio outside${checked ? ' checked' : ''}`} title={words}>{checked ? 'Outside, checked' : 'Outside'}</span>;
}
