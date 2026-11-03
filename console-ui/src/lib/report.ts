import { useSyncExternalStore } from 'react';

/**
 * Report a problem can open from anywhere: a ticket, an error card, a toast, Settings. One dialog serves them all;
 * this says which one is asked for. `ticket` makes it a report about that ticket of this page's project.
 */
export interface ReportAsk {
  ticket?: string;
  /** For the whole app, not this page's project (Home, and Settings' app-level report). */
  app?: boolean;
}

let asked: ReportAsk | null = null;
const listeners = new Set<() => void>();

function set(next: ReportAsk | null): void {
  asked = next;
  for (const l of listeners) l();
}

export const report = {
  open: (ask: ReportAsk = {}) => set(ask),
  close: () => set(null),
};

export function useReportAsk(): ReportAsk | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => asked,
  );
}
