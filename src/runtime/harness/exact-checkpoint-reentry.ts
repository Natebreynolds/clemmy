/**
 * The exact-checkpoint re-entry budget — shared, dependency-free state.
 *
 * A private HostRecoveryState is deliberately retried: a hold means "this
 * exact frame is still owned, come back for it", and the periodic scanner,
 * the runner's own immediate re-entry, and the legacy approval-resume path
 * all do. When the underlying admission can never succeed again — the frozen
 * recovery blob's chain no longer matches `accepted_model_batch_checkpoints`,
 * which the replay path never re-derives — that invitation is an infinite
 * loop. Live: 1,054 re-entries (09-01 10:50Z), 1,006 (09-01 18:30Z), 454
 * (09-02, run 5) at one to two per second until the daemon was killed.
 *
 * The budget therefore counts where the admission FAILS, not where a caller
 * dispatches. Counting dispatches only bounded ONE of the three entry points
 * and left the other two free to loop. It lives in this leaf module because
 * both owners — the scanner (restart-recovery) and the host runner — must
 * share one Map, and restart-recovery already sits downstream of the runner
 * through delivery-committer.
 *
 * A count is per (session, source, phase, frame) in THIS process: a new
 * checkpoint (progress) starts a new count, and a restart starts over, so a
 * genuinely transient store failure is never permanently terminalized.
 */
export const EXACT_CHECKPOINT_REENTRY_BUDGET = 5;

const exactCheckpointReentries = new Map<string, number>();
const exactCheckpointReentryNoticed = new Set<string>();

export function exactCheckpointReentryKey(
  sessionId: string,
  descriptor: { sourceUserSeq: number; phase: string; frameCallIds: readonly string[] },
): string {
  return `${sessionId}:${descriptor.sourceUserSeq}:${descriptor.phase}:${descriptor.frameCallIds.join('|')}`;
}

/** The frame's call ids, in order, as the re-entry key sees them.
 *
 * The budget only converges if every entry point derives the SAME key. The
 * scanner reads them back out of the serialized recovery blob while the host
 * holds the live `frameHistory` it is about to serialize; both must agree
 * exactly, so both call this. */
export function exactCheckpointFrameCallIds(frameHistory: unknown): string[] {
  return Array.isArray(frameHistory)
    ? frameHistory.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        return row.type === 'function_call' && typeof row.callId === 'string' && row.callId.trim()
          ? [row.callId.trim()]
          : [];
      })
    : [];
}

/** Count one failed admission of the exact checkpoint `key`. */
export function noteExactCheckpointReentry(key: string): { count: number; exhausted: boolean } {
  const count = (exactCheckpointReentries.get(key) ?? 0) + 1;
  exactCheckpointReentries.set(key, count);
  return { count, exhausted: count >= EXACT_CHECKPOINT_REENTRY_BUDGET };
}

export function exactCheckpointReentryExhausted(key: string): boolean {
  return (exactCheckpointReentries.get(key) ?? 0) >= EXACT_CHECKPOINT_REENTRY_BUDGET;
}

/** True exactly once per key, so exhaustion is announced once and not on
 * every subsequent tick that skips the same spent checkpoint. */
export function claimExactCheckpointReentryNotice(key: string): boolean {
  if (exactCheckpointReentryNoticed.has(key)) return false;
  exactCheckpointReentryNoticed.add(key);
  return true;
}

export function _resetExactCheckpointReentriesForTests(): void {
  exactCheckpointReentries.clear();
  exactCheckpointReentryNoticed.clear();
}
