import { useCallback, useId, useState, type KeyboardEvent, type ReactNode } from 'react';

export function Tabs({
  tabs,
  defaultIndex = 0,
}: {
  tabs: { id: string; label: string; panel: ReactNode }[];
  defaultIndex?: number;
}) {
  const baseId = useId();
  const [i, setI] = useState(defaultIndex);
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setI((j) => (j + 1) % tabs.length);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setI((j) => (j - 1 + tabs.length) % tabs.length);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setI(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setI(tabs.length - 1);
      }
    },
    [tabs.length],
  );

  return (
    <div>
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex gap-4 border-b border-[var(--color-border)]"
        onKeyDown={onKeyDown}
      >
        {tabs.map((t, j) => {
          const selected = j === i;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={
                selected
                  ? 'relative -mb-px border-b-2 border-[var(--color-text)] px-1 py-2 text-[13px] font-medium text-[var(--color-text)]'
                  : 'relative -mb-px border-b-2 border-transparent px-1 py-2 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }
              onClick={() => setI(j)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t, j) => (
        <div
          key={t.id}
          id={`${baseId}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={j !== i}
          className="pt-4"
        >
          {j === i ? t.panel : null}
        </div>
      ))}
    </div>
  );
}
