import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, KeyRound, Check, X, Search, RotateCw, RefreshCw, Loader2, Unplug } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { MobilePanel } from '@/components/connect/MobilePanel';
import { McpManager } from '@/components/connect/McpManager';
import { ProjectsPanel } from '@/components/connect/ProjectsPanel';
import { CliTools } from '@/components/connect/CliTools';
import { usePoll } from '@/lib/poll';
import {
  getComposioStatus, getComposioToolkits, authorizeComposio, refreshComposio, disconnectComposio, activeConnectionId,
  getCredentials, setCredential, setDiscordOwner,
  normalizeCredentialRows, isConnected, CODEX_MANAGED_SECRETS,
  connectedToolkits, searchToolkits, toolkitStatus,
  type CredentialRow, type CredentialDescriptor, type ComposioToolkit,
} from '@/lib/connect';

function prettyName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function Section({ icon: Icon, title, subtitle, children, action }: {
  icon: typeof Plug; title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Icon className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">{title}</h3>
          {subtitle && <p className="text-small text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Connect() {
  const qc = useQueryClient();
  const composio = usePoll(['composio-status'], getComposioStatus, 20000);
  const toolkits = usePoll(['composio-toolkits'], getComposioToolkits, 30000);
  const creds = usePoll(['credentials'], getCredentials, 20000);

  const [appQuery, setAppQuery] = useState('');
  const snap = toolkits.data;
  const connected = connectedToolkits(snap);
  const results = searchToolkits(snap, appQuery);
  const credentialRows = normalizeCredentialRows(creds.data?.rows);
  const descriptors = creds.data?.descriptors ?? {};
  const discordAllowedUsers = creds.data?.discordAllowedUsers ?? '';
  const codexSignedIn = Boolean(creds.data?.auth?.codexOauthPresent);

  const [refreshing, setRefreshing] = useState(false);
  const [appNotice, setAppNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const refreshApps = async () => {
    setRefreshing(true); setAppNotice(null);
    try {
      await refreshComposio();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['composio-status'] }),
        qc.invalidateQueries({ queryKey: ['composio-toolkits'] }),
      ]);
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setRefreshing(false); }
  };

  const connectApp = async (slug: string) => {
    setAppNotice(null);
    try {
      const res = await authorizeComposio(slug);
      const url = res.url || res.redirectUrl;
      if (url) {
        window.open(url, '_blank', 'noopener');
        setAppNotice({ tone: 'info', text: 'Finish connecting in the window that opened — this list refreshes when you come back.' });
        // Auto-refresh when the user returns from the OAuth window.
        const onFocus = () => { window.removeEventListener('focus', onFocus); void refreshApps(); };
        window.addEventListener('focus', onFocus);
      } else {
        setAppNotice({ tone: 'error', text: 'No authorization URL was returned.' });
      }
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
  };

  const disconnectApp = async (t: ComposioToolkit) => {
    const id = activeConnectionId(t);
    if (!id) { setAppNotice({ tone: 'error', text: 'No active connection found to disconnect.' }); return; }
    setAppNotice(null);
    try {
      await disconnectComposio(t.slug, id);
      setAppNotice({ tone: 'info', text: `Disconnected ${t.displayName || t.slug}.` });
      await refreshApps();
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
  };

  return (
    <Page title="Connect" subtitle="Give Clementine access to your apps, tools, and phone">
      {/* Apps */}
      <Section
        icon={Plug}
        title="Apps"
        subtitle="Apps you've connected through Composio"
        action={composio.data && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={refreshApps} disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-caption text-muted hover:text-fg cursor-pointer disabled:opacity-50"
              aria-label="Refresh apps" title="Refresh connection status">
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Refresh
            </button>
            <StatusPill tone={composio.data.apiKeyPresent ? 'success' : 'neutral'}>
              {composio.data.apiKeyPresent ? 'Composio connected' : 'Not set up'}
            </StatusPill>
          </div>
        )}
      >
        {appNotice && (
          <p className={cn('mb-3 rounded-md border px-3 py-2 text-small',
            appNotice.tone === 'error' ? 'border-danger/40 bg-danger-tint text-danger' : 'border-border bg-subtle text-muted')}>
            {appNotice.text}
          </p>
        )}
        {/* Search to find + connect a new app from the full catalog. */}
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-3">
          <Search className="h-4 w-4 text-faint" aria-hidden />
          <input
            value={appQuery}
            onChange={(e) => setAppQuery(e.target.value)}
            placeholder="Search apps to connect (Gmail, Slack, Salesforce…)"
            aria-label="Search apps"
            className="h-11 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint"
          />
          {appQuery && <button type="button" onClick={() => setAppQuery('')} aria-label="Clear" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>}
        </div>

        {toolkits.isLoading ? (
          <TileSkeleton />
        ) : appQuery ? (
          results.length === 0
            ? <Card className="p-4 text-body text-muted">No apps match “{appQuery}”.</Card>
            : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onDisconnect={() => disconnectApp(t)} />)}
              </div>
        ) : connected.length === 0 ? (
          <Card className="p-5 text-body text-muted">No apps connected yet — search above to connect Gmail, Slack, your CRM, and more.</Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onDisconnect={() => disconnectApp(t)} />)}
          </div>
        )}
      </Section>

      {/* Keys & accounts */}
      <Section icon={KeyRound} title="Keys & accounts" subtitle="API keys and sign-ins Clementine uses">
        {creds.isLoading ? <TileSkeleton /> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {credentialRows.length === 0 && <Card className="p-4 text-body text-muted">Nothing configured yet.</Card>}
            {credentialRows.map((row, i) => (
              <CredentialCard key={row.name || i} row={row} descriptor={descriptors[row.name ?? '']}
                discordAllowedUsers={row.name === 'discord_bot_token' ? discordAllowedUsers : undefined}
                codexSignedIn={codexSignedIn}
                onSaved={() => qc.invalidateQueries({ queryKey: ['credentials'] })} />
            ))}
          </div>
        )}
      </Section>

      {/* MCP */}
      <McpManager />

      {/* CLIs — save-to-confirm, not a PATH dump */}
      <CliTools />

      {/* Projects & folders */}
      <ProjectsPanel />

      {/* Mobile */}
      <MobilePanel />
    </Page>
  );
}

function AppCard({ t, onConnect, onDisconnect }: { t: ComposioToolkit; onConnect: () => void; onDisconnect?: () => void | Promise<void> }) {
  const status = toolkitStatus(t);
  const name = t.displayName || t.slug;
  const [imgOk, setImgOk] = useState(Boolean(t.logoUrl));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const canDisconnect = Boolean(onDisconnect) && status !== 'none';

  const doDisconnect = async () => {
    setBusy(true);
    try { await onDisconnect?.(); } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <Card className="flex items-center gap-3 p-4">
      {imgOk
        ? <img src={t.logoUrl} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md object-contain" onError={() => setImgOk(false)} />
        : <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-subtle text-body font-semibold text-muted">{name.slice(0, 1).toUpperCase()}</div>}
      <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{name}</span>
      {confirming ? (
        <div className="flex items-center gap-1.5">
          <span className="text-caption text-muted">Disconnect?</span>
          <Button size="sm" variant="danger" onClick={doDisconnect} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Yes'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>No</Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {status === 'active'
            ? <StatusPill tone="success">Connected</StatusPill>
            : status === 'expired'
              ? <Button size="sm" variant="secondary" onClick={onConnect}><RotateCw className="h-4 w-4" aria-hidden /> Reconnect</Button>
              : <Button size="sm" variant="secondary" onClick={onConnect}>Connect</Button>}
          {canDisconnect && (
            <Button size="sm" variant="ghost" aria-label={`Disconnect ${name}`} title="Disconnect" onClick={() => setConfirming(true)}>
              <Unplug className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function CredentialCard({ row, descriptor, discordAllowedUsers, codexSignedIn = false, onSaved }: {
  row: CredentialRow; descriptor?: CredentialDescriptor; discordAllowedUsers?: string; codexSignedIn?: boolean; onSaved: () => void;
}) {
  const name = row.name ?? '';
  // Codex OAuth tokens are stored + refreshed automatically by the sign-in
  // flow — never user-pasted. Show them green when signed in and hide the
  // Set/Update editor so no one can clobber the auto-managed refresh token.
  const managed = CODEX_MANAGED_SECRETS.has(name);
  const connected = managed ? codexSignedIn : isConnected(row);
  const required = descriptor?.required ?? false;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const label = prettyName(name);
  const showDiscordOwner = discordAllowedUsers !== undefined;

  const save = async () => {
    if (!value.trim() || !name) return;
    setSaving(true); setError('');
    try { await setCredential(name, value.trim()); setValue(''); setEditing(false); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-fg" title={descriptor?.description}>{label}</div>
          {descriptor?.description && <div className="truncate text-caption text-faint" title={descriptor.description}>{descriptor.description}</div>}
        </div>
        <StatusPill tone={connected ? 'success' : required ? 'warning' : 'neutral'}>
          {connected ? 'Connected' : managed ? 'Sign in needed' : required ? 'Action needed' : 'Optional'}
        </StatusPill>
        {!editing && !managed && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{connected ? 'Update' : 'Set'}</Button>
        )}
      </div>
      {editing && (
        <div className="mt-3 flex gap-2">
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste value…" aria-label={`${label} value`} className="flex-1" />
          <Button size="sm" onClick={save} disabled={saving || !value.trim()}>{saving ? '…' : <Check className="h-4 w-4" aria-hidden />}</Button>
          <Button variant="ghost" size="icon" onClick={() => { setEditing(false); setValue(''); setError(''); }} aria-label="Cancel"><X className="h-4 w-4" aria-hidden /></Button>
        </div>
      )}
      {error && <p className="mt-2 text-caption text-danger">{error}</p>}
      {showDiscordOwner && <DiscordOwnerField initial={discordAllowedUsers ?? ''} onSaved={onSaved} />}
    </Card>
  );
}

// A saved Discord bot token connects the bot but it stays MUTE until your
// user ID is on the allow-list. This surfaces that field right on the card.
function DiscordOwnerField({ initial, onSaved }: { initial: string; onSaved: () => void }) {
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    setSaving(true); setMsg(''); setError('');
    try { await setDiscordOwner(val.trim()); setMsg('Saved — applies on restart'); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="mb-1 text-caption font-medium text-muted">Your Discord User ID</div>
      <p className="mb-2 text-caption text-faint">The bot only replies to you. Developer Mode → right-click your name → Copy User ID.</p>
      <div className="flex gap-2">
        <Input value={val} onChange={(e) => { setVal(e.target.value); setMsg(''); }} placeholder="e.g. 123456789012345678" aria-label="Discord User ID" className="flex-1" />
        <Button size="sm" onClick={save} disabled={saving || val.trim() === initial.trim()}>{saving ? '…' : 'Save'}</Button>
      </div>
      {msg && <p className="mt-1 text-caption text-success">{msg}</p>}
      {error && <p className="mt-1 text-caption text-danger">{error}</p>}
    </div>
  );
}

function TileSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
    </div>
  );
}
