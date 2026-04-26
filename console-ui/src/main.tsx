import './styles/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { bootstrapToken } from './api/client';
import { CommandPalette } from './components/CommandPalette';
import { ConfirmProvider } from './components/Confirm';
import { ShortcutsCheatsheet } from './components/ShortcutsCheatsheet';
import { ToastProvider } from './components/Toast';
import { router } from './router';
import { SessionExpired } from './pages/SessionExpired';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

const token = bootstrapToken();
if (!token) {
  createRoot(el).render(
    <StrictMode>
      <SessionExpired />
    </StrictMode>,
  );
} else {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <CommandPalette />
            <ShortcutsCheatsheet />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
