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

/** Fires when the shell reports a new connection door. */
export const CONNECTION_EVENT = 'clem:connection';
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
  };
  let pending: string | null = null;
  try { pending = localStorage.getItem(PENDING_KEY); } catch { /* private browsing */ }
  if (pending) void tryRegister(pending);

  // In a plain browser (or before the shell speaks) the platform's own
  // signals are the best available truth.
  window.addEventListener('offline', () => setConnectionDoor('offline'));
  window.addEventListener('online', () => setConnectionDoor('direct'));
}
