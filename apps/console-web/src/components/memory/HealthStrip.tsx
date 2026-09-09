/**
 * Three things the header does not already say: people & things, what needs
 * review, and when memory was last tidied. Idle state only — a search
 * replaces it with matches.
 */
import type { MemoryHealth } from '@/lib/memory';
import { relativeTime } from '@/lib/inbox';

function Tile({ value, label, note, tone }: { value: string; label: string; note?: string; tone?: 'up' | 'warn' }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 shadow-xs">
      <span className="text-h2 tabular-nums text-fg">{value}</span>
      <span className="min-w-0"><span className="block truncate text-small text-fg">{label}</span>{note && <span className={`block truncate text-caption ${tone === 'up' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-faint'}`}>{note}</span>}</span>
    </div>
  );
}

export function HealthStrip({ health, review, duplicates }: { health?: MemoryHealth; review: number; duplicates: number }) {
  const tidy = health?.lastHygiene ?? null;
  const tidyWhen = tidy ? relativeTime(tidy.at) : '';
  const tidyWhat = tidy ? `${tidy.kind.replace(/-/g, ' ')} · ${tidy.count} ${tidy.count === 1 ? 'memory' : 'memories'}` : 'no tidy recorded yet';
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      <Tile value={String(health?.entities ?? 0)} label="people & things" note={health?.entityIdentity?.conflicts ? `${health.entityIdentity.conflicts} identity ${health.entityIdentity.conflicts === 1 ? 'conflict' : 'conflicts'}` : 'no identity conflicts'} tone={health?.entityIdentity?.conflicts ? 'warn' : undefined} />
      <Tile value={String(review + duplicates)} label="need your review" note={duplicates > 0 ? `${duplicates} possible ${duplicates === 1 ? 'duplicate' : 'duplicates'}` : review > 0 ? 'facts to keep or fold' : 'caught up'} tone={review + duplicates > 0 ? 'warn' : 'up'} />
      <Tile value={tidy ? tidyWhen : '—'} label={tidy ? 'last tidied' : 'last tidied'} note={tidyWhat} />
    </div>
  );
}
