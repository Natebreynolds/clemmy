import { useEffect, useState } from 'preact/hooks';
import { compactUsageText, formatTokenCount, presentUsageMeters, resetsInText } from '@clem/chat-engine';
import {
  getCompletionReview,
  getConnectionsHealth,
  getDaemonStatus,
  getModelSettings,
  setCompletionReview,
  getTidyPlan,
  applyTidy,
  getUsageStatus,
  type TidyClass,
  type TidyCounts,
  type TidyResult,
  type TidyScope,
  listDevices,
  revokeAllDevices,
  revokeDevice,
  setCodexRescueModel,
  type CodexRescueSettings,
  type MobileDeviceRow,
  type ModelRoleName,
  type ModelSettings,
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
import { RoleSheet } from '../components/RoleSheet';
import {
  ROLE_COPY,
  brainSummary,
  inactiveNote,
  roleSummary,
  sameFamilyWarning,
} from '../lib/model-roles';
import { ScreenNotice } from '../components/ScreenNotice';

/**
 * Settings — the pocket end of a trust relationship minted at home on the
 * Mac. Everything here is a read of daemon state or a routing choice among
 * things already connected; nothing credential-shaped ever renders, and a
 * broken connection points at the Mac instead of pretending the phone can
 * repair it.
 *
 * Deferred by design (a control that changes nothing is a lie): "what
 * reaches me" notification preferences, quiet hours, approval posture, the
 * cost section, schedule pause.
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

  const thisDevice = devices.data?.devices.find((d) => d.current);
  const failedSections = [
    devices.error ? 'devices' : '',
    daemon.error ? 'app status' : '',
    models.error ? 'models' : '',
    connections.error ? 'connections' : '',
  ].filter(Boolean);
  const retryAll = () => Promise.allSettled([
    devices.refresh(), daemon.refresh(), models.refresh(), connections.refresh(),
  ]).then(() => undefined);

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

      <section class="card settings-card" aria-label="Home">
        <h2 class="settings-card-title">Home</h2>
        <button type="button" class="settings-row" onClick={() => { haptic('light'); onCustomize(); }}>
          <span class="settings-row-main">
            <span class="settings-row-label">Customize your home</span>
            <span class="settings-row-note">Panes, the title switcher, what opens on launch, quick actions. Same as your desktop.</span>
          </span>
          <span class="settings-row-action">Open</span>
        </button>
      </section>

      <NotificationsCard />

      <ModelsCard loaded={models.data} onRefresh={models.refresh} />

      <UsageCard />

      <CleanupCard />

      <ConnectionsCard
        rows={connections.data?.connections}
        loading={connections.loading}
      />

      <DevicesCard
        rows={devices.data?.devices}
        loading={devices.loading}
        onRevoked={() => void devices.refresh()}
        onSignOut={onSignOut}
      />
    </div>
  );
}

/** One glance = "am I safely connected": this device, the door, the daemon. */
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
        <span class="truncate">{device?.deviceLabel || 'This device'}</span>
        {paired && !Number.isNaN(paired.getTime()) ? (
          <span>Paired {paired.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
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
 * Push on/off for THIS device only — the one notification control the daemon
 * actually enforces today. Server-side "what reaches me" preferences do not
 * exist yet, so no such switches are shown (deferred, not faked).
 */
function NotificationsCard() {
  const [state, setState] = useState<PushState>({ kind: 'loading' });
  const nativeShell = inNativeShell();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (nativeShell) return;
      if (!pushSupported()) {
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
        if (!cancelled) setState(isIOS && !isStandalonePwa() ? { kind: 'needs-pwa-install' } : { kind: 'unsupported' });
        return;
      }
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (isIOS && !isStandalonePwa()) {
        if (!cancelled) setState({ kind: 'needs-pwa-install' });
        return;
      }
      const existing = await getExistingSubscription();
      if (!cancelled) setState(existing ? { kind: 'on' } : { kind: 'off' });
    })();
    return () => { cancelled = true; };
  }, [nativeShell]);

  const enabled = state.kind === 'on';
  const toggle = async () => {
    haptic('light');
    const wasOn = enabled;
    setState({ kind: 'busy' });
    if (wasOn) {
      await unsubscribePush();
      setState({ kind: 'off' });
      return;
    }
    const result = await requestAndSubscribe();
    setState(result.ok ? { kind: 'on' } : { kind: 'error', message: result.reason });
  };

  if (nativeShell) {
    return (
      <section class="card settings-card" aria-label="Notifications">
        <h2 class="settings-card-title">Notifications</h2>
        <div class="settings-row">
          <span class="settings-row-main">
            <span class="settings-row-label">Push to this iPhone</span>
            <span class="settings-row-note">Managed in iOS Settings. Clem alerts you when a response or decision is needed.</span>
          </span>
          <span class="settings-row-kind">iOS</span>
        </div>
      </section>
    );
  }

  return (
    <section class="card settings-card" aria-label="Notifications">
      <h2 class="settings-card-title">Notifications</h2>
      {state.kind === 'needs-pwa-install' ? (
        <p class="card-note">iOS delivers push only after Add to Home Screen. Tap Share, then Add to Home Screen, and reopen from there.</p>
      ) : state.kind === 'unsupported' ? (
        <p class="card-note">This browser cannot receive push notifications.</p>
      ) : (
        <button
          type="button"
          class="settings-row settings-toggle-row"
          role="switch"
          aria-checked={enabled}
          disabled={state.kind === 'busy' || state.kind === 'loading'}
          onClick={() => void toggle()}
        >
          <span class="settings-row-main">
            <span class="settings-row-label">Push to this device</span>
            <span class="settings-row-note">Approvals waiting, replies ready, finished work.</span>
          </span>
          <span class={`settings-switch${enabled ? ' on' : ''}`} aria-hidden="true"><i /></span>
        </button>
      )}
      {state.kind === 'error' ? <p class="error card-note">Couldn't enable: {state.message}</p> : null}
    </section>
  );
}

/**
 * Who handles each part of a request, in plain words: the model that does the
 * work, the one that writes the final answer, the one that checks it, and the
 * helpers that run side tasks. Each row names the model that will actually
 * run and opens a picker over the daemon's connected catalog. Rarely changed
 * options sit under Advanced.
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
      <h2 class="settings-card-title">Models</h2>
      <p class="card-note">Which model handles each part of a request.</p>
      {!settings ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : (
        <>
          <RoleRow
            title={ROLE_COPY.brain.title}
            summary={brainSummary(settings)}
            note={inactiveNote(settings.brain, settings)}
            onOpen={() => setBrainOpen(true)}
          />
          {(['writer', 'judge', 'worker'] as const).map((role) => settings.roles?.[role] ? (
            <RoleRow
              key={role}
              title={ROLE_COPY[role].title}
              summary={roleSummary(role, settings)}
              note={inactiveNote(settings.roles[role], settings)
                ?? (role === 'judge' && reviewOff ? 'Review of finished work is off.' : null)}
              onOpen={() => setSheet(role)}
            />
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

function RoleRow({ title, summary, note, onOpen }: {
  title: string;
  summary: string;
  note?: string | null;
  onOpen: () => void;
}) {
  return (
    <button type="button" class="settings-row model-role-row" onClick={() => { haptic('light'); onOpen(); }}>
      <span class="settings-row-main">
        <span class="settings-row-label">{title}</span>
        <span class="settings-row-note">{summary}</span>
        {note ? <span class="settings-row-note warning">{note}</span> : null}
      </span>
      <span class="settings-row-action">Change</span>
    </button>
  );
}

const TIDY_ROWS: Array<{ id: TidyClass; label: string; note: string; verb: (n: number) => string }> = [
  { id: 'updates', label: 'Updates', note: 'Unread updates from finished work. Open questions are never touched.', verb: (n) => `${n} marked read` },
  { id: 'staleAsks', label: 'Asks', note: 'Approval cards, plan and trust proposals, check-in questions. Stale = unanswered for a day.', verb: (n) => `${n} cancelled` },
  { id: 'stuckRuns', label: 'Stuck runs', note: 'Blocked or parked workflow runs, and chat turns no runner holds. Stale = over a day.', verb: (n) => `${n} stopped` },
  { id: 'oldConversations', label: 'Conversations', note: 'Stale = quiet for two weeks; all = every unpinned conversation. Archived, never deleted.', verb: (n) => `${n} archived` },
];

/** Clean up: exact counts for what is stale and for everything, a button per
 *  class per scope, and "clear everything" behind one confirmation. Nothing
 *  is deleted; updates are read, asks cancelled, runs stopped, conversations
 *  archived. */
function CleanupCard() {
  const stale = useScreenData(() => getTidyPlan('stale'), { intervalMs: 60_000, resourceKey: 'tidy:stale' });
  const all = useScreenData(() => getTidyPlan('all'), { intervalMs: 60_000, resourceKey: 'tidy:all' });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sum = (c?: TidyCounts) => (c ? c.updates + c.staleAsks + c.stuckRuns + c.oldConversations : 0);
  const staleCounts = stale.data?.counts;
  const allCounts = all.data?.counts;

  const run = async (classes: TidyClass[], scope: TidyScope, key: string) => {
    setBusy(key);
    setError(null);
    setOutcome(null);
    setConfirmAll(false);
    try {
      const { result } = await applyTidy(classes, scope);
      haptic('light');
      setOutcome(describeTidy(result));
      await Promise.allSettled([stale.refresh(), all.refresh()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not tidy up right now.');
    } finally {
      setBusy(null);
    }
  };

  if (!stale.data && !stale.error) return null;
  return (
    <section class="card settings-card" aria-label="Clean up">
      <h2 class="settings-card-title">Clean up</h2>
      {stale.error && !stale.data ? <p class="card-note">Could not check for clutter right now.</p> : null}
      {staleCounts ? TIDY_ROWS.map((row) => {
        const s = staleCounts[row.id];
        const a = allCounts?.[row.id] ?? 0;
        return (
          <div class="tidy-row" key={row.id}>
            <div class="settings-row-main">
              <span class="settings-row-label">{row.label}</span>
              <span class="settings-row-note">{row.note}</span>
            </div>
            <div class="tidy-actions">
              <button type="button" class="tidy-action" disabled={s === 0 || busy !== null} onClick={() => void run([row.id], 'stale', `${row.id}:stale`)}>
                {busy === `${row.id}:stale` ? 'Clearing…' : `Clear stale${s > 0 ? ` (${s})` : ''}`}
              </button>
              <button type="button" class="tidy-action" disabled={a === 0 || busy !== null} onClick={() => void run([row.id], 'all', `${row.id}:all`)}>
                {busy === `${row.id}:all` ? 'Clearing…' : `Clear all${a > 0 ? ` (${a})` : ''}`}
              </button>
            </div>
          </div>
        );
      }) : null}
      {staleCounts ? (
        confirmAll ? (
          <div class="tidy-confirm">
            <p class="card-note">Clear every item above — {sum(allCounts)} in total, including today's? Nothing is deleted.</p>
            <div class="tidy-confirm-actions">
              <button type="button" class="btn-approve" disabled={busy !== null} onClick={() => void run(TIDY_ROWS.map((r) => r.id), 'all', 'all:all')}>
                {busy === 'all:all' ? 'Clearing…' : `Yes, clear ${sum(allCounts)}`}
              </button>
              <button type="button" class="btn-reject" disabled={busy !== null} onClick={() => setConfirmAll(false)}>Keep</button>
            </div>
          </div>
        ) : (
          <div class="tidy-confirm-actions">
            <button type="button" class="btn tidy-all" disabled={sum(staleCounts) === 0 || busy !== null} onClick={() => void run(TIDY_ROWS.map((r) => r.id), 'stale', 'all:stale')}>
              {busy === 'all:stale' ? 'Tidying…' : `Tidy up stale${sum(staleCounts) > 0 ? ` (${sum(staleCounts)})` : ''}`}
            </button>
            <button type="button" class="btn tidy-all" disabled={sum(allCounts) === 0 || busy !== null} onClick={() => setConfirmAll(true)}>
              {`Clear everything${sum(allCounts) > 0 ? ` (${sum(allCounts)})` : ''}`}
            </button>
          </div>
        )
      ) : null}
      {outcome ? <p class="card-note">{outcome}</p> : null}
      {error ? <p class="warning card-note">{error}</p> : null}
    </section>
  );
}

function describeTidy(result: TidyResult): string {
  const parts = [
    result.updatesCleared > 0 ? TIDY_ROWS[0].verb(result.updatesCleared) : '',
    result.asksCancelled > 0 ? TIDY_ROWS[1].verb(result.asksCancelled) : '',
    result.runsStopped > 0 ? TIDY_ROWS[2].verb(result.runsStopped) : '',
    result.conversationsArchived > 0 ? TIDY_ROWS[3].verb(result.conversationsArchived) : '',
  ].filter(Boolean);
  const held = result.updatesHeld > 0 ? ` ${result.updatesHeld} update${result.updatesHeld === 1 ? '' : 's'} still need an answer and were kept.` : '';
  const errors = result.errors.length > 0 ? ` ${result.errors.length} item${result.errors.length === 1 ? '' : 's'} could not be cleared.` : '';
  return (parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Nothing needed clearing.') + held + errors;
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
    <section class="card settings-card" aria-label="Usage">
      <h2 class="settings-card-title">Usage</h2>
      {usage.error && !usage.data ? (
        <p class="card-note">Could not load usage right now.</p>
      ) : meters.length === 0 ? (
        <p class="card-note">No model account is connected yet.</p>
      ) : meters.map((meter) => (
        <div key={meter.id} class="usage-meter">
          <div class="usage-meter-head">
            <span class="settings-row-label">{meter.label}</span>
            <span class="usage-meter-compact">{compactUsageText(meter)}</span>
          </div>
          {meter.windows.map((w) => {
            const reset = resetsInText(w.resetAt, now);
            return (
              <div key={w.id} class="usage-window">
                <div class="usage-window-line">
                  <span>{w.label}</span>
                  <span class={`usage-tone-${w.tone}`}>{w.usedPercent}%{reset ? ` · ${reset}` : ''}</span>
                </div>
                <div class="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.usedPercent} aria-label={`${meter.label} ${w.label}`}>
                  <div class={`usage-bar-fill usage-fill-${w.tone}`} style={{ width: `${w.usedPercent}%` }} />
                </div>
              </div>
            );
          })}
          <p class="settings-row-note">
            {meter.windows.length === 0 && meter.note ? `${meter.note} ` : ''}
            {meter.spend
              ? `Today: ${formatTokenCount(meter.spend.tokens)} tokens · ${meter.spend.calls} call${meter.spend.calls === 1 ? '' : 's'}`
              : 'Today: nothing yet'}
          </p>
        </div>
      ))}
    </section>
  );
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

/** Read-only health. v1 does no reauth from the phone — a broken row says
 *  where to fix it (on the Mac), which is the truth. */
function ConnectionsCard({ rows, loading }: {
  rows?: Array<{ id: string; name: string; kind: string; state: 'ok' | 'warn' | 'err'; cause: string | null }>;
  loading: boolean;
}) {
  return (
    <section class="card settings-card" aria-label="Connections">
      <h2 class="settings-card-title">Connections</h2>
      {loading && !rows ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /></div>
      ) : !rows || rows.length === 0 ? (
        <p class="card-note">Nothing connected yet. Connect tools on your Mac and they show up here.</p>
      ) : (
        <ul class="settings-list">
          {rows.map((row) => (
            <li key={row.id} class="settings-list-row">
              <span class={`health-dot ${row.state}`} aria-hidden="true" />
              <span class="settings-row-main">
                <span class="settings-row-label truncate">{row.name}</span>
                <span class="settings-row-note">
                  {row.cause ?? (row.state === 'ok' ? 'Connected' : row.state === 'warn' ? 'Needs attention' : 'Unavailable')}
                </span>
              </span>
              <span class="settings-row-kind">{row.kind === 'cli' ? 'CLI' : 'App'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DevicesCard({ rows, loading, onRevoked, onSignOut }: {
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

  return (
    <section class="card settings-card" aria-label="Devices and security">
      <h2 class="settings-card-title">Devices &amp; security</h2>
      {loading && !rows ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /></div>
      ) : (
        <ul class="settings-list">
          {(rows ?? []).map((device) => (
            <li key={device.deviceId} class="settings-list-row">
              <span class="settings-row-main">
                <span class="settings-row-label truncate">
                  {device.deviceLabel || device.deviceId}
                  {device.current ? <span class="settings-this-device"> · this device</span> : null}
                </span>
                <span class="settings-row-note">
                  Last seen {relativeDay(device.lastSeenAt)}
                </span>
              </span>
              {!device.current ? (
                confirming === device.deviceId ? (
                  <span class="settings-danger-actions">
                    <button
                      type="button"
                      class="settings-danger-btn confirming"
                      aria-label={`Confirm revoke ${device.deviceLabel || device.deviceId}`}
                      disabled={busy !== null}
                      onClick={() => void revoke(device.deviceId)}
                    >
                      {busy === device.deviceId ? '…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      class="settings-danger-btn"
                      disabled={busy !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    class="settings-danger-btn"
                    aria-label={`Revoke ${device.deviceLabel || device.deviceId}`}
                    disabled={busy !== null}
                    onClick={() => setConfirming(device.deviceId)}
                  >
                    Revoke
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p class="error card-note">{error}</p> : null}
      <div class="settings-signout">
        <button
          type="button"
          class="settings-signout-btn"
          onClick={() => { haptic('light'); void onSignOut(); }}
        >
          Sign out on this device
        </button>
        {confirming === 'all' ? (
          <span class="settings-danger-actions">
            <button
              type="button"
              class="settings-danger-btn confirming"
              disabled={busy !== null}
              onClick={() => void signOutEverywhere()}
            >
              {busy === 'all' ? '…' : 'Confirm sign out everywhere'}
            </button>
            <button
              type="button"
              class="settings-danger-btn"
              disabled={busy !== null}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            class="settings-danger-btn"
            disabled={busy !== null}
            onClick={() => setConfirming('all')}
          >
            Sign out everywhere
          </button>
        )}
      </div>
    </section>
  );
}

function relativeDay(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'recently';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
