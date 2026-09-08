/** Retain the last good value only for the exact resource being displayed. */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { isOfflineError } from './api';
import { REFRESH_EVENT } from './native-bridge';

export interface ScreenData<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  offline: boolean;
  /** Last successful read, not a certificate that a remembered response is live. */
  updatedAt: number | null;
  /** A failed refresh cannot leave retained in-memory data looking current. */
  stale: boolean;
  refresh: () => Promise<void>;
}

interface ResourceOwner {
  key: string | null;
  active: boolean;
  inFlight: Promise<void> | null;
}
interface Snapshot<T> extends Omit<ScreenData<T>, 'refresh'> { owner: ResourceOwner }
function emptySnapshot<T>(owner: ResourceOwner, disabled: boolean): Snapshot<T> {
  return { owner, data: null, loading: !disabled, refreshing: false, error: null,
    offline: false, updatedAt: null, stale: true };
}

export function useScreenData<T>(load: () => Promise<T>, options?: {
  intervalMs?: number;
  disabled?: boolean;
  /** Identity of the fetched resource; changing it resets before paint. */
  resourceKey?: string;
}): ScreenData<T> {
  const key = options?.resourceKey ?? null;
  const ownerRef = useRef<ResourceOwner>({ key, active: true, inFlight: null });
  if (ownerRef.current.key !== key) {
    ownerRef.current.active = false;
    ownerRef.current = { key, active: true, inFlight: null };
  }
  const owner = ownerRef.current;
  const disabled = options?.disabled === true;
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => emptySnapshot(owner, disabled));
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async (): Promise<void> => {
    if (disabled || !owner.active || ownerRef.current !== owner) return;
    if (owner.inFlight) return owner.inFlight;
    const current = () => owner.active && ownerRef.current === owner;
    const loader = loadRef.current;
    // Defer the loader to a microtask so even a synchronous throw settles after
    // the in-flight owner is installed. Wake events join this exact attempt.
    const attempt: Promise<void> = Promise.resolve().then(async () => {
      if (!current()) return;
      setSnapshot(previous => ({ ...(previous.owner === owner ? previous : emptySnapshot<T>(owner, disabled)), refreshing: true }));
      try {
        const value = await loader();
        if (!current()) return;
        setSnapshot({ owner, data: value, loading: false, refreshing: false, error: null,
          offline: false, stale: false, updatedAt: Date.now() });
      } catch (err) {
        if (!current()) return;
        setSnapshot(previous => ({ ...(previous.owner === owner ? previous : emptySnapshot<T>(owner, disabled)),
          refreshing: false, loading: false, stale: true, offline: isOfflineError(err),
          error: err instanceof Error ? err.message : 'Something went wrong' }));
      } finally {
        if (owner.inFlight === attempt) owner.inFlight = null;
      }
    });
    owner.inFlight = attempt;
    return attempt;
  }, [owner, disabled]);

  useEffect(() => {
    owner.active = true;
    return () => { owner.active = false; };
  }, [owner]);
  useEffect(() => {
    if (disabled) return;
    void refresh();
    const onWake = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener(REFRESH_EVENT, onWake);
    const timer = options?.intervalMs && options.intervalMs > 0
      ? setInterval(onVisible, options.intervalMs) : undefined;
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener(REFRESH_EVENT, onWake);
      if (timer) clearInterval(timer);
    };
  }, [refresh, disabled, options?.intervalMs]);

  // A -> B must never render A's data/action targets while waiting for effects.
  const visible = snapshot.owner === owner ? snapshot : emptySnapshot<T>(owner, disabled);
  return { data: visible.data, loading: disabled ? false : visible.loading,
    refreshing: visible.refreshing, error: visible.error, offline: visible.offline,
    updatedAt: visible.updatedAt, stale: visible.stale, refresh };
}
