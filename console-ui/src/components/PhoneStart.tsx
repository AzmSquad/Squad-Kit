import { Link } from '@tanstack/react-router';
import { Loader2, Smartphone } from 'lucide-react';
import type { PhoneAppView } from '../api/types';
import '../styles/check.css';

/**
 * The pieces Your apps and Try it yourself share for a phone app: the language to open it in, the line while it gets
 * onto squad-kit's phone (each step with the time left), the device it runs on, and why it can't when a tool is missing.
 */

/** "Arabic", "English": the language's own name in English, or its code when the browser does not know it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The language to open the app in, next to Start: only when the app comes in more than one. */
export function LanguagePick({ languages, value, onChange }: { languages: string[]; value: string; onChange(code: string): void }) {
  if (languages.length < 2) return null;
  return (
    <select className="input sm phone-lang" aria-label="The language to open the app in" value={value} onChange={(e) => onChange(e.target.value)}>
      {languages.map((l) => (
        <option key={l} value={l}>
          {languageName(l)}
        </option>
      ))}
    </select>
  );
}

/** While it gets onto the phone: the step and about how long is left. Once it runs: the device. Or why it stopped. */
export function PhoneLine({ phone, starting }: { phone: PhoneAppView; starting: boolean }) {
  const run = phone.run;
  if (starting) {
    return (
      <p className="app-more phone-line" role="status">
        <Loader2 size={13} className="spin" aria-hidden="true" /> {run?.line ?? `Getting the app onto squad-kit's ${phone.word}`}
      </p>
    );
  }
  if (run?.state === 'running') {
    return (
      <p className="app-more phone-line">
        <Smartphone size={13} aria-hidden="true" /> Open on {run.device ?? `the ${phone.word}`}
        {run.language && run.language !== 'en' ? `, in ${languageName(run.language)}` : ''}. Close its window when you are done.
      </p>
    );
  }
  if (run?.ended) return <p className="app-more">{run.ended}</p>;
  return null;
}

/** The phone can't open it here yet: why, and the line of the Tools page with what is needed. */
export function PhoneNotReady({ phone }: { phone: PhoneAppView }) {
  if (phone.ready || !phone.why) return null;
  return (
    <p className="app-more phone-wait">
      {phone.why} {phone.web ? 'Start opens the web version meanwhile. ' : ''}
      <Link to="/tools" hash={(phone.link ?? '/tools').split('#')[1] ?? ''}>
        See what&apos;s needed
      </Link>
    </p>
  );
}
