import '@fontsource-variable/instrument-sans/standard.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/app.css';
import './styles/chat.css';
import './styles/support.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { bootstrapToken } from './api/client';
import { PrefsProvider, initialTheme } from './lib/prefs';
import { router } from './router';
import { ReportHost } from './components/Report';

// Set the theme before the first paint so the board never flashes the wrong colors.
document.documentElement.dataset.theme = initialTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 500, retry: 1, refetchOnWindowFocus: true } },
});

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

const token = bootstrapToken();
createRoot(el).render(
  <StrictMode>
    {token ? (
      <QueryClientProvider client={queryClient}>
        <PrefsProvider>
          <RouterProvider router={router} />
          <ReportHost />
        </PrefsProvider>
      </QueryClientProvider>
    ) : (
      <div className="center" style={{ height: '100%' }}>
        <div>
          <h2>Open the board from the terminal</h2>
          <p>
            This page needs the link that <span className="mono">squad console</span> or <span className="mono">squad demo</span> prints.
          </p>
        </div>
      </div>
    )}
  </StrictMode>,
);
