/**
 * One-tap mobile setup.
 *
 * Setup used to be a four-step wizard because Cloudflare Access was the
 * security model: you had to own a domain, run a browser login, create and
 * DNS-route a named tunnel, then configure a Cloudflare app and come back and
 * tick a box. All of that was out-of-product work, and most of it existed only
 * to satisfy a gate that was never actually verified.
 *
 * With the daemon's own auth able to face the internet, none of it is required.
 * Setup collapses to: make sure cloudflared exists, open a tunnel, show a QR.
 *
 * Two ideas do the work here:
 *
 * `ensureMobileAccess()` is idempotent and resumable. Every failure leaves the
 * system in a state where calling it again is the correct next action, which is
 * what lets the entire error UI be a single "Try again" button instead of a
 * branching troubleshooting tree.
 *
 * `mobileSetupView()` is the ONE object every surface renders — desktop panel,
 * CLI, and any future client. Three surfaces previously recomputed "what state
 * are we in?" from raw status, and they disagreed with each other. Deriving it
 * once means they cannot.
 */
import {
  adoptOrStartQuickTunnel,
  getInstallJob,
  getLoginStatus,
  getMobileAccessStatusPayload,
  startInstallJob,
  startTunnel,
  type MobileAccessStatusPayload,
} from './mobile-access.js';
import { detectCloudflared } from '../runtime/cloudflared.js';
import { readMobileAccess, tunnelOriginUrl } from '../runtime/mobile-access-state.js';
import { mobileAuthPosture } from '../runtime/mobile-auth-posture.js';

export type MobileSetupPhase = 'not-set-up' | 'installing' | 'connecting' | 'live' | 'error';

export type MobileFailureCode =
  | 'NOT_MACOS'
  | 'BREW_MISSING'
  | 'INSTALL_FAILED'
  | 'CLOUDFLARED_MISSING'
  | 'PORT_UNREACHABLE'
  | 'TUNNEL_WONT_CONNECT'
  | 'AUTH_POSTURE';

export interface MobileSetupRemedy {
  label: string;
  action: 'retry' | 'install-brew' | 'open-url' | 'copy-command';
  url?: string;
  command?: string;
}

export interface MobileSetupFailure {
  code: MobileFailureCode;
  /** One plain sentence. No jargon, no stack traces. */
  message: string;
  /** Exactly one next action, so no state is ever a dead end. */
  remedy: MobileSetupRemedy;
}

export interface MobileSetupDevice {
  deviceId: string;
  deviceLabel?: string;
  lastSeenAt: string;
  pushSubscribed: boolean;
}

export interface MobileSetupView {
  phase: MobileSetupPhase;
  headline: string;
  detail?: string;
  /** Present only when phase === 'live'. */
  url?: string;
  qrReady: boolean;
  /** Tail of install/tunnel output, for an honest progress disclosure. */
  progressLines?: string[];
  failure?: MobileSetupFailure;
  devices: MobileSetupDevice[];
  advanced: {
    mode: 'quick' | 'named' | 'none';
    hostname?: string;
    /** A named tunnel is only offerable once cloudflared holds a cert. */
    permanentAvailable: boolean;
    cloudflareAccess: 'enforcing' | 'not-enforcing' | 'unknown';
  };
}

/**
 * Derives the whole UI state from a status payload.
 *
 * Pure and synchronous so it is trivially testable and cannot drift between
 * callers.
 */
export function mobileSetupView(payload: MobileAccessStatusPayload): MobileSetupView {
  const devices: MobileSetupDevice[] = payload.sessions.map((session) => ({
    deviceId: session.deviceId,
    deviceLabel: session.deviceLabel,
    lastSeenAt: session.lastSeenAt,
    pushSubscribed: session.pushSubscribed ?? false,
  }));

  const advanced: MobileSetupView['advanced'] = {
    mode: payload.state.tunnel?.mode ?? 'none',
    hostname: payload.state.tunnel?.hostname,
    permanentAvailable: payload.login.certPresent,
    cloudflareAccess: payload.target.hardening?.cloudflareAccess ?? 'unknown',
  };

  const posture = mobileAuthPosture();
  const blocking = posture.gaps.find((gap) => gap.blocking);
  if (blocking) {
    return {
      phase: 'error',
      headline: 'Mobile access is not safe to turn on yet',
      qrReady: false,
      devices,
      advanced,
      failure: {
        code: 'AUTH_POSTURE',
        message: blocking.message,
        remedy: { label: 'Try again', action: 'retry' },
      },
    };
  }

  const installing = payload.install.recent.find((job) => job.status === 'running');
  if (installing) {
    return {
      phase: 'installing',
      headline: 'Installing the Cloudflare helper…',
      detail: 'This usually takes about 30 seconds.',
      qrReady: false,
      progressLines: installing.lines.slice(-8).map((line) => line.text),
      devices,
      advanced,
    };
  }

  if (!payload.detect.binary) {
    return {
      phase: 'not-set-up',
      headline: 'Use Clementine on your phone',
      detail: 'Clementine will install Cloudflare’s helper and open a private, encrypted link to this Mac.',
      qrReady: false,
      devices,
      advanced,
    };
  }

  if (payload.state.status === 'error' && payload.state.lastError) {
    return {
      phase: 'error',
      headline: 'Could not open the mobile link',
      qrReady: false,
      devices,
      advanced,
      failure: {
        code: 'TUNNEL_WONT_CONNECT',
        message: payload.state.lastError,
        remedy: { label: 'Try again', action: 'retry' },
      },
    };
  }

  if (payload.target.qrReady) {
    return {
      phase: 'live',
      headline: 'Scan with your phone’s camera',
      detail: advanced.mode === 'quick'
        ? 'This link works until this Mac restarts. Add it to your home screen.'
        : undefined,
      url: payload.target.url,
      qrReady: true,
      devices,
      advanced,
    };
  }

  if (payload.tunnel.running || payload.state.status === 'configuring') {
    return {
      phase: 'connecting',
      headline: 'Opening a secure link…',
      detail: 'Cloudflare is sometimes slow to connect.',
      qrReady: false,
      progressLines: payload.tunnel.events
        .filter((event) => event.type === 'log')
        .slice(-8)
        .map((event) => (event as { line: string }).line),
      devices,
      advanced,
    };
  }

  return {
    phase: 'not-set-up',
    headline: 'Use Clementine on your phone',
    detail: 'Open a private, encrypted link to this Mac and scan a code to pair.',
    qrReady: false,
    devices,
    advanced,
  };
}

/** Confirms the daemon is actually answering before we tunnel to it. */
async function localSurfaceReachable(opts?: { fetchImpl?: typeof fetch }): Promise<boolean> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await doFetch(`${tunnelOriginUrl()}/m/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnsureMobileAccessOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam so the install poll does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function failure(
  code: MobileFailureCode,
  message: string,
  remedy: MobileSetupRemedy,
): { ok: false; failure: MobileSetupFailure } {
  return { ok: false, failure: { code, message, remedy } };
}

/**
 * Drives setup from wherever it currently is to a scannable QR.
 *
 * Safe to call repeatedly — each step checks whether it is already satisfied
 * before doing anything, which is what makes "Try again" a complete recovery UI.
 */
export async function ensureMobileAccess(
  opts?: EnsureMobileAccessOptions,
): Promise<{ ok: boolean; failure?: MobileSetupFailure; view: MobileSetupView }> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts?.timeoutMs ?? 90_000);

  const finish = async (
    result: { ok: boolean; failure?: MobileSetupFailure },
  ): Promise<{ ok: boolean; failure?: MobileSetupFailure; view: MobileSetupView }> => {
    const view = mobileSetupView(await getMobileAccessStatusPayload());
    return { ...result, view: result.failure ? { ...view, phase: 'error', failure: result.failure } : view };
  };

  // Refuse to expose an unsound daemon, whatever the user clicked.
  const posture = mobileAuthPosture();
  const blocking = posture.gaps.find((gap) => gap.blocking);
  if (blocking) {
    return finish(failure('AUTH_POSTURE', blocking.message, { label: 'Try again', action: 'retry' }));
  }

  // 1. cloudflared present?
  let detect = await detectCloudflared();
  if (!detect.binary) {
    if (process.platform !== 'darwin') {
      return finish(failure(
        'NOT_MACOS',
        'Automatic install is only available on macOS. Install cloudflared, then try again.',
        { label: 'Installation guide', action: 'open-url', url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' },
      ));
    }
    const job = await startInstallJob();
    while (Date.now() < deadline) {
      const current = getInstallJob(job.id);
      if (!current || current.status !== 'running') break;
      await sleep(500);
    }
    const finished = getInstallJob(job.id);
    if (finished?.status !== 'succeeded') {
      const detail = finished?.exitError ?? '';
      const brewMissing = /brew: command not found|not found: brew/i.test(detail);
      return finish(brewMissing
        ? failure(
          'BREW_MISSING',
          'Homebrew is needed to install the Cloudflare helper automatically.',
          { label: 'Get Homebrew', action: 'open-url', url: 'https://brew.sh' },
        )
        : failure(
          'INSTALL_FAILED',
          detail || 'The Cloudflare helper could not be installed.',
          { label: 'Copy install command', action: 'copy-command', command: 'brew install cloudflared' },
        ));
    }
    detect = await detectCloudflared();
    if (!detect.binary) {
      return finish(failure(
        'CLOUDFLARED_MISSING',
        'The Cloudflare helper installed but could not be found on PATH.',
        { label: 'Try again', action: 'retry' },
      ));
    }
  }

  // 2. Is there anything to tunnel TO? Checking first avoids spending 60s
  //    building a tunnel to a door that is closed.
  if (!(await localSurfaceReachable({ fetchImpl: opts?.fetchImpl }))) {
    return finish(failure(
      'PORT_UNREACHABLE',
      'Clementine’s local server is not responding, so there is nothing to link to yet.',
      { label: 'Try again', action: 'retry' },
    ));
  }

  // 3. Open the tunnel. An already-configured named tunnel keeps its path —
  //    existing users are not silently migrated to a quick tunnel.
  const record = readMobileAccess();
  const started = record.tunnel?.mode === 'named'
    ? await startTunnel()
    : await adoptOrStartQuickTunnel();
  if (!started.ok) {
    return finish(failure(
      'TUNNEL_WONT_CONNECT',
      started.error || 'Cloudflare did not finish connecting.',
      { label: 'Try again', action: 'retry' },
    ));
  }

  // 4. Wait for a scannable QR.
  while (Date.now() < deadline) {
    const view = mobileSetupView(await getMobileAccessStatusPayload());
    if (view.qrReady) return { ok: true, view };
    if (view.phase === 'error') return { ok: false, failure: view.failure, view };
    await sleep(500);
  }
  return finish(failure(
    'TUNNEL_WONT_CONNECT',
    'Cloudflare did not finish connecting in time.',
    { label: 'Try again', action: 'retry' },
  ));
}
