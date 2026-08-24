import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '~/components/Button';
import type { RateLimitStateUI } from '~/hooks/useGenerateRun';

export function RateLimitRing({
  rateLimit,
  onRerun,
  onCancel,
  rerunDisabled,
  subscription = false,
}: {
  rateLimit: RateLimitStateUI;
  onRerun: () => void;
  onCancel: () => void;
  rerunDisabled?: boolean;
  /** Subscription runs hit a Claude *usage window*, not a provider API rate limit. */
  subscription?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const elapsedSec = Math.floor((now - rateLimit.receivedAtMs) / 1000);
  const remaining = Math.max(0, rateLimit.retryAfterSec - elapsedSec);

  const circumference = 2 * Math.PI * 42;
  const progress = rateLimit.retryAfterSec > 0 ? Math.min(1, remaining / rateLimit.retryAfterSec) : 0;

  const limitsUrl: Record<typeof rateLimit.provider, string> = {
    anthropic: 'https://console.anthropic.com/settings/limits',
    openai: 'https://platform.openai.com/settings/organization/limits',
    google: 'https://aistudio.google.com/app/plan_information',
  };

  return (
    <div
      data-testid="rate-limit-ring"
      className="mb-4 rounded-xl border border-[var(--color-info-border)] bg-[var(--color-info-bg)] p-4"
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="relative h-24 w-24 shrink-0">
          <svg viewBox="0 0 100 100" className="-rotate-90" aria-hidden>
            <circle cx="50" cy="50" r="42" stroke="var(--gray-5)" strokeWidth="10" fill="none" />
            <circle
              cx="50"
              cy="50"
              r="42"
              stroke="var(--color-info)"
              strokeWidth="10"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              className="transition-[stroke-dashoffset] duration-500"
            />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center tabular">
            <span className="text-xl font-semibold text-[var(--color-text)]">{remaining}s</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">retry</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-[var(--color-text)]">
            {subscription
              ? `Claude usage limit reached (${rateLimit.phase})`
              : `${rateLimit.provider} rate limit hit (${rateLimit.phase})`}
          </p>
          <p className="mt-1 text-[var(--color-text-muted)]">
            Retry after{' '}
            <span className="tabular font-medium text-[var(--color-text)]">{rateLimit.retryAfterSec}s</span>
            .
            {rateLimit.phase === 'retrying' ? (
              <>
                {' '}
                Auto-retrying in <span className="tabular">{remaining}s</span>…
              </>
            ) : (
              <>
                {' '}
                Above our {rateLimit.capSec}s retry cap — run stopped cleanly.
              </>
            )}
          </p>

          <details className="mt-2 text-[12px] text-[var(--color-text-muted)]">
            <summary className="cursor-pointer text-[var(--color-text)]">Why this happened</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {subscription ? (
                <li>Planning draws on the same usage limits as Claude and Claude Code — the window has to reset.</li>
              ) : (
                <li>Provider throttled upstream requests.</li>
              )}
              <li>Wait the full backoff before retrying to avoid multiplying 429s.</li>
              <li>
                <Link to={'/config' as never} className="underline">
                  Config
                </Link>{' '}
                lets you shrink model tier or tighten planner budget.
              </li>
              {subscription ? null : (
                <li>
                  <a href={limitsUrl[rateLimit.provider]} className="underline" target="_blank" rel="noreferrer">
                    Provider limits dashboard
                  </a>
                </li>
              )}
            </ul>
          </details>

          {rateLimit.phase === 'aborted' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={rerunDisabled || remaining > 0}
                onClick={onRerun}
                data-testid="rate-limit-rerun"
              >
                {remaining > 0 ? `Wait ${remaining}s` : 'Rerun planner'}
              </Button>
              <Button type="button" variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
