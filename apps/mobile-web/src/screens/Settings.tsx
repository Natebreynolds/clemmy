import { useEffect, useState } from 'preact/hooks';
import {
  getConnectionsHealth,
  getDaemonStatus,
  getModelSettings,
  listDevices,
  revokeAllDevices,
  revokeDevice,
  setCodexRescueModel,
  type CodexRescueSettings,
  type MobileDeviceRow,
} from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { haptic, type ConnectionDoor } from '../lib/native-bridge';
import {
  getExistingSubscription,
  isStandalonePwa,
  pushSupported,
  requestAndSubscribe,
  unsubscribePush,
} from '../lib/push';
import { BrainSheet } from '../components/BrainSheet';

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
export function Settings({ door, doorCopy, onSignOut }: {
  door: ConnectionDoor;
  doorCopy: { label: string; hint: string };
  onSignOut: () => Promise<void> | void;
}) {
  const devices = useScreenData(listDevices);
  const daemon = useScreenData(getDaemonStatus);
  const models = useScreenData(getModelSettings);
  const connections = useScreenData(getConnectionsHealth);

  const thisDevice = devices.data?.devices.find((d) => d.current);

  return (
    <div class="stack settings">
      <StatusStrip
        device={thisDevice}
        door={door}
        doorCopy={doorCopy}
        version={daemon.data?.daemon.version}
      />

      <NotificationsCard />

      <BrainCard
        currentLabel={
          models.data?.options.find((o) => o.value === models.data?.effectiveValue)?.label
            ?? models.data?.brain.modelId
        }
        provider={models.data?.brain.provider}
        inactive={models.data?.brain.inactiveBinding}
        actualModelId={models.data?.brain.modelId}
        codexRescue={models.data?.codexRescue}
        onChanged={() => models.refresh()}
      />

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
  }, []);

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

  return (
    <section class="card settings-card" aria-label="Notifications">
      <h3 class="settings-card-title">Notifications</h3>
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

function BrainCard({ currentLabel, provider, inactive, actualModelId, codexRescue, onChanged }: {
  currentLabel?: string;
  provider?: string;
  inactive?: { modelId: string; reason: string };
  actualModelId?: string;
  codexRescue?: CodexRescueSettings;
  onChanged: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section class="card settings-card" aria-label="Brain">
      <h3 class="settings-card-title">Brain</h3>
      <button
        type="button"
        class="settings-row"
        onClick={() => { haptic('light'); setOpen(true); }}
      >
        <span class="brain-dot ok" aria-hidden="true" />
        <span class="settings-row-main">
          <span class="settings-row-label truncate">{currentLabel ?? 'Loading…'}</span>
          <span class="settings-row-note">{provider ? `${provider} · switching applies to your next message` : ''}</span>
        </span>
        <span class="settings-row-action">Change</span>
      </button>
      {inactive ? (
        <p class="warning card-note">
          Saved {inactive.modelId} is unavailable — {actualModelId} answers instead.
        </p>
      ) : null}
      {codexRescue ? <CodexRescueRow settings={codexRescue} onChanged={onChanged} /> : null}
      <BrainSheet open={open} onClose={() => setOpen(false)} onChanged={onChanged} />
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
          <span class="settings-row-label">Codex rescue</span>
          <span class="settings-row-note">Used only if an all-in custom brain fails before answering.</span>
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
      <h3 class="settings-card-title">Connections</h3>
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
                {row.cause ? <span class="settings-row-note">{row.cause}</span> : null}
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
      <h3 class="settings-card-title">Devices &amp; security</h3>
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
                  <button
                    type="button"
                    class="settings-danger-btn confirming"
                    disabled={busy !== null}
                    onClick={() => void revoke(device.deviceId)}
                  >
                    {busy === device.deviceId ? '…' : 'Confirm'}
                  </button>
                ) : (
                  <button
                    type="button"
                    class="settings-danger-btn"
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
          <button
            type="button"
            class="settings-danger-btn confirming"
            disabled={busy !== null}
            onClick={() => void signOutEverywhere()}
          >
            {busy === 'all' ? '…' : 'Confirm sign out everywhere'}
          </button>
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
