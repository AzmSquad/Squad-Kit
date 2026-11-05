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
import './styles/onboard.css';
import './styles/narrow.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { bootstrapToken } from './api/client';
import { PrefsProvider, initialTheme } from './lib/prefs';
import { router } from './router';
import { ReportHost } from './components/Report';
import { AppDown } from './components/AppDown';
import { Boundary } from './components/Crash';
import { pruneDrafts } from './lib/drafts';
import { Cmd } from './components/ui';

// Set the theme before the first paint so the board never flashes the wrong colors.
document.documentElement.dataset.theme = initialTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 500, retry: 1, refetchOnWindowFocus: true } },
});

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

const token = bootstrapToken();
pruneDrafts();
createRoot(el).render(
  <StrictMode>
    {token ? (
      <QueryClientProvider client={queryClient}>
        <PrefsProvider>
          <AppDown />
          <Boundary>
            <RouterProvider router={router} />
          </Boundary>
          {/* The report window has its own net, so a problem in it never takes the page down. */}
          <Boundary fallback={null}>
            <ReportHost />
          </Boundary>
        </PrefsProvider>
      </QueryClientProvider>
    ) : (
      <PrefsProvider>
        <div className="center" style={{ height: '100%' }}>
          <div style={{ maxWidth: 460 }}>
            <h2>Open squad-kit once from a terminal</h2>
            <p>This browser has not opened squad-kit yet, so it does not have its private link. Run this in a terminal: it opens the board here, and after that new tabs and bookmarks work too.</p>
            <Cmd text="squad" />
          </div>
        </div>
      </PrefsProvider>
    )}
  </StrictMode>,
);
