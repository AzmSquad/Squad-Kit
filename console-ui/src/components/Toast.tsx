import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';

type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info';

interface ToastInput {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  tone?: Tone;
  /** ms; 0 disables auto-dismiss. */
  duration?: number;
  /** Optional inline action button. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends Required<Pick<ToastInput, 'id' | 'tone' | 'duration'>> {
  title?: ReactNode;
  description?: ReactNode;
  action?: ToastInput['action'];
}

interface Ctx {
  toast: (input: ToastInput | string) => string;
  dismiss: (id: string) => void;
}

const ToastCtx = createContext<Ctx | null>(null);

export function useToast(): Ctx {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}

const toneIcon: Record<Tone, ReactNode> = {
  default: null,
  success: <CheckCircle2 size={14} className="text-[var(--color-ok)]" aria-hidden />,
  warning: <AlertTriangle size={14} className="text-[var(--color-warn)]" aria-hidden />,
  danger: <AlertCircle size={14} className="text-[var(--color-fail)]" aria-hidden />,
  info: <Info size={14} className="text-[var(--color-info)]" aria-hidden />,
};

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `t${nextId}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setItems((curr) => curr.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      window.clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput | string): string => {
      const normalized: ToastInput = typeof input === 'string' ? { title: input } : input;
      const id = normalized.id ?? makeId();
      const item: ToastItem = {
        id,
        tone: normalized.tone ?? 'default',
        duration: normalized.duration ?? 4500,
        title: normalized.title,
        description: normalized.description,
        action: normalized.action,
      };
      setItems((curr) => [...curr, item]);
      if (item.duration > 0) {
        const tm = window.setTimeout(() => dismiss(id), item.duration);
        timers.current.set(id, tm);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      for (const tm of timers.current.values()) window.clearTimeout(tm);
      timers.current.clear();
    };
  }, []);

  return (
    <ToastCtx.Provider value={{ toast, dismiss }}>
      {children}
      {createPortal(
        <ol
          aria-live="polite"
          aria-atomic="false"
          className="pointer-events-none fixed bottom-6 right-6 z-[var(--z-toast)] flex w-[min(calc(100vw-3rem),360px)] flex-col gap-2"
        >
          {items.map((t) => (
            <li
              key={t.id}
              className="pointer-events-auto rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--gray-3)] px-3 py-2 text-sm text-[var(--color-text)] shadow-2xl animate-fade-up"
            >
              <div className="flex items-start gap-2">
                {toneIcon[t.tone]}
                <div className="min-w-0 flex-1">
                  {t.title ? <div className="font-medium leading-snug">{t.title}</div> : null}
                  {t.description ? (
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{t.description}</div>
                  ) : null}
                  {t.action ? (
                    <button
                      type="button"
                      className="mt-1.5 text-xs font-medium text-[var(--color-accent)] hover:underline"
                      onClick={() => {
                        t.action?.onClick();
                        dismiss(t.id);
                      }}
                    >
                      {t.action.label}
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss(t.id)}
                  className="rounded-[var(--radius-sm)] p-0.5 text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                >
                  <X size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}
