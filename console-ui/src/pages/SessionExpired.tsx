import { Callout } from '~/components/Callout';
import { Kbd } from '~/components/Kbd';
import { Page } from '~/components/Page';

export function SessionExpired() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)] px-6 py-12 text-[var(--color-text)]">
      <Page title="Session not available" description="The console must be opened with a fresh link from the CLI.">
        <Callout tone="warning" title="Session expired">
          <p>
            The console URL must include a fresh token from the terminal. Run <Kbd>squad console</Kbd> again and open the link
            it prints (or paste <Kbd>?t=…</Kbd> into the address bar).
          </p>
          <p className="mt-2 text-[var(--color-text-dim)]">
            If you closed the terminal, start <Kbd>squad console</Kbd> from your project root.
          </p>
        </Callout>
      </Page>
    </div>
  );
}
