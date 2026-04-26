import { Outlet } from '@tanstack/react-router';
import { useGlobalShortcuts } from '~/hooks/useGlobalShortcuts';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function Layout() {
  useGlobalShortcuts();
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex">
        <Sidebar />
        <div className="flex min-h-screen flex-1 flex-col">
          <TopBar />
          <main className="flex-1">
            <div className="mx-auto w-full max-w-screen-2xl px-6 py-6 lg:px-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
