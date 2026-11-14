import { useState } from 'react';
import { PROJECT } from '../api/client';
import { STUDIO_TABS, readStudioTab, saveStudioTab, type StudioTab } from '../lib/studio';

/* ── Studio: the project's sketches and design systems ──
   The tab the person last used stays in this browser tab, one per project (lib/studio). The page makes no call to the
   board server, so opening it or switching tabs creates nothing on disk: files appear only when something is made. */

export function StudioPage({ project = PROJECT ?? '' }: { project?: string }) {
  const [tab, setTab] = useState<StudioTab>(() => readStudioTab(project));
  const pick = (t: StudioTab) => {
    setTab(t);
    saveStudioTab(project, t);
  };

  return (
    <>
      <div className="top">
        <h1>Studio</h1>
        <span className="note">Your sketches and design systems for this project.</span>
      </div>
      <div className="ptabs" role="tablist">
        {STUDIO_TABS.map((t) => (
          <button key={t.id} id={`studio-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="studio-panel" className={tab === t.id ? 'on' : ''} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="scroll">
        <div className="page" id="studio-panel" role="tabpanel" aria-labelledby={`studio-tab-${tab}`}>
          <p className="note">Nothing here yet.</p>
        </div>
      </div>
    </>
  );
}
