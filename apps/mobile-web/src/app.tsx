import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, getAuthStatus, logout, pairDevice, type AuthStatus, type ChatSession } from './lib/api';
import { CONNECTION_EVENT, connectionDoor, haptic, type ConnectionDoor } from './lib/native-bridge';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { Activity } from './screens/Activity';
import { Chats } from './screens/Chats';
import { Memory } from './screens/Memory';
import { Workflows } from './screens/Workflows';
import { Workspaces } from './screens/Workspaces';

type Tab = 'home' | 'chats' | 'spaces' | 'workflows' | 'memory' | 'activity';

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [name, setName] = useState('');
  const [decisions, setDecisions] = useState(0);
  /** Set when Home hands a question to Chats — consumed once on arrival. */
  const [handoff, setHandoff] = useState<{ draft?: string; session?: ChatSession } | null>(null);
  const [door, setDoor] = useState<ConnectionDoor>(connectionDoor() ?? 'direct');

  useEffect(() => {
    const onDoor = (event: Event) => setDoor((event as CustomEvent<ConnectionDoor>).detail);
    window.addEventListener(CONNECTION_EVENT, onDoor);
    return () => window.removeEventListener(CONNECTION_EVENT, onDoor);
  }, []);

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

  // The greeting name, resolved at runtime from the profile — never hardcoded,
  // and a miss simply means an unnamed greeting.
  useEffect(() => {
    if (!authStatus?.authenticated) return;
    void api<{ name?: string }>('/m/api/whoami')
      .then((who) => setName(who.name ?? ''))
      .catch(() => setName(''));
  }, [authStatus?.authenticated]);

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
        <img class="login-mark" src="/m/clemmy.png" alt="" width="88" height="88" />
        <h1>Clementine</h1>
        <p class="error">{bootError}</p>
      </div>
    );
  }

  if (!authStatus || pairing) {
    return (
      <div class="login-shell">
        <img class="login-mark breathe" src="/m/clemmy.png" alt="" width="88" height="88" />
        <h1>Clementine</h1>
        <p class="muted">{pairing ? 'Pairing this device…' : 'Waking up…'}</p>
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return <Login pinConfigured={authStatus.pinConfigured} pairError={pairError} onAuthenticated={refreshAuth} />;
  }

  const goToChat = (payload: { draft?: string; session?: ChatSession }) => {
    setHandoff(payload);
    setTab('chats');
  };

  return (
    <>
      <header class="app-header">
        <div class="brand">
          <img class="brand-mark" src="/m/clemmy.png" alt="" width="28" height="28" />
          <span class="brand-name">{TAB_TITLES[tab]}</span>
        </div>
        <div class="meta">
          <span class={`conn-pill conn-${door}`} title={DOOR_COPY[door].hint}>
            <span class="conn-dot" aria-hidden="true" />{DOOR_COPY[door].label}
          </span>
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

      <main class="app-main" key={tab}>
        {tab === 'home' ? (
          <Home
            name={name}
            onAsk={(draft) => goToChat({ draft })}
            onOpenChat={(session) => goToChat({ session })}
            onDecisionCount={setDecisions}
          />
        ) : tab === 'chats' ? (
          <Chats handoff={handoff} onHandoffConsumed={() => setHandoff(null)} />
        ) : tab === 'workflows' ? <Workflows />
          : tab === 'spaces' ? <Workspaces />
          : tab === 'memory' ? <Memory />
          : <Activity />}
      </main>

      <nav class="dock" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={tab === t.id ? 'active' : ''}
            onClick={() => { if (tab !== t.id) haptic('light'); setTab(t.id); }}
            aria-label={t.label}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            <span class="dock-icon">
              {t.icon}
              {t.id === 'home' && decisions > 0 ? <span class="dock-badge">{decisions > 9 ? '9+' : decisions}</span> : null}
            </span>
            <span class="dock-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

/**
 * The pill has to be honest: on the relay the traffic is still end-to-end
 * encrypted to this Mac, but it is no longer a direct local connection, and
 * claiming "Direct" from a hotel wifi would be a lie the user could catch.
 */
const DOOR_COPY: Record<ConnectionDoor, { label: string; hint: string }> = {
  direct: { label: 'Direct', hint: 'Connected straight to your Mac on this network — end-to-end encrypted' },
  relay: { label: 'Remote', hint: 'Reaching your Mac from away — still end-to-end encrypted, the relay only passes bytes' },
  offline: { label: 'Offline', hint: "Can't reach your Mac right now" },
};

const TAB_TITLES: Record<Tab, string> = {
  home: 'Clementine',
  chats: 'Chats',
  spaces: 'Workspaces',
  workflows: 'Flows',
  memory: 'Memory',
  activity: 'Activity',
};

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const TABS: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
  {
    id: 'home',
    label: 'Home',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 21V12h6v9" />
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
    id: 'spaces',
    label: 'Spaces',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
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
