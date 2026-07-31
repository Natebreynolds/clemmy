import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette } from './CommandPalette';
import { VoiceOverlay } from './VoiceOverlay';
import { UpdaterBanner } from './UpdaterBanner';
import { ErrorBoundary } from './ErrorBoundary';
import { LocalRecordingBanner } from './LocalRecordingBanner';
import { LiveAgentsPanel } from './LiveAgentsPanel';
import { ALL_NAV } from '@/lib/nav';
import { listBoard } from '@/lib/board';
import { usePoll } from '@/lib/poll';
import { liveAgentAutoOpen, liveAgentBadgeCount } from '@/lib/live-agents';

const LIVE_AGENTS_PREF = 'clem.live-agents.open';

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
  const [liveAgentsOpen, setLiveAgentsOpen] = useState(() => {
    try { return localStorage.getItem(LIVE_AGENTS_PREF) === '1'; } catch { return false; }
  });
  // One shared board poll powers the badge, the auto-pop, and the panel rows.
  // Faster while the panel is open; a slow heartbeat while closed so a freshly
  // kicked-off agent can still pop the panel and the badge stays honest.
  const board = usePoll(['board'], listBoard, liveAgentsOpen ? 4000 : 12_000);
  const boardCards = board.data?.cards ?? [];
  const liveRunCount = liveAgentBadgeCount(boardCards);

  // Auto-pop: open exactly when a NEW live row appears (Clem just kicked
  // something off or something started waiting on the user). Closing the
  // panel is respected until the next new row — the seen-set is the memory.
  const seenRef = useRef<string[]>([]);
  useEffect(() => {
    if (!board.data) return;
    const decision = liveAgentAutoOpen(seenRef.current, boardCards);
    seenRef.current = decision.seenIds;
    if (decision.open) setLiveAgentsOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.data]);

  const toggleLiveAgents = () => {
    setLiveAgentsOpen((current) => {
      const next = !current;
      try { localStorage.setItem(LIVE_AGENTS_PREF, next ? '1' : '0'); } catch { /* preference only */ }
      return next;
    });
  };

  const closeLiveAgents = () => {
    setLiveAgentsOpen(false);
    try { localStorage.setItem(LIVE_AGENTS_PREF, '0'); } catch { /* preference only */ }
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
          liveAgentsOpen={liveAgentsOpen}
          liveRunCount={liveRunCount}
          onToggleLiveAgents={toggleLiveAgents}
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

      <LiveAgentsPanel
        open={liveAgentsOpen}
        cards={boardCards}
        loading={board.isLoading}
        error={board.isError}
        onRetry={() => { void board.refetch(); }}
        onClose={closeLiveAgents}
      />

      <CommandPalette />
      <VoiceOverlay />
      <UpdaterBanner />
    </div>
  );
}
