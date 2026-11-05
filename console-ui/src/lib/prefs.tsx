import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { toastLife, withToast, type Toast } from './toasts';
import { report } from './report';

type Theme = 'light' | 'dark';

interface Prefs {
  theme: Theme;
  toggleTheme(): void;
  showCommands: boolean;
  toggleCommands(): void;
  /** An open ticket covers the whole board area instead of the side panel. Remembered in this browser. */
  ticketFull: boolean;
  toggleTicketFull(): void;
  /** An error toast offers Report a problem, and Try again when `retry` is given. */
  toast(text: string, kind?: 'ok' | 'err', retry?: () => void): void;
}

const PrefsContext = createContext<Prefs | null>(null);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit only.
  }
}

export function initialTheme(): Theme {
  const saved = stored('sk.theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [showCommands, setShowCommands] = useState(stored('sk.commands') !== 'off');
  const [ticketFull, setTicketFull] = useState(stored('sk.ticketFull') === 'on');
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store('sk.theme', theme);
  }, [theme]);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, kind: 'ok' | 'err' = 'ok', retry?: () => void) => {
      const id = Date.now() + Math.random();
      setToasts((t) => withToast(t, { id, text, kind, ...(retry ? { retry } : {}) }));
      const life = toastLife(kind);
      if (life !== null) setTimeout(() => dismiss(id), life);
    },
    [dismiss],
  );

  const value = useMemo<Prefs>(
    () => ({
      theme,
      toggleTheme: () => setTheme((t) => (t === 'light' ? 'dark' : 'light')),
      showCommands,
      toggleCommands: () =>
        setShowCommands((s) => {
          store('sk.commands', s ? 'off' : 'on');
          return !s;
        }),
      ticketFull,
      toggleTicketFull: () =>
        setTicketFull((f) => {
          store('sk.ticketFull', f ? 'off' : 'on');
          return !f;
        }),
      toast,
    }),
    [theme, showCommands, ticketFull, toast],
  );

  return (
    <PrefsContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) =>
          t.kind === 'err' ? (
            <div key={t.id} className="toast err" role="alert">
              <CircleAlert size={16} />
              <span className="grow">{t.text}</span>
              {t.retry && (
                <button
                  className="toast-act"
                  onClick={() => {
                    dismiss(t.id);
                    t.retry!();
                  }}
                >
                  Try again
                </button>
              )}
              <button
                className="toast-act"
                onClick={() => {
                  dismiss(t.id);
                  report.open();
                }}
              >
                Report a problem
              </button>
              <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="Close this message">
                <X size={15} />
              </button>
            </div>
          ) : (
            <div key={t.id} className="toast">
              <Check size={16} />
              {t.text}
            </div>
          ),
        )}
      </div>
    </PrefsContext.Provider>
  );
}

export function usePrefs(): Prefs {
  const p = useContext(PrefsContext);
  if (!p) throw new Error('usePrefs outside PrefsProvider');
  return p;
}
