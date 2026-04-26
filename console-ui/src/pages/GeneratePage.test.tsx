import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { GeneratePage } from './GeneratePage';
import { ToastProvider } from '~/components/Toast';
import type { ApiStory } from '~/api/types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

type EsListener = (ev: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  listeners = new Map<string, Set<EsListener>>();
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: EsListener) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  close() {}
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

const generateSearch = (search: Record<string, unknown>) => ({
  feature: typeof search.feature === 'string' ? search.feature : '',
  storyId: typeof search.storyId === 'string' ? search.storyId : '',
});

function renderPage(initialPath = '/generate') {
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/generate',
    validateSearch: generateSearch,
    component: () => <GeneratePage />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GeneratePage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'a'.repeat(64));
    apiMock.mockReset();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('shows file reads, cache badge, and success card from streamed events', async () => {
    const stories: ApiStory[] = [
      {
        feature: 'demo',
        id: '01-x',
        intakePath: '/p',
        storyDir: '/s',
        planFile: null,
        titleHint: 't',
      },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return stories;
      if (path === '/api/config') return { planner: { enabled: true, provider: 'anthropic' }, version: 1 };
      if (path === '/api/runs/active') return [];
      throw new Error(`unexpected ${path}`);
    });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ runId: 'run-1' }),
    } as Response);

    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const running = await screen.findByText('running');
    expect(running).toHaveStyle({ color: 'var(--color-info)' });
    const es = MockEventSource.instances[0]!;

    es.emit(
      'cache_summary',
      JSON.stringify({ kind: 'cache_summary', runId: 'run-1', turn: 2, cacheHitRatio: 0.68 }),
    );
    es.emit(
      'tool_call',
      JSON.stringify({
        kind: 'tool_call',
        runId: 'run-1',
        turn: 1,
        toolCall: { input: { path: 'src/a.ts' } },
        bytesLoaded: 4300,
        totalBytes: 9000,
      }),
    );
    es.emit(
      'done',
      JSON.stringify({
        kind: 'done',
        runId: 'run-1',
        success: true,
        planFile: '01-story-x.md',
        partial: false,
        stats: {
          turns: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 1,
        },
        durationMs: 1,
      }),
    );

    await waitFor(() => expect(screen.getByText(/cache hit 68%/)).toBeInTheDocument());
    expect(screen.getByText(/src\/a\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/Plan saved/)).toBeInTheDocument();
    const openLink = screen.getByRole('link', { name: 'Open' });
    expect(openLink).toHaveAttribute('href', '/plans/demo/01-story-x.md');
  });

  it('issues DELETE when Cancel is clicked', async () => {
    const stories: ApiStory[] = [
      {
        feature: 'demo',
        id: '01-x',
        intakePath: '/p',
        storyDir: '/s',
        planFile: null,
        titleHint: null,
      },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return stories;
      if (path === '/api/config') return { planner: { enabled: true }, version: 1 };
      if (path === '/api/runs/active') return [];
      throw new Error(`unexpected ${path}`);
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ runId: 'run-z' }),
    } as Response);

    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel run' })).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-z',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('prefers feature and story from URL search over auto-selected default', async () => {
    const stories: ApiStory[] = [
      {
        feature: 'demo',
        id: '01-x',
        intakePath: '/p',
        storyDir: '/s',
        planFile: null,
        titleHint: 'first',
      },
      {
        feature: 'demo',
        id: '02-z',
        intakePath: '/p2',
        storyDir: '/s2',
        planFile: null,
        titleHint: 'auto default',
      },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return stories;
      if (path === '/api/config') return { planner: { enabled: true }, version: 1 };
      if (path === '/api/runs/active') return [];
      throw new Error(`unexpected ${path}`);
    });

    renderPage('/generate?feature=demo&storyId=01-x');

    await waitFor(() => {
      const story = screen.getByLabelText('Story') as HTMLSelectElement;
      expect(story.value).toBe('01-x');
    });
    const feature = screen.getByLabelText('Feature') as HTMLSelectElement;
    expect(feature.value).toBe('demo');
  });
});
