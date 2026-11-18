import { Link2 } from 'lucide-react';

/** The trackers a story can be pulled from, by the name squad-kit saves on the story (its source type). */
const TRACKERS: Record<string, { name: string; viewBox: string; d: string }> = {
  azure: {
    name: 'Azure DevOps',
    viewBox: '0 0 24 24',
    d: 'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z',
  },
  jira: {
    name: 'Jira',
    viewBox: '0 0 24 24',
    d: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
  github: {
    name: 'GitHub',
    viewBox: '0 0 16 16',
    d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
  },
};

/** The tracker's name for people, or null when squad-kit does not know it. */
export function trackerName(type: string): string | null {
  return TRACKERS[type]?.name ?? null;
}

/** Where a story came from, said in words: on the link's tooltip and for screen readers. */
export function pulledFrom(type: string, opens: boolean): string {
  const from = `Pulled from ${trackerName(type) ?? 'your tracker'}`;
  return opens ? `${from}. Opens it there.` : from;
}

/**
 * The tracker's own small mark, in the text's colour, where a story's link says where it came from. A tracker
 * squad-kit has no mark for gets a plain link.
 */
export function TrackerMark({ type, size = 14 }: { type: string; size?: number }) {
  const t = TRACKERS[type];
  if (!t) return <Link2 size={size} aria-hidden="true" />;
  return (
    <svg className="tracker-mark" width={size} height={size} viewBox={t.viewBox} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={t.d} />
    </svg>
  );
}
