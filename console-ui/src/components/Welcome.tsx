import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, Code2, Compass, Copy, Eye, FileText, FolderOpen, Loader2, Play, Search, SquareCheck, UserRound } from 'lucide-react';
import { api, send } from '../api/client';
import type { AppProject, ComputerReady, ReadyStep } from '../api/types';
import { readLang, saveLang, type Lang } from '../lib/first-story';

/**
 * The very first start, before any project: who the squad is, whether this computer is ready, and what the person has.
 * In English or Arabic. Nothing here runs an AI tool.
 */

export type WelcomeStep = 'welcome' | 'ready' | 'start';

const WORDS = {
  en: {
    other: 'العربية',
    head: 'Meet your engineering squad.',
    sub: 'Five specialists turn your idea into working software. They do the technical work. You make the decisions.',
    squad: [
      ['Analyst', 'Understands what you need'],
      ['Architect', 'Plans how to build it'],
      ['Builder', 'Writes the code'],
      ['Reviewer', 'Checks the work'],
      ['Tester', 'Shows you the proof'],
    ],
    you: 'You',
    youDo: 'Say if it looks right',
    go: 'Get started',
    note: 'It takes about 2 minutes to get ready.',
    readyHead: 'Is your computer ready?',
    readySub: 'squad-kit checks this by itself. If something is missing, you get one clear step.',
    git: 'Git',
    gitOk: 'It keeps every version of your work safe.',
    tool: 'Your AI tool',
    toolOk: (label: string) => `${label} is ready.`,
    browser: 'The screenshot browser',
    browserOk: 'squad-kit sets it up by itself the first time it is needed.',
    checking: 'Checking your computer…',
    goOn: 'Continue',
    allSet: 'All set. You can change these later in Settings.',
    oneLeft: 'One step left.',
    anyway: 'Continue anyway',
    steps: {
      'install-git': 'Git is not on this computer. Install it, then come back here.',
      'update-git': 'Git is too old for squad-kit. Update it to 2.38 or newer, then come back here.',
      'install-tool': 'Your squad needs an AI tool. Open a terminal and install Claude Code with this line, then come back here.',
      'sign-in': (label?: string) => `${label ?? 'Your AI tool'} is here. Sign in once and your squad can work: open a terminal, run this line, and follow what it says.`,
    },
    download: 'Get Git',
    copy: 'Copy',
    startHead: 'What do you have?',
    newHead: 'A BRD or an idea',
    newBody: "Start a new project from nothing. You don't need a folder, code, or any technical knowledge.",
    newGo: 'New project',
    addHead: 'A project I already have',
    addBody: 'Pick its folder. Your squad reads it first, and nothing changes until you approve.',
    showHead: 'Just show me',
    showBody: 'Watch a sample project being built. No AI runs, and it costs nothing.',
    showing: 'Opening the sample project…',
    back: 'Back',
  },
  ar: {
    other: 'English',
    head: 'تعرّف على فريقك الهندسي.',
    sub: 'خمسة متخصصين يحوّلون فكرتك إلى برنامج يعمل. هم يتولون العمل التقني، وأنت تتخذ القرارات.',
    squad: [
      ['المحلل', 'يفهم ما تحتاجه'],
      ['المهندس', 'يخطط لطريقة البناء'],
      ['المطوّر', 'يكتب الكود'],
      ['المراجع', 'يفحص العمل'],
      ['المختبِر', 'يعرض لك الدليل'],
    ],
    you: 'أنت',
    youDo: 'تقرر إن كان مناسبًا',
    go: 'لنبدأ',
    note: 'يستغرق التجهيز نحو دقيقتين.',
    readyHead: 'هل جهازك جاهز؟',
    readySub: 'يتحقق squad-kit من ذلك بنفسه. وإن نقص شيء، تحصل على خطوة واحدة واضحة.',
    git: 'Git',
    gitOk: 'يحفظ كل نسخة من عملك بأمان.',
    tool: 'أداة الذكاء الاصطناعي',
    toolOk: (label: string) => `${label} جاهز.`,
    browser: 'متصفح لقطات الشاشة',
    browserOk: 'يجهّزه squad-kit بنفسه عند أول حاجة إليه.',
    checking: 'جارٍ فحص جهازك…',
    goOn: 'متابعة',
    allSet: 'كل شيء جاهز. يمكنك تغيير هذا لاحقًا من الإعدادات.',
    oneLeft: 'بقيت خطوة واحدة.',
    anyway: 'متابعة على أي حال',
    steps: {
      'install-git': 'Git غير موجود على هذا الجهاز. ثبّته ثم عد إلى هنا.',
      'update-git': 'نسخة Git قديمة بالنسبة إلى squad-kit. حدّثها إلى 2.38 أو أحدث ثم عد إلى هنا.',
      'install-tool': 'يحتاج فريقك إلى أداة ذكاء اصطناعي. افتح نافذة الأوامر وثبّت Claude Code بهذا السطر، ثم عد إلى هنا.',
      'sign-in': (label?: string) => `${label ?? 'أداة الذكاء الاصطناعي'} موجودة. سجّل الدخول مرة واحدة ليعمل فريقك: افتح نافذة الأوامر، وشغّل هذا السطر، واتبع ما يطلبه.`,
    },
    download: 'تنزيل Git',
    copy: 'نسخ',
    startHead: 'ماذا لديك؟',
    newHead: 'وثيقة متطلبات أو فكرة',
    newBody: 'ابدأ مشروعًا جديدًا من الصفر. لا تحتاج إلى مجلد أو كود أو خبرة تقنية.',
    newGo: 'مشروع جديد',
    addHead: 'مشروع لديّ بالفعل',
    addBody: 'اختر مجلده. يقرؤه فريقك أولًا، ولا يتغير شيء حتى توافق.',
    showHead: 'أرني فقط',
    showBody: 'شاهد بناء مشروع تجريبي. بلا ذكاء اصطناعي وبلا تكلفة.',
    showing: 'جارٍ فتح المشروع التجريبي…',
    back: 'رجوع',
  },
};

const SQUAD_ICONS = [
  { icon: Search, color: '#2f6fd0' },
  { icon: Compass, color: '#6a4fc2' },
  { icon: Code2, color: '#b4590f' },
  { icon: Eye, color: '#0e6f7a' },
  { icon: SquareCheck, color: 'var(--accent)' },
];

/** Opens the sample project: no AI, no cost. */
async function openSample(): Promise<void> {
  const p = await send<AppProject>('/api/v1/app/sample', 'POST');
  window.location.assign(p.url);
}

export function Welcome({ step, onStep, onNew, onAdd }: { step: WelcomeStep; onStep(s: WelcomeStep): void; onNew(): void; onAdd(): void }) {
  const [lang, setLang] = useState<Lang>(readLang);
  const w = WORDS[lang];
  const swap = () => {
    const next: Lang = lang === 'ar' ? 'en' : 'ar';
    saveLang(next);
    setLang(next);
  };
  const started = () => {
    onStep('ready');
    // A failed save only means this page may show once more.
    void send('/api/v1/app/settings', 'PUT', { welcomed: true }).catch(() => undefined);
  };
  return (
    <div className="wl" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <div className="wl-in">
        <div className="wl-top">
          <div className="wl-logo" dir="ltr">
            <img src="/logo.svg" alt="" />
            <span>squad-kit</span>
          </div>
          <button className="wl-lang" onClick={swap}>{w.other}</button>
        </div>
        {step === 'welcome' && <Meet lang={lang} onGo={started} />}
        {step === 'ready' && <Ready lang={lang} onGo={() => onStep('start')} />}
        {step === 'start' && <Start lang={lang} onNew={onNew} onAdd={onAdd} onBack={() => onStep('ready')} />}
      </div>
    </div>
  );
}

function Meet({ lang, onGo }: { lang: Lang; onGo(): void }) {
  const w = WORDS[lang];
  return (
    <>
      <div className="wl-main wl-main-wide">
        <h1 className="wl-big">{w.head}</h1>
        <p className="wl-sub">{w.sub}</p>
        <div className="wl-squad">
          <div className="wl-wire" aria-hidden="true" />
          {w.squad.map(([name, does], i) => {
            const { icon: Icon, color } = SQUAD_ICONS[i]!;
            return (
              <div key={name} className="wl-tile" style={{ '--d': `${0.1 + i * 0.35}s` } as React.CSSProperties}>
                <div className="wl-mark" style={{ color }}><Icon size={24} aria-hidden="true" /></div>
                <b>{name}</b>
                <span>{does}</span>
              </div>
            );
          })}
          <div className="wl-tile" style={{ '--d': '1.95s' } as React.CSSProperties}>
            <div className="wl-mark wl-mark-you"><UserRound size={24} aria-hidden="true" /></div>
            <b className="wl-you">{w.you}</b>
            <span>{w.youDo}</span>
          </div>
        </div>
      </div>
      <div className="wl-go wl-go-wide">
        <button className="wl-cta" onClick={onGo}>{w.go}</button>
        <span>{w.note}</span>
      </div>
    </>
  );
}

/** The line to run. The clipboard can refuse, so the words are there to select too. */
function Line({ text, copy }: { text: string; copy: string }) {
  return (
    <span className="wl-cmd">
      <span>{text}</span>
      <button aria-label={copy} title={copy} onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}>
        <Copy size={14} />
      </button>
    </span>
  );
}

const LINE: Partial<Record<ReadyStep, string>> = {
  'install-tool': 'npm install -g @anthropic-ai/claude-code',
  'sign-in': 'claude',
};

function OneStep({ lang, step, label }: { lang: Lang; step: ReadyStep; label?: string }) {
  const w = WORDS[lang];
  const said = w.steps[step];
  const line = LINE[step];
  return (
    <>
      <span className="wl-line">{typeof said === 'function' ? said(label) : said}</span>
      <span className="wl-step">
        {line && <Line text={line} copy={w.copy} />}
        {(step === 'install-git' || step === 'update-git') && (
          <a className="wl-act" href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">{w.download}</a>
        )}
      </span>
    </>
  );
}

function Tick({ state }: { state: 'ok' | 'needs' | 'wait' }) {
  if (state === 'wait') return <span className="wl-tick wl-tick-wait"><Loader2 size={20} className="spin" role="img" aria-label="Checking" /></span>;
  if (state === 'needs') return <span className="wl-tick wl-tick-needs"><CircleAlert size={16} strokeWidth={2.5} role="img" aria-label="Needs one step" /></span>;
  return <span className="wl-tick"><Check size={15} strokeWidth={3} role="img" aria-label="Ready" /></span>;
}

function Ready({ lang, onGo }: { lang: Lang; onGo(): void }) {
  const w = WORDS[lang];
  // It looks again by itself, so the page moves on as soon as the person is done in the terminal.
  const q = useQuery({
    queryKey: ['app', 'ready'],
    queryFn: () => api<ComputerReady>('/api/v1/app/ready'),
    refetchInterval: (s) => (s.state.data?.git.ok && s.state.data?.tool.ok ? false : 3000),
  });
  const d = q.data;
  const done = Boolean(d?.git.ok && d?.tool.ok);
  return (
    <div className="wl-main wl-main-narrow">
      <h1>{w.readyHead}</h1>
      <p className="wl-sub wl-sub-tight">{w.readySub}</p>
      <div className="wl-rows" aria-live="polite">
        <div className="wl-row">
          <Tick state={!d ? 'wait' : d.git.ok ? 'ok' : 'needs'} />
          <div>
            <b>{w.git}</b>
            {!d ? <span className="wl-line">{w.checking}</span> : d.git.step ? <OneStep lang={lang} step={d.git.step} /> : <span className="wl-line">{w.gitOk}</span>}
          </div>
        </div>
        <div className="wl-row">
          <Tick state={!d ? 'wait' : d.tool.ok ? 'ok' : 'needs'} />
          <div>
            <b>{w.tool}</b>
            {!d ? <span className="wl-line">{w.checking}</span> : d.tool.step ? <OneStep lang={lang} step={d.tool.step} label={d.tool.label} /> : <span className="wl-line">{w.toolOk(d.tool.label ?? '')}</span>}
          </div>
        </div>
        <div className="wl-row">
          <Tick state={d ? 'ok' : 'wait'} />
          <div>
            <b>{w.browser}</b>
            <span className="wl-line">{w.browserOk}</span>
          </div>
        </div>
      </div>
      <div className="wl-go" style={{ marginTop: 32 }}>
        <button className="wl-cta" disabled={!done} onClick={onGo}>{w.goOn}</button>
        <span>{done ? w.allSet : d ? w.oneLeft : w.checking}</span>
        {/* A check can be wrong about a computer it does not know: it never stops anyone. */}
        {(d && !done) || q.isError ? <button className="wl-quiet" onClick={onGo}>{w.anyway}</button> : null}
      </div>
    </div>
  );
}

function Start({ lang, onNew, onAdd, onBack }: { lang: Lang; onNew(): void; onAdd(): void; onBack(): void }) {
  const w = WORDS[lang];
  const [showing, setShowing] = useState(false);
  const [failed, setFailed] = useState('');
  const show = async () => {
    setShowing(true);
    setFailed('');
    try {
      await openSample();
    } catch (err) {
      setShowing(false);
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="wl-main wl-main-mid">
      <h1 style={{ marginBottom: 32 }}>{w.startHead}</h1>
      <div className="wl-cards">
        <button className="wl-card wl-card-main" onClick={onNew}>
          <FileText size={36} strokeWidth={1.8} aria-hidden="true" />
          <span className="wl-fill" />
          <b>{w.newHead}</b>
          <span>{w.newBody}</span>
          <i>{w.newGo}</i>
        </button>
        <button className="wl-card wl-card-side" onClick={onAdd}>
          <FolderOpen size={28} aria-hidden="true" />
          <span className="wl-fill" />
          <b>{w.addHead}</b>
          <span>{w.addBody}</span>
        </button>
        <button className="wl-card wl-card-side" disabled={showing} onClick={() => void show()}>
          <Play size={28} aria-hidden="true" />
          <span className="wl-fill" />
          <b>{w.showHead}</b>
          <span>{showing ? w.showing : w.showBody}</span>
        </button>
      </div>
      {failed && <p className="wl-err" role="alert">{failed}</p>}
      <div className="wl-go" style={{ marginTop: 20 }}>
        <button className="wl-quiet" onClick={onBack}>{w.back}</button>
      </div>
    </div>
  );
}

/** The third way in on an empty Home: the sample project. */
export function JustShowMe() {
  const [showing, setShowing] = useState(false);
  const [failed, setFailed] = useState('');
  return (
    <button
      className="home-empty"
      disabled={showing}
      onClick={() => {
        setShowing(true);
        setFailed('');
        openSample().catch((err: unknown) => {
          setShowing(false);
          setFailed(err instanceof Error ? err.message : String(err));
        });
      }}
    >
      <Play size={22} />
      <b>Just show me</b>
      <span role={failed ? 'alert' : undefined}>{failed || (showing ? WORDS.en.showing : WORDS.en.showBody)}</span>
    </button>
  );
}
