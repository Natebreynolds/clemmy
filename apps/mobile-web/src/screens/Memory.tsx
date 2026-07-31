import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { listFacts, searchMemory, type MemoryFact, type MemoryHit } from '../lib/api';
import { humanizeReasons } from '../lib/memory-reasons';

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

export function Memory() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [factsLoading, setFactsLoading] = useState(true);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<FactKindFilter>('all');

  const refreshFacts = useCallback(async () => {
    setFactsLoading(true);
    try {
      const result = await listFacts(kindFilter === 'all' ? undefined : kindFilter, 60);
      setFacts(result.facts);
      setFactsError(null);
    } catch (err) {
      setFactsError((err as Error).message ?? 'Failed to load facts');
    } finally {
      setFactsLoading(false);
    }
  }, [kindFilter]);

  useEffect(() => { refreshFacts(); }, [refreshFacts]);

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
        />
      ) : (
        <Browse
          facts={facts}
          loading={factsLoading}
          error={factsError}
          pinnedCount={pinnedCount}
          kindFilter={kindFilter}
          onKind={setKindFilter}
        />
      )}
    </div>
  );
}

function SearchResults(props: {
  hits: MemoryHit[];
  searching: boolean;
  error: string | null;
  onClear: () => void;
}) {
  const { hits, searching, error, onClear } = props;

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
      {hits.map((hit) => (
        <div key={`${hit.path}-${hit.score}`} class="memory-hit">
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
        </div>
      ))}
    </div>
  );
}

function Browse(props: {
  facts: MemoryFact[];
  loading: boolean;
  error: string | null;
  pinnedCount: number;
  kindFilter: FactKindFilter;
  onKind: (kind: FactKindFilter) => void;
}) {
  const { facts, loading, error, pinnedCount, kindFilter, onKind } = props;

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
      {!loading && !error && facts.length > 0 ? (
        <div class="memory-overview">
          {facts.length} {facts.length === 1 ? 'memory' : 'memories'}
          {pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
        </div>
      ) : null}

      {loading ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}
      {!loading && error ? <p class="error">{error}</p> : null}
      {!loading && !error && facts.length === 0 ? (
        <div class="empty">
          <p class="empty-title">Nothing here yet</p>
          <p class="empty-body">What Clem learns about this lands here automatically.</p>
        </div>
      ) : null}

      {facts.map((fact) => (
        <div key={fact.id} class={`memory-fact memory-fact-${fact.kind}`}>
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
        </div>
      ))}
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
