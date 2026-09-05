import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_HOME_PREFERENCES,
  HOME_PREFS_KEY,
  useSaveHomePreferences,
  type HomePreferences,
} from '@/lib/home-prefs';

export type CustomizeSaveStatus = 'idle' | 'saving' | 'error';

/**
 * Serialized, coalescing saver for the Customize sheet.
 *
 * Every edit lands in the query cache immediately (so Home behind the sheet
 * re-renders with it) and is PATCHed in order — one request in flight at a
 * time, later edits merged into the next request — so a burst of toggles
 * can't race and settle out of order. On failure the cache is refetched from
 * the server (the truth behind the sheet) and the caller shows one line.
 */
export function useCustomizeSaver() {
  const qc = useQueryClient();
  const mutation = useSaveHomePreferences();
  const mutateRef = useRef(mutation.mutateAsync);
  mutateRef.current = mutation.mutateAsync;

  const queue = useRef<Partial<HomePreferences> | null>(null);
  const inflight = useRef(false);
  const [status, setStatus] = useState<CustomizeSaveStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (inflight.current) return;
    const patch = queue.current;
    queue.current = null;
    if (!patch) return;
    inflight.current = true;
    setStatus('saving');
    try {
      await mutateRef.current(patch);
      const pending: Partial<HomePreferences> | null = queue.current;
      if (pending) {
        // The server's reply just replaced the cache; put the not-yet-sent
        // edits back on top so Home doesn't flicker to a stale state.
        const reapply: Partial<HomePreferences> = pending;
        qc.setQueryData<HomePreferences>(HOME_PREFS_KEY, (old) => ({ ...(old ?? DEFAULT_HOME_PREFERENCES), ...reapply }));
      } else {
        setStatus('idle');
        setMessage(null);
      }
    } catch (err) {
      queue.current = null;
      setStatus('error');
      setMessage(err instanceof Error && err.message ? err.message : 'Clementine did not answer');
      void qc.invalidateQueries({ queryKey: HOME_PREFS_KEY });
    } finally {
      inflight.current = false;
      if (queue.current) void run();
    }
  }

  function enqueue(patch: Partial<HomePreferences>) {
    queue.current = { ...(queue.current ?? {}), ...patch };
    qc.setQueryData<HomePreferences>(HOME_PREFS_KEY, (old) => ({ ...(old ?? DEFAULT_HOME_PREFERENCES), ...patch }));
    void run();
  }

  return { status, message, enqueue };
}
