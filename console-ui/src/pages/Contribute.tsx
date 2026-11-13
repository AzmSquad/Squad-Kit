import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import type { Checklist, ChecklistItem } from '../api/contribution-types';
import { ASSIST, IDEA, itemWords } from '../lib/contribute-words';
import { readLang, type Lang } from '../lib/first-story';
import { useAct } from '../lib/data';
import { Cmd, CouldNotLoad } from '../components/ui';
import { SignInCode } from '../components/connect/SignInCode';
import { useConnections } from './Connections';
import '../styles/contribute.css';

/**
 * The contribution assistant, for squad-kit's own code: what is ready and what squad-kit can do for the person, each
 * with its button and its terminal command (`squad contribute`): sign in, make their own copy, bring it up to date, the
 * rules, and a big idea told to the maintainers first (a filled-in page they send themselves).
 */

export function useChecklist() {
  return useQuery({ queryKey: ['contribute'], queryFn: () => api<Checklist>('/api/v1/contribute'), refetchInterval: 60_000 });
}

type Done = { line: string; checklist: Checklist };

function Dot({ i }: { i: ChecklistItem | 'self' }) {
  if (i !== 'self' && i.id === 'idea') return <span className="as-dot tip" aria-hidden="true">?</span>;
  if (i === 'self' || i.state === 'done' || i.state === 'info')
    return (
      <span className="as-dot ok" aria-hidden="true">
        <Check size={13} strokeWidth={2.8} />
      </span>
    );
  return <span className="as-dot todo" aria-hidden="true" />;
}

/** Tell the maintainers first: the main repo's new issue page, filled in with the idea. The person sends it there. */
function IdeaDialog({ lang, command, onClose }: { lang: Lang; command: string; onClose(): void }) {
  const w = IDEA[lang];
  const act = useAct<{ link: string }>();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gh-code" role="dialog" aria-modal="true" aria-label={w.head} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <h2>{w.head}</h2>
        <p className="gh-muted">{w.sub}</p>
        <div className="as-idea">
          <label>
            {w.title}
            <input
              className="input"
              value={title}
              autoFocus
              onChange={(e) => {
                setTitle(e.target.value);
                setLink('');
              }}
            />
          </label>
          <label>
            {w.text}
            <textarea
              className="input"
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setLink('');
              }}
            />
          </label>
        </div>
        {link && <p className="gh-muted">{w.filled}</p>}
        <div className="gh-row">
          {link ? (
            <a className="btn pri sm" href={link} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> {w.open}
            </a>
          ) : (
            <button className="btn pri sm" disabled={!title.trim() || act.isPending} onClick={() => act.mutate({ path: '/api/v1/contribute/idea', body: { title, text }, after: (r) => setLink(r.link) })}>
              {w.fill}
            </button>
          )}
          <button className="btn sm" onClick={onClose}>{lang === 'ar' ? 'إغلاق' : 'Close'}</button>
          <Cmd text={command} />
        </div>
      </div>
    </div>
  );
}

export function ContributePage() {
  const lang = readLang();
  const w = ASSIST[lang];
  const q = useChecklist();
  const act = useAct<Done>();
  const connections = useConnections(60_000).data?.rows;
  const [rules, setRules] = useState(false);
  const [idea, setIdea] = useState(false);
  const [signing, setSigning] = useState(false);
  const c = q.data;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const run = (path: string) => act.mutate({ path, done: (r) => r.line });
  // The tool's own sign-in, when it is on this computer; else the Connections page with its steps.
  const host = connections?.find((r) => r.label === c?.host && r.actions.some((a) => a.id === 'sign-in'));
  const signedIn = c?.items.find((i) => i.id === 'sign-in')?.state === 'done';
  const copyTodo = c?.items.find((i) => i.id === 'copy')?.state === 'todo';
  // Whether the first idea can be written, and how much is left, are the engine's (`ready`, `left`).
  const left = c?.left ?? 0;
  const ready = Boolean(c?.ready);
  const both = signedIn && copyTodo && left >= 2;
  // A copy with changes of its own stops nothing: said in one line under the list.
  const ahead = c?.items.find((i) => i.id === 'up-to-date' && i.state === 'blocked' && i.count);

  const button = (i: ChecklistItem, label?: string) => {
    if (!label) return null;
    const pri = i.state === 'todo';
    if (i.id === 'sign-in')
      return host ? (
        <button className="btn pri sm" onClick={() => setSigning(true)}>{label}</button>
      ) : (
        <Link to="/connections" className="btn pri sm">{label}</Link>
      );
    if (i.id === 'rules') return <button className="btn sm" onClick={() => setRules((x) => !x)}>{rules ? w.hide : label}</button>;
    if (i.id === 'idea') return <button className="btn sm" onClick={() => setIdea(true)}>{label}</button>;
    if (!i.action || i.state !== 'todo') return null;
    const path = i.action.route.replace(/^POST /, '');
    return (
      <>
        <button className={`btn sm ${pri ? 'pri' : ''}`} disabled={act.isPending} onClick={() => run(path)}>
          {act.isPending && act.variables?.path === path ? <Loader2 size={13} className="spin" /> : null}
          {label}
        </button>
        <Cmd text={i.action.command} />
      </>
    );
  };

  return (
    <>
      <div className="top as-top" dir={dir} lang={lang}>
        <div>
          <h1>{w.head}</h1>
          <p>{w.sub}</p>
        </div>
      </div>
      <div className="scroll">
        {!c ? (
          q.isError ? (
            <CouldNotLoad what="the contribution checklist" error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <div className="center">
              <span className="gh-wait">
                <Loader2 size={16} className="spin" /> {w.looking}
              </span>
            </div>
          )
        ) : !c.self ? (
          <div className="page as-page" dir={dir} lang={lang}>
            <p className="gh-muted">{w.notSelf}</p>
          </div>
        ) : (
          <div className="page as-page" dir={dir} lang={lang}>
            <ol className="as-checks">
              <li>
                <Dot i="self" />
                <div>
                  <b>{w.selfTitle}</b>
                  <p>{w.selfLine}</p>
                </div>
              </li>
              {c.items.map((i) => {
                const words = itemWords(i, c, lang);
                return (
                  <li key={i.id} className={i.state === 'todo' || i.state === 'blocked' ? 'todo' : ''}>
                    <Dot i={i} />
                    <div>
                      <b>{words.title}</b>
                      <p>{words.line}</p>
                      {i.id === 'rules' && rules && (
                        <ul className="as-rules" dir="ltr" lang="en">
                          {i.points?.map((p) => <li key={p}>{p}</li>)}
                          {i.file && (
                            <li>
                              {w.readFile} <code className="mono">{i.file}</code>
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                    <span className="as-act">{button(i, words.button)}</span>
                  </li>
                );
              })}
            </ol>
            <div className="as-foot">
              <span className="as-left">{!signedIn ? w.signFirst : ready ? (ahead && c ? itemWords(ahead, c, lang).line : w.ready) : w.left(left)}</span>
              {both && (
                <button className="btn pri" disabled={act.isPending} onClick={() => run('/api/v1/contribute/setup')}>
                  {act.isPending && act.variables?.path === '/api/v1/contribute/setup' ? <Loader2 size={14} className="spin" /> : null}
                  {w.both}
                </button>
              )}
              {ready ? (
                <Link to="/board" search={{ write: 1 }} className="btn pri">
                  {w.go}
                </Link>
              ) : (
                <button className="btn" disabled>
                  {w.go}
                </button>
              )}
              {both && <Cmd text="squad contribute --fork --sync" />}
            </div>
          </div>
        )}
      </div>
      {idea && <IdeaDialog lang={lang} command={c?.items.find((i) => i.id === 'idea')?.action?.command ?? 'squad contribute --idea <title>'} onClose={() => setIdea(false)} />}
      {signing && host && <SignInCode name={host.name} label={host.label} onClose={() => setSigning(false)} />}
    </>
  );
}
