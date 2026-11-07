import { useEffect, useState } from 'react';
import { Check, Copy, LifeBuoy, Loader2 } from 'lucide-react';
import { PROJECT, api, send } from '../api/client';
import type { ReportPlan } from '../api/types';
import { usePrefs } from '../lib/prefs';
import { report, useReportAsk, type ReportAsk } from '../lib/report';
import { Cmd, Modal } from './ui';
import { typedDir } from '../lib/lang';

/**
 * Report a problem (phase 10): squad-kit saves one file the person sends to whoever helps them. The dialog lists what
 * the file holds and what it never holds, takes an optional note, and after saving says where the file is.
 * Terminal: `squad report [ticket]`.
 */

/** The button every error card, the ticket drawer and Settings show. */
export function ReportButton({ ticket, app, small, label = 'Report a problem' }: ReportAsk & { small?: boolean; label?: string }) {
  return (
    <button className={`btn ${small ? 'sm' : ''}`} onClick={() => report.open({ ...(ticket ? { ticket } : {}), ...(app ? { app } : {}) })}>
      <LifeBuoy size={small ? 13 : 14} /> {label}
    </button>
  );
}

/** Mounted once, beside the pages: the dialog opens wherever Report a problem was pressed. */
export function ReportHost() {
  const ask = useReportAsk();
  if (!ask) return null;
  return <ReportDialog key={`${ask.ticket ?? ''}${ask.app ? 'app' : ''}`} ask={ask} onClose={report.close} />;
}

/** " in your Downloads folder" reads better than the path, which shows under it anyway. */
function folderWords(folder: string): string {
  return /[\\/]Downloads$/.test(folder) ? ' in your Downloads folder' : '';
}

function ReportDialog({ ask, onClose }: { ask: ReportAsk; onClose(): void }) {
  const { toast } = usePrefs();
  const [plan, setPlan] = useState<ReportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ReportPlan | null>(null);
  const project = ask.app ? null : PROJECT;
  const query = new URLSearchParams({ ...(project ? { project } : {}), ...(project && ask.ticket ? { ticket: ask.ticket } : {}) }).toString();

  useEffect(() => {
    let live = true;
    api<ReportPlan>(`/api/v1/app/report${query ? `?${query}` : ''}`)
      .then((p) => live && setPlan(p))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [query]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setSaved(await send<ReportPlan>('/api/v1/app/report', 'POST', { ...(project ? { project } : {}), ...(project && ask.ticket ? { ticket: ask.ticket } : {}), ...(note.trim() ? { note } : {}) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const copy = (text: string) => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) return toast('Could not copy. Select the text instead.', 'err');
    void done.then(
      () => toast('Copied where the file is'),
      () => toast('Could not copy. Select the text instead.', 'err'),
    );
  };

  if (saved?.file) {
    return (
      <Modal
        title="Report saved"
        onClose={onClose}
        footer={
          <>
            <button className="btn pri" onClick={onClose}>
              <Check size={15} strokeWidth={2.5} /> Done
            </button>
            <button className="btn" onClick={() => copy(saved.file!)}>
              <Copy size={14} /> Copy where it is
            </button>
          </>
        }
      >
        <div className="report-saved" role="status">
          <span className="report-ok">
            <Check size={16} strokeWidth={2.6} />
          </span>
          <div>
            <b>
              Saved {saved.name}
              {folderWords(saved.folder)}
            </b>
            <span className="mono">{saved.file}</span>
          </div>
        </div>
        <p className="report-send">Send this file to whoever helps you with squad-kit.</p>
        <p className="note">It holds no tokens or passwords. You can open it first to see what is inside: README.txt lists every file.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Report a problem"
      onClose={onClose}
      footer={
        <>
          <button className="btn pri" disabled={!plan || saving} onClick={() => void save()}>
            {saving ? <Loader2 size={15} className="spin" /> : <LifeBuoy size={15} />} {plan ? `Save ${plan.name}` : 'Save the report'}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          {plan && <Cmd text={plan.command} />}
        </>
      }
    >
      <p>squad-kit saves one file you can send to your engineer or to squad-kit support.</p>
      {plan ? (
        <>
          <div className="lbl">The file holds</div>
          <ul className="safe-list">
            {plan.holds.map((h) => (
              <li key={h}>
                <Check size={15} strokeWidth={2.6} aria-hidden="true" />
                {h}
              </li>
            ))}
          </ul>
          <div className="report-never">
            <b>Never included:</b> {plan.never.replace(/^Never included:\s*/, '')}
          </div>
        </>
      ) : (
        !error && <p className="note">Looking at what the file will hold…</p>
      )}
      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="report-what">What happened? (optional)</label>
        <textarea id="report-what" className="waynote" rows={3} dir={typedDir(note)} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: it stopped after I approved the design" />
      </div>
      {error && (
        <p className="report-err" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Settings: Report a problem about squad-kit as a whole, and where its own log is. */
export function HelpRow() {
  return (
    <div className="maprow" style={{ alignItems: 'center' }}>
      <b>Something wrong?</b>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <ReportButton app small />
        <span className="note">One file to send: squad-kit&apos;s log for the last 24 hours and the versions. Never your tokens or passwords.</span>
        <Cmd text="squad report" />
        <Cmd text="squad logs" />
      </span>
    </div>
  );
}
