import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { Kbd } from './Kbd';

interface Row {
  keys: string[];
  label: string;
}

const sections: { title: string; rows: Row[] }[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['g', 'd'], label: 'Dashboard' },
      { keys: ['g', 's'], label: 'Stories' },
      { keys: ['g', 'p'], label: 'Plans' },
      { keys: ['g', 'r'], label: 'Generate plan' },
      { keys: ['g', 'c'], label: 'Config' },
      { keys: ['g', 'k'], label: 'Secrets' },
      { keys: ['g', 't'], label: 'Tracker' },
      { keys: ['g', 'h'], label: 'Doctor' },
    ],
  },
  {
    title: 'Actions',
    rows: [
      { keys: ['⌘', 'K'], label: 'Open command palette' },
      { keys: ['n', 's'], label: 'New story' },
      { keys: ['?'], label: 'Show this cheatsheet' },
      { keys: ['Esc'], label: 'Close any dialog' },
    ],
  },
];

export function ShortcutsCheatsheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const fn = () => setOpen(true);
    window.addEventListener('squad:dialog:shortcuts', fn);
    return () => window.removeEventListener('squad:dialog:shortcuts', fn);
  }, []);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" size="md">
      <div className="space-y-5">
        {sections.map((sec) => (
          <div key={sec.title}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-dim)]">
              {sec.title}
            </div>
            <ul className="space-y-1.5">
              {sec.rows.map((r) => (
                <li key={r.label} className="flex items-center justify-between text-[13px]">
                  <span className="text-[var(--color-text)]">{r.label}</span>
                  <span className="flex items-center gap-1">
                    {r.keys.map((k) => (
                      <Kbd key={`${r.label}-${k}`}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
