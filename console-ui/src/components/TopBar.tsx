import { Breadcrumbs } from './Breadcrumbs';
import { DensityToggle } from './DensityToggle';
import { Kbd } from './Kbd';
import { Badge } from './Badge';

export function TopBar() {
  return (
    <header
      className="sticky top-0 z-[var(--z-sticky)] flex h-12 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 px-6 backdrop-blur-sm lg:px-8"
    >
      <Breadcrumbs />
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Open command palette (⌘K)"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('squad:cmdk:open'));
          }}
          className="hidden items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--gray-3)] px-2.5 py-1 text-[12px] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] sm:inline-flex"
        >
          <span>Search…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <DensityToggle />
        <Badge tone="success" dot>
          session
        </Badge>
      </div>
    </header>
  );
}
