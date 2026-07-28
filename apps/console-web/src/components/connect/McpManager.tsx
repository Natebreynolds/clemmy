import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Plus, Trash2, Loader2, ChevronDown, Wrench } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import {
  getMcpServers,
  getMcpServerTools,
  addMcpServer,
  deleteMcpServer,
  setMcpCredential,
  type McpServerInput,
  type McpServer,
  type McpToolSummary,
} from '@/lib/connect';
import { cn } from '@/lib/cn';

export function McpManager() {
  const qc = useQueryClient();
  const mcp = usePoll(['mcp-servers'], getMcpServers, 15000);
  const servers = mcp.data?.servers ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<McpServerInput['type']>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async () => {
    setError('');
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(name)) { setError('Name: 2–40 chars (letters, numbers, _ . -).'); return; }
    setBusy(true);
    try {
      await addMcpServer({
        name, type,
        command: type === 'stdio' ? command.trim() : undefined,
        args: type === 'stdio' && args.trim() ? args.trim().split(/\s+/) : undefined,
        url: type !== 'stdio' ? url.trim() : undefined,
      });
      setName(''); setCommand(''); setArgs(''); setUrl(''); setOpen(false); refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Server className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">MCP servers</h3>
          <p className="text-small text-muted">Built-in and connected tools. Full inventories load only when you open them.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Plus className="h-4 w-4" aria-hidden /> Add server
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      </div>

      {open && (
        <Card className="mb-3 p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. filesystem)" aria-label="Server name" />
            <Select value={type} onChange={(e) => setType(e.target.value as McpServerInput['type'])} aria-label="Server type">
              <option value="stdio">Local command (stdio)</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </Select>
            {type === 'stdio' ? (
              <>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command (e.g. npx)" aria-label="Command" />
                <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="Args (space-separated)" aria-label="Args" />
              </>
            ) : (
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://server/endpoint" aria-label="URL" className="sm:col-span-2" />
            )}
          </div>
          {error && <p className="mt-2 text-small text-danger">{error}</p>}
          <div className="mt-3">
            <Button size="sm" onClick={add} disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add server
            </Button>
          </div>
        </Card>
      )}

      {mcp.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : mcp.isError ? (
        <QueryUnavailable
          title="MCP servers are unavailable"
          description="Clementine couldn’t verify the local MCP catalog. This is not an empty server list."
          onRetry={() => { void mcp.refetch(); }}
          className="py-10"
        />
      ) : servers.length === 0 ? (
        <Card className="p-4 text-body text-muted">No MCP servers yet. Add one above.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s, i) => (
            <McpServerCard key={s.name || s.slug || i} server={s} refresh={refresh} />
          ))}
        </div>
      )}
    </section>
  );
}

const STATE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  connected: 'success', connecting: 'warning', degraded: 'warning', unavailable: 'danger',
};

function McpServerCard({ server, refresh }: { server: McpServer; refresh: () => void }) {
  const label = String(server.name || server.slug || '');
  const unset = server.unsetEnvKeys ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState('');
  const [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState('');
  const [tools, setTools] = useState<McpToolSummary[] | null>(null);
  const displayedToolCount = tools?.length ?? server.toolCount;

  const saveCred = async (key: string) => {
    const value = (values[key] ?? '').trim();
    if (!value) return;
    setError(''); setSavingKey(key);
    try {
      await setMcpCredential(label, key, value);
      setValues((v) => ({ ...v, [key]: '' }));
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSavingKey(''); }
  };

  const toggleTools = async () => {
    const nextOpen = !toolsOpen;
    setToolsOpen(nextOpen);
    if (!nextOpen || tools !== null || toolsLoading) return;
    setToolsError('');
    setToolsLoading(true);
    try {
      const result = await getMcpServerTools(label);
      setTools(result.tools ?? []);
    } catch (e) {
      setToolsError((e as Error).message);
    } finally {
      setToolsLoading(false);
    }
  };

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{label}</span>
        {server.state && server.state !== 'unknown' && (
          <StatusPill tone={STATE_TONE[server.state] ?? 'neutral'}>{server.state}</StatusPill>
        )}
        <StatusPill tone={server.enabled !== false ? 'success' : 'neutral'}>{server.enabled !== false ? 'Enabled' : 'Disabled'}</StatusPill>
        {!server.builtin && (
          <Button variant="ghost" size="icon" aria-label={`Remove ${label}`} title="Remove"
            onClick={async () => { await deleteMcpServer(label); refresh(); }}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted">
          {typeof displayedToolCount === 'number'
            ? `${displayedToolCount.toLocaleString()} ${displayedToolCount === 1 ? 'tool' : 'tools'}`
            : 'Tool count available after connection'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleTools}
          disabled={server.enabled === false}
          aria-expanded={toolsOpen}
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden />
          {toolsOpen ? 'Hide tools' : 'View tools'}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', toolsOpen && 'rotate-180')} aria-hidden />
        </Button>
      </div>
      {toolsOpen && (
        <div className="rounded-md border border-border bg-subtle/40 p-2.5">
          {toolsLoading ? (
            <p className="flex items-center gap-2 text-small text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Discovering tools…
            </p>
          ) : toolsError ? (
            <p className="text-small text-danger">{toolsError}</p>
          ) : tools?.length ? (
            <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <p className="break-all text-small font-medium text-fg">{tool.name}</p>
                  {tool.description && <p className="line-clamp-2 text-caption text-muted">{tool.description}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-small text-muted">No tools surfaced. The server may still be connecting.</p>
          )}
          <p className="mt-2 text-caption text-muted">Schemas stay unloaded until a task selects a relevant tool.</p>
        </div>
      )}
      {unset.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5">
          <p className="mb-1.5 text-small font-medium text-warning">Needs credentials</p>
          <div className="flex flex-col gap-1.5">
            {unset.map((key) => (
              <div key={key} className="flex items-center gap-1.5">
                <Input type="password" autoComplete="off" value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  placeholder={key} aria-label={`${key} for ${label}`} className="flex-1" />
                <Button size="sm" variant="secondary" disabled={savingKey === key || !(values[key] ?? '').trim()} onClick={() => saveCred(key)}>
                  {savingKey === key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Save'}
                </Button>
              </div>
            ))}
          </div>
          {error && <p className="mt-1.5 text-small text-danger">{error}</p>}
          <p className="mt-1.5 text-caption text-muted">Stored locally + the server reconnects. Values are never shown again.</p>
        </div>
      )}
    </Card>
  );
}
