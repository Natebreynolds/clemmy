import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Server, Plus, Trash2, Loader2, ChevronDown, Wrench, MessageCircle, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import { connectionSetupChatNavigation } from '@/lib/connection-setup-draft';
import {
  getMcpServers, getMcpServerTools, addMcpServer, deleteMcpServer,
  setMcpCredential, reconnectMcpServer, setMcpServerEnabled,
  type McpServerInput, type McpServer,
} from '@/lib/connect';
import { parseMcpSetup } from '@/lib/mcp-setup';
import { mcpConnectionHelp, mcpConnectionPresentation, mcpServerNameConflict } from '@/lib/mcp-setup-view';
import { cn } from '@/lib/cn';

type Inventory = Awaited<ReturnType<typeof getMcpServerTools>>;

export function McpManager() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mcp = usePoll(['mcp-servers'], getMcpServers, 5000);
  const servers = mcp.data?.servers ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['mcp-servers'] });
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');

  return (
    <section className="mb-8" aria-labelledby="mcp-heading">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <Server className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 basis-64">
          <h3 id="mcp-heading" className="text-h3 text-fg">MCP servers</h3>
          <p className="max-w-prose text-small text-muted">Tell Clem which tool you want to connect. She can set it up and check the connection; any keys she needs from you appear here.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { const target = connectionSetupChatNavigation('mcp'); if (target) navigate(target.pathname, { state: target.state }); }}>
          <MessageCircle className="h-4 w-4" aria-hidden /> Ask Clem
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-controls="mcp-manual-setup">
          <Plus className="h-4 w-4" aria-hidden /> Add manually
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
        </Button>
      </div>
      {open && <McpSetupForm servers={servers} unavailable={!mcp.data || mcp.isError} onCancel={() => setOpen(false)} onAdded={name => {
        setNotice(`Saved ${name}. Its connection status appears below.`);
        setOpen(false);
        void refresh();
      }} />}
      {notice && <p role="status" className="mb-3 text-small text-fg">{notice}</p>}
      {mcp.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1].map(i => <Skeleton key={i} className="h-28 w-full" />)}</div>
      ) : mcp.isError ? (
        <QueryUnavailable title="MCP servers are unavailable" description="Clementine couldn’t verify your connections. Try loading the list again." onRetry={() => { void mcp.refetch(); }} className="py-10" />
      ) : servers.length === 0 ? (
        <Card className="p-4 text-body text-muted">No MCP servers added yet. Ask Clem to connect one, or paste its setup with Add manually.</Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((s, i) => <McpServerCard key={s.name || s.slug || i} server={s} refresh={refresh} />)}
        </div>
      )}
      <p className="mt-3 max-w-prose text-caption text-muted">Local servers run on the computer hosting Clem. Connected means the server answered a tool-discovery check; it does not verify every action or account permission.</p>
    </section>
  );
}

function McpSetupForm({ servers, unavailable, onAdded, onCancel }: {
  servers: McpServer[]; unavailable: boolean; onAdded: (name: string) => void; onCancel: () => void;
}) {
  const [mode, setMode] = useState<'paste' | 'details'>('paste');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [type, setType] = useState<McpServerInput['type']>('stdio');
  const [address, setAddress] = useState('');
  const [variables, setVariables] = useState([{ key: '', value: '' }]);
  const [preview, setPreview] = useState<McpServerInput[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const change = (fn: () => void) => { fn(); setPreview(null); setError(''); };
  const review = () => {
    let parsed = parseMcpSetup(mode === 'paste' || type === 'stdio' ? text : JSON.stringify({ type, url: address }), name.trim() || undefined);
    if (mode === 'details' && parsed.ok) {
      const filled = variables.filter(v => v.key.trim() || v.value);
      const keys = filled.map(v => v.key.trim());
      if (keys.some(k => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) || new Set(keys).size !== keys.length) {
        setError('Give each environment variable a unique name using letters, numbers and underscores.'); return;
      }
      const env = Object.fromEntries(filled.map(v => [v.key.trim(), v.value]));
      parsed = parseMcpSetup(JSON.stringify({ ...parsed.servers[0], ...(filled.length ? { env } : {}) }));
    }
    if (!parsed.ok) { setError(parsed.error); return; }
    setError(''); setSelected(0); setPreview(parsed.servers);
  };
  const candidate = preview?.[selected];
  const conflict = candidate && mcpServerNameConflict(candidate.name, servers);
  const add = async () => {
    if (!candidate || busyRef.current || conflict || unavailable) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await addMcpServer(candidate);
      setText(''); setVariables([{ key: '', value: '' }]); setPreview(null);
      onAdded(candidate.name);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 409 ? 'That server is already in Clem. Check its connection below, or choose a different name.'
        : status === 400 ? 'Clem could not use this setup. Check its name, command or web address and try again.'
        : 'The save could not be confirmed. Check the server list before trying again.');
    } finally { busyRef.current = false; setBusy(false); }
  };

  return (
    <Card id="mcp-manual-setup" className="mb-4 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Setup method">
        <Button variant={mode === 'paste' ? 'secondary' : 'ghost'} size="sm" aria-pressed={mode === 'paste'} disabled={busy} onClick={() => change(() => setMode('paste'))}>Paste setup</Button>
        <Button variant={mode === 'details' ? 'secondary' : 'ghost'} size="sm" aria-pressed={mode === 'details'} disabled={busy} onClick={() => change(() => setMode('details'))}>Enter details</Button>
      </div>
      <div className="max-w-3xl">
        <Field label={mode === 'paste' ? 'Name (optional for a named configuration)' : 'Server name'}>
          {id => <Input id={id} value={name} onChange={e => change(() => setName(e.target.value))} placeholder="my-tools" disabled={busy} autoComplete="off" />}
        </Field>
        {mode === 'paste' ? (
          <Field label="Configuration or start command" hint="Paste the MCP configuration from its setup guide, or a single start command. Quoted paths stay together; shell scripts are not run.">
            {id => <Textarea id={id} value={text} onChange={e => change(() => setText(e.target.value))} placeholder={'{ "mcpServers": { "my-tools": { "command": "node", "args": ["/path/to/server.js"] } } }'} className="min-h-36 font-mono text-small" disabled={busy} autoComplete="off" spellCheck={false} />}
          </Field>
        ) : <>
          <Field label="Connection">
            {id => <Select id={id} value={type} onChange={e => change(() => setType(e.target.value as McpServerInput['type']))} disabled={busy}>
              <option value="stdio">On this computer</option><option value="http">Web address (HTTP)</option><option value="sse">Web address (SSE)</option>
            </Select>}
          </Field>
          {type === 'stdio' ? <Field label="Start command" hint="Include the arguments. Put quotes around paths containing spaces.">
            {id => <Input id={id} value={text} onChange={e => change(() => setText(e.target.value))} placeholder={'node "/path with spaces/server.js"'} disabled={busy} autoComplete="off" spellCheck={false} />}
          </Field> : <Field label="Server web address">
            {id => <Input id={id} value={address} onChange={e => change(() => setAddress(e.target.value))} placeholder="https://server.example/mcp" disabled={busy} autoComplete="off" />}
          </Field>}
          <details className="mb-4">
            <summary className="cursor-pointer rounded-md py-2 text-small font-medium text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Environment variables (optional)</summary>
            <p className="mb-2 max-w-prose text-caption text-muted">Use the names from the server’s guide. Leave a value blank to enter its key on the connection card later. For web headers, use Paste setup.</p>
            <div className="space-y-2">
              {variables.map((v, i) => <div key={i} className="grid gap-2 sm:grid-cols-2">
                <Input aria-label={`Variable ${i + 1} name`} value={v.key} onChange={e => change(() => setVariables(rows => rows.map((r, n) => n === i ? { ...r, key: e.target.value } : r)))} placeholder="VARIABLE_NAME" disabled={busy} autoComplete="off" />
                <Input aria-label={`Variable ${i + 1} value`} type="password" value={v.value} onChange={e => change(() => setVariables(rows => rows.map((r, n) => n === i ? { ...r, value: e.target.value } : r)))} placeholder="Value, or leave blank" disabled={busy} autoComplete="new-password" />
              </div>)}
            </div>
            <Button variant="ghost" size="sm" className="mt-2" disabled={busy} onClick={() => change(() => setVariables(v => [...v, { key: '', value: '' }]))}><Plus className="h-3.5 w-3.5" aria-hidden /> Add variable</Button>
          </details>
        </>}
        {preview && candidate && <div className="mb-4 border-t border-border pt-4" aria-label="Setup preview">
          {preview.length > 1 && <Field label="Choose one server to add">
            {id => <Select id={id} value={selected} onChange={e => { setSelected(Number(e.target.value)); setError(''); }} disabled={busy}>
              {preview.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
            </Select>}
          </Field>}
          <p className="break-words text-body font-semibold text-fg">{candidate.name}</p>
          <p className="mt-1 text-small text-muted">{candidate.type === 'stdio'
            ? `Runs on this computer · ${candidate.args?.length ?? 0} ${(candidate.args?.length ?? 0) === 1 ? 'argument' : 'arguments'}`
            : `Connects to a web server · ${candidate.type === 'http' ? 'HTTP' : 'SSE'}`}</p>
          {Object.keys(candidate.env ?? {}).length > 0 && <p className="mt-1 break-words text-caption text-muted">Environment variables: {Object.keys(candidate.env!).join(', ')}. Values are hidden in this preview.</p>}
          {Object.keys(candidate.headers ?? {}).length > 0 && <p className="mt-1 text-caption text-muted">{Object.keys(candidate.headers!).length} request headers. Values are hidden in this preview.</p>}
          <p className="mt-2 max-w-prose text-caption text-muted">Adding saves this setup for Clem. The server may start to discover its tools; its actual connection status appears below.</p>
          {conflict && <p role="alert" className="mt-2 text-small text-danger">This server is already in Clem. Use its connection card below, or change the name.</p>}
        </div>}
        {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
        {unavailable && <p className="mb-3 text-small text-muted">Wait for the current server list before adding a connection.</p>}
        <div className="flex flex-wrap gap-2">
          {candidate ? <Button size="sm" onClick={() => { void add(); }} disabled={busy || !!conflict || unavailable}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add server
          </Button> : <Button size="sm" onClick={review} disabled={busy || !(mode === 'details' && type !== 'stdio' ? address.trim() : text.trim())}>Review setup</Button>}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

function McpServerCard({ server, refresh }: { server: McpServer; refresh: () => Promise<unknown> }) {
  const label = String(server.name || server.slug || '');
  const names = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))] : [];
  const ownerRef = useRef({ label, active: true });
  if (ownerRef.current.label !== label) ownerRef.current = { label, active: true };
  const owner = ownerRef.current;
  const operation = useRef<object | null>(null);
  const [draft, setDraft] = useState({ owner, values: {} as Record<string, string>, editing: false });
  const values = draft.owner === owner ? draft.values : {};
  const valueFor = (key: string) => Object.hasOwn(values, key) && typeof values[key] === 'string' ? values[key] : '';
  const editingAccess = draft.owner === owner && draft.editing;
  const accessId = useId();
  const [checkedUnset, setCheckedUnset] = useState<string[] | undefined>();
  const unset = checkedUnset ?? names(server.unsetEnvKeys);
  // Missing fields retain old-daemon compatibility. Existing values are only
  // replaceable when the daemon explicitly certifies their declaration type.
  const replaceable = names(server.editableEnvKeys).filter(key => !unset.includes(key));
  const [savingKey, setSavingKey] = useState('');
  const [changing, setChanging] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [checkedState, setCheckedState] = useState<string | undefined>();
  const [removeConfirm, setRemoveConfirm] = useState(false);
  useEffect(() => {
    owner.active = true; operation.current = null;
    setDraft({ owner, values: {}, editing: false }); setSavingKey(''); setChanging(false); setChecking(false);
    setError(''); setNotice(''); setInventory(null); setCheckedState(undefined); setCheckedUnset(undefined);
    setConnectionError(''); setToolsOpen(false); setRemoveConfirm(false);
    return () => { owner.active = false; };
  }, [owner]);
  useEffect(() => { setInventory(null); setCheckedState(undefined); setCheckedUnset(undefined); setConnectionError(''); setToolsOpen(false); }, [server.enabled, names(server.unsetEnvKeys).join('\0')]);
  useEffect(() => {
    setCheckedState(undefined); setConnectionError('');
    if (server.state !== 'connected') setInventory(null);
  }, [server.state, server.failureCount]);
  const enabled = checkedState === 'disabled' ? false : server.enabled;
  const state = checking ? 'connecting' : checkedState ?? server.state;
  const presentation = enabled === false ? mcpConnectionPresentation({ enabled: false })
    : state === 'needs_credentials' ? { label: 'Needs setup', tone: 'warning' as const }
      : mcpConnectionPresentation({ ...server, state, unsetEnvKeys: unset });
  const failed = presentation.tone === 'danger';
  const toolCount = inventory?.toolCount ?? server.toolCount;
  const locked = changing || checking || !!savingKey;
  const begin = () => {
    if (operation.current || !owner.active || ownerRef.current !== owner) return null;
    const token = {}; operation.current = token; return token;
  };
  const current = (token: object) => owner.active && ownerRef.current === owner && operation.current === token;
  const finish = (token: object) => {
    if (current(token)) { setSavingKey(''); setChecking(false); setChanging(false); }
    if (operation.current === token) operation.current = null;
  };
  const applyReadiness = (result: { state?: string; unsetEnvKeys?: string[] }) => {
    const next = result.state && ['disabled', 'needs_credentials', 'connecting', 'connected', 'unavailable', 'degraded'].includes(result.state) ? result.state : 'unknown';
    setCheckedState(next);
    setCheckedUnset(result.unsetEnvKeys ? names(result.unsetEnvKeys) : next === 'connected' ? [] : undefined);
    setConnectionError(next === 'unavailable' || next === 'degraded' ? mcpConnectionHelp() : '');
    return next;
  };
  const readConnection = async (token: object, retry: boolean) => {
    setChecking(true); setToolsOpen(true); setConnectionError(''); setInventory(null); setCheckedState('connecting');
    if (retry) await reconnectMcpServer(label);
    if (!current(token)) return;
    const result = await getMcpServerTools(label);
    if (!current(token)) return;
    setInventory(result); applyReadiness(result);
    await refresh();
  };

  const check = async (retry = failed, afterCredential = false) => {
    if (unset.length > 0 && !afterCredential) return;
    const token = begin(); if (!token) return;
    try {
      await readConnection(token, retry);
    } catch (e) {
      if (!current(token)) return;
      setCheckedState('unavailable');
      setConnectionError(mcpConnectionHelp((e as Error).message));
    } finally { finish(token); }
  };
  const saveCred = async (key: string) => {
    const value = valueFor(key);
    if (!value.trim() || (!unset.includes(key) && !replaceable.includes(key))) return;
    const token = begin(); if (!token) return;
    setError(''); setNotice(''); setConnectionError(''); setSavingKey(key); setInventory(null); setCheckedState('unknown');
    try {
      const result = await setMcpCredential(label, key, value);
      if (!current(token)) return;
      if (result.ok !== true) throw new Error('Credential save was not confirmed.');
      setDraft(d => d.owner === owner ? { ...d, values: { ...d.values, [key]: '' } } : d);
      const next = applyReadiness(result);
      setNotice(next === 'connected' ? 'Value saved. The server answered its tool-discovery check.'
        : next === 'needs_credentials' ? 'Value saved. Enter the remaining access details, then check the connection.'
          : next === 'disabled' ? 'Value saved. This connection is turned off; enable it when you are ready.'
            : next === 'unavailable' ? 'Value saved. The connection still needs attention; check its access details, then retry.'
              : 'Value saved. Check connection to confirm the server is ready.');
      try { await refresh(); } catch { if (current(token)) setError('The value was saved, but the connection list could not refresh. Reload the list before saving again.'); }
      if (!current(token)) return;
      // Older daemons return no readiness; retain a single exact-server check
      // for that compatibility path, not a second handshake on current builds.
      if (!result.state && unset.length === 1 && unset[0] === key) await readConnection(token, false);
    } catch { if (current(token)) setError('The key save or connection check could not be confirmed. Check the connection status before saving again.'); }
    finally { finish(token); }
  };
  const toggleEnabled = async () => {
    const token = begin(); if (!token) return;
    setChanging(true); setError('');
    try { await setMcpServerEnabled(label, enabled === false); if (current(token)) { setInventory(null); await refresh(); } }
    catch { if (current(token)) setError('Clem could not change this connection. Check its status before retrying.'); }
    finally { finish(token); }
  };
  const remove = async () => {
    const token = begin(); if (!token) return;
    setChanging(true); setError('');
    try { await deleteMcpServer(label); if (current(token)) await refresh(); }
    catch { if (current(token)) setError('Clem could not remove this server. Check the connection list before retrying.'); }
    finally { finish(token); }
  };
  const showTools = () => {
    if (operation.current || ownerRef.current !== owner || !owner.active) return;
    if (presentation.label === 'Connected' && inventory?.state === 'connected') setToolsOpen(v => !v);
    else void check();
  };
  const fields = (keys: string[], replacing = false) => <div className="space-y-2">{keys.map(key => <div key={key} className="flex flex-wrap gap-2">
    <Input type="password" autoComplete="new-password" value={valueFor(key)} onChange={e => {
      if (ownerRef.current === owner && owner.active && !operation.current) setDraft(d => ({ owner, editing: d.owner === owner && d.editing, values: { ...(d.owner === owner ? d.values : {}), [key]: e.target.value } }));
    }} placeholder={key} aria-label={`${key} for ${label}`} className="min-w-0 flex-1 basis-40" disabled={locked} />
    <Button size="sm" variant="secondary" disabled={locked || !valueFor(key).trim()} onClick={() => { void saveCred(key); }}>{savingKey === key ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : replacing ? 'Save & check' : keys.length === 1 ? 'Save & connect' : 'Save'}</Button>
  </div>)}</div>;

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-body font-medium text-fg">{label}</p>
          <p className="mt-0.5 text-caption text-muted">{server.builtin ? 'Built into Clem' : server.type === 'stdio' ? 'On this computer' : 'Web server'}</p>
        </div>
        <StatusPill tone={presentation.tone}>{checking ? 'Checking' : presentation.label}</StatusPill>
        {!server.builtin && server.source !== 'auto-detected' && <Button variant="ghost" size="icon" aria-label={`Remove ${label}`} title="Remove" disabled={locked} onClick={() => setRemoveConfirm(v => !v)}><Trash2 className="h-4 w-4" aria-hidden /></Button>}
      </div>
      {server.description && <p className="line-clamp-2 text-small text-muted">{String(server.description)}</p>}
      {removeConfirm && <div className="border-t border-border pt-3">
        <p className="mb-2 text-small text-fg">Remove this connection from Clem? This does not uninstall the server.</p>
        <div className="flex flex-wrap gap-2"><Button variant="danger" size="sm" disabled={locked} onClick={() => { void remove(); }}>Remove server</Button><Button variant="ghost" size="sm" disabled={locked} onClick={() => setRemoveConfirm(false)}>Keep server</Button></div>
      </div>}
      {unset.length > 0 && enabled !== false && <div className="border-t border-border pt-3">
        <p className="mb-2 text-small text-fg">Clem needs these values to finish connecting. Enter them here, not in chat.</p>
        {fields(unset)}
        <p className="mt-2 text-caption text-muted">Saved on this computer. Values are not shown in the tool list.</p>
      </div>}
      {replaceable.length > 0 && enabled !== false && <div className="border-t border-border pt-3">
        {!editingAccess ? <Button variant="ghost" size="sm" disabled={locked} aria-expanded={false} aria-controls={accessId} onClick={() => {
          if (!operation.current && ownerRef.current === owner && owner.active) setDraft({ owner, values: {}, editing: true });
        }}>Update access details</Button> : <div id={accessId}>
          <p className="mb-2 text-small text-fg">Enter a replacement here, not in chat. Stored values are never shown. Connections using the same key name will use its replacement.</p>
          {fields(replaceable, true)}
          <Button variant="ghost" size="sm" className="mt-2" disabled={locked} onClick={() => {
            if (!operation.current && ownerRef.current === owner && owner.active) setDraft({ owner, values: {}, editing: false });
          }}>Cancel</Button>
        </div>}
      </div>}
      {notice && <p role="status" className="text-small text-muted">{notice}</p>}
      {error && <p role="alert" className="text-small text-danger">{error}</p>}
      {connectionError && <p role="alert" className="text-small text-danger">{connectionError}</p>}
      {!checking && !connectionError && failed && <p className="text-small text-danger">{mcpConnectionHelp(server.lastError)}</p>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <span className="text-caption text-muted">{typeof toolCount === 'number' ? `${presentation.label !== 'Connected' ? 'Last seen: ' : ''}${toolCount.toLocaleString()} ${toolCount === 1 ? 'tool' : 'tools'}` : 'Tools not checked yet'}</span>
        {enabled !== false && <Button variant="ghost" size="sm" onClick={showTools} disabled={locked || unset.length > 0} aria-expanded={toolsOpen}>
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : failed ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : <Wrench className="h-3.5 w-3.5" aria-hidden />}
          {checking ? 'Checking…' : failed || connectionError ? 'Retry connection' : inventory?.state === 'connected' ? toolsOpen ? 'Hide tools' : 'View tools' : presentation.label === 'Connected' ? 'View tools' : 'Check connection'}
        </Button>}
        {!server.builtin && <Button variant="ghost" size="sm" disabled={locked} onClick={() => { void toggleEnabled(); }}>{enabled === false ? 'Enable' : 'Turn off'}</Button>}
      </div>
      {toolsOpen && <div className="border-t border-border pt-3">
        {checking ? <p role="status" className="text-small text-muted">Starting the server and discovering its tools…</p>
          : inventory?.state === 'connected' ? inventory.tools.length ? <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">{inventory.tools.map(tool => <li key={tool.name}><p className="break-all text-small font-medium text-fg">{tool.name}</p>{tool.description && <p className="line-clamp-2 text-caption text-muted">{tool.description}</p>}</li>)}</ul>
          : <p className="text-small text-muted">The server connected, but did not offer any tools.</p>
          : !connectionError && <p className="text-small text-muted">{state === 'connecting' ? 'The server is still starting. Check again in a moment.' : 'Connection readiness is not confirmed. Check the connection again.'}</p>}
      </div>}
    </Card>
  );
}
