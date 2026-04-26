import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';

interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface Ctx {
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
}

const ConfirmCtx = createContext<Ctx | null>(null);

export function useConfirm(): Ctx['confirm'] {
  const v = useContext(ConfirmCtx);
  if (!v) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return v.confirm;
}

interface PendingState {
  options: ConfirmOptions;
  resolve: (v: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);

  const confirm = useCallback<Ctx['confirm']>((o) => {
    return new Promise<boolean>((resolve) => {
      const options: ConfirmOptions = typeof o === 'string' ? { title: o } : o;
      setPending({ options, resolve });
    });
  }, []);

  const finish = (ok: boolean) => {
    if (!pending) return;
    pending.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmCtx.Provider value={{ confirm }}>
      {children}
      <Dialog
        open={pending !== null}
        title={pending?.options.title ?? ''}
        description={pending?.options.description}
        size="sm"
        onClose={() => finish(false)}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => finish(false)}>
              {pending?.options.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              type="button"
              variant={pending?.options.tone === 'danger' ? 'danger' : 'primary'}
              onClick={() => finish(true)}
            >
              {pending?.options.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}
