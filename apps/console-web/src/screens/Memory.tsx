import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, Trash2, Pin, Target, User, Network, FileText, BookOpen, Plus, X, Database,
  FileSearch, Users, MapPin, Wrench, CheckCircle2, XCircle, Download, Undo2, FolderSearch, Pencil, History,
  ShieldCheck, AlertTriangle,
} from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { MemoryGraphContainer } from '@/components/MemoryGraphContainer';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  listFacts, forgetFact, pinFact, getContext, addFact, addGoal, searchMemory, getMemoryFiles,
  getBrainHealth, getMemoryHealth, getToolRecall, listEntities, getSourceMap, fileBasename, FACT_KINDS,
  listEntityIdentityConflicts, listEntityDuplicateCandidates, dismissEntityDuplicateCandidate,
  restoreDismissedEntityDuplicateCandidates, mergeEntityIdentity,
  getEntityMemory,
  listMemoryReviewCandidates, applyMemoryReviewCandidate, dismissMemoryReviewCandidate,
  discoverImportSources, scanImportPath, runMemoryImport, listImportBatches, undoImportBatch,
  restoreFact, updateFact, reconcileMemoryEvidence, reconcileMemoryRelationships,
  getMemoryReadiness, listReflectionCandidates,
  listMemoryEpisodes, promoteMemoryEpisodeCandidate, rejectMemoryEpisodeCandidate,
  type Fact, type ContextFile, type Entity, type ToolRecallRecord, type ImportScan, type ImportBatch, type MemoryHit,
  type EntityIdentityConflict, type EntityDuplicateCandidate, type EntityMemoryDetail,
  type MemoryReviewCandidate, type MemoryReadinessReport, type MemoryReadinessCheck,
  type MemoryEpisode, type MemoryEpisodeKind, type MemoryEpisodeStatus,
} from '@/lib/memory';
import { memoryAssuranceView, memoryClaimTemporalStatus } from '@/lib/memory-assurance';

type Tab = 'overview' | 'facts' | 'episodes' | 'entities' | 'procedures' | 'sources' | 'you' | 'import';
const KIND_LABEL: Record<Fact['kind'], string> = { user: 'About you', project: 'Project', feedback: 'Preference', reference: 'Reference', constraint: 'Hard constraint' };

export function Memory() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const search = useQuery({ queryKey: ['mem-search', debouncedQ], queryFn: () => searchMemory(debouncedQ), enabled: debouncedQ.length >= 2, staleTime: 30_000 });
  const searching = debouncedQ.length >= 2;

  const tabs: { key: Tab; label: string; icon: typeof Search }[] = [
    { key: 'overview', label: 'Overview', icon: Network },
    { key: 'facts', label: 'Facts', icon: BookOpen },
    { key: 'episodes', label: 'Timeline', icon: History },
    { key: 'entities', label: 'People & things', icon: Users },
    { key: 'procedures', label: 'Tool recall', icon: Wrench },
    { key: 'sources', label: 'Sources', icon: FileText },
    { key: 'you', label: 'You & goals', icon: User },
    { key: 'import', label: 'Import', icon: Download },
  ];

  return (
    <Page title="Memory" subtitle="Everything Clementine knows — and where it comes from">
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-border bg-surface px-3 shadow-xs">
        <Search className="h-4 w-4 text-faint" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything Clementine knows…" aria-label="Search memory"
          className="h-12 flex-1 bg-transparent text-body-lg text-fg outline-none placeholder:text-faint" />
        {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="cursor-pointer text-faint hover:text-fg"><X className="h-4 w-4" aria-hidden /></button>}
      </div>

      {searching ? (
        <SearchResults loading={search.isLoading} hits={search.data?.hits ?? []} query={debouncedQ} answerability={search.data?.answerability} stores={search.data?.diagnostics?.stores} />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-1 border-b border-border">
            {tabs.map((t) => {
              const Icon = t.icon; const active = tab === t.key;
              return (
                <button key={t.key} type="button" onClick={() => setTab(t.key)}
                  className={cn('inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-body font-medium transition-colors cursor-pointer -mb-px',
                    active ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')}>
                  <Icon className="h-4 w-4" aria-hidden /> {t.label}
                </button>
              );
            })}
          </div>
          {tab === 'overview' && <OverviewTab onNavigate={setTab} />}
          {tab === 'facts' && <FactsTab qc={qc} />}
          {tab === 'episodes' && <EpisodesTab />}
          {tab === 'entities' && <EntitiesTab />}
          {tab === 'procedures' && <ProceduresTab />}
          {tab === 'sources' && <SourcesTab />}
          {tab === 'you' && <YouTab qc={qc} />}
          {tab === 'import' && <ImportTab qc={qc} />}
        </>
      )}
    </Page>
  );
}

// ─────────── Overview: the knowledge graph as the focal point + stats ───────────
function OverviewTab({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const health = usePoll(['brain-health'], getBrainHealth, 30000);
  const memHealth = usePoll(['memory-health'], getMemoryHealth, 30000);
  const readiness = usePoll(['memory-readiness'], getMemoryReadiness, 30000);
  const files = usePoll(['memory-files'], getMemoryFiles, 60000);
  const sources = usePoll(['source-map'], getSourceMap, 60000);
  const h = health.data ?? {};
  const relationships = memHealth.data?.reliability?.relationships;
  const stats = [
    { label: 'Facts', value: h.activeFacts, sub: `${h.directFacts ?? 0} told · ${h.derivedFacts ?? 0} learned` },
    { label: 'People & things', value: h.entitiesTotal, sub: `${h.entitiesPerson ?? 0} people · ${h.entitiesCompany ?? 0} orgs` },
    { label: 'Knowledge files', value: files.data?.files?.length, sub: 'indexed & searchable' },
    { label: 'Source episodes', value: h.memoryEpisodesTotal, sub: `${h.memoryEpisodesRecent ?? 0} recent · ${h.recordedMeetingsTotal ?? 0} meetings` },
    { label: 'Data sources', value: sources.data?.count, sub: 'places data lives' },
    {
      label: 'Evidence links',
      value: relationships?.factEvidence,
      sub: 'claims ↔ durable episodes',
    },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <div className="text-h2 text-fg">{typeof s.value === 'number' ? s.value.toLocaleString() : '—'}</div>
            <div className="text-small font-medium text-fg">{s.label}</div>
            <div className="mt-0.5 text-caption text-faint">{s.sub}</div>
          </Card>
        ))}
      </div>
      <MemoryAssurancePanel report={readiness.data} loading={readiness.isLoading} />
      <MemoryReviewQueue
        health={memHealth.data}
        readiness={readiness.data}
        onNavigate={onNavigate}
        onUpdated={() => {
          void memHealth.refetch();
          void readiness.refetch();
        }}
      />
      <RecallHealthStrip health={memHealth.data} />
      <GraphTruthCoverage health={memHealth.data} readiness={readiness.data} />
      <div>
        <p className="mb-2 text-small text-muted">Explore stored memory truth first. Text matches and semantic similarity are optional, labeled overlays.</p>
        <MemoryGraphContainer height={540} />
      </div>
    </div>
  );
}

function MemoryReviewQueue({
  health,
  readiness,
  onNavigate,
  onUpdated,
}: {
  health?: import('@/lib/memory').MemoryHealth;
  readiness?: MemoryReadinessReport;
  onNavigate: (tab: Tab) => void;
  onUpdated: () => void;
}) {
  const reviews = usePoll(['memory-review-candidates', 'overview'], () => listMemoryReviewCandidates(25), 30000);
  const people = usePoll(['entity-duplicate-candidates', 'overview'], () => listEntityDuplicateCandidates(100, 'person'), 60000);
  const [repairing, setRepairing] = useState<'identity' | 'evidence' | ''>('');
  const [message, setMessage] = useState('');
  const reliability = health?.reliability;
  const promptOnly = reliability?.policyCoverage?.promptOnlyConstraintFacts ?? 0;
  const ledgerPendingObservations = reliability?.reflectionCandidates?.pending ?? 0;
  const ledgerPendingClaims = reliability?.reflectionCandidates?.pendingUniqueClaims ?? ledgerPendingObservations;
  const knownExactPending = reliability?.reflectionCandidates?.knownExactPending ?? 0;
  const bufferedExtractions = reliability?.pendingReflections ?? 0;
  const pendingClaims = ledgerPendingClaims > 0 ? ledgerPendingClaims : bufferedExtractions;
  const overdueClaims = reliability?.reflectionCandidates?.overduePending ?? 0;
  const unreconciledEvidence = reliability?.unreconciledEvidence ?? 0;
  const unavailableEvidence = reliability?.evidenceUnavailable ?? 0;
  const identityBlockers = readiness?.inventory?.identity.exactEmailCollisionGroups ?? 0;
  const factReviews = reviews.data?.total;
  const peopleReviews = people.data?.total;
  const queuesLoading = factReviews == null || peopleReviews == null;
  const manualReviewCount = (factReviews ?? 0) + (peopleReviews ?? 0) + promptOnly;
  const totalReviewCount = manualReviewCount + pendingClaims;
  const repairCount = identityBlockers + unreconciledEvidence;

  const repairIdentity = async () => {
    if (!window.confirm(`Back up memory and safely converge ${identityBlockers.toLocaleString()} exact-email identity group${identityBlockers === 1 ? '' : 's'} now? Shared inboxes and name-only matches will remain review-only.`)) return;
    setRepairing('identity');
    setMessage('');
    try {
      const report = await reconcileMemoryRelationships();
      setMessage(`${report.identities.entitiesRedirected} duplicate identities redirected · ${report.groundedFactEntityLinks.promoted + report.groundedFactResourceLinks.promoted} evidence-backed graph links promoted.`);
      await Promise.all([people.refetch(), reviews.refetch()]);
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairing('');
    }
  };

  const repairEvidence = async () => {
    if (!window.confirm(`Back up memory and classify ${unreconciledEvidence.toLocaleString()} unresolved evidence link${unreconciledEvidence === 1 ? '' : 's'} now? Clementine will never fabricate missing historical evidence.`)) return;
    setRepairing('evidence');
    setMessage('');
    try {
      const report = await reconcileMemoryEvidence();
      setMessage(`${report.available.toLocaleString()} source-backed · ${report.unavailable.toLocaleString()} honestly unavailable · ${report.remaining.toLocaleString()} remaining.`);
      onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairing('');
    }
  };

  return (
    <Card className="overflow-hidden p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body-lg font-semibold text-fg">Memory review queue</h3>
            {queuesLoading
              ? <StatusPill tone="neutral">Loading queues…</StatusPill>
              : totalReviewCount > 0
                ? <StatusPill tone="warning">{totalReviewCount.toLocaleString()} to review</StatusPill>
                : <StatusPill tone="success">Caught up</StatusPill>}
            {repairCount > 0 && <StatusPill tone="danger">{repairCount.toLocaleString()} repair item{repairCount === 1 ? '' : 's'}</StatusPill>}
          </div>
          <p className="mt-0.5 text-small text-muted">Human judgment stays separate from safe, backup-first system repairs.</p>
        </div>
        {unavailableEvidence > 0 && <div className="max-w-sm rounded-md bg-subtle px-3 py-2 text-caption text-muted">
          <span className="font-medium text-fg">Known historical limit:</span> {unavailableEvidence.toLocaleString()} pre-upgrade evidence links are honestly unavailable and are never presented as source-backed.
        </div>}
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <ReviewQueueItem
          icon={Users}
          label="Possible duplicate people"
          count={peopleReviews}
          detail="Name and alias matches always require your choice."
          action="Review people"
          onAction={() => onNavigate('entities')}
        />
        <ReviewQueueItem
          icon={BookOpen}
          label="Fact cleanup"
          count={factReviews}
          detail="Possible duplicate facts and transient chat requests."
          action="Review facts"
          onAction={() => onNavigate('facts')}
        />
        <ReviewQueueItem
          icon={History}
          label="Learned claims"
          count={pendingClaims}
          detail={overdueClaims > 0
            ? `${overdueClaims} overdue; replay remains bounded and durable.`
            : ledgerPendingClaims === 0 && bufferedExtractions > 0
              ? `${bufferedExtractions} legacy buffers will enter the decision ledger on daemon start.`
              : `${ledgerPendingObservations.toLocaleString()} source observation${ledgerPendingObservations === 1 ? '' : 's'} collapse to ${ledgerPendingClaims.toLocaleString()} unique claim${ledgerPendingClaims === 1 ? '' : 's'}${knownExactPending > 0 ? `; ${knownExactPending} already-known will auto-attach` : ''}.`}
          action="Inspect learning"
          onAction={() => onNavigate('episodes')}
          tone={overdueClaims > 0 ? 'warning' : 'neutral'}
        />
        <ReviewQueueItem
          icon={ShieldCheck}
          label="Prompt-only instructions"
          count={promptOnly}
          detail="Legacy constraint-shaped facts are not mislabeled as enforced."
          action="Review policies"
          onAction={() => onNavigate('facts')}
          tone={promptOnly > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {(identityBlockers > 0 || unreconciledEvidence > 0) && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3 text-small">
        <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
        <span className="mr-auto text-muted">
          {identityBlockers > 0 ? `${identityBlockers} exact-email identity group${identityBlockers === 1 ? '' : 's'} can be safely converged. ` : ''}
          {unreconciledEvidence > 0 ? `${unreconciledEvidence} evidence link${unreconciledEvidence === 1 ? '' : 's'} still need classification.` : ''}
        </span>
        {identityBlockers > 0 && <Button size="sm" variant="secondary" disabled={Boolean(repairing)} onClick={() => void repairIdentity()}>
          <Users className="h-3.5 w-3.5" aria-hidden /> {repairing === 'identity' ? 'Repairing…' : 'Back up & repair identities'}
        </Button>}
        {unreconciledEvidence > 0 && <Button size="sm" variant="secondary" disabled={Boolean(repairing)} onClick={() => void repairEvidence()}>
          <Database className="h-3.5 w-3.5" aria-hidden /> {repairing === 'evidence' ? 'Reconciling…' : 'Back up & classify evidence'}
        </Button>}
      </div>}
      {message && <p className="mt-2 text-caption text-muted">{message}</p>}
    </Card>
  );
}

function ReviewQueueItem({
  icon: Icon,
  label,
  count,
  detail,
  action,
  onAction,
  tone = 'neutral',
}: {
  icon: typeof Users;
  label: string;
  count?: number;
  detail: string;
  action: string;
  onAction: () => void;
  tone?: 'neutral' | 'warning';
}) {
  return (
    <div className="flex min-h-32 flex-col rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', tone === 'warning' ? 'text-warning' : 'text-primary')} aria-hidden />
        <div className="min-w-0 flex-1 text-small font-medium text-fg">{label}</div>
        <StatusPill tone={(count ?? 0) > 0 && tone === 'warning' ? 'warning' : 'neutral'}>{count == null ? '—' : count.toLocaleString()}</StatusPill>
      </div>
      <p className="mt-2 flex-1 text-caption text-muted">{detail}</p>
      <button type="button" onClick={onAction} className="mt-2 w-fit cursor-pointer text-caption font-medium text-primary hover:underline">{action} →</button>
    </div>
  );
}

function GraphTruthCoverage({
  health,
  readiness,
}: {
  health?: import('@/lib/memory').MemoryHealth;
  readiness?: MemoryReadinessReport;
}) {
  const graph = readiness?.inventory?.graph;
  const relationships = health?.reliability?.relationships;
  const storedFactEntity = graph?.factEntityStored ?? relationships?.factEntity ?? 0;
  const storedFactResource = graph?.factResourceStored ?? relationships?.factResource ?? 0;
  const storedEntityEntity = graph?.groundedEntityRelationships ?? relationships?.groundedEntityEntity ?? 0;
  const storedObservations = graph?.entityObservationStored ?? 0;
  const storedArtifacts = graph?.episodeArtifactStored ?? 0;
  const evidenceLinks = relationships?.factEvidence ?? 0;
  const inferred = (graph?.factEntityInferred ?? relationships?.factEntityInferred ?? 0)
    + (graph?.factResourceInferred ?? relationships?.factResourceInferred ?? 0);
  const items = [
    ['Claim ↔ evidence', evidenceLinks],
    ['Claim ↔ entity', storedFactEntity],
    ['Claim ↔ resource', storedFactResource],
    ['Entity ↔ episode', storedObservations],
    ['Episode ↔ artifact', storedArtifacts],
    ['Entity ↔ entity', storedEntityEntity],
  ] as const;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-body font-semibold text-fg">Stored graph truth</h3>
          <p className="mt-0.5 text-small text-muted">Every solid edge below is persisted. Nothing is promoted from matching words alone.</p>
        </div>
        <div className="text-right text-caption text-muted">
          <div><span className="font-medium text-fg">{items.reduce((sum, [, count]) => sum + count, 0).toLocaleString()}</span> durable links across {items.length} relationship types</div>
          <div>{inferred.toLocaleString()} text-match overlay{inferred === 1 ? '' : 's'} hidden by default</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {items.map(([label, count]) => <div key={label} className="rounded-md bg-subtle px-3 py-2">
          <div className="text-body font-semibold text-fg">{count.toLocaleString()}</div>
          <div className="text-caption text-muted">{label}</div>
        </div>)}
      </div>
    </Card>
  );
}

function readinessCheckIcon(check: MemoryReadinessCheck) {
  if (check.status === 'pass') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />;
  if (check.status === 'fail') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />;
  return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />;
}

function MemoryAssurancePanel({ report, loading }: { report?: MemoryReadinessReport; loading: boolean }) {
  if (loading && !report) return <Skeleton className="h-24 w-full" />;
  if (!report) return null;
  const view = memoryAssuranceView(report);
  const border = view.tone === 'danger' ? 'border-danger/40 bg-danger/5'
    : view.tone === 'warning' ? 'border-warning/40 bg-warning/5'
      : 'border-success/30 bg-success-tint/40';
  const visible = view.priorityChecks.slice(0, 2);
  return (
    <Card className={cn('overflow-hidden p-4', border)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck className={cn('mt-0.5 h-5 w-5 shrink-0', view.tone === 'danger' ? 'text-danger' : view.tone === 'warning' ? 'text-warning' : 'text-success')} aria-hidden />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-body-lg font-semibold text-fg">{view.title}</h3>
              <StatusPill tone={view.tone}>{view.statusLabel}</StatusPill>
            </div>
            <p className="mt-0.5 text-small text-muted">{view.detail}</p>
          </div>
        </div>
        <div className="shrink-0 text-right text-caption text-muted">
          <div><span className="font-semibold text-success">{report.summary.pass} pass</span> · <span className={report.summary.warn > 0 ? 'font-semibold text-warning' : ''}>{report.summary.warn} advisory</span></div>
          <div>Schema {report.observedSchemaVersion ?? 'unknown'} · read-only audit</div>
        </div>
      </div>
      {visible.length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">
        {visible.map((item) => <div key={item.id} className="flex items-start gap-2 rounded-md border border-border/70 bg-surface/70 px-3 py-2">
          {readinessCheckIcon(item)}
          <div className="min-w-0">
            <div className="text-small font-medium text-fg">{item.label}</div>
            <div className="text-caption text-muted">{item.summary}</div>
          </div>
        </div>)}
      </div>}
      <details className="mt-3 border-t border-border/70 pt-2 text-small">
        <summary className="cursor-pointer font-medium text-fg">Inspect all {report.checks.length} safeguards</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {report.checks.map((item) => <div key={item.id} className="flex items-start gap-2 rounded-md bg-surface/60 px-3 py-2">
            {readinessCheckIcon(item)}
            <div className="min-w-0"><div className="font-medium text-fg">{item.label}</div><div className="text-caption text-muted">{item.summary}</div></div>
          </div>)}
        </div>
      </details>
    </Card>
  );
}

// ─────────── Recall / embedding health ───────────
// Surfaces the signal that was illegible before: when embeddings are off (no
// key) or circuit-broken, semantic recall silently degrades to lexical match.
function RecallHealthStrip({ health }: { health?: import('@/lib/memory').MemoryHealth }) {
  const emb = health?.embeddings;
  const recall = health?.recall;
  const reliability = health?.reliability;
  const recallUsage = reliability?.recallUsage;
  const reflectionReplay = reliability?.reflectionReplay;
  const reflectionCandidates = reliability?.reflectionCandidates;
  const promptContext = reliability?.promptContext;
  if (!emb) return null;
  // Clamp at 100 — coverage can transiently exceed 1 (embeddings for rows since
  // deleted), and "101% notes" reads as a bug.
  const pct = (v?: number) => `${Math.min(100, Math.round((v ?? 0) * 100))}%`;
  const semanticOn = emb.enabled && !emb.breakerOpen;
  const tone: 'good' | 'warn' | 'neutral' = !emb.enabled ? 'warn' : emb.breakerOpen ? 'warn' : 'good';
  const dot = tone === 'good' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-faint';
  const label = !emb.enabled
    ? 'Semantic recall OFF — no embedding key; using lexical match only'
    : emb.breakerOpen
      ? `Semantic recall paused (${emb.lastErrorClass ?? 'error'}) — temporarily lexical-only`
      : 'Semantic recall on';
  const promptIncluded = promptContext?.included ?? 0;
  const promptOmitted = promptContext?.omitted ?? 0;
  const storedGraphLinks = (reliability?.relationships?.factEntity ?? 0)
    + (reliability?.relationships?.factResource ?? 0)
    + (reliability?.relationships?.groundedEntityEntity ?? 0);
  const hiddenGraphOverlays = (reliability?.relationships?.factEntityInferred ?? 0)
    + (reliability?.relationships?.factResourceInferred ?? 0);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-small font-medium text-fg">
          <span className={cn('inline-block h-2 w-2 rounded-full', dot)} aria-hidden />
          {label}
        </span>
        <span className="text-caption text-muted">
          {semanticOn ? `${pct(emb.factCoverage)} facts · ${pct(emb.vaultCoverage)} notes embedded` : 'Lexical fallback is active'}
          {recall && (recall.calls ?? 0) > 0 ? ` · ${pct(recall.hitRate)} recall hit-rate` : ''}
        </span>
      </div>

      {reliability && <>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          <HealthMetric label="Source-backed evidence" value={(reliability.evidenceAvailable ?? reliability.evidenceLinked ?? 0).toLocaleString()} detail={`${(reliability.unreconciledEvidence ?? 0).toLocaleString()} unresolved`} warning={(reliability.unreconciledEvidence ?? 0) > 0} />
          <HealthMetric label="Proven recall use" value={(recallUsage?.usedRefs ?? 0).toLocaleString()} detail={(recallUsage?.runs ?? 0) > 0 ? `${pct(recallUsage?.conversionRate ?? 0)} run conversion` : 'awaiting new samples'} />
          <HealthMetric label="Prompt context" value={promptContext?.runs ? `${promptIncluded.toLocaleString()} shown` : 'No new samples'} detail={promptContext?.runs ? `${promptOmitted.toLocaleString()} omitted by budget` : 'omissions will be recorded'} warning={promptOmitted > 0} />
          <HealthMetric label="Stored graph edges" value={storedGraphLinks.toLocaleString()} detail={`${hiddenGraphOverlays.toLocaleString()} overlays hidden`} />
          <HealthMetric label="Compiled policies" value={(reliability.policyCoverage?.compiledHard ?? 0).toLocaleString()} detail={`${(reliability.policyCoverage?.promptOnlyConstraintFacts ?? 0).toLocaleString()} prompt-only`} warning={(reliability.policyCoverage?.promptOnlyConstraintFacts ?? 0) > 0} />
        </div>

        <details className="mt-3 border-t border-border pt-3 text-caption text-muted">
          <summary className="cursor-pointer font-medium text-fg">Inspect retrieval and learning diagnostics</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Evidence and exposure</div>
              <div className="mt-1">{reliability.evidenceUnavailable ?? 0} historical links honestly unavailable · {reliability.unreachableFacts ?? 0} facts have no proven use yet.</div>
              <div className="mt-1">Utility {reliability.utility ?? 0} · passive impressions {reliability.impressions ?? 0}. Impressions never affect ranking.</div>
            </div>
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Material-use learning</div>
              {(recallUsage?.runs ?? 0) > 0 ? <>
                <div className="mt-1">{recallUsage?.usedRuns}/{recallUsage?.runs} runs used recalled memory · {recallUsage?.usedRefs ?? 0} exact refs credited.</div>
                <div className="mt-1">Top-memory share {(recallUsage?.topRefShare ?? null) == null ? 'not available' : pct(recallUsage?.topRefShare ?? 0)}{Object.keys(recallUsage?.refTypeUses ?? {}).length > 0 ? ` · ${Object.entries(recallUsage?.refTypeUses ?? {}).filter(([, count]) => (count ?? 0) > 0).map(([type, count]) => `${type} ${count}`).join(', ')}` : ''}.</div>
              </> : <div className="mt-1">Awaiting post-upgrade operational samples.</div>}
            </div>
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Prompt assembly</div>
              <div className="mt-1">{promptContext?.runs ?? 0} runs · {promptIncluded} memories shown · {promptOmitted} omitted by budget.</div>
              <div className="mt-1">Standing context: {promptContext?.standingContext?.included ?? 0} shown · {promptContext?.standingContext?.omitted ?? 0} omitted · {promptContext?.standingContext?.last?.enforcementBacked ?? 0} enforcement-backed in latest assembly.</div>
            </div>
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Learning lifecycle</div>
              <div className="mt-1">{reflectionCandidates?.promoted ?? 0} promoted · {reflectionCandidates?.rejected ?? 0} rejected · {reflectionCandidates?.expired ?? 0} expired · {reflectionCandidates?.pendingUniqueClaims ?? reflectionCandidates?.pending ?? 0} unique pending across {reflectionCandidates?.pending ?? 0} sources.</div>
              {(reflectionCandidates?.knownExactPending ?? 0) > 0 && <div className="mt-1">{reflectionCandidates?.knownExactPending ?? 0} exact already-known observations will attach automatically without changing fact trust or importance.</div>}
              <div className="mt-1">{reflectionReplay?.completed ?? 0} replay jobs completed once · {reflectionReplay?.failed ?? 0} failed · {reflectionReplay?.staleProcessing ?? 0} stale leases.</div>
            </div>
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Policy truth</div>
              <div className="mt-1">{reliability.policies?.hard_constraint ?? 0} hard constraints · {reliability.policies?.core_profile ?? 0} core-profile items · {reliability.policies?.standing_preference ?? 0} standing preferences.</div>
              <div className="mt-1">{reliability.policyCoverage?.overstatedDispatch ?? 0} rules overstate dispatch enforcement.</div>
            </div>
            <div className="rounded-md bg-subtle p-3">
              <div className="font-medium text-fg">Shadow and graph diagnostics</div>
              <div className="mt-1">{reliability.shadow?.samples ?? 0} shadow samples · {pct(reliability.shadow?.evidenceRate)} source-backed · {reliability.shadow?.tailHits ?? 0} tail-memory hits.</div>
              <div className="mt-1">{reliability.relationships?.groundedEntityEntity ?? 0} grounded entity relationships · {reliability.relationships?.legacyUngroundedEntityEntity ?? 0} legacy edges remain ungrounded.</div>
            </div>
          </div>
        </details>
      </>}
    </Card>
  );
}

function HealthMetric({ label, value, detail, warning = false }: { label: string; value: string; detail: string; warning?: boolean }) {
  return (
    <div className="rounded-md bg-subtle px-3 py-2">
      <div className="text-body font-semibold text-fg">{value}</div>
      <div className="text-caption font-medium text-muted">{label}</div>
      <div className={cn('mt-0.5 text-caption', warning ? 'text-warning' : 'text-faint')}>{detail}</div>
    </div>
  );
}

// ─────────── Search ───────────
function SearchResults({ loading, hits, query, answerability, stores }: {
  loading: boolean; hits: MemoryHit[]; query: string;
  answerability?: 'supported' | 'partial' | 'insufficient'; stores?: string[];
}) {
  if (loading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
  if (hits.length === 0) return <EmptyState title="No matches" description={`Nothing in memory matches “${query}” yet.`} />;
  return (
    <div className="space-y-2">
      <p className="mb-1 text-small text-muted">
        {hits.length} result{hits.length === 1 ? '' : 's'} · {answerability ?? 'partial'}
        {stores?.length ? ` · ${stores.join(', ')}` : ''}
      </p>
      {hits.map((hit, i) => (
        <Card key={i} className="p-4">
          <div className="mb-1 flex items-center gap-2">
            <FileSearch className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{hit.title || String(hit.ref.id)}</span>
            <StatusPill tone="neutral">{hit.ref.type}</StatusPill>
            <span className="shrink-0 text-caption text-faint">{Math.round(hit.confidence * 100)}% confidence</span>
          </div>
          <p className="text-small text-muted">{hit.text}</p>
          {hit.whyRecalled.length > 0 && <p className="mt-2 text-caption text-faint">Why: {hit.whyRecalled.join(' · ')}</p>}
          {hit.evidence.length > 0 && <details className="mt-2 text-caption text-muted">
            <summary className="cursor-pointer font-medium text-fg">{hit.evidence.length} supporting source{hit.evidence.length === 1 ? '' : 's'}</summary>
            <div className="mt-1 space-y-1">{hit.evidence.slice(0, 3).map((evidence) => <div key={`${evidence.episodeId}:${evidence.excerpt}`} className="rounded bg-subtle p-2">{evidence.excerpt}{evidence.sourceUri ? <div className="mt-1 font-mono text-faint">{evidence.sourceUri}</div> : null}</div>)}</div>
          </details>}
        </Card>
      ))}
    </div>
  );
}

// ─────────── Facts ───────────
function FactsTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [kind, setKind] = useState<Fact['kind'] | 'all'>('all');
  const [showForgotten, setShowForgotten] = useState(false);
  const facts = usePoll(['facts', kind, showForgotten], () => listFacts(kind === 'all' ? undefined : kind, 120, showForgotten), 15000);
  const reviews = usePoll(['memory-review-candidates'], () => listMemoryReviewCandidates(25), 30000);
  const learning = usePoll(['reflection-candidates'], () => listReflectionCandidates(40), 30000);
  const rows = facts.data?.facts ?? [];
  const [resolvingReview, setResolvingReview] = useState('');
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<Fact['kind']>('user');
  const [addResult, setAddResult] = useState<string>('');
  const add = async () => {
    if (!draft.trim()) return;
    try {
      const result = await addFact(draft.trim(), draftKind);
      const message = result.consolidation.action === 'supersede'
        ? `Updated stale memory${result.consolidation.supersededFactId ? ` #${result.consolidation.supersededFactId}` : ''} and preserved its history.`
        : result.consolidation.action === 'reinforce'
          ? `Reinforced canonical memory${result.fact ? ` #${result.fact.id}` : ''}; no duplicate was created.`
          : result.consolidation.action === 'ignore'
            ? `Already represented by canonical memory${result.fact ? ` #${result.fact.id}` : ''}; no duplicate was created.`
            : `Added canonical memory${result.fact ? ` #${result.fact.id}` : ''} with durable evidence.`;
      setAddResult(message);
      setDraft('');
    } finally {
      void qc.invalidateQueries({ queryKey: ['facts'] });
    }
  };
  const onForget = async (id: Fact['id']) => { try { await forgetFact(id); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onPin = async (id: Fact['id'], pinned: boolean) => { try { await pinFact(id, pinned); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onRestore = async (id: Fact['id']) => { try { await restoreFact(id); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onEdit = async (id: Fact['id'], content: string) => { try { await updateFact(id, { content }); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const resolveReview = async (candidate: MemoryReviewCandidate, action: 'apply' | 'dismiss') => {
    const fact = candidate.targetFacts[0];
    if (action === 'apply') {
      const prompt = candidate.kind === 'merge_duplicate'
        ? `Merge these two claims into canonical fact #${candidate.payload?.keepId ?? candidate.targetIds[0]}?\n\nEvery source, person/resource link, validity boundary, and measured-use counter will be preserved. This is backed up and reversible.`
        : `Forget this conversational request as a durable fact?\n\n“${fact?.content ?? candidate.evidence}”\n\nThis is reversible from memory history.`;
      if (!window.confirm(prompt)) return;
    }
    setResolvingReview(candidate.id);
    try {
      if (action === 'apply') await applyMemoryReviewCandidate(candidate.id);
      else await dismissMemoryReviewCandidate(candidate.id);
      await Promise.all([reviews.refetch(), facts.refetch()]);
      void qc.invalidateQueries({ queryKey: ['facts'] });
    } finally {
      setResolvingReview('');
    }
  };
  return (
    <>
      {(learning.data?.health.total ?? 0) > 0 && <Card className="mb-4 p-4">
        <details>
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-body font-medium text-fg"><History className="h-4 w-4 text-primary" aria-hidden /> Learning decisions</div>
                <p className="mt-1 text-small text-muted">See every proposed claim—not only what survived into Facts—and how repeats were consolidated.</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <StatusPill tone="success">{learning.data?.health.promoted ?? 0} promoted</StatusPill>
                <StatusPill tone="neutral">{learning.data?.health.rejected ?? 0} filtered</StatusPill>
                {(learning.data?.health.pending ?? 0) > 0 && <StatusPill tone="warning">{learning.data?.health.pending ?? 0} pending</StatusPill>}
                {(learning.data?.health.retrying ?? 0) > 0 && <StatusPill tone="warning">{learning.data?.health.retrying ?? 0} replaying</StatusPill>}
                {(learning.data?.health.expired ?? 0) > 0 && <StatusPill tone="neutral">{learning.data?.health.expired ?? 0} expired</StatusPill>}
              </div>
            </div>
          </summary>
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            {learning.data?.candidates.slice(0, 16).map((candidate) => {
              const tone = candidate.status === 'promoted' ? 'success' : candidate.status === 'pending' ? 'warning' : 'neutral';
              return <div key={candidate.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={tone}>{candidate.status}</StatusPill>
                  <StatusPill tone="neutral">{candidate.kind}</StatusPill>
                  <StatusPill tone="neutral">{candidate.sourceType === 'auto_capture' ? 'user turn' : candidate.sourceType.replace(/_/g, ' ')}</StatusPill>
                  <span className="text-caption text-faint">importance {candidate.importance}/10</span>
                  <span className="ml-auto text-caption text-faint">{shortDate(candidate.occurredAt ?? candidate.createdAt)}{candidate.sourceApp ? ` · ${candidate.sourceApp}` : ''}</span>
                </div>
                <p className="mt-2 text-small text-fg">{candidate.text}</p>
                <p className="mt-1 text-caption text-faint">
                  {candidate.intakeReason ? `Captured because ${candidate.intakeReason}. ` : ''}
                  {candidate.reason ? candidate.reason.replace(/[_:]/g, ' ') : candidate.attemptCount > 0 ? `queued replay attempt ${candidate.attemptCount}` : 'awaiting consolidation'}
                  {candidate.resultingFactId != null ? ` · canonical fact #${candidate.resultingFactId}` : ''}
                </p>
                {candidate.lastError && <p className="mt-1 rounded border border-warning/30 bg-warning/5 p-2 text-caption text-muted">Replay is safe and pending: {candidate.lastError}{candidate.nextAttemptAt ? ` · retry ${shortDate(candidate.nextAttemptAt)}` : ''}</p>}
                {candidate.resultingFactContent && candidate.resultingFactContent !== candidate.text && <p className="mt-1 rounded bg-subtle p-2 text-caption text-muted">Consolidated as: {candidate.resultingFactContent}</p>}
              </div>;
            })}
            {(learning.data?.candidates.length ?? 0) > 16 && <p className="text-caption text-faint">Showing the 16 latest of {learning.data?.health.total} decisions.</p>}
          </div>
        </details>
      </Card>}
      {(reviews.data?.candidates.length ?? 0) > 0 && <Card className="mb-4 border-warning/40 bg-warning/5 p-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <div className="text-body font-medium text-fg">Memory review</div>
          {(reviews.data?.byKind.merge_duplicate ?? 0) > 0 && <StatusPill tone="warning">{reviews.data?.byKind.merge_duplicate} possible duplicate{reviews.data?.byKind.merge_duplicate === 1 ? '' : 's'}</StatusPill>}
          {(reviews.data?.byKind.retire_transient_request ?? 0) > 0 && <StatusPill tone="neutral">{reviews.data?.byKind.retire_transient_request} chat request{reviews.data?.byKind.retire_transient_request === 1 ? '' : 's'}</StatusPill>}
        </div>
        <p className="mb-3 text-small text-muted">Potential duplicates and older chat requests wait here. Clementine never merges or removes durable knowledge without showing you the exact facts first.</p>
        <div className="space-y-2">
          {reviews.data?.candidates.slice(0, 8).map((candidate) => {
            const fact = candidate.targetFacts[0];
            if (candidate.kind === 'merge_duplicate') {
              const canonicalId = candidate.payload?.keepId ?? candidate.targetIds[0];
              const duplicateId = candidate.payload?.dropId ?? candidate.targetIds[1];
              const canonical = candidate.targetFacts.find((item) => Number(item.id) === canonicalId);
              const duplicate = candidate.targetFacts.find((item) => Number(item.id) === duplicateId);
              const similarity = typeof candidate.payload?.similarity === 'number'
                ? `${Math.round(candidate.payload.similarity * 100)}% semantic match`
                : candidate.confidence;
              return <div key={candidate.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <StatusPill tone="warning">possible duplicate</StatusPill>
                  <span className="text-caption text-faint">{similarity} · entity-safe probe · reversible</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-md bg-success-tint/50 p-2.5">
                    <div className="text-caption font-semibold text-success">Keep canonical #{canonicalId}</div>
                    <p className="mt-1 text-small text-fg">{canonical?.content ?? 'Canonical fact unavailable'}</p>
                    <div className="mt-1 text-caption text-faint">{canonical?.evidence?.length ?? 0} source{canonical?.evidence?.length === 1 ? '' : 's'} · used {canonical?.utilityCount ?? 0}×</div>
                  </div>
                  <div className="rounded-md bg-subtle p-2.5">
                    <div className="text-caption font-semibold text-muted">Fold duplicate #{duplicateId}</div>
                    <p className="mt-1 text-small text-fg">{duplicate?.content ?? 'Duplicate fact unavailable'}</p>
                    <div className="mt-1 text-caption text-faint">{duplicate?.evidence?.length ?? 0} source{duplicate?.evidence?.length === 1 ? '' : 's'} · used {duplicate?.utilityCount ?? 0}×</div>
                  </div>
                </div>
                <p className="mt-2 text-caption text-muted">Merge preserves both source histories and promotes the strongest grounded graph links onto the canonical claim.</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'apply')}><Network className="h-3.5 w-3.5" aria-hidden /> Merge safely</Button>
                  <Button size="sm" variant="secondary" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'dismiss')}><XCircle className="h-3.5 w-3.5" aria-hidden /> Keep separate</Button>
                </div>
              </div>;
            }
            return <div key={candidate.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="text-small text-fg">{fact?.content ?? candidate.evidence}</p>
                <p className="mt-1 text-caption text-faint">Likely conversational request · review only · reversible</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="danger" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'apply')}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Forget request</Button>
                <Button size="sm" variant="secondary" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'dismiss')}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Keep as fact</Button>
              </div>
            </div>;
          })}
        </div>
        {(reviews.data?.total ?? 0) > 8 && <p className="mt-2 text-caption text-faint">Showing 8 of {reviews.data?.total} candidates. Duplicate and request reviews are interleaved so neither queue can hide the other.</p>}
      </Card>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([{ key: 'all', label: 'All' }, ...FACT_KINDS] as { key: Fact['kind'] | 'all'; label: string }[]).map((k) => (
          <button key={k.key} type="button" onClick={() => setKind(k.key)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', kind === k.key ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{k.label}</button>
        ))}
        <button type="button" onClick={() => setShowForgotten((value) => !value)}
          className={cn('ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', showForgotten ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>
          <History className="h-3.5 w-3.5" aria-hidden /> {showForgotten ? 'Showing history' : 'Show history'}
        </button>
        {facts.data && <span className="basis-full text-caption text-faint sm:ml-auto sm:basis-auto">
          Showing {facts.data.visible} of {facts.data.total} {showForgotten ? 'current and historical' : 'current'} facts{facts.data.visible < facts.data.total ? ' · use memory search for the full archive' : ''}
        </span>}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={draft} onChange={(e) => { setDraft(e.target.value); setAddResult(''); }} placeholder="Tell Clementine something to remember…" aria-label="New fact" className="min-w-48 flex-1" onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <Select value={draftKind} onChange={(e) => setDraftKind(e.target.value as Fact['kind'])} aria-label="Fact type" className="w-40">{FACT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</Select>
        <Button onClick={add} disabled={!draft.trim()}><Plus className="h-4 w-4" aria-hidden /> Remember</Button>
        {addResult && <p className="basis-full text-caption text-muted"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-success" aria-hidden />{addResult}</p>}
      </div>
      {facts.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="Still getting to know you" description="As we work together, the important things land here — and you can edit or forget anything." /></Card>
          : <div className="space-y-2">{rows.map((f) => <FactCard key={f.id} fact={f} onPin={() => onPin(f.id, !f.pinned)} onForget={() => onForget(f.id)} onRestore={() => onRestore(f.id)} onEdit={(content) => onEdit(f.id, content)} />)}</div>}
    </>
  );
}

function FactCard({ fact, onPin, onForget, onRestore, onEdit }: { fact: Fact; onPin: () => void; onForget: () => void; onRestore: () => void; onEdit: (content: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.content);
  const long = (fact.content?.length ?? 0) > 180;
  const usableEvidence = (fact.evidence ?? []).filter((item) =>
    (item.status === 'available' || item.status === 'partial' || item.status === undefined) && item.excerpt.trim().length > 0);
  const unavailableEvidence = (fact.evidence ?? []).filter((item) => !usableEvidence.includes(item));
  let policyReason = '';
  try {
    const parsed = JSON.parse(fact.policy?.applies_to_json ?? '{}') as { reason?: unknown };
    policyReason = typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch { /* malformed legacy metadata remains visibly unclassified */ }
  return (
    <Card className="flex items-start gap-3 p-3.5">
      {fact.pinned && <Pin className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap gap-1.5">
          <StatusPill tone="neutral">{KIND_LABEL[fact.kind] ?? fact.kind}</StatusPill>
          {fact.policy && <span title={policyReason || undefined}><StatusPill tone={fact.policy.enforcement === 'dispatch' ? 'warning' : 'neutral'}>{fact.policy.policy_type.replace(/_/g, ' ')} · {fact.policy.enforcement}</StatusPill></span>}
          {fact.active === false && <StatusPill tone="warning">historical</StatusPill>}
          {fact.active === false && fact.supersededByFactId != null && <StatusPill tone="neutral">continued as #{fact.supersededByFactId}</StatusPill>}
        </div>
        {editing ? <div className="space-y-2">
          <Input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Edit fact" />
          <div className="flex gap-2"><Button size="sm" onClick={async () => { await onEdit(draft.trim()); setEditing(false); }} disabled={!draft.trim() || draft.trim() === fact.content}>Save as correction</Button><Button size="sm" variant="ghost" onClick={() => { setDraft(fact.content); setEditing(false); }}>Cancel</Button></div>
        </div> : <p className={cn('text-body text-fg', !expanded && long && 'line-clamp-3')}>{fact.content}</p>}
        {long && <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 text-caption font-semibold text-primary hover:underline cursor-pointer">{expanded ? 'Show less' : 'Show more'}</button>}
        <div className="mt-1 text-caption text-faint">
          {typeof fact.confidence === 'number' ? `${Math.round(fact.confidence * 100)}% confidence · ` : ''}{usableEvidence.length} source{usableEvidence.length === 1 ? '' : 's'}{unavailableEvidence.length > 0 ? ` · ${unavailableEvidence.length} unavailable` : ''} · used {fact.utilityCount ?? 0}× · shown {fact.impressionCount ?? 0}×
        </div>
        {(fact.evidence?.length ?? 0) > 0 && <details className="mt-1 text-caption text-muted"><summary className="cursor-pointer">View provenance</summary><div className="mt-1 space-y-1">{fact.evidence?.map((item) => <div key={`${item.episodeId}:${item.excerpt}`} className="rounded bg-subtle p-2"><div>{item.excerpt || 'Supporting excerpt unavailable — the source expired before durable capture.'}</div><div className="mt-1 text-faint">{item.status ?? 'available'}{item.sourceUri ? ` · ${item.sourceUri}` : ''}</div></div>)}</div></details>}
        {(fact.validityIntervals?.length ?? 0) > 1 && <details className="mt-1 text-caption text-muted"><summary className="cursor-pointer">View validity history ({fact.validityIntervals?.length} periods)</summary><div className="mt-1 space-y-1">{fact.validityIntervals?.map((interval) => <div key={interval.id} className="rounded bg-subtle p-2"><div>{new Date(interval.validFrom).toLocaleString()} → {interval.validTo ? new Date(interval.validTo).toLocaleString() : 'current'}</div><div className="mt-1 text-faint">{interval.openedReason}{interval.closedReason ? ` · ${interval.closedReason}` : ''}</div></div>)}</div></details>}
      </div>
      <div className="flex shrink-0 gap-1">
        {fact.active === false ? <Button variant="ghost" size="icon" aria-label="Restore" title="Restore" onClick={onRestore}><Undo2 className="h-4 w-4" aria-hidden /></Button> : <>
          <Button variant="ghost" size="icon" aria-label="Correct" title="Correct with temporal history" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" aria-hidden /></Button>
          <Button variant="ghost" size="icon" aria-label={fact.pinned ? 'Unpin' : 'Pin'} title={fact.pinned ? 'Unpin' : 'Pin'} onClick={onPin}><Pin className={cn('h-4 w-4', fact.pinned && 'fill-primary text-primary')} aria-hidden /></Button>
          <Button variant="ghost" size="icon" aria-label="Forget this" title="Forget this" onClick={onForget}><Trash2 className="h-4 w-4" aria-hidden /></Button>
        </>}
      </div>
    </Card>
  );
}

// ─────────── Timeline (durable source episodes) ───────────
const EPISODE_KIND_LABEL: Record<MemoryEpisodeKind | 'meeting', string> = {
  meeting: 'Recorded meeting',
  user_turn: 'User turn',
  tool_result: 'Tool result',
  import: 'Import',
  manual: 'Manual memory',
  reflection: 'Reflection',
};

function episodeMoment(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function episodeDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : value.slice(0, 10);
}

function EpisodesTab() {
  const [kind, setKind] = useState<MemoryEpisodeKind | 'meeting' | 'all'>('all');
  const [status, setStatus] = useState<MemoryEpisodeStatus | 'all'>('all');
  const [review, setReview] = useState<'pending' | 'all'>('all');
  const [candidateSource, setCandidateSource] = useState<'tool_reflection' | 'recursive_reflection' | 'auto_capture' | 'meeting_analysis' | 'manual' | 'import' | 'all'>('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [limit, setLimit] = useState(80);
  const [resolvingCandidate, setResolvingCandidate] = useState<number | null>(null);
  const [reviewMessage, setReviewMessage] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebouncedQ(q.trim()), 250); return () => clearTimeout(timer); }, [q]);
  useEffect(() => { setLimit(80); }, [kind, status, review, candidateSource, debouncedQ]);
  const episodes = usePoll(
    ['memory-episodes', kind, status, review, candidateSource, debouncedQ, limit],
    () => listMemoryEpisodes({ kind, status, review, candidateSource, query: debouncedQ, limit }),
    30000,
  );
  const rows = episodes.data?.episodes ?? [];
  const grouped = new Map<string, MemoryEpisode[]>();
  for (const episode of rows) {
    const day = episodeDay(episode.occurredAt);
    grouped.set(day, [...(grouped.get(day) ?? []), episode]);
  }
  const visibleClaims = rows.reduce((sum, episode) => sum + episode.claimCount, 0);
  const visiblePeople = rows.reduce((sum, episode) => sum + episode.entityCount, 0);
  const visiblePending = rows.reduce((sum, episode) => sum + episode.pendingCandidateCount, 0);
  const pendingBySource = episodes.data?.summary.pendingUniqueClaimsBySource
    ?? episodes.data?.summary.pendingCandidatesBySource
    ?? {};
  const pendingObservations = episodes.data?.summary.pendingCandidates ?? visiblePending;
  const pendingUniqueClaims = episodes.data?.summary.pendingUniqueClaims ?? pendingObservations;
  const pendingBreakdown = [
    pendingBySource.meeting_analysis ? `${pendingBySource.meeting_analysis.toLocaleString()} meeting` : '',
    (pendingBySource.tool_reflection ?? 0) + (pendingBySource.recursive_reflection ?? 0) > 0
      ? `${((pendingBySource.tool_reflection ?? 0) + (pendingBySource.recursive_reflection ?? 0)).toLocaleString()} tool-derived`
      : '',
    pendingBySource.auto_capture ? `${pendingBySource.auto_capture.toLocaleString()} user-captured` : '',
    (pendingBySource.manual ?? 0) + (pendingBySource.import ?? 0) > 0
      ? `${((pendingBySource.manual ?? 0) + (pendingBySource.import ?? 0)).toLocaleString()} manual/imported`
      : '',
  ].filter(Boolean).join(' · ');
  const setReviewFilter = (value: 'pending' | 'all') => {
    setReview(value);
    if (value === 'all') setCandidateSource('all');
  };
  const resolveCandidate = async (episode: MemoryEpisode, candidateId: number, action: 'promote' | 'reject') => {
    const candidate = episode.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    const equivalentCount = Math.max(1, candidate.pendingEquivalentCount ?? 1);
    const sourceNotice = equivalentCount > 1
      ? `This exact claim appears in ${equivalentCount} independent source episodes. One decision will preserve and attach every available source.`
      : 'Its source episode will remain preserved as evidence.';
    if (action === 'promote' && !window.confirm(`Add this source-backed claim to canonical memory?\n\n${candidate.text}\n\n${sourceNotice}\nClementine will consolidate it with existing facts.`)) return;
    if (action === 'reject' && !window.confirm(`Dismiss this proposed claim?\n\n${candidate.text}\n\n${sourceNotice}\nThe source history itself will not be deleted.`)) return;
    setResolvingCandidate(candidateId);
    setReviewMessage('');
    try {
      if (action === 'promote') {
        const result = await promoteMemoryEpisodeCandidate(candidateId);
        setReviewMessage(`Approved as canonical fact #${result.factId} (${result.action}) with ${result.evidenceSourcesAdded} source${result.evidenceSourcesAdded === 1 ? '' : 's'}.`);
      } else {
        const result = await rejectMemoryEpisodeCandidate(candidateId);
        setReviewMessage(`${result.rejectedCount} matching proposal${result.rejectedCount === 1 ? '' : 's'} dismissed; every source episode remains intact.`);
      }
      await episodes.refetch();
    } catch (error) {
      setReviewMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setResolvingCandidate(null);
    }
  };
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-h3 text-fg">What Clementine experienced</h3>
        <p className="mt-1 text-small text-muted">Meetings, user turns, imports, tool observations, and manual memories—the durable source layer beneath facts. Claim and people counts are stored links, never text guesses.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Card className="p-3.5"><div className="text-h2 text-fg">{(episodes.data?.allTotal ?? 0).toLocaleString()}</div><div className="text-caption text-muted">Source episodes</div></Card>
        <Card className="p-3.5"><div className="text-h2 text-fg">{(episodes.data?.summary.meetings ?? 0).toLocaleString()}</div><div className="text-caption text-muted">Recorded meetings</div></Card>
        <Card className="p-3.5"><div className="text-h2 text-fg">{visibleClaims.toLocaleString()}</div><div className="text-caption text-muted">Claim links in view</div></Card>
        <button type="button" onClick={() => setReviewFilter(review === 'pending' ? 'all' : 'pending')} className="text-left" aria-pressed={review === 'pending'} aria-label="Show episodes with claims awaiting review">
          <Card className={cn('h-full p-3.5 transition-colors', pendingUniqueClaims > 0 && 'border-warning/40 bg-warning/5', review === 'pending' && 'ring-2 ring-warning/30')}>
            <div className="text-h2 text-fg">{pendingUniqueClaims.toLocaleString()}</div>
            <div className="text-caption text-muted">Unique claims awaiting review</div>
            {pendingObservations !== pendingUniqueClaims && <div className="mt-1 text-[10px] leading-tight text-faint">{pendingObservations.toLocaleString()} source observations</div>}
            {pendingBreakdown && <div className="mt-1 text-[10px] leading-tight text-faint">{pendingBreakdown}</div>}
          </Card>
        </button>
        <Card className="p-3.5"><div className="text-h2 text-fg">{visiblePeople.toLocaleString()}</div><div className="text-caption text-muted">People/things observed in view</div></Card>
      </div>

      {reviewMessage && <div className="rounded-md border border-border bg-subtle px-3 py-2 text-small text-muted">{reviewMessage}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search titles, evidence, apps, or source URIs…" aria-label="Search source timeline" className="min-w-64 flex-1" />
        <Select value={kind} onChange={(event) => setKind(event.target.value as MemoryEpisodeKind | 'meeting' | 'all')} className="w-48" aria-label="Filter source type">
          <option value="all">All source types</option>
          <option value="meeting">Recorded meetings</option>
          <option value="user_turn">User turns</option>
          <option value="tool_result">Tool results</option>
          <option value="import">Imports</option>
          <option value="manual">Manual memories</option>
          <option value="reflection">Reflections</option>
        </Select>
        <Select value={status} onChange={(event) => setStatus(event.target.value as MemoryEpisodeStatus | 'all')} className="w-40" aria-label="Filter source status">
          <option value="all">All statuses</option>
          <option value="available">Available</option>
          <option value="partial">Partial</option>
          <option value="missing">Missing</option>
          <option value="pending">Pending</option>
          <option value="expired">Expired</option>
        </Select>
        <Select value={review} onChange={(event) => setReviewFilter(event.target.value as 'pending' | 'all')} className="w-44" aria-label="Filter claim review">
          <option value="all">All review states</option>
          <option value="pending">Needs claim review</option>
        </Select>
        <Select value={candidateSource} onChange={(event) => {
          const value = event.target.value as typeof candidateSource;
          setCandidateSource(value);
          if (value !== 'all') setReview('pending');
        }} className="w-48" aria-label="Filter claim source">
          <option value="all">All claim sources</option>
          <option value="meeting_analysis">Meeting decisions/actions</option>
          <option value="tool_reflection">Tool-derived claims</option>
          <option value="recursive_reflection">Recursive reflections</option>
          <option value="auto_capture">User-captured claims</option>
          <option value="manual">Manual claims</option>
          <option value="import">Imported claims</option>
        </Select>
      </div>

      {episodes.isLoading ? <div className="space-y-2">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-32 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="No source episodes match" description="Try a broader type, status, or search phrase. Clementine will never invent missing history." /></Card>
          : <>
            <div className="text-caption text-faint">Showing {rows.length.toLocaleString()} of {(episodes.data?.total ?? rows.length).toLocaleString()} matching episodes{(episodes.data?.allTotal ?? 0) !== (episodes.data?.total ?? 0) ? ` · ${(episodes.data?.allTotal ?? 0).toLocaleString()} total` : ''}.</div>
            {[...grouped.entries()].map(([day, dayEpisodes]) => (
              <section key={day}>
                <div className="mb-2 flex items-center gap-2 text-small font-semibold text-muted"><History className="h-4 w-4 text-primary" aria-hidden />{day}<span className="text-faint">· {dayEpisodes.length}</span></div>
                <div className="space-y-2">{dayEpisodes.map((episode) => <EpisodeCard key={episode.id} episode={episode} resolvingCandidate={resolvingCandidate} onResolveCandidate={resolveCandidate} />)}</div>
              </section>
            ))}
            {episodes.data?.hasMore && <div className="flex justify-center"><Button variant="secondary" onClick={() => setLimit((value) => Math.min(200, value + 80))}>Show more episodes</Button></div>}
          </>}
    </div>
  );
}

function EpisodeCard({
  episode,
  resolvingCandidate,
  onResolveCandidate,
}: {
  episode: MemoryEpisode;
  resolvingCandidate: number | null;
  onResolveCandidate: (episode: MemoryEpisode, candidateId: number, action: 'promote' | 'reject') => Promise<void>;
}) {
  const isMeeting = episode.subtype === 'meeting';
  const label = isMeeting ? EPISODE_KIND_LABEL.meeting : EPISODE_KIND_LABEL[episode.kind];
  const tone = episode.status === 'available' ? 'success' : episode.status === 'partial' || episode.status === 'pending' ? 'warning' : 'neutral';
  const artifactPath = typeof episode.metadata.artifactPath === 'string' ? episode.metadata.artifactPath : '';
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-primary-tint p-2 text-primary">{isMeeting ? <History className="h-4 w-4" aria-hidden /> : episode.kind === 'user_turn' ? <User className="h-4 w-4" aria-hidden /> : episode.kind === 'import' ? <Download className="h-4 w-4" aria-hidden /> : episode.kind === 'manual' ? <Pencil className="h-4 w-4" aria-hidden /> : episode.kind === 'reflection' ? <Network className="h-4 w-4" aria-hidden /> : <Wrench className="h-4 w-4" aria-hidden />}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-body font-semibold text-fg">{episode.title || label}</span>
            <StatusPill tone="neutral">{label}</StatusPill>
            <StatusPill tone={tone}>{episode.status}</StatusPill>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption text-faint">
            <span>{episodeMoment(episode.occurredAt)}</span>
            {episode.sourceApp && <span>{episode.sourceApp}</span>}
            <span>{episode.claimCount} claim{episode.claimCount === 1 ? '' : 's'}</span>
            {episode.candidateCount > 0 && <span>{episode.pendingCandidateCount} of {episode.candidateCount} proposal{episode.candidateCount === 1 ? '' : 's'} awaiting review</span>}
            <span>{episode.entityCount} observed {episode.entityCount === 1 ? 'identity' : 'identities'}</span>
          </div>
          {episode.excerpt ? <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-small text-muted">{episode.excerpt}{episode.excerptTruncated ? ' …' : ''}</p>
            : <p className="mt-3 text-small text-warning">Supporting content is unavailable; the episode remains visible so the gap is explicit.</p>}
          {episode.candidates.length > 0 && <details className="mt-3 rounded-md border border-border bg-subtle/60 p-3" open={isMeeting && episode.pendingCandidateCount > 0}>
            <summary className="cursor-pointer text-small font-medium text-fg">
              {episode.pendingCandidateCount > 0 ? `${episode.pendingCandidateCount} source-backed claim${episode.pendingCandidateCount === 1 ? '' : 's'} to review` : `${episode.candidateCount} claim decision${episode.candidateCount === 1 ? '' : 's'}`}
            </summary>
            <div className="mt-2 space-y-2">
              {episode.candidates.map((candidate) => {
                const pending = candidate.status === 'pending';
                const tone = candidate.status === 'promoted' ? 'success' : pending ? 'warning' : 'neutral';
                return <div key={candidate.id} data-testid={`memory-candidate-${candidate.id}`} className="rounded-md border border-border bg-surface p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={tone}>{candidate.status}</StatusPill>
                    <StatusPill tone="neutral">{candidate.intakeReason?.replace(/^structured meeting |^user-marked meeting /, '') ?? candidate.kind}</StatusPill>
                    <span className="text-caption text-faint">importance {candidate.importance}/10</span>
                    {candidate.resultingFactId != null && <span className="ml-auto text-caption text-success">canonical fact #{candidate.resultingFactId}</span>}
                  </div>
                  <p className="mt-1.5 text-small text-fg">{candidate.text}</p>
                  {pending && <div className="mt-2 flex gap-2">
                    <Button size="sm" data-testid={`promote-memory-candidate-${candidate.id}`} disabled={resolvingCandidate != null} onClick={() => void onResolveCandidate(episode, candidate.id, 'promote')}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Add to memory{candidate.pendingEquivalentCount > 1 ? ` (${candidate.pendingEquivalentCount} sources)` : ''}</Button>
                    <Button size="sm" variant="secondary" data-testid={`reject-memory-candidate-${candidate.id}`} disabled={resolvingCandidate != null} onClick={() => void onResolveCandidate(episode, candidate.id, 'reject')}><XCircle className="h-3.5 w-3.5" aria-hidden /> Dismiss{candidate.pendingEquivalentCount > 1 ? ` ${candidate.pendingEquivalentCount} copies` : ''}</Button>
                  </div>}
                  {!pending && candidate.reason && <p className="mt-1 text-caption text-faint">{candidate.reason.replace(/[_:]/g, ' ')}</p>}
                </div>;
              })}
            </div>
          </details>}
          {(episode.sourceUri || artifactPath) && <details className="mt-2 text-caption text-muted"><summary className="cursor-pointer">Inspect source identity</summary><div className="mt-2 space-y-1 rounded bg-subtle p-2 font-mono text-faint">{episode.sourceUri && <div className="break-all">{episode.sourceUri}</div>}{artifactPath && <div className="break-all">{artifactPath}</div>}<div className="break-all">episode:{episode.id}</div></div></details>}
        </div>
      </div>
    </Card>
  );
}

// ─────────── Entities (people & things) ───────────
const ENTITY_TYPES = ['all', 'person', 'company', 'project', 'place', 'thing'];
const ENTITY_PLURAL: Record<string, string> = { all: 'All', person: 'People', company: 'Companies', project: 'Projects', place: 'Places', thing: 'Things' };
function EntitiesTab() {
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [merging, setMerging] = useState('');
  const [selectedId, setSelectedId] = useState<Entity['id'] | null>(null);
  useEffect(() => { const timer = setTimeout(() => setDebouncedQ(q.trim()), 250); return () => clearTimeout(timer); }, [q]);
  useEffect(() => { setSelectedId(null); }, [type, debouncedQ]);
  const entities = usePoll(
    ['entities', type, debouncedQ],
    () => listEntities(300, type, debouncedQ),
    60000,
  );
  const identityConflicts = usePoll(['entity-identity-conflicts'], () => listEntityIdentityConflicts(100), 60000);
  const identityCandidates = usePoll(['entity-duplicate-candidates', 'person'], () => listEntityDuplicateCandidates(100, 'person'), 60000);
  const rows = entities.data?.entities ?? [];
  // Person identifier conflicts are included in the richer review candidates below.
  // Keep this legacy card only for cross-type or non-person conflicts so the same
  // people are never presented twice with two independent merge controls.
  const otherIdentityConflicts = (identityConflicts.data?.conflicts ?? []).filter(
    (conflict) => !conflict.entities.every((entity) => entity.type === 'person'),
  );
  const mergeReviewedGroup = async (
    group: Array<{ id: number; type: string; name: string }>,
    canonicalId: number,
    key: string,
  ) => {
    const canonical = group.find((entity) => entity.id === canonicalId);
    const sources = group.filter((entity) => entity.id !== canonicalId);
    if (!canonical || sources.length === 0) return;
    if (!window.confirm(`Keep “${canonical.name}” as the canonical identity and combine ${sources.map((entity) => `“${entity.name}”`).join(', ')} into it? Facts, sources, aliases, and history will resolve through the kept record; original ids remain redirected and queryable.`)) return;
    setMerging(key);
    try {
      for (const source of sources) await mergeEntityIdentity(source.id, canonicalId);
      setSelectedId(canonicalId);
      await Promise.all([entities.refetch(), identityConflicts.refetch(), identityCandidates.refetch()]);
    } finally {
      setMerging('');
    }
  };
  const mergeConflict = async (conflict: EntityIdentityConflict, canonicalId: number) => {
    const key = `${conflict.scheme}:${conflict.value}`;
    await mergeReviewedGroup(conflict.entities, canonicalId, key);
  };
  const dismissCandidate = async (candidate: EntityDuplicateCandidate) => {
    if (!window.confirm(`Hide this duplicate suggestion for ${candidate.entities.map((entity) => `“${entity.name}”`).join(', ')}? No identity or memory data will be changed, and all dismissed suggestions can be restored.`)) return;
    const key = `dismiss:${candidate.id}`;
    setMerging(key);
    try {
      await dismissEntityDuplicateCandidate(candidate.entities.map((entity) => entity.id));
      await identityCandidates.refetch();
    } finally {
      setMerging('');
    }
  };
  const restoreCandidates = async () => {
    if (!window.confirm('Restore every dismissed duplicate-identity suggestion for review?')) return;
    setMerging('restore-dismissed');
    try {
      await restoreDismissedEntityDuplicateCandidates();
      await identityCandidates.refetch();
    } finally {
      setMerging('');
    }
  };
  return (
    <>
      {otherIdentityConflicts.length > 0 && (
        <Card className="mb-4 border-warning/40 bg-warning/5 p-4">
          <div className="mb-1 text-body font-medium text-fg">Other identity conflicts</div>
          <p className="mb-3 text-small text-muted">These cross-type or non-person records share a stable identifier. Choose the identity Clementine should keep; facts, relationships, aliases, and history will resolve through it.</p>
          <div className="space-y-3">
            {otherIdentityConflicts.slice(0, 8).map((conflict) => {
              const key = `${conflict.scheme}:${conflict.value}`;
              return (
                <div key={key} className="rounded-lg border border-border bg-surface p-3">
                  <div className="mb-2 text-caption text-faint">Shared {conflict.scheme}: {conflict.value}</div>
                  <div className="flex flex-wrap gap-2">
                    {conflict.entities.map((entity) => (
                      <Button key={entity.id} variant="secondary" size="sm" disabled={Boolean(merging)} onClick={() => void mergeConflict(conflict, entity.id)}>
                        {merging === key ? 'Combining…' : `Keep ${entity.name} (${entity.type})`}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      {((identityCandidates.data?.total ?? 0) > 0 || (identityCandidates.data?.dismissedCount ?? 0) > 0) && (
        <Card className="mb-4 border-primary/30 bg-primary-tint/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="mb-1 text-body font-medium text-fg">Possible duplicate people</div>
              <p className="text-small text-muted">
                {identityCandidates.data?.total ?? 0} review group{identityCandidates.data?.total === 1 ? '' : 's'} from full-name, alias, nickname, and stable-identifier evidence. Clementine never combines name-only matches automatically.
              </p>
            </div>
            {(identityCandidates.data?.dismissedCount ?? 0) > 0 && (
              <Button variant="ghost" size="sm" disabled={Boolean(merging)} onClick={() => void restoreCandidates()}>
                {merging === 'restore-dismissed' ? 'Restoring…' : `Restore dismissed pairs (${identityCandidates.data?.dismissedCount})`}
              </Button>
            )}
          </div>
          <div className="mt-3 space-y-3">
            {identityCandidates.data?.candidates.slice(0, 10).map((candidate) => (
              <DuplicateIdentityCandidateCard
                key={candidate.id}
                candidate={candidate}
                busy={merging}
                onKeep={(canonicalId) => void mergeReviewedGroup(candidate.entities, canonicalId, candidate.id)}
                onDismiss={() => void dismissCandidate(candidate)}
              />
            ))}
            {(identityCandidates.data?.candidates.length ?? 0) > 10 && (
              <details className="rounded-lg border border-border bg-surface p-3 text-small text-muted">
                <summary className="cursor-pointer font-medium text-fg">Review {identityCandidates.data!.candidates.length - 10} more possible duplicate group{identityCandidates.data!.candidates.length - 10 === 1 ? '' : 's'}</summary>
                <div className="mt-3 space-y-3">
                  {identityCandidates.data?.candidates.slice(10).map((candidate) => (
                    <DuplicateIdentityCandidateCard
                      key={candidate.id}
                      candidate={candidate}
                      busy={merging}
                      onKeep={(canonicalId) => void mergeReviewedGroup(candidate.entities, canonicalId, candidate.id)}
                      onDismiss={() => void dismissCandidate(candidate)}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {ENTITY_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', type === t ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{ENTITY_PLURAL[t] ?? t}</button>
        ))}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all identities…" aria-label="Search all identities" className="ml-auto w-56" />
      </div>
      {entities.isLoading ? <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="Nothing here yet" description="People, companies, and projects Clementine learns about will appear here." /></Card>
          : <>
              <p className="mb-2 text-small text-muted">
                {rows.length} of {(entities.data?.total ?? rows.length).toLocaleString()} matching canonical identities
                {(type !== 'all' || debouncedQ) ? ` · ${(entities.data?.allTotal ?? 0).toLocaleString()} total` : ''}
                {' · '}{(entities.data?.redirectedTotal ?? 0).toLocaleString()} identity records safely combined.
              </p>
              {selectedId != null && <EntityMemoryPanel entityId={selectedId} onClose={() => setSelectedId(null)} />}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((e) => <EntityCard key={e.id} entity={e} selected={String(e.id) === String(selectedId)} onOpen={() => setSelectedId(e.id)} />)}
              </div>
            </>}
    </>
  );
}

function DuplicateIdentityCandidateCard({
  candidate,
  busy,
  onKeep,
  onDismiss,
}: {
  candidate: EntityDuplicateCandidate;
  busy: string;
  onKeep: (canonicalId: number) => void;
  onDismiss: () => void;
}) {
  const working = busy === candidate.id || busy === `dismiss:${candidate.id}`;
  return (
    <div className="rounded-lg border border-border bg-surface p-3" data-testid={`identity-candidate-${candidate.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={candidate.confidence === 'high' ? 'success' : candidate.confidence === 'medium' ? 'warning' : 'neutral'}>{candidate.confidence} match</StatusPill>
        <span className="text-caption text-faint">Strongest signal {Math.round(candidate.score * 100)}/100 · {candidate.entities.length} records</span>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {candidate.entities.map((entity) => {
          const suggested = entity.id === candidate.suggestedCanonicalId;
          return (
            <button
              key={entity.id}
              type="button"
              disabled={Boolean(busy)}
              onClick={() => onKeep(entity.id)}
              className={cn('cursor-pointer rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60', suggested ? 'border-primary bg-primary-tint/20 hover:bg-primary-tint/30' : 'border-border hover:border-primary/50 hover:bg-subtle')}
            >
              <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-small font-medium text-fg">Keep {entity.name}</span>{suggested && <StatusPill tone="success">suggested</StatusPill>}</div>
              <div className="mt-1 text-caption text-faint">{entity.groundedClaims} source-backed claims · {entity.observations} episodes · {entity.identifiers.length} stable ids</div>
            </button>
          );
        })}
      </div>
      <div className="mt-2 space-y-1 text-caption text-muted">
        {candidate.reasons.slice(0, 3).map((reason) => <div key={reason}>Evidence: {reason}</div>)}
        {candidate.cautions.map((caution) => <div key={caution} className="text-warning">Caution: {caution}</div>)}
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={onDismiss}>{working && busy.startsWith('dismiss:') ? 'Dismissing…' : 'Not the same person'}</Button>
      </div>
    </div>
  );
}

function EntityCard({ entity, selected, onOpen }: { entity: Entity; selected: boolean; onOpen: () => void }) {
  return (
    <Card className={cn('transition-colors', selected && 'border-primary bg-primary-tint/20')}>
      <button type="button" onClick={onOpen} className="w-full cursor-pointer p-3.5 text-left" aria-expanded={selected} data-testid={`entity-card-${entity.id}`}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{entity.canonicalName}</span>
          <StatusPill tone="neutral">{entity.entityType}</StatusPill>
        </div>
        {entity.aliases && entity.aliases.length > 0 && <p className="mt-1 line-clamp-1 text-caption text-faint">aka {entity.aliases.join(', ')}</p>}
        <p className="mt-2 text-caption text-faint">
          {(entity.groundedFactCount ?? 0).toLocaleString()} source-backed claims
          {' · '}{(entity.observationCount ?? 0).toLocaleString()} source episodes
          {(entity.inferredFactCount ?? 0) > 0 ? ` · ${entity.inferredFactCount?.toLocaleString()} candidate links hidden` : ''}
          {entity.identifierCount ? ` · ${entity.identifierCount} stable ids` : ''}
        </p>
      </button>
    </Card>
  );
}

function shortDate(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : value;
}

function EntityMemoryPanel({ entityId, onClose }: { entityId: Entity['id']; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['entity-memory', String(entityId)],
    queryFn: () => getEntityMemory(entityId),
    staleTime: 30_000,
  });
  if (detail.isLoading) return <Card className="mb-4 p-4"><Skeleton className="h-56 w-full" /></Card>;
  if (detail.isError || !detail.data) return (
    <Card className="mb-4 p-4">
      <div className="flex items-center justify-between gap-3"><p className="text-body text-danger">Could not load this identity’s memory.</p><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>
    </Card>
  );
  return <EntityMemoryDetailPanel detail={detail.data} onClose={onClose} />;
}

function EntityMemoryDetailPanel({ detail, onClose }: { detail: EntityMemoryDetail; onClose: () => void }) {
  const { entity, stats } = detail;
  return (
    <Card className="mb-4 overflow-hidden border-primary/40">
      <div className="border-b border-border bg-subtle/60 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-h3 text-fg">{entity.canonicalName}</h3>
              <StatusPill tone="neutral">{entity.type}</StatusPill>
              {detail.identity.redirectedFrom.length > 0 && <StatusPill tone="success">{detail.identity.redirectedFrom.length} duplicate{detail.identity.redirectedFrom.length === 1 ? '' : 's'} combined</StatusPill>}
            </div>
            <p className="mt-1 text-small text-muted">Observed from {shortDate(entity.firstSeenAt)} through {shortDate(entity.lastSeenAt)} · only evidence-backed links appear here.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close identity memory" onClick={onClose}><X className="h-4 w-4" aria-hidden /></Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ['Accepted current', stats.currentClaims],
            ['Needs review', stats.reviewClaims],
            ['Relationships', stats.currentRelationships],
            ['Source episodes', stats.sourceEpisodes],
            ['Stable IDs', stats.identifiers],
          ].map(([label, value]) => <div key={String(label)} className="rounded-md border border-border bg-surface px-3 py-2"><div className="text-h3 text-fg">{value}</div><div className="text-caption text-faint">{label}</div></div>)}
        </div>
      </div>

      <div className="grid gap-5 p-4 lg:grid-cols-2">
        <section>
          <h4 className="mb-2 text-body font-semibold text-fg">What Clementine knows</h4>
          {detail.claims.length === 0 ? <p className="rounded-md bg-subtle p-3 text-small text-muted">No evidence-backed claims yet. Name matches that were only inferred stay out of this profile.</p>
            : <div className="space-y-2">{detail.claims.slice(0, 30).map((claim) => {
              const temporalStatus = memoryClaimTemporalStatus(claim, detail.asOf);
              return (
              <div key={claim.factId} className="rounded-md border border-border p-3">
                <div className="mb-1 flex flex-wrap gap-1.5">
                  <StatusPill tone={temporalStatus === 'current' ? 'success' : temporalStatus === 'scheduled' ? 'neutral' : 'warning'}>{temporalStatus}</StatusPill>
                  {claim.quality === 'needs_review' && <StatusPill tone="warning">needs review</StatusPill>}
                  <StatusPill tone="neutral">{KIND_LABEL[claim.kind] ?? claim.kind}</StatusPill>
                  <span className="text-caption text-faint">{Math.round(claim.confidence * 100)}% confidence · {claim.evidence.length} source{claim.evidence.length === 1 ? '' : 's'}</span>
                </div>
                <p className="text-small text-fg">{claim.content}</p>
                {claim.reviewReason && <p className="mt-1 rounded bg-warning/10 p-2 text-caption text-warning">{claim.reviewReason} It stays recoverable until you review it in Facts.</p>}
                {(claim.validFrom || claim.validTo) && <p className="mt-1 text-caption text-faint">Valid {claim.validFrom ? `from ${shortDate(claim.validFrom)}` : ''}{claim.validTo ? ` until ${shortDate(claim.validTo)}` : temporalStatus === 'scheduled' ? ' · scheduled to begin' : temporalStatus === 'current' ? ' · currently open' : ''}</p>}
                {claim.evidence.length > 0 && <details className="mt-2 text-caption text-muted"><summary className="cursor-pointer">Show evidence</summary><div className="mt-1 space-y-1">{claim.evidence.map((evidence) => <div key={`${claim.factId}:${evidence.episodeId}`} className="rounded bg-subtle p-2"><div>{evidence.excerpt || 'Evidence excerpt unavailable.'}</div><div className="mt-1 text-faint">{shortDate(evidence.occurredAt)} · {evidence.status}{evidence.sourceUri ? ` · ${evidence.sourceUri}` : ''}</div></div>)}</div></details>}
              </div>
              );
            })}</div>}
        </section>

        <section>
          <h4 className="mb-2 text-body font-semibold text-fg">Relationships</h4>
          {detail.relationships.length === 0 ? <p className="rounded-md bg-subtle p-3 text-small text-muted">No stored relationships with exact supporting language yet. Clementine will not promote simple co-occurrence.</p>
            : <div className="space-y-2">{detail.relationships.slice(0, 30).map((relationship, index) => {
              const statement = relationship.direction === 'outgoing'
                ? `${entity.canonicalName} — ${relationship.predicate} → ${relationship.otherEntity.canonicalName}`
                : `${relationship.otherEntity.canonicalName} — ${relationship.predicate} → ${entity.canonicalName}`;
              return <div key={`${relationship.direction}:${relationship.predicate}:${relationship.otherEntity.id}:${index}`} className="rounded-md border border-border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <StatusPill tone={relationship.current ? 'success' : 'warning'}>{relationship.current ? 'current' : 'historical'}</StatusPill>
                  <span className="text-caption text-faint">{Math.round(relationship.confidence * 100)}% confidence · {relationship.evidence.length} evidence item{relationship.evidence.length === 1 ? '' : 's'}</span>
                </div>
                <p className="text-small font-medium text-fg">{statement}</p>
                {relationship.evidence.length === 0 && <p className="mt-1 text-caption text-warning">Stored legacy edge; supporting evidence is not available.</p>}
                {relationship.evidence.length > 0 && <details className="mt-2 text-caption text-muted"><summary className="cursor-pointer">Show relationship evidence</summary><div className="mt-1 space-y-1">{relationship.evidence.map((evidence) => <div key={evidence.episodeId} className="rounded bg-subtle p-2"><div>{evidence.excerpt}</div><div className="mt-1 text-faint">{shortDate(evidence.observedAt)} · {evidence.status}{evidence.sourceUri ? ` · ${evidence.sourceUri}` : ''}</div></div>)}</div></details>}
                {relationship.validityIntervals.length > 1 && <details className="mt-1 text-caption text-muted"><summary className="cursor-pointer">Show relationship history</summary><div className="mt-1 space-y-1">{relationship.validityIntervals.map((period) => <div key={`${period.validFrom}:${period.validTo ?? 'open'}`} className="rounded bg-subtle p-2">{shortDate(period.validFrom)} → {period.validTo ? shortDate(period.validTo) : 'current'} · {period.openedReason}{period.closedReason ? ` · ${period.closedReason}` : ''}</div>)}</div></details>}
              </div>;
            })}</div>}
        </section>
      </div>

      <div className="grid gap-5 border-t border-border p-4 lg:grid-cols-2">
        <section>
          <h4 className="mb-2 text-body font-semibold text-fg">Identity</h4>
          <div className="rounded-md border border-border p-3 text-small">
            <div className="text-caption text-faint">Aliases</div>
            <p className="mt-1 text-fg">{entity.aliases.length > 0 ? entity.aliases.map((alias) => alias.value).join(', ') : 'No alternate names recorded.'}</p>
            <div className="mt-3 text-caption text-faint">Stable identifiers</div>
            {entity.identifiers.length === 0 ? <p className="mt-1 text-muted">None recorded.</p> : <div className="mt-1 space-y-1">{entity.identifiers.map((identifier) => <div key={`${identifier.scheme}:${identifier.value}`} className="flex flex-wrap justify-between gap-2"><span className="text-fg">{identifier.scheme}: {identifier.value}</span><span className="text-faint">{Math.round(identifier.confidence * 100)}%</span></div>)}</div>}
            {detail.identity.redirectedFrom.length > 0 && <details className="mt-3 text-caption text-muted"><summary className="cursor-pointer">Combined identity history</summary><div className="mt-1 space-y-1">{detail.identity.redirectedFrom.map((source) => <div key={source.id} className="rounded bg-subtle p-2"><div>{source.canonicalName}</div><div className="text-faint">{source.reason} · {shortDate(source.createdAt)}</div></div>)}</div></details>}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-body font-semibold text-fg">Source timeline</h4>
          {detail.episodes.length === 0 ? <p className="rounded-md bg-subtle p-3 text-small text-muted">No distinct source episodes have been ledgered yet; older mention totals remain approximate.</p>
            : <div className="space-y-2">{detail.episodes.slice(0, 12).map((episode) => <div key={episode.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-1.5"><StatusPill tone={episode.status === 'available' || episode.status === 'partial' ? 'success' : 'warning'}>{episode.status}</StatusPill><span className="text-small font-medium text-fg">{episode.title ?? episode.sourceApp ?? episode.subtype ?? episode.kind}</span></div>
              <div className="mt-1 text-caption text-faint">{shortDate(episode.occurredAt)} · {episode.sourceKind}{episode.sourceUri ? ` · ${episode.sourceUri}` : ''}</div>
              {episode.excerpt && <details className="mt-1 text-caption text-muted"><summary className="cursor-pointer">Show source excerpt</summary><p className="mt-1 rounded bg-subtle p-2">{episode.excerpt}</p></details>}
            </div>)}</div>}
        </section>
      </div>
    </Card>
  );
}

// ─────────── Sources (what Clementine reads + where data lives) ───────────
// ─────────── Tool recall (procedural memory) ───────────
// Surfaces the per-machine learned-procedure store that was previously
// inspectable only by hand-reading .md files — the strongest ever-learning
// signal, now auditable: which tool proved out for an intent, its success
// rate, and what fell back.
function ProceduresTab() {
  const recall = usePoll(['tool-recall'], getToolRecall, 30000);
  const rows = recall.data?.records ?? [];
  return (
    <>
      <p className="mb-3 text-small text-muted">Tools Clementine learned to reach for, per intent — she skips rediscovery and goes straight to a proven path. Sorted by what's working.</p>
      {recall.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="No learned procedures yet" description="As Clementine proves out which tool handles a kind of task, it lands here so she doesn't rediscover it next time." /></Card>
          : <div className="space-y-2">{rows.map((r) => <ProcedureCard key={r.intent} rec={r} />)}</div>}
    </>
  );
}

function ProcedureCard({ rec }: { rec: ToolRecallRecord }) {
  const c = rec.choice;
  const score = typeof c?.score === 'number' ? Math.round(c.score * 100) : null;
  const success = c?.successCount ?? 0;
  const failure = c?.failureCount ?? 0;
  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{rec.intent}</span>
            {c ? <StatusPill tone="neutral">{c.kind}</StatusPill> : <StatusPill tone="warning">needs rediscovery</StatusPill>}
            {score != null && <span className="shrink-0 text-caption text-faint">{score}%</span>}
          </div>
          {c && <p className="mt-0.5 font-mono text-small text-muted">→ {c.identifier}</p>}
          {rec.description && <p className="mt-0.5 text-small text-muted">{rec.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
            {(success > 0 || failure > 0) && (
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden />{success}</span>
                <span className="inline-flex items-center gap-1"><XCircle className="h-3.5 w-3.5 text-warning" aria-hidden />{failure}</span>
              </span>
            )}
            {rec.fallbacks.length > 0 && <span>{rec.fallbacks.length} fallback{rec.fallbacks.length === 1 ? '' : 's'} tried</span>}
          </div>
        </div>
      </div>
    </Card>
  );
}

function SourcesTab() {
  const ctx = usePoll(['context'], getContext, 30000);
  const files = usePoll(['memory-files'], getMemoryFiles, 30000);
  const sources = usePoll(['source-map'], getSourceMap, 30000);
  const coreFiles = ctx.data?.files ?? [];
  const vault = files.data?.files ?? [];
  const pointers = sources.data?.pointers ?? [];
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg"><BookOpen className="h-5 w-5 text-primary" aria-hidden /> Core context</h3>
        <p className="mb-3 text-small text-muted">The notes Clementine reads on every turn — her personality, who you are, and what to keep in mind. This is the seeded memory you can shape.</p>
        {ctx.isLoading ? <Skeleton className="h-32 w-full" /> : <div className="space-y-2">{coreFiles.map((f) => <ContextFileCard key={f.key} file={f} />)}</div>}
      </section>

      {pointers.length > 0 && (
        <section>
          <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg"><MapPin className="h-5 w-5 text-primary" aria-hidden /> Where your data lives</h3>
          <p className="mb-3 text-small text-muted">The apps and places Clementine knows to look — Outlook folders, Airtable bases, Drive, and more.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {pointers.slice(0, 40).map((p) => (
              <Card key={p.id} className="p-3.5">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{p.name || p.ref}</span>
                  <StatusPill tone="neutral">{p.app}</StatusPill>
                </div>
                {p.whatsHere && <p className="mt-1 line-clamp-1 text-caption text-muted">{p.whatsHere}</p>}
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg"><Database className="h-5 w-5 text-primary" aria-hidden /> Indexed knowledge</h3>
        <p className="mb-3 text-small text-muted">Files Clementine has read and broken into searchable chunks — this is where she looks things up. ({vault.length} files)</p>
        {files.isLoading ? <Skeleton className="h-32 w-full" /> : vault.length === 0 ? <Card className="p-4 text-body text-muted">No files indexed yet.</Card>
          : <div className="space-y-1.5">
              {vault.slice(0, 80).map((v) => (
                <div key={v.path} className="flex items-center gap-3 rounded-md border border-border bg-surface px-3.5 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-mono text-small text-fg">{fileBasename(v.path)}</span>
                  <span className="shrink-0 text-caption text-faint">{v.chunks} chunk{v.chunks === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>}
      </section>
    </div>
  );
}

function ContextFileCard({ file }: { file: ContextFile }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 text-left cursor-pointer">
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-fg">{file.title}</div>
          {file.description && <div className="text-caption text-muted">{file.description}</div>}
        </div>
        <StatusPill tone={file.empty ? 'neutral' : 'success'}>{file.empty ? 'Empty' : `${file.bytes ?? 0} bytes`}</StatusPill>
      </button>
      {open && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-3 text-small text-muted">{file.content?.trim() || '(empty)'}</pre>}
    </Card>
  );
}

// ─────────── You & goals ───────────
function YouTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const ctx = usePoll(['context'], getContext, 20000);
  const profile = ctx.data?.profile ?? {};
  const goals = ctx.data?.goals ?? [];
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDesc, setGoalDesc] = useState('');
  const add = async () => { if (!goalTitle.trim() || !goalDesc.trim()) return; try { await addGoal(goalTitle.trim(), goalDesc.trim()); setGoalTitle(''); setGoalDesc(''); } finally { void qc.invalidateQueries({ queryKey: ['context'] }); } };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2"><User className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Profile</h3></div>
        {ctx.isLoading ? <Skeleton className="h-24 w-full" /> : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <ProfileItem label="Name" value={profile.preferredName || profile.displayName} />
            <ProfileItem label="Role" value={profile.role} />
            <ProfileItem label="Timezone" value={profile.timezone} />
            <ProfileItem label="Tone" value={profile.communicationTone} />
          </dl>
        )}
        <p className="mt-3 text-small text-muted">Wrong name or details? Fix them in <Link to="/settings" className="text-primary hover:underline">Settings → Profile</Link>.</p>
      </Card>
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2"><Target className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Your goals</h3></div>
        {ctx.isLoading ? <Skeleton className="h-24 w-full" /> : goals.length === 0 ? <p className="text-body text-muted">No goals yet. Tell Clementine what you're working toward.</p>
          : <ul className="space-y-2.5">{goals.map((g, i) => (
              <li key={g.id || i} className="flex items-start gap-2.5"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden /><div><div className="text-body font-medium text-fg">{g.title || g.objective || 'Goal'}</div>{g.description && <div className="text-small text-muted">{g.description}</div>}</div></li>
            ))}</ul>}
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <Input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="New goal (e.g. Grow SEO pipeline)" aria-label="Goal title" />
          <div className="flex gap-2">
            <Input value={goalDesc} onChange={(e) => setGoalDesc(e.target.value)} placeholder="What does success look like?" aria-label="Goal description" className="flex-1" />
            <Button size="sm" onClick={add} disabled={!goalTitle.trim() || !goalDesc.trim()}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProfileItem({ label, value }: { label: string; value?: string }) {
  return <div><dt className="text-label text-faint">{label}</dt><dd className="text-body text-fg">{value || '—'}</dd></div>;
}

// ─────────── Import: bring another agent's memory into Clementine ───────────

function ImportTab({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [path, setPath] = useState('');
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [distill, setDistill] = useState(true);
  const [label, setLabel] = useState('');
  const [importing, setImporting] = useState(false);
  const [lastBatch, setLastBatch] = useState<ImportBatch | null>(null);
  const [error, setError] = useState('');

  const discovered = useQuery({ queryKey: ['mem-import-discover'], queryFn: discoverImportSources, staleTime: 60_000 });
  const batches = useQuery({ queryKey: ['mem-import-batches'], queryFn: listImportBatches, staleTime: 10_000 });

  const doScan = async (p: string) => {
    setError(''); setLastBatch(null); setScanning(true);
    try {
      const result = await scanImportPath(p);
      setScan(result);
      setSelected(new Set(result.files.map((f) => f.path)));
      setPath(p);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setScanning(false); }
  };

  const doImport = async () => {
    if (!scan || selected.size === 0) return;
    setError(''); setImporting(true);
    try {
      const { batch } = await runMemoryImport({
        path: scan.root,
        files: selected.size === scan.files.length ? undefined : [...selected],
        sourceLabel: label.trim() || undefined,
        distill,
      });
      setLastBatch(batch);
      setScan(null);
      qc.invalidateQueries({ queryKey: ['mem-import-batches'] });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setImporting(false); }
  };

  const doUndo = async (id: string) => {
    setError('');
    try {
      await undoImportBatch(id);
      setLastBatch(null);
      qc.invalidateQueries({ queryKey: ['mem-import-batches'] });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div className="space-y-5">
      <Card>
        <div className="mb-1 flex items-center gap-2 text-body-lg font-semibold text-fg"><Download className="h-4 w-4" aria-hidden /> Import another agent&apos;s memory</div>
        <p className="mb-4 text-body text-muted">
          Point Clementine at any local memory store — Claude Code memories, OpenClaw or Fermis files, a bare <code>memory.md</code> / <code>AGENTS.md</code> — and she&apos;ll
          normalize it into her own facts, de-duplicate, embed, and make it searchable. Imports are additive and undoable; source files are never modified.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/memory-folder or ~/notes/memory.md"
            aria-label="Memory source path" className="min-w-72 flex-1" />
          <Button onClick={() => path.trim() && doScan(path.trim())} disabled={!path.trim() || scanning}>
            <FolderSearch className="h-4 w-4" aria-hidden /> {scanning ? 'Scanning…' : 'Scan'}
          </Button>
        </div>
        {error && <p className="mt-2 text-body text-danger">{error}</p>}
      </Card>

      {!scan && (discovered.data?.sources.length ?? 0) > 0 && (
        <Card>
          <div className="mb-2 text-body-lg font-semibold text-fg">Found on this Mac</div>
          <p className="mb-3 text-body text-muted">Agent-memory locations Clementine can see. Nothing is imported until you scan and confirm.</p>
          <ul className="space-y-2">
            {discovered.data!.sources.map((s) => (
              <li key={s.path} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body font-medium text-fg">{s.label}</div>
                  <div className="truncate text-label text-faint">{s.path} · {s.fileCount} file{s.fileCount === 1 ? '' : 's'}</div>
                </div>
                <Button variant="secondary" onClick={() => doScan(s.path)}>Scan</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {scan && (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-body-lg font-semibold text-fg">{scan.files.length} importable file{scan.files.length === 1 ? '' : 's'} in {scan.root}</div>
            <button type="button" className="cursor-pointer text-label text-muted hover:text-fg"
              onClick={() => setSelected(selected.size === scan.files.length ? new Set() : new Set(scan.files.map((f) => f.path)))}>
              {selected.size === scan.files.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <ul className="mb-4 max-h-80 space-y-1 overflow-y-auto">
            {scan.files.map((f) => (
              <li key={f.path}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                  <input type="checkbox" checked={selected.has(f.path)} className="mt-1"
                    onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(f.path); else next.delete(f.path); setSelected(next); }} />
                  <span className="min-w-0">
                    <span className="block truncate text-body text-fg">{fileBasename(f.path)} <span className="text-faint">· {f.shape === 'structured_md' ? 'structured' : 'freeform'} · {Math.max(1, Math.round(f.bytes / 1024))}KB</span></span>
                    <span className="block truncate text-label text-muted">{f.preview}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {scan.skipped.length > 0 && <p className="mb-3 text-label text-faint">{scan.skipped.length} file(s) skipped (unsupported, empty, or too large).</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Source label (e.g. openclaw)" aria-label="Source label" className="w-56" />
            <label className="flex cursor-pointer items-center gap-2 text-body text-muted">
              <input type="checkbox" checked={distill} onChange={(e) => setDistill(e.target.checked)} />
              Distill freeform files with the model
            </label>
            <Button onClick={doImport} disabled={selected.size === 0 || importing}>
              <Download className="h-4 w-4" aria-hidden /> {importing ? 'Importing…' : `Import ${selected.size} file${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>
        </Card>
      )}

      {lastBatch && (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-body-lg font-semibold text-fg"><CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> Imported</div>
              <p className="text-body text-muted">
                {lastBatch.newFactIds.length} new fact(s) from {lastBatch.fileCount} file(s) · {lastBatch.dedupedCount} already known ·
                {' '}{lastBatch.distilledFiles} distilled · {lastBatch.errors.length} error(s). Embedding started — these are entering semantic recall now.
              </p>
            </div>
            <Button variant="secondary" onClick={() => doUndo(lastBatch.id)}><Undo2 className="h-4 w-4" aria-hidden /> Undo</Button>
          </div>
        </Card>
      )}

      {(batches.data?.batches.length ?? 0) > 0 && (
        <Card>
          <div className="mb-2 text-body-lg font-semibold text-fg">Past imports</div>
          <ul className="space-y-2">
            {batches.data!.batches.slice(0, 10).map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body font-medium text-fg">{b.sourceLabel} <span className="text-faint">· {new Date(b.startedAt).toLocaleString()}</span></div>
                  <div className="truncate text-label text-faint">{b.root} · +{b.newFactIds.length} facts ({b.dedupedCount} deduped)</div>
                </div>
                {b.newFactIds.length > 0 && (
                  <Button variant="secondary" onClick={() => doUndo(b.id)}><Undo2 className="h-4 w-4" aria-hidden /> Undo</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
