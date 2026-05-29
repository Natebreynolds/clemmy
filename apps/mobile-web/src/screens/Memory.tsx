import { useCallback, useEffect, useState } from 'preact/hooks';
import { listFacts, searchMemory, type MemoryFact, type MemoryHit } from '../lib/api';

type FactKindFilter = 'all' | MemoryFact['kind'];
const KIND_OPTIONS: { value: FactKindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'user', label: 'User' },
  { value: 'project', label: 'Project' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'reference', label: 'Reference' },
];

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

  async function submitSearch(ev: Event) {
    ev.preventDefault();
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const result = await searchMemory(q, 20);
      setHits(result.hits);
    } catch (err) {
      setSearchError((err as Error).message ?? 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <form class="memory-search" onSubmit={submitSearch}>
        <input
          class="memory-search-input"
          type="search"
          placeholder="Search memory…"
          value={query}
          onInput={(ev) => setQuery((ev.currentTarget as HTMLInputElement).value)}
          autoComplete="off"
        />
        <button class="memory-search-go" type="submit" disabled={searching}>
          {searching ? '…' : 'Find'}
        </button>
      </form>
      {searchError ? <div class="global-error">{searchError}</div> : null}
      {hits.length > 0 ? (
        <div class="memory-section">
          <div class="memory-section-head">Results ({hits.length})</div>
          {hits.map((hit) => (
            <div key={`${hit.path}-${hit.score}`} class="memory-hit">
              <div class="memory-hit-head">
                <span class="memory-hit-path">{hit.path}</span>
                <span class="memory-hit-score">{Math.round(hit.score * 100)}</span>
              </div>
              {hit.title ? <div class="memory-hit-title">{hit.title}</div> : null}
              <div class="memory-hit-snippet">{hit.snippet}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div class="memory-section">
        <div class="memory-section-head">
          <span>Facts</span>
          <span class="memory-section-count">{facts.length}</span>
        </div>
        <div class="memory-filter">
          {KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              class={`memory-filter-chip ${kindFilter === option.value ? 'active' : ''}`}
              onClick={() => setKindFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {factsLoading ? <div class="inbox-empty">Loading…</div> : null}
        {!factsLoading && factsError ? <div class="inbox-empty">{factsError}</div> : null}
        {!factsLoading && !factsError && facts.length === 0 ? (
          <div class="inbox-empty">No facts in this category yet.</div>
        ) : null}
        {facts.map((fact) => (
          <div key={fact.id} class={`memory-fact memory-fact-${fact.kind}`}>
            <div class="memory-fact-head">
              <span class={`fact-kind kind-${fact.kind}`}>{fact.kind}</span>
              {typeof fact.importance === 'number' ? (
                <span class="fact-importance" title="importance">★ {fact.importance.toFixed(1)}</span>
              ) : null}
            </div>
            <div class="memory-fact-content">{fact.content}</div>
            <div class="memory-fact-meta">updated {formatDate(fact.updatedAt)}</div>
          </div>
        ))}
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
