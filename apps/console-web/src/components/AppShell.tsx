import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { VoiceOverlay } from './VoiceOverlay';
import { UpdaterBanner } from './UpdaterBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { LocalRecordingBanner } from './LocalRecordingBanner';
import { RunEnvironmentPanel } from './RunEnvironmentPanel';
import { ALL_NAV } from '@/lib/nav';
import { listRuns } from '@/lib/inbox';
import { usePoll } from '@/lib/poll';
import { isRunLive } from '@/lib/run-environment';

const RUN_ENVIRONMENT_PREF = 'clem.run-environment.open';

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
  const [runEnvironmentOpen, setRunEnvironmentOpen] = useState(() => {
    try { return localStorage.getItem(RUN_ENVIRONMENT_PREF) === '1'; } catch { return false; }
  });
  // The drawer is intentionally lazy. Tasks/Inbox already own ambient run
  // monitoring; a closed inspection panel must not add another permanent DB
  // poll on every desktop screen.
  const runs = usePoll(['run-environment-runs'], () => listRuns(12), 4000, { enabled: runEnvironmentOpen });
  const runRows = runs.data?.runs ?? [];
  const liveRunCount = runEnvironmentOpen ? runRows.filter((run) => isRunLive(run)).length : 0;

  const toggleRunEnvironment = () => {
    setRunEnvironmentOpen((current) => {
      const next = !current;
      try { localStorage.setItem(RUN_ENVIRONMENT_PREF, next ? '1' : '0'); } catch { /* preference only */ }
      return next;
    });
  };

  const closeRunEnvironment = () => {
    setRunEnvironmentOpen(false);
    try { localStorage.setItem(RUN_ENVIRONMENT_PREF, '0'); } catch { /* preference only */ }
  };

  // A 401 from the daemon dispatches a global `clem:needs-login` event
  // (see lib/api.ts). Nothing surfaced it before, so an expired session was a
  // silent dead-end. Catch it here and show a slim reconnect banner.
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const sync = () => { if (media.matches) setCollapsed(true); };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const onNeedsLogin = () => setNeedsLogin(true);
    window.addEventListener('clem:needs-login', onNeedsLogin);
    return () => window.removeEventListener('clem:needs-login', onNeedsLogin);
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
          runEnvironmentOpen={runEnvironmentOpen}
          liveRunCount={liveRunCount}
          onToggleRunEnvironment={toggleRunEnvironment}
        />
        <LocalRecordingBanner />
        {needsLogin && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-warning/40 bg-warning-tint/50 px-4 py-2 text-small text-fg"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0 flex-1">Session expired — reopen the console from the Clementine app.</span>
            <button
              type="button"
              onClick={() => setNeedsLogin(false)}
              aria-label="Dismiss"
              className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-subtle hover:text-fg"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <RunEnvironmentPanel
        open={runEnvironmentOpen}
        runs={runRows}
        runsLoading={runs.isLoading}
        runsError={runs.isError}
        onRetryRuns={() => { void runs.refetch(); }}
        onClose={closeRunEnvironment}
      />

      <CommandPalette />
      <VoiceOverlay />
      <UpdaterBanner />
    </div>
  );
}
