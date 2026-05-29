import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  getExistingSubscription,
  isStandalonePwa,
  markPushDeclined,
  pushDeclined,
  pushPermission,
  pushSupported,
  requestAndSubscribe,
} from '../lib/push';

type State =
  | { kind: 'hidden' }
  | { kind: 'unsupported' }
  | { kind: 'needs-pwa-install' }
  | { kind: 'prompt' }
  | { kind: 'enabling' }
  | { kind: 'enabled' }
  | { kind: 'error'; message: string };

/**
 * Inline post-login banner that asks for push permission once. After
 * the user clicks enable or dismisses, this hides itself for the rest
 * of the session (and persists 'declined' so we don't re-prompt on
 * every load).
 */
export function PushPrompt() {
  const [state, setState] = useState<State>({ kind: 'hidden' });

  useEffect(() => {
    let cancelled = false;
    async function decide() {
      if (!pushSupported()) {
        if (!cancelled) setState({ kind: 'unsupported' });
        return;
      }
      // iOS Safari: Web Push only works after Add-to-Home-Screen.
      // navigator.standalone is the iOS signal; on Android / desktop
      // we don't need the PWA install — Web Push works in the tab.
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (isIOS && !isStandalonePwa()) {
        if (!cancelled) setState({ kind: 'needs-pwa-install' });
        return;
      }
      const existing = await getExistingSubscription();
      if (existing) {
        if (!cancelled) setState({ kind: 'enabled' });
        return;
      }
      const perm = pushPermission();
      if (perm === 'denied') {
        if (!cancelled) setState({ kind: 'hidden' });
        return;
      }
      if (perm === 'granted') {
        // Permission granted but no subscription — re-subscribe silently.
        const result = await requestAndSubscribe();
        if (!cancelled) setState(result.ok ? { kind: 'enabled' } : { kind: 'prompt' });
        return;
      }
      if (pushDeclined()) {
        if (!cancelled) setState({ kind: 'hidden' });
        return;
      }
      if (!cancelled) setState({ kind: 'prompt' });
    }
    decide();
    return () => { cancelled = true; };
  }, []);

  const enable = useCallback(async () => {
    setState({ kind: 'enabling' });
    const result = await requestAndSubscribe();
    if (result.ok) setState({ kind: 'enabled' });
    else setState({ kind: 'error', message: result.reason });
  }, []);

  const dismiss = useCallback(() => {
    markPushDeclined(true);
    setState({ kind: 'hidden' });
  }, []);

  if (state.kind === 'hidden' || state.kind === 'enabled' || state.kind === 'unsupported') {
    return null;
  }

  if (state.kind === 'needs-pwa-install') {
    return (
      <div class="push-banner">
        <div class="push-banner-body">
          <strong>Install to get notifications</strong>
          <span>iOS needs you to <em>Add to Home Screen</em> first. Tap Share → Add to Home Screen, then reopen this app from your home screen.</span>
        </div>
        <button class="push-banner-dismiss" onClick={dismiss}>Not now</button>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div class="push-banner push-banner-error">
        <div class="push-banner-body">
          <strong>Couldn't enable notifications</strong>
          <span>{state.message}</span>
        </div>
        <button class="push-banner-dismiss" onClick={dismiss}>Close</button>
      </div>
    );
  }

  return (
    <div class="push-banner">
      <div class="push-banner-body">
        <strong>Enable notifications</strong>
        <span>Clem will push when an approval is waiting or she has a reply.</span>
      </div>
      <div class="push-banner-actions">
        <button class="push-banner-primary" disabled={state.kind === 'enabling'} onClick={enable}>
          {state.kind === 'enabling' ? '…' : 'Enable'}
        </button>
        <button class="push-banner-dismiss" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}
