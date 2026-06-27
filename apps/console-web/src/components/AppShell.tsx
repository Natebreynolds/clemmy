import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { VoiceOverlay } from './VoiceOverlay';
import { UpdaterBanner } from './UpdaterBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { ALL_NAV } from '@/lib/nav';

function titleForPath(pathname: string): string {
  // Longest matching prefix wins (so /advanced/usage beats /advanced).
  const match = [...ALL_NAV]
    .sort((a, b) => b.path.length - a.path.length)
    .find((d) => pathname === d.path || pathname.startsWith(d.path + '/'));
  return match?.label ?? 'Clementine';
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 720px)').matches : false
  ));
  const location = useLocation();
  const title = titleForPath(location.pathname);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const sync = () => { if (media.matches) setCollapsed(true); };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-lg"
      >
        Skip to content
      </a>

      <Sidebar collapsed={collapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          sidebarCollapsed={collapsed}
          onToggleSidebar={() => setCollapsed((v) => !v)}
        />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette />
      <VoiceOverlay />
      <UpdaterBanner />
    </div>
  );
}
