/**
 * One-tap mobile setup.
 *
 * Setup used to be a four-step wizard because a Cloudflare tunnel was the
 * transport: install cloudflared, log in, create and DNS-route a tunnel, come
 * back and tick a box. The pinned-TLS direct-app door removed all of it — the
 * daemon opens its own door at boot, so setup collapses to: show a QR, scan it
 * from the Clem app.
 *
 * `mobileSetupView()` is the ONE object every surface renders — desktop panel,
 * CLI, and any future client. Surfaces previously recomputed "what state are
 * we in?" from raw status, and they disagreed with each other. Deriving it
 * once means they cannot.
 *
 * `ensureMobileAccess()` is idempotent and resumable. Every failure leaves the
 * system in a state where calling it again is the correct next action, which is
 * what lets the entire error UI be a single "Try again" button instead of a
 * branching troubleshooting tree.
 */
import {
  getMobileAccessStatusPayload,
  type MobileAccessStatusPayload,
} from './mobile-access.js';
import { WEBHOOK_PORT } from '../config.js';
import { mobileAuthPosture } from '../runtime/mobile-auth-posture.js';

export type MobileSetupPhase = 'not-set-up' | 'live' | 'error';

export type MobileFailureCode =
  | 'DOOR_CLOSED'
  | 'PORT_UNREACHABLE'
  | 'AUTH_POSTURE';

export interface MobileSetupRemedy {
  label: string;
  action: 'retry' | 'open-url' | 'copy-command';
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
  failure?: MobileSetupFailure;
  devices: MobileSetupDevice[];
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

  const posture = mobileAuthPosture();
  const blocking = posture.gaps.find((gap) => gap.blocking);
  if (blocking) {
    return {
      phase: 'error',
      headline: 'Mobile access is not safe to turn on yet',
      qrReady: false,
      devices,
      failure: {
        code: 'AUTH_POSTURE',
        message: blocking.message,
        remedy: { label: 'Try again', action: 'retry' },
      },
    };
  }

  if (payload.target.qrReady) {
    return {
      phase: 'live',
      headline: 'Scan from the Clem app on your iPhone',
      detail: 'Open the Clem app and point it at this code. The phone connects straight to this Mac — nothing in between.',
      url: payload.target.url,
      qrReady: true,
      devices,
    };
  }

  if (payload.target.mode === 'local-preview') {
    return {
      phase: 'error',
      headline: 'The mobile door is closed',
      qrReady: false,
      devices,
      failure: {
        code: 'DOOR_CLOSED',
        message: payload.target.qrBlockedReason
          ?? 'The direct-app door did not open, so a phone cannot reach this Mac.',
        remedy: { label: 'Try again', action: 'retry' },
      },
    };
  }

  // Door is open but the QR is blocked (e.g. no LAN address yet). Not an
  // error the user must fix in Clementine — just not ready to scan.
  return {
    phase: 'not-set-up',
    headline: 'Use Clementine on your phone',
    detail: payload.target.qrBlockedReason
      ?? 'Scan a code from the Clem app to pair this Mac.',
    qrReady: false,
    devices,
  };
}

/** Confirms the daemon is actually answering before we point a phone at it. */
async function localSurfaceReachable(opts?: { fetchImpl?: typeof fetch }): Promise<boolean> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await doFetch(`http://127.0.0.1:${WEBHOOK_PORT}/m/health`, { signal: controller.signal });
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
  /** Test seam so polling does not really sleep. */
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

  // Is there anything to point a phone AT?
  if (!(await localSurfaceReachable({ fetchImpl: opts?.fetchImpl }))) {
    return finish(failure(
      'PORT_UNREACHABLE',
      'Clementine’s local server is not responding, so there is nothing to link to yet.',
      { label: 'Try again', action: 'retry' },
    ));
  }

  const view = mobileSetupView(await getMobileAccessStatusPayload());
  if (view.qrReady) return { ok: true, view };
  if (view.failure) return { ok: false, failure: view.failure, view };
  return { ok: false, view };
}
