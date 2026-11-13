import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { api } from '../api/client';
import type { Journey } from '../api/contribution-types';
import { JOURNEY } from '../lib/contribute-words';
import { readLang } from '../lib/first-story';
import { useBoard } from '../lib/data';
import '../styles/contribute.css';

/**
 * On every page of a contribution to squad-kit's own code: where it is, from set up to the owner's merge, and that
 * squad-kit stays with the person until then. The step is the engine's (GET /contribute/journey, `squad contribute`),
 * for the open story when one is open. The bar opens the contribution assistant.
 */

export function useJourney(ticket: string | undefined, on: boolean) {
  return useQuery({
    queryKey: ['journey', ticket ?? ''],
    queryFn: () => api<Journey>(`/api/v1/contribute/journey${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`),
    enabled: on,
    refetchInterval: 5000,
  });
}

export function JourneyBar({ ticket }: { ticket?: string }) {
  const board = useBoard();
  const self = board.data?.ready ? Boolean(board.data.self) : false;
  const j = useJourney(ticket, self).data;
  if (!self || !j?.self) return null;
  const lang = readLang();
  const w = JOURNEY[lang];
  return (
    <div className="jr" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <Link to="/contribute" className="jr-t" title={j.ticket ? w.story(j.ticket) : undefined}>
        <img src="/logo.svg" alt="" width={30} height={30} />
        <span>
          <b>{w.title}</b>
          <small>{w.sub}</small>
        </span>
      </Link>
      <ol aria-label={w.title}>
        {w.steps.map((s, i) => {
          // Closed by the owner: the review step says so, and the bar stops there.
          const shut = j.closed && i === j.at;
          return (
            <li key={s} className={shut ? 'x' : i < j.at ? 'd' : i === j.at ? 'n' : ''} aria-current={i === j.at ? 'step' : undefined}>
              <span aria-hidden="true">{shut ? <X size={10} strokeWidth={3} /> : i < j.at && <Check size={10} strokeWidth={3} />}</span>
              {shut ? w.closed : s}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
