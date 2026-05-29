/**
 * Browser-side Web Push wiring.
 *
 * Flow:
 *   1. The PWA loads the daemon's VAPID public key via /m/push/vapid-key.
 *   2. After login, App.tsx checks `canRequestPush()`. If push is
 *      supported but not yet subscribed AND not previously declined,
 *      it shows a one-tap "Enable notifications" prompt.
 *   3. `requestAndSubscribe()` calls Notification.requestPermission
 *      then pushManager.subscribe and POSTs the result to
 *      /m/push/subscribe via api.ts.
 *   4. Decline state ("user dismissed") is persisted in localStorage
 *      so we don't re-prompt every load.
 *
 * iOS-specific: Web Push only works for PWAs added to the Home
 * Screen on iOS 16.4+. `pushSupported()` returns false in regular
 * Safari tabs, and the UI renders an "open in Add to Home Screen"
 * hint instead.
 */

import { getVapidPublicKey, registerPushSubscription, unregisterPushSubscription } from './api';

const DECLINED_KEY = 'clem.push.declined';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalonePwa(): boolean {
  // iOS sets navigator.standalone; other browsers use display-mode.
  const navAny = navigator as Navigator & { standalone?: boolean };
  return Boolean(navAny.standalone) || window.matchMedia('(display-mode: standalone)').matches;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

export function pushDeclined(): boolean {
  try { return localStorage.getItem(DECLINED_KEY) === '1'; } catch { return false; }
}

export function markPushDeclined(declined: boolean): void {
  try {
    if (declined) localStorage.setItem(DECLINED_KEY, '1');
    else localStorage.removeItem(DECLINED_KEY);
  } catch { /* private browsing — ignore */ }
}

/**
 * Returns the current subscription if the SW already has one, else
 * null. Used so the App shell can show "Notifications: on" without
 * re-prompting.
 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/m/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export async function requestAndSubscribe(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  // Permission must be requested in response to a user gesture, which
  // the caller (button click) provides.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    markPushDeclined(true);
    return { ok: false, reason: `permission ${permission}` };
  }
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await registerPushSubscription(existing);
    markPushDeclined(false);
    return { ok: true };
  }
  let publicKey: string;
  try {
    publicKey = await getVapidPublicKey();
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? 'vapid-key-failed' };
  }
  try {
    const keyBytes = urlBase64ToUint8Array(publicKey);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // .buffer is `ArrayBufferLike`; PushManager wants a strict
      // ArrayBuffer. The runtime payload is identical.
      applicationServerKey: keyBytes.buffer as ArrayBuffer,
    });
    await registerPushSubscription(sub);
    markPushDeclined(false);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? 'subscribe-failed' };
  }
}

export async function unsubscribePush(): Promise<void> {
  const existing = await getExistingSubscription();
  if (!existing) return;
  try { await unregisterPushSubscription(existing.endpoint); } catch { /* best effort */ }
  try { await existing.unsubscribe(); } catch { /* best effort */ }
  markPushDeclined(true);
}
