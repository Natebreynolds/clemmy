import {
  fingerprintSchema,
  loadToolContract,
  saveToolContract,
  touchToolContract,
  type ToolContract,
} from './tool-contract-store.js';
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
 *   - Validation and executable authority are distinct. Validation may use a
 *     durable contract as a best-effort hint. Autonomous execution requires a
 *     provider observation no older than 30 minutes, and a validation read can
 *     never refresh that observation timestamp.
 *   - Executable authority is TTL-bounded (30 min) so a schema change upstream
 *     is picked up within minutes. A restart preserves only the unused portion
 *     of that same lease; it never mints a new one.
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
  /** When this entry was loaded for validation/cache eviction purposes. */
  cachedAt: number;
  /** Original provider observation. Only this timestamp grants live authority. */
  providerObservedAt?: number;
  /** Exact schema fingerprint bound to that provider observation. */
  providerObservedFingerprint?: string;
}

const cache = new Map<string, CachedSchema>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cachedProviderObservation(entry: CachedSchema | undefined): number | undefined {
  const observedAt = entry?.providerObservedAt;
  if (!entry
    || !Number.isFinite(observedAt)
    || observedAt! < 0
    || observedAt! > Date.now()) return undefined;
  try {
    return fingerprintSchema(entry.schema) === entry.providerObservedFingerprint
      ? observedAt
      : undefined;
  } catch {
    return undefined;
  }
}

function durableProviderObservation(record: ToolContract | null): number | undefined {
  if (!record || record.providerObservedFingerprint !== record.fingerprint) return undefined;
  const observedAt = Date.parse(record.providerObservedAt ?? '');
  return Number.isFinite(observedAt) && observedAt >= 0 && observedAt <= Date.now()
    ? observedAt
    : undefined;
}

/** Deposit one action's input schema. Ignores non-object schemas. */
export function rememberToolSchema(
  toolSlug: string,
  inputParameters: unknown,
  providerObservedAt?: number,
): void {
  if (!toolSlug || !isRecord(inputParameters)) return;
  let schema: Record<string, unknown>;
  try {
    // Provider/SDK objects are caller-owned. Snapshot before caching so a later
    // mutation cannot silently reshape the contract under an existing lease.
    schema = structuredClone(inputParameters);
  } catch {
    return;
  }
  const now = Date.now();
  const observedAt = providerObservedAt;
  const validProviderObservation = Number.isFinite(observedAt)
    && observedAt! >= 0
    && observedAt! <= now;
  const observedFingerprint = fingerprintSchema(schema);
  const currentEntry = cache.get(toolSlug);
  const currentObservation = cachedProviderObservation(currentEntry);
  let equalTimeConflict = false;
  if (currentObservation !== undefined
    && (!validProviderObservation || observedAt! <= currentObservation)) {
    if (validProviderObservation && observedAt === currentObservation) {
      let currentFingerprint: string | undefined;
      try { currentFingerprint = fingerprintSchema(currentEntry?.schema); } catch { /* conflict below */ }
      if (currentFingerprint !== observedFingerprint) equalTimeConflict = true;
      else return;
    } else {
      // Never let an older catalog replay or an unproven validation hint roll
      // back a newer provider observation.
      return;
    }
  }
  // Learn it once, keep it forever: the same deposit that warms this session
  // also survives the restart, so discovery is paid a single time per tool.
  const accepted = saveToolContract({
    identifier: toolSlug,
    schema: equalTimeConflict && currentEntry ? currentEntry.schema : schema,
    ...(equalTimeConflict
      ? { providerAuthorityConflictAt: new Date(observedAt!).toISOString() }
      : validProviderObservation
      ? { providerObservedAt: new Date(observedAt!).toISOString() }
      : {}),
  });

  let acceptedSchema = equalTimeConflict && currentEntry
    ? structuredClone(currentEntry.schema)
    : schema;
  let acceptedObservedAt = validProviderObservation && !equalTimeConflict ? observedAt : undefined;
  let acceptedObservedFingerprint = validProviderObservation && !equalTimeConflict
    ? observedFingerprint
    : undefined;
  if (accepted) {
    acceptedSchema = structuredClone(accepted.schema);
    const durableObservedAt = durableProviderObservation(accepted);
    acceptedObservedAt = durableObservedAt;
    acceptedObservedFingerprint = durableObservedAt !== undefined
      ? accepted.providerObservedFingerprint
      : undefined;
  }

  // Refresh insertion order so hot slugs survive the size cap.
  cache.delete(toolSlug);
  cache.set(toolSlug, {
    schema: acceptedSchema,
    cachedAt: now,
    ...(acceptedObservedAt !== undefined && acceptedObservedFingerprint
      ? {
        providerObservedAt: acceptedObservedAt,
        providerObservedFingerprint: acceptedObservedFingerprint,
      }
      : {}),
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Convenience: deposit a batch of {slug, inputParameters} items. */
export function rememberToolSchemas(
  items: Array<{ slug?: string; inputParameters?: unknown; providerObservedAt?: number }>,
): void {
  for (const item of items) {
    if (item?.slug) rememberToolSchema(item.slug, item.inputParameters, item.providerObservedAt);
  }
}

/** Fetch a validation schema, or null.
 *
 * Falls through to the DURABLE contract store on a miss. Before that, this map
 * died with the process, so a restart re-paid discovery for tools used a
 * hundred times before — and discovery is not a cheap HTTP call at that point,
 * it is a full model round trip mid-run. Measured live: fifteen discovery calls
 * inside a forty-eight-call run that needed about four. Disk is the difference
 * between learning a tool once and learning it every session. */
export function getCachedToolSchema(toolSlug: string): Record<string, unknown> | null {
  const hit = cache.get(toolSlug);
  const hitAge = hit ? Date.now() - hit.cachedAt : Number.NaN;
  if (hit && Number.isFinite(hitAge) && hitAge >= 0 && hitAge <= SCHEMA_TTL_MS) return hit.schema;
  if (hit) cache.delete(toolSlug);
  const durable = loadToolContract(toolSlug);
  if (!durable) return null;
  // A dispatch-path read IS a use — stamp recency for recall ranking and
  // pruning. (Save paths deliberately never touch; a write is not a use.)
  touchToolContract(durable.identifier);
  // Promote back into the validation map so the rest of the session pays
  // nothing. Preserve the provider-observation timestamp separately: a
  // 30-day validation contract must not become 30-minute executable authority
  // merely because this process read it from disk.
  // loadToolContract has already verified the schema fingerprint. Legacy
  // contracts without this explicit field remain validation-only until one
  // exact-slug provider metadata refresh establishes a new authority lease.
  const providerObservedAt = durableProviderObservation(durable);
  const providerObservedFingerprint = providerObservedAt !== undefined
    ? durable.providerObservedFingerprint
    : undefined;
  cache.set(toolSlug, {
    schema: durable.schema,
    cachedAt: Date.now(),
    ...(Number.isFinite(providerObservedAt) && providerObservedFingerprint
      ? { providerObservedAt, providerObservedFingerprint }
      : {}),
  });
  return durable.schema;
}

/**
 * Slugs whose validation schema we already tried to load this session. Prevents a
 * slug the provider cannot describe from paying a fetch on every dispatch.
 */
const schemaLoadAttempted = new Set<string>();
const liveSchemaNegativeUntil = new Map<string, number>();
const LIVE_SCHEMA_NEGATIVE_TTL_MS = 60_000;

export interface LiveSchemaProviderRefresh {
  outcome: 'refreshed' | 'unavailable' | 'failed';
  durationMs: number;
  fingerprint?: string;
}

export type LiveSchemaProviderRefreshObserver = (refresh: LiveSchemaProviderRefresh) => void;

interface ProviderSchemaLoad {
  promise: Promise<LiveSchemaProviderRefresh>;
  /** First warm-session observer wins; one physical request emits one event. */
  observer?: LiveSchemaProviderRefreshObserver;
}

const providerSchemaLoads = new Map<string, ProviderSchemaLoad>();

interface LoadedSchema {
  inputParameters?: unknown;
  providerObservedAt?: number;
}
type SchemaLoader = (slug: string) => Promise<LoadedSchema | null>;
let schemaLoader: SchemaLoader | null = null;

async function loadSchemaFromProvider(toolSlug: string): Promise<LoadedSchema | null> {
  const load = schemaLoader ?? (async (slug: string) => {
    const client = await import('../integrations/composio/client.js');
    // Ask ONLY when an SDK client already exists. Without one, the slug
    // lookup falls back to listing the whole toolkit — a side effect no
    // validation or warm-read admission step should cause on a keyless install.
    if (!client.getComposio()) return null;
    const tool = await client.getComposioToolBySlug(slug);
    return tool
      ? {
        inputParameters: tool.inputParameters,
        providerObservedAt: client.composioToolSchemaObservedAt(tool),
      }
      : null;
  });
  return load(toolSlug);
}

/** One exact-slug metadata lookup per process at a time. Validation and warm
 * authority callers share it, so concurrent accepted turns cannot fan out. */
function refreshSchemaFromProvider(
  toolSlug: string,
  observer?: LiveSchemaProviderRefreshObserver,
): Promise<LiveSchemaProviderRefresh> {
  const existing = providerSchemaLoads.get(toolSlug);
  if (existing) {
    // A validation lookup can start first with no session observer. Let the
    // first warm joiner attach the one accounting event to that physical I/O.
    if (!existing.observer && observer) existing.observer = observer;
    return existing.promise;
  }
  const entry = {} as ProviderSchemaLoad;
  entry.observer = observer;
  const refresh = (async () => {
    const startedAt = Date.now();
    let result: LiveSchemaProviderRefresh;
    try {
      const tool = await loadSchemaFromProvider(toolSlug);
      if (!tool?.inputParameters) {
        result = { outcome: 'unavailable', durationMs: Date.now() - startedAt };
      } else {
        rememberToolSchema(
          toolSlug,
          tool.inputParameters,
          tool.providerObservedAt ?? Number.NaN,
        );
        const fingerprint = liveComposioSchemaFingerprint(toolSlug);
        result = fingerprint
          ? { outcome: 'refreshed', durationMs: Date.now() - startedAt, fingerprint }
          : { outcome: 'unavailable', durationMs: Date.now() - startedAt };
      }
    } catch {
      result = { outcome: 'failed', durationMs: Date.now() - startedAt };
    }
    try { entry.observer?.(result); } catch { /* telemetry never changes authority */ }
    return result;
  })();
  entry.promise = refresh;
  providerSchemaLoads.set(toolSlug, entry);
  void refresh.finally(() => {
    if (providerSchemaLoads.get(toolSlug) === entry) providerSchemaLoads.delete(toolSlug);
  });
  return refresh;
}

/** Test seam: inject the live loader without importing the composio client. */
export function _setToolSchemaLoaderForTests(loader: SchemaLoader | null): void {
  schemaLoader = loader;
  schemaLoadAttempted.clear();
  liveSchemaNegativeUntil.clear();
  providerSchemaLoads.clear();
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
  await refreshSchemaFromProvider(toolSlug);
  return getCachedToolSchema(toolSlug);
}

/** Test hook: how many entries the PROCESS cache currently holds — the size
 *  cap is a memory bound, and asserting it through the public getter no longer
 *  works now that a durable contract can answer for an evicted entry. */
export function inMemorySchemaCount(): number {
  return cache.size;
}

/** Test hook. */
export function resetToolSchemaCache(): void {
  cache.clear();
  schemaLoadAttempted.clear();
  liveSchemaNegativeUntil.clear();
  providerSchemaLoads.clear();
}

/**
 * The executable contract digest for one identifier. Only a real provider
 * observation inside the 30-minute authority lease qualifies. A durable
 * validation-cache read never moves providerObservedAt and therefore cannot
 * mint autonomous execution authority.
 */
export function liveComposioSchemaFingerprint(toolSlug: string): string | undefined {
  const hit = cache.get(toolSlug);
  if (!hit) return undefined;
  const age = Date.now() - (hit.providerObservedAt ?? Number.NaN);
  if (!Number.isFinite(age) || age < 0 || age > SCHEMA_TTL_MS) return undefined;
  try {
    const currentFingerprint = fingerprintSchema(hit.schema);
    return hit.providerObservedFingerprint === currentFingerprint
      ? currentFingerprint
      : undefined;
  } catch { return undefined; }
}

/** Restore only the unused part of a real provider-observation lease. */
function hydrateRecentProviderAuthority(toolSlug: string): string | undefined {
  if (!toolSlug) return undefined;
  const durable = loadToolContract(toolSlug);
  const observedAt = durable ? Date.parse(durable.providerObservedAt ?? '') : Number.NaN;
  const age = Date.now() - observedAt;
  if (!durable
    || durable.identifier !== toolSlug
    || !Number.isFinite(age)
    || age < 0
    || age > SCHEMA_TTL_MS
    || fingerprintSchema(durable.schema) !== durable.fingerprint
    || durable.providerObservedFingerprint !== durable.fingerprint) return undefined;
  cache.set(toolSlug, {
    schema: durable.schema,
    cachedAt: Date.now(),
    providerObservedAt: observedAt,
    providerObservedFingerprint: durable.providerObservedFingerprint,
  });
  return liveComposioSchemaFingerprint(toolSlug);
}

/**
 * Resolve TTL-bounded schema authority for a warm candidate. A recent durable
 * observation answers without network I/O; an expired/missing observation
 * performs one exact-slug metadata refresh for this daemon. This never
 * executes the business tool and is called only after a deterministic active
 * procedure match, so unrelated chat still performs zero provider work.
 */
export async function ensureLiveComposioSchemaFingerprint(
  toolSlug: string,
  observer?: LiveSchemaProviderRefreshObserver,
): Promise<string | undefined> {
  const current = liveComposioSchemaFingerprint(toolSlug)
    ?? hydrateRecentProviderAuthority(toolSlug);
  if (current) return current;
  if (!toolSlug) return undefined;
  const inFlight = providerSchemaLoads.get(toolSlug);
  if (inFlight) {
    if (!inFlight.observer && observer) inFlight.observer = observer;
    await inFlight.promise;
    return liveComposioSchemaFingerprint(toolSlug);
  }
  if ((liveSchemaNegativeUntil.get(toolSlug) ?? 0) > Date.now()) return undefined;
  const refreshed = await refreshSchemaFromProvider(toolSlug, observer);
  if (refreshed.outcome !== 'refreshed') {
    liveSchemaNegativeUntil.set(toolSlug, Date.now() + LIVE_SCHEMA_NEGATIVE_TTL_MS);
  }
  else liveSchemaNegativeUntil.delete(toolSlug);
  return liveComposioSchemaFingerprint(toolSlug);
}

/** Test hook: empty all process-only state, the shape of a daemon restart. */
export function _clearToolSchemaCacheForTest(): void {
  cache.clear();
  schemaLoadAttempted.clear();
  liveSchemaNegativeUntil.clear();
  providerSchemaLoads.clear();
}
