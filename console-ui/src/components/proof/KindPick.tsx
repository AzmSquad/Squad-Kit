import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import type { LineProofKind } from '../../api/proof-kind';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { KINDS, KIND_NAME, KIND_SMALL, LOCK_NOTE, MENU_FOOT, kindsOpen, proveCommand } from '../../lib/proof-kinds';
import { typedDir } from '../../lib/lang';
import { Cmd, Written } from '../ui';
import { KIND_ICON, KindChip } from './KindChip';

/**
 * How one "done when" of the spec will be proved: the Analyst's choice as a chip, its reason under the line, and before
 * the spec is approved a menu to change it. On a line squad-kit locked, the other kinds are off, with why. After the
 * approval the chip is read only. A spec with no kinds (an old one) shows nothing here.
 */
export function KindPick({ t, i }: { t: Ticket; i: number }) {
  const c = t.criteria?.[i];
  const [open, setOpen] = useState(false);
  if (!c?.proof) return null;
  const p = c.proof;
  const can = kindsOpen(t);
  return (
    <>
      {p.why && !p.locked && <Written className="kindwhy" text={p.why} />}
      <div className="kindpick">
        {can ? (
          <button type="button" className="kindbtn" aria-haspopup="menu" aria-expanded={open} aria-label={`How "done when" ${i + 1} is proved: ${KIND_NAME[p.kind]}. Change it`} onClick={() => setOpen((o) => !o)}>
            <KindChip kind={p.kind} locked={p.locked} caret />
          </button>
        ) : (
          <KindChip kind={p.kind} locked={p.locked} />
        )}
        {p.locked && p.why && <Written as="small" className="kindrule" text={p.why} />}
        {open && <KindMenu t={t} line={i + 1} current={p.kind} locked={Boolean(p.locked)} why={p.why} onClose={() => setOpen(false)} />}
      </div>
    </>
  );
}

function KindMenu({ t, line, current, locked, why, onClose }: { t: Ticket; line: number; current: LineProofKind; locked: boolean; why?: string; onClose(): void }) {
  const act = useAct();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<LineProofKind>(current);
  // Not on a screen needs a reason first: the Reviewer checks it.
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState(current === 'none' ? (why ?? '') : '');
  // Near the bottom of the window the menu opens upward, so all of it stays in view.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (r && r.bottom > window.innerHeight - 12 && r.top - r.height - 40 > 0) setUp(true);
  }, []);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const pick = (kind: LineProofKind, said?: string) => {
    if (kind === current && kind !== 'none') return onClose();
    act.mutate({ path: `/api/v1/tickets/${t.id}/prove`, body: { line, kind, ...(said ? { why: said } : {}) }, done: `"Done when" ${line} is proved by ${KIND_NAME[kind]} now.` }, { onSuccess: onClose });
  };
  return (
    <div className={`kindmenu${up ? ' up' : ''}`} role="menu" ref={box} aria-label={`How should line ${line} be proved?`}>
      <div className="mh">How should line {line} be proved?</div>
      {KINDS.map((k) => {
        const Icon = KIND_ICON[k];
        const off = locked && k !== 'screen';
        return (
          <button
            key={k}
            type="button"
            role="menuitemradio"
            aria-checked={k === current}
            className={`opt k-${k}${k === current ? ' on' : ''}${off ? ' off' : ''}`}
            disabled={off || act.isPending}
            onMouseEnter={() => setHover(k)}
            onFocus={() => setHover(k)}
            onClick={() => (k === 'none' ? setAsking(true) : pick(k))}
          >
            <span className="ic">
              <Icon aria-hidden="true" />
            </span>
            <span>
              <b>{KIND_NAME[k]}</b>
              <small>{KIND_SMALL[k]}</small>
            </span>
            <Check className="tick" aria-hidden="true" />
          </button>
        );
      })}
      {asking && (
        <div className="kindwhyask">
          <input className="input" autoFocus dir={typedDir(reason)} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why can it not be shown? The Reviewer checks it." onKeyDown={(e) => e.key === 'Enter' && reason.trim() && pick('none', reason.trim())} />
          <button type="button" className="btn pri sm" disabled={!reason.trim() || act.isPending} onClick={() => pick('none', reason.trim())}>
            Save
          </button>
        </div>
      )}
      <div className="mf">
        {locked ? <Lock aria-hidden="true" /> : null}
        <span>{locked ? LOCK_NOTE : MENU_FOOT}</span>
      </div>
      <div className="mcmd">
        <Cmd text={proveCommand(t.id, line, asking ? 'none' : hover, asking ? reason.trim() || '…' : undefined)} />
      </div>
    </div>
  );
}
