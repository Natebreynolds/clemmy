/**
 * In-memory cache of Composio action input schemas, keyed by tool slug.
 *
 * Every surface that fetches real `inputParameters` from Composio
 * (dynamic cx_* tool build, composio_search_tools, composio_list_tools)
 * deposits the schema here. The pre-dispatch validator then prefers the
 * REAL schema over slug-name heuristics — see composio-batch-validator.ts.
 *
 * This closes a self-healing loop: when a heuristic block is wrong, the
 * recovery path the model is told to take (search/list the toolkit to see
 * the action's schema) is the same act that populates this cache, which
 * upgrades the next validation from heuristic guess to schema-grounded
 * fact. The false positive cannot strike twice in a session.
 *
 * Design constraints:
 *   - TTL-bounded (30 min) so a schema change upstream is picked up within
 *     minutes. Safe to keep generous: the cache is validation-only and
 *     fail-open, so a slightly-stale schema can only make a check less precise,
 *     never wrongly block (D3 — fewer re-fetches across a session).
 *   - Size-capped (LRU-ish: oldest insertion evicted) so a long-running
 *     daemon cannot grow unbounded.
 *   - Never authoritative for BLOCKING on its own: consumers must
 *     fail-open when the cached value is missing or malformed. The cache
 *     can only make validation more precise, never more aggressive.
 */

const SCHEMA_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 500;

interface CachedSchema {
  schema: Record<string, unknown>;
  cachedAt: number;
}

const cache = new Map<string, CachedSchema>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Deposit one action's input schema. Ignores non-object schemas. */
export function rememberToolSchema(toolSlug: string, inputParameters: unknown): void {
  if (!toolSlug || !isRecord(inputParameters)) return;
  // Refresh insertion order so hot slugs survive the size cap.
  cache.delete(toolSlug);
  cache.set(toolSlug, { schema: inputParameters, cachedAt: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Convenience: deposit a batch of {slug, inputParameters} items. */
export function rememberToolSchemas(
  items: Array<{ slug?: string; inputParameters?: unknown }>,
): void {
  for (const item of items) {
    if (item?.slug) rememberToolSchema(item.slug, item.inputParameters);
  }
}

/** Fetch a live (non-expired) schema, or null. */
export function getCachedToolSchema(toolSlug: string): Record<string, unknown> | null {
  const hit = cache.get(toolSlug);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > SCHEMA_TTL_MS) {
    cache.delete(toolSlug);
    return null;
  }
  return hit.schema;
}

/** Test hook. */
export function resetToolSchemaCache(): void {
  cache.clear();
}
