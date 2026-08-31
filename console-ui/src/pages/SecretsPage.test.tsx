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
import { SecretsPage } from './SecretsPage';
import { ToastProvider } from '~/components/Toast';
import type { ApiPlannerAuth } from '~/api/types';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('~/api/client', () => ({
  api: apiMock,
  UnauthorizedError: class E extends Error {
    name = 'UnauthorizedError';
  },
}));

const SECRETS = {
  planner: { anthropic: 'sk-a…wxyz', openai: null, google: null, anthropicOauthToken: null as string | null },
  tracker: {
    jira: { host: null, email: null, token: null },
    azure: { organization: null, project: null, pat: null },
    github: { host: null, pat: null },
    notion: { token: null },
  },
};

const SUBSCRIPTION_AUTH: ApiPlannerAuth = {
  provider: 'anthropic',
  configuredMode: 'subscription',
  resolved: {
    mode: 'subscription',
    reason: 'explicit in .squad/config.yaml',
    credentialHint: 'Claude login (macOS Keychain)',
  },
  error: null,
  login: { present: true, hint: 'credential-store', detail: 'macOS Keychain' },
  account: { email: 'dev@example.com', organization: 'Acme', subscriptionType: 'max' },
  apiKeySource: 'oauth',
  runtime: 'agent-sdk',
  binary: { found: true, source: 'bundled' },
  loginCommand: 'squad auth login',
  loggedIn: true,
  probe: { ran: true, ok: true },
  runtimeConflict: null,
};

function mockApi(auth: ApiPlannerAuth, secrets: unknown = SECRETS) {
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/api/secrets') return secrets;
    if (path === '/api/planner-auth') return auth;
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  const root = createRootRoute();
  const secretsRoute = createRoute({ getParentRoute: () => root, path: '/secrets', component: SecretsPage });
  const configRoute = createRoute({ getParentRoute: () => root, path: '/config', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([secretsRoute, configRoute]),
    history: createMemoryHistory({ initialEntries: ['/secrets'] }),
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

describe('SecretsPage Claude account card', () => {
  beforeEach(() => {
    sessionStorage.setItem('squad.console.token', 'a'.repeat(64));
    apiMock.mockReset();
  });

  it('renders the account line and a removable stored token when signed in', async () => {
    mockApi(SUBSCRIPTION_AUTH, {
      ...SECRETS,
      planner: { ...SECRETS.planner, anthropicOauthToken: 'sk-a…9876' },
    });
    renderPage();

    expect(await screen.findByText('Claude account')).toBeInTheDocument();
    expect(screen.getByText('dev@example.com · Acme · max')).toBeInTheDocument();
    expect(screen.getByText('apiKeySource: oauth')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();

    expect(screen.getByText('Stored token')).toBeInTheDocument();
    expect(screen.getByText('sk-a…9876')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/api/secrets',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ planner: { anthropicOauthToken: '' } }),
        }),
      ),
    );
  });

  it('offers a copyable command and never a login button when signed out', async () => {
    mockApi({
      ...SUBSCRIPTION_AUTH,
      login: { present: false, hint: 'none', detail: 'no Claude login detected' },
      account: null,
      apiKeySource: null,
      loggedIn: false,
      probe: null,
    });
    renderPage();

    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByText('squad auth login')).toBeInTheDocument();
    // The console guides the login; it must never appear to perform it.
    expect(screen.queryByRole('button', { name: /sign in|log in|login/i })).toBeNull();
  });

  it('collapses to one line and points at Config when the resolved mode is api-key', async () => {
    mockApi({
      ...SUBSCRIPTION_AUTH,
      configuredMode: 'api-key',
      resolved: { mode: 'api-key', reason: 'explicit in .squad/config.yaml', credentialHint: 'ANTHROPIC_API_KEY' },
      account: null,
      apiKeySource: null,
      probe: null,
    });
    renderPage();

    expect(await screen.findByText(/Using an Anthropic API key/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Config' })).toHaveAttribute('href', '/config');
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.queryByText('Stored token')).toBeNull();
    // The key row itself stays available in every mode.
    expect(screen.getByText('Anthropic API key')).toBeInTheDocument();
  });

  it('keeps the signed-in state when a probe fails instead of claiming the user is signed out', async () => {
    mockApi({
      ...SUBSCRIPTION_AUTH,
      account: null,
      apiKeySource: null,
      loggedIn: false,
      probe: { ran: true, ok: false, kind: 'timeout', detail: 'did not answer in time' },
    });
    renderPage();

    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('Could not verify (timed out)')).toBeInTheDocument();
    expect(screen.queryByText('Not signed in')).toBeNull();
  });
});
