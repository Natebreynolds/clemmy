/**
 * Memory on the phone — no longer a read-only list.
 *
 * Three surfaces, same canonical data the desktop uses:
 *  - SEARCH (top, unchanged): unified recall with "why recalled" chips.
 *  - MEMORIES: browsable facts; every card opens a full detail view with
 *    evidence and validity history, and the actions that matter — pin,
 *    correct, forget/restore. Corrections SUPERSEDE (the daemon preserves
 *    the history chain); nothing here can hard-delete.
 *  - PEOPLE: who Clem knows — entities ranked by grounded facts, each with
 *    a full dossier (claims, relationships, aliases).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addFact,
  correctFact,
  forgetFact,
  getEntityDetail,
  getFactDetail,
  listEntities,
  listFacts,
  pinFact,
  restoreFact,
  searchMemory,
  type MemoryEntity,
  type MemoryFact,
  type MemoryHit,
} from '../lib/api';
import { humanizeReasons } from '../lib/memory-reasons';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';
import { haptic } from '../lib/native-bridge';

type FactKindFilter = 'all' | MemoryFact['kind'];
const KIND_OPTIONS: { value: FactKindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'reference', label: 'Reference' },
];

/** Long enough that typing doesn't fire a request per keystroke, short enough
 *  that results feel like they're keeping up with you. */
const SEARCH_DEBOUNCE_MS = 220;

type MemoryTab = 'facts' | 'people';

export function Memory() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [tab, setTab] = useState<MemoryTab>('facts');
  const [kindFilter, setKindFilter] = useState<FactKindFilter>('all');
  const [openFactId, setOpenFactId] = useState<number | null>(null);
  const [openEntityId, setOpenEntityId] = useState<number | null>(null);

  const loadFacts = useCallback(
    () => listFacts(kindFilter === 'all' ? undefined : kindFilter, 60),
    [kindFilter],
  );
  const {
    data: factsData, loading: factsLoading, error: factsError, offline: factsOffline, refresh: refreshFacts,
  } = useScreenData(loadFacts, { disabled: tab !== 'facts' || openFactId !== null });
  const facts = factsData?.facts ?? [];
  // The hook refreshes on wake/pull; a filter change is its own trigger.
  useEffect(() => { if (tab === 'facts') void refreshFacts(); }, [kindFilter, tab, refreshFacts]);

  const {
    data: entityData, loading: entitiesLoading, error: entitiesError, offline: entitiesOffline, refresh: refreshEntities,
  } = useScreenData(
    () => listEntities({ limit: 100 }),
    { disabled: tab !== 'people' || openEntityId !== null },
  );
  const entities = entityData?.entities ?? [];

  // Search as you type. Every request carries a sequence number and late
  // replies are dropped, because search latency varies with query length —
  // without this, a slow reply for "pla" can land after "platform 49" and
  // overwrite the better results with staler ones.
  const seq = useRef(0);
  const searchQuery = query.trim();
  useEffect(() => {
    if (!searchQuery) {
      seq.current += 1;
      setHits([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await searchMemory(searchQuery, 25);
        if (seq.current !== mine) return;
        setHits(result.hits);
        setSearchError(null);
      } catch (err) {
        if (seq.current !== mine) return;
        setSearchError((err as Error).message ?? 'Search failed');
      } finally {
        if (seq.current === mine) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const pinnedCount = useMemo(() => facts.filter((f) => f.pinned).length, [facts]);

  if (openFactId !== null) {
    return (
      <FactDetailView
        id={openFactId}
        onBack={() => { setOpenFactId(null); void refreshFacts(); }}
        onOpenFact={(id) => setOpenFactId(id)}
      />
    );
  }
  if (openEntityId !== null) {
    return (
      <EntityDetailView
        id={openEntityId}
        onBack={() => { setOpenEntityId(null); void refreshEntities(); }}
        onOpenFact={(id) => { setOpenEntityId(null); setOpenFactId(id); }}
      />
    );
  }

  return (
    <div>
      <form class="memory-search" onSubmit={(ev) => ev.preventDefault()}>
        <input
          class="memory-search-input"
          type="search"
          placeholder="Search everything Clem knows…"
          value={query}
          onInput={(ev) => setQuery((ev.currentTarget as HTMLInputElement).value)}
          autoComplete="off"
          enterKeyHint="search"
        />
        {searching ? <span class="memory-search-busy" aria-label="Searching" /> : null}
      </form>

      {searchQuery ? (
        <SearchResults
          hits={hits}
          searching={searching}
          error={searchError}
          onClear={() => setQuery('')}
          onOpenFact={(id) => setOpenFactId(id)}
        />
      ) : (
        <>
          <div class="memory-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'facts'} class={`memory-tab ${tab === 'facts' ? 'active' : ''}`} onClick={() => setTab('facts')}>Memories</button>
            <button role="tab" aria-selected={tab === 'people'} class={`memory-tab ${tab === 'people' ? 'active' : ''}`} onClick={() => setTab('people')}>People</button>
          </div>
          {tab === 'facts' ? (
            <>
              <AddFactComposer onAdded={() => void refreshFacts()} />
              <ScreenNotice error={factsError} offline={factsOffline} onRetry={() => void refreshFacts()} hasData={facts.length > 0} />
              <Browse
                facts={facts}
                loading={factsLoading}
                pinnedCount={pinnedCount}
                kindFilter={kindFilter}
                onKind={setKindFilter}
                onOpen={(id) => setOpenFactId(id)}
              />
            </>
          ) : (
            <>
              <ScreenNotice error={entitiesError} offline={entitiesOffline} onRetry={() => void refreshEntities()} hasData={entities.length > 0} />
              <People entities={entities} loading={entitiesLoading} onOpen={(id) => setOpenEntityId(id)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/** "Remember this" — rides the daemon's dedup-aware consolidation, so adding
 *  a duplicate reinforces instead of double-storing. */
function AddFactComposer({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  async function save() {
    const content = text.trim();
    if (!content || saving) return;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await addFact({ kind: 'user', content });
      haptic('success');
      setText('');
      setOutcome(result.consolidation.action === 'reinforce'
        ? 'Already knew that — reinforced it.'
        : result.consolidation.action === 'supersede'
          ? 'Updated what she knew.'
          : 'Remembered.');
      onAdded();
      setTimeout(() => setOutcome(null), 3500);
    } catch (err) {
      haptic('error');
      setOutcome((err as Error).message ?? 'Couldn’t save that');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form class="memory-add" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
      <input
        class="memory-add-input"
        placeholder="Tell Clem something to remember…"
        value={text}
        onInput={(ev) => setText((ev.currentTarget as HTMLInputElement).value)}
        enterKeyHint="done"
      />
      <button class="memory-add-save" type="submit" disabled={saving || !text.trim()}>
        {saving ? '…' : 'Remember'}
      </button>
      {outcome ? <div class="memory-add-outcome">{outcome}</div> : null}
    </form>
  );
}

function SearchResults(props: {
  hits: MemoryHit[];
  searching: boolean;
  error: string | null;
  onClear: () => void;
  onOpenFact: (id: number) => void;
}) {
  const { hits, searching, error, onClear, onOpenFact } = props;

  if (error) return <div class="global-error">{error}</div>;
  if (hits.length === 0 && searching) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (hits.length === 0) {
    return (
      <div class="empty">
        <p class="empty-title">No matches</p>
        <p class="empty-body">Try a different word, or browse everything.</p>
        <button class="memory-clear" onClick={onClear}>Show all memory</button>
      </div>
    );
  }

  return (
    <div class="memory-section">
      <div class="memory-section-head">
        <span>{hits.length} {hits.length === 1 ? 'match' : 'matches'}</span>
        <button class="memory-clear-inline" onClick={onClear}>Clear</button>
      </div>
      {hits.map((hit) => {
        const factId = hit.ref?.type === 'fact' ? Number(hit.ref.id) : null;
        const Tag = factId ? 'button' as const : 'div' as const;
        return (
          <Tag
            key={`${hit.path}-${hit.score}`}
            class={`memory-hit${factId ? ' memory-hit-tap' : ''}`}
            onClick={factId ? () => onOpenFact(factId) : undefined}
          >
            <div class="memory-hit-head">
              <span class="memory-hit-title">{hit.title || hit.path}</span>
              {hit.ref?.type ? <span class="memory-hit-kind">{hit.ref.type}</span> : null}
            </div>
            <div class="memory-hit-snippet">{hit.snippet}</div>
            {/* The API already explains why something surfaced. Showing it is the
                difference between a list of results and something you can trust:
                you can see whether a match was about meaning or just wording. */}
            {humanizeReasons(hit.whyRecalled).length ? (
              <div class="memory-why">
                {humanizeReasons(hit.whyRecalled).map((reason) => (
                  <span key={reason} class="memory-why-chip">{reason}</span>
                ))}
              </div>
            ) : null}
            {typeof hit.evidenceCount === 'number' && hit.evidenceCount > 0 ? (
              <div class="memory-hit-meta">
                seen {hit.evidenceCount} {hit.evidenceCount === 1 ? 'time' : 'times'}
              </div>
            ) : null}
          </Tag>
        );
      })}
    </div>
  );
}

function Browse(props: {
  facts: MemoryFact[];
  loading: boolean;
  pinnedCount: number;
  kindFilter: FactKindFilter;
  onKind: (kind: FactKindFilter) => void;
  onOpen: (id: number) => void;
}) {
  const { facts, loading, pinnedCount, kindFilter, onKind, onOpen } = props;

  return (
    <div class="memory-section">
      <div class="memory-filter">
        {KIND_OPTIONS.map((option) => (
          <button
            key={option.value}
            class={`memory-filter-chip ${kindFilter === option.value ? 'active' : ''}`}
            onClick={() => onKind(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* A plain count of what is actually loaded. Deliberately not a total:
          claiming a number the list doesn't contain invites the "where are the
          rest?" question this screen exists to avoid. */}
      {!loading && facts.length > 0 ? (
        <div class="memory-overview">
          {facts.length} {facts.length === 1 ? 'memory' : 'memories'}
          {pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
        </div>
      ) : null}

      {loading && facts.length === 0 ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
      {!loading && facts.length === 0 ? (
        <div class="empty">
          <p class="empty-title">Nothing here yet</p>
          <p class="empty-body">What Clem learns about this lands here automatically.</p>
        </div>
      ) : null}

      {facts.map((fact) => (
        <button key={fact.id} class={`memory-fact memory-fact-tap memory-fact-${fact.kind}`} onClick={() => onOpen(fact.id)}>
          <div class="memory-fact-head">
            <span class={`fact-kind kind-${fact.kind}`}>{fact.kind}</span>
            {fact.pinned ? (
              <span class="fact-pinned" title="pinned standing instruction">📌</span>
            ) : null}
            {typeof fact.importance === 'number' ? (
              <span class="fact-importance" title="importance">★ {fact.importance.toFixed(1)}</span>
            ) : null}
          </div>
          <div class="memory-fact-content">{fact.content}</div>
          <div class="memory-fact-meta">updated {formatDate(fact.updatedAt)}</div>
        </button>
      ))}
    </div>
  );
}

/** Full fact card: everything the desktop shows, plus the actions. */
function FactDetailView({ id, onBack, onOpenFact }: {
  id: number;
  onBack: () => void;
  onOpenFact: (id: number) => void;
}) {
  const { data, loading, error, offline, refresh } = useScreenData(
    () => getFactDetail(id),
  );
  const fact = data?.fact ?? null;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [confirmForget, setConfirmForget] = useState(false);

  async function act(name: string, run: () => Promise<unknown>): Promise<void> {
    if (busyAction) return;
    setBusyAction(name);
    setActionError(null);
    try {
      await run();
      haptic('success');
      await refresh();
    } catch (err) {
      haptic('error');
      setActionError((err as Error).message ?? `Failed to ${name}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">Memory</div>
      </div>
      <div class="workflow-detail-body">
        {loading && !fact ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={Boolean(fact)} />
        {fact ? (
          <>
            <div class="memory-fact-head">
              <span class={`fact-kind kind-${fact.kind}`}>{fact.kind}</span>
              {fact.pinned ? <span class="fact-pinned">📌 pinned</span> : null}
              {fact.active === false ? <span class="fact-historical">historical</span> : null}
              {typeof fact.importance === 'number' ? <span class="fact-importance">★ {fact.importance.toFixed(1)}</span> : null}
            </div>
            {fact.supersededByFactId ? (
              <button class="memory-superseded" onClick={() => onOpenFact(fact.supersededByFactId!)}>
                Continued as #{fact.supersededByFactId} →
              </button>
            ) : null}

            {editing ? (
              <div class="memory-edit">
                <textarea
                  class="chat-input memory-edit-input"
                  rows={4}
                  value={editText}
                  onInput={(ev) => setEditText((ev.currentTarget as HTMLTextAreaElement).value)}
                />
                <div class="memory-actions">
                  <button
                    class="btn"
                    disabled={busyAction !== null || !editText.trim() || editText.trim() === fact.content}
                    onClick={() => void act('correct', async () => {
                      await correctFact(fact.id, { content: editText.trim() });
                      setEditing(false);
                      // The correction creates a NEW fact; jump to it so the
                      // user is looking at what Clem now believes.
                      onBack();
                    })}
                  >
                    {busyAction === 'correct' ? 'Saving…' : 'Save correction'}
                  </button>
                  <button class="btn-quiet" onClick={() => setEditing(false)}>Cancel</button>
                </div>
                <p class="memory-fineprint">Corrections keep history — the old version stays in the validity chain.</p>
              </div>
            ) : (
              <p class="memory-detail-content">{fact.content}</p>
            )}

            {actionError ? <div class="global-error">{actionError}</div> : null}

            {!editing ? (
              <div class="memory-actions">
                <button
                  class="btn-quiet"
                  disabled={busyAction !== null}
                  onClick={() => void act('pin', () => pinFact(fact.id, !fact.pinned))}
                >
                  {busyAction === 'pin' ? '…' : fact.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  class="btn-quiet"
                  disabled={busyAction !== null || fact.active === false}
                  onClick={() => { setEditText(fact.content); setEditing(true); }}
                >
                  Correct
                </button>
                {fact.active === false ? (
                  <button
                    class="btn-quiet"
                    disabled={busyAction !== null}
                    onClick={() => void act('restore', () => restoreFact(fact.id))}
                  >
                    {busyAction === 'restore' ? '…' : 'Restore'}
                  </button>
                ) : confirmForget ? (
                  <>
                    <button
                      class="btn-danger"
                      disabled={busyAction !== null}
                      onClick={() => void act('forget', async () => { await forgetFact(fact.id); onBack(); })}
                    >
                      {busyAction === 'forget' ? '…' : 'Really forget'}
                    </button>
                    <button class="btn-quiet" onClick={() => setConfirmForget(false)}>Keep</button>
                  </>
                ) : (
                  <button class="btn-quiet" disabled={busyAction !== null} onClick={() => setConfirmForget(true)}>
                    Forget
                  </button>
                )}
              </div>
            ) : null}

            <div class="memory-fact-meta">updated {formatDate(fact.updatedAt)}</div>

            {Array.isArray(fact.evidence) && fact.evidence.length > 0 ? (
              <section class="memory-subsection">
                <div class="memory-section-head">Where this came from</div>
                {fact.evidence.slice(0, 8).map((row, i) => (
                  <div key={i} class="memory-evidence">
                    {typeof row.snippet === 'string' && row.snippet ? <div class="memory-evidence-snippet">{row.snippet}</div> : null}
                    <div class="memory-hit-meta">
                      {typeof row.sourceUri === 'string' && row.sourceUri ? row.sourceUri.replace(/^[a-z]+:\/\//, '') : 'observed'}
                      {typeof row.observedAt === 'string' && row.observedAt ? ` · ${formatDate(row.observedAt)}` : ''}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}

            {Array.isArray(fact.validityIntervals) && fact.validityIntervals.length > 1 ? (
              <section class="memory-subsection">
                <div class="memory-section-head">How this changed</div>
                {fact.validityIntervals.slice(0, 6).map((row, i) => (
                  <div key={i} class="memory-evidence">
                    {typeof row.content === 'string' && row.content ? <div class="memory-evidence-snippet">{row.content}</div> : null}
                    <div class="memory-hit-meta">
                      {typeof row.validFrom === 'string' && row.validFrom ? `from ${formatDate(row.validFrom)}` : ''}
                      {typeof row.validTo === 'string' && row.validTo ? ` until ${formatDate(row.validTo)}` : ' — current'}
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function People({ entities, loading, onOpen }: {
  entities: MemoryEntity[];
  loading: boolean;
  onOpen: (id: number) => void;
}) {
  if (loading && entities.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (entities.length === 0) {
    return (
      <div class="empty">
        <p class="empty-title">No one yet</p>
        <p class="empty-body">People, companies and projects Clem learns about show up here.</p>
      </div>
    );
  }
  return (
    <div class="memory-section">
      {entities.map((entity) => (
        <button key={entity.id} class="memory-fact memory-fact-tap" onClick={() => onOpen(entity.id)}>
          <div class="memory-fact-head">
            <span class="fact-kind kind-reference">{entity.entityType}</span>
            <span class="memory-entity-name">{entity.canonicalName}</span>
          </div>
          <div class="memory-fact-meta">
            {entity.groundedFactCount} {entity.groundedFactCount === 1 ? 'fact' : 'facts'}
            {entity.aliases.length > 0 ? ` · also “${entity.aliases[0]}”` : ''}
            {` · seen ${formatDate(entity.lastSeenAt)}`}
          </div>
        </button>
      ))}
    </div>
  );
}

interface EntityDossier {
  entity?: { canonicalName?: string; type?: string; aliases?: Array<{ alias?: string }> };
  claims?: Array<{ factId: number; content: string; active: boolean; validTo: string | null }>;
  relationships?: Array<{ kind?: string; otherName?: string; label?: string; [k: string]: unknown }>;
  stats?: { groundedClaims?: number; currentClaims?: number; relationships?: number; sourceEpisodes?: number };
}

function EntityDetailView({ id, onBack, onOpenFact }: {
  id: number;
  onBack: () => void;
  onOpenFact: (factId: number) => void;
}) {
  const { data, loading, error, offline, refresh } = useScreenData(
    () => getEntityDetail(id) as Promise<EntityDossier>,
  );
  const dossier = data ?? null;
  const claims = dossier?.claims ?? [];
  const current = claims.filter((c) => c.active && !c.validTo);
  const past = claims.filter((c) => !c.active || c.validTo);

  return (
    <div class="workflow-detail">
      <div class="chat-header">
        <button class="chat-back" onClick={onBack} aria-label="Back">←</button>
        <div class="chat-title">{dossier?.entity?.canonicalName ?? 'Person'}</div>
      </div>
      <div class="workflow-detail-body">
        {loading && !dossier ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={Boolean(dossier)} />
        {dossier ? (
          <>
            {dossier.entity?.aliases?.length ? (
              <div class="memory-fact-meta">
                also known as {dossier.entity.aliases.map((a) => a.alias).filter(Boolean).slice(0, 4).join(', ')}
              </div>
            ) : null}
            {dossier.stats ? (
              <div class="memory-overview">
                {dossier.stats.currentClaims ?? 0} current facts
                {typeof dossier.stats.relationships === 'number' && dossier.stats.relationships > 0 ? ` · ${dossier.stats.relationships} relationships` : ''}
              </div>
            ) : null}

            {current.length > 0 ? (
              <section class="memory-subsection">
                <div class="memory-section-head">What Clem knows</div>
                {current.map((claim) => (
                  <button key={claim.factId} class="memory-fact memory-fact-tap" onClick={() => onOpenFact(claim.factId)}>
                    <div class="memory-fact-content">{claim.content}</div>
                  </button>
                ))}
              </section>
            ) : null}
            {past.length > 0 ? (
              <section class="memory-subsection">
                <div class="memory-section-head">No longer current</div>
                {past.slice(0, 6).map((claim) => (
                  <button key={claim.factId} class="memory-fact memory-fact-tap memory-fact-past" onClick={() => onOpenFact(claim.factId)}>
                    <div class="memory-fact-content">{claim.content}</div>
                  </button>
                ))}
              </section>
            ) : null}
            {current.length === 0 && past.length === 0 ? (
              <p class="muted">Mentioned, but nothing recorded yet.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const days = Math.round((Date.now() - t) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}
