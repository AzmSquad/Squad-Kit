import { Maximize2, Minimize2 } from 'lucide-react';
import { useDensity } from '~/hooks/useDensity';
import { Tooltip } from './Tooltip';

export function DensityToggle() {
  const { density, setDensity } = useDensity();
  return (
    <div
      role="group"
      aria-label="Density"
      className="inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--gray-3)]"
    >
      <Tooltip label="Comfortable">
        <button
          type="button"
          aria-pressed={density === 'comfortable'}
          onClick={() => setDensity('comfortable')}
          className={
            density === 'comfortable'
              ? 'flex h-7 w-7 items-center justify-center bg-[var(--gray-4)] text-[var(--color-text)]'
              : 'flex h-7 w-7 items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }
        >
          <Maximize2 size={12} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label="Compact">
        <button
          type="button"
          aria-pressed={density === 'compact'}
          onClick={() => setDensity('compact')}
          className={
            density === 'compact'
              ? 'flex h-7 w-7 items-center justify-center bg-[var(--gray-4)] text-[var(--color-text)]'
              : 'flex h-7 w-7 items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
          }
        >
          <Minimize2 size={12} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
