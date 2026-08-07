import { createHash } from 'node:crypto';
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

/**
 * Slugs whose live schema we already tried to load this session. Prevents a
 * slug the provider cannot describe from paying a fetch on every dispatch.
 */
const schemaLoadAttempted = new Set<string>();

type SchemaLoader = (slug: string) => Promise<{ inputParameters?: unknown } | null>;
let schemaLoader: SchemaLoader | null = null;

/** Test seam: inject the live loader without importing the composio client. */
export function _setToolSchemaLoaderForTests(loader: SchemaLoader | null): void {
  schemaLoader = loader;
  schemaLoadAttempted.clear();
}

/**
 * Schema-FIRST dispatch: return this action's real input contract, fetching it
 * ONCE per session when it isn't cached yet.
 *
 * Without this, validation for a first-use slug falls back to heuristics, so a
 * missing REQUIRED field reaches the provider and returns as a paid 400 plus a
 * full model turn to recover (live 2026-08-07: APIFY_RUN_ACTOR dispatched twice
 * with no `actorId`). One bounded lookup converts that into a local refusal
 * that names the exact missing field. Fail-open and non-throwing: any loader
 * failure leaves validation exactly as it was.
 */
export async function ensureToolSchema(toolSlug: string): Promise<Record<string, unknown> | null> {
  const cached = getCachedToolSchema(toolSlug);
  if (cached) return cached;
  if (!toolSlug || schemaLoadAttempted.has(toolSlug)) return null;
  schemaLoadAttempted.add(toolSlug);
  try {
    const load = schemaLoader ?? (async (slug: string) => {
      const client = await import('../integrations/composio/client.js');
      // Ask ONLY when an SDK client already exists. Without one, the slug
      // lookup falls back to listing the whole toolkit — a side effect no
      // validation step should cause on a keyless/CLI-only install.
      if (!client.getComposio()) return null;
      return client.getComposioToolBySlug(slug);
    });
    const tool = await load(toolSlug);
    if (tool?.inputParameters) rememberToolSchema(toolSlug, tool.inputParameters);
  } catch { /* fail-open: heuristic validation still applies */ }
  return getCachedToolSchema(toolSlug);
}

/** Test hook. */
export function resetToolSchemaCache(): void {
  cache.clear();
  schemaLoadAttempted.clear();
}

/**
 * The live contract digest for one identifier — sorted-key canonical JSON, so
 * two loads of an identical contract agree and any structural change moves
 * the digest. Undefined when no live schema is known this session: absence of
 * a contract is absence of proof, and consumers treat it accordingly
 * (learning fails closed; retrieval cannot prove a mismatch and serves).
 */
export function liveComposioSchemaFingerprint(toolSlug: string): string | undefined {
  const schema = getCachedToolSchema(toolSlug);
  if (!schema) return undefined;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>).sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  try {
    return createHash('sha256').update(JSON.stringify(canonical(schema)), 'utf-8').digest('hex').slice(0, 32);
  } catch {
    return undefined;
  }
}

/** Test hook: empty the process cache — the daemon-restart / TTL-expiry
 *  shape, under which schema-bound retrieval must decline (fail closed). */
export function _clearToolSchemaCacheForTest(): void {
  cache.clear();
}
