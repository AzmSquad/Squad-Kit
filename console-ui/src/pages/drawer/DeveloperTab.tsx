import { useMemo } from 'react';
import type { Ticket } from '../../api/types';
import { Cmd } from '../../components/ui';
import { OpenInEditor } from '../../components/Changes';
import { ExactError } from '../../components/ErrorCard';

export function DeveloperTab({ t }: { t: Ticket }) {
  const files = useMemo(() => {
    const found = new Set<string>();
    const lines = [...t.activity.map((a) => a.text), ...(t.steps ?? []).map((s) => s.live ?? '')];
    for (const l of lines) for (const m of l.matchAll(/[\w./-]+\/[\w.-]+\.\w+/g)) found.add(m[0]);
    return [...found];
  }, [t]);
  return (
    <div className="db">
      <ExactError t={t} />
      <div className="lbl">Branch</div>
      <p className="mono" style={{ fontSize: 13 }}>
        {t.repo ? `${t.repo}: ` : ''}
        {t.branch ?? `squad/${t.id.toLowerCase()}`}
      </p>
      {t.worktree && (
        <>
          <div className="lbl">The ticket's copy of the code</div>
          <p className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{t.storyDir ?? t.worktree}</p>
          <OpenInEditor t={t} />
        </>
      )}
      {t.gates?.ran?.length ? (
        <>
          <div className="lbl">The checks that ran</div>
          <div className="feed">
            {t.gates.ran.map((r) => (
              <div key={r.name} className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {r.name}: {r.command} ({r.failedOnce ? 'failed once, passed when run again' : r.ok ? 'passed' : 'failed'})
              </div>
            ))}
          </div>
        </>
      ) : null}
      {t.testChange || t.testDecided ? (
        <>
          <div className="lbl">How the tests run</div>
          <div className="feed">
            {t.testDecided && (
              <div className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {t.testDecided.kept === 'new' ? `Kept the new one: ${t.testDecided.to} (was ${t.testDecided.from})` : `Kept the current one: ${t.testDecided.from} (not ${t.testDecided.to})`}, by {t.testDecided.by === 'you' ? 'you' : 'squad-kit'}
                {t.testDecided.ran ? `. ${t.testDecided.ran}` : ''}
              </div>
            )}
            {t.testChange && (
              <div className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
                {t.testChange.ask ? 'Waiting for a choice' : 'Tried at the next checks'}: {t.testChange.from} or {t.testChange.to}
                {t.testChange.ran ? `. ${t.testChange.ran}` : ''}
              </div>
            )}
          </div>
        </>
      ) : null}
      {t.localSetup && (
        <>
          <div className="lbl">Setting up your own copy</div>
          <p className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
            {t.localSetup.command} in {t.localSetup.dir} ({t.localSetup.status})
          </p>
        </>
      )}
      <div className="lbl">Files the squad touched</div>
      {files.length ? (
        <div className="feed">
          {files.map((f) => (
            <div key={f} className="mono" style={{ fontSize: 12.5 }}>{f}</div>
          ))}
        </div>
      ) : (
        <p className="note">No files changed yet.</p>
      )}
      <div className="lbl">In the terminal</div>
      <div className="pills">
        <Cmd text={`squad show ${t.id}`} />
        <Cmd text={`squad watch ${t.id}`} />
      </div>
    </div>
  );
}
