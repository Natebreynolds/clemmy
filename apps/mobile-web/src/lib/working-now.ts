/**
 * The working-now snapshot — polled ONCE for the whole app.
 *
 * Home, the header chip, and the running-tasks sheet all render the same
 * server-owned projection. Before this store each of them ran its own poll
 * of the same route, so three cadences could disagree about what was running.
 * Now the shell keeps one poll alive while signed in; every reader subscribes
 * to that one snapshot and its one clock.
 */
import { useEffect } from 'preact/hooks';
import { isOfflineError, listWorkingNow, type ActivityEntry } from './api';
import { REFRESH_EVENT } from './native-bridge';
import { createLiveStore, useLiveStore } from './live-store';

export interface WorkingNowSnapshot {
  /** The server's own clock: elapsed is observedAt−startedAt, never the phone's. */
  observedAt: string;
  entries: ActivityEntry[];
}

export interface WorkingNowState {
  data: WorkingNowSnapshot | null;
  /** True once the route has answered at least once this session. */
  known: boolean;
  error: string | null;
  offline: boolean;
}

const POLL_MS = 4_000;
const EMPTY: WorkingNowState = { data: null, known: false, error: null, offline: false };
const store = createLiveStore<WorkingNowState>(EMPTY);

let subscribers = 0;
let timer: number | null = null;
let inFlight: Promise<void> | null = null;

export function refreshWorkingNow(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = listWorkingNow()
    .then((snapshot) => {
      store.set((s) => ({ ...s, data: snapshot, known: true, error: null, offline: false }));
    }, (err: unknown) => {
      // Keep the last good snapshot on screen; report the miss beside it.
      store.set((s) => ({
        ...s,
        offline: isOfflineError(err),
        error: err instanceof Error ? err.message : 'Could not read current work',
      }));
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

const onWake = (): void => { void refreshWorkingNow(); };
const onVisible = (): void => { if (document.visibilityState === 'visible') void refreshWorkingNow(); };

function start(): void {
  void refreshWorkingNow();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('online', onWake);
  window.addEventListener(REFRESH_EVENT, onWake);
  timer = window.setInterval(() => {
    // A hidden page's interval either doesn't fire or wastes the radio; the
    // wake-up refresh covers the return.
    if (document.visibilityState === 'visible') void refreshWorkingNow();
  }, POLL_MS);
}

function stop(): void {
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('pageshow', onWake);
  window.removeEventListener('online', onWake);
  window.removeEventListener(REFRESH_EVENT, onWake);
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  // A signed-out shell must not carry a stale snapshot into the next session.
  store.set(EMPTY);
}

/**
 * Subscribe to the shared snapshot. The first enabled subscriber starts the
 * poll and the last one stops it; the shell subscribes while signed in so the
 * poll outlives any one screen.
 */
export function useWorkingNow(enabled = true): WorkingNowState & { refresh: () => Promise<void> } {
  const state = useLiveStore(store);
  useEffect(() => {
    if (!enabled) return;
    subscribers += 1;
    if (subscribers === 1) start();
    return () => {
      subscribers -= 1;
      if (subscribers === 0) stop();
    };
  }, [enabled]);
  return { ...state, refresh: refreshWorkingNow };
}
