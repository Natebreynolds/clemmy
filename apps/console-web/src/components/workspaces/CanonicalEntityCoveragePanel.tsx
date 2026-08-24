import { useEffect, useState } from 'react';
import { AlertCircle, Database, Layers3 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  appendCanonicalPartitionPage,
  canonicalCoveragePresentation,
  canonicalProjectionEmptyState,
  getWorkspaceCanonicalEntityProjection,
  initialCanonicalPartitionPageState,
  recurrenceConfigurationLabel,
  type CanonicalPartitionPageState,
  type WorkspaceCanonicalEntityProjectionResponse,
} from '@/lib/workspace-canonical-entity';

const PARTITION_PAGE_SIZE = 20;

type AvailableProjection = Extract<
  WorkspaceCanonicalEntityProjectionResponse,
  { status: 'available' }
>;

function referenceList(
  label: string,
  count: number,
  references: readonly string[],
  truncated: boolean,
) {
  if (count === 0) return null;
  return (
    <details className="rounded-md border border-border bg-subtle px-2.5 py-2">
      <summary className="cursor-pointer text-caption text-muted">
        {label} · {count}{truncated ? ' (sample)' : ''}
      </summary>
      <ul className="mt-2 space-y-1">
        {references.map((reference) => (
          <li key={reference} className="truncate font-mono text-caption text-faint" title={reference}>
            {reference}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CanonicalEntityCoveragePanel({ workspaceId }: { workspaceId: string }) {
  const firstPage = usePoll(
    ['workspace-canonical-entity-projection', workspaceId],
    () => getWorkspaceCanonicalEntityProjection(workspaceId, { limit: PARTITION_PAGE_SIZE }),
    5_000,
    { enabled: Boolean(workspaceId) },
  );
  const [partitions, setPartitions] = useState<CanonicalPartitionPageState | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    const response = firstPage.data;
    if (!response || response.status !== 'available') {
      setPartitions(null);
      return;
    }
    setPartitions((current) => {
      if (current
        && current.headDigest === response.head.headDigest
        && current.bindingId === response.head.identity.bindingId) return current;
      return initialCanonicalPartitionPageState(response);
    });
    setPageError(null);
  }, [firstPage.data]);

  if (firstPage.isLoading) {
    return (
      <section className="rounded-md border border-border bg-surface p-3" aria-label="Canonical coverage and records">
        <p className="text-small font-semibold text-fg">Coverage &amp; records</p>
        <p className="mt-1 text-caption text-muted">Reading the canonical projection…</p>
      </section>
    );
  }
  if (firstPage.isError || !firstPage.data) {
    return (
      <section className="rounded-md border border-warning/30 bg-warning/5 p-3" aria-label="Canonical coverage and records">
        <p className="flex items-center gap-1.5 text-small font-semibold text-fg">
          <AlertCircle className="h-3.5 w-3.5 text-warning" aria-hidden /> Coverage &amp; records
        </p>
        <p className="mt-1 text-caption text-muted">Canonical status is unavailable. No record totals are being inferred.</p>
      </section>
    );
  }
  if (firstPage.data.status === 'unavailable') {
    const empty = canonicalProjectionEmptyState(firstPage.data.reason);
    return (
      <section className="rounded-md border border-border bg-surface p-3" aria-label="Canonical coverage and records">
        <p className="flex items-center gap-1.5 text-small font-semibold text-fg">
          <Database className="h-3.5 w-3.5 text-muted" aria-hidden /> Coverage &amp; records
        </p>
        <p className="mt-1 text-caption text-muted">{empty.message}</p>
      </section>
    );
  }

  const response: AvailableProjection = firstPage.data;
  const currentPartitions = partitions
    && partitions.headDigest === response.head.headDigest
    && partitions.bindingId === response.head.identity.bindingId
    ? partitions
    : initialCanonicalPartitionPageState(response);
  const coverage = canonicalCoveragePresentation(
    response.head.coverage,
    currentPartitions.integrity,
  );

  const loadMore = async () => {
    const requestedCursor = currentPartitions.nextCursor;
    if (!requestedCursor || pageBusy || currentPartitions.integrity !== 'ok') return;
    const requestHeadDigest = currentPartitions.headDigest;
    setPageBusy(true);
    setPageError(null);
    try {
      const next = await getWorkspaceCanonicalEntityProjection(workspaceId, {
        cursor: requestedCursor,
        limit: PARTITION_PAGE_SIZE,
      });
      setPartitions((current) => {
        if (!current || current.headDigest !== requestHeadDigest) return current;
        return appendCanonicalPartitionPage(current, requestedCursor, next);
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Could not load more partitions.');
      setPartitions((current) => current && current.headDigest === requestHeadDigest
        ? {
            ...current,
            hasMore: false,
            nextCursor: undefined,
            integrity: 'stale_projection',
          }
        : current);
    } finally {
      setPageBusy(false);
    }
  };

  const quarantineReasons = Object.entries(response.head.quarantine.reasons);
  return (
    <section className="rounded-md border border-border bg-surface p-3" aria-label="Canonical coverage and records">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-small font-semibold text-fg">
            <Database className="h-3.5 w-3.5 text-muted" aria-hidden /> Coverage &amp; records
          </p>
          <p className="mt-0.5 truncate text-caption text-faint" title={response.head.identity.datasetId}>
            {response.head.identity.datasetId}
          </p>
        </div>
        <StatusPill tone={coverage.tone}>{coverage.label}</StatusPill>
      </div>

      {coverage.percent !== undefined && (
        <div className="mt-3">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-subtle"
            role="progressbar"
            aria-label="Canonical record coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={coverage.percent}
          >
            <div
              className={`h-full rounded-full ${coverage.label === 'Complete' ? 'bg-success' : 'bg-warning'}`}
              style={{ width: `${coverage.percent}%` }}
            />
          </div>
          <p className="mt-1 text-caption text-muted">{coverage.percent}% · {coverage.observedLabel}</p>
        </div>
      )}
      {coverage.percent === undefined && (
        <p className="mt-2 text-caption text-muted">{coverage.observedLabel}</p>
      )}
      <p className="mt-1 text-caption text-muted">{coverage.partitionLabel}</p>

      {coverage.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {coverage.reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-1.5 text-caption text-warning">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {reason}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          ['Canonical', response.head.records.canonicalRecords],
          ['Merged', response.head.records.mergedObservations],
          ['Quarantine', response.head.quarantine.observationCount],
          ['Duplicates', response.head.records.duplicateObservations],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-md border border-border bg-subtle px-2.5 py-2">
            <p className="text-caption text-faint">{label}</p>
            <p className="text-h3 text-fg">{value}</p>
          </div>
        ))}
      </div>

      {quarantineReasons.length > 0 && (
        <p className="mt-2 text-caption text-muted">
          Quarantine: {quarantineReasons.map(([reason, count]) => `${reason.replaceAll('_', ' ')} (${count})`).join(' · ')}
        </p>
      )}

      <div className="mt-3 rounded-md border border-border bg-subtle px-2.5 py-2">
        <p className="text-caption font-semibold text-fg">Configured workflow trigger</p>
        <p className="mt-0.5 text-caption text-muted">{recurrenceConfigurationLabel(response.recurrence)}</p>
        <p className="mt-1 text-caption text-faint">
          Configuration only — this is not proof that recurrence was consented, activated, or is running.
          {response.recurrence.definitionEnabled !== undefined
            ? ` Workflow definition: ${response.recurrence.definitionEnabled ? 'enabled' : 'disabled'}.`
            : ''}
        </p>
      </div>

      <div className="mt-2 space-y-2">
        {referenceList(
          'Provenance references',
          response.head.provenance.referenceCount,
          response.head.provenance.references,
          response.head.provenance.referencesTruncated,
        )}
        {referenceList(
          'Quarantine review references',
          response.head.quarantine.referenceCount,
          response.head.quarantine.references,
          response.head.quarantine.referencesTruncated,
        )}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <div className="flex items-center gap-1.5">
          <Layers3 className="h-3.5 w-3.5 text-muted" aria-hidden />
          <p className="text-caption font-semibold text-fg">Partitions</p>
          <span className="ml-auto text-caption text-faint">{currentPartitions.items.length} shown</span>
        </div>
        {currentPartitions.items.length === 0 ? (
          <p className="mt-2 text-caption text-muted">No normalized partition rows are available.</p>
        ) : (
          <ul className="mt-2 max-h-52 space-y-1 overflow-auto pr-1">
            {currentPartitions.items.map((partition) => (
              <li key={partition.partitionId} className="rounded-md bg-subtle px-2 py-1.5 text-caption">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={partition.partitionId}>
                    {partition.partitionId}
                  </span>
                  <span className="text-muted">{partition.state}</span>
                </div>
                <p className="mt-0.5 text-faint">
                  {partition.canonicalRecords} canonical · {partition.duplicateObservations} duplicates
                </p>
              </li>
            ))}
          </ul>
        )}
        {pageError && <p className="mt-2 text-caption text-warning">{pageError}</p>}
        {currentPartitions.integrity !== 'ok' && (
          <p className="mt-2 text-caption text-warning">
            Pagination stopped because the projection changed or the cursor did not advance.
          </p>
        )}
        {currentPartitions.hasMore && currentPartitions.nextCursor && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
            disabled={pageBusy}
            onClick={() => { void loadMore(); }}
          >
            {pageBusy ? 'Loading…' : 'Load more partitions'}
          </Button>
        )}
      </div>
    </section>
  );
}
