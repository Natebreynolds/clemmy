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

declare global {
  interface Window {
    clemNative?: {
      registerApnsToken(deviceToken: string): void;
    };
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
  };
  let pending: string | null = null;
  try { pending = localStorage.getItem(PENDING_KEY); } catch { /* private browsing */ }
  if (pending) void tryRegister(pending);
}
