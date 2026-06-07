import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Plus, Trash2, Loader2, ChevronDown } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getMcpServers, addMcpServer, deleteMcpServer, type McpServerInput } from '@/lib/connect';
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
          <p className="text-small text-muted">Extra tool surfaces from Model Context Protocol servers</p>
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
      ) : servers.length === 0 ? (
        <Card className="p-4 text-body text-muted">No MCP servers yet. Add one above.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s, i) => (
            <Card key={s.name || s.slug || i} className="flex items-center gap-3 p-4">
              <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{s.name || s.slug}</span>
              <StatusPill tone={s.enabled !== false ? 'success' : 'neutral'}>{s.enabled !== false ? 'Enabled' : 'Disabled'}</StatusPill>
              <Button variant="ghost" size="icon" aria-label={`Remove ${s.name || s.slug}`} title="Remove"
                onClick={async () => { await deleteMcpServer(String(s.name || s.slug)); refresh(); }}>
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
