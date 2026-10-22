import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, Trash2, Pin, Target, User, Network, FileText, BookOpen, Plus, X, Database,
  Users, MapPin, Wrench, CheckCircle2, XCircle, Download, Undo2, FolderSearch, Pencil, History,
  ShieldCheck, AlertTriangle, ArrowRight, Clock, Globe, MessageCircle, Activity, ChevronRight,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { MemoryGraphContainer } from '@/components/MemoryGraphContainer';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { ToolRecallSection } from './advanced/ToolRecallSection';
import {
  listFacts, forgetFact, pinFact, getContext, addFact, addGoal, searchMemory, getMemoryFiles,
  getBrainHealth, getMemoryHealth, listEntities, getSourceMap, fileBasename, FACT_KINDS,
  listEntityIdentityConflicts, listEntityDuplicateCandidates, dismissEntityDuplicateCandidate,
  restoreDismissedEntityDuplicateCandidates, mergeEntityIdentity,
  getEntityMemory,
  listMemoryReviewCandidates, applyMemoryReviewCandidate, dismissMemoryReviewCandidate,
  discoverImportSources, scanImportPath, runMemoryImport, listImportBatches, undoImportBatch,
  restoreFact, updateFact, moveFactScope, reconcileMemoryEvidence, reconcileMemoryRelationships,
  getMemoryReadiness, listReflectionCandidates,
  listMemoryEpisodes, promoteMemoryEpisodeCandidate, rejectMemoryEpisodeCandidate,
  listIdentityProposals, approveIdentityProposal, rejectIdentityProposal, type IdentityProposal,
  type Fact, type ContextFile, type Entity, type ImportScan, type ImportBatch, type MemoryHit,
  type EntityIdentityConflict, type EntityDuplicateCandidate, type EntityMemoryDetail,
  type MemoryReviewCandidate, type MemoryReadinessReport, type MemoryReadinessCheck,
  type MemoryEpisode, type MemoryEpisodeKind, type MemoryEpisodeStatus,
} from '@/lib/memory';
import { memoryAssuranceView, memoryClaimTemporalStatus } from '@/lib/memory-assurance';
import { HitRow } from '@/components/memory/HitRow';
import { HealthStrip } from '@/components/memory/HealthStrip';
import { ReviewPane } from '@/components/memory/ReviewPane';
import { LearnedPane } from '@/components/memory/LearnedPane';
import { MemoryDetail } from '@/components/memory/MemoryDetail';
import { MemoryWorkPanel } from '@/components/memory/work/MemoryWorkPanel';
import { MemoryAssistant } from '@/components/memory/MemoryAssistant';
import { memoryWorkViewModel, useMemoryWork } from '@/lib/memory-work';
import './memory-workspace.css';
import type { MemoryStore } from '@/lib/memory';
import { memoryScopeLabel } from '@clem/chat-engine';
import { ScopeChip } from '@/components/memory/ScopeChip';
import { canMoveToEverywhere, factScopeChoices, factScopeFromKey, factScopeKey, scopedFacts } from '@/lib/memory-scope';
import { apiErrorCode, listProjects, projectKeys, refusalText } from '@/lib/projects';
import { listAgents } from '@/lib/agents';
import { isMac } from '@/lib/platform';
import { ExactMemoryDetail } from '@/components/memory/ExactMemoryDetail';
import { memoryFactId } from '@/lib/memory-fact-links';

type Tab = 'overview' | 'facts' | 'tools' | 'episodes' | 'entities' | 'sources' | 'activity' | 'review';
const TABS: readonly Tab[] = ['overview', 'facts', 'tools', 'episodes', 'entities', 'sources', 'activity', 'review'];
const KIND_LABEL: Record<Fact['kind'], string> = { user: 'About you', project: 'Project', feedback: 'Preference', reference: 'Reference', constraint: 'Hard constraint' };

const KIND_FACETS: Array<{ key: MemoryStore | 'all'; label: string }> = [
  { key: 'all', label: 'All' }, { key: 'fact', label: 'Facts' }, { key: 'entity', label: 'People' }, { key: 'note', label: 'Notes' }, { key: 'procedure', label: 'Procedures' }, { key: 'episode', label: 'Timeline' }, { key: 'resource', label: 'Resources' }, { key: 'policy', label: 'Policies' },
];
type Scope = 'all' | 'week' | 'meetings' | 'salesforce';
const SCOPE_FACETS: Array<{ key: Scope; label: string }> = [
  { key: 'week', label: 'Effective this week' }, { key: 'meetings', label: 'From meetings' }, { key: 'salesforce', label: 'From Salesforce' },
];
function inScope(hit: MemoryHit, scope: Scope): boolean {
  if (scope === 'all') return true;
  if (scope === 'week') { const t = hit.validFrom ? Date.parse(hit.validFrom) : NaN; return Number.isFinite(t) && t >= Date.now() - 7 * 24 * 60 * 60 * 1000; }
  const uris = hit.evidence.map((e) => e.sourceUri ?? '').join(' ');
  if (scope === 'meetings') return /meeting|recall|transcript/i.test(uris);
  return /salesforce/i.test(uris);
}
/** A fact from the Learned pane opens in the same detail panel a search hit does. */
function factToHit(f: Fact): MemoryHit {
  return {
    ref: { type: 'fact', id: f.id }, text: f.content, score: 1, confidence: typeof f.confidence === 'number' ? f.confidence : null,
    evidence: (f.evidence ?? []).map((e) => ({ episodeId: e.episodeId, excerpt: e.excerpt, ...(e.sourceUri ? { sourceUri: e.sourceUri } : {}) })),
    whyRecalled: [], ...(f.validFrom || f.createdAt ? { validFrom: (f.validFrom ?? f.createdAt) as string } : {}), ...(f.validTo ? { validTo: f.validTo } : {}),
  };
}

export function Memory() {
  const [params] = useSearchParams();
  // A task's exact reference has its own view. The normal overview's polls,
  // list and search never mount while that reference is open.
  const linkedFacts = params.getAll('fact');
  if (linkedFacts.length) return <ExactMemoryDetail factId={linkedFacts.length === 1 ? memoryFactId(linkedFacts[0]) : null} />;
  return <MemoryOverview />;
}

function MemoryOverview() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const linkedScope = factScopeKey(factScopeFromKey(params.get('scope') ?? ''));
  const tab = TABS.find((key) => key === params.get('tab')) ?? (linkedScope !== 'all' ? 'facts' : 'overview');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [kind, setKind] = useState<MemoryStore | 'all'>('all');
  const [scope, setScope] = useState<Scope>('all');
  const [selected, setSelected] = useState<MemoryHit | null>(null);
  const [selectedPinned, setSelectedPinned] = useState<boolean | null>(null);
  const [selectedActive, setSelectedActive] = useState<boolean | null>(null);
  const [correctSelection, setCorrectSelection] = useState(false);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [panel, setPanel] = useState<'ask' | 'detail' | null>(null);
  const [askContext, setAskContext] = useState<MemoryHit | null>(null);
  const [asking, setAsking] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const rememberPanelTrigger = () => { if (document.activeElement instanceof HTMLElement) panelTrigger.current = document.activeElement; };
  const closePanel = () => {
    setPanel(null);
    requestAnimationFrame(() => (panelTrigger.current?.isConnected ? panelTrigger.current : searchInputRef.current)?.focus({ preventScroll: true }));
  };
  const showAsk = () => { rememberPanelTrigger(); setPanel('ask'); };
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const searching = debouncedQ.length >= 2;
  const showFacets = q.length > 0 || kind !== 'all' || scope !== 'all';
  const search = useQuery({
    queryKey: ['mem-search', debouncedQ, kind],
    queryFn: () => searchMemory(debouncedQ, { limit: 30, ...(kind === 'all' ? {} : { stores: [kind] }) }),
    enabled: searching, staleTime: 30_000,
  });
  const health = usePoll(['mem-health'], getMemoryHealth, 30_000);
  const brain = usePoll(['brain-health'], getBrainHealth, 30_000);
  const memoryFiles = usePoll(['memory-files'], getMemoryFiles, 60_000);
  // Count reads are shared with ReviewPane. They never insert rows above the
  // navigation or change the viewport belonging to the user's current store.
  const review = usePoll(['mem-review'], () => listMemoryReviewCandidates(8), 30_000);
  const duplicates = usePoll(['mem-dups'], () => listEntityDuplicateCandidates(8), 30_000);
  const reviewCount = review.data ? review.data.total ?? review.data.candidates.length : null;
  const duplicateCount = duplicates.data ? duplicates.data.total ?? duplicates.data.candidates.length : null;
  const waiting = reviewCount != null && duplicateCount != null ? reviewCount + duplicateCount : null;
  const hits = (search.data?.hits ?? []).filter((h) => inScope(h, scope));
  const refreshMemory = useCallback(() => {
    for (const key of ['mem-search', 'facts', 'mem-health', 'memory-health', 'brain-health', 'mem-review', 'mem-dups', 'memory-work', 'memory-review-candidates', 'reflection-candidates', 'memory-readiness', 'entity-memory', 'entities', 'entity-identity-conflicts', 'entity-duplicate-candidates', 'memory-episodes', 'tool-recall', 'context', 'source-map', 'memory-files', 'identity-proposals', 'mem-import-batches']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [qc]);
  const navigate = (next: Tab, addMemory = false) => {
    setParams((previous) => { const value = new URLSearchParams(previous); value.set('tab', next); if (addMemory) { value.set('add', '1'); value.delete('scope'); } else value.delete('add'); return value; }, { replace: true });
    setQ(''); setDebouncedQ(''); setKind('all'); setScope('all');
    focusHeading.current = !addMemory;
    // Also reset when selecting the current store after searching.
    contentRef.current?.scrollTo({ top: 0 });
  };
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    if (focusHeading.current) { headingRef.current?.focus({ preventScroll: true }); focusHeading.current = false; }
  }, [tab, searching, debouncedQ, kind, scope, linkedScope]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Keep the global command palette's shortcut; Memory search has its own.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (hit: MemoryHit, pinned: boolean | null = null, active: boolean | null = null, correct = false) => { rememberPanelTrigger(); setSelected(hit); setSelectedPinned(pinned); setSelectedActive(active); setCorrectSelection(correct); setSelectionVersion((value) => value + 1); setPanel('detail'); };
  const pickFact = (fact: Fact, correct = false) => pick(factToHit(fact), typeof fact.pinned === 'boolean' ? fact.pinned : null, typeof fact.active === 'boolean' ? fact.active : null, correct);
  const askAbout = (hit: MemoryHit) => { setAskContext(hit); showAsk(); };
  const storeCount = (key: Tab): number | null => {
    if (key === 'facts') return brain.data?.activeFacts ?? null;
    if (key === 'entities') return brain.data?.entitiesTotal ?? null;
    if (key === 'episodes') return brain.data?.memoryEpisodesTotal ?? null;
    if (key === 'sources') return memoryFiles.data?.files?.length ?? null;
    if (key === 'review') return waiting;
    return null;
  };
  const tabs: { key: Tab; label: string; icon: typeof Search; description: string }[] = [
    { key: 'overview', label: 'Memory graph', icon: Network, description: 'Explore the connections between memories and their sources.' },
    { key: 'facts', label: 'Facts', icon: BookOpen, description: 'What you told Clem and what she learned, with sources and history.' },
    { key: 'entities', label: 'People & things', icon: Users, description: 'People, organizations, and the connections between them.' },
    { key: 'tools', label: 'Procedures & tools', icon: Wrench, description: 'How Clem learns to do things, and which tools worked.' },
    { key: 'episodes', label: 'Timeline', icon: History, description: 'The conversations and observations behind durable memories.' },
    { key: 'sources', label: 'Sources', icon: FileText, description: 'The files and context behind what Clem knows.' },
    { key: 'activity', label: 'Learning activity', icon: Activity, description: 'Background jobs, the models doing the work, and what changed.' },
    { key: 'review', label: 'Review & health', icon: ShieldCheck, description: 'Decisions, repairs, and the evidence behind memory health.' },
  ];
  const current = tabs.find((item) => item.key === tab)!;
  return (
    <section className="memory-workspace" aria-label="Memory workspace">
      <header className="memory-toolbar">
        <div className="memory-search">
          <Search size={18} aria-hidden />
          <input ref={searchInputRef} value={q} onChange={(event) => setQ(event.target.value)} placeholder="Find a fact, person, or procedure…" aria-label="Search all memory" />
          {q ? <button type="button" aria-label="Clear memory search" onClick={() => { setQ(''); setDebouncedQ(''); searchInputRef.current?.focus(); }}><X size={17} aria-hidden /></button>
            : <kbd>{isMac() ? '⌘⇧F' : 'Ctrl Shift F'}</kbd>}
        </div>
        <Button variant="secondary" onClick={() => panel === 'ask' ? closePanel() : showAsk()} aria-expanded={panel === 'ask'} aria-controls="memory-assistant-pane">
          <MessageCircle className="h-4 w-4" aria-hidden /> {asking ? 'Clem is working…' : 'Ask Clem'}
        </Button>
      </header>
        <nav className="memory-navigation" aria-label="Memory views">
          {tabs.map((item, index) => {
            const count = storeCount(item.key); const Icon = item.icon;
            return <button key={item.key} type="button" aria-current={!searching && item.key === tab ? 'page' : undefined}
              className={cn('memory-nav-item', index === 6 && 'memory-nav-secondary')} onClick={() => navigate(item.key)}>
              <Icon size={17} aria-hidden /><span>{item.label}</span>
              {count != null && <span className={cn('memory-nav-count', item.key === 'review' && count > 0 && 'memory-nav-attention')}>{count.toLocaleString()}</span>}
            </button>;
          })}
          <label className="memory-view-select">View
            <select value={searching ? '' : tab} onChange={(event) => navigate(event.target.value as Tab)}>
              {searching && <option value="" disabled>Search results</option>}
              {tabs.map((item) => <option key={item.key} value={item.key}>{item.label}{storeCount(item.key) != null ? ` (${storeCount(item.key)!.toLocaleString()})` : ''}</option>)}
            </select>
          </label>
        </nav>
      <div className="memory-layout" data-panel-open={Boolean(panel)}>
        <div ref={contentRef} className="memory-content" tabIndex={0} aria-label={searching ? 'Memory search results' : `${current.label} content`}>
          <div className="memory-content-inner" data-map={!searching && tab === 'overview' || undefined}>
            <div className="memory-section-heading">
              <div><h2 ref={headingRef} tabIndex={-1}>{searching ? 'Search results' : current.label}</h2>
                <p>{searching ? `Across memory${kind === 'all' ? '' : ` · ${KIND_FACETS.find((facet) => facet.key === kind)?.label ?? kind}`}` : current.description}</p></div>
              {!searching && tab === 'overview' && <Button variant="secondary" size="sm" onClick={() => navigate('facts', true)}><Plus className="h-4 w-4" aria-hidden /> Add a memory</Button>}
            </div>
            {showFacets && <div className="memory-search-filters" aria-label="Search filters">
              <div>{KIND_FACETS.map((facet) => <button key={facet.key} type="button" aria-pressed={kind === facet.key} onClick={() => setKind(facet.key)}>{facet.label}</button>)}</div>
              <div>{SCOPE_FACETS.map((facet) => <button key={facet.key} type="button" aria-pressed={scope === facet.key} onClick={() => setScope(scope === facet.key ? 'all' : facet.key)}>{facet.label}</button>)}
                {(kind !== 'all' || scope !== 'all') && <button type="button" onClick={() => { setKind('all'); setScope('all'); }}>Clear filters</button>}</div>
            </div>}
            {searching ? (
              search.isLoading ? <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
                : search.isError && !search.data ? <CouldNotRead what="Memory search" onRetry={() => void search.refetch()} />
                : <>
                  {search.isError && <p role="status" className="mb-3 text-small text-warning">Showing the last results. The latest search couldn’t refresh.</p>}
                  {hits.length === 0 ? <div className="memory-search-empty"><Search size={24} aria-hidden /><h3>No matches returned for “{debouncedQ}”{kind !== 'all' || scope !== 'all' ? ' with these filters' : ''}</h3><p>Try another phrase, clear a filter, or ask Clem to look into it.</p><Button variant="secondary" onClick={showAsk}>Ask about memory</Button></div>
                    : <div className="space-y-2"><p className="text-small text-muted">{hits.length} {hits.length === 1 ? 'match' : 'matches'} shown</p>{hits.map((hit, index) => <HitRow key={`${hit.ref.type}:${hit.ref.id}`} hit={hit} index={index} selected={selected?.ref.type === hit.ref.type && String(selected.ref.id) === String(hit.ref.id)} onSelect={() => pick(hit)} />)}</div>}
                </>
            ) : <>
              {tab === 'overview' && <OverviewTab onNavigate={navigate} onPickLearned={pickFact} />}
              {tab === 'facts' && <FactsTab key={linkedScope} initialScope={linkedScope} initialAddOpen={params.get('add') === '1'} onPick={pickFact} onChanged={refreshMemory} />}
              {tab === 'tools' && <ToolRecallSection />}
              {tab === 'episodes' && <EpisodesTab />}
              {tab === 'entities' && <EntitiesTab />}
              {tab === 'sources' && <SourcesTab qc={qc} onNavigate={navigate} />}
              {tab === 'activity' && <MemoryWorkPanel />}
              {tab === 'review' && <MemoryReviewTab onNavigate={navigate} health={health.data} review={reviewCount} duplicates={duplicateCount} healthUnavailable={health.isError && !health.data} />}
            </>}
          </div>
        </div>
        <div className="memory-sidepanel" data-open={Boolean(panel)} aria-label="Memory companion" hidden={!panel}>
          <div id="memory-assistant-pane" className="memory-assistant-host" hidden={panel !== 'ask'}>
            <MemoryAssistant open={panel === 'ask'} onClose={closePanel} context={askContext} onClearContext={() => setAskContext(null)} onMemoryChanged={refreshMemory} onBusyChange={setAsking} />
          </div>
          {panel === 'detail' && <MemoryDetail key={selectionVersion} hit={selected} pinned={selectedPinned} active={selectedActive} initialEditing={correctSelection} onClose={closePanel} onAsk={askAbout} onReplaced={pickFact} onChanged={refreshMemory} className="memory-inspector" />}
        </div>
      </div>
    </section>
  );
}

// ─────────── Overview ───────────
// The graph is the landing workspace. Recent learning and working context
// follow it; diagnostics and the assistant never take space until requested.
function OverviewTab({ onNavigate, onPickLearned }: { onNavigate: (tab: Tab) => void; onPickLearned: (fact: Fact) => void }) {
  const ctx = usePoll(['context'], getContext, 20000);
  const workingMem = (ctx.data?.files ?? []).find((file) => file.key === 'working_memory');
  return <div className="memory-overview">
    <section className="memory-graph-stage" aria-label="Memory graph">
      <MemoryGraphContainer height="clamp(18rem, calc(100dvh - 21rem), 48rem)" />
      <p className="memory-graph-caption">Stored links first. Text matches and semantic similarity are labeled overlays.</p>
    </section>
    <MemoryLearningGlance onOpen={() => onNavigate('activity')} />
    <LearnedPane onPick={onPickLearned} />
    <details className="memory-overview-disclosure">
      <summary><Clock size={18} aria-hidden /><span><strong>Current working context</strong><small>What Clem carries forward as you work together</small></span><ChevronRight size={17} aria-hidden /></summary>
      <div>{ctx.isLoading ? <Skeleton className="h-24 w-full" /> : ctx.isError && !ctx.data ? <CouldNotRead what="Working memory" onRetry={() => void ctx.refetch()} /> : workingMem ? <ContextFileCard file={workingMem} onNavigate={onNavigate} /> : <p className="text-small text-muted">No working context is recorded yet.</p>}</div>
    </details>
    <button type="button" className="memory-review-link" onClick={() => onNavigate('review')}><ShieldCheck size={18} aria-hidden /><span>Review decisions and memory health</span><ArrowRight size={17} aria-hidden /></button>
  </div>;
}

function MemoryLearningGlance({ onOpen }: { onOpen: () => void }) {
  const work = useMemoryWork();
  const view = work.data ? memoryWorkViewModel(work.data, Date.now(), { stale: work.isError, readAt: work.dataUpdatedAt || undefined }) : null;
  return <section className="memory-learning-glance" aria-label="Background learning">
    <div className="memory-learning-heading"><span className="memory-status-dot" data-state={view?.state ?? 'unknown'} aria-hidden /><h3>{view?.headline ?? (work.isError ? 'Learning status unavailable' : work.isLoading ? 'Reading learning activity…' : 'Learning activity is not reported')}</h3></div>
    <p>{view?.detail ?? 'See what the background jobs have learned and which model did the work.'}</p>
    <div className="memory-learning-footer"><span>{view?.model.name ? `Memory model · ${view.model.name}` : 'Memory model not reported'}</span><button type="button" onClick={onOpen}>View learning activity <ArrowRight size={15} aria-hidden /></button></div>
  </section>;
}

function MemoryReviewTab({ onNavigate, health, review, duplicates, healthUnavailable }: { onNavigate: (tab: Tab) => void; health?: import('@/lib/memory').MemoryHealth; review: number | null; duplicates: number | null; healthUnavailable: boolean }) {
  const memHealth = usePoll(['memory-health'], getMemoryHealth, 30000);
  const readiness = usePoll(['memory-readiness'], getMemoryReadiness, 30000);
  return <div className="space-y-5">
    <HealthStrip health={health} review={review} duplicates={duplicates} unavailable={healthUnavailable} />
    <ReviewPane onOpen={onNavigate} />
    <MemoryReviewQueue health={memHealth.data} readiness={readiness.data} onNavigate={onNavigate} onUpdated={() => { void memHealth.refetch(); void readiness.refetch(); }} />
    <details className="memory-overview-disclosure"><summary><ShieldCheck size={18} aria-hidden /><span><strong>Memory diagnostics</strong><small>Readiness, retrieval, and evidence coverage</small></span><ChevronRight size={17} aria-hidden /></summary><div className="space-y-4"><MemoryAssurancePanel report={readiness.data} loading={readiness.isLoading} /><RecallHealthStrip health={memHealth.data} /><GraphTruthCoverage health={memHealth.data} readiness={readiness.data} /></div></details>
  </div>;
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
  const qc = useQueryClient();
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
  const repairCount = identityBlockers + unreconciledEvidence;

  const repairIdentity = async () => {
    if (!window.confirm(`Back up memory and safely converge ${identityBlockers.toLocaleString()} exact-email identity group${identityBlockers === 1 ? '' : 's'} now? Shared inboxes and name-only matches will remain review-only.`)) return;
    setRepairing('identity');
    setMessage('');
    try {
      const report = await reconcileMemoryRelationships();
      setMessage(`${report.identities.entitiesRedirected} duplicate identities redirected · ${report.groundedFactEntityLinks.promoted + report.groundedFactResourceLinks.promoted} evidence-backed graph links promoted.`);
      await qc.invalidateQueries({ queryKey: ['mem-review'] });
      await qc.invalidateQueries({ queryKey: ['mem-dups'] });
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

  // Hand decisions already have a queue. This section only appears for the
  // counts that queue does not decide, and for the backup-first repairs.
  const items: Array<{ key: string; icon: typeof Users; label: string; count: number; detail: string; action: string; tab: Tab; tone: 'neutral' | 'warning' }> = [];
  if (pendingClaims > 0) items.push({
    key: 'claims', icon: History, label: 'Learned claims', count: pendingClaims,
    detail: overdueClaims > 0
      ? `${overdueClaims} overdue. Replay stays bounded.`
      : ledgerPendingClaims === 0 && bufferedExtractions > 0
        ? `${bufferedExtractions} legacy buffers enter the decision ledger on daemon start.`
        : `${ledgerPendingObservations.toLocaleString()} source observation${ledgerPendingObservations === 1 ? '' : 's'} collapse to ${ledgerPendingClaims.toLocaleString()} unique claim${ledgerPendingClaims === 1 ? '' : 's'}${knownExactPending > 0 ? `. ${knownExactPending} already-known will auto-attach` : ''}.`,
    action: 'Inspect learning', tab: 'episodes', tone: overdueClaims > 0 ? 'warning' : 'neutral',
  });
  if (promptOnly > 0) items.push({ key: 'prompt', icon: ShieldCheck, label: 'Prompt-only instructions', count: promptOnly, detail: 'Legacy constraint-shaped facts are not enforced.', action: 'Review policies', tab: 'facts', tone: 'warning' });
  if (items.length === 0 && repairCount === 0 && unavailableEvidence === 0 && !message) return null;

  return (
    <section aria-labelledby="memory-upkeep-h" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="memory-upkeep-h" className="text-body font-semibold text-fg">Upkeep</h3>
        {/* "Needs you" means exactly one thing in this product: a person is
            blocking work, and it lives in the Inbox. What this section owns is
            the upkeep ReviewPane cannot do — identity convergence and evidence
            reconciliation — plus counts that are not hand decisions. */}
        {repairCount > 0 && (
          <p className="text-small text-muted">Hand decisions are in the queue above. These repairs back memory up first.</p>
        )}
      </div>
      {unavailableEvidence > 0 && (
        <p className="text-caption text-muted">
          <span className="font-medium text-fg">Known historical limit.</span> {unavailableEvidence.toLocaleString()} pre-upgrade evidence links are honestly unavailable and are never presented as source-backed.
        </p>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {items.map(({ key, tab, ...item }) => <ReviewQueueItem key={key} {...item} onAction={() => onNavigate(tab)} />)}
        </ul>
      )}
      {(identityBlockers > 0 || unreconciledEvidence > 0) && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3 text-small">
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
      {message && <p className="text-caption text-muted">{message}</p>}
    </section>
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
  count: number;
  detail: string;
  action: string;
  onAction: () => void;
  tone?: 'neutral' | 'warning';
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <Icon className={cn('h-4 w-4 shrink-0', tone === 'warning' ? 'text-warning' : 'text-primary')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-small font-medium text-fg">{label} <span className="tabular-nums text-muted">{count.toLocaleString()}</span></div>
        <p className="text-caption text-muted">{detail}</p>
      </div>
      <button type="button" onClick={onAction} className="cursor-pointer text-small font-semibold text-primary hover:underline">{action}</button>
    </li>
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
// Surfaces the signal that was illegible before: when embeddings are off (the
// local model did not load) or circuit-broken, semantic recall silently
// degrades to lexical match.
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
    ? 'Semantic recall OFF — the local embedding model is not loaded; using lexical match only'
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

// ─────────── Facts ───────────
/**
 * What a memory store says when it could not be read.
 *
 * Every tab here used to go `isLoading ? skeleton : rows.length === 0 ?
 * <EmptyState>` — so a failed call fell straight through to the empty state and
 * the screen asserted a fact about Clementine's memory that nothing had
 * established. On the Facts tab that read "Still getting to know you": Clem
 * telling the owner she had learned nothing about him, when the truth was that
 * she could not be asked. Unknown is not empty, and nowhere is that worse than
 * on the memory screen.
 */
function CouldNotRead({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Card className="p-4 text-body text-muted" role="status">
      {what} couldn’t be read just now — nothing has been lost or forgotten.{' '}
      <button type="button" onClick={onRetry} className="cursor-pointer font-medium text-primary hover:underline">Try again</button>
    </Card>
  );
}

function FactsTab({ initialScope = 'all', initialAddOpen = false, onPick, onChanged }: { initialScope?: string; initialAddOpen?: boolean; onPick: (fact: Fact, correct?: boolean) => void; onChanged: () => void }) {
  const [kind, setKind] = useState<Fact['kind'] | 'all'>('all');
  const [showForgotten, setShowForgotten] = useState(false);
  // Where the facts shown apply: everything, everywhere only, one project or one agent.
  const [scopeKey, setScopeKey] = useState(initialScope);
  const scopeFilter = factScopeFromKey(scopeKey);
  const facts = usePoll(['facts', kind, showForgotten, scopeKey], () => listFacts(kind === 'all' ? undefined : kind, 120, showForgotten, scopeFilter), 15000);
  const reviews = usePoll(['memory-review-candidates'], () => listMemoryReviewCandidates(25), 30000);
  const learning = usePoll(['reflection-candidates'], () => listReflectionCandidates(40), 30000);
  const projects = usePoll(projectKeys.list(true), () => listProjects(true), 60000);
  const agents = usePoll(['agents'], listAgents, 60000);
  // A narrowed list shows only facts that say they belong there.
  const scoped = scopedFacts(facts.data?.facts ?? [], scopeFilter);
  const rows = scoped.facts;
  const scopeChoices = factScopeChoices(projects.data ?? [], agents.data ?? []);
  // The scope in force always has a row, even when its project is archived
  // out of the list or the rosters could not be read.
  if (!scopeChoices.some((choice) => choice.key === scopeKey)) {
    const named = rows.find((fact) => fact.scope && fact.scope.kind !== 'user')?.scope;
    scopeChoices.push({
      group: scopeFilter.kind === 'agent' ? 'agents' : 'projects',
      key: scopeKey,
      label: (scopeFilter.kind === 'agent' ? named?.agentName : named?.projectName) || (scopeFilter.kind === 'agent' ? 'This agent' : 'This project'),
    });
  }
  const scopeLabel = scopeChoices.find((choice) => choice.key === scopeKey)?.label ?? 'All facts';
  const showScopeFilter = scopeKey !== 'all' || scopeChoices.length > 2;
  const onMoveEverywhere = async (id: Fact['id']) => {
    try {
      await moveFactScope(id, { projectId: null, agentId: null });
    } catch (error) {
      // Already everywhere is what was asked for; anything else is said in words.
      if (apiErrorCode(error) !== 'ALREADY_KEPT_THERE') throw new Error(refusalText(error, 'It could not be moved just now. Try again.'));
    } finally {
      onChanged();
    }
  };
  const [resolvingReview, setResolvingReview] = useState('');
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<Fact['kind']>('user');
  const [addResult, setAddResult] = useState('');
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(initialAddOpen);
  const add = async () => {
    if (!draft.trim() || adding) return;
    const submitted = draft;
    setAdding(true); setAddError(''); setAddResult('');
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
      setDraft((current) => current === submitted ? '' : current);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'This memory could not be saved. Try again.');
    } finally {
      setAdding(false); onChanged();
    }
  };
  const onForget = async (id: Fact['id']) => { try { await forgetFact(id); } finally { onChanged(); } };
  const onPin = async (id: Fact['id'], pinned: boolean) => { try { await pinFact(id, pinned); } finally { onChanged(); } };
  const onRestore = async (id: Fact['id']) => { try { await restoreFact(id); } finally { onChanged(); } };
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
      onChanged();
    } finally {
      setResolvingReview('');
    }
  };
  // The classifier already labeled every one of these "likely conversational
  // request" — asking for N individual clicks was the clutter. One sweep,
  // one confirm, still reversible from memory history. Pages through the
  // queue so the sweep covers the whole backlog, not just the visible 25.
  const transientTotal = reviews.data?.byKind.retire_transient_request ?? 0;
  const bulkForgetRequests = async () => {
    if (!window.confirm(`Forget all ${transientTotal} conversational requests currently waiting for review?\n\nOnly items classified as chat requests are touched — possible duplicates stay for individual review. Reversible from memory history.`)) return;
    setResolvingReview('bulk');
    try {
      for (let page = 0; page < 40; page += 1) {
        const batch = await listMemoryReviewCandidates(25);
        const transient = batch.candidates.filter((c) => c.kind === 'retire_transient_request');
        if (transient.length === 0) break;
        for (const candidate of transient) await applyMemoryReviewCandidate(candidate.id);
      }
      await Promise.all([reviews.refetch(), facts.refetch()]);
      onChanged();
    } finally {
      setResolvingReview('');
    }
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([{ key: 'all', label: 'All' }, ...FACT_KINDS] as { key: Fact['kind'] | 'all'; label: string }[]).map((k) => (
          <button key={k.key} type="button" onClick={() => setKind(k.key)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', kind === k.key ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{k.label}</button>
        ))}
        {showScopeFilter && (
          <Select
            value={scopeKey}
            onChange={(e) => setScopeKey(e.target.value)}
            aria-label="Show facts that apply to"
            title="Where the facts shown apply"
            className={cn('h-8 w-auto max-w-56 rounded-full py-0 pl-3 pr-8 text-small', scopeKey !== 'all' && 'border-primary bg-primary-tint text-primary')}
          >
            {scopeChoices.filter((choice) => choice.group === 'general').map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
            {scopeChoices.some((choice) => choice.group === 'projects') && (
              <optgroup label="A project">
                {scopeChoices.filter((choice) => choice.group === 'projects').map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
              </optgroup>
            )}
            {scopeChoices.some((choice) => choice.group === 'agents') && (
              <optgroup label="An agent">
                {scopeChoices.filter((choice) => choice.group === 'agents').map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
              </optgroup>
            )}
          </Select>
        )}
        <button type="button" onClick={() => setShowForgotten((value) => !value)}
          className={cn('ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', showForgotten ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>
          <History className="h-3.5 w-3.5" aria-hidden /> {showForgotten ? 'Showing history' : 'Show history'}
        </button>
        {facts.data && scoped.supported && <span className="basis-full text-caption text-faint sm:ml-auto sm:basis-auto">
          Showing {rows.length} of {facts.data.total} {showForgotten ? 'current and historical' : 'current'} facts{scopeKey === 'all' ? '' : scopeKey === 'everywhere' ? ' that apply everywhere' : ` kept for ${scopeLabel}`}{rows.length < facts.data.total ? ' · use memory search for the full archive' : ''}
        </span>}
      </div>
      <details className="memory-add-fact" open={addOpen} onToggle={(event) => setAddOpen(event.currentTarget.open)}>
        <summary>Add a memory</summary>
        <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <p className="basis-full text-small text-muted">Applies everywhere · Tell Clem something to remember across your conversations.</p>
          <Input autoFocus={initialAddOpen} value={draft} onChange={(e) => { setDraft(e.target.value); setAddResult(''); setAddError(''); }} placeholder="What would you like Clem to remember?" aria-label="New fact" className="min-w-0 basis-full" />
          <Select value={draftKind} onChange={(e) => setDraftKind(e.target.value as Fact['kind'])} aria-label="Fact type" className="w-40">{FACT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</Select>
          <Button type="submit" disabled={!draft.trim() || adding}><Plus className="h-4 w-4" aria-hidden /> {adding ? 'Saving…' : 'Remember'}</Button>
          {addResult && <p role="status" className="basis-full text-small text-muted"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-success" aria-hidden />{addResult}</p>}
          {addError && <p role="alert" className="basis-full text-small text-danger">{addError}</p>}
        </form>
      </details>
      {facts.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        : facts.isError && !facts.data ? <CouldNotRead what="Your facts" onRetry={() => { void facts.refetch(); }} />
        : !scoped.supported ? (
          // Asked for one scope and answered with facts that do not say where
          // they apply: none of them can be claimed for it.
          <Card className="p-4 text-body text-muted" role="status">
            This version of Clementine’s service does not yet keep memory by project or agent, so this view cannot be shown. Nothing has been lost.{' '}
            <button type="button" onClick={() => setScopeKey('all')} className="cursor-pointer font-medium text-primary hover:underline">Show all facts</button>
          </Card>
        )
        : rows.length === 0 ? (scopeKey === 'all'
          ? <Card><EmptyState title="Still getting to know you" description="As we work together, the important things land here — and you can edit or forget anything." /></Card>
          : <Card><EmptyState title={scopeKey === 'everywhere' ? 'Nothing here applies everywhere yet' : `Nothing is kept for ${scopeLabel} yet`} description="What is learned there lands here, with where it came from." action={<Button variant="secondary" size="sm" onClick={() => setScopeKey('all')}>Show all facts</Button>} /></Card>)
          : <div className="space-y-2">{rows.map((f) => <FactCard key={f.id} fact={f} onInspect={(correct) => onPick(f, correct)} onMoveEverywhere={canMoveToEverywhere(f) ? () => onMoveEverywhere(f.id) : undefined} onPin={() => onPin(f.id, !f.pinned)} onForget={() => onForget(f.id)} onRestore={() => onRestore(f.id)} onImportance={(value) => updateFact(f.id, { importance: value }).finally(onChanged)} />)}</div>}
      {(reviews.data?.candidates.length ?? 0) > 0 && <Card className="mt-4 border-warning/40 bg-warning/5 p-4">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <div className="text-body font-medium text-fg">Memory review</div>
          {(reviews.data?.byKind.merge_duplicate ?? 0) > 0 && <StatusPill tone="warning">{reviews.data?.byKind.merge_duplicate} possible duplicate{reviews.data?.byKind.merge_duplicate === 1 ? '' : 's'}</StatusPill>}
          {transientTotal > 0 && <StatusPill tone="neutral">{transientTotal} chat request{transientTotal === 1 ? '' : 's'}</StatusPill>}
          {transientTotal > 1 && (
            <Button size="sm" variant="secondary" className="ml-auto" disabled={Boolean(resolvingReview)} onClick={() => void bulkForgetRequests()}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> {resolvingReview === 'bulk' ? 'Sweeping…' : `Forget all ${transientTotal} chat requests`}
            </Button>
          )}
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
              {/* Keep leads; Forget is quiet — the destructive action should
                  never be the loudest thing on the row. */}
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'dismiss')}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Keep as fact</Button>
                <Button size="sm" variant="ghost" className="text-danger" disabled={Boolean(resolvingReview)} onClick={() => void resolveReview(candidate, 'apply')}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Forget</Button>
              </div>
            </div>;
          })}
        </div>
        {(reviews.data?.total ?? 0) > 8 && <p className="mt-2 text-caption text-faint">Showing 8 of {reviews.data?.total} candidates. Duplicate and request reviews are interleaved so neither queue can hide the other.</p>}
      </Card>}
      {(learning.data?.health.total ?? 0) > 0 && <Card className="mt-4 p-4">
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
    </>
  );
}

function FactCard({ fact, onPin, onForget, onRestore, onImportance, onMoveEverywhere, onInspect }: {
  fact: Fact; onInspect: (correct?: boolean) => void; onPin: () => Promise<void>; onForget: () => Promise<void>; onRestore: () => Promise<void>;
  onImportance?: (value: number) => Promise<unknown>; onMoveEverywhere?: () => Promise<void>;
}) {
  const [moving, setMoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (fact.active === false) setMoving(false); }, [fact.active]);
  const usableEvidence = (fact.evidence ?? []).filter((item) =>
    (item.status === 'available' || item.status === 'partial' || item.status === undefined) && item.excerpt.trim().length > 0);
  const unavailableEvidence = (fact.evidence?.length ?? 0) - usableEvidence.length;
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'This change could not be saved. Try again.'); }
    finally { setBusy(false); }
  };
  return <Card className="memory-fact-card">
    <div className="memory-fact-meta">
      {fact.pinned && <Pin className="h-3.5 w-3.5 text-primary" aria-label="Pinned" />}
      <span>{KIND_LABEL[fact.kind] ?? fact.kind}</span>
      {fact.scope && <ScopeChip scope={fact.scope} />}
      {fact.active === false && <StatusPill tone="warning">Historical{fact.supersededByFactId != null ? ` · continued as #${fact.supersededByFactId}` : ''}</StatusPill>}
    </div>
    <button type="button" className="memory-fact-text" onClick={() => onInspect()}><span className="line-clamp-3">{fact.content}</span></button>
    <div className="memory-fact-footer">
      <button type="button" onClick={() => onInspect()}>Inspect & ask <ArrowRight size={14} aria-hidden /></button>
      <span className="text-caption text-muted">{usableEvidence.length} source excerpt{usableEvidence.length === 1 ? '' : 's'}{unavailableEvidence > 0 ? ` · ${unavailableEvidence} unavailable` : ''}</span>
    </div>
    <details className="memory-fact-more">
      <summary>History & actions</summary>
      <p className="text-small">{fact.derivedFrom?.tool ? `Learned from ${fact.derivedFrom.tool}` : fact.derivedFrom?.callId ? 'Learned from a tool result' : 'Learning origin not recorded'} · {typeof fact.confidence === 'number' ? `${Math.round(fact.confidence * 100)}% recorded confidence` : 'Confidence not recorded'}</p>
      <p className="mt-1 text-caption">Used {fact.utilityCount ?? 0} times · shown {fact.impressionCount ?? 0} times{typeof fact.importance === 'number' ? ` · importance ${fact.importance}/10` : ''}</p>
      {fact.policy && <p className="mt-2 text-small">{fact.policy.policy_type.replace(/_/g, ' ')} · {fact.policy.enforcement === 'dispatch' ? 'enforced at dispatch' : 'included in the prompt'}</p>}
      {fact.pinned && <p className="mt-2 text-small text-primary">Pinned memories stay in Clem’s context.</p>}
      {fact.active !== false && moving && onMoveEverywhere && <div className="mt-3 space-y-2 rounded-md bg-subtle p-3" role="group" aria-label="Confirm using this fact everywhere">
        <p className="text-small">Use this everywhere? It is kept for {memoryScopeLabel(fact.scope)} now; after this it applies in every conversation.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void perform(async () => { await onMoveEverywhere(); setMoving(false); })}>Use everywhere</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoving(false)}>Cancel</Button></div>
      </div>}
      <div className="memory-fact-actions">
        {fact.active === false ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void perform(onRestore)}><Undo2 size={14} aria-hidden /> Restore</Button> : <>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onInspect(true)}><Pencil size={14} aria-hidden /> Correct</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(onPin)}><Pin size={14} aria-hidden /> {fact.pinned ? 'Unpin' : 'Pin'}</Button>
          {onMoveEverywhere && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoving(!moving)}><Globe size={14} aria-hidden /> Use everywhere</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(onForget)}><Trash2 size={14} aria-hidden /> Forget</Button>
          {typeof fact.importance === 'number' && onImportance && <span className="inline-flex items-center gap-1" title="Importance affects how strongly this memory competes for recall">
            <Button size="sm" variant="ghost" disabled={busy || fact.importance >= 10} onClick={() => void perform(() => onImportance(Math.min(10, (fact.importance ?? 5) + 1)))}>Raise importance</Button>
            <Button size="sm" variant="ghost" disabled={busy || fact.importance <= 0} onClick={() => void perform(() => onImportance(Math.max(0, (fact.importance ?? 5) - 1)))}>Lower</Button>
          </span>}
        </>}
      </div>
      {error && <p role="alert" className="mt-2 text-small text-danger">{error}</p>}
      {(fact.evidence?.length ?? 0) > 0 && <details className="mt-3"><summary className="cursor-pointer">Source excerpts ({fact.evidence?.length})</summary><div className="mt-2 space-y-2">{fact.evidence?.map((item) => <div key={`${item.episodeId}:${item.excerpt}`} className="rounded bg-subtle p-3"><p>{item.excerpt || 'Supporting excerpt unavailable — the source expired before durable capture.'}</p><p className="mt-1 text-caption">{item.status ?? 'status not recorded'}{item.sourceUri ? ` · ${item.sourceUri}` : ''}</p></div>)}</div></details>}
      {(fact.validityIntervals?.length ?? 0) > 1 && <details className="mt-3"><summary className="cursor-pointer">Validity history ({fact.validityIntervals?.length} periods)</summary><div className="mt-2 space-y-2">{fact.validityIntervals?.map((interval) => <div key={interval.id} className="rounded bg-subtle p-3"><p>{new Date(interval.validFrom).toLocaleString()} → {interval.validTo ? new Date(interval.validTo).toLocaleString() : 'current'}</p><p className="mt-1 text-caption">{interval.openedReason}{interval.closedReason ? ` · ${interval.closedReason}` : ''}</p></div>)}</div></details>}
    </details>
  </Card>;
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
            {pendingObservations !== pendingUniqueClaims && <div className="mt-1 text-caption leading-tight text-faint">{pendingObservations.toLocaleString()} source observations</div>}
            {pendingBreakdown && <div className="mt-1 text-caption leading-tight text-faint">{pendingBreakdown}</div>}
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
        : episodes.isError && !episodes.data ? <CouldNotRead what="The source timeline" onRetry={() => { void episodes.refetch(); }} />
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
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {ENTITY_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', type === t ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{ENTITY_PLURAL[t] ?? t}</button>
        ))}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all identities…" aria-label="Search all identities" className="ml-auto w-56" />
      </div>
      {entities.isLoading ? <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        : entities.isError && !entities.data ? <CouldNotRead what="People and things" onRetry={() => { void entities.refetch(); }} />
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
function SourcesTab({ qc, onNavigate }: { qc: ReturnType<typeof useQueryClient>; onNavigate?: (tab: Tab) => void }) {
  const ctx = usePoll(['context'], getContext, 30000);
  const files = usePoll(['memory-files'], getMemoryFiles, 30000);
  const sources = usePoll(['source-map'], getSourceMap, 30000);
  const coreFiles = ctx.data?.files ?? [];
  const vault = files.data?.files ?? [];
  const pointers = sources.data?.pointers ?? [];
  const profile = ctx.data?.profile ?? {};
  const goals = ctx.data?.goals ?? [];
  const [goalTitle, setGoalTitle] = useState('');
  const [goalDesc, setGoalDesc] = useState('');
  const addContextGoal = async () => {
    if (!goalTitle.trim() || !goalDesc.trim()) return;
    try { await addGoal(goalTitle.trim(), goalDesc.trim()); setGoalTitle(''); setGoalDesc(''); }
    finally { void qc.invalidateQueries({ queryKey: ['context'] }); }
  };
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg"><BookOpen className="h-5 w-5 text-primary" aria-hidden /> Core context</h3>
        <p className="mb-3 text-small text-muted">The notes Clementine reads on every turn — her personality, who you are, and what to keep in mind. This is the seeded memory you can shape.</p>
        <IdentityProposalReview qc={qc} />
        {ctx.isLoading ? <Skeleton className="h-32 w-full" /> : <div className="space-y-2">{coreFiles.map((f) => <ContextFileCard key={f.key} file={f} onNavigate={onNavigate} />)}</div>}
        {/* Profile + standing goals ARE core context — they used to be their own
            "You & goals" tab, but they read on every turn like the files above. */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
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
            <div className="mb-3 flex items-center gap-2"><Target className="h-5 w-5 text-primary" aria-hidden /><h3 className="text-h3 text-fg">Standing goals</h3></div>
            {ctx.isLoading ? <Skeleton className="h-24 w-full" />
              : ctx.isError && !ctx.data ? <p className="text-body text-muted">Core context couldn’t be read just now — nothing has been lost.</p>
              : goals.length === 0 ? <p className="text-body text-muted">No standing goals yet. Tell Clementine what you're working toward.</p>
              : <ul className="space-y-2.5">{goals.map((g, i) => (
                  <li key={g.id || i} className="flex items-start gap-2.5"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden /><div><div className="text-body font-medium text-fg">{g.title || g.objective || 'Goal'}</div>{g.description && <div className="text-small text-muted">{g.description}</div>}</div></li>
                ))}</ul>}
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              <Input value={goalTitle} onChange={(e) => setGoalTitle(e.target.value)} placeholder="New goal (e.g. Grow SEO pipeline)" aria-label="Goal title" />
              <div className="flex gap-2">
                <Input value={goalDesc} onChange={(e) => setGoalDesc(e.target.value)} placeholder="What does success look like?" aria-label="Goal description" className="flex-1" />
                <Button size="sm" onClick={addContextGoal} disabled={!goalTitle.trim() || !goalDesc.trim()}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
              </div>
              {/* These are core-context notes (/api/console/context/goals), read
                  on every turn — a different store from the tracked Goals screen
                  (/api/console/goals). Both are called "goals", so say which is
                  which rather than leaving the owner to discover it. */}
              <p className="text-caption text-faint">Standing goals are context Clementine reads every turn. For goals you want tracked to completion, use <Link to="/goals" className="text-primary hover:underline">Goals</Link>.</p>
            </div>
          </Card>
        </div>
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

      {/* Import is an action on Sources, not a top-level destination. */}
      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="flex cursor-pointer items-center gap-2 text-h3 text-fg"><Download className="h-5 w-5 text-primary" aria-hidden /> Import another agent's memory</summary>
        <div className="mt-4"><ImportTab qc={qc} /></div>
      </details>
    </div>
  );
}

/** Pending curated-identity update drafted from learned facts. Renders
 *  nothing when the queue is empty (the common case), so the Core
 *  context section stays byte-identical for users with no proposal. */
function IdentityProposalReview({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const proposals = usePoll(['identity-proposals'], listIdentityProposals, 60000);
  const [resolving, setResolving] = useState('');
  const pending = (proposals.data?.proposals ?? []).filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;
  const resolve = async (proposal: IdentityProposal, action: 'approve' | 'reject') => {
    setResolving(proposal.id);
    try {
      if (action === 'approve') await approveIdentityProposal(proposal.id);
      else await rejectIdentityProposal(proposal.id);
    } finally {
      setResolving('');
      void proposals.refetch();
      void qc.invalidateQueries({ queryKey: ['context'] });
    }
  };
  return (
    <div className="mb-3 space-y-2">
      {pending.map((p) => (
        <Card key={p.id} className="border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="flex-1 text-body font-medium text-fg">
              Suggested update to {p.target === 'identity' ? 'Identity' : 'Personality'}
            </span>
            <StatusPill tone="neutral">from learned facts</StatusPill>
          </div>
          <p className="mt-1.5 text-small text-muted">{p.rationale}</p>
          <details className="mt-2 text-small">
            <summary className="cursor-pointer text-primary">Compare current and proposed</summary>
            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <div className="rounded bg-subtle p-3"><div className="mb-1 text-caption font-medium text-faint">Current</div><pre className="whitespace-pre-wrap font-sans text-small text-muted">{p.currentText}</pre></div>
              <div className="rounded bg-subtle p-3"><div className="mb-1 text-caption font-medium text-faint">Proposed</div><pre className="whitespace-pre-wrap font-sans text-small text-fg">{p.proposedText}</pre></div>
            </div>
          </details>
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={Boolean(resolving)} onClick={() => void resolve(p, 'approve')}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {resolving === p.id ? 'Applying…' : 'Approve'}
            </Button>
            <Button size="sm" variant="secondary" disabled={Boolean(resolving)} onClick={() => void resolve(p, 'reject')}>
              <XCircle className="h-3.5 w-3.5" aria-hidden /> Dismiss
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ContextFileCard({ file, onNavigate }: { file: ContextFile; onNavigate?: (tab: Tab) => void }) {
  const [open, setOpen] = useState(false);
  const isMemory = file.key === 'memory';
  const isWorking = file.key === 'working_memory';
  const factCount = file.learnedFactCount ?? 0;
  // Working memory fills in as you chat, so an empty state there is normal, not
  // broken — say so instead of a bare "Empty".
  const emptyPill = isWorking ? 'No live session yet' : 'Empty';
  const emptyBody = isWorking
    ? 'No working memory for the current session yet — this fills in as you chat.'
    : '(empty)';
  return (
    <Card className="p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 text-left cursor-pointer">
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-fg">{file.title}</div>
          {file.description && <div className="text-caption text-muted">{file.description}</div>}
          {isWorking && file.sessionLabel && !file.empty && (
            <div className="mt-0.5 text-caption text-faint">Session: {file.sessionLabel}</div>
          )}
        </div>
        <StatusPill tone={file.empty ? 'neutral' : 'success'}>{file.empty ? emptyPill : `${file.bytes ?? 0} bytes`}</StatusPill>
      </button>
      {open && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-3 text-small text-muted">{file.content?.trim() || emptyBody}</pre>}
      {isMemory && (
        // The generated fact projection is no longer dumped into this editor —
        // it lives in the Facts tab (canonical, typed store). Link there.
        <button type="button" onClick={() => onNavigate?.('facts')}
          className="mt-3 inline-flex items-center gap-1 text-small font-medium text-primary hover:underline cursor-pointer">
          View {factCount} learned {factCount === 1 ? 'fact' : 'facts'} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </Card>
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
          <div className="mb-2 text-body-lg font-semibold text-fg">Found on this computer</div>
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
