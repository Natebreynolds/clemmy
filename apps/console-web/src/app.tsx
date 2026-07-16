import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Chat } from './screens/Chat';
import { ChatScreen } from './features/conversations/ChatScreen';
import { ConversationThread } from './features/conversations/chat/ConversationThread';

/** Route-level splitting keeps the everyday Chat boot path lean while retaining
 * every screen. Named exports are adapted to React.lazy's default-export shape;
 * Vite then emits one cached chunk per destination and loads it only on visit. */
function lazyNamed<T extends Record<K, ComponentType>, K extends keyof T>(
  loader: () => Promise<T>,
  exportName: K,
) {
  return lazy(async () => ({ default: (await loader())[exportName] }));
}

const Inbox = lazyNamed(() => import('./screens/Inbox'), 'Inbox');
const BackgroundTasks = lazyNamed(() => import('./screens/BackgroundTasks'), 'BackgroundTasks');
const Goals = lazyNamed(() => import('./screens/Goals'), 'Goals');
const Automate = lazyNamed(() => import('./screens/Automate'), 'Automate');
const Connect = lazyNamed(() => import('./screens/Connect'), 'Connect');
const Memory = lazyNamed(() => import('./screens/Memory'), 'Memory');
const Meetings = lazyNamed(() => import('./screens/Meetings'), 'Meetings');
const Workspaces = lazyNamed(() => import('./screens/Workspaces'), 'Workspaces');
const WorkspaceView = lazyNamed(() => import('./screens/WorkspaceView'), 'WorkspaceView');
const Agents = lazyNamed(() => import('./screens/Agents'), 'Agents');
const Advanced = lazyNamed(() => import('./screens/Advanced'), 'Advanced');
const Settings = lazyNamed(() => import('./screens/Settings'), 'Settings');
const Help = lazyNamed(() => import('./screens/Help'), 'Help');

const CHUNK_RELOAD_LATCH = 'clem-chunk-reload-at';

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch dynamically imported module|importing a module script failed|chunkloaderror|error loading dynamically imported module/i.test(message);
}

/** React.lazy rejections are NOT caught by Suspense. A window that survived an
 * auto-update requests old hashed chunk names that no longer exist on disk —
 * without this boundary that's an uncaught rejection and a blank content
 * region. One forced reload picks up the new asset manifest; the timestamp
 * latch stops a reload loop when the failure is something other than
 * staleness. */
class DeferredScreenBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Same instance is reused across routes (identical position in the tree),
    // so without this reset one broken screen would poison every deferred
    // route until a manual reload. Mirrors ErrorBoundary's resetKey contract.
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error)) return;
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_LATCH) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(CHUNK_RELOAD_LATCH, String(Date.now()));
    window.location.reload();
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-body text-fg-muted">
          <span>This screen failed to load — the app may have just updated.</span>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-fg hover:bg-bg-subtle"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function DeferredScreen({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <DeferredScreenBoundary resetKey={location.pathname}>
      <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-body text-fg-muted">Loading…</div>}>
        {children}
      </Suspense>
    </DeferredScreenBoundary>
  );
}

const deferred = (screen: ReactNode) => <DeferredScreen>{screen}</DeferredScreen>;

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/console">
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/chat" replace />} />

            <Route path="/chat" element={<ChatScreen />}>
              <Route index element={<Chat />} />
              <Route path=":sessionId" element={<ConversationThread />} />
            </Route>
            <Route path="/inbox" element={deferred(<Inbox />)} />
            <Route path="/tasks" element={deferred(<BackgroundTasks />)} />
            <Route path="/goals" element={deferred(<Goals />)} />
            <Route path="/automate" element={deferred(<Automate />)} />
            <Route path="/connect" element={deferred(<Connect />)} />
            <Route path="/memory" element={deferred(<Memory />)} />
            <Route path="/meetings" element={deferred(<Meetings />)} />
            <Route path="/workspaces" element={deferred(<Workspaces />)} />
            <Route path="/workspaces/:id" element={deferred(<WorkspaceView />)} />
            <Route path="/agents" element={deferred(<Agents />)} />

            <Route path="/advanced" element={<Navigate to="/advanced/usage" replace />} />
            <Route path="/advanced/usage" element={deferred(<Advanced />)} />
            <Route path="/advanced/tools" element={deferred(<Advanced />)} />
            <Route path="/advanced/diagnostics" element={deferred(<Advanced />)} />
            <Route path="/advanced/observability" element={deferred(<Advanced />)} />
            <Route path="/advanced/traces" element={deferred(<Advanced />)} />
            <Route path="/advanced/budgets" element={deferred(<Advanced />)} />
            <Route path="/advanced/autonomy" element={deferred(<Advanced />)} />
            <Route path="/advanced/evolution" element={deferred(<Advanced />)} />
            <Route path="/advanced/developer" element={deferred(<Advanced />)} />

            <Route path="/settings" element={deferred(<Settings />)} />
            <Route path="/help" element={deferred(<Help />)} />

            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
