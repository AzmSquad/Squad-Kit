import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Link, useParams } from '@tanstack/react-router';
import { assetUrl } from '../api/client';
import { useTicket } from '../lib/data';
import { ProofDecision } from './TicketDrawer';
import { Lightbox } from '../components/Lightbox';
import { GatePill as Gate, NoNewTestsLabel, NotCheckedNote, OldFailuresNote } from '../components/Gates';
import { checksWords, noShotsText, proofWords } from '../lib/gates';
import { AlsoChanged, MorePictures, OffScreenList, PicturesNote, VerdictIcon, VerdictTag } from '../components/Verdict';
import { isApiProof, proofViewer, verdictClass, verdictNote } from '../lib/verdict';
import { pageOf, pagesOf, waitsAtReview } from '../lib/review';
import { YourCheck } from '../components/YourCheck';
import { AskButton } from '../components/AskQuestion';
import { ApiProof } from '../components/ApiProof';
import { Written } from '../components/ui';
import { langProps } from '../lib/lang';
import { KindBlocks } from '../components/proof/KindBlocks';
import { hasKinds } from '../lib/proof-kinds';

export function ProofPage() {
  const { id } = useParams({ from: '/tickets/$id/proof' });
  const ticket = useTicket(id);
  const [pick, setPick] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const t = ticket.data;
  if (!t) return <div className="center">{ticket.isError ? `No ticket ${id}.` : 'Loading…'}</div>;
  const shots = t.proof ?? [];
  const shot = shots[Math.min(pick, shots.length - 1)];
  // Looks right was pressed: it is being saved and merged now, so the buttons give way to what happens.
  const waiting = t.waiting?.kind === 'proof' && !t.now?.merging;
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
            <Written lead={t.id} text={t.title} />
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
        <NoNewTestsLabel t={t} />
        <span style={{ marginLeft: 6 }}>Nothing ships without these three.</span>
      </div>
      <NotCheckedNote g={g} className="gatebar-why" />
      <OldFailuresNote g={g} className="gatebar-why" />
      <AlsoChanged t={t} className="gatebar-why" />
      {hasKinds(t) ? (
        <div className="kindpage">
          <KindBlocks t={t} />
          {waitsAtReview(t) && <YourCheck t={t} />}
        </div>
      ) : (
      <div className="split proofsplit">
        <div className="critlist">
          <div className="lbl" style={{ marginTop: 0 }}>Done when · {shots.length}</div>
          {shots.map((s, i) => (
            <button key={s.criterion} className={`crit ${i === pick ? 'on' : ''}`} {...langProps(s.criterion)} onClick={() => setPick(i)}>
              <VerdictIcon shows={s.shows} />
              <span>
                <Written text={s.criterion} />
                <VerdictTag shows={s.shows} />
                {pagesOf(s).length > 0 && <small className="critpage-s" dir="ltr">{pagesOf(s).join(' · ')}</small>}
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
              <Written as="h3" text={shot.criterion} />
              {shot.shows && (
                <p className={`verdictline ${verdictClass(shot.shows)}`}>
                  <VerdictTag shows={shot.shows} />
                  {shot.shows !== 'met' && verdictNote(shot) && <Written text={verdictNote(shot)!} />}
                </p>
              )}
              {pageOf(shot) && (
                <p className="critpage">
                  Page <code>{pageOf(shot)}</code>
                </p>
              )}
              <PicturesNote t={t} />
              {isApiProof(shot.after) ? <ApiProof file={shot.after} {...(shot.note ? { note: shot.note } : {})} /> : <div className="ba">
                <div className={shot.beforeDevice ? 'ondevice' : undefined}>
                  <div className="cap">
                    <Written text={shot.beforeLabel} />
                  </div>
                  <button className="zoom" onClick={() => setZoom(at)} aria-label={`Open ${shot.beforeLabel} full size`}>
                    <img src={assetUrl(`/api/v1/proof/${shot.before}`)} alt={`${shot.criterion}, ${shot.beforeLabel}`} />
                  </button>
                  {shot.beforeDevice && <small className="shotdevice">{shot.beforeDevice}</small>}
                </div>
                <div className={shot.device ? 'ondevice' : undefined}>
                  <div className="cap">
                    <Written text={shot.afterLabel} />
                  </div>
                  <button className="zoom" onClick={() => setZoom(at + 1)} aria-label={`Open ${shot.afterLabel} full size`}>
                    <img src={assetUrl(`/api/v1/proof/${shot.after}`)} alt={`${shot.criterion}, ${shot.afterLabel}`} />
                  </button>
                  {shot.device && <small className="shotdevice">{shot.device}</small>}
                </div>
              </div>}
              {shot.note && !isApiProof(shot.after) && <Written as="p" className="note" text={shot.note} />}
              <MorePictures shot={shot} first={at + 2} onOpen={setZoom} />
            </>
          ) : (
            <p className="note">Nothing to compare.</p>
          )}
        </div>
      </div>
      )}
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      {waiting ? (
        <ProofDecision t={t} sticky />
      ) : (
        <div className="stickybar" role={t.now?.merging ? 'status' : undefined}>
          {t.now?.merging && <Loader2 size={15} className="spin" />}
          <Written className="note" text={t.now?.merging ? t.now.line : t.status} />
        </div>
      )}
    </>
  );
}
