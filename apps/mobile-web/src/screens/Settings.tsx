import { BrowserbaseConnection } from '../components/BrowserbaseConnection';
import { useEffect, useState } from 'preact/hooks';
import { Fragment } from 'preact';
import { accountStatus, creditRefusalSentence, presentUsageMeters } from '@clem/chat-engine';
import {
  forgetLearnedWriteKind,
  getApprovalMode,
  getCompletionReview,
  getConnectionsHealth,
  getDaemonStatus,
  getModelSettings,
  setCompletionReview,
  getUsageStatus,
  listDevices,
  listHeartbeats,
  revokeAllDevices,
  revokeDevice,
  setApprovalMode,
  setCodexRescueModel,
  setHeartbeatNotify,
  setJudgeFallback,
  type ApprovalModeSettings,
  type JudgeFallbackSetting,
  type CodexRescueSettings,
  type MobileDeviceRow,
  type ModelRoleName,
  type ModelSettings,
  type PhoneHeartbeat,
} from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { haptic, inNativeShell, type ConnectionDoor } from '../lib/native-bridge';
import {
  getExistingSubscription,
  isStandalonePwa,
  pushSupported,
  requestAndSubscribe,
  unsubscribePush,
} from '../lib/push';
import { BrainSheet } from '../components/BrainSheet';
import { StoragePage } from '../components/StoragePage';
import { RoleSheet } from '../components/RoleSheet';
import {
  ROLE_COPY,
  brainSummary,
  inactiveNote,
  roleNote,
  roleSummary,
  sameFamilyWarning,
  judgeFallbackChoices,
  judgeFallbackSelection,
  judgeFallbackValue,
} from '../lib/model-roles';
import { ScreenNotice } from '../components/ScreenNotice';
import {
  SECTION_TITLES,
  connectionStateWords,
  connectionsSummary,
  daysSince,
  deviceDisplayName,
  devicesSummary,
  groupConnections,
  notificationsSummary,
  phonePushCaveat,
  relativeDay,
  sectionFromSearch,
  settingsSearch,
  splitDevices,
  type SettingsSection,
} from '../lib/settings-index';

/**
 * Settings — the pocket end of a trust relationship minted at home on the
 * Mac. An index of a few recognisable rows, each with one line of truth under
 * it, opening a page; never one long scroll of shouting cards. Everything here
 * is a read of daemon state or a routing choice among things already
 * connected; nothing credential-shaped ever renders, and a broken connection
 * points at the Mac instead of pretending the phone can repair it.
 *
 * Upkeep (clearing stale updates, stuck runs, old conversations) stays on the
 * Mac: bulk actions with four-digit counts are not a thumb's job.
 */
export function Settings({ door, doorCopy, onSignOut, onCustomize }: {
  door: ConnectionDoor;
  doorCopy: { label: string; hint: string };
  onSignOut: () => Promise<void> | void;
  /** Opens the shell's customize-home sheet (ONE sheet, shared with Home). */
  onCustomize: () => void;
}) {
  const devices = useScreenData(listDevices);
  const daemon = useScreenData(getDaemonStatus);
  const models = useScreenData(getModelSettings);
  const connections = useScreenData(getConnectionsHealth);
  const heartbeats = useScreenData(listHeartbeats);
  const approvals = useScreenData(getApprovalMode);
  const usage = useScreenData(getUsageStatus, { intervalMs: 30_000 });

  // The open page lives in the URL (?tab=settings&section=…) so the back
  // gesture, a reload and a deep link all agree on where the phone is.
  const [section, setSection] = useState<SettingsSection | null>(() => sectionFromSearch(window.location.search));
  useEffect(() => {
    const sync = () => setSection(sectionFromSearch(window.location.search));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const openSection = (next: SettingsSection) => {
    haptic('light');
    window.history.pushState({ clemSettings: next }, '', `${window.location.pathname}${settingsSearch(next)}`);
    setSection(next);
    document.querySelector('.app-main')?.scrollTo({ top: 0 });
  };
  const backToIndex = () => {
    haptic('light');
    const state = window.history.state as { clemSettings?: string } | null;
    if (state?.clemSettings) { window.history.back(); return; }
    window.history.replaceState(null, '', `${window.location.pathname}${settingsSearch(null)}`);
    setSection(null);
  };

  const thisDevice = devices.data?.devices.find((d) => d.current);
  const failedSections = [
    devices.error ? 'devices' : '',
    daemon.error ? 'app status' : '',
    models.error ? 'models' : '',
    connections.error ? 'connections' : '',
  ].filter(Boolean);
  const retryAll = () => Promise.allSettled([
    devices.refresh(), daemon.refresh(), models.refresh(), connections.refresh(), heartbeats.refresh(), usage.refresh(), approvals.refresh(),
  ]).then(() => undefined);

  if (section) {
    return (
      <div class="stack settings settings-page">
        <header class="settings-subhead">
          <button type="button" class="settings-back" onClick={backToIndex}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            Settings
          </button>
          <h1 class="settings-page-title">{SECTION_TITLES[section]}</h1>
        </header>
        {section === 'notifications' ? (
          <NotificationsPage
            device={thisDevice}
            devicesLoading={devices.loading}
            heartbeats={heartbeats.data?.heartbeats}
            heartbeatsError={heartbeats.error}
            onChanged={() => Promise.all([heartbeats.refresh(), devices.refresh()])}
          />
        ) : section === 'mode' ? (
          <ModePage loaded={approvals.data} error={approvals.error} onChanged={() => void approvals.refresh()} onRetry={() => void approvals.refresh()} />
        ) : section === 'models' ? (
          <ModelsCard loaded={models.data} onRefresh={models.refresh} />
        ) : section === 'storage' ? (
          <StoragePage />
        ) : section === 'accounts' ? (
          <UsageCard />
        ) : section === 'connections' ? (
          <>
            <ConnectionsPage
              rows={connections.data?.connections}
              loading={connections.loading}
              error={connections.error}
              offline={connections.offline}
              stale={connections.stale}
              refreshing={connections.refreshing}
              onRetry={() => void connections.refresh()}
            />
            {/* Stateful, so it sits beside the stateless connections page
                rather than inside it. */}
            <BrowserbaseConnection />
          </>
        ) : (
          <DevicesPage
            rows={devices.data?.devices}
            loading={devices.loading}
            onRevoked={() => void devices.refresh()}
            onSignOut={onSignOut}
          />
        )}
      </div>
    );
  }

  const meters = presentUsageMeters(usage.data);
  const outOfCredit = meters.filter((m) => m.outOfCredit).length;
  const accountsNote = !usage.data
    ? ''
    : meters.length === 0
      ? 'No model account connected yet'
      : `${meters.length} account${meters.length === 1 ? '' : 's'}${outOfCredit ? ` · ${outOfCredit} refusing requests` : ''}`;

  return (
    <div class="stack settings">
      <StatusStrip
        device={thisDevice}
        door={door}
        doorCopy={doorCopy}
        version={daemon.data?.daemon.version}
      />

      <ScreenNotice
        error={failedSections.length ? `Could not refresh: ${failedSections.join(', ')}.` : null}
        offline={devices.offline || daemon.offline || models.offline || connections.offline}
        onRetry={() => void retryAll()}
        hasData={Boolean(devices.data || daemon.data || models.data || connections.data)}
      />

      <IndexGroup label="You">
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>}
          title="Notifications"
          note={notificationsSummary({ registered: thisDevice ? Boolean(thisDevice.pushRegistered) : undefined, heartbeats: heartbeats.data?.heartbeats })}
          onOpen={() => openSection('notifications')}
        />
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>}
          title="Home"
          note="What Today shows, what opens on launch, quick actions. Same as your Mac."
          onOpen={() => { haptic('light'); onCustomize(); }}
        />
      </IndexGroup>

      <IndexGroup label="Clementine">
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>}
          title="Approvals"
          note={modeSummary(approvals.data)}
          onOpen={() => openSection('mode')}
        />
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a4 4 0 0 0-4 4v1a4 4 0 0 0-3 3.9A4 4 0 0 0 7 19h1a4 4 0 0 0 8 0h1a4 4 0 0 0 2-7.1V11a4 4 0 0 0-3-3.9V7a4 4 0 0 0-4-4z" /><path d="M12 3v18" /></svg>}
          title="Models"
          note={models.data ? `${brainSummary(models.data)} does the work` : ''}
          onOpen={() => openSection('models')}
        />
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /><path d="M7 14h3" /></svg>}
          title="Model accounts"
          note={accountsNote}
          tone={outOfCredit ? 'warn' : undefined}
          onOpen={() => openSection('accounts')}
        />
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7V3M15 7V3" /><path d="M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></svg>}
          title="Connections"
          note={connections.error || connections.offline ? 'Status unavailable · open to retry' : connectionsSummary(connections.data?.connections)}
          onOpen={() => openSection('connections')}
        />
      </IndexGroup>

      <IndexGroup label="Upkeep">
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18M16 17h2" /></svg>}
          title="Storage"
          note="Conversations, memory, execution evidence and backups on your computer."
          onOpen={() => openSection('storage')}
        />
      </IndexGroup>

      <IndexGroup label="This phone">
        <IndexRow
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>}
          title="Devices & security"
          note={devicesSummary(devices.data?.devices)}
          onOpen={() => openSection('devices')}
        />
      </IndexGroup>

      <p class="settings-foot">Sign-ins, keys and clean-up live on your Mac, in Settings.</p>
    </div>
  );
}

/** One line for the index: the mode, and how many kinds Ask has learned. */
export function modeSummary(settings: ApprovalModeSettings | null | undefined): string {
  if (!settings) return '';
  if (settings.mode === 'auto') return 'Auto · anything non-disruptive runs';
  const n = settings.learned.length;
  return `Ask · ${n === 0 ? 'nothing learned yet' : `${n} kind${n === 1 ? '' : 's'} of change learned`}`;
}

/** The approval mode and what Ask learned — the same control as the Mac. */
function ModePage({ loaded, error, onChanged, onRetry }: {
  loaded: ApprovalModeSettings | null | undefined;
  error: string | null | undefined;
  onChanged: () => void;
  onRetry: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // What the daemon answered last; shown at once, then the screen refreshes.
  const [current, setCurrent] = useState<ApprovalModeSettings | null>(null);
  useEffect(() => { setCurrent(null); }, [loaded]);
  const run = async (key: string, work: () => Promise<ApprovalModeSettings>) => {
    setBusy(key);
    setFailed(null);
    try {
      setCurrent(await work());
      onChanged();
      haptic('light');
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setBusy(null);
    }
  };
  const shown = current ?? loaded;
  if (!shown) {
    return (
      <section class="card settings-card">
        <p class="card-note">{error ? `Could not load the approval mode: ${error}` : 'Loading…'}</p>
        {error ? <button type="button" class="btn btn-secondary" onClick={onRetry}>Try again</button> : null}
      </section>
    );
  }
  const mode = shown.mode;
  return (
    <Fragment>
      <section class="card settings-card settings-mode">
        <div class="cz-seg settings-mode-seg" role="group" aria-label="Approval mode">
          <button type="button" class={mode === 'auto' ? 'on' : ''} aria-pressed={mode === 'auto'} disabled={busy !== null} onClick={() => mode !== 'auto' && void run('mode', () => setApprovalMode('auto'))}>Auto</button>
          <button type="button" class={mode === 'ask' ? 'on' : ''} aria-pressed={mode === 'ask'} disabled={busy !== null} onClick={() => mode !== 'ask' && void run('mode', () => setApprovalMode('ask'))}>Ask</button>
        </div>
        <p class="card-note" role="status">
          {busy === 'mode' ? 'Saving…' : mode === 'auto'
            ? 'Anything that is not disruptive just runs: local files, the shell, reads, ordinary changes in your connected apps.'
            : 'Clem also checks with you before an ordinary change in a connected app, once. Approving it teaches her that kind of change.'}
        </p>
        <p class="card-note">In both modes a send, a delete or anything irreversible always asks, on one card. Same setting as your Mac.</p>
        {failed ? <p class="error card-note" role="alert">{failed}</p> : null}
      </section>
      <section class="card settings-card">
        <h2 class="settings-card-title">What Ask learned</h2>
        {shown.learned.length === 0 ? (
          <p class="card-note">Nothing yet. Each approval in Ask mode is remembered here by the operation and account it named; a kind unused for sixty days is forgotten on its own.</p>
        ) : (
          <ul class="settings-list">
            {shown.learned.map((kind) => {
              const key = `${kind.operationId}|${kind.accountId ?? ''}`;
              return (
                <li key={key} class="settings-row">
                  <span class="settings-row-main">
                    <span class="settings-row-label">{kind.operationId}</span>
                    <span class="settings-row-note">{kind.accountId ? `on ${kind.accountId} · ` : ''}last used {daysSince(kind.lastUsedAt) === 0 ? 'today' : `${daysSince(kind.lastUsedAt)}d ago`}</span>
                  </span>
                  <button type="button" class="settings-row-action" disabled={busy !== null} onClick={() => void run(key, () => forgetLearnedWriteKind({ operationId: kind.operationId, accountId: kind.accountId }))}>
                    {busy === key ? 'Forgetting…' : 'Forget'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Fragment>
  );
}

function IndexGroup({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <section class="settings-group" aria-label={label}>
      <h2 class="settings-group-label">{label}</h2>
      <div class="card settings-index">{children}</div>
    </section>
  );
}

function IndexRow({ icon, title, note, tone, onOpen }: {
  icon: preact.ComponentChildren;
  title: string;
  note: string;
  tone?: 'warn';
  onOpen: () => void;
}) {
  return (
    <button type="button" class="settings-index-row" onClick={onOpen}>
      <span class="settings-index-icon" aria-hidden="true">{icon}</span>
      <span class="settings-row-main">
        <span class="settings-row-label">{title}</span>
        {note ? <span class={`settings-row-note${tone === 'warn' ? ' warning' : ''}`}>{note}</span> : null}
      </span>
      <svg class="settings-index-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}

/** One glance = "am I safely connected": this phone, the door, the Mac's version. */
function StatusStrip({ device, door, doorCopy, version }: {
  device?: MobileDeviceRow;
  door: ConnectionDoor;
  doorCopy: { label: string; hint: string };
  version?: string;
}) {
  const paired = device?.createdAt ? new Date(device.createdAt) : null;
  return (
    <section class="card settings-status" aria-label="Connection status">
      <div class="settings-status-row">
        <span class={`conn-pill conn-${door}`} title={doorCopy.hint}>
          <span class="conn-dot" aria-hidden="true" />{doorCopy.label}
        </span>
        <span class="settings-status-hint">{doorCopy.hint}</span>
      </div>
      <div class="settings-status-facts">
        <span class="truncate">{device ? deviceDisplayName(device) : 'This phone'}</span>
        {paired && !Number.isNaN(paired.getTime()) ? (
          <span>Paired {paired.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        ) : null}
        {version ? <span>Clementine {version}</span> : null}
      </div>
    </section>
  );
}

type PushState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'needs-pwa-install' }
  | { kind: 'off' }
  | { kind: 'on' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string };

/**
 * Notifications, truthfully: whether anything can reach THIS phone (a live
 * push destination bound to this device), then what does. Questions Clem
 * needs answered and finished work always reach a registered phone; each
 * heartbeat's findings reach it only when the owner says so, the same switch
 * the Mac's Heartbeats page calls "reach my phone".
 */
function NotificationsPage({ device, devicesLoading, heartbeats, heartbeatsError, onChanged }: {
  device?: MobileDeviceRow;
  devicesLoading: boolean;
  heartbeats?: PhoneHeartbeat[];
  heartbeatsError: string | null;
  onChanged: () => Promise<unknown>;
}) {
  const nativeShell = inNativeShell();
  const registered = Boolean(device?.pushRegistered);
  const [state, setState] = useState<PushState>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Browser (non-native) phones own a Web Push subscription; the switch below
  // is the one control the daemon actually enforces for them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (nativeShell) return;
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (!pushSupported() || (isIOS && !isStandalonePwa())) {
        if (!cancelled) setState(isIOS && !isStandalonePwa() ? { kind: 'needs-pwa-install' } : { kind: 'unsupported' });
        return;
      }
      const existing = await getExistingSubscription();
      if (!cancelled) setState(existing ? { kind: 'on' } : { kind: 'off' });
    })();
    return () => { cancelled = true; };
  }, [nativeShell]);

  const toggleWebPush = async () => {
    haptic('light');
    const wasOn = state.kind === 'on';
    setState({ kind: 'busy' });
    if (wasOn) {
      await unsubscribePush();
      setState({ kind: 'off' });
    } else {
      const result = await requestAndSubscribe();
      setState(result.ok ? { kind: 'on' } : { kind: 'error', message: result.reason });
    }
    await onChanged();
  };

  const flip = async (h: PhoneHeartbeat) => {
    haptic('light');
    setBusyId(h.id);
    setError(null);
    try {
      await setHeartbeatNotify(h.id, h.notify === 'push' ? 'quiet' : 'push');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The change was not confirmed. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const readiness = heartbeats?.[0]?.phonePush;
  const caveat = registered ? '' : phonePushCaveat(readiness, nativeShell);

  return (
    <Fragment>
      <section class="card settings-card" aria-label="This phone">
        {devicesLoading && !device ? (
          <div class="skeleton-stack" aria-hidden="true"><i /></div>
        ) : nativeShell || registered ? (
          <div class="settings-row">
            <span class={`health-dot ${registered ? 'ok' : 'warn'}`} aria-hidden="true" />
            <span class="settings-row-main">
              <span class="settings-row-label">{device ? deviceDisplayName(device) : 'This phone'}</span>
              <span class="settings-row-note">
                {registered
                  ? 'Receives notifications from your Mac.'
                  : 'Not receiving notifications yet. Allow notifications for Clem in iOS Settings, then reopen the app.'}
              </span>
            </span>
          </div>
        ) : state.kind === 'needs-pwa-install' ? (
          <p class="card-note">In Safari, notifications work once Clem is on your Home Screen: tap Share, then Add to Home Screen, and open it from there. The Clem app needs no such step.</p>
        ) : state.kind === 'unsupported' ? (
          <p class="card-note">This browser cannot receive notifications. The Clem app can.</p>
        ) : (
          <button
            type="button"
            class="settings-row settings-toggle-row"
            role="switch"
            aria-checked={state.kind === 'on'}
            disabled={state.kind === 'busy' || state.kind === 'loading'}
            onClick={() => void toggleWebPush()}
          >
            <span class="settings-row-main">
              <span class="settings-row-label">Notify this phone</span>
              <span class="settings-row-note">Questions waiting on you, and finished work.</span>
            </span>
            <span class={`settings-switch${state.kind === 'on' ? ' on' : ''}`} aria-hidden="true"><i /></span>
          </button>
        )}
        {state.kind === 'error' ? <p class="error card-note">Couldn't enable: {state.message}</p> : null}
      </section>

      <section class="settings-group" aria-label="What reaches your phone">
        <h2 class="settings-group-label">What reaches your phone</h2>
        <div class="card settings-card">
          <div class="settings-row">
            <span class="settings-row-main">
              <span class="settings-row-label">Questions and finished work</span>
              <span class="settings-row-note">Always, when this phone receives notifications. Nothing else interrupts you.</span>
            </span>
            <span class="settings-row-kind">Always</span>
          </div>
          {heartbeatsError && !heartbeats ? (
            <p class="card-note">Could not load what Clem watches right now.</p>
          ) : !heartbeats ? (
            <div class="skeleton-stack" aria-hidden="true"><i /><i /></div>
          ) : heartbeats.map((h) => (
            <button
              key={h.id}
              type="button"
              class="settings-row settings-toggle-row"
              role="switch"
              aria-checked={h.notify === 'push'}
              disabled={busyId !== null || !h.enabled}
              onClick={() => void flip(h)}
            >
              <span class="settings-row-main">
                <span class="settings-row-label">{h.title}</span>
                <span class="settings-row-note">
                  {!h.enabled ? 'Off on your Mac.' : h.notify === 'push' ? 'Findings reach this phone.' : 'Findings wait in the app.'}
                </span>
              </span>
              <span class={`settings-switch${h.notify === 'push' ? ' on' : ''}`} aria-hidden="true"><i /></span>
            </button>
          ))}
          {caveat ? <p class="card-note settings-caveat">{caveat}</p> : null}
          {error ? <p class="error card-note">{error}</p> : null}
        </div>
      </section>
    </Fragment>
  );
}

/**
 * Who handles each part of a request, in plain words: the model that does the
 * work, the one that writes the final answer, the one that checks it, and the
 * helpers that run side tasks; then the model that keeps your memory in the
 * background. Each row names the model that will actually run and opens a
 * picker over the daemon's connected catalog. Rarely changed options sit
 * under Advanced.
 */
function ModelsCard({ loaded, onRefresh }: {
  loaded: ModelSettings | null;
  onRefresh: () => Promise<void>;
}) {
  const review = useScreenData(getCompletionReview);
  const [latest, setLatest] = useState<ModelSettings | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const [sheet, setSheet] = useState<ModelRoleName | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // A save answers with the full snapshot so the card redraws at once; the
  // next load supersedes it.
  useEffect(() => { setLatest(null); }, [loaded]);
  const settings = latest ?? loaded;

  const toggleReview = async (enabled: boolean) => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await setCompletionReview(enabled);
      haptic('light');
      await review.refresh();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'The change was not confirmed. Try again.');
    } finally {
      setReviewBusy(false);
    }
  };

  const rescue = settings?.codexRescue;
  const rescueMeaningful = (rescue?.options.filter((option) => option.available).length ?? 0) >= 2;
  const warning = settings ? sameFamilyWarning(settings) : null;
  const reviewOff = review.data ? !review.data.enabled : false;

  return (
    <section class="card settings-card" aria-label="Models">
      <p class="card-note">Which model handles each part of a request, and which keeps your memory.</p>
      {!settings ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : (
        <>
          <RoleRow
            title={ROLE_COPY.brain.title}
            summary={brainSummary(settings)}
            warning={inactiveNote(settings.brain, settings)}
            onOpen={() => setBrainOpen(true)}
          />
          {(['writer', 'judge', 'worker', 'memory', 'quick'] as const).map((role) => settings.roles?.[role] ? (
            <Fragment key={role}>
              <RoleRow
                title={ROLE_COPY[role].title}
                summary={roleSummary(role, settings)}
                warning={inactiveNote(settings.roles[role], settings, role)}
                note={role === 'judge' && reviewOff ? 'Review of finished work is off.' : roleNote(role, settings)}
                onOpen={() => setSheet(role)}
              />
              {role === 'judge' && settings.judgeFallback ? (
                <FallbackJudgeRow settings={settings} onChanged={(judgeFallback) => {
                  setLatest((previous) => ({ ...(previous ?? settings), judgeFallback }));
                  void onRefresh();
                }} />
              ) : null}
            </Fragment>
          ) : null)}
          {warning ? <p class="warning card-note model-roles-warning">{warning}</p> : null}
          {rescue && rescueMeaningful ? (
            <details class="settings-advanced">
              <summary>Advanced</summary>
              <CodexRescueRow settings={rescue} onChanged={onRefresh} />
            </details>
          ) : null}
        </>
      )}
      <BrainSheet open={brainOpen} onClose={() => setBrainOpen(false)} onChanged={() => void onRefresh()} />
      <RoleSheet
        role={sheet}
        settings={settings}
        review={review.data}
        reviewBusy={reviewBusy}
        reviewError={reviewError}
        onToggleReview={(enabled) => void toggleReview(enabled)}
        onClose={() => setSheet(null)}
        onChanged={(next) => { setLatest(next); void onRefresh(); }}
      />
    </section>
  );
}

function FallbackJudgeRow({ settings, onChanged }: {
  settings: ModelSettings;
  onChanged: (setting: JudgeFallbackSetting) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = settings.judgeFallback;
  if (!fallback) return null;
  const choices = judgeFallbackChoices(settings);
  const unavailable = fallback.mode === 'model'
    && choices.some((model) => model.id === (fallback.modelId ?? '') && !model.available);
  const save = async (value: string) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const response = await setJudgeFallback(judgeFallbackSelection(value));
      onChanged(response.judgeFallback);
      haptic('light');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the fallback judge. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="settings-rescue settings-fallback">
      <label class="settings-row" for="judge-fallback-model">
        <span class="settings-row-main">
          <span class="settings-row-label">Backup checker</span>
          <span class="settings-row-note" id="judge-fallback-description">Used only when the checker cannot complete a review. A completed verdict is kept.</span>
        </span>
        <select id="judge-fallback-model" class="settings-select" aria-label="Backup checker model" aria-describedby="judge-fallback-description judge-fallback-status" disabled={busy} value={judgeFallbackValue(fallback)} onChange={(event) => void save(event.currentTarget.value)}>
          <option value="automatic">Automatic</option>
          <option value="off">No fallback</option>
          {choices.map((model) => <option key={model.id} value={`model:${model.id}`} disabled={!model.available}>{model.label}{!model.available ? ' (unavailable)' : ''}</option>)}
        </select>
      </label>
      <p id="judge-fallback-status" class={`card-note${unavailable ? ' warning' : ''}`} role="status">
        {busy ? 'Saving…' : unavailable
          ? `Your saved choice is unavailable. ${fallback.reason || 'Connect it again or choose another fallback.'}`
          : saved ? 'Saved. Applies to new requests.'
          : fallback.mode === 'off' ? 'The checker reviews without a backup.' : 'Applies to new requests.'}
      </p>
      {error ? <p class="error card-note" role="alert">{error}</p> : null}
    </div>
  );
}

function RoleRow({ title, summary, note, warning, onOpen }: {
  title: string;
  summary: string;
  note?: string | null;
  warning?: string | null;
  onOpen: () => void;
}) {
  return (
    <button type="button" class="settings-row model-role-row" onClick={() => { haptic('light'); onOpen(); }}>
      <span class="settings-row-main">
        <span class="settings-row-label">{title}</span>
        <span class="settings-row-note">{summary}</span>
        {warning ? <span class="settings-row-note warning">{warning}</span> : null}
        {note ? <span class="settings-row-note">{note}</span> : null}
      </span>
      <span class="settings-row-action">Change</span>
    </button>
  );
}

/** Usage meters: one row per connected model account, read from the same
 *  daemon builder as the desktop. An account whose provider publishes no
 *  window still shows today's spend, so a connected account is never blank. */
function UsageCard() {
  const usage = useScreenData(getUsageStatus, { intervalMs: 30_000 });
  const meters = presentUsageMeters(usage.data);
  const now = Date.now();
  if (!usage.data && !usage.error) return null;
  return (
    <section class="card settings-card" aria-label="Model accounts">
      {usage.error && !usage.data ? (
        <p class="card-note">Could not load usage right now.</p>
      ) : meters.length === 0 ? (
        <p class="card-note">No model account is connected yet.</p>
      ) : meters.map((meter) => {
        // One grammar for every account, the same words as the Mac: what is
        // left, when it resets, what it does. One bar, for the window the
        // headline speaks about; the rest is in the Mac's Settings.
        const status = accountStatus(meter, now);
        const refusal = creditRefusalSentence(meter, clockTime);
        const bar = status.window;
        return (
          <div key={meter.id} class={`usage-meter${meter.outOfCredit ? ' usage-meter-out' : ''}`}>
            <div class="usage-meter-head">
              <span class="settings-row-label">{meter.label}</span>
              <span class={`usage-meter-compact usage-tone-${status.tone}`}>
                {[status.left, status.resets].filter(Boolean).join(' · ')}
              </span>
            </div>
            {bar ? (
              <div class="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bar.usedPercent} aria-label={`${meter.label} ${bar.label}`}>
                <div class={`usage-bar-fill usage-fill-${bar.tone}`} style={{ width: `${bar.usedPercent}%` }} />
              </div>
            ) : null}
            <p class="settings-row-note">
              {status.doing} · {status.today ?? 'nothing today'}{status.age ? ` · ${status.age}` : ''}
            </p>
            {refusal ? <p class="usage-out-note">{refusal}</p> : null}
            {meter.billing ? (
              <a
                class={`usage-billing-link${meter.outOfCredit ? ' urgent' : ''}`}
                href={meter.billing.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${meter.billing.action} for ${meter.label} on the provider's billing page`}
              >
                {meter.billing.action} ↗
              </a>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Shown only when there is a meaningful choice. Every option id and label is
 * supplied by the daemon's connected Codex catalog; the phone never guesses a
 * provider from text or exposes a credential field. */
function CodexRescueRow({ settings, onChanged }: {
  settings: CodexRescueSettings;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.options.filter((option) => option.available).length < 2) return null;

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await setCodexRescueModel(value === '__primary__' ? null : value);
      haptic('light');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the rescue model');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-rescue">
      <label class="settings-row" for="codex-rescue-model">
        <span class="brain-dot ok" aria-hidden="true" />
        <span class="settings-row-main">
          <span class="settings-row-label">Codex backup</span>
          <span class="settings-row-note">Answers only if an API-key model doing the work fails before replying.</span>
        </span>
        <select
          id="codex-rescue-model"
          class="settings-select"
          aria-label="Codex rescue model"
          disabled={busy}
          value={settings.configured ? settings.modelId : '__primary__'}
          onChange={(event) => void save(event.currentTarget.value)}
        >
          <option value="__primary__">Follow primary ({settings.inheritedModelId})</option>
          {settings.options.map((option) => (
            <option key={option.id} value={option.id} disabled={!option.available}>{option.label}</option>
          ))}
        </select>
      </label>
      {error ? <p class="error card-note">{error}</p> : null}
    </div>
  );
}

/**
 * Connections, as the owner named them: the apps Clem can reach, then the
 * tools on the Mac. A row says what is true in plain words; fixing anything
 * happens on the Mac, in Connect.
 */
export function ConnectionsPage({ rows, loading, error, offline, stale, refreshing, onRetry }: {
  rows?: Array<{ id: string; name: string; kind: string; state: 'ok' | 'warn' | 'err'; cause: string | null }>;
  loading: boolean;
  error: string | null;
  offline: boolean;
  stale: boolean;
  refreshing: boolean;
  onRetry: () => void;
}) {
  if (loading && !rows) {
    return <section class="card settings-card" role="status" aria-label="Loading connections" aria-busy="true"><div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div></section>;
  }
  const unavailable = Boolean(error || offline || stale || !rows);
  const { apps, tools } = groupConnections(rows ?? []);
  const list = (items: NonNullable<typeof rows>) => (
    <ul class="settings-list">
      {items.map((row) => (
        <li key={row.id} class="settings-list-row">
          {!unavailable && <span class={`health-dot ${row.state}`} aria-hidden="true" />}
          <span class="settings-row-main">
            <span class="settings-row-label truncate">{row.name}</span>
            <span class="settings-row-note">{unavailable ? `Last checked: ${connectionStateWords(row)}` : connectionStateWords(row)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Fragment>
      <ScreenNotice
        error={unavailable ? 'Connection status is unavailable.' : null}
        offline={offline}
        onRetry={onRetry}
        hasData={Boolean(rows?.length)}
      />
      {refreshing && <p class="card-note" role="status">Checking connections…</p>}
      {unavailable && Boolean(rows?.length) && <p class="card-note">Showing last known connections. Their current status has not been verified.</p>}
      {!unavailable && rows?.length === 0 && <section class="card settings-card"><p class="card-note">Nothing connected yet. Connect apps on your Mac and they show up here.</p></section>}
      {apps.length ? (
        <section class="settings-group" aria-label="Apps">
          <h2 class="settings-group-label">Apps</h2>
          <div class="card settings-card">{list(apps)}</div>
        </section>
      ) : null}
      {tools.length ? (
        <section class="settings-group" aria-label="Tools on your Mac">
          <h2 class="settings-group-label">Tools on your Mac</h2>
          <div class="card settings-card">{list(tools)}</div>
        </section>
      ) : null}
      {Boolean(rows?.length) && <p class="settings-foot">Other connections are managed on your Mac, in Connect.</p>}
    </Fragment>
  );
}

/**
 * Devices, recognisably: this phone first, the others by when they were last
 * seen, and the ones nobody has opened in two weeks set apart so revoking them
 * is an obvious tidy. Revoking asks once; signing out everywhere asks once.
 */
function DevicesPage({ rows, loading, onRevoked, onSignOut }: {
  rows?: MobileDeviceRow[];
  loading: boolean;
  onRevoked: () => void;
  onSignOut: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (deviceId: string) => {
    setBusy(deviceId);
    setError(null);
    try {
      await revokeDevice(deviceId);
      haptic('light');
      onRevoked();
    } catch (err) {
      setError((err as Error).message ?? 'Could not revoke that device');
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const signOutEverywhere = async () => {
    setBusy('all');
    setError(null);
    try {
      await revokeAllDevices();
    } catch (err) {
      setError((err as Error).message ?? 'Could not sign out everywhere');
      setBusy(null);
      setConfirming(null);
      return;
    }
    await onSignOut();
  };

  const { current, active, stale } = splitDevices(rows ?? []);

  const revokeControl = (device: MobileDeviceRow) => (
    confirming === device.deviceId ? (
      <span class="settings-danger-actions">
        <button type="button" class="settings-danger-btn confirming" aria-label={`Confirm revoke ${deviceDisplayName(device)}`} disabled={busy !== null} onClick={() => void revoke(device.deviceId)}>
          {busy === device.deviceId ? '…' : 'Confirm'}
        </button>
        <button type="button" class="settings-danger-btn" disabled={busy !== null} onClick={() => setConfirming(null)}>Cancel</button>
      </span>
    ) : (
      <button type="button" class="settings-danger-btn" aria-label={`Revoke ${deviceDisplayName(device)}`} disabled={busy !== null} onClick={() => setConfirming(device.deviceId)}>
        Revoke
      </button>
    )
  );

  const deviceRow = (device: MobileDeviceRow) => (
    <li key={device.deviceId} class="settings-list-row">
      <span class="settings-row-main">
        <span class="settings-row-label truncate">{deviceDisplayName(device)}</span>
        <span class="settings-row-note">
          Last seen {relativeDay(device.lastSeenAt)}{device.pushRegistered ? ' · gets notifications' : ''}
        </span>
      </span>
      {revokeControl(device)}
    </li>
  );

  return (
    <Fragment>
      <section class="card settings-card settings-this-phone" aria-label="This phone">
        {loading && !rows ? (
          <div class="skeleton-stack" aria-hidden="true"><i /></div>
        ) : (
          <div class="settings-row">
            <span class="settings-row-main">
              <span class="settings-row-label">
                <span class="truncate">{current ? deviceDisplayName(current) : 'This phone'}</span>
                <span class="settings-this-device-pill">This phone</span>
              </span>
              <span class="settings-row-note">
                {current ? `Paired ${relativeDay(current.createdAt)} · ${current.pushRegistered ? 'gets notifications' : 'no notifications yet'}` : ''}
              </span>
            </span>
          </div>
        )}
      </section>

      {active.length ? (
        <section class="settings-group" aria-label="Other devices">
          <h2 class="settings-group-label">Other devices</h2>
          <div class="card settings-card"><ul class="settings-list">{active.map(deviceRow)}</ul></div>
        </section>
      ) : null}

      {stale.length ? (
        <section class="settings-group" aria-label="Not seen in weeks">
          <h2 class="settings-group-label">Not seen in weeks</h2>
          <div class="card settings-card">
            <ul class="settings-list">{stale.map(deviceRow)}</ul>
            <p class="card-note">Revoking signs that device out of Clem. It can pair again from your Mac.</p>
          </div>
        </section>
      ) : null}

      {error ? <p class="error card-note">{error}</p> : null}

      <div class="settings-signout settings-signout-page">
        <button type="button" class="settings-signout-btn" onClick={() => { haptic('light'); void onSignOut(); }}>
          Sign out on this phone
        </button>
        {confirming === 'all' ? (
          <span class="settings-danger-actions">
            <button type="button" class="settings-danger-btn confirming" disabled={busy !== null} onClick={() => void signOutEverywhere()}>
              {busy === 'all' ? '…' : 'Confirm sign out everywhere'}
            </button>
            <button type="button" class="settings-danger-btn" disabled={busy !== null} onClick={() => setConfirming(null)}>Cancel</button>
          </span>
        ) : (
          <button type="button" class="settings-danger-btn" disabled={busy !== null} onClick={() => setConfirming('all')}>
            Sign out everywhere
          </button>
        )}
      </div>
    </Fragment>
  );
}
