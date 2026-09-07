import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Sidebar, readSidebarCollapsed, writeSidebarCollapsed } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { CustomizePanel } from './home/CustomizePanel';
import { VoiceOverlay } from './VoiceOverlay';
import { UpdaterBanner } from './UpdaterBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { LocalRecordingBanner } from './LocalRecordingBanner';
import { ALL_NAV, DEVELOPER_NAV } from '@/lib/nav';
import { usePoll } from '@/lib/poll';
import { apiGet } from '@/lib/api';
import type { CommandCenter } from '@/lib/types';
import { listWorkingNowSnapshot } from '@/lib/activity';
import { presentWorkingNow } from '@/lib/activity-presentation';
import { pollIntervalForStream, useConsoleActionStream } from '@/lib/action-stream';

const NARROW_QUERY = '(max-width: 720px)';

function titleForPath(pathname: string): string {
  // Longest matching prefix wins (so /advanced/usage beats /advanced).
  const match = [...ALL_NAV, DEVELOPER_NAV]
    .sort((a, b) => b.path.length - a.path.length)
    .find((d) => pathname === d.path || pathname.startsWith(d.path + '/'));
  return match?.label ?? 'Clementine';
}

export function AppShell() {
  // A narrow window always starts collapsed; otherwise the user's last
  // choice (localStorage, best-effort) wins.
  const [collapsed, setCollapsed] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches
      ? true
      : readSidebarCollapsed()
  ));
  const toggleSidebar = () => {
    setCollapsed((v) => {
      writeSidebarCollapsed(!v);
      return !v;
    });
  };
  const location = useLocation();
  const title = titleForPath(location.pathname);

  const navigate = useNavigate();
  // ONE push subscription for the whole app, mounted here because the shell is
  // the only component that outlives every route. It invalidates the queries
  // below the moment the daemon acts, so the badge stops lagging reality by a
  // poll interval. The polls stay armed as the degraded path — a stream that
  // never connects leaves the console behaving exactly as it did before.
  const stream = useConsoleActionStream();
  // ONE working-now source for the whole app: the server projection, rendered
  // through the ONE shared presenter (presentWorkingNow) that the drawer,
  // /tasks, and mobile also render from — never a private count of the raw
  // entries. The conversation the user is currently watching is omitted in
  // the presenter call: its bubble already narrates itself.
  const workingNow = usePoll(['working-now-badge'], listWorkingNowSnapshot, pollIntervalForStream(stream, 12_000));
  // ONE needs-you number for every badge: the command center's decision-shaped
  // list (the same query Home and Chat render), never the presenter's broader
  // 'needs attention' bucket — two denominators on one screen was the clutter.
  const commandCenter = usePoll(
    ['command-center'],
    () => apiGet<CommandCenter>('/api/console/home/command-center'),
    pollIntervalForStream(stream, 6_000),
  );
  const needsYouCount = commandCenter.data?.needsYou?.length ?? 0;
  const currentChatMatch = /^\/chat\/([^/]+)/.exec(location.pathname);
  const currentChatSession = currentChatMatch ? decodeURIComponent(currentChatMatch[1]) : null;
  const workingView = presentWorkingNow(
    workingNow.data?.entries ?? [],
    workingNow.data?.observedAt ?? '',
    { omitSessionId: currentChatSession },
  );

  // A 401 from the daemon dispatches a global `clem:needs-login` event
  // (see lib/api.ts). Nothing surfaced it before, so an expired session was a
  // silent dead-end. Catch it here and show a slim reconnect banner.
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    // Forced by the viewport, not chosen — so it is not persisted.
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
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-popover"
      >
        Skip to content
      </a>

      <Sidebar
        collapsed={collapsed}
        needsYouCount={needsYouCount}
        runningCount={workingView.running}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          sidebarCollapsed={collapsed}
          onToggleSidebar={toggleSidebar}
          runningCount={workingView.running}
          needsYouCount={needsYouCount}
          onOpenTasks={() => navigate('/tasks')}
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

      <CommandPalette />
      <CustomizePanel />
      <VoiceOverlay />
      <UpdaterBanner />
    </div>
  );
}
