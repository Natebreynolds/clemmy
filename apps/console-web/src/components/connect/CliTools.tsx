import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, Search, X, Check, Plus, Loader2, Github, RotateCw, Download, KeyRound, ExternalLink, Copy, MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { connectionSetupChatNavigation } from '@/lib/connection-setup-draft';
import {
  getClis, getCliConnections, saveCli, removeSavedCli, probeCli,
  getManagedClis, startManagedCliJob, getManagedCliJob,
  getCliCatalog, installCatalogCli, forgetCatalogCli, getInstallJob,
  authCatalogCli, runInstallCommand, openTerminalAuth,
  type ManagedCliStatus, type ManagedCliKind, type ManagedCliAction,
  type CatalogEntry, type ConnectedCli, type CliHealth, type CliConnectionSnapshot,
  type ManagedCliJob, type InstallJob,
} from '@/lib/connect';
import { isMac } from '@/lib/platform';
import { cliConnectionHealth, cliConnectionPresentation } from '@/lib/cli-connection-view';

const BARE = /^[A-Za-z0-9._+-]{1,60}$/;
// gh + composio are shown as rich managed cards; don't duplicate them in the catalog list.
const MANAGED_IDS = new Set(['gh', 'github', 'composio']);

type ObservedJob = { id: string; status: string; title: string; output: string };
const JOB_STATES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);

type SetupOwner = { id: string; prefix: string; action: string; generation: number };
let setupGeneration = 0;

/** Only the acknowledged ID and action survive Connect navigation. The normal
 * job cache may expire; clearing the QueryClient also revokes pending callbacks. */
function useCliSetupOwnership(section: 'managed' | 'catalog') {
  const qc = useQueryClient();
  const key = ['cli-setup-owner', section];
  useQuery<SetupOwner | null>({ queryKey: key, enabled: false, initialData: null, gcTime: Infinity, queryFn: async () => null });
  const [local, setLocal] = useState<{ generation: number; action: string } | null>(null);
  const operation = useRef<typeof local>(null);
  const active = useRef(true);
  const epoch = useRef(0);
  const [, setRevision] = useState(0);
  useEffect(() => {
    active.current = true;
    const unsubscribe = qc.getQueryCache().subscribe(event => {
      if (event.type === 'removed' && event.query.queryKey[0] === key[0] && event.query.queryKey[1] === section) {
        epoch.current += 1; operation.current = null; setLocal(null); setRevision(value => value + 1);
      }
    });
    return () => { active.current = false; operation.current = null; unsubscribe(); };
  }, [qc, section]);
  const renderEpoch = epoch.current;
  const current = () => qc.getQueryData<SetupOwner | null>(key) ?? null;
  const owner = current();
  const isCurrent = (generation: number, id: string, prefix: string) => {
    const saved = current();
    return active.current && saved?.generation === generation && saved.id === id && saved.prefix === prefix;
  };
  const begin = (action: string) => {
    if (!active.current || epoch.current !== renderEpoch || operation.current || current()) return null;
    // A removable sentinel fences even an in-flight, not-yet-acknowledged POST.
    if (qc.getQueryData(key) === undefined) qc.setQueryData(key, null);
    const next = { generation: ++setupGeneration, action };
    operation.current = next; setLocal(next); return next.generation;
  };
  const owns = (generation: number) => active.current && operation.current?.generation === generation;
  const finish = (generation: number) => {
    if (owns(generation)) { operation.current = null; setLocal(null); }
  };
  const acknowledge = (id: string, prefix: string, generation: number) => {
    if (!owns(generation) || qc.getQueryData(key) === undefined) return false;
    qc.setQueryData<SetupOwner>(key, { id, prefix, action: operation.current!.action, generation }); return true;
  };
  const complete = (generation: number, id: string, prefix: string) => {
    if (!isCurrent(generation, id, prefix)) return false;
    qc.setQueryData(key, null); finish(generation); return true;
  };
  return { owner, busy: owner?.action ?? local?.action ?? null, epoch, begin, owns, finish, acknowledge, isCurrent, complete };
}

/** A lost observation never authorizes another install or sign-in. Retain the
 * acknowledged job, observe only its exact ID, and bound automatic recovery. */
function useCliJobObservation<T extends ObservedJob>(prefix: string, read: (id: string) => Promise<{ job: T }>, ownership: ReturnType<typeof useCliSetupOwnership>) {
  const qc = useQueryClient();
  type Entry = { job: ObservedJob; token: number; epoch: number; fresh: boolean; errorBaseline: number; observedErrors: number };
  const [entry, setEntry] = useState<Entry | null>(() => ownership.owner?.prefix === prefix ? {
    job: { id: ownership.owner.id, status: 'running', title: 'Checking setup status', output: '' },
    token: ownership.owner.generation, epoch: ownership.epoch.current, fresh: false, errorBaseline: 0, observedErrors: 0,
  } : null);
  const selected = useRef<Entry | null>(entry);
  const active = useRef(true);
  const retrying = useRef<Entry | null>(null);
  useEffect(() => { active.current = true; selected.current = entry; return () => { active.current = false; selected.current = null; }; }, []);
  const current = (candidate: Entry) => active.current && selected.current === candidate && candidate.epoch === ownership.epoch.current
    && ownership.isCurrent(candidate.token, candidate.job.id, prefix);
  const query = useQuery<{ job: ObservedJob }>({
    queryKey: [prefix, entry?.job.id ?? null], enabled: Boolean(entry && current(entry)), retry: false,
    initialData: entry ? { job: entry.job } : undefined,
    queryFn: async () => {
      if (!entry || !current(entry)) throw new Error('No acknowledged job.');
      const result = await read(entry.job.id);
      if (!result?.job || result.job.id !== entry.job.id || !JOB_STATES.has(result.job.status)
        || typeof result.job.title !== 'string' || typeof result.job.output !== 'string') throw new Error('Job status unavailable.');
      if (!current(entry)) throw new Error('Job observation retired.');
      entry.fresh = true;
      return result;
    },
    refetchInterval: q => {
      if (!entry || !current(entry)) return false;
      const job = entry.fresh ? q.state.data?.job ?? entry.job : entry.job;
      if (job.id !== entry.job.id || job.status !== 'running') return false;
      entry.observedErrors = q.state.errorUpdateCount;
      if (q.state.status === 'error') return q.state.errorUpdateCount - entry.errorBaseline < 3 ? 5000 : false;
      entry.errorBaseline = q.state.errorUpdateCount;
      return 1500;
    },
  });
  const accept = (job: T, token: number) => {
    if (!active.current || !ownership.acknowledge(job.id, prefix, token)) return;
    const next = { job, token, epoch: ownership.epoch.current, fresh: true, errorBaseline: 0, observedErrors: 0 };
    selected.current = next;
    qc.setQueryData([prefix, job.id], { job });
    setEntry(next);
  };
  const retryStatus = async () => {
    if (!entry || !current(entry) || retrying.current === entry) return;
    retrying.current = entry; entry.errorBaseline = entry.observedErrors;
    try { await query.refetch(); } catch { /* Query state retains observation failure; never re-dispatch work. */ }
    finally { if (retrying.current === entry) retrying.current = null; }
  };
  const retained = entry?.epoch === ownership.epoch.current;
  const job = retained ? (entry.fresh && query.data?.job?.id === entry.job.id ? query.data.job : entry.job) : undefined;
  return { job, token: entry?.token, accept, unavailable: Boolean(retained && entry && query.isError), checking: query.isFetching, retryStatus };
}

function JobStatusRecovery({ unavailable, checking, onRetry }: { unavailable: boolean; checking: boolean; onRetry: () => Promise<unknown> }) {
  if (!unavailable) return null;
  return <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-small text-muted">
    Status unavailable; work may still be running. Check this job before starting it again.
    <Button size="sm" variant="secondary" disabled={checking} onClick={() => { void onRetry(); }}>{checking ? 'Checking status…' : 'Retry status'}</Button>
  </div>;
}

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
        <Button variant="secondary" size="sm" onClick={() => { const target = connectionSetupChatNavigation('cli'); if (target) navigate(target.pathname, { state: target.state }); }}>
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
  const ownership = useCliSetupOwnership('managed');
  const pending = ownership.busy;
  const [error, setError] = useState('');
  const observation = useCliJobObservation<ManagedCliJob>('managed-cli-job', getManagedCliJob, ownership);
  const job = observation.job;
  useEffect(() => {
    if (job && job.status !== 'running' && observation.token && ownership.complete(observation.token, job.id, 'managed-cli-job')) {
      void qc.invalidateQueries({ queryKey: ['managed-clis'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
    }
  }, [job?.id, job?.status, observation.token, qc]);

  const run = async (kind: ManagedCliKind, action: ManagedCliAction) => {
    const token = ownership.begin(`${kind}:${action}`); if (!token) return;
    setError('');
    try { const { job } = await startManagedCliJob(kind, action); if (ownership.owns(token)) observation.accept(job, token); }
    catch { if (ownership.owns(token)) { ownership.finish(token); setError('The setup could not be started. Check the tool status before trying again.'); } }
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
      {observation.unavailable && <div className="sm:col-span-2"><JobStatusRecovery unavailable checking={observation.checking} onRetry={observation.retryStatus} /></div>}
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
  const anyBusy = Boolean(busy);
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
          {!['not_installed', 'signed_out', 'connected'].includes(presentation.state) && <Button size="sm" variant="secondary" disabled={anyBusy} onClick={() => { const target = connectionSetupChatNavigation('cli', command); if (target) navigate(target.pathname, { state: target.state }); }}><MessageCircle className="h-3.5 w-3.5" aria-hidden /> Ask Clem to check</Button>}
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
  const ownership = useCliSetupOwnership('catalog');
  const busy = ownership.busy;
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState<string | null>(null);
  const installObservation = useCliJobObservation<InstallJob>('install-job', getInstallJob, ownership);
  const authObservation = useCliJobObservation<ManagedCliJob>('catalog-auth-job', getManagedCliJob, ownership);

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

  const installJob = installObservation.job;
  useEffect(() => {
    if (installJob && installJob.status !== 'running' && installObservation.token && ownership.complete(installObservation.token, installJob.id, 'install-job')) {
      void qc.invalidateQueries({ queryKey: ['cli-catalog'] });
      void qc.invalidateQueries({ queryKey: ['clis'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
    }
  }, [installJob?.id, installJob?.status, installObservation.token, qc]);

  const authJob = authObservation.job;
  useEffect(() => {
    if (authJob && authJob.status !== 'running' && authObservation.token && ownership.complete(authObservation.token, authJob.id, 'catalog-auth-job')) {
      void qc.invalidateQueries({ queryKey: ['cli-catalog'] });
      void qc.invalidateQueries({ queryKey: ['cli-connections'] });
    }
  }, [authJob?.id, authJob?.status, authObservation.token, qc]);

  const begin = (label: string) => {
    const token = ownership.begin(label); if (token) setError(''); return token;
  };
  const finish = ownership.finish;

  const signIn = async (id: string) => {
    const token = begin(`auth:${id}`); if (!token) return;
    try { const { job } = await authCatalogCli(id); if (ownership.owns(token)) authObservation.accept(job, token); }
    catch { if (ownership.owns(token)) { setError('Sign-in could not be started. Check the tool status before trying again.'); finish(token); } }
  };

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['cli-catalog'] }); void qc.invalidateQueries({ queryKey: ['cli-connections'] }); };
  const install = async (id: string) => {
    const token = begin(`install:${id}`); if (!token) return;
    try { const { job } = await installCatalogCli(id); if (ownership.owns(token)) installObservation.accept(job, token); }
    catch { if (ownership.owns(token)) { setError('Installation could not be started. Check the tool status before trying again.'); finish(token); } }
  };
  const forget = async (id: string) => { const token = begin(`forget:${id}`); if (!token) return; try { await forgetCatalogCli(id); if (ownership.owns(token)) refresh(); } catch { if (ownership.owns(token)) setError('The saved tool could not be changed. Refresh its status before trying again.'); } finally { finish(token); } };
  const save = async (command: string) => { const token = begin(`save:${command}`); if (!token) return; try { await saveCli(command); if (ownership.owns(token)) void qc.invalidateQueries({ queryKey: ['cli-connections'] }); } catch { if (ownership.owns(token)) setError('The tool could not be saved. Refresh its status before trying again.'); } finally { finish(token); } };
  const unsave = async (command: string) => { const token = begin(`save:${command}`); if (!token) return; try { await removeSavedCli(command); if (ownership.owns(token)) void qc.invalidateQueries({ queryKey: ['cli-connections'] }); } catch { if (ownership.owns(token)) setError('The saved tool could not be changed. Refresh its status before trying again.'); } finally { finish(token); } };
  const customInstall = async (command: string, name?: string) => {
    const token = begin('install:custom'); if (!token) return false;
    try {
      const { job } = await runInstallCommand(command, name);
      if (!ownership.owns(token)) return false;
      installObservation.accept(job, token); return true;
    } catch { if (ownership.owns(token)) finish(token); throw new Error('Installation could not be started. Check the tool status before trying again.'); }
  };

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
                  ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => signIn(c.id)}>{busy === `auth:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Manage sign-in</Button>
                  : <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setReveal(reveal === c.id ? null : c.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign-in options</Button>}
                <Button size="sm" variant="ghost" aria-label={`Forget ${c.name}`} title="Disconnect" disabled={Boolean(busy)} onClick={() => forget(c.id)}>
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
                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setReveal(reveal === `saved:${name}` ? null : `saved:${name}`)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign-in options</Button>
                <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} title="Remove" disabled={Boolean(busy)} onClick={() => unsave(name)}>
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
      <JobStatusRecovery unavailable={authObservation.unavailable} checking={authObservation.checking} onRetry={authObservation.retryStatus} />

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
      <JobStatusRecovery unavailable={installObservation.unavailable} checking={installObservation.checking} onRetry={installObservation.retryStatus} />

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
                      ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => signIn(e.id)}>{busy === `auth:${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <KeyRound className="h-3.5 w-3.5" aria-hidden />} Sign in</Button>
                      : <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => setReveal(reveal === e.id ? null : e.id)}><KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign in</Button>)
                  : <Button size="sm" disabled={Boolean(busy)} onClick={() => install(e.id)}>{busy === `install:${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install</Button>}
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
                : <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => save(c.command ?? '')}>{busy === `save:${c.command}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Save</Button>}
            </Card>
          ))}

          {/* Bare name not found anywhere — probe + save anyway */}
          {isBare && !exactKnown && (
            <Card className="flex items-center gap-3 p-3.5">
              {probeQ.isLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-faint" aria-hidden /> : probeQ.data ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <Terminal className="h-4 w-4 shrink-0 text-faint" aria-hidden />}
              <div className="min-w-0 flex-1"><div className="truncate font-mono text-small text-fg">{q}</div><div className="truncate text-caption text-faint">{probeQ.isLoading ? 'Checking your PATH…' : probeQ.data ? `Found at ${probeQ.data.path}` : 'Not auto-detected — save it and Clementine will still try it'}</div></div>
              {savedSet.has(q)
                ? <span className="inline-flex items-center gap-1 text-caption text-success"><Check className="h-3.5 w-3.5" aria-hidden /> Saved</span>
                : <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => save(q)}>{busy === `save:${q}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Save</Button>}
            </Card>
          )}

          {catResults.length === 0 && pathResults.length === 0 && !(isBare && !exactKnown) && (searchQ.isFetching ? <Card className="p-4 text-body text-muted">Searching…</Card> : <Card className="p-4 text-body text-muted">No tool matches “{q}”.</Card>)}
        </div>
      )}

      <CustomInstall busy={Boolean(busy)} onInstall={customInstall} />
    </>
  );
}

/** Paste-your-own install command. Validated SERVER-SIDE against the same
 *  allowlist as catalog installs (npm -g / brew / uv tool / pipx / pip
 *  --user / git clone https — no sudo, no pipes); "remember" saves the
 *  binary name to the roster once the install succeeds. */
function CustomInstall({ busy, onInstall }: { busy: boolean; onInstall: (command: string, saveAs?: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [remember, setRemember] = useState(true);
  const [saveAs, setSaveAs] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [error, setError] = useState('');

  const guessedName = (() => {
    const words = command.trim().split(/\s+/);
    const last = words[words.length - 1] ?? '';
    const bare = last.split('/').pop()?.replace(/^@[^/]+\//, '') ?? '';
    return BARE.test(bare) ? bare : '';
  })();

  const submit = async () => {
    if (busy || submittingRef.current || !command.trim() || !active.current) return;
    submittingRef.current = true;
    setSubmitting(true); setError('');
    try {
      const name = remember ? (saveAs.trim() || guessedName) : '';
      const accepted = await onInstall(command.trim(), name || undefined);
      if (!accepted || !active.current) return;
      setCommand(''); setSaveAs(''); setOpen(false);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      submittingRef.current = false; if (active.current) setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => { if (!busy) setOpen(true); }}
        className="mt-3 cursor-pointer text-small text-muted underline-offset-2 hover:text-fg hover:underline">
        Have an install command? Paste it to review and run it here.
      </button>
    );
  }
  return (
    <Card className="mt-3 p-3.5">
      <div className="mb-2 text-small font-medium text-fg">Paste an install command</div>
      <div className="mb-2 flex items-center gap-2">
        <input value={command} disabled={busy || submitting} onChange={(e) => { setCommand(e.target.value); setError(''); }}
          placeholder={isMac() ? 'npm install -g some-cli   ·   brew install some-tool' : 'npm install -g some-cli'} aria-label="Install command"
          className="min-w-0 flex-1 rounded border border-border bg-canvas px-2.5 py-1.5 font-mono text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        <Button size="sm" disabled={!command.trim() || submitting || busy} onClick={() => void submit()}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Download className="h-3.5 w-3.5" aria-hidden />} Install
        </Button>
        <Button size="sm" variant="ghost" disabled={submitting} onClick={() => { if (!submittingRef.current) { setOpen(false); setError(''); } }} aria-label="Close"><X className="h-3.5 w-3.5" aria-hidden /></Button>
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
