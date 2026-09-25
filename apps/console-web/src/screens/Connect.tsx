import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, KeyRound, Check, X, Search, RotateCw, RefreshCw, Loader2, Unplug, Mail, Tag, Plus, Pencil, ExternalLink, MessageCircle, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Page } from '@/components/Page';
import { PluginsPanel } from '@/components/connect/PluginsPanel';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
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
  getComposioCliDefaultAccounts, authorizeComposioCliDefaultAccount, revokeComposioCliDefaultAccount,
  setAccountLabel, setComposioApiKey, setupComposioCredentials, setupComposioOAuthApp,
  getCredentials, setCredential, setDiscordOwner,
  normalizeCredentialRows, isConnected, keyUrlHost, CODEX_MANAGED_SECRETS,
  connectedToolkits, reconnectConnectionId, searchToolkits, staleConnectionStory, toolkitStatus, toolkitConnectKind,
  type CredentialRow, type CredentialDescriptor, type ComposioToolkit, type ComposioConnection,
  type ComposioConnectResult, type ComposioSetupMeta, type ComposioSetupField, type ComposioOAuthAppSetup,
  type ComposioCliDefaultAccountAuthority,
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
  const cliDefaults = usePoll(['composio-cli-default-accounts'], getComposioCliDefaultAccounts, 30000);
  const creds = usePoll(['credentials'], getCredentials, 20000);

  const [appQuery, setAppQuery] = useState('');
  const snap = toolkits.data;
  const connected = connectedToolkits(snap);
  const results = searchToolkits(snap, appQuery);
  const appsUnavailable = composio.isError || toolkits.isError;
  const cliOnlyComposio = composio.data?.executionBackend === 'cli'
    || (composio.data?.executionBackend === 'auto' && !composio.data?.apiKeyPresent);
  const cliAuthenticated = composio.data?.cli?.authenticated === true;
  // Internal plumbing never renders as a user row: the webhook secret is the
  // console's own auth — editing it here would only log the user out. Model
  // accounts (the Codex sign-in pair, the OpenAI key, the TypeSafe key) live
  // in Settings › Models beside their usage and billing, so they are not
  // repeated here; one row points there instead.
  const HIDDEN_CREDENTIAL_ROWS = new Set([
    'codex_oauth_access_token', 'codex_oauth_refresh_token', 'openai_api_key', 'typesafe_api_key', 'webhook_secret',
  ]);
  const credentialRows = normalizeCredentialRows(creds.data?.rows)
    .filter((row) => !HIDDEN_CREDENTIAL_ROWS.has(row.name ?? ''));
  const descriptors = creds.data?.descriptors ?? {};
  const discordAllowedUsers = creds.data?.discordAllowedUsers ?? '';
  const codexSignedIn = Boolean(creds.data?.auth?.codexOauthPresent);

  const [refreshing, setRefreshing] = useState(false);
  const [appNotice, setAppNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [setupForm, setSetupForm] = useState<AppSetupForm | null>(null);

  /** Open a sign-in link in the browser; the words go back to the card. */
  const openAuthorization = (res: ComposioConnectResult, prefix = ''): string => {
    const url = res.url || res.redirectUrl;
    if (!url) throw new Error('Composio did not return a sign-in link. Try again in a moment.');
    window.open(url, '_blank', 'noopener');
    const onFocus = () => { window.removeEventListener('focus', onFocus); void refreshApps(); };
    window.addEventListener('focus', onFocus);
    return `${prefix}Finish signing in in your browser — this list refreshes when you come back.`;
  };

  /** Act on what connecting needs. Returns words for the card, or nothing
   *  when Clem's own form opened. Throws in plain words on failure. */
  const handleConnectResult = (slug: string, res: ComposioConnectResult, prefix = ''): string | undefined => {
    if (res.kind === 'credentials' || res.kind === 'details') {
      setSetupForm({ kind: res.kind, slug, setup: res.setup });
      return prefix.trim() || undefined;
    }
    if (res.kind === 'oauth_app') {
      setSetupForm({ kind: 'oauth_app', slug, app: res.app });
      return prefix.trim() || undefined;
    }
    if (res.kind === 'no_auth') return `No sign-in needed — Clementine can use ${res.name} now.`;
    return openAuthorization(res, prefix);
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

  // Connect and reconnect report on the card that was clicked, not in a
  // banner above the search box the person may not be looking at.
  const connectApp = async (slug: string): Promise<string | undefined> => {
    setAppNotice(null);
    return handleConnectResult(slug, await authorizeComposio(slug));
  };

  const reconnectApp = async (t: ComposioToolkit): Promise<string | undefined> => {
    const staleId = reconnectConnectionId(t);
    setAppNotice(null);
    const res = await reconnectComposio(t.slug, staleId);
    const prefix = !staleId
      ? ''
      : res.staleRemoved
        ? 'Removed the stale connection. '
        : 'The stale record could not be removed; the new connection will replace it for Clementine. ';
    return handleConnectResult(t.slug, res, prefix);
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
            <StatusPill tone={composio.data.apiKeyPresent || cliAuthenticated ? 'success' : 'neutral'}>
              {composio.data.apiKeyPresent
                ? 'Composio connected'
                : cliAuthenticated
                  ? 'Composio CLI connected'
                  : 'Not set up'}
            </StatusPill>
          </div>
        )}
      >
        {appsUnavailable && (
          <QueryUnavailable
            title="Connected apps are unavailable"
            description="Clementine couldn’t verify Composio or its connection catalog. This is not an empty-app state."
            onRetry={() => {
              void composio.refetch();
              void toolkits.refetch();
            }}
            className="mb-4 py-10"
          />
        )}
        {!appsUnavailable && appNotice && (
          <p className={cn('mb-3 rounded-md border px-3 py-2 text-small',
            appNotice.tone === 'error' ? 'border-danger/40 bg-danger-tint text-danger' : 'border-border bg-subtle text-muted')}>
            {appNotice.text}
          </p>
        )}
        {/* Composio API key — the ONE thing you get from composio.dev. Enter/reset
            it here; everything else (connect, add accounts, label) stays in-app. */}
        {!appsUnavailable && composio.data && (
          <ComposioApiKeyCard
            present={Boolean(composio.data.apiKeyPresent)}
            onSaved={() => { void refreshApps(); }}
          />
        )}
        {!appsUnavailable && cliOnlyComposio && cliAuthenticated && (
          <CliDefaultAccountsCard
            authorities={cliDefaults.data?.authorities ?? []}
            loading={cliDefaults.isLoading}
            unavailable={cliDefaults.isError}
            onAuthorize={async (toolkit, label) => {
              await authorizeComposioCliDefaultAccount(toolkit, label);
              await qc.invalidateQueries({ queryKey: ['composio-cli-default-accounts'] });
            }}
            onRevoke={async (toolkit) => {
              await revokeComposioCliDefaultAccount(toolkit);
              await qc.invalidateQueries({ queryKey: ['composio-cli-default-accounts'] });
            }}
          />
        )}
        {/* Search to find + connect a new app from the full catalog. */}
        {!appsUnavailable && <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-primary">
          <Search className="h-4 w-4 text-faint" aria-hidden />
          <input
            value={appQuery}
            onChange={(e) => setAppQuery(e.target.value)}
            placeholder="Search apps to connect (Gmail, Slack, Salesforce…)"
            aria-label="Search apps"
            className="h-11 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint"
          />
          {appQuery && <button type="button" onClick={() => setAppQuery('')} aria-label="Clear" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>}
        </div>}

        {!appsUnavailable && (toolkits.isLoading || composio.isLoading) ? (
          <TileSkeleton />
        ) : !appsUnavailable && appQuery ? (
          results.length === 0
            ? <Card className="p-4 text-body text-muted">No apps match “{appQuery}”.</Card>
            : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onReconnect={() => reconnectApp(t)} onDisconnectConnection={disconnectConnection} onSaveLabel={saveLabel} />)}
              </div>
        ) : !appsUnavailable && connected.length === 0 ? (
          <Card className="p-5 text-body text-muted">No apps connected yet — search above to connect Gmail, Slack, your CRM, and more.</Card>
        ) : !appsUnavailable ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((t) => <AppCard key={t.slug} t={t} onConnect={() => connectApp(t.slug)} onReconnect={() => reconnectApp(t)} onDisconnectConnection={disconnectConnection} onSaveLabel={saveLabel} />)}
          </div>
        ) : null}
      </Section>

      {/* Keys & accounts — uniform single-line rows, not an uneven card grid */}
      <Section icon={KeyRound} title="Keys & accounts" subtitle="API keys and sign-ins Clementine uses">
        {creds.isLoading ? <TileSkeleton /> : creds.isError ? (
          <QueryUnavailable
            title="Keys and accounts are unavailable"
            description="Clementine couldn’t verify the credential inventory. Nothing has been removed."
            onRetry={() => { void creds.refetch(); }}
            className="py-10"
          />
        ) : (
          <div className="space-y-2">
            <Card className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-fg">Model accounts</div>
                <div className="truncate text-caption text-faint">Claude, Codex, Grok, OpenAI, Jev and API-key models: sign-ins, keys, usage and where to add credit.</div>
              </div>
              <Link to="/settings#accounts" className="inline-flex shrink-0 items-center gap-1 text-small font-medium text-primary hover:underline">
                Settings › Models <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </Card>
            {credentialRows.length === 0 && <Card className="p-4 text-body text-muted">Nothing else configured yet.</Card>}
            {credentialRows.map((row, i) => (
              <CredentialCard key={row.name || i} row={row} descriptor={descriptors[row.name ?? '']}
                discordAllowedUsers={row.name === 'discord_bot_token' ? discordAllowedUsers : undefined}
                codexSignedIn={codexSignedIn}
                onSaved={() => qc.invalidateQueries({ queryKey: ['credentials'] })} />
            ))}
          </div>
        )}
      </Section>

      {/* Talk to Clementine — the channels where you chat with her, grouped
          in one place: Slack (compact wizard row) + your phone. Discord is a
          single token — it stays a row in Keys & accounts above. */}
      <Section icon={MessageCircle} title="Talk to Clementine" subtitle="Chat channels — Slack and your phone. (Discord: set its token in Keys & accounts.)">
        <div className="space-y-3">
          <SlackConnect />
          <MobilePanel />
        </div>
      </Section>

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

      {setupForm && (
        <ComposioSetupModal
          key={`${setupForm.kind}:${setupForm.slug}`}
          form={setupForm}
          onClose={() => setSetupForm(null)}
          onSaved={async () => {
            const name = setupForm.kind === 'oauth_app' ? setupForm.app.name : setupForm.setup.name || setupForm.slug;
            setSetupForm(null);
            await refreshApps();
            setAppNotice({ tone: 'info', text: `${name} connected inside Clementine.` });
          }}
          onAuthorized={(res) => {
            setSetupForm(null);
            setAppNotice({ tone: 'info', text: openAuthorization(res) });
          }}
        />
      )}
    </Page>
  );
}

/** The three things Clem can ask for in its own window, so connecting an app
 *  never sends the person to Composio's site. */
type AppSetupForm =
  | { kind: 'credentials'; slug: string; setup: ComposioSetupMeta }
  | { kind: 'details'; slug: string; setup: ComposioSetupMeta }
  | { kind: 'oauth_app'; slug: string; app: ComposioOAuthAppSetup };

const GENERIC_KEY_FIELD: ComposioSetupField = { name: 'generic_api_key', label: 'API Key', description: null, default: null, isSecret: true, required: true };

function SetupFields({ fields, values, onChange, onEnter, autoFocus }: {
  fields: ComposioSetupField[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onEnter: () => void;
  autoFocus: boolean;
}) {
  return (
    <>
      {fields.map((field, index) => (
        <label key={field.name} className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-fg">
            {field.label || field.name}
            {field.required !== false && <span className="text-danger"> *</span>}
          </span>
          <Input
            type={field.isSecret || /secret|token|password|api_key/i.test(field.name) ? 'password' : 'text'}
            value={values[field.name] ?? ''}
            onChange={(event) => onChange(field.name, event.target.value)}
            autoFocus={autoFocus && index === 0}
            autoComplete="off"
            placeholder={field.default ?? ''}
            onKeyDown={(event) => { if (event.key === 'Enter') onEnter(); }}
          />
          {field.description && <span className="text-caption text-faint">{field.description}</span>}
        </label>
      ))}
    </>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-small font-medium text-fg">{label}</span>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} aria-label={label} className="flex-1 font-mono text-caption" onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" variant="secondary" onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
        }}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : null}{copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function ComposioSetupModal({ form, onClose, onSaved, onAuthorized }: {
  form: AppSetupForm;
  onClose: () => void;
  /** Credentials saved: the account is connected. */
  onSaved: () => void | Promise<void>;
  /** A sign-in link is ready: open it. */
  onAuthorized: (res: ComposioConnectResult) => void;
}) {
  const name = form.kind === 'oauth_app' ? form.app.name : form.setup.name;
  // Developer-app fields: the redirect address is shown to copy, not typed.
  const appFields = form.kind === 'oauth_app'
    ? form.app.fields.filter((f) => !/redirect/i.test(f.name))
    : [];
  const requiredAppFields = appFields.filter((f) => f.required !== false);
  const optionalAppFields = appFields.filter((f) => f.required === false);
  const accountFields = form.kind === 'oauth_app'
    ? form.app.accountFields
    : form.setup.fields.length > 0 || form.kind === 'details' ? form.setup.fields : [GENERIC_KEY_FIELD];
  const allFields = [...appFields, ...accountFields];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(allFields.map((field) => [field.name, field.default ?? ''])),
  );
  const [showOptional, setShowOptional] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const pick = (fields: ComposioSetupField[]) =>
    Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? '').trim()]).filter(([, v]) => v));
  const missingRequired = allFields.some((field) => field.required !== false && !(values[field.name] ?? '').trim());
  const submit = async () => {
    if (busy || missingRequired) return;
    setBusy(true);
    setError('');
    try {
      if (form.kind === 'credentials') {
        await setupComposioCredentials(form.slug, values, form.setup.authScheme);
        await onSaved();
      } else if (form.kind === 'details') {
        onAuthorized(await authorizeComposio(form.slug, pick(accountFields)));
      } else {
        onAuthorized(await setupComposioOAuthApp(form.slug, {
          credentials: pick(appFields),
          details: pick(accountFields),
          authScheme: form.app.authScheme,
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect this app.');
    } finally {
      setBusy(false);
    }
  };
  const setValue = (field: string, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const helpUrl = form.kind === 'oauth_app'
    ? form.app.authHintUrl || form.app.authGuideUrl || form.app.appUrl
    : form.setup.authHintUrl || form.setup.authGuideUrl || form.setup.appUrl;

  const intro = form.kind === 'credentials'
    ? 'Add the credentials here. Clementine sends them directly to Composio and does not save them in her local settings.'
    : form.kind === 'details'
      ? `${name} needs a detail about your account before you sign in.`
      : `${name} doesn’t offer a shared sign-in, so it connects through a developer app you own. You set this up once; after that, connecting more accounts is one click.`;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-black/30 p-4 pt-[8vh] animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${name}`}
      onMouseDown={() => { if (!busy) onClose(); }}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="h-4 w-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-h3 text-fg">Connect {name}</h2>
            <p className="mt-0.5 text-small text-muted">{intro}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-faint hover:text-fg disabled:opacity-50" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="max-h-[66vh] space-y-4 overflow-y-auto p-5">
          {form.kind === 'oauth_app' ? (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-small text-muted">
                <li>
                  Create an app (sometimes called an OAuth client) in {name}’s developer settings.
                  {helpUrl && <>{' '}<a href={helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">Open {name} <ExternalLink className="h-3 w-3" aria-hidden /></a></>}
                </li>
                <li>Add the redirect address below to that app.</li>
                <li>Paste the app’s details here. Clementine creates the connection and opens {name}’s sign-in.</li>
              </ol>
              <CopyField label="Redirect address" value={form.app.callbackUrl} />
              <SetupFields fields={requiredAppFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus />
              {optionalAppFields.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowOptional((v) => !v)} className="text-caption font-medium text-muted hover:text-fg">
                    {showOptional ? 'Hide' : 'Show'} optional settings ({optionalAppFields.map((f) => f.label || f.name).join(', ')})
                  </button>
                  {showOptional && <div className="mt-3 space-y-4"><SetupFields fields={optionalAppFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus={false} /></div>}
                </div>
              )}
              {accountFields.length > 0 && <SetupFields fields={accountFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus={false} />}
            </>
          ) : (
            <>
              <SetupFields fields={accountFields} values={values} onChange={setValue} onEnter={() => void submit()} autoFocus />
              {helpUrl && (
                <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-small text-primary hover:underline">
                  Where to find {form.kind === 'details' ? 'this' : 'these credentials'} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              )}
            </>
          )}

          {error && <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || missingRequired}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}
            {busy ? 'Connecting…' : form.kind === 'credentials' ? 'Connect' : form.kind === 'details' ? 'Continue to sign in' : 'Save and sign in'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Under the app's name: what connecting will ask for, before the click. */
function connectKindNote(kind: ReturnType<typeof toolkitConnectKind>, name: string): string | null {
  if (kind === 'key') return 'Connects with an API key';
  if (kind === 'own_app') return `Needs your own ${name} app`;
  return null;
}

function AppCard({ t, onConnect, onReconnect, onDisconnectConnection, onSaveLabel }: {
  t: ComposioToolkit;
  /** Resolves to words for the card, or nothing when Clem's form opened. */
  onConnect: () => Promise<string | undefined>;
  onReconnect?: () => Promise<string | undefined>;
  onDisconnectConnection?: (slug: string, connectionId: string, who: string) => void | Promise<void>;
  onSaveLabel?: (slug: string, connectionId: string, email: string | null | undefined, label: string) => Promise<void>;
}) {
  const status = toolkitStatus(t);
  const name = t.displayName || t.slug;
  const kind = toolkitConnectKind(t);
  const note = status === 'none' ? connectKindNote(kind, name) : null;
  const [imgOk, setImgOk] = useState(Boolean(t.logoUrl));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  // Accounts under this app (a user may connect several mailboxes/workspaces).
  const accounts = (t.connections ?? []).filter((c) => c.id || c.connectionId);
  const isConnected = status !== 'none';

  const doConnect = async (reconnect: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const words = reconnect && onReconnect ? await onReconnect() : await onConnect();
      if (words) setMessage({ tone: 'info', text: words });
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        {imgOk
          ? <img src={t.logoUrl} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md object-contain" onError={() => setImgOk(false)} />
          : <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-subtle text-body font-semibold text-muted">{name.slice(0, 1).toUpperCase()}</div>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-fg">{name}</div>
          {note && <div className="truncate text-caption text-faint" title={note}>{note}</div>}
        </div>
        {status === 'active'
          ? <StatusPill tone="success">{accounts.length > 1 ? `${accounts.length} accounts` : 'Connected'}</StatusPill>
          : status === 'expired' || status === 'reconnect'
            ? <Button size="sm" variant="secondary" onClick={() => void doConnect(true)} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="h-4 w-4" aria-hidden />} Reconnect
              </Button>
            : kind === 'none'
              ? <StatusPill tone="neutral">No sign-in needed</StatusPill>
              : <Button size="sm" variant="secondary" onClick={() => void doConnect(false)} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {kind === 'own_app' ? 'Set up' : 'Connect'}
                </Button>}
      </div>
      {message && (
        <p className={cn('mt-3 rounded-md border px-3 py-2 text-small',
          message.tone === 'error' ? 'border-danger/40 bg-danger-tint text-danger' : 'border-border bg-subtle text-muted')}
          role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}

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
  // Never show a raw ca_… connection id as the account's name — that's
  // Composio plumbing. The id stays reachable via the hover title.
  const who = conn.accountEmail || conn.accountName || conn.userLabel || 'Unlabeled account';
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
          <span className="truncate text-small text-fg" title={id}>{who}</span>
          {needsReconnect && <StatusPill tone="warning">Needs reconnecting</StatusPill>}
        </div>
        {/* The pill names the state; this line tells the story — what broke and
            when — so a dead login never hides behind a quiet label. */}
        {needsReconnect && (
          <p className="mt-0.5 truncate text-caption text-warning" title={staleConnectionStory(conn) ?? undefined}>
            {staleConnectionStory(conn)}
          </p>
        )}
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

function CliDefaultAccountsCard({
  authorities,
  loading,
  unavailable,
  onAuthorize,
  onRevoke,
}: {
  authorities: ComposioCliDefaultAccountAuthority[];
  loading: boolean;
  unavailable: boolean;
  onAuthorize: (toolkit: string, label: string) => Promise<void>;
  onRevoke: (toolkit: string) => Promise<void>;
}) {
  const [toolkit, setToolkit] = useState('');
  const [label, setLabel] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const authorize = async () => {
    const slug = toolkit.trim().toLowerCase().replace(/[-\s]+/g, '_');
    const accountLabel = label.trim();
    if (!slug || !accountLabel || !confirmed || busy) return;
    setBusy(slug);
    setMessage(null);
    try {
      await onAuthorize(slug, accountLabel);
      setToolkit('');
      setLabel('');
      setConfirmed(false);
      setMessage({
        tone: 'info',
        text: `${slug} writes can now use the named CLI default after the normal exact approval card.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not authorize this CLI default.' });
    } finally {
      setBusy('');
    }
  };

  const revoke = async (slug: string) => {
    if (busy) return;
    setBusy(slug);
    setMessage(null);
    try {
      await onRevoke(slug);
      setMessage({
        tone: 'info',
        text: `${slug} CLI-default authority revoked. Older queued writes are now invalid.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not revoke this CLI default.' });
    } finally {
      setBusy('');
    }
  };

  return (
    <Card className="mb-4 border-primary/20 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Check className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-body font-medium text-fg">CLI default accounts for writes</span>
      </div>
      <p className="mb-3 text-small text-muted">
        CLI reads use the signed-in default automatically. For posts, sends, or updates, name the exact
        toolkit default you verified. Clementine still opens the normal byte-exact approval card before writing.
      </p>

      {unavailable ? (
        <p className="text-small text-danger">CLI-default authorities are unavailable. No new write authority was granted.</p>
      ) : loading ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <>
          {authorities.length > 0 && (
            <div className="mb-3 space-y-1.5">
              {authorities.map((authority) => (
                <div key={authority.toolkit} className="flex items-center gap-2 rounded-md border border-border bg-subtle px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-small font-medium text-fg">{prettyName(authority.toolkit)}</div>
                    <div className="truncate text-caption text-muted">{authority.label}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void revoke(authority.toolkit)}
                    disabled={Boolean(busy)}
                  >
                    {busy === authority.toolkit ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Revoke'}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={toolkit}
              onChange={(event) => setToolkit(event.target.value)}
              placeholder="Toolkit slug (e.g. instagram)"
              aria-label="Composio toolkit slug"
            />
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Account label (e.g. Brand Instagram)"
              aria-label="Verified CLI default account label"
            />
          </div>
          <label className="mt-2 flex cursor-pointer items-start gap-2 text-caption text-muted">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
            />
            I verified this is the provider-side account the Composio CLI currently uses for this toolkit.
          </label>
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              onClick={() => void authorize()}
              disabled={Boolean(busy) || !toolkit.trim() || !label.trim() || !confirmed}
            >
              {busy && !authorities.some((authority) => authority.toolkit === busy)
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                : <Check className="h-3.5 w-3.5" aria-hidden />}
              Authorize named default
            </Button>
          </div>
        </>
      )}
      {message && (
        <p className={cn('mt-2 text-caption', message.tone === 'error' ? 'text-danger' : 'text-muted')}>
          {message.text}
        </p>
      )}
    </Card>
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
  // One row stands in for the whole managed OAuth pair (see the list filter).
  const codexRow = name === 'codex_oauth_access_token';
  const label = codexRow ? 'Codex sign-in' : prettyName(name);
  const description = codexRow
    ? 'Signed in with your OpenAI subscription — managed in Settings → Models & routing.'
    : descriptor?.description;
  const showDiscordOwner = discordAllowedUsers !== undefined;
  const [ownerOpen, setOwnerOpen] = useState(false);
  const keyUrl = !managed && typeof descriptor?.keyUrl === 'string' ? descriptor.keyUrl : undefined;

  const save = async () => {
    if (!value.trim() || !name) return;
    setSaving(true); setError('');
    try { await setCredential(name, value.trim()); setValue(''); setEditing(false); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Card className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-fg" title={description}>{label}</div>
          {description && <div className="truncate text-caption text-faint" title={description}>{description}</div>}
        </div>
        {showDiscordOwner && !editing && (
          <button type="button" onClick={() => setOwnerOpen((v) => !v)} className="shrink-0 text-caption text-primary hover:underline cursor-pointer">
            {discordAllowedUsers?.trim() ? 'Bot owner' : 'Set bot owner'}
          </button>
        )}
        {keyUrl && !connected && !editing && (
          <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-caption text-primary hover:underline">
            Get a key <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
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
      {editing && keyUrl && (
        <p className="mt-2 text-caption text-muted">
          No key yet?{' '}
          <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            Get one at {keyUrlHost(keyUrl)} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </p>
      )}
      {error && <p className="mt-2 text-caption text-danger">{error}</p>}
      {codexRow && !connected && <CodexReauth signedIn={connected} onDone={onSaved} />}
      {showDiscordOwner && ownerOpen && <DiscordOwnerField initial={discordAllowedUsers ?? ''} onSaved={onSaved} />}
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
