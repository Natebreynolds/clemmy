/**
 * Mobile Access integration — orchestrates the cloudflared lifecycle +
 * PIN provisioning on behalf of the dashboard. Module-scoped singletons
 * keep "is the tunnel running?", "is there a login in progress?", and
 * "is there an install job?" answerable across HTTP requests.
 *
 * The dashboard's Settings → Mobile Access page calls these functions
 * via /api/console/mobile-access/* endpoints. The CLI (`clementine
 * mobile tunnel start`) is a separate path that owns its own
 * supervisor in foreground; the dashboard supervisor lives here.
 */

import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { BASE_DIR, WEBHOOK_HOST, WEBHOOK_PORT } from '../config.js';
import { createMobilePairingCode } from '../runtime/mobile-pairing.js';
import { setPin, hasPin, readPinMeta } from '../runtime/mobile-pin.js';
import {
  listSessions,
  revokeAllSessions,
  type MobileSessionRecord,
} from '../runtime/mobile-sessions.js';
import {
  CloudflaredSupervisor,
  awaitQuickTunnelHostname,
  isProcessAlive,
  spawnDetachedQuickTunnel,
  type CloudflaredEvent,
  createTunnel,
  detectCloudflared,
  installCloudflaredViaBrew,
  listTunnels,
  routeDns,
  startCloudflaredLogin,
  type DetectResult,
  type LoginSession,
  type TunnelInfo,
} from '../runtime/cloudflared.js';
import {
  readMobileAccess,
  setMobileAccessAccessAck,
  setMobileAccessAutoStart,
  setMobileAccessBinary,
  setMobileAccessStatus,
  setMobileAccessTunnel,
  updateMobileAccess,
  type MobileAccessRecord,
  type MobileAccessStatus,
  tunnelOriginUrl,
} from '../runtime/mobile-access-state.js';
import { mobileAuthPosture, type MobileAuthPostureGap } from '../runtime/mobile-auth-posture.js';

const DEFAULT_CERT_PATH = path.join(os.homedir(), '.cloudflared', 'cert.pem');
const TUNNEL_LOG_FILE = path.join(BASE_DIR, 'logs', 'cloudflared', 'tunnel.log');

// ─── install jobs ───────────────────────────────────────────────────

export interface InstallJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  /** Tail of stdout/stderr lines, capped at MAX_LINES. */
  lines: Array<{ stream: 'stdout' | 'stderr'; text: string; at: string }>;
  exitOk?: boolean;
  exitError?: string;
}

const MAX_INSTALL_LINES = 400;
const installJobs = new Map<string, InstallJob>();

function newJobId(): string {
  return `install-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

export function getInstallJob(id: string): InstallJob | undefined {
  return installJobs.get(id);
}

export function listInstallJobs(): InstallJob[] {
  return [...installJobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5);
}

export async function startInstallJob(): Promise<InstallJob> {
  const job: InstallJob = {
    id: newJobId(),
    status: 'running',
    startedAt: new Date().toISOString(),
    lines: [],
  };
  installJobs.set(job.id, job);
  await setMobileAccessStatus('installing').catch(() => undefined);
  // Fire-and-forget; the caller polls the job by id.
  void installCloudflaredViaBrew({
    onLine: (stream, text) => {
      job.lines.push({ stream, text, at: new Date().toISOString() });
      if (job.lines.length > MAX_INSTALL_LINES) {
        job.lines = job.lines.slice(-MAX_INSTALL_LINES);
      }
    },
  }).then(async (result) => {
    job.completedAt = new Date().toISOString();
    job.exitOk = result.ok;
    job.exitError = result.error;
    job.status = result.ok ? 'succeeded' : 'failed';
    if (result.ok) {
      const det = await detectCloudflared();
      if (det.binary) {
        await setMobileAccessBinary({ path: det.binary, version: det.version ?? 'unknown' });
      }
      await setMobileAccessStatus('inactive');
    } else {
      await setMobileAccessStatus('error', result.error);
    }
  }).catch(async (err) => {
    job.completedAt = new Date().toISOString();
    job.exitOk = false;
    job.exitError = (err as Error).message;
    job.status = 'failed';
    await setMobileAccessStatus('error', job.exitError).catch(() => undefined);
  }).catch(() => undefined); // fire-and-forget: a background install must NEVER
  // leak an unhandled rejection (e.g. a status write that fails after the caller
  // has moved on) — that would crash the process / fail a whole test file.
  return job;
}

// ─── login session ──────────────────────────────────────────────────

export interface LoginStatus {
  active: boolean;
  url?: string;
  certPath: string;
  certPresent: boolean;
  certUpdatedAt?: string;
  outcome?: { ok: true } | { ok: false; error: string };
}

let currentLogin: { session: LoginSession; url?: string; outcome?: LoginStatus['outcome'] } | null = null;

export function getLoginStatus(): LoginStatus {
  const certPresent = existsSync(DEFAULT_CERT_PATH);
  const certUpdatedAt = certPresent
    ? new Date(statSync(DEFAULT_CERT_PATH).mtimeMs).toISOString()
    : undefined;
  return {
    active: Boolean(currentLogin && !currentLogin.outcome),
    url: currentLogin?.url,
    certPath: DEFAULT_CERT_PATH,
    certPresent,
    certUpdatedAt,
    outcome: currentLogin?.outcome,
  };
}

export async function startLogin(): Promise<LoginStatus> {
  if (currentLogin && !currentLogin.outcome) {
    return getLoginStatus();
  }
  const session = startCloudflaredLogin();
  const entry: { session: LoginSession; url?: string; outcome?: LoginStatus['outcome'] } = { session };
  currentLogin = entry;
  await setMobileAccessStatus('awaiting-login').catch(() => undefined);

  // Capture URL with a timeout — cloudflared sometimes prints to stderr
  // late on slow networks.
  void Promise.race([
    session.url,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for cloudflared login URL')), 15_000)),
  ]).then((url) => { entry.url = url; }).catch((err) => {
    entry.outcome = { ok: false, error: (err as Error).message };
    void setMobileAccessStatus('error', entry.outcome.error).catch(() => undefined);
  });

  void session.done.then(async (result) => {
    entry.outcome = result;
    if (result.ok) {
      await setMobileAccessStatus('configuring');
    } else {
      await setMobileAccessStatus('error', result.error);
    }
  });

  // Brief settle so url has a chance to land before the first poll.
  await new Promise((r) => setTimeout(r, 50));
  return getLoginStatus();
}

export function cancelLogin(): void {
  if (currentLogin && !currentLogin.outcome) {
    currentLogin.session.cancel();
    currentLogin.outcome = { ok: false, error: 'cancelled' };
  }
}

// ─── tunnels ────────────────────────────────────────────────────────

export async function fetchAvailableTunnels(): Promise<TunnelInfo[]> {
  return listTunnels();
}

export interface ConfigureInput {
  /** Tunnel name. If it matches an existing tunnel, reuse it (no create call). */
  tunnelName: string;
  hostname: string;
}

export async function configureTunnel(input: ConfigureInput): Promise<MobileAccessRecord> {
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(input.tunnelName)) {
    throw new Error('Tunnel name must be 1-63 chars of A-Z, a-z, 0-9, dot, dash, underscore');
  }
  if (!/^[A-Za-z0-9._-]{4,253}$/.test(input.hostname) || !input.hostname.includes('.')) {
    throw new Error('Hostname must be a valid dotted DNS name');
  }
  await setMobileAccessStatus('configuring');
  // Reuse existing if name matches; else create.
  let tunnel: { id: string; name: string; credentialsFile?: string } | null = null;
  try {
    const existing = await listTunnels();
    const match = existing.find((t) => t.name === input.tunnelName);
    if (match) tunnel = { id: match.id, name: match.name };
  } catch {
    /* not logged in → create will fail with a clear error */
  }
  if (!tunnel) {
    const created = await createTunnel(input.tunnelName);
    tunnel = { id: created.id, name: created.name, credentialsFile: created.credentialsFile };
  }
  await routeDns(tunnel.id, input.hostname);
  return updateMobileAccess((current) => ({
    ...current,
    tunnel: {
      id: tunnel!.id,
      name: tunnel!.name,
      hostname: input.hostname,
      mode: 'named',
      credentialsFile: tunnel!.credentialsFile ?? current.tunnel?.credentialsFile,
    },
    status: 'configuring',
    cloudflareAccess: current.cloudflareAccess?.hostname === input.hostname ? current.cloudflareAccess : undefined,
  }));
}

// ─── tunnel supervisor (dashboard-owned singleton) ──────────────────

let currentSupervisor: CloudflaredSupervisor | null = null;
let lastSupervisorEvents: CloudflaredEvent[] = [];
let tunnelRuntimeOverrideForTests: TunnelRuntime | null = null;

const EVENT_RING_SIZE = 50;

export interface TunnelRuntime {
  running: boolean;
  connected: boolean;
  events: CloudflaredEvent[];
  startedAt?: string;
}

let startedAt: string | undefined;

/**
 * A detached quick tunnel this daemon is currently adopting or running.
 *
 * Detached cloudflared has no pipes to watch, so liveness is a pid check plus
 * the nonce probe rather than a stream of supervisor events.
 */
let detachedQuick: { pid: number; hostname: string } | null = null;

export function getTunnelRuntime(): TunnelRuntime {
  if (tunnelRuntimeOverrideForTests) return tunnelRuntimeOverrideForTests;
  if (detachedQuick && isProcessAlive(detachedQuick.pid)) {
    return {
      running: true,
      connected: true,
      events: [...lastSupervisorEvents],
      startedAt,
    };
  }
  return {
    running: Boolean(currentSupervisor?.isRunning()),
    connected: Boolean(currentSupervisor?.isConnected()),
    events: [...lastSupervisorEvents],
    startedAt,
  };
}

/**
 * Confirms a hostname is still OUR tunnel by asking it to echo our nonce.
 *
 * Cloudflare recycles trycloudflare hostnames, so a hostname that merely
 * answers proves nothing — it could be a stranger's tunnel. Only the nonce
 * echo is evidence.
 */
export async function probeTunnelOwnership(
  hostname: string,
  expectedNonce: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<boolean> {
  if (!hostname || !expectedNonce) return false;
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
  try {
    const res = await doFetch(`https://${hostname}/m/health`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json() as { nonce?: unknown };
    return body?.nonce === expectedNonce;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function startTunnel(): Promise<{ ok: boolean; error?: string }> {
  if (currentSupervisor?.isRunning()) {
    return { ok: true };
  }
  const record = readMobileAccess();
  if (!record.binary?.path) {
    const error = 'cloudflared binary not detected';
    await setMobileAccessStatus('error', error).catch(() => undefined);
    return { ok: false, error };
  }
  if (!record.tunnel?.id || record.tunnel.mode !== 'named') {
    const error = 'no custom-domain tunnel configured';
    await setMobileAccessStatus('error', error).catch(() => undefined);
    return { ok: false, error };
  }
  const localUrl = tunnelOriginUrl();
  lastSupervisorEvents = [];
  const supervisor = new CloudflaredSupervisor({
    binary: record.binary.path,
    tunnelNameOrId: record.tunnel.id,
    localUrl,
    logFile: TUNNEL_LOG_FILE,
    onEvent: (event) => {
      lastSupervisorEvents.push(event);
      if (lastSupervisorEvents.length > EVENT_RING_SIZE) {
        lastSupervisorEvents = lastSupervisorEvents.slice(-EVENT_RING_SIZE);
      }
      if (event.type === 'connected') {
        void setMobileAccessStatus('running').catch(() => undefined);
      } else if (event.type === 'exit') {
        void setMobileAccessStatus('inactive').catch(() => undefined);
      } else if (event.type === 'restart-skipped') {
        void setMobileAccessStatus('error', event.reason).catch(() => undefined);
      }
    },
  });
  currentSupervisor = supervisor;
  startedAt = new Date().toISOString();
  try {
    await supervisor.start();
  } catch (err) {
    currentSupervisor = null;
    startedAt = undefined;
    const error = err instanceof Error ? err.message : String(err);
    await setMobileAccessStatus('error', error).catch(() => undefined);
    return { ok: false, error };
  }
  await setMobileAccessAutoStart(true).catch(() => undefined);
  return { ok: true };
}

/**
 * Starts a quick tunnel as a detached process and records how to find it again.
 *
 * Detached is the whole point: a trycloudflare hostname lives exactly as long
 * as its cloudflared process, and while that process was our child, every
 * daemon restart rotated the hostname. A new hostname is a new ORIGIN, which
 * invalidates the phone's home-screen icon, session cookie, service worker,
 * push subscription, and notification permission — so a naive restart produced
 * a live tunnel nobody's phone could use.
 */
export async function startQuickTunnel(): Promise<{ ok: boolean; error?: string }> {
  if (detachedQuick && isProcessAlive(detachedQuick.pid)) return { ok: true };
  if (currentSupervisor?.isRunning()) return { ok: true };
  if (currentLogin && !currentLogin.outcome) cancelLogin();

  const record = readMobileAccess();
  if (!record.binary?.path) return { ok: false, error: 'cloudflared binary not detected' };

  lastSupervisorEvents = [];
  await setMobileAccessStatus('configuring').catch(() => undefined);

  const previousHostname = record.tunnel?.mode === 'quick' ? record.tunnel.hostname : undefined;
  const logSize = existsSync(TUNNEL_LOG_FILE) ? statSync(TUNNEL_LOG_FILE).size : 0;

  let handle;
  try {
    handle = spawnDetachedQuickTunnel({
      binary: record.binary.path,
      localUrl: tunnelOriginUrl(),
      logFile: TUNNEL_LOG_FILE,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setMobileAccessStatus('error', error).catch(() => undefined);
    return { ok: false, error };
  }

  // The hostname is only discoverable from cloudflared's own output, so this
  // one read of the log is unavoidable on first start. Adoption later uses the
  // persisted hostname plus the nonce probe instead.
  const hostname = await awaitQuickTunnelHostname(TUNNEL_LOG_FILE, { since: logSize });
  if (!hostname) {
    try { process.kill(handle.pid); } catch { /* already gone */ }
    const error = 'Cloudflare did not return a tunnel URL in time';
    await setMobileAccessStatus('error', error).catch(() => undefined);
    return { ok: false, error };
  }

  const probeNonce = randomBytes(16).toString('hex');
  await updateMobileAccess((current) => ({
    ...current,
    tunnel: {
      id: 'quick',
      name: 'Quick mobile link',
      hostname,
      mode: 'quick',
      pid: handle.pid,
      probeNonce,
      startedAt: handle.startedAt,
    },
    status: 'running',
    lastError: undefined,
  })).catch(() => undefined);

  detachedQuick = { pid: handle.pid, hostname };
  startedAt = handle.startedAt;
  // Quick tunnels now survive restarts, so they participate in boot auto-start
  // like any other tunnel. Previously this was forced to false, which is what
  // made them die on every restart.
  await setMobileAccessAutoStart(true).catch(() => undefined);

  if (previousHostname && previousHostname !== hostname) {
    await notifyQuickTunnelRotation(previousHostname, hostname);
  }
  return { ok: true };
}

/**
 * Reattaches to a still-running detached tunnel, or starts a fresh one.
 *
 * Called at boot and from the status endpoint. Adoption is what makes a daemon
 * restart invisible to an already-paired phone.
 */
export async function adoptOrStartQuickTunnel(
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; adopted: boolean; error?: string }> {
  const record = readMobileAccess();
  const tunnel = record.tunnel;
  if (tunnel?.mode === 'quick' && tunnel.pid && tunnel.probeNonce && isProcessAlive(tunnel.pid)) {
    const ours = await probeTunnelOwnership(tunnel.hostname, tunnel.probeNonce, opts);
    if (ours) {
      detachedQuick = { pid: tunnel.pid, hostname: tunnel.hostname };
      startedAt = tunnel.startedAt ?? new Date().toISOString();
      await setMobileAccessStatus('running').catch(() => undefined);
      return { ok: true, adopted: true };
    }
    // Alive but not serving us — a recycled hostname or a stale process.
    // Reap it rather than leaving an orphan holding a port.
    try { process.kill(tunnel.pid); } catch { /* already gone */ }
  }
  const started = await startQuickTunnel();
  return { ok: started.ok, adopted: false, error: started.error };
}

/**
 * Bookmark-rot alarm. Best-effort — must never break tunnel startup. Push fans
 * out to every paired device through the existing notification pipeline.
 */
async function notifyQuickTunnelRotation(previousHostname: string, newHostname: string): Promise<void> {
  try {
    const { addNotification } = await import('../runtime/notifications.js');
    addNotification({
      id: `mobile-quick-url-rotated-${Date.now().toString(36)}`,
      kind: 'system',
      title: 'Mobile link URL changed',
      body: `Your temporary mobile URL rotated to https://${newHostname}/m/. The home-screen icon on your phone now points at a stale URL — open the desktop Mobile Access panel for a fresh QR code.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { previousHostname, newHostname, mode: 'quick' },
    });
  } catch {
    /* swallow */
  }
}

export async function stopTunnel(): Promise<{ ok: boolean }> {
  const record = readMobileAccess();
  const wasQuick = record.tunnel?.mode === 'quick';

  // A detached tunnel outlives this process, so it must be killed by pid.
  // Leaving it running after an explicit stop would be an orphan the user
  // cannot see or reach.
  const pid = record.tunnel?.pid;
  if (pid && isProcessAlive(pid)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  detachedQuick = null;

  if (currentSupervisor) {
    await currentSupervisor.stop();
    currentSupervisor = null;
  }
  startedAt = undefined;
  await setMobileAccessAutoStart(false).catch(() => undefined);
  if (wasQuick) {
    await updateMobileAccess((current) => ({ ...current, tunnel: null, status: 'inactive' })).catch(() => undefined);
  } else {
    await setMobileAccessStatus('inactive').catch(() => undefined);
  }
  return { ok: true };
}

// ─── PIN rotation ───────────────────────────────────────────────────

export async function rotatePin(pin: string): Promise<{ revokedSessions: number; updatedAt: string }> {
  await setPin(pin);
  const revoked = await revokeAllSessions();
  return { revokedSessions: revoked, updatedAt: new Date().toISOString() };
}

// ─── QR code ────────────────────────────────────────────────────────

export type MobileAccessTargetMode = 'local-preview' | 'quick' | 'custom-domain';

export interface MobileAccessHardening {
  /**
   * Observed, not claimed. 'unknown' means we have not successfully probed this
   * hostname — never that Access is off.
   */
  cloudflareAccess: 'enforcing' | 'not-enforcing' | 'unknown';
  checkedAt?: string;
  /** Weaknesses in the daemon's own auth. Blocking ones prevent the QR. */
  postureGaps?: MobileAuthPostureGap[];
}

export interface MobileAccessTarget {
  url: string;
  mode: MobileAccessTargetMode;
  qrReady: boolean;
  qrBlockedReason?: string;
  hardening?: MobileAccessHardening;
}

export class MobileQrNotReadyError extends Error {
  readonly code = 'MOBILE_QR_NOT_READY';

  constructor(readonly target: MobileAccessTarget) {
    super(target.qrBlockedReason ?? 'Mobile QR is not ready');
  }
}

function baseUrlForHostname(hostname: string): string {
  return `https://${hostname}/m/`;
}

function legacyTargetMode(target: MobileAccessTarget): 'public' | 'local-preview' {
  return target.mode === 'local-preview' ? 'local-preview' : 'public';
}

export function mobileAccessTarget(
  input: {
    record?: MobileAccessRecord;
    runtime?: TunnelRuntime;
    hostnameOverride?: string;
  } = {},
): MobileAccessTarget {
  const record = input.record ?? readMobileAccess();
  const runtime = input.runtime ?? getTunnelRuntime();
  const cleanOverride = input.hostnameOverride?.trim();
  const tunnel = record.tunnel;
  const host = cleanOverride || tunnel?.hostname?.trim() || '';

  if (host) {
    const mode: MobileAccessTargetMode = !cleanOverride && tunnel?.mode === 'quick' ? 'quick' : 'custom-domain';
    const running = runtime.running;
    const connected = runtime.running && runtime.connected;

    // Both modes now gate on the same two things: the tunnel is up, and OUR OWN
    // auth is sound.
    //
    // Cloudflare Access used to gate the custom-domain branch, via an
    // `acknowledged && enabled` pair the user set by ticking "I've enabled it"
    // — never verified. That made the security model depend on a self-report,
    // and made the hard setup steps (own a domain, configure a Cloudflare app)
    // load-bearing. Now that sessions are device-bound, rate limits are
    // unspoofable, and the route surface is default-deny, the daemon can face
    // the internet on its own. Access becomes defense-in-depth, reported as a
    // badge from an actual probe rather than trusted as a claim.
    const posture = mobileAuthPosture();

    let qrBlockedReason: string | undefined;
    if (!posture.ok) {
      qrBlockedReason = posture.gaps.find((gap) => gap.blocking)?.message
        ?? 'Mobile access is not safe to expose yet.';
    } else if (!running) {
      qrBlockedReason = mode === 'quick'
        ? 'Start the temporary mobile link and wait for Cloudflare to finish connecting before scanning the QR.'
        : 'Start the custom-domain tunnel before scanning the QR.';
    } else if (!connected) {
      qrBlockedReason = 'Wait for Cloudflare to finish connecting before scanning the QR.';
    }

    const access = record.cloudflareAccess;
    const matchesHost = access?.hostname.trim().toLowerCase() === host.toLowerCase();
    const cloudflareAccess: MobileAccessHardening['cloudflareAccess'] = !matchesHost || !access
      ? 'unknown'
      : access.verified
        ? (access.verified.enforcing ? 'enforcing' : 'not-enforcing')
        : 'unknown';

    return {
      url: baseUrlForHostname(host),
      mode,
      qrReady: connected && posture.ok,
      qrBlockedReason,
      hardening: {
        cloudflareAccess,
        checkedAt: matchesHost ? access?.verified?.checkedAt : undefined,
        postureGaps: posture.gaps,
      },
    };
  }

  return {
    url: `http://127.0.0.1:${WEBHOOK_PORT}/m/`,
    mode: 'local-preview',
    qrReady: false,
    qrBlockedReason: 'This Mac is only exposing mobile at 127.0.0.1, which a phone cannot reach. Configure a Cloudflare hostname or start a temporary mobile link.',
  };
}

export async function generateQrSvg(hostname?: string): Promise<{
  svg: string;
  targetUrl: string;
  targetMode: 'public' | 'local-preview';
  target: MobileAccessTarget;
  expiresAt: string;
}> {
  const record = readMobileAccess();
  const target = mobileAccessTarget({ record, hostnameOverride: hostname });
  if (!target.qrReady) {
    throw new MobileQrNotReadyError(target);
  }
  const pairing = await createMobilePairingCode({ targetUrl: target.url });
  const pairUrl = new URL(target.url);
  pairUrl.searchParams.set('pair', pairing.token);
  const svg = await QRCode.toString(pairUrl.toString(), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
  });
  return {
    svg,
    targetUrl: pairUrl.toString(),
    targetMode: legacyTargetMode(target),
    target: { ...target, url: pairUrl.toString() },
    expiresAt: pairing.expiresAt,
  };
}

// ─── aggregate status (single fetch for the panel) ──────────────────

export interface MobileAccessStatusPayload {
  detect: DetectResult;
  state: MobileAccessRecord;
  pin: { configured: boolean; updatedAt?: string };
  sessions: Array<Pick<MobileSessionRecord, 'deviceId' | 'deviceLabel' | 'createdAt' | 'lastSeenAt' | 'expiresAt' | 'pushSubscribed'>>;
  login: LoginStatus;
  tunnel: TunnelRuntime;
  install: { recent: InstallJob[] };
  webhookBound: { host: string; port: number };
  target: MobileAccessTarget;
  targetUrl?: string;
  targetMode?: 'public' | 'local-preview';
  /**
   * The single derived view every surface renders. Added alongside the legacy
   * fields rather than replacing them, so existing consumers keep working.
   */
  setup?: import('./mobile-setup.js').MobileSetupView;
}

export async function getMobileAccessStatusPayload(): Promise<MobileAccessStatusPayload> {
  const detect = await detectCloudflared();
  // Best-effort: if the binary was detected for the first time, persist it.
  const state = readMobileAccess();
  if (detect.binary && (!state.binary || state.binary.path !== detect.binary || state.binary.version !== detect.version)) {
    try {
      await setMobileAccessBinary({ path: detect.binary, version: detect.version ?? 'unknown' });
    } catch { /* best effort */ }
  }
  // A quick tunnel is no longer reaped here. This block used to null the
  // persisted tunnel whenever no in-process supervisor was running, which erased
  // the hostname on the FIRST status poll after a restart — before adoption ever
  // got a chance to run. It was the real reason quick tunnels felt disposable.
  let stateAfter = readMobileAccess();
  if (stateAfter.tunnel?.mode === 'quick' && !detachedQuick && !currentSupervisor?.isRunning()) {
    const pid = stateAfter.tunnel.pid;
    if (pid && isProcessAlive(pid)) {
      void adoptOrStartQuickTunnel().catch(() => undefined);
    }
  }
  const pinMeta = readPinMeta();
  const sessions = listSessions().map((row) => ({
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    pushSubscribed: row.pushSubscribed ?? false,
  }));
  const target = mobileAccessTarget({ record: stateAfter });
  const payload: MobileAccessStatusPayload = {
    detect,
    state: stateAfter,
    pin: { configured: hasPin(), updatedAt: pinMeta?.updatedAt },
    sessions,
    login: getLoginStatus(),
    tunnel: getTunnelRuntime(),
    install: { recent: listInstallJobs() },
    webhookBound: { host: WEBHOOK_HOST, port: WEBHOOK_PORT },
    target,
    targetUrl: target.url,
    targetMode: legacyTargetMode(target),
  };
  // Derived last, from the finished payload, so there is exactly one place
  // that decides "what state is setup in?".
  const { mobileSetupView } = await import('./mobile-setup.js');
  payload.setup = mobileSetupView(payload);
  return payload;
}

export async function acknowledgeCloudflareAccess(enabled: boolean): Promise<MobileAccessRecord> {
  return setMobileAccessAccessAck({ enabled });
}

/** Re-export for tests so they can drive supervisor lifecycle. */
export function _resetMobileAccessForTests(): void {
  currentSupervisor = null;
  lastSupervisorEvents = [];
  tunnelRuntimeOverrideForTests = null;
  currentLogin = null;
  installJobs.clear();
  startedAt = undefined;
}

export function _setTunnelRuntimeForTests(runtime: TunnelRuntime | null): void {
  tunnelRuntimeOverrideForTests = runtime;
}

/** Convenience: name + label of the status enum values, for the UI. */
export const MOBILE_ACCESS_STATUS_LABELS: Record<MobileAccessStatus, string> = {
  inactive: 'Inactive',
  installing: 'Installing cloudflared',
  'awaiting-login': 'Waiting for Cloudflare login',
  configuring: 'Configuring tunnel',
  running: 'Running',
  error: 'Error',
};
