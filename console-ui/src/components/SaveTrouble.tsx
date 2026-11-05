import { useQuery } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import { api } from '../api/client';

/**
 * squad-kit cannot save its files (a full disk, a project folder that moved): the squad of that project waits, and it
 * carries on by itself once a small test write gets through. On Home and every project page, so it is never silent.
 */
export function SaveTroubleBanner() {
  const { data } = useQuery({
    queryKey: ['app', 'save-trouble'],
    queryFn: () => api<{ text: string | null; detail?: string; projects: string[] }>('/api/v1/app/save-trouble'),
    refetchInterval: 5000,
  });
  if (!data?.text) return null;
  return (
    <section className="upd failed" role="alert" aria-label="squad-kit cannot save its work">
      <span className="upd-ic">
        <HardDrive size={16} />
      </span>
      <div className="upd-main">
        <b className="upd-title">{data.text}</b>
        <span className="upd-sub">The squad waits meanwhile. {data.projects.length > 1 ? `${data.projects.length} projects wait.` : ''}</span>
        {data.detail && (
          <details>
            <summary className="note">For engineers</summary>
            <span className="mono" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{data.detail}</span>
          </details>
        )}
      </div>
    </section>
  );
}
