/**
 * One line the header does not already say: people and things, what needs a
 * decision, and when memory was last tidied. A search replaces the whole
 * idle view, including this line.
 */
import type { MemoryHealth } from '@/lib/memory';
import { relativeTime } from '@/lib/inbox';

/**
 * `unavailable` is not the same as zero. Without it this strip answered a
 * failed health call with "0 people & things · no identity conflicts" and
 * "caught up" — three confident statements about a memory it had not been able
 * to read. On this screen of all screens, say so instead.
 */
export function HealthStrip({ health, review, duplicates, unavailable }: { health?: MemoryHealth; review: number | null; duplicates: number | null; unavailable?: boolean }) {
  if (unavailable) {
    return <p className="text-small text-muted">People, the review queue, and the last tidy couldn’t be read.</p>;
  }
  // Still loading is not a count. A zero here used to flash before the read landed.
  if (!health) return <p className="text-small text-faint">Reading memory health…</p>;
  const entities = typeof health.entities === 'number' ? health.entities.toLocaleString() : '—';
  const conflicts = health.entityIdentity?.conflicts ?? 0;
  const reviewKnown = review != null && duplicates != null;
  const waiting = (review ?? 0) + (duplicates ?? 0);
  const tidy = health.lastHygiene ?? null;
  const tidyWhen = tidy ? relativeTime(tidy.at) : '';
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-small text-muted">
      <span>
        <span className="font-semibold tabular-nums text-fg">{entities}</span>
        {' '}people & things
        {conflicts > 0 && <span className="text-warning"> · {conflicts} identity {conflicts === 1 ? 'conflict' : 'conflicts'}</span>}
      </span>
      {reviewKnown ? (
        <span className={waiting > 0 ? 'text-warning' : 'text-success'}>
          <span className="font-semibold tabular-nums">{waiting}</span>
          {' '}to review
          {(duplicates ?? 0) > 0 ? ` · ${duplicates} possible ${duplicates === 1 ? 'duplicate' : 'duplicates'}` : ''}
        </span>
      ) : (
        <span>Review queue still loading</span>
      )}
      <span>{tidy ? <>Last tidied {tidyWhen} · {tidy.kind.replace(/-/g, ' ')} · {tidy.count} {tidy.count === 1 ? 'memory' : 'memories'}</> : 'No tidy recorded yet'}</span>
    </p>
  );
}
