import { useState } from 'react';
import { Check } from 'lucide-react';
import { assetUrl } from '../../api/client';
import type { ProofShot, Ticket } from '../../api/types';
import { rowKind, shortProof } from '../../lib/proof-kinds';
import { pageOf } from '../../lib/review';
import { proofViewer, verdictClass, verdictNote } from '../../lib/verdict';
import { langProps } from '../../lib/lang';
import { ApiProof } from '../ApiProof';
import { Lightbox } from '../Lightbox';
import { MorePictures, OffScreenList, VerdictIcon, VerdictTag } from '../Verdict';
import { Written } from '../ui';
import { DataRows, useRowsCaption } from './DataRows';
import { KindChip } from './KindChip';

/**
 * The proof of a spec with kinds: one block per "done when", with its kind, laid out two by two. Pictures before and
 * after for Screen, the call and its answer for an API call, the rows before and after for Data, the test's steps and
 * its run before and after the change for Test, and what the Reviewer checked for Not on a screen.
 */
export function KindBlocks({ t }: { t: Ticket }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const rows = t.proof ?? [];
  const { pictures, starts } = proofViewer(rows, (file) => assetUrl(`/api/v1/proof/${file}`));
  return (
    <>
      {zoom !== null && <Lightbox pictures={pictures} start={zoom} onClose={() => setZoom(null)} />}
      <div className="kindgrid">
        {rows.map((p, k) => (
          <Block key={p.criterion} p={p} i={k} first={starts[k] ?? 0} onOpen={setZoom} />
        ))}
      </div>
      <OffScreenList t={t} />
    </>
  );
}

function Block({ p, i, first, onOpen }: { p: ProofShot; i: number; first: number; onOpen(at: number): void }) {
  const kind = rowKind(p);
  const note = p.shows && p.shows !== 'met' ? verdictNote(p) : '';
  return (
    <section className={`pf ${verdictClass(p.shows)}`} style={{ ['--i' as string]: i }} {...langProps(p.criterion)}>
      <div className="ph">
        <VerdictIcon shows={p.shows} />
        <Written as="b" text={p.criterion} />
        <KindChip kind={kind} />
        <VerdictTag shows={p.shows} />
      </div>
      {note && <Written as="p" className="verdictnote" text={note} />}
      {kind === 'screen' && <Pictures p={p} first={first} onOpen={onOpen} />}
      {kind === 'api' && <ApiProof file={p.after} {...(p.note ? { note: p.note } : {})} />}
      {kind === 'data' && <Rows p={p} />}
      {kind === 'test' && <TestRun p={p} />}
      {kind === 'none' && <NoneCheck p={p} />}
    </section>
  );
}

function Pictures({ p, first, onOpen }: { p: ProofShot; first: number; onOpen(at: number): void }) {
  return (
    <>
      {pageOf(p) && (
        <p className="cap">
          Page <code>{pageOf(p)}</code>
        </p>
      )}
      <div className="proofmini">
        <div className={p.beforeDevice ? 'ondevice' : undefined}>
          <Written as="small" text={p.beforeLabel} />
          <button className="zoom" onClick={() => onOpen(first)} aria-label={`Open ${p.beforeLabel} full size`}>
            <img src={assetUrl(`/api/v1/proof/${p.before}`)} alt={`${p.criterion}, ${p.beforeLabel}`} />
          </button>
        </div>
        <div className={p.device ? 'ondevice' : undefined}>
          <Written as="small" text={p.afterLabel} />
          <button className="zoom" onClick={() => onOpen(first + 1)} aria-label={`Open ${p.afterLabel} full size`}>
            <img src={assetUrl(`/api/v1/proof/${p.after}`)} alt={`${p.criterion}, ${p.afterLabel}`} />
          </button>
        </div>
      </div>
      {p.note && <Written as="p" className="cap" text={p.note} />}
      <MorePictures shot={p} first={first + 2} onOpen={onOpen} />
    </>
  );
}

function Rows({ p }: { p: ProofShot }) {
  const caption = useRowsCaption(p.after);
  return (
    <>
      <p className="cap">{caption}</p>
      <DataRows file={p.after} />
      {p.note && <Written as="p" className="cap" text={p.note} />}
    </>
  );
}

/** The test's steps in plain words, and its run before and after the change. */
function TestRun({ p }: { p: ProofShot }) {
  const run = p.test;
  if (!run) return p.note ? <Written as="p" className="cap" text={p.note} /> : null;
  const red = run.before === 'failed';
  return (
    <>
      <ul className="tsteps">
        {run.steps.map((s, k) => (
          <li key={k}>
            <Check aria-hidden="true" />
            <Written text={s} />
          </li>
        ))}
      </ul>
      <div className="redgreen">
        <span className={red ? 'r' : 'q'}>{red ? 'It failed before the change' : run.before === 'passed' ? 'It passed before the change too' : 'Not run on main’s code'}</span>
        <span>{run.after === 'passed' ? 'and passes now' : 'and fails now'}</span>
        {run.after === 'passed' && (
          <span className="g">
            <Check aria-hidden="true" />
          </span>
        )}
        {run.seconds !== undefined && <bdi dir="ltr">{run.seconds} s</bdi>}
      </div>
      <small className="tname" dir="ltr" title={run.file}>
        {run.name || run.file}
      </small>
    </>
  );
}

/** What the Reviewer checked, and the reason the person approved. */
function NoneCheck({ p }: { p: ProofShot }) {
  return (
    <>
      {p.note && <Written as="p" className="cap" lead={<b>Why no proof to show:</b>} text={p.note} />}
      {p.checked ? (
        <div className="checked">
          <Check aria-hidden="true" />
          <Written text={p.checked} />
        </div>
      ) : (
        <p className="cap">{shortProof(p, 'none')}</p>
      )}
    </>
  );
}
