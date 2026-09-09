/**
 * One review queue: fact duplicates and transient requests (the memory review
 * candidates) and possible duplicate people (entity identity candidates),
 * each with its decision inline. No confirm dialogs — every action here is
 * reversible on the server.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  applyMemoryReviewCandidate, dismissEntityDuplicateCandidate, dismissMemoryReviewCandidate, listEntityDuplicateCandidates,
  listMemoryReviewCandidates, mergeEntityIdentity, type EntityDuplicateCandidate, type MemoryReviewCandidate,
} from '@/lib/memory';

function factLine(c: MemoryReviewCandidate): { title: string; detail: string } {
  if (c.kind === 'merge_duplicate') {
    const keep = c.targetFacts.find((f) => Number(f.id) === (c.payload?.keepId ?? c.targetIds[0]));
    const drop = c.targetFacts.find((f) => Number(f.id) === (c.payload?.dropId ?? c.targetIds[1]));
    return { title: 'Two versions of the same thing', detail: `“${(keep?.content ?? '').slice(0, 90)}” and “${(drop?.content ?? '').slice(0, 90)}”` };
  }
  return { title: 'A one-off request, not a memory', detail: `“${(c.targetFacts[0]?.content ?? '').slice(0, 120)}”` };
}

export function ReviewPane({ onCounts }: { onCounts?: (n: { review: number; duplicates: number }) => void }) {
  const qc = useQueryClient();
  const review = usePoll(['mem-review'], () => listMemoryReviewCandidates(8), 30_000);
  const people = usePoll(['mem-dups'], () => listEntityDuplicateCandidates(8), 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['mem-review'] }); void qc.invalidateQueries({ queryKey: ['mem-dups'] }); void qc.invalidateQueries({ queryKey: ['facts'] }); void qc.invalidateQueries({ queryKey: ['mem-health'] }); };
  const act = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); try { await fn(); } finally { setBusy(null); refresh(); } };
  const facts = review.data?.candidates ?? [];
  const dups = (people.data?.candidates ?? []) as EntityDuplicateCandidate[];
  const total = (review.data?.total ?? facts.length) + dups.length;
  onCounts?.({ review: review.data?.total ?? facts.length, duplicates: dups.length });
  return (
    <section className="rounded-lg border border-border bg-surface p-3.5 shadow-xs" aria-labelledby="mem-review-h">
      <h3 id="mem-review-h" className="mb-2 flex items-center gap-2 text-body font-semibold text-fg">Needs review <StatusPill tone={total > 0 ? 'warning' : 'success'}>{total}</StatusPill></h3>
      {review.isLoading && people.isLoading ? <p className="text-small text-faint">Looking…</p>
        : total === 0 ? <p className="text-small text-muted">Caught up. She'll leave anything doubtful here.</p>
        : (
          <ul className="space-y-2">
            {dups.slice(0, 3).map((d) => {
              const [a, b] = d.entities;
              if (!a || !b) return null;
              const canonical = d.entities.find((e) => e.id === d.suggestedCanonicalId) ?? a;
              const other = d.entities.find((e) => e.id !== canonical.id) ?? b;
              return (
                <li key={d.id} className="grid grid-cols-[1fr_auto] items-center gap-3 text-small">
                  <span className="min-w-0 text-muted"><span className="font-medium text-fg">{a.name}</span> and <span className="font-medium text-fg">{b.name}</span> look like one {d.entityType}</span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => act(d.id, () => mergeEntityIdentity(other.id, canonical.id))}>Merge</Button>
                    <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => act(d.id, () => dismissEntityDuplicateCandidate(d.entities.map((e) => e.id)))}>Not same</Button>
                  </span>
                </li>
              );
            })}
            {facts.slice(0, 4).map((c) => {
              const line = factLine(c);
              return (
                <li key={c.id} className="grid grid-cols-[1fr_auto] items-center gap-3 text-small">
                  <span className="min-w-0 text-muted"><span className="font-medium text-fg">{line.title}</span> — {line.detail}</span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => act(c.id, () => applyMemoryReviewCandidate(c.id))}>{c.kind === 'merge_duplicate' ? 'Keep one' : 'Forget'}</Button>
                    <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => act(c.id, () => dismissMemoryReviewCandidate(c.id))}>{c.kind === 'merge_duplicate' ? 'Keep both' : 'Keep'}</Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
