import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

const CHORD_TIMEOUT_MS = 1200;

const goRoutes: Record<string, string> = {
  d: '/',
  s: '/stories',
  p: '/plans',
  r: '/generate',
  c: '/config',
  k: '/secrets',
  t: '/tracker',
  h: '/doctor',
};

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
  const ce = t.getAttribute('contenteditable');
  if (ce === '' || ce === 'true') return true;
  if (t.tagName === 'SELECT') return true;
  return false;
}

export function useGlobalShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    let chord: 'g' | 'n' | null = null;
    let chordAt = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const k = e.key.toLowerCase();

      if (e.key === '?') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('squad:dialog:shortcuts'));
        chord = null;
        return;
      }

      if (chord && Date.now() - chordAt > CHORD_TIMEOUT_MS) {
        chord = null;
      }

      if (chord === 'g' && goRoutes[k]) {
        e.preventDefault();
        navigate({ to: goRoutes[k] as never });
        chord = null;
        return;
      }
      if (chord === 'n' && k === 's') {
        e.preventDefault();
        navigate({ to: '/stories' as never });
        window.dispatchEvent(new CustomEvent('squad:dialog:new-story'));
        chord = null;
        return;
      }

      if (k === 'g' || k === 'n') {
        chord = k;
        chordAt = Date.now();
      } else {
        chord = null;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}
