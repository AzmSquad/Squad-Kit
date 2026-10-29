import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';

type Theme = 'light' | 'dark';

interface Prefs {
  theme: Theme;
  toggleTheme(): void;
  showCommands: boolean;
  toggleCommands(): void;
  toast(text: string, kind?: 'ok' | 'err'): void;
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

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [showCommands, setShowCommands] = useState(stored('sk.commands') !== 'off');
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store('sk.theme', theme);
  }, [theme]);

  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 5000 : 3200);
  }, []);

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
      toast,
    }),
    [theme, showCommands, toast],
  );

  return (
    <PrefsContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>
            {t.kind === 'err' ? <X size={16} /> : <Check size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </PrefsContext.Provider>
  );
}

export function usePrefs(): Prefs {
  const p = useContext(PrefsContext);
  if (!p) throw new Error('usePrefs outside PrefsProvider');
  return p;
}
