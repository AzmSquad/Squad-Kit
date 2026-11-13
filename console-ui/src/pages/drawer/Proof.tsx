import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { assetUrl } from '../../api/client';
import type { Ticket } from '../../api/types';
import { useAct } from '../../lib/data';
import { ApiProof } from '../../components/ApiProof';
import { Cmd, Written } from '../../components/ui';
import { Lightbox } from '../../components/Lightbox';
import { GatePill, NotCheckedNote, OldFailuresNote } from '../../components/Gates';
import { checksWords, noGateRan, noShotsText, overrideWhat, proofLead, proofWords } from '../../lib/gates';
import { AlsoChanged, MorePictures, OffScreenList, VerdictIcon, VerdictTag } from '../../components/Verdict';
import { isApiProof, proofViewer, verdictClass, verdictNote } from '../../lib/verdict';
import { YourCheck } from '../../components/YourCheck';
import { pageOf } from '../../lib/review';
import { useDraft } from '../../lib/drafts';
import { langProps, typedDir } from '../../lib/lang';

/* ── Proof ─────────────────────────────────────────────── */

export function GatePills({ t }: { t: Ticket }) {
  const g = t.gates;
  if (t.outside && t.waiting?.kind === 'proof' && noGateRan(g)) {
    return (
      <div className="pills">
        <GatePill state="pending" text="Checks not run" />
        <GatePill state="pending" text="No review" />
        <GatePill state="pending" text="No proof" />
      </div>
    );
  }
  return (
    <>
      <div className="pills">
        <GatePill state={g?.checks} text={checksWords(g)} />
        <GatePill state={g?.review} text={g?.review === 'pass' ? `Review approved by ${g.reviewBy}` : g?.review === 'skipped' ? 'Review notes open, you continued' : 'Review approved'} />
        <GatePill state={g?.proof} text={proofWords(t)} />
      </div>
      <NotCheckedNote g={g} />
      <OldFailuresNote g={g} />
      {t.overrides?.map((o) => (
        <p className="note override" key={o.at}>
          <b>Continued anyway</b> past the {overrideWhat(o)}, by <Written text={o.by} />: <Written text={o.reason} />
        </p>
      ))}
    </>
  );
}

export function ProofShots({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  if (!t.proof?.length) {
    return (
      <>
        <p className="note">{noShotsText(t)}</p>
        <OffScreenList t={t} />
      </>
    );
  }
  const { pictures, starts } = proofViewer(t.proof, (file) => assetUrl(`/api/v1/proof/${file}`));
  return (
    <>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      {t.proof.map((p, k) => (
        <div className={`critrow ${verdictClass(p.shows)}`} key={p.criterion}>
          <h5 {...langProps(p.criterion)}>
            <VerdictIcon shows={p.shows} />
            <Written text={p.criterion} />
            <VerdictTag shows={p.shows} />
          </h5>
          {verdictNote(p) && <Written as="p" className="verdictnote" text={verdictNote(p)!} />}
          {pageOf(p) && (
            <p className="critpage">
              Page <code>{pageOf(p)}</code>
            </p>
          )}
          {isApiProof(p.after) ? <ApiProof file={p.after} {...(p.note ? { note: p.note } : {})} /> : <div className="proofmini">
            <div className={p.beforeDevice ? 'ondevice' : undefined}>
              <Written as="small" text={p.beforeLabel} />
              <button className="zoom" onClick={() => setZoom(starts[k]!)} aria-label={`Open ${p.beforeLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.before}`)} alt={`${p.criterion}, ${p.beforeLabel}`} />
              </button>
              {p.beforeDevice && <small className="shotdevice">{p.beforeDevice}</small>}
            </div>
            <div className={p.device ? 'ondevice' : undefined}>
              <Written as="small" text={p.afterLabel} />
              <button className="zoom" onClick={() => setZoom(starts[k]! + 1)} aria-label={`Open ${p.afterLabel} full size`}>
                <img src={assetUrl(`/api/v1/proof/${p.after}`)} alt={`${p.criterion}, ${p.afterLabel}`} />
              </button>
              {p.device && <small className="shotdevice">{p.device}</small>}
            </div>
          </div>}
          {p.more?.length && p.why && p.note ? <Written as="p" className="note proofmore-main" text={p.note} /> : null}
          <MorePictures shot={p} first={starts[k]! + 2} onOpen={setZoom} />
        </div>
      ))}
      <OffScreenList t={t} />
    </>
  );
}

export function ProofDecision({ t, sticky }: { t: Ticket; sticky?: boolean }) {
  const act = useAct<Ticket>();
  const [note, setNote, clearNote] = useDraft(t.id, 'proof-wrong', '');
  const [wrong, setWrong] = useState(Boolean(note));
  const sendBack = () => {
    if (act.isPending) return;
    act.mutate({ path: `/api/v1/tickets/${t.id}/change`, body: { text: note }, done: 'Sent back to the Builder with your note.' }, { onSuccess: clearNote });
  };
  return wrong ? (
    <div className={sticky ? 'stickybar' : 'df'}>
      <input className="input" style={{ flex: 1 }} autoFocus dir={typedDir(note)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What's wrong? Tell the squad in one line." onKeyDown={(e) => e.key === 'Enter' && note.trim() && sendBack()} />
      <button className="btn pri" disabled={!note.trim() || act.isPending} onClick={sendBack}>Send back</button>
      <button className="btn" onClick={() => setWrong(false)}>Cancel</button>
    </div>
  ) : (
    <div className={sticky ? 'stickybar' : 'df'}>
      <button
        className="btn pri"
        disabled={act.isPending}
        onClick={() =>
          act.mutate({
            path: `/api/v1/tickets/${t.id}/approve`,
            // Accepted, or newer work clashed and the Builder brings it in first. A card says anything else itself.
            done: (x) => (x.stage === 'release' ? `${t.id} is ready to release.` : x.live ? 'Newer work changed the same code meanwhile, so the Builder brings it in first. Then the proof comes back to you.' : null),
          })
        }
      >
        {act.isPending ? <Loader2 size={15} className="spin" /> : <Check size={15} strokeWidth={2.5} />} {act.isPending ? 'Saving…' : 'Looks right'}
      </button>
      <button className="btn" onClick={() => setWrong(true)}>Something's wrong</button>
      <span className="grow" />
      <Cmd text={`squad approve ${t.id}`} />
    </div>
  );
}

export function ProofPanel({ t }: { t: Ticket }) {
  return (
    <>
      <div className="db">
        <div className="youbox">
          <span className="ring"><Check size={18} strokeWidth={2.5} /></span>
          <div>
            <b>Check that it works the way you want</b>
            <span>{proofLead(t.gates)}</span>
          </div>
          <span className="grow" />
          <Link to="/tickets/$id/proof" params={{ id: t.id }} className="btn sm">
            <ExternalLink size={14} /> Full page
          </Link>
        </div>
        <div className="lbl">Gates, checked by squad-kit</div>
        <GatePills t={t} />
        <AlsoChanged t={t} />
        <div className="lbl">Before and after</div>
        <ProofShots t={t} />
        <YourCheck t={t} />
      </div>
      <ProofDecision t={t} />
    </>
  );
}
