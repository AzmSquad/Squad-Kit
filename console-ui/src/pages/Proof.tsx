import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { assetUrl } from '../api/client';
import { useTicket } from '../lib/data';
import { ProofDecision } from './TicketDrawer';
import { Lightbox } from '../components/Lightbox';
import { GatePill as Gate, NotCheckedNote } from '../components/Gates';
import { checksWords, noShotsText, proofWords } from '../lib/gates';
import { AlsoChanged, MorePictures, OffScreenList, VerdictIcon, VerdictTag } from '../components/Verdict';
import { proofViewer, verdictClass, verdictNote } from '../lib/verdict';
import { pageOf, pagesOf, waitsAtReview } from '../lib/review';
import { YourCheck } from '../components/YourCheck';
import { AskButton } from '../components/AskQuestion';

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
  const { pictures, starts } = proofViewer(shots, (file) => assetUrl(`/api/v1/proof/${file}`));
  const at = starts[Math.min(pick, shots.length - 1)] ?? 0;

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
        <span className="grow" />
        <AskButton t={t} />
      </div>
      <div className={`gatebar ${g?.checks === 'unchecked' ? 'unchecked' : ''}`}>
        {/* Each gate as it really is: green only when it passed; a gate you continued past says so. */}
        <Gate state={g?.checks} text={checksWords(g)} />
        <Gate state={g?.review} text={g?.review === 'skipped' ? 'Review notes open, you continued' : `Review approved${g?.reviewBy ? ` by ${g.reviewBy}` : ''}`} />
        <Gate state={g?.proof} text={proofWords(t)} />
        <span style={{ marginLeft: 6 }}>Nothing ships without these three.</span>
      </div>
      <NotCheckedNote g={g} className="gatebar-why" />
      <AlsoChanged t={t} className="gatebar-why" />
      <div className="split proofsplit">
        <div className="critlist">
          <div className="lbl" style={{ marginTop: 0 }}>Done when · {shots.length}</div>
          {shots.map((s, i) => (
            <button key={s.criterion} className={`crit ${i === pick ? 'on' : ''}`} onClick={() => setPick(i)}>
              <VerdictIcon shows={s.shows} />
              <span>
                {s.criterion}
                <VerdictTag shows={s.shows} />
                {pagesOf(s).length > 0 && <small className="critpage-s">{pagesOf(s).join(' · ')}</small>}
              </span>
            </button>
          ))}
          {shots.length === 0 && (
            <p className="note">{noShotsText(t)}</p>
          )}
          <OffScreenList t={t} />
          {waitsAtReview(t) && <YourCheck t={t} />}
        </div>
        <div className="stage">
          {shot ? (
            <>
              <h3>{shot.criterion}</h3>
              {shot.shows && (
                <p className={`verdictline ${verdictClass(shot.shows)}`}>
                  <VerdictTag shows={shot.shows} />
                  {shot.shows !== 'met' && verdictNote(shot) && <span>{verdictNote(shot)}</span>}
                </p>
              )}
              {pageOf(shot) && (
                <p className="critpage">
                  Page <code>{pageOf(shot)}</code>
                </p>
              )}
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
              <MorePictures shot={shot} first={at + 2} onOpen={setZoom} />
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
