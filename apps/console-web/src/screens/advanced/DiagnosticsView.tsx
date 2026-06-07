import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getDiagnostics } from '@/lib/advanced';

function humanizeKey(k: string): string {
  return k.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function previewItem(item: unknown): string {
  if (item == null) return '—';
  if (typeof item !== 'object') return String(item);
  const o = item as Record<string, unknown>;
  for (const k of ['name', 'title', 'slug', 'tool', 'type', 'message', 'status', 'id']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  return JSON.stringify(o).slice(0, 80);
}

function Value({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return (
      <div>
        <div className="mb-1 text-caption text-faint">{value.length} item{value.length === 1 ? '' : 's'}</div>
        <ul className="space-y-1">
          {value.slice(0, 8).map((it, i) => <li key={i} className="truncate text-small text-fg">{previewItem(it)}</li>)}
          {value.length > 8 && <li className="text-caption text-faint">+ {value.length - 8} more</li>}
        </ul>
      </div>
    );
  }
  if (value && typeof value === 'object') {
    return (
      <dl className="space-y-1.5">
        {Object.entries(value as Record<string, unknown>).slice(0, 10).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt className="text-small text-muted">{humanizeKey(k)}</dt>
            <dd className="truncate text-small text-fg">{Array.isArray(v) ? `${v.length}` : typeof v === 'object' ? '…' : String(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <div className="text-body text-fg">{String(value)}</div>;
}

export function DiagnosticsView() {
  const diag = usePoll(['diagnostics'], getDiagnostics, 10000);
  const entries = diag.data ? Object.entries(diag.data).filter(([k]) => k !== 'error') : [];

  return (
    <Page title="Diagnostics" subtitle="Health, logs, and storage">
      {diag.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
      ) : entries.length === 0 ? (
        <Card className="p-5 text-body text-muted">No diagnostics available.</Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {entries.map(([key, value]) => (
            <Card key={key} className="p-5">
              <h3 className="mb-2 text-h3 text-fg">{humanizeKey(key)}</h3>
              <Value value={value} />
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
