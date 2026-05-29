import { useCallback, useEffect, useState } from 'preact/hooks';
import { getAuthStatus, logout, pairDevice, type AuthStatus } from './lib/api';
import { Login } from './screens/Login';
import { Inbox } from './screens/Inbox';
import { Activity } from './screens/Activity';
import { Chats } from './screens/Chats';
import { Memory } from './screens/Memory';
import { Workflows } from './screens/Workflows';
import { PushPrompt } from './components/PushPrompt';

type Tab = 'inbox' | 'chats' | 'workflows' | 'memory' | 'activity';

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');

  const refreshAuth = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      setAuthStatus(status);
      setBootError(null);
    } catch (err) {
      setBootError((err as Error).message ?? 'Failed to reach daemon');
    }
  }, []);

  useEffect(() => {
    refreshAuth();
    const handler = () => setAuthStatus((s) => s ? { ...s, authenticated: false } : s);
    window.addEventListener('clem:needs-login', handler);
    return () => window.removeEventListener('clem:needs-login', handler);
  }, [refreshAuth]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('pair');
    if (!token) return;
    let cancelled = false;
    setPairing(true);
    setPairError(null);
    const cleanPairTokenFromUrl = () => {
      const clean = `${window.location.pathname}${window.location.hash || ''}`;
      window.history.replaceState(null, '', clean || '/m/');
    };
    void (async () => {
      try {
        await pairDevice(token, navigator.userAgent.slice(0, 80));
        if (cancelled) return;
        cleanPairTokenFromUrl();
        await refreshAuth();
      } catch (err) {
        if (cancelled) return;
        cleanPairTokenFromUrl();
        const apiErr = err as { status?: number; body?: unknown; message?: string };
        const body = apiErr.body as { error?: string } | null;
        if (apiErr.status === 401 && body?.error === 'INVALID_PAIRING_CODE') {
          setPairError('That QR code expired or was already used. Open Mobile on the desktop app and scan a fresh QR.');
        } else {
          setPairError(apiErr.message || 'QR pairing failed. Try a fresh QR code or use your PIN.');
        }
      } finally {
        if (!cancelled) setPairing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshAuth]);

  if (bootError && !authStatus) {
    return (
      <div class="login-shell">
        <h1>Clementine</h1>
        <p class="error">{bootError}</p>
      </div>
    );
  }

  if (!authStatus) {
    return <div class="login-shell"><p>Loading…</p></div>;
  }

  if (pairing) {
    return (
      <div class="login-shell">
        <h1>Clementine</h1>
        <p>Pairing this device…</p>
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return <Login pinConfigured={authStatus.pinConfigured} pairError={pairError} onAuthenticated={refreshAuth} />;
  }

  return (
    <>
      <header class="app-header">
        <h1>Clementine</h1>
        <div class="meta">
          <button
            class="btn btn-ghost"
            style="padding: 4px 10px; font-size: 10px; max-width: none; width: auto;"
            onClick={async () => { await logout(); await refreshAuth(); }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main class="app-main">
        <PushPrompt />
        {tab === 'inbox' ? <Inbox />
          : tab === 'chats' ? <Chats />
          : tab === 'workflows' ? <Workflows />
          : tab === 'memory' ? <Memory />
          : <Activity />}
      </main>
      <nav class="section-tab-bar">
        <button class={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>Inbox</button>
        <button class={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>Chats</button>
        <button class={tab === 'workflows' ? 'active' : ''} onClick={() => setTab('workflows')}>Flows</button>
        <button class={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>Memory</button>
        <button class={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
      </nav>
    </>
  );
}
