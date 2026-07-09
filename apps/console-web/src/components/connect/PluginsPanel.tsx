/**
 * Plugins — installed content cartridges (skills + workflows + MCP servers +
 * memory in one bundle). Slot one in right here: drop a .clemplug, pick a
 * file, or paste a URL — the CartridgeInsert overlay walks consent → install
 * with the full animation. CLI install (`clementine plugin install <path>`)
 * still works and shows up on the next poll.
 */
import { useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Link2, Package, Search, Upload } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { apiGet, apiPost } from '@/lib/api';
import { CartridgeInsert, type CartridgeSource } from './CartridgeInsert';

interface PluginArtifact { kind: string; name: string }
interface InstalledPlugin {
  manifest: { id: string; name: string; version: string; description?: string; publisher?: { name?: string } };
  installedAt: string;
  enabled: boolean;
  artifacts: PluginArtifact[];
  memory?: { batchId: string; newFacts: number; deduped: number };
}
interface CatalogPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: { name?: string; url?: string };
  tags?: string[];
  source: 'builtin' | 'url' | 'local';
  contents?: { skills: number; workflows: number; mcpServers: number; memoryFiles: number };
  featured?: boolean;
  installed?: boolean;
  enabled?: boolean;
  installedVersion?: string;
}
interface PluginCatalog { items: CatalogPlugin[]; sources: string[]; warnings: string[] }

const listInstalledPlugins = () => apiGet<{ plugins: InstalledPlugin[] }>('/api/console/plugins');
const listPluginCatalog = () => apiGet<PluginCatalog>('/api/console/plugins/catalog');
const pluginAction = (id: string, action: 'enable' | 'disable' | 'uninstall') =>
  apiPost<{ ok: boolean; error?: string }>(`/api/console/plugins/${encodeURIComponent(id)}/${action}`);

const KIND_LABELS: Record<string, string> = { 'mcp-server': 'MCP server', memory: 'memory batch' };

function artifactSummary(p: InstalledPlugin): string {
  const counts = p.artifacts.reduce<Record<string, number>>((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc; }, {});
  return Object.entries(counts).map(([k, n]) => {
    if (k === 'memory' && p.memory) return `${p.memory.newFacts} memory fact${p.memory.newFacts === 1 ? '' : 's'}`;
    const label = KIND_LABELS[k] ?? k;
    return `${n} ${label}${n === 1 ? '' : (label.endsWith('h') ? 'es' : 's')}`;
  }).join(' · ');
}

function catalogSummary(p: CatalogPlugin): string {
  const c = p.contents;
  if (!c) return p.tags?.join(' · ') ?? '';
  const parts = [
    c.skills ? `${c.skills} skill${c.skills === 1 ? '' : 's'}` : '',
    c.workflows ? `${c.workflows} workflow${c.workflows === 1 ? '' : 's'}` : '',
    c.mcpServers ? `${c.mcpServers} MCP server${c.mcpServers === 1 ? '' : 's'}` : '',
    c.memoryFiles ? `${c.memoryFiles} memory file${c.memoryFiles === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

const ARCHIVE_RE = /\.(clemplug|tgz|tar\.gz)$/i;

export function PluginsPanel() {
  const qc = useQueryClient();
  const plugins = usePoll(['plugins'], listInstalledPlugins, 15000);
  const catalog = usePoll(['plugins', 'catalog'], listPluginCatalog, 60000);
  const rows = plugins.data?.plugins ?? [];
  const catalogRows = catalog.data?.items ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [insert, setInsert] = useState<CartridgeSource | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const catalogNeedle = catalogQuery.trim().toLowerCase();
  const visibleCatalog = catalogNeedle
    ? catalogRows.filter((p) => `${p.name} ${p.description} ${p.publisher?.name ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(catalogNeedle))
    : catalogRows;

  const act = async (id: string, action: 'enable' | 'disable' | 'uninstall') => {
    if (action === 'uninstall' && !window.confirm(`Uninstall ${id}? Everything it installed (skills, workflows, MCP servers, memory) is removed.`)) return;
    setBusy(id); setNote(null);
    try {
      const res = await pluginAction(id, action);
      if (!res.ok) throw new Error(res.error || `${action} failed`);
      setNote({ tone: 'success', text: action === 'uninstall' ? `${id} uninstalled.` : `${id} ${action}d.` });
    } catch (err) {
      setNote({ tone: 'danger', text: err instanceof Error ? err.message : `${action} failed` });
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['plugins'] });
      void qc.invalidateQueries({ queryKey: ['plugins', 'catalog'] });
    }
  };

  const openFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!ARCHIVE_RE.test(file.name)) {
      setNote({ tone: 'danger', text: `${file.name} is not a plugin archive (.clemplug, .tgz, .tar.gz)` });
      return;
    }
    setNote(null);
    setInsert({ file });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    openFile(e.dataTransfer.files?.[0]);
  };

  const submitUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setNote(null);
    setInsert({ url: trimmed });
  };

  const onInsertClosed = (installed: boolean) => {
    setInsert(null);
    if (installed) {
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['plugins'] });
      void qc.invalidateQueries({ queryKey: ['plugins', 'catalog'] });
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-start gap-2.5">
        <Package className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
        <div>
          <h3 className="text-h3 text-fg">Plugins</h3>
          <p className="text-caption text-muted">One package of skills, workflows, tools, and memory that unlocks new abilities for your agent. Install in one step — remove just as cleanly.</p>
        </div>
      </div>

      <div className="mb-3 rounded-md border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-fg">Discover plugins</p>
            <p className="text-caption text-muted">Search the catalog, preview what a plugin will add, then install from the same consent flow.</p>
          </div>
          {catalog.isLoading && <span className="text-caption text-faint">Loading…</span>}
        </div>
        <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-canvas px-3">
          <Search className="h-4 w-4 shrink-0 text-faint" aria-hidden />
          <input
            value={catalogQuery}
            onChange={(e) => setCatalogQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className="h-9 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint"
          />
        </div>
        {catalog.data?.warnings?.map((warning) => (
          <p key={warning} className="mb-2 text-caption text-warning">{warning}</p>
        ))}
        {visibleCatalog.length === 0 ? (
          <div className="rounded-md border border-border bg-subtle p-3 text-caption text-muted">
            {catalogNeedle ? `No plugins match "${catalogQuery.trim()}".` : 'No catalog plugins available yet.'}
          </div>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {visibleCatalog.slice(0, 8).map((p) => (
              <div key={p.id} className="rounded-md border border-border bg-canvas p-3">
                <div className="flex items-start gap-3">
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-semibold text-fg">{p.name}</span>
                      <span className="text-caption text-faint">v{p.version}{p.publisher?.name ? ` · ${p.publisher.name}` : ''}</span>
                      {p.featured && <StatusPill tone="info">Featured</StatusPill>}
                      {p.installed && <StatusPill tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'Installed' : 'Disabled'}</StatusPill>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-caption text-muted">{p.description}</p>
                    <p className="mt-1 text-caption text-faint">{catalogSummary(p) || p.source}</p>
                  </div>
                  <Button
                    size="sm"
                    variant={p.installed ? 'secondary' : 'primary'}
                    disabled={p.installed}
                    onClick={() => { setNote(null); setInsert({ catalogId: p.id }); }}
                  >
                    {p.installed ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />}
                    {p.installed ? 'Installed' : 'Install'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Card
        className={`mb-3 border-dashed p-4 transition-colors duration-fast ${dragOver ? 'border-primary bg-primary-tint' : ''}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-body text-fg">Add a plugin</p>
            <p className="text-caption text-muted">Drop a <code className="rounded-sm bg-subtle px-1 py-0.5 font-mono">.clemplug</code> here, choose a file, or paste a plugin link.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden /> Choose file
          </Button>
          <input
            ref={fileInput} type="file" accept=".clemplug,.tgz,.tar.gz" className="hidden"
            onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }}
          />
        </div>
        <div className="mt-3 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Link2 className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
            <input
              type="url" value={url} placeholder="https://…/my-plugin.clemplug"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
              className="h-9 w-full rounded-md border border-border bg-canvas pl-8 pr-3 text-body text-fg placeholder:text-faint focus:border-ring focus:outline-none"
              aria-label="Plugin URL"
            />
          </div>
          <Button size="sm" disabled={!url.trim()} onClick={submitUrl}>Insert</Button>
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card className="p-4">
          <p className="text-body text-muted">No plugins installed yet.</p>
          <p className="mt-1 text-caption text-faint">
            Add one above, or install from the terminal: <code className="rounded-sm bg-subtle px-1 py-0.5 font-mono">clementine plugin install &lt;folder, .clemplug, or URL&gt;</code>
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => (
            <Card key={p.manifest.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-semibold text-fg">{p.manifest.name}</span>
                  <span className="text-caption text-faint">v{p.manifest.version}{p.manifest.publisher?.name ? ` · ${p.manifest.publisher.name}` : ''}</span>
                  <StatusPill tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                </div>
                <p className="mt-0.5 truncate text-caption text-muted">{artifactSummary(p) || 'no artifacts'}{p.manifest.description ? ` — ${p.manifest.description}` : ''}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" disabled={busy === p.manifest.id}
                  onClick={() => void act(p.manifest.id, p.enabled ? 'disable' : 'enable')}>
                  {p.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="secondary" size="sm" disabled={busy === p.manifest.id}
                  onClick={() => void act(p.manifest.id, 'uninstall')}>
                  Uninstall
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {note && <p className={`mt-2 text-caption ${note.tone === 'success' ? 'text-success' : 'text-danger'}`}>{note.text}</p>}

      {insert && <CartridgeInsert source={insert} onClose={onInsertClosed} />}
    </section>
  );
}
