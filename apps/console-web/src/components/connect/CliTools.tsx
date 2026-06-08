import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, Search, X, Check, Plus, Loader2, Github, RotateCw, Download, KeyRound, ExternalLink, Copy } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  getClis, getSavedClis, saveCli, removeSavedCli, probeCli,
  getManagedClis, startManagedCliJob, getManagedCliJob,
  getCliCatalog, installCatalogCli, forgetCatalogCli, getInstallJob,
  type ManagedCliStatus, type ManagedCliKind, type ManagedCliAction,
  type CatalogEntry, type ConnectedCli,
} from '@/lib/connect';

const BARE = /^[A-Za-z0-9._+-]{1,60}$/;
// gh + composio are shown as rich managed cards; don't duplicate them in the catalog list.
const MANAGED_IDS = new Set(['gh', 'github', 'composio']);

export function CliTools() {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2.5">
        <Terminal className="h-5 w-5 text-primary" aria-hidden />
        <div className="flex-1">
          <h3 className="text-h3 text-fg">Command-line tools</h3>
          <p className="text-small text-muted">Install tools, sign in, and save any CLI so Clementine can use it</p>
        </div>
      </div>
      <ManagedClis />
      <CatalogTools />
    </section>
  );
}

// ─── Auto-discovered managed CLIs: GitHub + Composio (live auth state) ──
function ManagedClis() {
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
    if (job && job.status !== 'running') { void qc.invalidateQueries({ queryKey: ['managed-clis'] }); setPending(null); }
  }, [job?.status, qc]);

  const run = async (kind: ManagedCliKind, action: ManagedCliAction) => {
    setPending(`${kind}:${action}`); setError('');
    try { const { job } = await startManagedCliJob(kind, action); setJobId(job.id); }
    catch (e) { setPending(null); setError((e as Error).message); }
  };

  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2">
      <ManagedCard label="GitHub CLI" command="gh" icon={Github} status={managed.data?.github} busy={pending} loading={managed.isLoading} onRun={(a) => run('github', a)} />
      <ManagedCard label="Composio CLI" command="composio" icon={Terminal} status={managed.data?.composio?.cli} busy={pending} loading={managed.isLoading} onRun={(a) => run('composio', a)} />
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

function ManagedCard({ label, command, icon: Icon, status, busy, loading, onRun }: {
  label: string; command: string; icon: typeof Terminal; status?: ManagedCliStatus; busy: string | null; loading: boolean; onRun: (a: ManagedCliAction) => void;
}) {
  const kind = command === 'gh' ? 'github' : 'composio';
  const isBusy = (a: ManagedCliAction) => busy === `${kind}:${a}`;
  const anyBusy = Boolean(busy?.startsWith(`${kind}:`));
  const tone = !status || !status.installed ? 'neutral' : status.authenticated ? 'success' : status.authStatus === 'missing' ? 'warning' : 'danger';
  const pill = !status ? '—' : !status.installed ? 'Not installed' : status.authenticated ? (status.username ? `@${status.username}` : 'Signed in') : status.authStatus === 'missing' ? 'Sign-in needed' : 'Auth needs repair';
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="text-body font-medium text-fg">{label}</span><span className="font-mono text-caption text-faint">{command}</span></div>
          {status?.version && <div className="truncate text-caption text-faint">{status.version}</div>}
        </div>
        {loading ? <Loader2 className="h-4 w-4 animate-spin text-faint" aria-hidden /> : <StatusPill tone={tone}>{pill}</StatusPill>}
      </div>
      {status && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!status.installed && <Button size="sm" disabled={anyBusy} onClick={() => onRun('install')}>{isBusy('install') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install</Button>}
          {status.installed && !status.authenticated && <Button size="sm" disabled={anyBusy} onClick={() => onRun('auth')}>{isBusy('auth') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Sign in</Button>}
          {status.installed && status.authenticated && <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => onRun('repair')}>{isBusy('repair') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />} Re-auth</Button>}
          {status.installed && !status.authenticated && status.authStatus !== 'missing' && <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => onRun('repair')}>{isBusy('repair') ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />} Repair</Button>}
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
function AuthReveal({ command, authCommand, authDocsUrl }: { command: string; authCommand?: string; authDocsUrl?: string }) {
  const [cmd, setCmd] = useState(authCommand || `${command} login`);
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const docs = authDocsUrl || `https://www.google.com/search?q=${encodeURIComponent(`${command} CLI login authenticate`)}`;
  return (
    <div className="mt-2 rounded-md border border-border bg-subtle p-2.5">
      <div className="mb-1 text-caption text-muted">Sign in / re-auth — run this in your terminal{authCommand ? '' : ' (edit if the command differs)'}:</div>
      <div className="flex items-center gap-2">
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} aria-label="Login command"
          className="min-w-0 flex-1 rounded bg-canvas px-2 py-1 font-mono text-caption text-fg outline-none focus:ring-1 focus:ring-primary" />
        <button type="button" onClick={copy} aria-label="Copy command" title="Copy" className="cursor-pointer text-faint hover:text-fg">{copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}</button>
        <a href={docs} target="_blank" rel="noopener noreferrer" aria-label={authDocsUrl ? 'Auth docs' : 'Search the web for the login command'} title={authDocsUrl ? 'Docs' : 'Find the login command'} className="text-faint hover:text-fg"><ExternalLink className="h-4 w-4" aria-hidden /></a>
      </div>
    </div>
  );
}

// ─── CLI catalog (install + connect) + free-form saved tools ──────────
function CatalogTools() {
  const qc = useQueryClient();
  const catalog = usePoll(['cli-catalog', ''], () => getCliCatalog(), 0);
  const clis = usePoll(['clis'], getClis, 30000);
  const savedQ = usePoll(['clis-saved'], getSavedClis, 0);
  const connected: ConnectedCli[] = Object.values(catalog.data?.connected ?? {}).filter((c) => !MANAGED_IDS.has(c.id));
  const connectedCmds = new Set(connected.map((c) => c.command));
  const saved = savedQ.data?.saved ?? [];
  const savedSet = new Set(saved);
  const savedOnly = saved.filter((name) => !connectedCmds.has(name));

  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState<string | null>(null);
  const [installJobId, setInstallJobId] = useState<string | null>(null);

  const q = query.trim();
  const searchQ = useQuery({ queryKey: ['cli-catalog', q], queryFn: () => getCliCatalog(q), enabled: q.length > 0 });
  const catResults: CatalogEntry[] = searchQ.data?.results ?? [];
  const catCommands = new Set(catResults.map((r) => r.command));

  const rows = clis.data?.clis ?? [];
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
      setBusy(null);
    }
  }, [installJob?.status, qc]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cli-catalog'] }); void qc.invalidateQueries({ queryKey: ['clis-saved'] }); };
  const install = async (id: string) => {
    setBusy(`install:${id}`); setError('');
    try { const { job } = await installCatalogCli(id); setInstallJobId(job.id); }
    catch (e) { setBusy(null); setError((e as Error).message); }
  };
  const forget = async (id: string) => { setBusy(`forget:${id}`); try { await forgetCatalogCli(id); refresh(); } finally { setBusy(null); } };
  const save = async (command: string) => { setBusy(`save:${command}`); setError(''); try { await saveCli(command); void qc.invalidateQueries({ queryKey: ['clis-saved'] }); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const unsave = async (command: string) => { setBusy(`save:${command}`); try { await removeSavedCli(command); void qc.invalidateQueries({ queryKey: ['clis-saved'] }); } finally { setBusy(null); } };

  return (
    <>
      {/* Connected catalog CLIs — installed tools with re-auth + forget */}
      {connected.length > 0 && (
        <div className="mb-3 space-y-2">
          {connected.map((c) => (
            <Card key={c.id} className="p-3.5">
              <div className="flex items-center gap-3">
                <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
                <div className="min-w-0 flex-1">
                  <span className="text-body font-medium text-fg">{c.name}</span>
                  <span className="ml-2 font-mono text-caption text-faint">{c.command}</span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setReveal(reveal === c.id ? null : c.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Re-auth</Button>
                <Button size="sm" variant="ghost" aria-label={`Forget ${c.name}`} title="Disconnect" disabled={busy === `forget:${c.id}`} onClick={() => forget(c.id)}>
                  {busy === `forget:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </div>
              {reveal === c.id && <AuthReveal command={c.command} authCommand={c.authCommand} authDocsUrl={c.authDocsUrl} />}
            </Card>
          ))}
        </div>
      )}

      {/* Free-form saved tools (non-catalog only) — each gets universal Re-auth */}
      {savedOnly.length > 0 && (
        <div className="mb-3 space-y-2">
          {savedOnly.map((name) => (
            <Card key={name} className="p-3.5">
              <div className="flex items-center gap-3">
                <Terminal className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-small text-fg">{name}</span>
                <Button size="sm" variant="ghost" onClick={() => setReveal(reveal === `saved:${name}` ? null : `saved:${name}`)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Re-auth</Button>
                <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} title="Remove" disabled={busy === `save:${name}`} onClick={() => unsave(name)}>
                  {busy === `save:${name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </div>
              {reveal === `saved:${name}` && <AuthReveal command={name} />}
            </Card>
          ))}
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
      <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-surface px-3">
        <Search className="h-4 w-4 text-faint" aria-hidden />
        <input value={query} onChange={(e) => { setQuery(e.target.value); setError(''); }}
          placeholder="Search to install or save a CLI (netlify, vercel, sf, jq…)" aria-label="Search CLIs"
          className="h-11 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-faint" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>}
      </div>

      {error && <p className="mb-3 text-small text-danger">{error}</p>}

      {!q ? (
        <Card className="p-4 text-body text-muted">
          Search to <span className="text-fg">install</span> a known tool (netlify, vercel, railway, stripe…) or <span className="text-fg">save</span> any CLI already on your machine.
          {clis.data?.cliCount ? <span className="text-faint"> {clis.data.cliCount.toLocaleString()} detected on your PATH.</span> : null}
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Catalog matches — install or (if installed) re-auth */}
          {catResults.map((e) => (
            <Card key={`cat:${e.id}`} className="p-3.5">
              <div className="flex items-center gap-3">
                {e.installed ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Download className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="text-body font-medium text-fg">{e.name}</span><span className="font-mono text-caption text-faint">{e.command}</span></div>
                  <div className="truncate text-caption text-muted">{e.description}</div>
                </div>
                {e.installed
                  ? <Button size="sm" variant="secondary" onClick={() => setReveal(reveal === e.id ? null : e.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign in</Button>
                  : <Button size="sm" disabled={busy === `install:${e.id}`} onClick={() => install(e.id)}>{busy === `install:${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install</Button>}
              </div>
              {reveal === e.id && <AuthReveal command={e.command} authCommand={e.authCommand} authDocsUrl={e.authDocsUrl} />}
            </Card>
          ))}

          {/* PATH matches not in the catalog — save them */}
          {pathResults.map((c, i) => (
            <Card key={`path:${c.command || i}`} className="flex items-center gap-3 p-3.5">
              {c.isLikelyCli ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Terminal className="h-4 w-4 shrink-0 text-faint" aria-hidden />}
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
    </>
  );
}
