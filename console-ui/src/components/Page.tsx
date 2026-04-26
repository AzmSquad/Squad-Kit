import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  description?: ReactNode;
  /** Right-side toolbar actions (buttons, links). */
  actions?: ReactNode;
  /** Optional breadcrumbs slot rendered above the title. Story 04 ships <Breadcrumbs />. */
  breadcrumbs?: ReactNode;
  children: ReactNode;
}

export function Page({ title, description, actions, breadcrumbs, children }: Props) {
  return (
    <section className="flex flex-col">
      {breadcrumbs ? <div className="mb-3">{breadcrumbs}</div> : null}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1
            className="text-[var(--font-size-h1)] font-semibold tracking-tight text-[var(--color-text)]"
            style={{ letterSpacing: '-0.015em' }}
          >
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex flex-col gap-[var(--space-section)]">{children}</div>
    </section>
  );
}
