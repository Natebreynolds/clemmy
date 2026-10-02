import { STORAGE_COPY, formatStorageBytes, storageDatabaseSummary, type StorageInventory } from '@clem/chat-engine';
import { api } from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';

export function StoragePage() {
  const inventory = useScreenData(() => api<StorageInventory>('/m/api/settings/storage'), { intervalMs: 120_000 });
  const data = inventory.data;
  const unavailable = data?.stopReason === 'unavailable';
  return <div class="stack">
    <p>{unavailable ? 'Storage measurement unavailable' : data ? `${data.complete ? '' : 'At least '}${formatStorageBytes(data.totalBytes)} stored on your computer` : 'Measuring storage…'}</p>
    {inventory.error && <p role="alert" class="settings-caveat">Could not measure storage. Try Refresh shortly.</p>}
    {unavailable && <p role="alert" class="settings-caveat">Clem could not access its data folder. Try Refresh shortly.</p>}
    {data && !unavailable && <>
      <dl class="storage-rows">{data.categories.map(row => <div key={row.id} class="storage-row">
        <dt>{STORAGE_COPY[row.id].label}<span class="storage-note">{STORAGE_COPY[row.id].note}</span></dt>
        <dd>{!data.complete && '≥ '}{formatStorageBytes(row.bytes)}</dd>
      </div>)}</dl>
      {!data.complete && <p role="status" class="settings-caveat">Partial measurement: some files could not be counted within this scan. Totals are a lower bound.</p>}
      {storageDatabaseSummary(data.database).map(line => <p key={line} class="settings-caveat">{line}</p>)}
      <p class="settings-caveat">File sizes on your computer, excluding filesystem overhead and linked folders. Measurements refresh at most every two minutes.</p>
      <p class="settings-caveat">Measured {new Date(data.measuredAt).toLocaleString()}. No history is deleted by this view.</p>
    </>}
    <button type="button" class="btn" disabled={inventory.refreshing} onClick={() => void inventory.refresh()}>{inventory.refreshing ? 'Checking…' : 'Refresh'}</button>
  </div>;
}
