import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { assetUrl } from '../api/client';
import { useTicket } from '../lib/data';
import { ProofDecision } from './TicketDrawer';
import { Lightbox, type Picture } from '../components/Lightbox';

export function ProofPage() {
  const { id } = useParams({ from: '/tickets/$id/proof' });
  const ticket = useTicket(id);
  const [pick, setPick] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const t = ticket.data;
  if (!t) return <div className="center">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>;
  const shots = t.proof ?? [];
  const shot = shots[Math.min(pick, shots.length - 1)];
  const waiting = t.waiting?.kind === 'proof';
  const g = t.gates;
  // Every picture of the proof in order, so the viewer can step through all of them.
  const pictures: Picture[] = shots.flatMap((s) => [
    { src: assetUrl(`/api/v1/proof/${s.before}`), caption: `${s.criterion} · ${s.beforeLabel}` },
    { src: assetUrl(`/api/v1/proof/${s.after}`), caption: `${s.criterion} · ${s.afterLabel}` },
  ]);
  const at = Math.min(pick, shots.length - 1) * 2;

  return (
    <>
      <div className="top">
        <span className="crumbs">
          <Link to="/inbox">Waiting for you</Link> /
          <Link to="/board" search={{ ticket: t.id }}>
            {t.id} {t.title}
          </Link>{' '}
          / <b>Proof</b>
        </span>
      </div>
      <div className="gatebar">
        {/* Each gate as it really is: green only when it passed; a gate you continued past says so. */}
        <Gate state={g?.checks} text={g?.checks === 'skipped' ? 'Checks failed, you continued' : (g?.checksText ?? 'All checks pass')} />
        <Gate state={g?.review} text={g?.review === 'skipped' ? 'Review notes open, you continued' : `Review approved${g?.reviewBy ? ` by ${g.reviewBy}` : ''}`} />
        <Gate state={g?.proof} text={g?.proof === 'skipped' ? 'No screenshots, you continued' : 'Proof made'} />
        <span style={{ marginLeft: 6 }}>Nothing ships without these three.</span>
      </div>
      <div className="split">
        <div className="critlist">
          <div className="lbl" style={{ marginTop: 0 }}>Done when · {shots.length}</div>
          {shots.map((s, i) => (
            <button key={s.criterion} className={`crit ${i === pick ? 'on' : ''}`} onClick={() => setPick(i)}>
              <Check size={15} strokeWidth={2.5} />
              <span>{s.criterion}</span>
            </button>
          ))}
          {shots.length === 0 && (
            <p className="note">
              {g?.proof === 'skipped' || (t.work?.screens ?? 0) > 0 ? 'No screenshots were taken for this ticket. See the activity for why.' : 'No screens change in this ticket, so the passing checks are the proof.'}
            </p>
          )}
        </div>
        <div className="stage">
          {shot ? (
            <>
              <h3>{shot.criterion}</h3>
              <div className="ba">
                <div>
                  <div className="cap">
                    <span>{shot.beforeLabel}</span>
                  </div>
                  <button className="zoom" onClick={() => setZoom(at)} aria-label={`Open ${shot.beforeLabel} full size`}>
                    <img src={assetUrl(`/api/v1/proof/${shot.before}`)} alt={`${shot.criterion}, ${shot.beforeLabel}`} />
                  </button>
                </div>
                <div>
                  <div className="cap">
                    <span>{shot.afterLabel}</span>
                  </div>
                  <button className="zoom" onClick={() => setZoom(at + 1)} aria-label={`Open ${shot.afterLabel} full size`}>
                    <img src={assetUrl(`/api/v1/proof/${shot.after}`)} alt={`${shot.criterion}, ${shot.afterLabel}`} />
                  </button>
                </div>
              </div>
              {shot.note && <p className="note">{shot.note}</p>}
            </>
          ) : (
            <p className="note">Nothing to compare.</p>
          )}
        </div>
      </div>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      {waiting ? (
        <ProofDecision t={t} sticky />
      ) : (
        <div className="stickybar">
          <span className="note">{t.status}</span>
        </div>
      )}
    </>
  );
}

function Gate({ state, text }: { state?: string; text: string }) {
  return (
    <span className={`pill ${state === 'pass' ? 'ok' : state === 'skipped' ? 'skip' : 'wait'}`}>
      {state === 'pass' && <Check size={13} strokeWidth={2.5} />}
      {text}
    </span>
  );
}
