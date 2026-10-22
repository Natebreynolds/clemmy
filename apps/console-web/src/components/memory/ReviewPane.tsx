/**
 * One review queue: fact duplicates and transient requests (the memory review
 * candidates) and possible duplicate people (entity identity candidates),
 * each with its decision inline. No confirm dialogs — every action here is
 * reversible on the server.
 */
import { useEffect, useState } from 'react';
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

export function ReviewPane({
  onCounts,
  onOpen,
  quietEmpty = false,
}: {
  /** Only a side that actually loaded. A failed read must not report 0. */
  onCounts?: (n: { review?: number; duplicates?: number }) => void;
  onOpen?: (tab: 'facts' | 'entities') => void;
  /** On a store tab, an empty queue says nothing. The overview still says it. */
  quietEmpty?: boolean;
}) {
  const qc = useQueryClient();
  const review = usePoll(['mem-review'], () => listMemoryReviewCandidates(8), 30_000);
  const people = usePoll(['mem-dups'], () => listEntityDuplicateCandidates(8), 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['mem-review'] }); void qc.invalidateQueries({ queryKey: ['mem-dups'] }); void qc.invalidateQueries({ queryKey: ['facts'] }); void qc.invalidateQueries({ queryKey: ['mem-health'] }); };
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t go through. Nothing was changed.');
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const facts = review.data?.candidates ?? [];
  const dups = (people.data?.candidates ?? []) as EntityDuplicateCandidate[];
  const factTotal = review.data?.total ?? facts.length;
  const peopleTotal = people.data?.total ?? dups.length;
  const reviewUnknown = review.isError && !review.data;
  const peopleUnknown = people.isError && !people.data;
  // A failed read is not an empty queue. Report only the sides that answered,
  // in one patch so a parent setState cannot drop the other side.
  const loadedReview = review.data ? factTotal : null;
  const loadedPeople = people.data ? peopleTotal : null;
  useEffect(() => {
    const patch: { review?: number; duplicates?: number } = {};
    if (loadedReview != null) patch.review = loadedReview;
    if (loadedPeople != null) patch.duplicates = loadedPeople;
    if (patch.review != null || patch.duplicates != null) onCounts?.(patch);
  }, [loadedReview, loadedPeople, onCounts]);
  const total = (review.data ? factTotal : 0) + (people.data ? peopleTotal : 0);
  // One side answering empty is not "caught up" while the other is still loading.
  const sidePending = (query: { data?: unknown; isError: boolean; isLoading: boolean }) => !query.data && !query.isError && query.isLoading;
  const loading = total === 0 && (sidePending(review) || sidePending(people));
  if (reviewUnknown && peopleUnknown) {
    return (
      <p className="text-small text-muted">
        The review queue couldn’t be read just now.{' '}
        <button type="button" onClick={() => { void review.refetch(); void people.refetch(); }} className="cursor-pointer font-medium text-primary hover:underline">Try again</button>
      </p>
    );
  }
  if (loading) return <p className="text-small text-faint">Checking for decisions…</p>;
  if (total === 0 && !reviewUnknown && !peopleUnknown) {
    if (quietEmpty) return null;
    return <p className="text-small text-muted">Nothing doubtful is waiting.</p>;
  }
  const shownFacts = facts.slice(0, 4);
  const shownPeople = dups.slice(0, 3);
  return (
    <section className="rounded-lg border border-border bg-surface p-3.5 shadow-xs" aria-labelledby="mem-review-h">
      <h3 id="mem-review-h" className="mb-2 flex items-center gap-2 text-body font-semibold text-fg">Needs a decision <StatusPill tone="warning">{total}</StatusPill></h3>
      {(reviewUnknown || peopleUnknown) && (
        <p className="mb-2 text-caption text-warning">{reviewUnknown ? 'Fact cleanup couldn’t be read.' : 'Possible duplicates couldn’t be read.'}</p>
      )}
      {error && <p className="mb-2 text-small text-danger" role="status">{error}</p>}
      {total === 0 ? null : (
          <ul className="space-y-2">
            {shownPeople.map((d) => {
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
            {shownFacts.map((c) => {
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
      {(factTotal > shownFacts.length || peopleTotal > shownPeople.length) && onOpen && (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption">
          {peopleTotal > shownPeople.length && (
            <button type="button" onClick={() => onOpen('entities')} className="cursor-pointer font-semibold text-primary hover:underline">
              All {peopleTotal} possible duplicates
            </button>
          )}
          {factTotal > shownFacts.length && (
            <button type="button" onClick={() => onOpen('facts')} className="cursor-pointer font-semibold text-primary hover:underline">
              All {factTotal} fact decisions
            </button>
          )}
        </p>
      )}
    </section>
  );
}
