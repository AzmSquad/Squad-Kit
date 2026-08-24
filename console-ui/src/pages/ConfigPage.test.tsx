import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigPage } from './ConfigPage';
import { ToastProvider } from '~/components/Toast';
import type { ApiPlannerAuth } from '~/api/types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

const BASE_CONFIG = {
  version: 1,
  project: { name: 'demo', primaryLanguage: 'ts', projectRoots: ['.'] },
  tracker: { type: 'none' },
  naming: { includeTrackerId: false, globalSequence: true },
  agents: [],
  planner: {
    enabled: true,
    provider: 'anthropic',
    auth: { anthropic: 'auto' },
    budget: { maxFileReads: 25, maxContextBytes: 50_000, maxDurationSeconds: 180 },
  },
};

const BASE_AUTH: ApiPlannerAuth = {
  provider: 'anthropic',
  configuredMode: 'auto',
  resolved: { mode: 'api-key', reason: 'auto — no Claude login', credentialHint: 'ANTHROPIC_API_KEY' },
  error: null,
  login: { present: true, hint: 'credential-store', detail: 'macOS Keychain' },
  account: null,
  apiKeySource: null,
  runtime: 'agent-sdk',
  binary: { found: true, source: 'bundled' },
  loginCommand: 'squad auth login',
  loggedIn: true,
  probe: null,
  runtimeConflict: null,
};

function mockApi(config: unknown, auth: ApiPlannerAuth) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/config') return config;
    if (path === '/api/planner-auth') return auth;
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfigPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ConfigPage planner auth control', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'a'.repeat(64));
    apiMock.mockReset();
  });

  it('renders the auth control for Anthropic and hides it entirely for other providers', async () => {
    mockApi(BASE_CONFIG, BASE_AUTH);
    const view = renderPage();

    const select = (await screen.findByLabelText('Authentication')) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(screen.getByText(/Prefers your Claude login when signed in/)).toBeInTheDocument();

    view.unmount();
    apiMock.mockReset();
    mockApi(
      { ...BASE_CONFIG, planner: { ...BASE_CONFIG.planner, provider: 'openai' } },
      { ...BASE_AUTH, provider: 'openai' },
    );
    renderPage();

    await waitFor(() => expect(screen.getByLabelText('Provider')).toBeInTheDocument());
    // Hidden, not disabled: `planner.auth` simply does not apply to OpenAI or Google.
    expect(screen.queryByLabelText('Authentication')).toBeNull();
  });

  it('warns with the login command when subscription is picked and no login is detected', async () => {
    mockApi(BASE_CONFIG, { ...BASE_AUTH, login: { present: false, hint: 'none', detail: 'no Claude login detected' } });
    renderPage();

    const select = (await screen.findByLabelText('Authentication')) as HTMLSelectElement;
    expect(screen.queryByText('No Claude login detected')).toBeNull();

    fireEvent.change(select, { target: { value: 'subscription' } });

    await waitFor(() => expect(screen.getByText('No Claude login detected')).toBeInTheDocument());
    expect(screen.getByText('squad auth login')).toBeInTheDocument();
    expect(screen.getByText(/Runs on your Claude plan\. No API key needed\./)).toBeInTheDocument();
    // A warning, not a block: the CLI lets the same combination be saved.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('blocks Save when subscription auth is picked on the vercel runtime', async () => {
    const conflict =
      'Subscription auth needs the Claude Agent SDK runtime. Remove `planner.runtime.anthropic: vercel` from ' +
      '.squad/config.yaml (the default is agent-sdk), or set `planner.auth.anthropic: api-key` and provide an ' +
      'ANTHROPIC_API_KEY.';
    mockApi(
      { ...BASE_CONFIG, planner: { ...BASE_CONFIG.planner, auth: { anthropic: 'subscription' } } },
      { ...BASE_AUTH, configuredMode: 'subscription', runtime: 'vercel', runtimeConflict: conflict },
    );
    renderPage();

    await waitFor(() => expect(screen.getByText(conflict)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    // Switching back to a mode the runtime can carry releases the block.
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'api-key' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
  });
});
