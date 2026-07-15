import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search, Trash2, Pin, Target, User, Network, FileText, BookOpen, Plus, X, Database,
  FileSearch, Users, MapPin, Wrench, CheckCircle2, XCircle, Download, Undo2, FolderSearch, Pencil, History,
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
  discoverImportSources, scanImportPath, runMemoryImport, listImportBatches, undoImportBatch,
  restoreFact, updateFact, reconcileMemoryEvidence,
  type Fact, type ContextFile, type Entity, type ToolRecallRecord, type ImportScan, type ImportBatch, type MemoryHit,
} from '@/lib/memory';

type Tab = 'overview' | 'facts' | 'entities' | 'procedures' | 'sources' | 'you' | 'import';
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
          {tab === 'overview' && <OverviewTab />}
          {tab === 'facts' && <FactsTab qc={qc} />}
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
function OverviewTab() {
  const health = usePoll(['brain-health'], getBrainHealth, 30000);
  const memHealth = usePoll(['memory-health'], getMemoryHealth, 30000);
  const files = usePoll(['memory-files'], getMemoryFiles, 60000);
  const sources = usePoll(['source-map'], getSourceMap, 60000);
  const h = health.data ?? {};
  const stats = [
    { label: 'Facts', value: h.activeFacts, sub: `${h.directFacts ?? 0} told · ${h.derivedFacts ?? 0} learned` },
    { label: 'People & things', value: h.entitiesTotal, sub: `${h.entitiesPerson ?? 0} people · ${h.entitiesCompany ?? 0} orgs` },
    { label: 'Knowledge files', value: files.data?.files?.length, sub: 'indexed & searchable' },
    { label: 'Events', value: h.pointersTotal, sub: `${h.pointersRecent ?? 0} recent` },
    { label: 'Data sources', value: sources.data?.count, sub: 'places data lives' },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <div className="text-h2 text-fg">{typeof s.value === 'number' ? s.value.toLocaleString() : '—'}</div>
            <div className="text-small font-medium text-fg">{s.label}</div>
            <div className="mt-0.5 text-caption text-faint">{s.sub}</div>
          </Card>
        ))}
      </div>
      <RecallHealthStrip health={memHealth.data} onReconciled={() => void memHealth.refetch()} />
      <div>
        <p className="mb-2 text-small text-muted">How everything connects — tap a topic to fold it, drag to explore, tap a node for detail.</p>
        <MemoryGraphContainer height={540} />
      </div>
    </div>
  );
}

// ─────────── Recall / embedding health ───────────
// Surfaces the signal that was illegible before: when embeddings are off (no
// key) or circuit-broken, semantic recall silently degrades to lexical match.
function RecallHealthStrip({ health, onReconciled }: { health?: import('@/lib/memory').MemoryHealth; onReconciled?: () => void }) {
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState('');
  const emb = health?.embeddings;
  const recall = health?.recall;
  const reliability = health?.reliability;
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
  const runReconciliation = async () => {
    const remaining = reliability?.unreconciledEvidence ?? 0;
    if (remaining <= 0 || !window.confirm(`Reconcile ${remaining.toLocaleString()} fact${remaining === 1 ? '' : 's'} now? Clementine will create a database backup first.`)) return;
    setReconciling(true);
    setReconcileMessage('');
    try {
      const report = await reconcileMemoryEvidence();
      setReconcileMessage(`${report.processed.toLocaleString()} classified · ${report.available.toLocaleString()} source-backed · ${report.unavailable.toLocaleString()} unavailable · ${report.remaining.toLocaleString()} remaining`);
      onReconciled?.();
    } catch (err) {
      setReconcileMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setReconciling(false);
    }
  };
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3.5 text-small">
      <span className="flex items-center gap-2 font-medium text-fg">
        <span className={cn('inline-block h-2 w-2 rounded-full', dot)} aria-hidden />
        {label}
      </span>
      {semanticOn && (
        <span className="text-muted">
          Embedded: <span className="font-medium text-fg">{pct(emb.factCoverage)}</span> facts · <span className="font-medium text-fg">{pct(emb.vaultCoverage)}</span> notes
          {emb.model ? <span className="text-faint"> · {emb.model}{emb.dim ? ` (${emb.dim}d)` : ''}</span> : null}
        </span>
      )}
      {recall && (recall.calls ?? 0) > 0 && (
        <span className="text-muted">Recall hit-rate: <span className="font-medium text-fg">{pct(recall.hitRate)}</span> <span className="text-faint">({recall.hits}/{recall.calls})</span></span>
      )}
      {reliability && <div className="basis-full flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        <span>
          Evidence: <span className="font-medium text-fg">{reliability.evidenceAvailable ?? reliability.evidenceLinked ?? 0}</span> usable
          {' · '}<span className={(reliability.evidenceUnavailable ?? 0) > 0 ? 'font-medium text-warning' : 'font-medium text-fg'}>{reliability.evidenceUnavailable ?? 0}</span> honestly unavailable
          {' · '}<span className={(reliability.unreconciledEvidence ?? 0) > 0 ? 'font-medium text-warning' : 'font-medium text-fg'}>{reliability.unreconciledEvidence ?? 0}</span> unreconciled
          {' · '}{reliability.pendingReflections ?? 0} pending extractions · {reliability.unreachableFacts ?? 0} never used
          {' · '}utility {reliability.utility ?? 0} / impressions {reliability.impressions ?? 0}
        </span>
        {(reliability.unreconciledEvidence ?? 0) > 0 && <Button size="sm" variant="secondary" onClick={runReconciliation} disabled={reconciling}>
          <Database className="h-3.5 w-3.5" aria-hidden /> {reconciling ? 'Reconciling…' : 'Back up & reconcile'}
        </Button>}
        {reconcileMessage && <span className="basis-full text-faint">{reconcileMessage}</span>}
        {(reliability.shadow?.samples ?? 0) > 0 && <span className="basis-full text-faint">
          Recall shadow: {reliability.shadow?.samples} samples · {pct(reliability.shadow?.averageOverlap)} legacy overlap
          {' · '}{reliability.shadow?.primaryOnly ?? 0} evidence-path-only hits · {reliability.shadow?.tailHits ?? 0} tail hits
          {' · '}{pct(reliability.shadow?.evidenceRate)} source-backed
        </span>}
      </div>}
    </Card>
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
  const rows = facts.data?.facts ?? [];
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<Fact['kind']>('user');
  const add = async () => { if (!draft.trim()) return; try { await addFact(draft.trim(), draftKind); setDraft(''); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onForget = async (id: Fact['id']) => { try { await forgetFact(id); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onPin = async (id: Fact['id'], pinned: boolean) => { try { await pinFact(id, pinned); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onRestore = async (id: Fact['id']) => { try { await restoreFact(id); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  const onEdit = async (id: Fact['id'], content: string) => { try { await updateFact(id, { content }); } finally { void qc.invalidateQueries({ queryKey: ['facts'] }); } };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([{ key: 'all', label: 'All' }, ...FACT_KINDS] as { key: Fact['kind'] | 'all'; label: string }[]).map((k) => (
          <button key={k.key} type="button" onClick={() => setKind(k.key)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', kind === k.key ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{k.label}</button>
        ))}
        <button type="button" onClick={() => setShowForgotten((value) => !value)}
          className={cn('ml-auto inline-flex items-center gap-1 rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', showForgotten ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>
          <History className="h-3.5 w-3.5" aria-hidden /> {showForgotten ? 'Showing history' : 'Show history'}
        </button>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Tell Clementine something to remember…" aria-label="New fact" className="min-w-48 flex-1" onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <Select value={draftKind} onChange={(e) => setDraftKind(e.target.value as Fact['kind'])} aria-label="Fact type" className="w-40">{FACT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</Select>
        <Button onClick={add} disabled={!draft.trim()}><Plus className="h-4 w-4" aria-hidden /> Remember</Button>
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
  return (
    <Card className="flex items-start gap-3 p-3.5">
      {fact.pinned && <Pin className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap gap-1.5">
          <StatusPill tone="neutral">{KIND_LABEL[fact.kind] ?? fact.kind}</StatusPill>
          {fact.policy && <StatusPill tone={fact.policy.enforcement === 'dispatch' ? 'warning' : 'neutral'}>{fact.policy.policy_type.replace(/_/g, ' ')} · {fact.policy.enforcement}</StatusPill>}
          {fact.active === false && <StatusPill tone="warning">historical</StatusPill>}
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

// ─────────── Entities (people & things) ───────────
const ENTITY_TYPES = ['all', 'person', 'company', 'project', 'place', 'thing'];
const ENTITY_PLURAL: Record<string, string> = { all: 'All', person: 'People', company: 'Companies', project: 'Projects', place: 'Places', thing: 'Things' };
function EntitiesTab() {
  const entities = usePoll(['entities'], () => listEntities(400), 60000);
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const all = entities.data?.entities ?? [];
  const rows = all.filter((e) =>
    (type === 'all' || e.entityType === type) &&
    (!q.trim() || `${e.canonicalName} ${(e.aliases ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {ENTITY_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={cn('rounded-full border px-3 py-1 text-small transition-colors cursor-pointer', type === t ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}>{ENTITY_PLURAL[t] ?? t}</button>
        ))}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter entities" className="ml-auto w-48" />
      </div>
      {entities.isLoading ? <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        : rows.length === 0 ? <Card><EmptyState title="Nothing here yet" description="People, companies, and projects Clementine learns about will appear here." /></Card>
          : <>
              <p className="mb-2 text-small text-muted">{rows.length} of {entities.data?.total ?? rows.length} — everyone and everything Clementine has noticed.</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {rows.slice(0, 150).map((e) => <EntityCard key={e.id} entity={e} />)}
              </div>
            </>}
    </>
  );
}

function EntityCard({ entity }: { entity: Entity }) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{entity.canonicalName}</span>
        <StatusPill tone="neutral">{entity.entityType}</StatusPill>
      </div>
      {entity.aliases && entity.aliases.length > 0 && <p className="mt-1 line-clamp-1 text-caption text-faint">aka {entity.aliases.join(', ')}</p>}
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
