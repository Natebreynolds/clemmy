/**
 * What was learned in one place: the facts kept for a project, or for an
 * agent. Each says where it came from (told or learned, and from how many
 * sources) and where it applies. The full list, with every control, is the
 * Memory screen, which this links to already narrowed.
 */
import { Link } from 'react-router-dom';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { listFacts, type Fact } from '@/lib/memory';
import { factScopeKey, scopedFacts, type FactScopeFilter } from '@/lib/memory-scope';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { ScopeChip } from './ScopeChip';

/** Where the Memory screen opens narrowed to one scope. */
export function memoryScopePath(filter: FactScopeFilter): string {
  return `/memory?tab=facts&scope=${encodeURIComponent(factScopeKey(filter))}`;
}

function sourceLine(fact: Fact): string {
  const sources = (fact.evidence ?? []).filter((item) => item.excerpt?.trim()).length;
  return sources === 0 ? 'No source kept' : `${sources} source${sources === 1 ? '' : 's'}`;
}

export function ScopedFacts({
  filter,
  limit = 8,
  empty,
  unavailableTitle,
  compact,
}: {
  filter: Exclude<FactScopeFilter, { kind: 'all' }>;
  limit?: number;
  /** What an honest empty list says. */
  empty: string;
  unavailableTitle: string;
  /** A narrow column: tighter rows. */
  compact?: boolean;
}) {
  const facts = usePoll(['facts', 'scoped', factScopeKey(filter), limit], () => listFacts(undefined, limit, false, filter), 30_000);

  if (facts.isLoading && !facts.data) {
    return (
      <div className="space-y-2" role="status">
        <span className="sr-only">Loading what was learned</span>
        {[0, 1].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }
  if (facts.isError && !facts.data) {
    return (
      <QueryUnavailable
        title={unavailableTitle}
        description="Clementine couldn’t read it just now. Nothing has been lost or forgotten."
        onRetry={() => { void facts.refetch(); }}
        className={compact ? 'px-4 py-6' : 'py-8'}
      />
    );
  }

  const answer = scopedFacts(facts.data?.facts ?? [], filter);
  if (!answer.supported) {
    // The service answered with facts that do not say where they apply, so
    // none of them can be claimed for this place.
    return (
      <QueryUnavailable
        title={unavailableTitle}
        description="This version of Clementine’s service does not yet keep memory by project or agent. Nothing has been lost."
        onRetry={() => { void facts.refetch(); }}
        className={compact ? 'px-4 py-6' : 'py-8'}
      />
    );
  }
  if (answer.facts.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-4 py-3 text-small text-muted">{empty}</p>;
  }

  const total = facts.data?.total ?? answer.facts.length;
  return (
    <div>
      <ul className={cn('overflow-hidden rounded-lg border border-border bg-surface', compact && 'rounded-md')}>
        {answer.facts.map((fact) => (
          <li key={fact.id} className={cn('border-t border-border first:border-t-0', compact ? 'px-3 py-2.5' : 'px-5 py-3')}>
            <p className={cn('text-fg', compact ? 'line-clamp-4 text-small' : 'line-clamp-3 text-body')}>{fact.content}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {fact.derivedFrom?.tool || fact.derivedFrom?.callId
                ? <StatusPill tone="neutral">she learned this</StatusPill>
                : <StatusPill tone="success">you told her</StatusPill>}
              <ScopeChip scope={fact.scope} />
              <span className="text-caption text-faint">{sourceLine(fact)}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-caption text-muted">
        {total > answer.facts.length ? `Showing ${answer.facts.length} of ${total}. ` : ''}
        <Link to={memoryScopePath(filter)} className="font-semibold text-primary hover:underline">Open in Memory</Link> to correct, move or forget any of it.
      </p>
    </div>
  );
}
