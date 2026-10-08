import type { JSX, ComponentChildren } from 'preact';
import { Component } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  adoptOriginSession,
  finalizeOriginHandoff,
  activateOriginHandoff,
  api,
  getAuthStatus,
  getInboxSummary,
  INBOX_SUMMARY_PATH,
  isInvalidOriginHandoffError,
  logout,
  mintOriginHandoff,
  pairDevice,
  type AuthStatus,
} from './lib/api';
import {
  CONNECTION_EVENT,
  ORIGIN_HANDOFF_STORED_EVENT,
  connectionDoor,
  haptic,
  inNativeShell,
  parkOriginHandoff,
  reportOriginHandoffResult,
  type ConnectionDoor,
} from './lib/native-bridge';
import { originHandoffMintCoordinator } from './lib/origin-handoff-mint';
import { runOriginHandoffAdoption } from './lib/origin-handoff-adoption';
import { authBootstrapMode } from './lib/auth-bootstrap';
import {
  mobileWorkspacePath,
  workspaceColdOpenNeedsParent,
  workspaceFromSearch,
  workspaceNavigationIntent,
} from './lib/workspace-route';
import {
  agentFromSearch,
  destinationSearch,
  inboxNotificationFromSearch,
  projectFromSearch,
  runFromSearch,
  searchHasDestination,
  tabFromSearch,
  type TabId as Tab,
} from './lib/deep-link';
import { useHomePreferences } from './lib/home-prefs';
import { phoneHeaderChrome } from './lib/home-presentation';
import { appBadgeAuthAction, clearAppBadge, syncAppBadge } from './lib/app-badge';
import { lastGoodAt } from './lib/last-good';
import { needsYouChrome } from './lib/needs-you';
import { useWorkingNow } from './lib/working-now';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { Activity } from './screens/Activity';
import { Chats } from './screens/Chats';
import { Agents } from './screens/Agents';
import { Projects } from './screens/Projects';
import { Memory } from './screens/Memory';
import { Workflows } from './screens/Workflows';
import { Workspaces } from './screens/Workspaces';
import { Settings } from './screens/Settings';
import { describeThisDevice } from './lib/device-name';
import { Inbox } from './screens/Inbox';
import type { ChatHandoff } from './screens/Chats';
import { DrawerRecents } from './components/DrawerRecents';
import { greetingName } from './lib/greeting';
import { RunningTasksSheet } from './components/RunningTasksSheet';
import { AskCapsule } from './components/AskCapsule';
import { CustomizeSheet } from './components/CustomizeSheet';

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => tabFromSearch(window.location.search));
  const [inboxNotification, setInboxNotification] = useState<string | null>(
    () => inboxNotificationFromSearch(window.location.search),
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    () => workspaceFromSearch(window.location.search),
  );
  /** The run a URL addresses — a push, a reload, or a tap from any surface
   *  that shows running work. Activity owns the run view. */
  const [runId, setRunId] = useState<string | null>(() => runFromSearch(window.location.search));
  /** The project and the agent a URL addresses; each tab owns its own view. */
  const [projectId, setProjectId] = useState<string | null>(() => projectFromSearch(window.location.search));
  const [agentId, setAgentId] = useState<string | null>(() => agentFromSearch(window.location.search));
  // The header's "+" door asks the open list screen to start a new one.
  const [createRequest, setCreateRequest] = useState(0);
  // The title is the navigator: tapping it opens the switcher sheet. The
  // full section menu (the left drawer) stays behind "More".
  // A rightward swipe across the header opens the menu.
  const headerSwipe = useRef<{ x: number; y: number; horizontal: boolean | null }>({ x: 0, y: 0, horizontal: null });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Left drawer (owner directive 2026-08-25): sections live in a slide-in
  // menu, never a bottom dock — content gets the full height.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 'closing' keeps the drawer mounted through its exit animation — an
  // instant unmount is the one visible tell next to a native drawer.
  const [drawerClosing, setDrawerClosing] = useState(false);
  const drawerClosingRef = useRef(false);
  const drawerCloseTimer = useRef<number | null>(null);
  const titleBtnRef = useRef<HTMLButtonElement | null>(null);
  const routeTitleRef = useRef<HTMLHeadingElement | null>(null);
  const routeTitleMounted = useRef(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  // Swipe-to-close needs horizontal INTENT before it acts, so it can never
  // fight the drawer's own vertical scrolling.
  const swipe = useRef<{ x: number; y: number; horizontal: boolean | null }>({ x: 0, y: 0, horizontal: null });
  const [name, setName] = useState('');
  const [decisions, setDecisions] = useState(0);
  const [decisionsKnown, setDecisionsKnown] = useState(false);
  /** When this count was last CONFIRMED — a live read, or the stamp of the
   *  remembered copy that answered. The chrome discloses it. */
  const [decisionsAsOf, setDecisionsAsOf] = useState<string | null>(null);
  /** False the moment a poll fails or the worker answers off its shelf. */
  const [decisionsLive, setDecisionsLive] = useState(false);
  /** Set when Home hands a question to Chats — consumed once on arrival. */
  const [handoff, setHandoff] = useState<ChatHandoff | null>(null);
  /** The Chats LIST is a capsule surface; an open thread has its own composer. */
  const [chatsListVisible, setChatsListVisible] = useState(false);
  const [door, setDoor] = useState<ConnectionDoor>(connectionDoor() ?? 'direct');
  const authenticated = Boolean(authStatus?.authenticated);
  /** Reads the ONE Needs-you count again; set by the poll that owns it. */
  const recountNeedsYou = useRef<() => void>(() => undefined);

  // ONE record shapes the window (panes, switcher, landing, quick actions),
  // and ONE working-now poll feeds Home, the header chip, and the sheet.
  const { prefs, loaded: prefsLoaded } = useHomePreferences({ enabled: authenticated });
  useWorkingNow(authenticated);
  const bootHadDestination = useRef(searchHasDestination(window.location.search));
  const userNavigated = useRef(false);
  const landingApplied = useRef(false);

  useEffect(() => {
    const onDoor = (event: Event) => setDoor((event as CustomEvent<ConnectionDoor>).detail);
    window.addEventListener(CONNECTION_EVENT, onDoor);
    return () => window.removeEventListener(CONNECTION_EVENT, onDoor);
  }, []);

  useEffect(() => {
    const activate = (event: Event) => {
      const detail = (event as CustomEvent<{ handoffId?: string; generation?: number }>).detail;
      if (!detail?.handoffId || !Number.isSafeInteger(detail.generation) || Number(detail.generation) <= 0) return;
      // Best effort here is safe: older generations remain valid until this
      // exact activation lands, and native repeats the acknowledgement after
      // every successful page load.
      void activateOriginHandoff(detail.handoffId, Number(detail.generation)).catch(() => undefined);
    };
    window.addEventListener(ORIGIN_HANDOFF_STORED_EVENT, activate);
    return () => window.removeEventListener(ORIGIN_HANDOFF_STORED_EVENT, activate);
  }, []);

  // Drawer dialog contract: Escape closes, focus lands inside on open and is
  // trapped while open — same idiom as the RunningTasksSheet dialog.
  useEffect(() => {
    if (!drawerOpen) return;
    drawerRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  useEffect(() => () => {
    if (drawerCloseTimer.current !== null) window.clearTimeout(drawerCloseTimer.current);
  }, []);

  useEffect(() => {
    document.title = `${TAB_TITLES[tab]} · Clem`;
    if (!routeTitleMounted.current) {
      routeTitleMounted.current = true;
      return;
    }
    window.requestAnimationFrame(() => routeTitleRef.current?.focus());
  }, [tab]);

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
    // A pairing/adoption request replaces the session cookie and installs its
    // matching in-memory fingerprint. Do not race it with a status request
    // carrying the previous cookie: a late old response makes the next device
    // proof fail even though the credential ceremony itself succeeded.
    if (authBootstrapMode(window.location.search) === 'status') void refreshAuth();
    const handler = () => setAuthStatus((s) => s ? { ...s, authenticated: false } : s);
    window.addEventListener('clem:needs-login', handler);
    return () => window.removeEventListener('clem:needs-login', handler);
  }, [refreshAuth]);

  // A direct terminal handoff may cold-open a Workspace detail. Give that
  // real URL one list-level parent entry so native edge-back closes the detail
  // instead of leaving the app or reopening the same slug.
  useEffect(() => {
    const slug = workspaceFromSearch(window.location.search);
    if (!slug || !workspaceColdOpenNeedsParent(window.location.search, window.history.state)) return;
    window.history.replaceState(null, '', `${window.location.pathname}?tab=spaces`);
    window.history.pushState({ clemWorkspace: slug }, '', mobileWorkspacePath(slug));
  }, []);

  // Push/native navigation can replace the URL while this shell is alive.
  // Keep the visible destination and exact notification selection in sync.
  useEffect(() => {
    const syncLocation = () => {
      setTab(tabFromSearch(window.location.search));
      setInboxNotification(inboxNotificationFromSearch(window.location.search));
      setWorkspaceId(workspaceFromSearch(window.location.search));
      setRunId(runFromSearch(window.location.search));
      setProjectId(projectFromSearch(window.location.search));
      setAgentId(agentFromSearch(window.location.search));
    };
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, []);

  // A place Clem links in a reply opens inside the app: the URL changes and
  // the same sync above moves the shell, with no page load.
  useEffect(() => {
    const openPlace = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[data-app-place]');
      const href = link?.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      userNavigated.current = true;
      window.history.pushState(null, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    document.addEventListener('click', openPlace);
    return () => document.removeEventListener('click', openPlace);
  }, []);

  // Needs-you is shell state, not Home state. Polling here keeps the header
  // pill and the switcher truthful while the user is in Chat, Memory, or a
  // deep detail — ONE count from ONE source for every surface.
  useEffect(() => {
    if (!authenticated) {
      setDecisions(0);
      setDecisionsKnown(false);
      setDecisionsAsOf(null);
      setDecisionsLive(false);
      return;
    }
    let cancelled = false;
    const refreshCount = async () => {
      try {
        const summary = await getInboxSummary();
        if (cancelled) return;
        // A 200 off the worker's shelf is not an answer from the Mac. The
        // stamp is how old this number actually is; without it the chrome
        // would say "Needs you · 3" from a six-hour-old copy while the Inbox
        // underneath honestly said it could not reach anything.
        const stamp = lastGoodAt(INBOX_SUMMARY_PATH);
        setDecisions(summary.needsYou);
        setDecisionsKnown(true);
        setDecisionsAsOf(stamp ?? new Date().toISOString());
        setDecisionsLive(!stamp);
      } catch {
        // Each screen owns its visible error and the badge keeps its last
        // good value — but it stops claiming to be current.
        if (!cancelled) setDecisionsLive(false);
      }
    };
    void refreshCount();
    // A decision settled on another screen (a project, an agent) changes this
    // count now, not at the next tick.
    recountNeedsYou.current = () => { void refreshCount(); };
    const onWake = () => { if (document.visibilityState === 'visible') void refreshCount(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshCount(); }, 8_000);
    return () => {
      cancelled = true;
      recountNeedsYou.current = () => undefined;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [authenticated]);

  const setAuthoritativeDecisionCount = useCallback((count: number) => {
    setDecisions(count);
    setDecisionsKnown(true);
    // The Inbox's own sources are never served from the shelf, so a complete
    // count it publishes was read live. The 8-second poll above corrects this
    // the moment the daemon stops answering.
    setDecisionsAsOf(new Date().toISOString());
    setDecisionsLive(true);
  }, []);

  // The greeting name, resolved at runtime from the profile — never hardcoded,
  // and a miss simply means an unnamed greeting.
  useEffect(() => {
    if (!authenticated) return;
    void api<{ name?: string }>('/m/api/whoami')
      .then((who) => setName(who.name ?? ''))
      .catch(() => setName(''));
  }, [authenticated]);

  // ORIGIN ADOPTION — the credential handoff that makes off-LAN access work.
  //
  // A cookie and the device key belong to ONE origin. The phone establishes
  // them at home on the LAN origin; the relay door is a different origin and
  // starts with nothing, and pairing there is refused by design. So the shell
  // carries a LAN-minted handoff token across and hands it to this page as
  // `?adopt=`; spending it mints the same device's session at this origin.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (authBootstrapMode(window.location.search) !== 'adopt') return;
    const token = params.get('adopt');
    if (!token) return;
    const handoffId = params.get('handoffId') || undefined;
    const rawGeneration = Number(params.get('handoffGeneration'));
    const generation = Number.isSafeInteger(rawGeneration) && rawGeneration > 0
      ? rawGeneration
      : undefined;
    const hasCorrelation = Boolean(handoffId && generation);
    let cancelled = false;
    const cleanUrl = () => {
      const clean = `${window.location.pathname}${window.location.hash || ''}`;
      window.history.replaceState(null, '', clean || '/m/');
    };
    void (async () => {
      try {
        // The shell now appends ?adopt= on EVERY origin change (relay OR a
        // new LAN address). If this origin already holds a live session, the
        // leased token must not be adopted on nothing — the park effect
        // will re-mint moments after auth confirms.
        const outcome = await runOriginHandoffAdoption(
          {
            token,
            ...(hasCorrelation ? { handoffId, generation } : {}),
          },
          {
            alreadyAuthenticated: async () => {
              // getAuthStatus also installs the session fingerprint needed to
              // proof-sign the authenticated finalization request after a
              // cold JS reload. A raw fetch would observe the cookie but leave
              // the very next request unable to prove it owns that session.
              const already = await getAuthStatus().catch(() => null);
              return Boolean(already?.authenticated);
            },
            adopt: async (value) => { await adoptOriginSession(value); },
            finalize: async (id, version) => { await finalizeOriginHandoff(id, version); },
            isExplicitlyInvalid: isInvalidOriginHandoffError,
            report: (id, version, result) => {
              reportOriginHandoffResult(id, version, result);
            },
          },
        );
        if (outcome === 'already_authenticated') {
          if (cancelled) return;
          cleanUrl();
          await refreshAuth();
          return;
        }
        if (cancelled) return;
        cleanUrl();
        await refreshAuth();
      } catch (error) {
        // A spent or expired handoff is not an error the user can act on
        // remotely — fall through to the normal unauthenticated screen.
        if (cancelled) return;
        cleanUrl();
        await refreshAuth();
      }
    })();
    return () => { cancelled = true; };
  }, [refreshAuth]);

  // While authenticated on the LAN, keep a fresh handoff parked with the
  // shell, so leaving the house never finds an expired one.
  useEffect(() => {
    if (!authenticated) return;
    if (door === 'relay') return; // already remote — this origin can't mint
    if (!inNativeShell()) return; // browsers do not need a cross-origin shell credential
    let cancelled = false;
    const park = async (): Promise<void> => {
      try {
        await originHandoffMintCoordinator.ensure(
          mintOriginHandoff,
          (handoff) => !cancelled && parkOriginHandoff(handoff),
        );
      } catch { /* best effort — absence just means re-pair on the next LAN visit */ }
    };
    void park();
    // Refresh well inside the token's lifetime — and once more at the moment
    // the app backgrounds, which is the freshest the parked token can ever be
    // when the phone later wakes up off-LAN. iOS suspends this page on lock,
    // so the interval alone always left a stale token behind (live: "off
    // wifi has never worked" — the shell arrived at the relay holding a
    // token minted the previous morning).
    const parkOnHide = () => { if (document.visibilityState === 'hidden') void park(); };
    document.addEventListener('visibilitychange', parkOnHide);
    const timer = setInterval(() => { void park(); }, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', parkOnHide);
    };
  }, [authenticated, door]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (authBootstrapMode(window.location.search) !== 'pair') return;
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
        await pairDevice(token, describeThisDevice(navigator.userAgent, inNativeShell()));
        if (cancelled) return;
        cleanPairTokenFromUrl();
        await refreshAuth();
      } catch (err) {
        if (cancelled) return;
        const apiErr = err as { status?: number; body?: unknown; message?: string };
        const body = apiErr.body as { error?: string } | null;
        if (apiErr.status === 401 && body?.error === 'INVALID_PAIRING_CODE') {
          cleanPairTokenFromUrl();
          setPairError('That QR code expired or was already used. Open Mobile on the desktop app and scan a fresh QR.');
        } else {
          // A transport failure does not spend the one-time token. Keep it in
          // the URL so reloading can retry the same pairing attempt.
          setPairError(apiErr.message || 'QR pairing failed. Check the connection and try the same QR again.');
        }
        // Leave the bootstrap state even after a failed pair. Without this,
        // authStatus stayed null and the app rendered “Waking up…” forever.
        await refreshAuth();
      } finally {
        if (!cancelled) setPairing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshAuth]);

  const navigateTo = useCallback((
    next: Tab,
    target?: { notificationId?: string | null; runId?: string | null; projectId?: string | null; agentId?: string | null },
  ) => {
    userNavigated.current = true;
    setTab(next);
    setWorkspaceId(null);
    // A selection only survives onto the tab that can act on it; destinationSearch
    // owns that rule so the URL and this state cannot disagree.
    const selectedNotification = next === 'inbox' ? target?.notificationId ?? null : null;
    const selectedRun = next === 'activity' ? target?.runId ?? null : null;
    const selectedProject = next === 'projects' ? target?.projectId ?? null : null;
    const selectedAgent = next === 'agents' ? target?.agentId ?? null : null;
    setInboxNotification(selectedNotification);
    setRunId(selectedRun);
    setProjectId(selectedProject);
    setAgentId(selectedAgent);
    const search = destinationSearch({
      tab: next,
      notificationId: selectedNotification,
      runId: selectedRun,
      projectId: selectedProject,
      agentId: selectedAgent,
    });
    window.history.replaceState(null, '', `${window.location.pathname}${search}`);
  }, []);

  /** Work is a destination: every surface that shows a run hands it here. */
  const openRun = useCallback((sessionId: string) => {
    haptic('light');
    navigateTo('activity', { runId: sessionId });
  }, [navigateTo]);

  // The number on the icon is the ONE decision count, so the phone is useful
  // without being opened. An unknown count leaves the icon exactly as it is —
  // and so does an unknown SESSION. `authStatus` is null until /m/auth/status
  // answers, and clearing on that null wiped a real badge on every cold open
  // with the Mac asleep. Only a confirmed sign-out clears (see appBadgeAuthAction).
  useEffect(() => {
    const action = appBadgeAuthAction(authStatus);
    if (action === 'clear') { clearAppBadge(); return; }
    if (action === 'hold') return;
    syncAppBadge({ count: decisions, known: decisionsKnown });
  }, [authStatus, decisions, decisionsKnown]);

  // "Open on launch" — honored once, on a bare cold launch, after the record
  // has actually been read. A push, a pairing, or a tap the user already made
  // outranks it; a record that never loads falls back to Home.
  useEffect(() => {
    if (!authenticated || !prefsLoaded || landingApplied.current) return;
    landingApplied.current = true;
    if (bootHadDestination.current || userNavigated.current) return;
    if (prefs.landing === 'last_conversation') {
      setHandoff({ openLatest: true });
      navigateTo('chats');
    } else if (prefs.landing === 'current_project') {
      navigateTo('spaces');
    }
  }, [authenticated, prefsLoaded, prefs.landing, navigateTo]);

  if (bootError && !authStatus) {
    return (
      <div class="login-shell">
        <img class="login-mark" src="/m/clemmy.png" alt="" width="88" height="88" />
        <h1>Clementine</h1>
        {/* The raw failure ("HTTP 500", "Failed to fetch") is engine vocabulary. Say
            what it means for the person holding the phone; keep the raw as a detail. */}
        <p class="error">Can’t reach Clementine right now. Nothing was lost — she’s just not answering yet.</p>
        <p class="empty-body">{bootError}</p>
        {/* A dead-end boot screen forces a force-quit; a retry is a fetch. */}
        <button class="login-repair" onClick={() => void refreshAuth()}>Try again</button>
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
    return <Login pairError={pairError} />;
  }

  const selectWorkspace = (slug: string | null) => {
    const intent = workspaceNavigationIntent({
      search: window.location.search,
      historyState: window.history.state,
      next: slug,
    });
    if (intent.kind === 'none') return;
    if (intent.kind === 'push') {
      setWorkspaceId(slug);
      window.history.pushState(intent.state, '', intent.path);
    } else if (intent.kind === 'back') {
      window.history.back();
    } else {
      setWorkspaceId(null);
      window.history.replaceState(null, '', `${window.location.pathname}?tab=spaces`);
    }
  };

  const ownerInitial = greetingName(name).trim().charAt(0).toUpperCase();

  const goToChat = (payload: ChatHandoff) => {
    setHandoff(payload);
    navigateTo('chats');
  };

  const openWorkspace = (slug: string) => {
    navigateTo('spaces');
    selectWorkspace(slug);
  };

  const openDrawer = () => {
    if (drawerCloseTimer.current !== null) {
      window.clearTimeout(drawerCloseTimer.current);
      drawerCloseTimer.current = null;
    }
    drawerClosingRef.current = false;
    setDrawerClosing(false);
    setDrawerOpen(true);
  };

  const closeDrawer = (restoreOpener = true) => {
    if (drawerClosingRef.current) return;
    drawerClosingRef.current = true;
    // End the modal contract immediately. The exiting pixels stay mounted,
    // but are hidden from assistive tech and cannot keep focus trapped.
    if (restoreOpener) titleBtnRef.current?.focus();
    setDrawerOpen(false);
    setDrawerClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    drawerCloseTimer.current = window.setTimeout(() => {
      drawerCloseTimer.current = null;
      drawerClosingRef.current = false;
      setDrawerClosing(false);
    }, reduceMotion ? 0 : 250);
  };

  // ONE presenter for all three Needs-you surfaces (pill, switcher, drawer),
  // so none of them can claim to be current while the others disclose an age.
  const needsYou = needsYouChrome({
    count: decisions,
    known: decisionsKnown,
    asOf: decisionsAsOf,
    live: decisionsLive,
    nowMs: Date.now(),
  });

  // The header is identity, where you are, and connection state. Anything else
  // it carries is a shortcut to something the CURRENT screen cannot show — so
  // on Home, which now leads with the answer and lists the work below it, the
  // row is three items and the title finally has room. (Before: five controls
  // fought for it — mark, title, a "6·42" chip, a "Needs you · 86" pill and
  // the connection state — and the title was crushed to a sliver.)
  const headerChrome = phoneHeaderChrome({ tab, needsYouSignal: needsYou.show });

  // The capsule is the one persistent control — on Home, Needs you, and the
  // Chats list. An open thread has its own composer; other screens have
  // their own primary action.
  const capsuleShown = tab === 'home' || tab === 'inbox' || (tab === 'chats' && chatsListVisible);

  return (
    <>
      <header
        class="app-header"
        hidden={tab === 'chats' && !chatsListVisible}
        onTouchStart={(event) => {
          const t = event.touches[0];
          headerSwipe.current = { x: t.clientX, y: t.clientY, horizontal: null };
        }}
        onTouchMove={(event) => {
          const t = event.touches[0];
          const sw = headerSwipe.current;
          if (sw.horizontal === null) {
            const dx = Math.abs(t.clientX - sw.x);
            const dy = Math.abs(t.clientY - sw.y);
            if (dx > 12 || dy > 12) sw.horizontal = dx > dy;
          }
        }}
        onTouchEnd={(event) => {
          // A rightward swipe across the header opens the menu. The header
          // only: the screen's left edge stays the system back gesture.
          const sw = headerSwipe.current;
          if (sw.horizontal && event.changedTouches[0].clientX - sw.x > 48 && !drawerOpen) openDrawer();
        }}
      >
        {/* ONE menu (owner 08-25, 09-26): the Clemmy mark is its handle. */}
        <button
          ref={titleBtnRef}
          type="button"
          class="menu-mark"
          aria-label="Menu"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => { haptic('light'); openDrawer(); }}
        >
          <img class="brand-mark" src="/m/clemmy.png" alt="" width="28" height="28" />
        </button>
        <h1 ref={routeTitleRef} class="app-title" tabIndex={-1}>
          <span class="title-text">{TAB_TITLES[tab]}</span>
          {tab === 'inbox' && needsYou.show ? (
            <span class={`title-badge${needsYou.stale ? ' badge-stale' : ''}`} title={needsYou.badgeAriaLabel} aria-hidden="true">
              {needsYou.badgeText}
            </span>
          ) : null}
        </h1>
        <div class="meta">
          {/* Compact running-work chip — the sheet's trigger, which must not
              float at the bottom now that the dock is gone. Absent at zero
              (presenter contract: the pill disappears when total is 0), and
              absent on the screens that already list the work themselves. */}
          {headerChrome.workChip ? <RunningTasksSheet onOpenRun={openRun} compact={headerChrome.needsPill} /> : null}
          {/* The pill has no room for a banner, so it discloses the age in the
              space it has: "Needs you · 3 · 6h ago" when the number came off
              the worker's shelf or a poll stopped answering. It is the standing
              signal for screens that have no other way to show it — never on
              Home or Needs you, which say it in their own content. */}
          {headerChrome.needsPill ? (
            // Live, it is a round door with its count; stale, the words come
            // back so the age is still on screen.
            <button
              type="button"
              class={`needs-pill${needsYou.stale ? ' needs-pill-stale' : ' needs-pill-round'}`}
              aria-label={needsYou.pillAriaLabel}
              onClick={() => { haptic('light'); navigateTo('inbox'); }}
            >
              {needsYou.stale ? (
                <span class="needs-pill-face" aria-hidden="true">{needsYou.pillText}</span>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
                  <span class="needs-pill-face needs-pill-count" aria-hidden="true">{needsYou.badgeText}</span>
                </>
              )}
            </button>
          ) : null}
          {(tab === 'projects' && !projectId) || (tab === 'agents' && !agentId) ? (
            <button
              type="button"
              class="header-round"
              aria-label={tab === 'projects' ? 'New project' : 'New agent'}
              onClick={() => { haptic('light'); setCreateRequest((n) => n + 1); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          ) : null}
          {tab === 'chats' && chatsListVisible ? (
            <button
              type="button"
              class="header-round"
              aria-label="New chat"
              onClick={() => { haptic('light'); goToChat({}); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            </button>
          ) : null}
          {door === 'direct' ? (
            // Direct is the quiet default: one green dot. Remote and offline
            // keep their words because they change what the user can expect.
            <span
              class="conn-dot-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={`${DOOR_COPY.direct.label}. ${DOOR_COPY.direct.hint}`}
              title={DOOR_COPY.direct.hint}
            />
          ) : (
            <span
              class={`conn-pill conn-${door}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={`${DOOR_COPY[door].label}. ${DOOR_COPY[door].hint}`}
              title={DOOR_COPY[door].hint}
            >
              <span class="conn-dot" aria-hidden="true" />{DOOR_COPY[door].label}
            </span>
          )}
        </div>
      </header>

      <CustomizeSheet
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        sections={TABS.map((t) => ({ id: t.id, label: t.label }))}
      />

      {drawerOpen || drawerClosing ? (
        <div
          class={`drawer-layer${drawerClosing ? ' closing' : ''}`}
          role={drawerClosing ? undefined : 'dialog'}
          aria-modal={drawerClosing ? undefined : true}
          aria-hidden={drawerClosing ? true : undefined}
          inert={drawerClosing ? true : undefined}
          aria-label={drawerClosing ? undefined : 'Menu'}
        >
          <button class="drawer-scrim" type="button" tabIndex={drawerClosing ? -1 : 0} aria-label="Close menu" onClick={() => closeDrawer()} />
          <aside
            ref={drawerRef}
            class="drawer"
            onTouchStart={(event) => {
              const t = event.touches[0];
              swipe.current = { x: t.clientX, y: t.clientY, horizontal: null };
            }}
            onTouchMove={(event) => {
              const t = event.touches[0];
              const s = swipe.current;
              // Lock intent once, on the first decisive axis — after that a
              // vertical menu scroll can never morph into a close gesture.
              if (s.horizontal === null) {
                const dx = Math.abs(t.clientX - s.x);
                const dy = Math.abs(t.clientY - s.y);
                if (dx > 12 || dy > 12) s.horizontal = dx > dy;
              }
            }}
            onTouchEnd={(event) => {
              const s = swipe.current;
              // The drawer owns this gesture directly rather than minting a
              // browser-history entry. A history entry made tab selection
              // self-cancelling: navigateTo() replaced the drawer entry, then
              // closing it went back to the previous tab. Tabs are peers, so
              // opening or closing the menu must never change history.
              if (s.horizontal && event.changedTouches[0].clientX - s.x < -48) closeDrawer();
            }}
          >
            <div class="drawer-brand">
              <img class="brand-mark" src="/m/clemmy.png" alt="" width="32" height="32" />
              <span class="brand-name">Clementine</span>
              <button class="drawer-close" type="button" aria-label="Close menu" onClick={() => closeDrawer()}>×</button>
            </div>
            <nav class="drawer-nav" aria-label="Sections">
              {PRIMARY_TABS.map((id) => TABS.find((t) => t.id === id)!).map((t) => (
                <button
                  key={t.id}
                  class="drawer-item"
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => {
                    if (tab !== t.id) haptic('light');
                    navigateTo(t.id);
                    closeDrawer(false);
                  }}
                >
                  <span class="drawer-item-icon">{t.icon}</span>
                  <span class="drawer-item-label">{t.label}</span>
                  {t.id === 'inbox' && needsYou.show ? (
                    <span class={`drawer-badge${needsYou.stale ? ' badge-stale' : ''}`} title={needsYou.badgeAriaLabel}>
                      {needsYou.drawerBadgeText}
                    </span>
                  ) : null}
                </button>
              ))}
              <div class="drawer-quiet" aria-label="Also">
                {QUIET_TABS.map((id) => TABS.find((t) => t.id === id)!).map((t) => (
                  <button
                    key={t.id}
                    class="drawer-item drawer-item-quiet"
                    aria-current={tab === t.id ? 'page' : undefined}
                    onClick={() => {
                      if (tab !== t.id) haptic('light');
                      navigateTo(t.id);
                      closeDrawer(false);
                    }}
                  >
                    <span class="drawer-item-icon">{t.icon}</span>
                    <span class="drawer-item-label">{t.label}</span>
                  </button>
                ))}
              </div>
            </nav>
            <DrawerRecents
              open={drawerOpen && !drawerClosing}
              onOpen={(session) => { goToChat({ session, sessionId: session.id, title: session.title }); closeDrawer(false); }}
              onAll={() => { navigateTo('chats'); closeDrawer(false); }}
            />
            {/* Settings rides the bottom of the menu (owner IA): the pocket
                end of trust minted on the Mac — quiet, always reachable — as
                the owner's initial, beside the one way to start a new chat. */}
            <div class="drawer-foot">
              <button
                class="drawer-avatar"
                type="button"
                aria-label="Settings"
                aria-current={tab === 'settings' ? 'page' : undefined}
                onClick={() => {
                  if (tab !== 'settings') haptic('light');
                  navigateTo('settings');
                  closeDrawer(false);
                }}
              >
                {ownerInitial ? <span aria-hidden="true">{ownerInitial}</span> : (
                  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                )}
              </button>
              <button
                class="drawer-new-chat"
                type="button"
                onClick={() => { haptic('light'); goToChat({}); closeDrawer(false); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                New chat
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      <main class={`app-main${capsuleShown ? ' app-main-capsule' : ''}`} key={tab}>
        <ScreenBoundary tab={tab}>
          {tab === 'home' ? (
            <Home
              name={name}
              onOpenRun={openRun}
              onAsk={(draft, attachments) => goToChat({ draft, attachments, autoSend: true })}
              onOpenChat={(session) => goToChat({ session, sessionId: session.id, title: session.title })}
              onOpenThread={(sessionId, title) => goToChat({ sessionId, title })}
              onOpenInbox={() => navigateTo('inbox')}
              onOpenWorkspace={openWorkspace}
              onOpenActivity={() => navigateTo('activity')}
              onCustomize={() => setCustomizeOpen(true)}
              needsYouCount={decisions}
              needsYouCountKnown={decisionsKnown}
              // The pill is suppressed on Home (Home says the number itself),
              // so the age it used to carry travels with the number instead —
              // same ONE presenter, so chrome and Home can never disagree
              // about how old this count is.
              needsYouCountLive={!needsYou.stale}
              needsYouCountAge={needsYou.age}
            />
          ) : tab === 'inbox' ? (
            <Inbox
              initialNotificationId={inboxNotification}
              onCount={setAuthoritativeDecisionCount}
              onReply={(sessionId, draft) => goToChat({ sessionId: sessionId ?? undefined, draft })}
              onOpenSettings={() => navigateTo('settings')}
              onOpenWorkflows={() => navigateTo('workflows')}
              onOpenRun={openRun}
            />
          ) : tab === 'chats' ? (
            <Chats
              handoff={handoff}
              onHandoffConsumed={() => setHandoff(null)}
              onListVisibleChange={setChatsListVisible}
              onOpenRun={openRun}
              onOpenNeedsYou={() => navigateTo('inbox')}
            />
          ) : tab === 'projects' ? (
            <Projects
              initialProjectId={projectId}
              onProjectChange={(id) => navigateTo('projects', { projectId: id })}
              onOpenChat={goToChat}
              onOpenRun={openRun}
              onOpenAgent={(id) => navigateTo('agents', { agentId: id })}
              onOpenNeedsYou={() => navigateTo('inbox')}
              onDecided={() => recountNeedsYou.current()}
              createRequest={createRequest}
            />
          ) : tab === 'agents' ? (
            <Agents
              createRequest={createRequest}
              initialAgentId={agentId}
              onAgentChange={(id) => navigateTo('agents', { agentId: id })}
              onOpenProject={(id) => navigateTo('projects', { projectId: id })}
              onOpenRun={openRun}
              onOpenNeedsYou={() => navigateTo('inbox')}
              onMessage={(agent) => {
                // Messaging an agent opens a NEW conversation inside it: the
                // agent is the working context every turn there starts from.
                goToChat({ agentId: agent.id, agentName: agent.name });
              }}
            />
          ) : tab === 'workflows' ? <Workflows />
            : tab === 'spaces' ? (
              <Workspaces onOpenNeedsYou={() => navigateTo('inbox')} initialOpenId={workspaceId} onOpenChange={selectWorkspace} />
            )
            : tab === 'memory' ? <Memory />
            : tab === 'settings' ? (
              <Settings
                door={door}
                doorCopy={DOOR_COPY[door]}
                onSignOut={async () => {
                  // Sign-out is LOCAL and unconditional. Telling the daemon is
                  // a courtesy that fails offline, and letting that failure
                  // skip the rest left the remembered reads, the icon badge
                  // and the signed-in shell all alive after a tap that looked
                  // like it did nothing.
                  let told = true;
                  try {
                    await logout();
                  } catch {
                    told = false;
                  }
                  clearAppBadge();
                  setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
                  // Only re-ask the daemon when it actually heard us; offline,
                  // the local decision stands.
                  if (told) await refreshAuth();
                }}
                onCustomize={() => setCustomizeOpen(true)}
              />
            )
            : (
              <Activity
                initialRunId={runId}
                onRunChange={(sessionId) => navigateTo('activity', { runId: sessionId })}
              />
            )}
        </ScreenBoundary>
      </main>

      {capsuleShown ? <AskCapsule onAsk={(draft, attachments) => goToChat({ draft, attachments, autoSend: true })} /> : null}
    </>
  );
}

/**
 * One rendering bug on one screen must not blank the whole app — the header
 * and drawer stay, and the broken screen gets a recovery card. `key={tab}` on the
 * boundary resets the error state when the user switches tabs, so a crash on
 * Memory never follows them to Chats.
 */
class ScreenBoundary extends Component<{ tab: string; children: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidUpdate(previous: { tab: string }) {
    if (previous.tab !== this.props.tab && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">This screen hit a snag</p>
          <p class="empty-body">The rest of the app is fine — try again or switch tabs.</p>
          <button class="login-repair" onClick={() => this.setState({ failed: false })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The pill has to be honest: on the relay the traffic is still end-to-end
 * encrypted to this Mac, but it is no longer a direct local connection, and
 * claiming "Direct" from a hotel wifi would be a lie the user could catch.
 */
const DOOR_COPY: Record<ConnectionDoor, { label: string; hint: string }> = {
  direct: { label: 'Direct', hint: 'Connected straight to your computer on this network — end-to-end encrypted' },
  relay: { label: 'Remote', hint: 'Reaching your computer from away — still end-to-end encrypted, the relay only passes bytes' },
  offline: { label: 'Offline', hint: "Can't reach your computer right now" },
};

/** The places (owner 09-26, Projects added 09-29): everything else is reached from inside them or from the quiet rows. */
const PRIMARY_TABS: ReadonlyArray<Tab> = ['home', 'inbox', 'projects', 'spaces', 'workflows', 'agents', 'memory'];
// Conversations live in the menu's Recents, with the full list one tap away.
const QUIET_TABS: ReadonlyArray<Tab> = ['activity'];

const TAB_TITLES: Record<Tab, string> = {
  home: 'Today',
  inbox: 'Needs you',
  chats: 'Chats',
  projects: 'Projects',
  agents: 'Agents',
  spaces: 'Spaces',
  workflows: 'Flows',
  memory: 'Memory',
  activity: 'Activity',
  settings: 'Settings',
};

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

const TABS: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
  {
    id: 'home',
    label: 'Today',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    id: 'inbox',
    label: 'Needs you',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M4 5h16v14H4z" /><path d="M4 14h4l2 3h4l2-3h4" />
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
    id: 'projects',
    label: 'Projects',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: (
      <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
