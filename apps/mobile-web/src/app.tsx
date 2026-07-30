import type { JSX } from 'preact';
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
        <h1><img class="brand-mark" src="/m/clemmy.png" alt="" width="26" height="26" />Clementine</h1>
        <div class="meta">
          <span class="conn-pill" title="Connected directly to your Mac — end-to-end encrypted">Direct</span>
          <button
            class="icon-btn"
            aria-label="Sign out"
            onClick={async () => { await logout(); await refreshAuth(); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>
      <main class="app-main">
        <div class="screen-enter" key={tab}>
          <PushPrompt />
          {tab === 'inbox' ? <Inbox />
            : tab === 'chats' ? <Chats />
            : tab === 'workflows' ? <Workflows />
            : tab === 'memory' ? <Memory />
            : <Activity />}
        </div>
      </main>
      <nav class="section-tab-bar" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} class={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-label={t.label}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
    </>
  );
}

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const TABS: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
  {
    id: 'inbox',
    label: 'Inbox',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
  },
  {
    id: 'chats',
    label: 'Chats',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'workflows',
    label: 'Flows',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M12 3a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5 4 4 0 0 0 3 6.5h.5" /><path d="M12 3a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5 4 4 0 0 1-3 6.5h-.5" /><path d="M12 3v17" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
];
