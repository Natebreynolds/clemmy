import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, Search, X, Check, Plus, Loader2, Github, RotateCw, Download, KeyRound, ExternalLink, Copy, MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  getClis, getCliConnections, saveCli, removeSavedCli, probeCli,
  getManagedClis, startManagedCliJob, getManagedCliJob,
  getCliCatalog, installCatalogCli, forgetCatalogCli, getInstallJob,
  authCatalogCli, runInstallCommand, openTerminalAuth,
  type ManagedCliStatus, type ManagedCliKind, type ManagedCliAction,
  type CatalogEntry, type ConnectedCli, type CliHealth, type CliConnectionSnapshot,
} from '@/lib/connect';
import { isMac } from '@/lib/platform';
import { cliConnectionHealth, cliConnectionPresentation } from '@/lib/cli-connection-view';

const BARE = /^[A-Za-z0-9._+-]{1,60}$/;
// gh + composio are shown as rich managed cards; don't duplicate them in the catalog list.
const MANAGED_IDS = new Set(['gh', 'github', 'composio']);

export function CliTools() {
  const navigate = useNavigate();
  const connections = usePoll(['cli-connections'], getCliConnections, 5000);
  return (
    <section className="mb-8" aria-labelledby="cli-tools-heading">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <Terminal className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 basis-64">
          <h3 id="cli-tools-heading" className="text-h3 text-fg">Command-line tools</h3>
          <p className="max-w-prose text-small text-muted">Tell Clem which tool you need. She can install it, remember tools already on your computer, and check access. Finish any browser or private sign-in prompts when asked.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => navigate('/chat')}>
          <MessageCircle className="h-4 w-4" aria-hidden /> Ask Clem
        </Button>
      </div>
      {connections.isError && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-small text-muted">
        Connection status could not refresh. Saved tools are kept.
        <Button size="sm" variant="ghost" onClick={() => { void connections.refetch(); }}>Refresh status</Button>
      </div>}
      <ManagedClis connections={connections.data} unavailable={connections.isError} />
      <CatalogTools connections={connections.data} unavailable={connections.isError} />
    </section>
  );
}

// ─── Auto-discovered managed CLIs: GitHub + Composio (live auth state) ──
function ManagedClis({ connections, unavailable }: { connections?: CliConnectionSnapshot; unavailable: boolean }) {
  const qc = useQueryClient();
  const managed = usePoll(['managed-clis'], getManagedClis, 0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');

  const jobQ = useQuery({
    queryKey: ['managed-cli-job', jobId],
    queryFn: () => getManagedCliJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const job = jobQ.data?.job;
  useEffect(() => {
    if (job && job.status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['managed-clis'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
      setPending(null);
    }
  }, [job?.status, qc]);

  const run = async (kind: ManagedCliKind, action: ManagedCliAction) => {
    setPending(`${kind}:${action}`); setError('');
    try { const { job } = await startManagedCliJob(kind, action); setJobId(job.id); }
    catch (e) { setPending(null); setError((e as Error).message); }
  };

  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2">
      <ManagedCard label="GitHub CLI" command="gh" icon={Github} status={managed.data?.github} health={cliConnectionHealth(connections?.health, 'github', 'gh')} unavailable={unavailable} busy={pending} loading={managed.isLoading} onRun={(a) => run('github', a)} />
      <ManagedCard label="Composio CLI" command="composio" icon={Terminal} status={managed.data?.composio?.cli} health={cliConnectionHealth(connections?.health, 'composio', 'composio')} unavailable={unavailable} busy={pending} loading={managed.isLoading} onRun={(a) => run('composio', a)} />
      {job && (
        <div className="sm:col-span-2 rounded-md border border-border bg-subtle p-3">
          <div className="mb-1 flex items-center gap-2 text-small">
            {job.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : job.status === 'succeeded' ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
            <span className="font-medium text-fg">{job.title}</span><span className="text-faint">· {job.status}</span>
          </div>
          {job.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-caption text-muted">{job.output}</pre>}
        </div>
      )}
      {error && <p className="sm:col-span-2 text-small text-danger">{error}</p>}
    </div>
  );
}

function ManagedCard({ label, command, icon: Icon, status, health, unavailable, busy, loading, onRun }: {
  label: string; command: string; icon: typeof Terminal; status?: ManagedCliStatus; health?: CliHealth; unavailable: boolean;
  busy: string | null; loading: boolean; onRun: (a: ManagedCliAction) => void;
}) {
  const navigate = useNavigate();
  const kind = command === 'gh' ? 'github' : 'composio';
  const isBusy = (a: ManagedCliAction) => busy === `${kind}:${a}`;
  const anyBusy = Boolean(busy?.startsWith(`${kind}:`));
  const installed = health?.installed ?? status?.installed;
  const presentation = cliConnectionPresentation({ health, installed, authRequired: true, unavailable });
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1 basis-32">
          <div className="flex flex-wrap items-center gap-x-2"><span className="text-body font-medium text-fg">{label}</span><span className="font-mono text-caption text-faint">{command}</span></div>
          {status?.version && <div className="truncate text-caption text-faint">{status.version}</div>}
        </div>
        {loading && !health ? <Loader2 className="h-4 w-4 animate-spin text-faint" aria-hidden /> : <StatusPill tone={presentation.tone} title={presentation.help} className="max-w-full whitespace-normal break-words">{presentation.label}{presentation.account ? ` · ${presentation.account}` : ''}</StatusPill>}
      </div>
      {presentation.state !== 'connected' && <p className="mt-2 text-caption text-muted">{presentation.help}</p>}
      {(status || health) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {presentation.state === 'not_installed' && <Button size="sm" disabled={anyBusy} onClick={() => onRun('install')}>{isBusy('install') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install</Button>}
          {presentation.state === 'signed_out' && <Button size="sm" disabled={anyBusy} onClick={() => onRun('auth')}>{isBusy('auth') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Sign in</Button>}
          {presentation.state === 'connected' && <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => onRun('repair')}>{isBusy('repair') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />} Re-auth</Button>}
          {!['not_installed', 'signed_out', 'connected'].includes(presentation.state) && <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => navigate('/chat')}><MessageCircle className="h-3.5 w-3.5" aria-hidden /> Ask Clem to check</Button>}
        </div>
      )}
    </Card>
  );
}

// Universal sign-in/re-auth: an EDITABLE login command (prefilled from the
// catalog when known, else a smart `<cli> login` guess) + copy + docs. Works
// for ANY CLI — known catalog tools get the exact command, others get a guess
// the user can correct. (Auth is interactive/browser-based, so we hand over
// the command rather than run it blindly; Clem can also run it on request.)
function AuthReveal({ command, authCommand, authDocsUrl, catalogId }: { command: string; authCommand?: string; authDocsUrl?: string; catalogId?: string }) {
  const [cmd, setCmd] = useState(authCommand || `${command} login`);
  const [copied, setCopied] = useState(false);
  const [terminalMsg, setTerminalMsg] = useState('');
  const [opening, setOpening] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const docs = authDocsUrl || `https://www.google.com/search?q=${encodeURIComponent(`${command} CLI login authenticate`)}`;
  const openTerminal = async () => {
    if (!catalogId) return;
    setOpening(true); setTerminalMsg('');
    try { const r = await openTerminalAuth(catalogId); setTerminalMsg(r.message); }
    catch (e) { setTerminalMsg((e as Error).message); }
    finally { setOpening(false); }
  };
  return (
    <div className="mt-2 rounded-md border border-border bg-subtle p-2.5">
      {catalogId && (
        <div className="mb-2 flex items-center gap-2">
          <Button size="sm" disabled={opening} onClick={() => void openTerminal()}>
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Terminal className="h-3.5 w-3.5" aria-hidden />} Open in Terminal
          </Button>
          <span className="text-caption text-faint">runs the sign-in for you — just finish the prompts</span>
        </div>
      )}
      {terminalMsg && <p className="mb-2 text-caption text-muted">{terminalMsg}</p>}
      <div className="mb-1 text-caption text-muted">Or run it yourself{authCommand ? '' : ' (edit if the command differs)'}:</div>
      <div className="flex items-center gap-2">
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Login command"
          className="min-w-0 flex-1 rounded bg-canvas px-2 py-1 font-mono text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        <button type="button" onClick={copy} aria-label="Copy command" title="Copy" className="cursor-pointer text-faint hover:text-fg">{copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}</button>
        <a href={docs} target="_blank" rel="noopener noreferrer" aria-label={authDocsUrl ? 'Auth docs' : 'Search the web for the login command'} title={authDocsUrl ? 'Docs' : 'Find the login command'} className="text-faint hover:text-fg"><ExternalLink className="h-4 w-4" aria-hidden /></a>
      </div>
    </div>
  );
}

/** Membership and availability alone never mean an account is connected. */
function HealthPill({ health, installed, authRequired, unavailable }: {
  health?: CliHealth; installed?: boolean; authRequired?: boolean; unavailable: boolean;
}) {
  const presentation = cliConnectionPresentation({ health, installed, authRequired, unavailable });
  return <StatusPill tone={presentation.tone} title={presentation.help} className="max-w-full whitespace-normal break-words">{presentation.label}{presentation.account ? ` · ${presentation.account}` : ''}</StatusPill>;
}

// ─── CLI catalog (install + connect) + free-form saved tools ──────────
function CatalogTools({ connections, unavailable }: { connections?: CliConnectionSnapshot; unavailable: boolean }) {
  const qc = useQueryClient();
  const catalog = usePoll(['cli-catalog', ''], () => getCliCatalog(), 0);
  const clis = usePoll(['clis'], getClis, 0);
  const connected: ConnectedCli[] = Object.values(connections?.connected ?? catalog.data?.connected ?? {}).filter((c) => !MANAGED_IDS.has(c.id));
  const connectedCmds = new Set(connected.map((c) => c.command));
  const saved = connections?.saved ?? [];
  const savedSet = new Set(saved);
  const savedOnly = saved.filter((name) => !connectedCmds.has(name));

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState<string | null>(null);
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  const [authJobId, setAuthJobId] = useState<string | null>(null);

  const healthFor = (id: string, command: string) => cliConnectionHealth(connections?.health, id, command);
  const authRequiredFor = (id: string, command: string) => connections?.authRequired[id] ?? connections?.authRequired[command];

  const q = query.trim();
  const searchQ = useQuery({ queryKey: ['cli-catalog', q], queryFn: () => getCliCatalog(q), enabled: q.length > 0 });
  const catResults: CatalogEntry[] = searchQ.data?.results ?? [];
  const catCommands = new Set(catResults.map((r) => r.command));

  const rows = clis.data?.clis ?? [];
  const detectedInstalled = (command: string) => rows.some((row) => row.command === command && row.isLikelyCli) ? true : undefined;
  const pathResults = q
    ? rows.filter((c) => (c.command ?? '').toLowerCase().includes(q.toLowerCase()) && !catCommands.has(c.command ?? ''))
        .sort((a, b) => Number(Boolean(b.isLikelyCli)) - Number(Boolean(a.isLikelyCli)) || (a.command ?? '').localeCompare(b.command ?? ''))
        .slice(0, 12)
    : [];

  const isBare = BARE.test(q);
  const exactKnown = catResults.some((c) => c.command.toLowerCase() === q.toLowerCase()) || pathResults.some((c) => c.command?.toLowerCase() === q.toLowerCase()) || savedSet.has(q);
  const probeQ = useQuery({ queryKey: ['cli-probe', q], queryFn: () => probeCli(q), enabled: Boolean(q) && isBare && !exactKnown, retry: false });

  const installJobQ = useQuery({
    queryKey: ['install-job', installJobId],
    queryFn: () => getInstallJob(installJobId!),
    enabled: Boolean(installJobId),
    refetchInterval: (qq) => (qq.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const installJob = installJobQ.data?.job;
  useEffect(() => {
    if (installJob && installJob.status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['cli-catalog'] });
      void qc.invalidateQueries({ queryKey: ['clis'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
      setBusy(null);
    }
  }, [installJob?.status, qc]);

  const authJobQ = useQuery({
    queryKey: ['catalog-auth-job', authJobId],
    queryFn: () => getManagedCliJob(authJobId!),
    enabled: Boolean(authJobId),
    refetchInterval: (qq) => (qq.state.data?.job?.status === 'running' ? 1500 : false),
  });
  const authJob = authJobQ.data?.job;
  useEffect(() => {
    if (authJob && authJob.status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['cli-catalog'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
      setBusy(null);
    }
  }, [authJob?.status, qc]);

  const signIn = async (id: string) => {
    setBusy(`auth:${id}`); setError('');
    try { const { job } = await authCatalogCli(id); setAuthJobId(job.id); }
    catch (e) { setBusy(null); setError((e as Error).message); }
  };

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cli-catalog'] }); void qc.invalidateQueries({ queryKey: ['cli-connections'] }); };
  const install = async (id: string) => {
    setBusy(`install:${id}`); setError('');
    try { const { job } = await installCatalogCli(id); setInstallJobId(job.id); }
    catch (e) { setBusy(null); setError((e as Error).message); }
  };
  const forget = async (id: string) => { setBusy(`forget:${id}`); try { await forgetCatalogCli(id); refresh(); } finally { setBusy(null); } };
  const save = async (command: string) => { setBusy(`save:${command}`); setError(''); try { await saveCli(command); void qc.invalidateQueries({ queryKey: ['cli-connections'] }); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const unsave = async (command: string) => { setBusy(`save:${command}`); try { await removeSavedCli(command); void qc.invalidateQueries({ queryKey: ['cli-connections'] }); } finally { setBusy(null); } };

  return (
    <>
      {/* Remembered catalog tools; the separate health pill describes access. */}
      {connected.length > 0 && (
        <div className="mb-3 space-y-2">
          {connected.map((c) => (
            <Card key={c.id} className="p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <Terminal className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <span className="text-body font-medium text-fg">{c.name}</span>
                  <span className="ml-2 font-mono text-caption text-faint">{c.command}</span>
                </div>
                <HealthPill health={healthFor(c.id, c.command)} installed={detectedInstalled(c.command)} authRequired={authRequiredFor(c.id, c.command)} unavailable={unavailable} />
                {c.authHeadless
                  ? <Button size="sm" variant="ghost" disabled={busy === `auth:${c.id}`} onClick={() => signIn(c.id)}>{busy === `auth:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Manage sign-in</Button>
                  : <Button size="sm" variant="ghost" onClick={() => setReveal(reveal === c.id ? null : c.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign-in options</Button>}
                <Button size="sm" variant="ghost" aria-label={`Forget ${c.name}`} title="Disconnect" disabled={busy === `forget:${c.id}`} onClick={() => forget(c.id)}>
                  {busy === `forget:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </div>
              {reveal === c.id && <AuthReveal command={c.command} authCommand={c.authCommand} authDocsUrl={c.authDocsUrl} catalogId={c.id} />}
            </Card>
          ))}
        </div>
      )}

      {/* Free-form saved tools (non-catalog only) — each gets universal Re-auth */}
      {savedOnly.length > 0 && (
        <div className="mb-3 space-y-2">
          {savedOnly.map((name) => (
            <Card key={name} className="p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <Terminal className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 basis-40 break-words font-mono text-small text-fg">{name}</span>
                <HealthPill health={healthFor(`saved:${name}`, name)} installed={detectedInstalled(name)} authRequired={authRequiredFor(`saved:${name}`, name)} unavailable={unavailable} />
                <Button size="sm" variant="ghost" onClick={() => setReveal(reveal === `saved:${name}` ? null : `saved:${name}`)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign-in options</Button>
                <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} title="Remove" disabled={busy === `save:${name}`} onClick={() => unsave(name)}>
                  {busy === `save:${name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </div>
              {reveal === `saved:${name}` && <AuthReveal command={name} />}
            </Card>
          ))}
        </div>
      )}

      {/* Sign-in job output */}
      {authJob && (
        <div className="mb-3 rounded-md border border-border bg-subtle p-3">
          <div className="mb-1 flex items-center gap-2 text-small">
            {authJob.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : authJob.status === 'succeeded' ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
            <span className="font-medium text-fg">{authJob.title}</span><span className="text-faint">· {authJob.status}</span>
            {authJob.status === 'running' && <span className="text-caption text-faint">— a browser window should open; finish signing in there</span>}
          </div>
          {authJob.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-caption text-muted">{authJob.output}</pre>}
        </div>
      )}

      {/* Install job output */}
      {installJob && (
        <div className="mb-3 rounded-md border border-border bg-subtle p-3">
          <div className="mb-1 flex items-center gap-2 text-small">
            {installJob.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> : installJob.status === 'succeeded' ? <Check className="h-4 w-4 text-success" aria-hidden /> : <X className="h-4 w-4 text-danger" aria-hidden />}
            <span className="font-medium text-fg">{installJob.title}</span><span className="text-faint">· {installJob.status}</span>
          </div>
          {installJob.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-caption text-muted">{installJob.output}</pre>}
        </div>
      )}

      {/* One search: catalog (install/connect) + your PATH (save) */}
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-surface px-3 focus-within:ring-2 focus-within:ring-primary">
        <Search className="h-4 w-4 text-faint" aria-hidden />
        <input value={query} onChange={(e) => { setQuery(e.target.value); setError(''); }}
          placeholder="Search to install or save a CLI (netlify, vercel, sf, jq…)" aria-label="Search CLIs"
          className="h-11 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>}
      </div>

      {error && <p className="mb-3 text-small text-danger">{error}</p>}

      {!q ? (
        <Card className="p-4 text-body text-muted">
          Prefer to manage setup yourself? Search to <span className="text-fg">install</span> a known tool or <span className="text-fg">save</span> a command already on your computer.
          {clis.data?.cliCount ? <span className="text-faint"> {clis.data.cliCount.toLocaleString()} detected on your PATH.</span> : null}
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Catalog matches — install or (if installed) re-auth */}
          {catResults.map((e) => {
            const health = healthFor(e.id, e.command);
            const installed = health?.installed ?? e.installed;
            return (
            <Card key={`cat:${e.id}`} className="p-3.5">
              <div className="flex flex-wrap items-center gap-3">
                {installed ? <Terminal className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : <Download className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="text-body font-medium text-fg">{e.name}</span><span className="font-mono text-caption text-faint">{e.command}</span></div>
                  <div className="truncate text-caption text-muted">{e.description}</div>
                </div>
                <HealthPill health={health} installed={installed} authRequired={authRequiredFor(e.id, e.command) ?? (e.authCommand ? true : undefined)} unavailable={unavailable} />
                {installed
                  ? (e.authHeadless
                      ? <Button size="sm" variant="secondary" disabled={busy === `auth:${e.id}`} onClick={() => signIn(e.id)}>{busy === `auth:${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Sign in</Button>
                      : <Button size="sm" variant="secondary" onClick={() => setReveal(reveal === e.id ? null : e.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign in</Button>)
                  : <Button size="sm" disabled={busy === `install:${e.id}`} onClick={() => install(e.id)}>{busy === `install:${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install</Button>}
              </div>
              {reveal === e.id && <AuthReveal command={e.command} authCommand={e.authCommand} authDocsUrl={e.authDocsUrl} catalogId={e.id} />}
            </Card>
            );
          })}

          {/* PATH matches not in the catalog — save them */}
          {pathResults.map((c, i) => (
            <Card key={`path:${c.command || i}`} className="flex items-center gap-3 p-3.5">
              <Terminal className="h-4 w-4 shrink-0 text-faint" aria-hidden />
              <div className="min-w-0 flex-1"><div className="truncate font-mono text-small text-fg">{c.command}</div>{c.isLikelyCli && c.version && <div className="truncate text-caption text-faint">{c.version}</div>}</div>
              {savedSet.has(c.command ?? '')
                ? <span className="inline-flex items-center gap-1 text-caption text-success"><Check className="h-3.5 w-3.5" aria-hidden /> Saved</span>
                : <Button size="sm" variant="secondary" disabled={busy === `save:${c.command}`} onClick={() => save(c.command ?? '')}>{busy === `save:${c.command}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Save</Button>}
            </Card>
          ))}

          {/* Bare name not found anywhere — probe + save anyway */}
          {isBare && !exactKnown && (
            <Card className="flex items-center gap-3 p-3.5">
              {probeQ.isLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-faint" aria-hidden /> : probeQ.data ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Terminal className="h-4 w-4 shrink-0 text-faint" aria-hidden />}
              <div className="min-w-0 flex-1"><div className="truncate font-mono text-small text-fg">{q}</div><div className="truncate text-caption text-faint">{probeQ.isLoading ? 'Checking your PATH…' : probeQ.data ? `Found at ${probeQ.data.path}` : 'Not auto-detected — save it and Clementine will still try it'}</div></div>
              {savedSet.has(q)
                ? <span className="inline-flex items-center gap-1 text-caption text-success"><Check className="h-3.5 w-3.5" aria-hidden /> Saved</span>
                : <Button size="sm" variant="secondary" disabled={busy === `save:${q}`} onClick={() => save(q)}>{busy === `save:${q}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Save</Button>}
            </Card>
          )}

          {catResults.length === 0 && pathResults.length === 0 && !(isBare && !exactKnown) && (searchQ.isFetching ? <Card className="p-4 text-body text-muted">Searching…</Card> : <Card className="p-4 text-body text-muted">No tool matches “{q}”.</Card>)}
        </div>
      )}

      <CustomInstall onJob={(id) => { setInstallJobId(id); setBusy('install:custom'); }} />
    </>
  );
}

/** Paste-your-own install command. Validated SERVER-SIDE against the same
 *  allowlist as catalog installs (npm -g / brew / uv tool / pipx / pip
 *  --user / git clone https — no sudo, no pipes); "remember" saves the
 *  binary name to the roster once the install succeeds. */
function CustomInstall({ onJob }: { onJob: (jobId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [remember, setRemember] = useState(true);
  const [saveAs, setSaveAs] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const guessedName = (() => {
    const words = command.trim().split(/\s+/);
    const last = words[words.length - 1] ?? '';
    const bare = last.split('/').pop()?.replace(/^@[^/]+\//, '') ?? '';
    return BARE.test(bare) ? bare : '';
  })();

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const name = remember ? (saveAs.trim() || guessedName) : '';
      const { job } = await runInstallCommand(command.trim(), name || undefined);
      onJob(job.id);
      setCommand(''); setSaveAs(''); setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-3 cursor-pointer text-small text-muted underline-offset-2 hover:text-fg hover:underline">
        Have an install command? Paste it to review and run it here.
      </button>
    );
  }
  return (
    <Card className="mt-3 p-3.5">
      <div className="mb-2 text-small font-medium text-fg">Paste an install command</div>
      <div className="mb-2 flex items-center gap-2">
        <input value={command} onChange={(e) => { setCommand(e.target.value); setError(''); }}
          placeholder={isMac() ? 'npm install -g some-cli   ·   brew install some-tool' : 'npm install -g some-cli'} aria-label="Install command"
          className="min-w-0 flex-1 rounded border border-border bg-canvas px-2.5 py-1.5 font-mono text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        <Button size="sm" disabled={!command.trim() || submitting} onClick={() => void submit()}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(''); }} aria-label="Close"><X className="h-3.5 w-3.5" aria-hidden /></Button>
      </div>
      <label className="flex items-center gap-2 text-caption text-muted">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember this CLI for Clementine
        {remember && (
          <input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder={guessedName || 'binary name'}
            aria-label="CLI name to remember"
            className="w-32 rounded border border-border bg-canvas px-2 py-0.5 font-mono text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        )}
      </label>
      <p className="mt-1.5 text-caption text-faint">Allowed forms: npm install -g · {isMac() ? 'brew install · ' : ''}uv tool install · pipx install · pip install --user · git clone https. Anything else is refused.</p>
      {error && <p className="mt-1.5 text-caption text-danger">{error}</p>}
    </Card>
  );
}
