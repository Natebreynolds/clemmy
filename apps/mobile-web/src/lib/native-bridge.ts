/**
 * Bridge for the native iOS shell (the Clem app wrapping this PWA in a
 * pinned WKWebView).
 *
 * The native side owns the APNs registration ceremony (permission prompt,
 * device token), but it deliberately does NOT own an authenticated transport
 * — the device-bound session key lives in this page's IndexedDB and is
 * non-extractable by design. So the shell hands the token to the page and the
 * page registers it through the normal proof-signed api() path. One auth
 * path, no second credential.
 *
 * Resilience: a token can arrive before the session exists (first launch
 * races pairing) or while the daemon is briefly unreachable. Failed
 * registrations park the token in localStorage and retry on the next app
 * boot — registration is idempotent per device on the daemon side.
 */
import { registerApnsToken } from './api';

const PENDING_KEY = 'clem.apns.pending';

/** Where the phone is talking to the Mac from — published by the shell. */
export type ConnectionDoor = 'direct' | 'relay' | 'offline';

declare global {
  interface Window {
    clemNative?: {
      registerApnsToken(deviceToken: string): void;
      /** Called by the shell's pull-to-refresh. */
      refresh?(): void;
      /** Called by the shell when the door or reachability changes. */
      setConnection?(door: ConnectionDoor): void;
      /** Native durably parked this exact relay lease in Keychain. */
      originHandoffStored?(value: { handoffId: string; generation: number }): void;
    };
    webkit?: {
      messageHandlers?: Record<string, { postMessage(body: unknown): void } | undefined>;
    };
  }
}

export type HapticKind = 'light' | 'medium' | 'success' | 'warning' | 'error';

/**
 * Weight under the thumb. Silently absent in a plain browser — the app must
 * never depend on the shell being there, only feel better when it is.
 */
export function haptic(kind: HapticKind = 'light'): void {
  try {
    window.webkit?.messageHandlers?.clemHaptic?.postMessage(kind);
  } catch { /* not in the native shell */ }
}

/** True when the pinned native shell is hosting this page. */
export function inNativeShell(): boolean {
  return Boolean(window.webkit?.messageHandlers?.clemHaptic);
}

/**
 * Park an origin-handoff token with the native shell.
 *
 * The shell is the only thing that survives an origin switch: cookies and the
 * device key are per-origin, so when the app moves to the relay door it needs
 * a credential the page itself cannot carry. The web layer mints the token on
 * the LAN (where trust was established) and hands it over; the shell appends
 * it as `?adopt=` when it loads the relay origin. Absent shell = no-op, and
 * the token simply expires unused.
 */
export interface OriginHandoffLeaseMessage {
  version: 2;
  token: string;
  expiresAt: number;
  handoffId: string;
  generation: number;
  deviceId: string;
}

export function parkOriginHandoff(lease: OriginHandoffLeaseMessage): boolean {
  try {
    const handler = window.webkit?.messageHandlers?.clemHandoff;
    if (!handler) return false;
    handler.postMessage(lease);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm the exact leased token was consumed or explicitly rejected.
 * Transport failures never call this: the Keychain copy remains retryable.
 */
export function reportOriginHandoffResult(
  handoffId: string,
  generation: number,
  outcome: 'consumed' | 'invalid',
): boolean {
  try {
    const handler = window.webkit?.messageHandlers?.clemHandoffResult;
    if (!handler) return false;
    handler.postMessage({ handoffId, generation, outcome });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the native shell to clear its pairing and show the scanner.
 *
 * The stranded state this fixes (live): the web session expires inside a
 * PAIRED native app — the login screen says "scan the QR" but the shell,
 * still holding a pairing, never shows its scanner; the only escape was the
 * undiscoverable shake gesture. Returns false when there is no shell (plain
 * browser) or the shell predates the handler, so the caller can fall back to
 * instructions instead of a dead button.
 */
export function requestNativeRepair(): boolean {
  try {
    const handler = window.webkit?.messageHandlers?.clemRepair;
    if (!handler) return false;
    handler.postMessage('repair');
    return true;
  } catch {
    return false;
  }
}

/** Fires when the shell reports a new connection door. */
export const CONNECTION_EVENT = 'clem:connection';
export const ORIGIN_HANDOFF_STORED_EVENT = 'clem:origin-handoff-stored';
/** Fires when the shell's pull-to-refresh asks the page for fresh data. */
export const REFRESH_EVENT = 'clem:refresh';

let currentDoor: ConnectionDoor | null = null;
export function connectionDoor(): ConnectionDoor | null {
  return currentDoor;
}
export function setConnectionDoor(door: ConnectionDoor): void {
  if (currentDoor === door) return;
  currentDoor = door;
  window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: door }));
}

/**
 * Tell the native shell that the currently loaded origin stopped answering.
 *
 * A failed fetch does not fail the WKWebView navigation that originally
 * loaded the PWA, so Swift cannot otherwise know it should run the
 * LAN -> Bonjour -> relay reconnect ladder. Plain browsers have no handler
 * and simply keep the existing offline/retry behavior.
 */
export function reportConnectionLost(): boolean {
  try {
    const handler = window.webkit?.messageHandlers?.clemConnectionLost;
    if (!handler) return false;
    handler.postMessage('offline');
    return true;
  } catch {
    return false;
  }
}

async function tryRegister(deviceToken: string): Promise<boolean> {
  try {
    await registerApnsToken(deviceToken);
    try { localStorage.removeItem(PENDING_KEY); } catch { /* private browsing */ }
    return true;
  } catch {
    try { localStorage.setItem(PENDING_KEY, deviceToken); } catch { /* private browsing */ }
    return false;
  }
}

/** Installed once at app bootstrap; also drains a parked token from a prior failed attempt. */
export function installNativeBridge(): void {
  window.clemNative = {
    registerApnsToken(deviceToken: string): void {
      void tryRegister(deviceToken);
    },
    refresh(): void {
      window.dispatchEvent(new Event(REFRESH_EVENT));
    },
    setConnection(door: ConnectionDoor): void {
      setConnectionDoor(door);
    },
    originHandoffStored(value): void {
      if (
        !value
        || typeof value.handoffId !== 'string'
        || !Number.isSafeInteger(value.generation)
        || value.generation <= 0
      ) return;
      window.dispatchEvent(new CustomEvent(ORIGIN_HANDOFF_STORED_EVENT, { detail: value }));
    },
  };
  let pending: string | null = null;
  try { pending = localStorage.getItem(PENDING_KEY); } catch { /* private browsing */ }
  if (pending) void tryRegister(pending);

  // In a plain browser (or before the shell speaks) the platform's own
  // signals are the best available truth.
  window.addEventListener('offline', () => setConnectionDoor('offline'));
  window.addEventListener('online', () => setConnectionDoor('direct'));
}
