import { Copy } from 'lucide-react';
import { Button } from '~/components/Button';
import { useToast } from '~/components/Toast';

/**
 * A shell command the user has to run themselves, with a copy button.
 *
 * Not a new design primitive — it is `code` + `Button` + `Toast` composed once instead of three
 * times. It exists because the console *guides* the Claude login and never performs it: every
 * surface that mentions `squad auth login` must offer the command, never a button that pretends
 * to sign the user in.
 */
export function CommandBlock({ command, className = '' }: { command: string; className?: string }) {
  const { toast } = useToast();

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      toast({ tone: 'success', title: 'Command copied' });
    } catch {
      toast({ tone: 'warning', title: 'Clipboard blocked', description: 'Select the command manually.' });
    }
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <code className="rounded bg-[var(--gray-3)] px-2 py-1 font-mono text-[12px] text-[var(--color-text)]">
        {command}
      </code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        leftIcon={<Copy size={14} aria-hidden />}
        onClick={() => void copy()}
      >
        Copy
      </Button>
    </div>
  );
}
