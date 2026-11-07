import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Check, CircleCheck, X } from 'lucide-react';
import type { Ticket } from '../api/types';
import { useAct, useApps, useBoard } from '../lib/data';
import { firstWinOf, guideHint, guideStep, keep, kept, readLang, storyToGuide, winStats, type GuideHint, type Lang } from '../lib/first-story';
import { Written } from './ui';

/**
 * The first story, guided: a small checklist on the board until a story is in, with one hint for the moment. Then the
 * first win, once, with the numbers of what really happened.
 */

const GUIDE: Record<Lang, { title: string; hide: string; open: string; items: string[]; hints: Record<GuideHint, { head: string; body: string }> }> = {
  en: {
    title: 'Your first story',
    hide: 'Hide this',
    open: 'Open it',
    items: ['Answer the Analyst', 'Approve what gets built', 'Your squad builds it', 'Check the proof and say Looks right'],
    hints: {
      questions: { head: 'Your turn: answer the questions', body: 'The Analyst asks only what your story leaves open. Your answers shape the story.' },
      spec: { head: 'Your turn: approve the spec', body: 'This is what the squad will build, in plain words. Nothing is built until you approve it.' },
      plan: { head: 'Your turn: approve the plan', body: 'This is how the squad will build it. Nothing is built until you approve it.' },
      proof: { head: 'Your turn: check the proof', body: 'Each "done when" shows pictures of the real app. Look at them, or press Try it yourself to use it. Nothing is merged until you say so.' },
      other: { head: 'Your turn', body: 'The squad needs a word from you. Open the story to see what.' },
      working: { head: 'Your squad is working', body: 'You can close this and come back. You get a card when the squad needs you, and you can ask a question at any time.' },
    },
  },
  ar: {
    title: 'قصتك الأولى',
    hide: 'إخفاء',
    open: 'افتحها',
    items: ['أجب عن أسئلة المحلل', 'وافق على ما سيُبنى', 'فريقك يبنيها', 'راجع الدليل وقل: يبدو صحيحًا'],
    hints: {
      questions: { head: 'دورك: أجب عن الأسئلة', body: 'لا يسأل المحلل إلا عمّا تركته قصتك مفتوحًا، وإجاباتك تحدد شكلها.' },
      spec: { head: 'دورك: وافق على المواصفات', body: 'هذا ما سيبنيه الفريق بكلمات واضحة، ولن يُبنى شيء حتى توافق.' },
      plan: { head: 'دورك: وافق على الخطة', body: 'هكذا سيبنيه الفريق، ولن يُبنى شيء حتى توافق.' },
      proof: { head: 'دورك: راجع الدليل', body: 'كل شرط إنجاز يعرض صورًا من التطبيق الحقيقي. انظر إليها، أو جرّب التطبيق بنفسك. لا يُدمج شيء حتى تقول ذلك.' },
      other: { head: 'دورك', body: 'يحتاج الفريق إلى كلمة منك. افتح القصة لتعرف ما هي.' },
      working: { head: 'فريقك يعمل', body: 'يمكنك إغلاق هذا والعودة لاحقًا. ستصلك بطاقة عندما يحتاجك الفريق، ويمكنك طرح سؤال في أي وقت.' },
    },
  },
};

export function FirstStoryGuide({ tickets, archived, live, project, onOpen }: { tickets: Ticket[]; archived: Ticket[]; live: boolean; project: string; onOpen(id: string): void }) {
  const key = `squad-kit-first-story-hidden:${project}`;
  const [hidden, setHidden] = useState(() => kept(key));
  const lang = readLang();
  const t = live && !hidden ? storyToGuide(tickets, archived) : null;
  if (!t) return null;
  const w = GUIDE[lang];
  const at = guideStep(t);
  const kind = guideHint(t);
  const hint = w.hints[kind];
  return (
    <section className="fs" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} aria-label={w.title}>
      <div className={`fs-hint ${kind === 'working' ? '' : 'fs-hint-you'}`}>
        <b>{hint.head}</b>
        <span>{hint.body}</span>
        <div className="fs-acts">
          <button className="btn sm pri" onClick={() => onOpen(t.id)}>{w.open}</button>
          <Written className="note" text={t.title} />
        </div>
      </div>
      <div className="fs-list">
        <b>{w.title}</b>
        {w.items.map((text, i) => (
          <div key={text} className={`fs-item ${i === at ? 'fs-item-now' : ''}`}>
            <span className={`fs-dot ${i < at ? 'fs-dot-done' : ''}`}>{i < at && <Check size={11} strokeWidth={3} role="img" aria-label="Done" />}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
      <button
        className="iconbtn"
        aria-label={w.hide}
        title={w.hide}
        onClick={() => {
          keep(key);
          setHidden(true);
        }}
      >
        <X size={15} />
      </button>
    </section>
  );
}

const WIN: Record<Lang, { head: string; sub: (title: string) => [string, string]; took: string; doneWhen: string; tests: string; cost: string; next: string; app: string; close: string; of: string; time: (m: number) => string }> = {
  en: {
    head: 'Your first story is in.',
    sub: () => ['"', '" now works in your app. Here is what your squad did.'],
    took: 'from your idea to working',
    doneWhen: '"done when" checked',
    tests: 'automatic tests pass',
    cost: 'of AI use',
    next: 'Write your next story',
    app: 'Open your app',
    close: 'Close',
    of: 'of',
    time: (m) => (m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`),
  },
  ar: {
    head: 'قصتك الأولى اكتملت.',
    sub: () => ['«', '» تعمل الآن في تطبيقك. هذا ما فعله فريقك.'],
    took: 'من فكرتك إلى برنامج يعمل',
    doneWhen: 'شرط إنجاز تم التحقق منه',
    tests: 'اختبارًا آليًا ناجحًا',
    cost: 'من استخدام الذكاء الاصطناعي',
    next: 'اكتب قصتك التالية',
    app: 'افتح تطبيقك',
    close: 'إغلاق',
    of: 'من',
    time: (m) => (m < 60 ? `${m} دقيقة` : m < 2880 ? `${Math.round(m / 60)} ساعة` : `${Math.round(m / 1440)} يوم`),
  },
};

/** Once for each project, in this browser, as soon as its first story goes in. */
export function FirstWin() {
  const board = useBoard();
  const data = board.data?.ready ? board.data : null;
  const key = data ? `squad-kit-first-win:${data.meta.project}` : '';
  const [closed, setClosed] = useState(false);
  const t = data && data.meta.engine === 'live' && !closed && !kept(key) ? firstWinOf(data.tickets, data.archived ?? []) : null;
  if (!t) return null;
  return (
    <FirstWinPage
      t={t}
      onClose={() => {
        keep(key);
        setClosed(true);
      }}
    />
  );
}

function FirstWinPage({ t, onClose }: { t: Ticket; onClose(): void }) {
  const navigate = useNavigate();
  const apps = useApps();
  const act = useAct();
  const lang = readLang();
  const w = WIN[lang];
  const s = winStats(t);
  const app = apps.data?.apps?.find((a) => a.start);
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => nextRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const [before, after] = w.sub(t.title);
  const stats = [
    { value: w.time(s.minutes), label: w.took },
    ...(s.doneWhen ? [{ value: `${s.doneWhen} ${w.of} ${s.doneWhen}`, label: w.doneWhen }] : []),
    ...(s.tests ? [{ value: String(s.tests), label: w.tests }] : []),
    ...(s.costUsd ? [{ value: `$${s.costUsd.toFixed(2)}`, label: w.cost }] : []),
  ];
  return (
    <div className="wl fw" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} role="dialog" aria-modal="true" aria-label={w.head}>
      <div className="wl-in">
        <div className="wl-top">
          <div className="wl-logo" dir="ltr">
            <img src="/logo.svg" alt="" />
            <span>squad-kit</span>
          </div>
          <button className="iconbtn" aria-label={w.close} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="wl-main" style={{ maxWidth: 900 }}>
          <CircleCheck className="fw-mark" size={64} strokeWidth={1.75} aria-hidden="true" />
          <h1 className="fw-h">{w.head}</h1>
          <p className="fw-sub">
            {before}
            <Written text={t.title} />
            {after}
          </p>
          <div className="fw-stats">
            {stats.map((x, i) => (
              <div key={x.label} className="fw-stat" style={{ '--d': `${0.2 + i * 0.12}s` } as React.CSSProperties}>
                <b>{x.value}</b>
                <span>{x.label}</span>
              </div>
            ))}
          </div>
          <div className="fw-acts">
            <button
              ref={nextRef}
              className="wl-cta"
              onClick={() => {
                onClose();
                void navigate({ to: '/board', search: { write: 1 } });
              }}
            >
              {w.next}
            </button>
            {app && (
              <button
                className="fw-ghost"
                disabled={act.isPending}
                onClick={() => {
                  act.mutate({ path: `/api/v1/apps/${encodeURIComponent(app.name)}/start`, done: `Starting ${app.name}` });
                  onClose();
                }}
              >
                {w.app}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
