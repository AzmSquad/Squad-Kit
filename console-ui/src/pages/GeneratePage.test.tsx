import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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
import type { ApiPlannerAuth, ApiStory } from '~/api/types';

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

const API_KEY_AUTH: ApiPlannerAuth = {
  provider: 'anthropic',
  configuredMode: 'api-key',
  resolved: { mode: 'api-key', reason: 'explicit in .squad/config.yaml', credentialHint: 'ANTHROPIC_API_KEY' },
  error: null,
  login: { present: false, hint: 'none', detail: 'no Claude login detected' },
  account: null,
  apiKeySource: null,
  runtime: 'agent-sdk',
  binary: { found: true, source: 'bundled' },
  loginCommand: 'squad auth login',
  loggedIn: true,
  probe: null,
  runtimeConflict: null,
};

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
  const runLegacy = createRoute({
    getParentRoute: () => root,
    path: '/runs/$runId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, runLegacy]),
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
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
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
        // Must match what `console/api/runs.ts` actually emits: a path relative to the workspace
        // root, not a bare file name. The bare form made this assertion pass while the real link
        // 404'd — see https://github.com/AzmSquad/Squad-Kit/issues/9.
        planFile: '.squad/plans/demo/01-story-x.md',
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

    await waitFor(() => expect(screen.getByTestId('generate-metrics-bar')).toHaveTextContent('68%'));
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
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
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
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
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

  it('shows the rate-limit panel and lets the user wait then rerun', async () => {
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
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
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
    const es = MockEventSource.instances[0]!;

    const t0 = 1_700_000_000_000;
    let clock = t0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    es.emit(
      'rate_limit',
      JSON.stringify({
        kind: 'rate_limit',
        runId: 'run-1',
        turn: 1,
        retryAfterSec: 3,
        waitSec: 3,
        capSec: 90,
        phase: 'aborted',
        provider: 'anthropic',
        rawBody: 'anthropic 429',
      }),
    );
    es.emit(
      'done',
      JSON.stringify({
        kind: 'done',
        runId: 'run-1',
        success: false,
        partial: true,
        planFile: null,
        stats: {
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRatio: 0,
          durationMs: 1,
        },
        durationMs: 1,
      }),
    );

    await waitFor(() => expect(screen.getByText(/anthropic rate limit hit/i)).toBeInTheDocument());
    const waitBtn = screen.getByRole('button', { name: 'Wait 3s' });
    expect(waitBtn).toBeDisabled();
    expect(screen.queryByText('Run failed')).not.toBeInTheDocument();

    try {
      clock = t0 + 5000;
      await act(async () => {
        await new Promise<void>((r) => setTimeout(r, 1200));
      });
    } finally {
      spy.mockRestore();
    }

    expect(screen.getByRole('button', { name: 'Rerun planner' })).toBeEnabled();
  });

  it('auto-retry path renders an info banner without action buttons', async () => {
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
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
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
    const es = MockEventSource.instances[0]!;

    es.emit(
      'rate_limit',
      JSON.stringify({
        kind: 'rate_limit',
        runId: 'run-1',
        turn: 1,
        retryAfterSec: 5,
        waitSec: 5,
        capSec: 90,
        phase: 'retrying',
        provider: 'anthropic',
        rawBody: '429',
      }),
    );

    await waitFor(() => expect(screen.getByText(/Auto-retrying in/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /rerun planner/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel$/ })).toBeNull();
  });
  it('renders the Subscription badge and usage-limit billing copy from an auth_info event', async () => {
    const stories: ApiStory[] = [
      { feature: 'demo', id: '01-x', intakePath: '/p', storyDir: '/s', planFile: null, titleHint: 't' },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return stories;
      if (path === '/api/config') return { planner: { enabled: true, provider: 'anthropic' }, version: 1 };
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth')
        return {
          ...API_KEY_AUTH,
          configuredMode: 'subscription',
          resolved: {
            mode: 'subscription',
            reason: 'explicit in .squad/config.yaml',
            credentialHint: 'Claude login (macOS Keychain)',
          },
          login: { present: true, hint: 'credential-store', detail: 'macOS Keychain' },
        } satisfies ApiPlannerAuth;
      throw new Error(`unexpected ${path}`);
    });

    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({ runId: 'run-sub' }) } as Response);

    renderPage();

    // Pre-run the badge comes from the config fallback…
    await waitFor(() => expect(screen.getByTestId('generate-auth-badge')).toHaveTextContent('Subscription'));
    expect(screen.getByText(/draw on your Claude usage limits/)).toBeInTheDocument();
    expect(screen.queryByText(/billed like any other API usage/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const es = MockEventSource.instances[0]!;

    // …and once the run reports its own credential, the run wins.
    es.emit(
      'auth_info',
      JSON.stringify({
        kind: 'auth_info',
        runId: 'run-sub',
        mode: 'subscription',
        reason: 'explicit-config',
        credentialHint: 'Claude login (macOS Keychain)',
        apiKeySource: 'oauth',
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('generate-auth-badge')).toHaveAttribute(
        'title',
        'Claude login (macOS Keychain) · apiKeySource: oauth',
      ),
    );
  });

  it('renders an actionable recovery callout when the run start returns auth_unavailable', async () => {
    const stories: ApiStory[] = [
      { feature: 'demo', id: '01-x', intakePath: '/p', storyDir: '/s', planFile: null, titleHint: 't' },
    ];
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/stories') return stories;
      if (path === '/api/config') return { planner: { enabled: true, provider: 'anthropic' }, version: 1 };
      if (path === '/api/runs/active') return [];
      if (path === '/api/runs') return [];
      if (path === '/api/planner-auth') return API_KEY_AUTH;
      throw new Error(`unexpected ${path}`);
    });

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'auth_unavailable',
        mode: 'subscription',
        detail:
          'No Anthropic credential available. Either log in with your Claude subscription (`squad auth login`) ' +
          'or save an API key (`squad config set planner`, or export ANTHROPIC_API_KEY).',
      }),
    } as Response);

    renderPage();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('No Claude credential available')).toBeInTheDocument());
    expect(screen.getByText(/No Anthropic credential available/)).toBeInTheDocument();
    expect(screen.getByText('squad auth login')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure auth' })).toHaveAttribute('href', '/config');
    // The generic string-only failure state must not fire for this code.
    expect(screen.queryByText('Run failed')).toBeNull();
  });
});
