/**
 * Plugins — installed content cartridges (skills + workflows + MCP servers in
 * one bundle). v1 installs are CLI-sideload (`clementine plugin install <path>`);
 * this panel is the console's view: what's slotted in, toggle, uninstall.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { apiGet, apiPost } from '@/lib/api';

interface PluginArtifact { kind: string; name: string }
interface InstalledPlugin {
  manifest: { id: string; name: string; version: string; description?: string; publisher?: { name?: string } };
  installedAt: string;
  enabled: boolean;
  artifacts: PluginArtifact[];
}

const listInstalledPlugins = () => apiGet<{ plugins: InstalledPlugin[] }>('/api/console/plugins');
const pluginAction = (id: string, action: 'enable' | 'disable' | 'uninstall') =>
  apiPost<{ ok: boolean; error?: string }>(`/api/console/plugins/${encodeURIComponent(id)}/${action}`);

function artifactSummary(artifacts: PluginArtifact[]): string {
  const counts = artifacts.reduce<Record<string, number>>((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc; }, {});
  return Object.entries(counts).map(([k, n]) => `${n} ${k.replace('mcp-server', 'MCP server')}${n === 1 ? '' : 's'}`).join(' · ');
}

export function PluginsPanel() {
  const qc = useQueryClient();
  const plugins = usePoll(['plugins'], listInstalledPlugins, 15000);
  const rows = plugins.data?.plugins ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const act = async (id: string, action: 'enable' | 'disable' | 'uninstall') => {
    if (action === 'uninstall' && !window.confirm(`Uninstall ${id}? Everything it installed (skills, workflows, MCP servers) is removed.`)) return;
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
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-start gap-2.5">
        <Package className="mt-0.5 h-5 w-5 text-primary" aria-hidden />
        <div>
          <h3 className="text-h3 text-fg">Plugins</h3>
          <p className="text-caption text-muted">Cartridges of skills, workflows, and MCP servers — slot one in, everything appears; eject it, everything leaves.</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card className="p-4">
          <p className="text-body text-muted">No plugins installed yet.</p>
          <p className="mt-1 text-caption text-faint">
            Install one with <code className="rounded-sm bg-subtle px-1 py-0.5 font-mono">clementine plugin install &lt;folder or .clemplug&gt;</code> — a curated gallery is coming.
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
                <p className="mt-0.5 truncate text-caption text-muted">{artifactSummary(p.artifacts) || 'no artifacts'}{p.manifest.description ? ` — ${p.manifest.description}` : ''}</p>
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
    </section>
  );
}
