import { useRef, useState } from 'react';
import { Share2, Download, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { usePoll } from '@/lib/poll';
import { cartridgeIdFor, exportCartridge, getShareInventory, type ShareResult } from '@/lib/plugin-export';
import { getAuthToken } from '@/lib/bootstrap';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';

// Share what Clem built as one cartridge: pick workflows, skills, tool
// servers and Spaces; the file carries definitions, never your data or keys.
export function ShareCartridge() {
  const inventory = usePoll(['share-inventory'], getShareInventory, 0);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Record<string, Set<string>>>({ workflows: new Set(), skills: new Set(), mcpServers: new Set(), workspaces: new Set() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ShareResult | null>(null);
  const actionOwner = useRef(false);
  const toggle = (group: string, key: string) => setPicked((prev) => {
    const next = new Set(prev[group]); if (next.has(key)) next.delete(key); else next.add(key);
    return { ...prev, [group]: next };
  });
  const count = Object.values(picked).reduce((sum, set) => sum + set.size, 0);
  const share = async () => {
    if (actionOwner.current || inventory.isError || !inventory.data || !name.trim() || !count) return;
    actionOwner.current = true;
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await exportCartridge({
        id: cartridgeIdFor(name), name: name.trim(),
        workflows: [...picked.workflows], skills: [...picked.skills], mcpServers: [...picked.mcpServers], workspaces: [...picked.workspaces],
      }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { actionOwner.current = false; setBusy(false); }
  };
  const inv = inventory.data;
  const group = (title: string, key: string, items: Array<{ id: string; label: string; hint?: string }>) => items.length === 0 ? null : (
    <fieldset disabled={busy} className="min-w-0">
      <legend className="mb-1 text-caption font-semibold uppercase tracking-wide text-faint">{title}</legend>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex cursor-pointer items-start gap-2 text-small text-fg">
              <input type="checkbox" className="mt-0.5" checked={picked[key].has(item.id)} onChange={() => toggle(key, item.id)} />
              <span className="min-w-0"><span className="block truncate">{item.label}</span>{item.hint && <span className="block truncate text-caption text-muted">{item.hint}</span>}</span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
  const token = getAuthToken();
  return (
    <Card>
      <details>
      <summary className="cursor-pointer rounded-sm py-1 text-body font-semibold text-fg">Share what Clem built</summary>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mt-1 text-small text-muted">Pick workflows, skills, tool servers and Spaces and get one cartridge file. It carries the definitions; your data, notes, history and keys stay here.</p>
          {inventory.isLoading && <p role="status" className="mt-3 text-small text-muted">Loading what you can share…</p>}
          {inventory.isError && <QueryUnavailable title="Shareable items couldn’t be refreshed" description={inv ? 'Showing the last loaded items. Refresh before making a cartridge.' : 'Your shareable items are unavailable.'} onRetry={() => { void inventory.refetch(); }} className="mt-3 py-5" />}
          {inv && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {group('Workflows', 'workflows', inv.workflows.map((w) => ({ id: w.name, label: w.name, hint: w.description })))}
              {group('Spaces', 'workspaces', inv.workspaces.map((s) => ({ id: s.slug, label: s.title, hint: s.slug })))}
              {group('Skills', 'skills', inv.skills.map((s) => ({ id: s, label: s })))}
              {group('Tool servers', 'mcpServers', inv.mcpServers.map((s) => ({ id: s, label: s, hint: 'keys left blank' })))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-small text-muted">Cartridge name
              <Input disabled={busy} value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder="Sales pack" />
            </label>
            <Button size="sm" disabled={busy || inventory.isError || !inv || !name.trim() || count === 0} onClick={() => { void share(); }}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />} Make the cartridge
            </Button>
          </div>
          {result && (
            <div className="mt-3 rounded-md border border-border bg-surface p-3 text-small">
              <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={`${result.downloadPath}${token ? `?token=${encodeURIComponent(token)}` : ''}`} download={result.fileName}>
                <Download className="h-4 w-4" aria-hidden /> {result.fileName} · {Math.max(1, Math.round(result.bytes / 1024))} KB
              </a>
              <p className="mt-1 text-muted">Left out on purpose: {result.leftOut.join('; ')}.</p>
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-small text-danger">{error}</p>}
        </div>
      </div>
      </details>
    </Card>
  );
}
