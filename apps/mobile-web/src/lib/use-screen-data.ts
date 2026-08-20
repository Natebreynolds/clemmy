/**
 * One data-loading discipline for every screen, so robustness is a property
 * of the app instead of a per-screen accident.
 *
 * What every screen gets by using this instead of a hand-rolled useEffect:
 *  - STALE-WHILE-REVALIDATE: the last good data stays on screen during any
 *    refresh or failure. A screen that has ever rendered never blanks back
 *    to "Loading…".
 *  - WAKE-UP REFRESH: iOS suspends the webview on lock/app-switch and
 *    freezes timers and sockets. Every screen now refetches when the page
 *    becomes visible again, when the network returns, and on the shell's
 *    pull-to-refresh — the same triggers that revived the chat stream.
 *  - HONEST FAILURE: a transport failure surfaces as offline (with the last
 *    data still shown), not as a silent stale screen or a raw error string.
 *  - ONE ATTEMPT IN FLIGHT: wake-up triggers can stack (pageshow +
 *    visibilitychange fire together); concurrent refreshes collapse.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { isOfflineError } from './api';
import { REFRESH_EVENT } from './native-bridge';

export interface ScreenData<T> {
  /** Last successfully loaded value; survives later failures. */
  data: T | null;
  /** True only before the FIRST successful load. */
  loading: boolean;
  /** A refresh is running behind existing data. */
  refreshing: boolean;
  /** Human-safe message for the last failure; null after any success. */
  error: string | null;
  /** The last failure was transport-level (daemon unreachable). */
  offline: boolean;
  refresh: () => Promise<void>;
}

export function useScreenData<T>(
  load: () => Promise<T>,
  options?: {
    /** Re-poll interval while the page is visible; 0/undefined = no polling. */
    intervalMs?: number;
    /** Skip loading entirely (screen not ready — e.g. no session yet). */
    disabled?: boolean;
  },
): ScreenData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!options?.disabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const disabled = options?.disabled === true;

  const refresh = useCallback(async (): Promise<void> => {
    if (disabled) return;
    if (inFlight.current) return inFlight.current;
    const attempt = (async () => {
      setRefreshing(true);
      try {
        const value = await loadRef.current();
        setData(() => value);
        setError(null);
        setOffline(false);
      } catch (err) {
        // Keep the last good data — the failure is reported alongside it,
        // never by blanking the screen.
        setOffline(isOfflineError(err));
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setRefreshing(false);
        setLoading(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = attempt;
    return attempt;
  }, [disabled]);

  useEffect(() => {
    if (disabled) { setLoading(false); return; }
    void refresh();
    const onWake = (): void => { void refresh(); };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener(REFRESH_EVENT, onWake);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (options?.intervalMs && options.intervalMs > 0) {
      timer = setInterval(() => {
        // A hidden page's interval either doesn't fire (suspended) or would
        // waste the radio; the wake-up refresh covers the return.
        if (document.visibilityState === 'visible') void refresh();
      }, options.intervalMs);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener(REFRESH_EVENT, onWake);
      if (timer) clearInterval(timer);
    };
  }, [refresh, disabled, options?.intervalMs]);

  return { data, loading, refreshing, error, offline, refresh };
}
