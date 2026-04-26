import { useEffect, useState, useCallback } from 'react';

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'squad.console.density';

function read(): Density {
  if (typeof window === 'undefined') return 'comfortable';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'compact' ? 'compact' : 'comfortable';
}

function apply(d: Density) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = d;
}

export function useDensity(): {
  density: Density;
  setDensity: (d: Density) => void;
  toggle: () => void;
} {
  const [density, setDensityState] = useState<Density>(read);

  useEffect(() => {
    apply(density);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, density);
  }, [density]);

  const setDensity = useCallback((d: Density) => setDensityState(d), []);
  const toggle = useCallback(() => setDensityState((v) => (v === 'compact' ? 'comfortable' : 'compact')), []);

  return { density, setDensity, toggle };
}
