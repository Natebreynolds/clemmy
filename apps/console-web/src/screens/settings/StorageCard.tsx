import { STORAGE_COPY, formatStorageBytes, type StorageInventory } from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { usePoll } from '@/lib/poll';

export function StorageCard() {
  const inventory = usePoll(['storage-inventory'], () => api<StorageInventory>('/api/console/storage'), 120_000);
  const data = inventory.data;
  const unavailable = data?.stopReason === 'unavailable';
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-body font-semibold text-fg">
          {unavailable ? 'Storage measurement unavailable' : data ? `${data.complete ? '' : 'At least '}${formatStorageBytes(data.totalBytes)} stored on your computer` : 'Measuring storage…'}
        </p>
        <Button variant="secondary" size="sm" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
          {inventory.isFetching ? 'Checking…' : 'Refresh'}
        </Button>
      </div>
      {inventory.isError && <p role="alert" className="px-4 pb-3 text-small text-danger">Could not measure storage. Try Refresh shortly.</p>}
      {unavailable && <p role="alert" className="px-4 pb-3 text-small text-danger">Clem could not access its data folder. Try Refresh shortly.</p>}
      {data && !unavailable && <>
        <dl className="divide-y divide-border border-t border-border">
          {data.categories.map(row => <div key={row.id} className="flex items-start justify-between gap-4 px-4 py-3">
            <dt className="min-w-0 text-body text-fg">{STORAGE_COPY[row.id].label}<span className="mt-0.5 block text-small text-muted">{STORAGE_COPY[row.id].note}</span></dt>
            <dd className="shrink-0 text-body tabular-nums text-fg">{!data.complete && '≥ '}{formatStorageBytes(row.bytes)}</dd>
          </div>)}
        </dl>
        <div className="space-y-1 border-t border-border px-4 py-3 text-small text-muted">
          {!data.complete && <p role="status">Partial measurement: some files could not be counted within this scan. Totals are a lower bound.</p>}
          <p>File sizes, excluding filesystem overhead and linked folders. Measurements refresh at most every two minutes.</p>
          <p>Measured {new Date(data.measuredAt).toLocaleString()}. No history is deleted by this view.</p>
        </div>
      </>}
    </div>
  );
}
