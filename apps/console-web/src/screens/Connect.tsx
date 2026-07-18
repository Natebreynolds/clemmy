import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, KeyRound, Check, X, Search, RotateCw, RefreshCw, Loader2, Unplug, Mail, Tag, Plus, Pencil, ExternalLink } from 'lucide-react';
import { Page } from '@/components/Page';
import { PluginsPanel } from '@/components/connect/PluginsPanel';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { MobilePanel } from '@/components/connect/MobilePanel';
import { McpManager } from '@/components/connect/McpManager';
import { SlackConnect } from '@/components/connect/SlackConnect';
import { ProjectsPanel } from '@/components/connect/ProjectsPanel';
import { CliTools } from '@/components/connect/CliTools';
import { BrowserHarness } from '@/components/connect/BrowserHarness';
import { usePoll } from '@/lib/poll';
import { CodexReauth } from './settings/CodexLoginForm';
import {
  getComposioStatus, getComposioToolkits, authorizeComposio, reconnectComposio, refreshComposio, disconnectComposio,
  setAccountLabel, setComposioApiKey,
  getCredentials, setCredential, setDiscordOwner,
  normalizeCredentialRows, isConnected, CODEX_MANAGED_SECRETS,
  connectedToolkits, reconnectConnectionId, searchToolkits, toolkitStatus,
  type CredentialRow, type CredentialDescriptor, type ComposioToolkit, type ComposioConnection,
} from '@/lib/connect';

function prettyName(name: string): string {
  // Title-case the slug, then fix the acronyms/brands title-casing mangles
  // ("Openai Api Key" is not a 1.0 look).
  const titled = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return titled
    .replace(/\bOpenai\b/g, 'OpenAI')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bUrl\b/g, 'URL')
    .replace(/\bOauth\b/g, 'OAuth')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bZai\b/g, 'Z.ai');
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

  const openAuthorization = (res: { url?: string; redirectUrl?: string }, prefix = '') => {
    const url = res.url || res.redirectUrl;
    if (url) {
      window.open(url, '_blank', 'noopener');
      setAppNotice({ tone: 'info', text: `${prefix}Finish connecting in the window that opened — this list refreshes when you come back.` });
      const onFocus = () => { window.removeEventListener('focus', onFocus); void refreshApps(); };
      window.addEventListener('focus', onFocus);
    } else {
      setAppNotice({ tone: 'error', text: 'No authorization URL was returned.' });
    }
  };

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

  const connectApp = async (slug: string, prefix = '') => {
    setAppNotice(null);
    try {
      const res = await authorizeComposio(slug);
      openAuthorization(res, prefix);
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
  };

  const reconnectApp = async (t: ComposioToolkit) => {
    const staleId = reconnectConnectionId(t);
    setAppNotice(null);
    try {
      const res = await reconnectComposio(t.slug, staleId);
      const prefix = !staleId
        ? ''
        : res.staleRemoved
          ? 'Removed the stale connection. '
          : 'The stale record could not be removed; the new connection will replace it for Clementine. ';
      openAuthorization(res, prefix);
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
  };

  // Disconnect ONE specific account (mailbox) of a multi-account app.
  const disconnectConnection = async (slug: string, connectionId: string, who: string) => {
    setAppNotice(null);
    try {
      await disconnectComposio(slug, connectionId);
      setAppNotice({ tone: 'info', text: `Disconnected ${who}.` });
      await refreshApps();
    } catch (e) { setAppNotice({ tone: 'error', text: (e as Error).message }); }
  };

  // Set / clear the memory label for one account, then refresh so the agent and
  // the UI pick it up.
  const saveLabel = async (slug: string, connectionId: string, email: string | null | undefined, label: string) => {
    await setAccountLabel(connectionId, { toolkit: slug, label, email });
    await qc.invalidateQueries({ queryKey: ['composio-toolkits'] });
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
        {/* Composio API key — the ONE thing you get from composio.dev. Enter/reset
            it here; everything else (connect, add accounts, label) stays in-app. */}
        {composio.data && (
          <ComposioApiKeyCard
            present={Boolean(composio.data.apiKeyPresent)}
            onSaved={() => { void refreshApps(); }}
          />
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
                {results.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onReconnect={() => reconnectApp(t)} onDisconnectConnection={disconnectConnection} onSaveLabel={saveLabel} />)}
              </div>
        ) : connected.length === 0 ? (
          <Card className="p-5 text-body text-muted">No apps connected yet — search above to connect Gmail, Slack, your CRM, and more.</Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onReconnect={() => reconnectApp(t)} onDisconnectConnection={disconnectConnection} onSaveLabel={saveLabel} />)}
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

      {/* Slack — guided two-way chat setup (manifest + 2 tokens) */}
      <SlackConnect />

      {/* Plugins — content cartridges (skills + workflows + MCP bundles) */}
      <PluginsPanel />

      {/* MCP */}
      <McpManager />

      {/* CLIs — save-to-confirm, not a PATH dump */}
      <CliTools />

      {/* Browser harness — drive the user's real Chrome */}
      <BrowserHarness />

      {/* Projects & folders */}
      <ProjectsPanel />

      {/* Mobile */}
      <MobilePanel />
    </Page>
  );
}

function AppCard({ t, onConnect, onReconnect, onDisconnectConnection, onSaveLabel }: {
  t: ComposioToolkit;
  onConnect: () => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onDisconnectConnection?: (slug: string, connectionId: string, who: string) => void | Promise<void>;
  onSaveLabel?: (slug: string, connectionId: string, email: string | null | undefined, label: string) => Promise<void>;
}) {
  const status = toolkitStatus(t);
  const name = t.displayName || t.slug;
  const [imgOk, setImgOk] = useState(Boolean(t.logoUrl));
  const [busy, setBusy] = useState(false);
  // Accounts under this app (a user may connect several mailboxes/workspaces).
  const accounts = (t.connections ?? []).filter((c) => c.id || c.connectionId);
  const isConnected = status !== 'none';

  const doConnect = async (reconnect: boolean) => {
    setBusy(true);
    try {
      if (reconnect && onReconnect) await onReconnect();
      else await onConnect();
    } finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        {imgOk
          ? <img src={t.logoUrl} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md object-contain" onError={() => setImgOk(false)} />
          : <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-subtle text-body font-semibold text-muted">{name.slice(0, 1).toUpperCase()}</div>}
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{name}</span>
        {status === 'active'
          ? <StatusPill tone="success">{accounts.length > 1 ? `${accounts.length} accounts` : 'Connected'}</StatusPill>
          : status === 'expired' || status === 'reconnect'
            ? <Button size="sm" variant="secondary" onClick={() => void doConnect(true)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="h-4 w-4" aria-hidden />} Reconnect
              </Button>
            : <Button size="sm" variant="secondary" onClick={() => void doConnect(false)} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Connect
              </Button>}
      </div>

      {isConnected && accounts.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-border pt-3">
          {accounts.map((c) => (
            <AccountRow
              key={c.id ?? c.connectionId}
              slug={t.slug}
              conn={c}
              onDisconnect={onDisconnectConnection}
              onSaveLabel={onSaveLabel}
            />
          ))}
          {/* Adding another account = start the OAuth flow again; Composio's
              link(allowMultiple) lets the same app hold several mailboxes. */}
          <button type="button" onClick={() => void doConnect(false)} disabled={busy}
            className="mt-1 inline-flex items-center gap-1 text-caption font-medium text-primary hover:underline cursor-pointer disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Add another account
          </button>
        </div>
      )}
    </Card>
  );
}

// One connected account (mailbox/workspace) with its status, memory label, and
// a per-account disconnect. The label writes to the same store the agent reads,
// so "send from my work mailbox" routes correctly.
function AccountRow({ slug, conn, onDisconnect, onSaveLabel }: {
  slug: string;
  conn: ComposioConnection;
  onDisconnect?: (slug: string, connectionId: string, who: string) => void | Promise<void>;
  onSaveLabel?: (slug: string, connectionId: string, email: string | null | undefined, label: string) => Promise<void>;
}) {
  const id = conn.id ?? conn.connectionId ?? '';
  const who = conn.accountEmail || conn.accountName || `${id.slice(0, 10)}…`;
  const needsReconnect = conn.needsReconnect === true || (conn.status ?? '').toUpperCase() === 'NEEDS_RECONNECT';
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(conn.userLabel ?? '');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const save = async () => {
    if (!onSaveLabel) return;
    setBusy(true);
    try { await onSaveLabel(slug, id, conn.accountEmail, label.trim()); setEditing(false); }
    finally { setBusy(false); }
  };
  const doDisconnect = async () => {
    setBusy(true);
    try { await onDisconnect?.(slug, id, who); } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1">
      <Mail className={cn('h-3.5 w-3.5 shrink-0', needsReconnect ? 'text-warning' : 'text-faint')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-small text-fg">{who}</span>
          {needsReconnect && <StatusPill tone="warning">Reconnect</StatusPill>}
        </div>
        {editing ? (
          <div className="mt-1 flex items-center gap-1.5">
            <Tag className="h-3 w-3 shrink-0 text-faint" aria-hidden />
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. work, personal)"
              className="h-7 flex-1 text-caption" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { setLabel(conn.userLabel ?? ''); setEditing(false); } }} />
            <Button size="sm" variant="secondary" onClick={() => void save()} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Save'}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setLabel(conn.userLabel ?? ''); setEditing(false); }} disabled={busy}>Cancel</Button>
          </div>
        ) : conn.userLabel ? (
          <button type="button" onClick={() => setEditing(true)} className="mt-0.5 inline-flex items-center gap-1 cursor-pointer" title="Rename label">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-caption font-medium text-primary">{conn.userLabel}</span>
            <Pencil className="h-3 w-3 text-faint" aria-hidden />
          </button>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="mt-0.5 inline-flex items-center gap-1 text-caption text-muted hover:text-fg cursor-pointer">
            <Tag className="h-3 w-3" aria-hidden /> Add label
          </button>
        )}
      </div>
      {!editing && (confirming ? (
        <div className="flex items-center gap-1">
          <span className="text-caption text-muted">Remove?</span>
          <Button size="sm" variant="danger" onClick={() => void doDisconnect()} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Yes'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>No</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" aria-label={`Disconnect ${who}`} title="Disconnect this account" onClick={() => setConfirming(true)}>
          <Unplug className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ))}
    </div>
  );
}

// Composio API key entry/reset — the single thing sourced from composio.dev.
// Expanded by default when no key is set (first-run), a quiet "Reset key" link
// once connected. The daemon validates the key against Composio before saving.
function ComposioApiKeyCard({ present, onSaved }: { present: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(!present);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const save = async () => {
    const value = key.trim();
    if (!value) return;
    setBusy(true); setMsg(null);
    try {
      const res = await setComposioApiKey(value);
      if (res?.error) { setMsg({ tone: 'error', text: res.error }); }
      else {
        setKey('');
        setMsg({ tone: 'info', text: res?.warning || 'Composio API key saved.' });
        setOpen(false);
        onSaved();
      }
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  if (present && !open) {
    return (
      <div className="mb-4 flex items-center gap-2 text-caption text-muted">
        <Check className="h-3.5 w-3.5 text-success" aria-hidden /> Composio API key set.
        <button type="button" onClick={() => setOpen(true)} className="text-primary hover:underline cursor-pointer">Reset key</button>
      </div>
    );
  }

  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-body font-medium text-fg">{present ? 'Reset your Composio API key' : 'Add your Composio API key'}</span>
      </div>
      <p className="mb-3 text-small text-muted">
        Paste your key from Composio — you only need to do this once.{' '}
        <a href="https://app.composio.dev/developers" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
          Get your key <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </p>
      <div className="flex items-center gap-2">
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="comp_…"
          className="h-10 flex-1" autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <Button onClick={() => void save()} disabled={busy || !key.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Save'}</Button>
        {present && <Button variant="ghost" onClick={() => { setOpen(false); setKey(''); setMsg(null); }} disabled={busy}>Cancel</Button>}
      </div>
      {msg && (
        <p className={cn('mt-2 text-caption', msg.tone === 'error' ? 'text-danger' : 'text-muted')}>{msg.text}</p>
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
      {name === 'codex_oauth_access_token' && <CodexReauth signedIn={connected} onDone={onSaved} />}
      {showDiscordOwner && <DiscordOwnerField initial={discordAllowedUsers ?? ''} onSaved={onSaved} />}
    </Card>
  );
}

// Codex re-auth lives in ./settings/CodexLoginForm (extracted so Settings → Models
// & routing can render it next to the Claude login). Connect renders the primitive
// CodexReauth on the codex_oauth_access_token credential card.

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
