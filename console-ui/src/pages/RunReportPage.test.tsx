import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { RunReportPage } from './RunReportPage';
import { ToastProvider } from '~/components/Toast';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

function renderReport(path = '/runs/demo-run') {
  const root = createRootRoute();
  const r = createRoute({
    getParentRoute: () => root,
    path: '/runs/$runId',
    validateSearch: (search: Record<string, unknown>) => {
      const t = typeof search.tab === 'string' ? search.tab : '';
      const tab =
        t === 'plan' || t === 'issues' || t === 'telemetry' ?
          (t as 'plan' | 'issues' | 'telemetry')
        : 'plan';
      return { tab };
    },
    component: RunReportPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([r]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const RECORD_BASE = {
  runId: 'demo-run',
  provider: 'anthropic',
  model: 'opus',
  feature: 'feat',
  storyId: 'story-1',
  startedAt: new Date('2024-06-01T10:00:00Z').toISOString(),
  completedAt: new Date('2024-06-01T10:00:06Z').toISOString(),
  success: true,
  partial: false,
  planFile: 'feat/plan.md' as string | null,
  durationMs: 6000,
  version: 1 as const,
  stats: {
    turns: 1,
    inputTokens: 12,
    outputTokens: 6,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
    durationMs: 6000,
  },
};

describe('RunReportPage', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'b'.repeat(64));
    apiMock.mockReset();
  });

  it('hydrates metrics, stage markers, thinking redaction notice, then done event', async () => {
    const caps = { maxFileReads: 10, maxContextBytes: 4096, maxDurationSeconds: 120 };
    const events = [
      {
        kind: 'runtime_info',
        provider: 'anthropic',
        model: 'opus',
        runtimeKind: 'agent-sdk' as const,
        cacheEnabled: true,
        scoutEnabled: true,
        validationEnabled: true,
        budgetCaps: caps,
      },
      { kind: 'stage_started', stage: 'scout' as const },
      { kind: 'stage_complete', stage: 'scout' as const, success: true, durationMs: 1 },
      { kind: 'thinking_block_started', turn: 0, blockIndex: 0 },
      { kind: 'thinking_delta', turn: 0, blockIndex: 0, delta: '' },
      { kind: 'thinking_block_stopped', turn: 0, blockIndex: 0, durationMs: 100, chars: 10 },
      {
        kind: 'done',
        success: true,
        planFile: 'feat/plan.md',
        partial: false,
        stats: RECORD_BASE.stats,
        durationMs: 6000,
      },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs/demo-run')
        return { ...RECORD_BASE, planFile: 'feat/plan.md' };
      if (path.startsWith('/api/runs/demo-run/events'))
        return { runId: 'demo-run', fromIndex: 0, limit: 2000, total: events.length, events };
      throw new Error(`unexpected api path ${path}`);
    });

    renderReport();

    await waitFor(() => {
      expect(screen.getByTestId('generate-metrics-bar')).toBeTruthy();
      expect(screen.getByTestId('feed-stage-scout')).toBeTruthy();
    });

    const thinkBtn = await screen.findByRole('button', { name: /Thinking/i });
    fireEvent.click(thinkBtn);

    await waitFor(() => {
      expect(screen.getByText(/Thinking text not persisted \(block summary only\)/i)).toBeTruthy();
    });
  });

  it('shows rotated-out callout when record 404', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs/demo-run') throw new Error('404 Not Found: {}');
      throw new Error(path);
    });
    renderReport();
    await waitFor(() => {
      expect(screen.getByText(/rotated out/i)).toBeTruthy();
    });
  });

  it('deep-links Issues tab via search', async () => {
    const eventsPage = [
      {
        kind: 'runtime_info',
        provider: 'anthropic',
        model: 'opus',
        runtimeKind: 'agent-sdk' as const,
        cacheEnabled: true,
        scoutEnabled: true,
        validationEnabled: true,
        budgetCaps: { maxFileReads: 10, maxContextBytes: 4096, maxDurationSeconds: 600 },
      },
      {
        kind: 'validation_issue',
        severity: 'warning' as const,
        issueKind: 'missing_path' as const,
        detail: 'x',
      },
      {
        kind: 'done',
        success: true,
        planFile: null,
        partial: false,
        stats: RECORD_BASE.stats,
        durationMs: 6000,
      },
    ];

    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs/demo-run')
        return { ...RECORD_BASE, planFile: null };
      if (path.startsWith('/api/runs/demo-run/events'))
        return { runId: 'demo-run', fromIndex: 0, limit: 2000, total: eventsPage.length, events: eventsPage };
      throw new Error(path);
    });

    renderReport('/runs/demo-run?tab=issues');

    const issuesTab = await screen.findByRole('tab', { name: /Issues/i });
    expect(issuesTab.getAttribute('aria-selected')).toBe('true');

    await waitFor(() => {
      expect(screen.getAllByText(/missing_path/).length).toBeGreaterThan(0);
    });
  });
  it('renders the Auth row from a persisted authMode and enriches it from a replayed auth_info', async () => {
    const events = [
      {
        kind: 'runtime_info',
        provider: 'anthropic',
        model: 'opus',
        runtimeKind: 'agent-sdk' as const,
        cacheEnabled: true,
        scoutEnabled: true,
        validationEnabled: true,
      },
      {
        kind: 'auth_info',
        mode: 'subscription' as const,
        reason: 'explicit-config',
        credentialHint: 'Claude login (macOS Keychain)',
        apiKeySource: 'oauth',
      },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs/demo-run') return { ...RECORD_BASE, authMode: 'subscription' };
      if (path.startsWith('/api/runs/demo-run/events'))
        return { runId: 'demo-run', fromIndex: 0, limit: 2000, total: events.length, events };
      throw new Error(`unexpected api path ${path}`);
    });

    renderReport();

    await waitFor(() =>
      expect(screen.getByTestId('run-auth-row')).toHaveTextContent(
        'Auth subscription · Claude login (macOS Keychain) · oauth',
      ),
    );
  });

  it('renders an em dash for a legacy run record with no authMode', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs/demo-run') return RECORD_BASE;
      if (path.startsWith('/api/runs/demo-run/events')) throw new Error('no events file');
      throw new Error(`unexpected api path ${path}`);
    });

    renderReport();

    await waitFor(() => expect(screen.getByTestId('run-auth-row')).toHaveTextContent('Auth —'));
  });
});
