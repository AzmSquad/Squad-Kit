import { useState } from 'react';
import { send } from '../api/client';
import type { AppProject } from '../api/types';
import { useDraft } from '../lib/drafts';
import { typedDir } from '../lib/lang';
import { shellQuote } from '../lib/text';
import { BrdDrop, readBrd, stem } from './BreakdownDialogs';
import type { PickedFile } from './dialogs';
import { FolderBrowser, useFolders } from './FolderBrowser';
import { Cmd, Modal } from './ui';

/**
 * New project: for a person with only a BRD or an idea. squad-kit makes the folder, git and the board, and what they gave
 * goes straight to the Analyst or the Architect. No terminal, and no technical question. Terminal: `squad projects --new`.
 */

/** "Documents / Visitor log": where it goes, without the part of the path nobody needs. */
function whereWords(folder: string, home: string | undefined, name: string): string {
  const rel = home && folder.startsWith(home) ? folder.slice(home.length) : folder;
  return [...rel.split(/[/\\]/).filter(Boolean), name || 'Your project'].join(' / ');
}

export function NewProject({ onClose }: { onClose(): void }) {
  const [mode, setMode, clearMode] = useDraft<'brd' | 'idea'>('new-project', 'mode', 'brd');
  const [name, setName, clearName] = useDraft('new-project', 'name', '');
  const [idea, setIdea, clearIdea] = useDraft('new-project', 'idea', '');
  const [paste, setPaste, clearPaste] = useDraft('new-project', 'paste', false);
  const [text, setText, clearText] = useDraft('new-project', 'text', '');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [named, setNamed] = useState(Boolean(name.trim()));
  const [where, setWhere] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folders = useFolders();
  const l = folders.listing.data;
  const place = where ?? l?.place ?? '';

  const pick = async (list: FileList | File[] | null) => {
    const f = list ? [...list][0] : undefined;
    if (!f) return;
    setError(null);
    try {
      const read = await readBrd(f);
      setFile(read);
      if (!named) setName(stem(f.name));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const given = mode === 'idea' ? idea.trim() : paste ? text.trim() : file;
  const can = Boolean(name.trim() && given && place && !busy);
  const quoted = shellQuote(name.trim() || 'Your project');
  const command =
    mode === 'idea'
      ? `squad projects --new ${quoted} --idea ${shellQuote(idea.trim() && idea.trim().length <= 60 ? idea.trim() : '<what you want to build>')}`
      : `squad projects --new ${quoted} --brd ${shellQuote(file?.name ?? '<file>')}`;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), where: place, ...(mode === 'idea' ? { idea } : paste ? { text } : { file: { name: file!.name, data: file!.data } }) };
      const res = await send<AppProject & { opens: string }>('/api/v1/app/projects/new', 'POST', body);
      for (const clear of [clearMode, clearName, clearIdea, clearPaste, clearText]) clear();
      window.location.assign(res.url.replace(/\/board$/, res.opens));
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal
      title="New project"
      wide
      onClose={onClose}
      losing={mode === 'brd' && file ? `the file ${file.name}` : null}
      footer={
        <>
          <button className="btn pri" disabled={!can} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create my project'}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <span className="grow" />
          <Cmd text={command} />
        </>
      }
    >
      <p>Tell your squad what you want. It sets everything else up.</p>
      <div className="np">
        <div className="seg" role="group" aria-label="What you have">
          <button className={mode === 'brd' ? 'on' : ''} aria-pressed={mode === 'brd'} onClick={() => setMode('brd')}>
            I have a BRD
          </button>
          <button className={mode === 'idea' ? 'on' : ''} aria-pressed={mode === 'idea'} onClick={() => setMode('idea')}>
            I have an idea
          </button>
        </div>
        {mode === 'idea' ? (
          <div className="field">
            <label htmlFor="np-idea">What do you want to build?</label>
            <textarea id="np-idea" className="textarea" dir={typedDir(idea)} autoFocus rows={4} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="In your own words, in Arabic or English. Who will use it, and what will they do?" />
          </div>
        ) : paste ? (
          <div className="field">
            <label htmlFor="np-paste">The BRD's text</label>
            <textarea id="np-paste" className="textarea rq-pastebox" dir={typedDir(text)} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the whole document here. Headings help the Analyst find its parts." />
            <div className="rq-hint">
              Have the file?{' '}
              <button className="rq-link" onClick={() => setPaste(false)}>
                Choose a file instead
              </button>
            </div>
          </div>
        ) : (
          <>
            <BrdDrop file={file} onPick={(f) => void pick(f)} onClear={() => setFile(null)} hint="Word or PDF, in Arabic or English. The Analyst reads it and asks only about real gaps." />
            <div className="rq-hint">
              No file?{' '}
              <button className="rq-link" onClick={() => setPaste(true)}>
                Paste the text instead
              </button>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="np-name">Project name</label>
          <input
            id="np-name"
            className="input"
            dir={typedDir(name)}
            value={name}
            placeholder="Visitor log"
            onChange={(e) => {
              setName(e.target.value);
              setNamed(true);
              setError(null);
            }}
          />
        </div>
        <div className="field">
          <label>Where it goes</label>
          {changing ? (
            <>
              <FolderBrowser at={folders.at} go={(p) => { setError(null); folders.setAt(p); }} listing={folders.listing} onError={setError} />
              {l?.notHere && <p className="fb-error">{l.notHere}</p>}
              <div className="np-pick">
                <button
                  className="btn sm pri"
                  disabled={!l || Boolean(l.notHere)}
                  onClick={() => {
                    setWhere(l!.path);
                    setChanging(false);
                  }}
                >
                  Put it here
                </button>
                <button className="btn sm" onClick={() => setChanging(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="np-where">
              <span className="grow" dir="auto">{place ? whereWords(place, l?.home, name.trim()) : '…'}</span>
              <button
                className="btn sm"
                disabled={!place}
                onClick={() => {
                  folders.setAt(place);
                  setChanging(true);
                }}
              >
                Change
              </button>
            </div>
          )}
        </div>
        <p className="note">squad-kit makes the folder for you. Nothing leaves your computer except what your AI tool reads.</p>
        {error && <p className="fb-error">{error}</p>}
      </div>
    </Modal>
  );
}
