import pino from 'pino';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getOpenAiApiKey, getRuntimeEnv } from '../config.js';
import { openMemoryDb, STATE_DIR } from './db.js';

/**
 * Provider-backed embeddings for semantic recall rerank.
 *
 * Design choices:
 * - OpenAI uses a single REST call via built-in `fetch`; no OpenAI key installs
 *   can use the lazy local provider when available.
 * - If no provider is available, the embedding path silently degrades to
 *   FTS/lexical recall — no errors, no prompts, no UX cliffs.
 * - Vectors are stored as raw Float32 buffers in SQLite. Provider model/dim are
 *   stored with every row so runtime only compares vectors from the active space.
 * - Recall does the cosine rerank in-process over the FTS candidate
 *   pool — usually 30–60 vectors — which is microseconds. No ANN
 *   library needed at personal scale.
 *
 * Schema lives in src/memory/db.ts (`embeddings` table, FK-cascaded
 * to `vault_chunks` so chunk delete → embedding delete for free).
 */

const logger = pino({ name: 'clementine-next.memory.embeddings' });

// OpenAI defaults (the provider used when an OPENAI_API_KEY is present). Kept as
// exported constants for back-compat; the ACTIVE provider's model/dim are read
// via activeEmbeddingModel()/activeEmbeddingDim() so a different provider's
// vectors are stored + compared correctly.
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

// Bundled local fallback (zero external key). Transformers.js / ONNX model.
// 384-dim — DIFFERENT from OpenAI's 1536, so the re-embed-on-provider-change
// path + cosine dim-guard below are load-bearing, not theoretical.
export const LOCAL_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const LOCAL_EMBEDDING_DIM = 384;

// OpenAI accepts up to 2048 inputs per request; we stay conservative
// so a single bad chunk can't poison too many at once.
const BATCH_SIZE = 96;
// Embedding model max is 8192 tokens; chunks are ~300 tokens, but we
// hard-cap the input length to avoid surprises on edge-case files.
const MAX_INPUT_CHARS = 16_000;
// Per-call timeout for the embeddings fetch. Tighter than undici's
// default (10s) so the daemon doesn't hang for a full 10s on a stale
// Cloudflare IP — chat/recall fall back to FTS-only on timeout.
// 10s (was 6s): the 6s ceiling tripped on slow-but-healthy calls, the #1 real
// recall degradation (156 timeouts / 32 breaker-opens in 14d). Read per-call via
// getRuntimeEnv (not a module const / raw process.env) so a .env-file drop of
// CLEMMY_EMBED_TIMEOUT_MS reverts it LIVE like every other daemon flag.
function fetchTimeoutMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_EMBED_TIMEOUT_MS', '') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

// Circuit breaker for the long-running daemon's pool-poisoning
// failure mode. After ~hours of uptime, undici keeps stale Cloudflare
// IPs in its connection pool and every embedding call times out for
// some period. When we see CONSECUTIVE_FAIL_THRESHOLD failures in a
// row we open the breaker for COOLDOWN_MS — recall and the indexer
// silently fall through to the FTS path, avoiding the 6s × N tax per
// chat. A single success closes the breaker.
const CONSECUTIVE_FAIL_THRESHOLD = 3;
// Class-aware cooldowns. A transient pool/network blip clears in minutes and a
// rate-limit clears fast, but a TERMINAL error (quota exhausted / bad key) will
// NOT fix itself for hours — retrying it every 5 min just drip-spends and floods
// the log (the 2026-06-08 incident: 149 retries in a day against an empty
// account). So terminal errors back off hard and surface loudly.
const COOLDOWN_TRANSIENT_MS = 5 * 60_000;   // pooled-IP / network / 5xx / timeout
const COOLDOWN_RATE_LIMIT_MS = 60_000;      // 429 throttle (not quota)
const COOLDOWN_TERMINAL_MS = 60 * 60_000;   // quota / auth — probe at most hourly

export type EmbedErrorClass = 'quota' | 'auth' | 'rate_limit' | 'transient';

interface PersistedProviderCooldown {
  cls: EmbedErrorClass;
  untilMs: number;
  since: string;
  failures: number;
}

interface PersistedProviderCooldownState {
  providers?: Record<string, PersistedProviderCooldown>;
}

const EMBEDDING_PROVIDER_HEALTH_FILE = path.join(STATE_DIR, 'embedding-provider-health.json');
let embeddingProviderHealthFile = EMBEDDING_PROVIDER_HEALTH_FILE;
let embeddingProviderHealthFileIsTestOverride = false;
let providerCooldownsLoaded = false;
const providerCooldowns = new Map<string, PersistedProviderCooldown>();

function providerCooldownKey(provider: Pick<EmbeddingProvider, 'name' | 'model' | 'dim'>): string {
  return `${provider.name ?? 'unknown'}:${provider.model ?? 'unknown'}:${provider.dim}`;
}

function loadProviderCooldowns(): void {
  if (providerCooldownsLoaded) return;
  providerCooldownsLoaded = true;
  providerCooldowns.clear();
  if (!existsSync(embeddingProviderHealthFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(embeddingProviderHealthFile, 'utf-8')) as PersistedProviderCooldownState;
    const now = Date.now();
    for (const [key, rec] of Object.entries(parsed.providers ?? {})) {
      if (
        typeof key === 'string' &&
        typeof rec.cls === 'string' &&
        typeof rec.untilMs === 'number' &&
        typeof rec.since === 'string' &&
        typeof rec.failures === 'number' &&
        rec.untilMs > now
      ) {
        providerCooldowns.set(key, rec);
      }
    }
  } catch {
    providerCooldowns.clear();
  }
  persistProviderCooldowns();
}

function persistProviderCooldowns(): void {
  const now = Date.now();
  for (const [key, rec] of providerCooldowns) {
    if (rec.untilMs <= now) providerCooldowns.delete(key);
  }
  try {
    if (providerCooldowns.size === 0) {
      rmSync(embeddingProviderHealthFile, { force: true });
      return;
    }
    mkdirSync(path.dirname(embeddingProviderHealthFile), { recursive: true });
    const tmp = `${embeddingProviderHealthFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ providers: Object.fromEntries(providerCooldowns) }, null, 2), 'utf-8');
    renameSync(tmp, embeddingProviderHealthFile);
  } catch {
    // Best-effort health marker only. In-process breaker/demotion still works.
  }
}

function providerCooldown(provider: EmbeddingProvider): PersistedProviderCooldown | null {
  loadProviderCooldowns();
  const key = providerCooldownKey(provider);
  const rec = providerCooldowns.get(key);
  if (!rec) return null;
  if (rec.untilMs <= Date.now()) {
    providerCooldowns.delete(key);
    persistProviderCooldowns();
    return null;
  }
  return rec;
}

function markProviderCooldown(provider: EmbeddingProvider, cls: EmbedErrorClass, untilMs: number, failures: number): void {
  if (provider.name !== 'openai' || untilMs <= Date.now()) return;
  loadProviderCooldowns();
  providerCooldowns.set(providerCooldownKey(provider), {
    cls,
    untilMs,
    since: new Date().toISOString(),
    failures,
  });
  persistProviderCooldowns();
}

function clearProviderCooldown(provider: EmbeddingProvider): void {
  if (provider.name !== 'openai') return;
  loadProviderCooldowns();
  if (providerCooldowns.delete(providerCooldownKey(provider))) persistProviderCooldowns();
}

export function classifyEmbedError(err: unknown): EmbedErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|exceeded your current quota|check your plan and billing/i.test(msg)) return 'quota';
  if (/\b401\b|invalid_api_key|incorrect api key|OPENAI_API_KEY is not set/i.test(msg)) return 'auth';
  if (/\b429\b|rate.?limit/i.test(msg)) return 'rate_limit';
  return 'transient';
}

/** Worth ONE retry before counting toward the breaker: a genuinely TRANSIENT blip
 *  (timeout / network / 5xx). NOT a persistent CLIENT error (400 oversized-input,
 *  404 bad-model) — those fail identically on retry and just double the synchronous
 *  JIT/recall latency — nor terminal (auth/quota) / rate-limit (429). Pure/testable. */
export function embedErrorIsRetryable(err: unknown): boolean {
  if (classifyEmbedError(err) !== 'transient') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return !/\b4\d\d\b/.test(msg); // any 4xx that slipped into 'transient' (≠429) won't recover
}

function cooldownForClass(cls: EmbedErrorClass): number {
  switch (cls) {
    case 'quota':
    case 'auth': return COOLDOWN_TERMINAL_MS;
    case 'rate_limit': return COOLDOWN_RATE_LIMIT_MS;
    default: return COOLDOWN_TRANSIENT_MS;
  }
}

let consecutiveFailures = 0;
let cooldownUntilMs = 0;
let lastSuccessAtMs = 0;
let lastErrorClass: EmbedErrorClass | null = null;
let lastErrorAtMs = 0;
const providerInFlightSince = new Map<string, number>();
const providerInFlightDone = new Map<string, Promise<void>>();

function inCooldown(): boolean {
  if (cooldownUntilMs === 0) return false;
  if (Date.now() >= cooldownUntilMs) {
    // Half-open: let the next call probe. Don't reset failures — if
    // the probe also fails the breaker re-opens immediately.
    cooldownUntilMs = 0;
    return false;
  }
  return true;
}

/** Non-mutating view of breaker state for the health getter (never half-opens). */
function breakerOpenPeek(): boolean {
  return cooldownUntilMs !== 0 && Date.now() < cooldownUntilMs;
}

function recordSuccess(provider?: EmbeddingProvider): void {
  consecutiveFailures = 0;
  cooldownUntilMs = 0;
  lastSuccessAtMs = Date.now();
  lastErrorClass = null;
  if (provider) clearProviderCooldown(provider);
}

function recordFailure(err: unknown): { cls: EmbedErrorClass; opened: boolean; untilMs: number; failures: number } {
  consecutiveFailures++;
  const cls = classifyEmbedError(err);
  lastErrorClass = cls;
  lastErrorAtMs = Date.now();
  const failures = consecutiveFailures;
  const terminal = cls === 'quota' || cls === 'auth';
  // Terminal errors are definitive — open immediately (don't burn 2 more calls
  // confirming the quota is still empty). Transient/rate-limit wait for the
  // threshold so a single blip doesn't drop recall to FTS.
  const shouldOpen = cooldownUntilMs === 0 && (terminal || consecutiveFailures >= CONSECUTIVE_FAIL_THRESHOLD);
  let openedUntilMs = 0;
  if (shouldOpen) {
    // ±12% jitter so many daemons/callers don't re-probe in lockstep (thundering
    // herd on the embedding endpoint the moment a cooldown lapses).
    const base = cooldownForClass(cls);
    const ms = Math.round(base * (0.88 + Math.random() * 0.24));
    cooldownUntilMs = Date.now() + ms;
    openedUntilMs = cooldownUntilMs;
    const line = `embeddings circuit breaker open (${cls}) — recall on FTS-only for ~${Math.round(ms / 60_000)}m`;
    if (terminal) {
      logger.error(
        { cls, failures, cooldownMs: ms },
        `${line}. ${cls === 'quota' ? 'OpenAI quota exhausted — add credit/billing to restore semantic memory.' : 'OpenAI key rejected — check credentials.'}`,
      );
    } else {
      logger.warn({ cls, failures, cooldownMs: ms }, line);
    }
    maybeDemoteToLocal(cls);
  }
  return { cls, opened: shouldOpen, untilMs: openedUntilMs, failures };
}

// ── Local-fallback demotion (2026-07-08) ────────────────────────────────────
// When the OpenAI embedder trips its breaker, recall used to degrade to
// FTS-only for the whole cooldown (99 embedQuery failures over two live days —
// the #1 recall pain). The daemon ships a zero-key local model, and the
// backfill already re-embeds any row whose stored model/dim differs from the
// active provider — so instead of degrading, DEMOTE to the local provider for
// the rest of the process lifetime (one flip max — no OpenAI↔local churn;
// terminal/provider cooldowns survive daemon restarts). The ~1k-chunk corpus re-embeds
// locally within a few backfill ticks; hybrid recall's FTS half covers the
// transition. A quota/auth breaker demotes on the FIRST open (it will not
// heal by itself); a transient breaker demotes on the SECOND open in one
// process (one bad network patch shouldn't flip providers).
let demotedToLocal = false;
let transientBreakerOpens = 0;

function maybeDemoteToLocal(cls: EmbedErrorClass): void {
  if (demotedToLocal) return;
  if (providerOverride() === 'openai') return; // an explicit force is honored
  if (!localEmbeddingsAllowed()) return;
  const terminal = cls === 'quota' || cls === 'auth';
  if (!terminal) {
    transientBreakerOpens++;
    if (transientBreakerOpens < 2) return;
  }
  demotedToLocal = true;
  // Recall/backfill consult the provider per call, so this takes effect on the
  // very next embed. Warm the local model now so the first demoted query
  // doesn't pay the load. Clear the breaker: it guarded the OPENAI provider,
  // and holding it open would needlessly keep the LOCAL provider on FTS-only.
  consecutiveFailures = 0;
  cooldownUntilMs = 0;
  void loadLocalProvider();
  logger.error(
    { cls, model: LOCAL_EMBEDDING_MODEL },
    'OpenAI embedder demoted — semantic memory continues on the LOCAL embedding model while the OpenAI provider is cooling down. Fix billing/network to restore the OpenAI embedder.',
  );
}

/** Test-only: reset the demotion state between cases. */
export function _resetEmbedDemotionForTest(): void {
  demotedToLocal = false;
  transientBreakerOpens = 0;
}

export interface EmbeddingHealth {
  enabled: boolean;
  breakerOpen: boolean;
  cooldownUntilMs: number;
  providerCooldownUntilMs: number;
  providerCooldownReason: EmbedErrorClass | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorClass: EmbedErrorClass | null;
  lastErrorAt: string | null;
}

/** Snapshot of embedding health for the diagnostics panel — non-mutating. */
export function getEmbeddingHealth(): EmbeddingHealth {
  const openaiCooldown = providerCooldown(OPENAI_PROVIDER);
  return {
    enabled: isEmbeddingsEnabled(),
    breakerOpen: breakerOpenPeek(),
    cooldownUntilMs,
    providerCooldownUntilMs: openaiCooldown?.untilMs ?? 0,
    providerCooldownReason: openaiCooldown?.cls ?? null,
    lastSuccessAt: lastSuccessAtMs ? new Date(lastSuccessAtMs).toISOString() : null,
    consecutiveFailures,
    lastErrorClass,
    lastErrorAt: lastErrorAtMs ? new Date(lastErrorAtMs).toISOString() : null,
  };
}

/** Test-only: reset the in-process breaker/health state between cases. */
export function _resetEmbeddingHealthForTest(): void {
  consecutiveFailures = 0;
  cooldownUntilMs = 0;
  lastSuccessAtMs = 0;
  lastErrorClass = null;
  lastErrorAtMs = 0;
  embedQueryInflight.clear();
  providerInFlightSince.clear();
  providerInFlightDone.clear();
  providerCooldownsLoaded = false;
  providerCooldowns.clear();
}
/** Test-only: drive the breaker without a real API call. */
export function _driveEmbedFailureForTest(err: unknown): void { recordFailure(err); }
export function _driveEmbedSuccessForTest(): void { recordSuccess(); }
/** Test-only: point persisted provider health at a disposable file. */
export function _setEmbeddingProviderHealthFileForTest(file: string | null): void {
  embeddingProviderHealthFile = file ?? EMBEDDING_PROVIDER_HEALTH_FILE;
  embeddingProviderHealthFileIsTestOverride = file !== null;
  providerCooldownsLoaded = false;
  providerCooldowns.clear();
}
/** Test-only: clear persisted provider cooldowns from the disposable health file. */
export function _resetEmbeddingProviderCooldownsForTest(): void {
  providerCooldownsLoaded = true;
  providerCooldowns.clear();
  if (embeddingProviderHealthFileIsTestOverride) {
    try { rmSync(embeddingProviderHealthFile, { force: true }); } catch { /* best effort */ }
  }
}

// ── Embedding provider abstraction (WS3) ────────────────────────────────
// Ends the OpenAI hard-lock: a non-OpenAI-key user (codex_oauth / claude-brain)
// no longer silently loses ALL semantic recall. Providers are selected by
// available credentials — OpenAI when a key is present, else a bundled local
// ONNX model (zero key). Each provider declares its model + dim so vectors are
// stored + compared in the right space (the cosine dim-guard + re-embed paths
// rely on this). The default path with a key present is byte-identical to before.

export interface EmbeddingProvider {
  /** Stable provider id stored alongside vectors ('openai' | 'local'). */
  readonly name: string;
  /** Model identifier (also stored, so a model change triggers re-embed). */
  readonly model: string;
  /** Output dimensionality. */
  readonly dim: number;
  /** Embed a batch; returns vectors in input order. Throws on hard failure. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

const OPENAI_PROVIDER: EmbeddingProvider = {
  name: 'openai',
  model: EMBEDDING_MODEL,
  dim: EMBEDDING_DIM,
  embed: (texts) => openaiEmbedBatch(texts),
};

// Local provider is loaded lazily (the Transformers.js / onnxruntime dependency
// is heavy + optional). `undefined` = not yet probed; `null` = probed and
// unavailable (degrade to lexical, exactly today's no-key behavior).
let localProvider: EmbeddingProvider | null | undefined = undefined;
let localProbeInFlight: Promise<EmbeddingProvider | null> | null = null;
// Test seam — inject a deterministic provider without any network/model load.
let injectedProvider: EmbeddingProvider | null | undefined = undefined;

/** Attempt local provider on no-key installs unless explicitly disabled. */
function localEmbeddingsAllowed(): boolean {
  return (getRuntimeEnv('CLEMMY_LOCAL_EMBEDDINGS', 'on') || 'on').trim().toLowerCase() !== 'off';
}

async function loadLocalProvider(): Promise<EmbeddingProvider | null> {
  if (localProvider !== undefined) return localProvider;
  if (localProbeInFlight) return localProbeInFlight;
  localProbeInFlight = (async () => {
    try {
      // Lazy + optional: the package is an optionalDependency. If it isn't
      // installed (or the model can't load offline), we degrade to lexical —
      // never a crash, never a startup cost when unused.
      const mod = await import(/* @vite-ignore */ '@huggingface/transformers' as string).catch(() => null) as
        | { pipeline?: (task: string, model: string) => Promise<(input: string[], opts?: unknown) => Promise<{ data: ArrayLike<number> }>> }
        | null;
      if (!mod?.pipeline) { localProvider = null; return null; }
      const extractor = await mod.pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL);
      const provider: EmbeddingProvider = {
        name: 'local',
        model: LOCAL_EMBEDDING_MODEL,
        dim: LOCAL_EMBEDDING_DIM,
        async embed(texts) {
          const out: Float32Array[] = [];
          for (const t of texts) {
            const res = await extractor([t], { pooling: 'mean', normalize: true });
            out.push(Float32Array.from(res.data as ArrayLike<number>));
          }
          return out;
        },
      };
      localProvider = provider;
      logger.info({ model: LOCAL_EMBEDDING_MODEL, dim: LOCAL_EMBEDDING_DIM }, 'local embedding provider loaded');
      return provider;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'local embedding provider unavailable — semantic recall on lexical fallback');
      localProvider = null;
      return null;
    } finally {
      localProbeInFlight = null;
    }
  })();
  return localProbeInFlight;
}

/** Hard opt-out (honored for every provider). */
function embeddingsDisabledByEnv(): boolean {
  return (getRuntimeEnv('EMBEDDINGS_DISABLED', '') || '').trim().toLowerCase() === 'true';
}

/** Forced provider override: 'openai' | 'local' | 'off' (else auto by creds). */
function providerOverride(): string {
  return (getRuntimeEnv('CLEMMY_EMBED_PROVIDER', '') || '').trim().toLowerCase();
}

/**
 * The active provider, async (may lazily load the local model). Selection:
 *   override 'off' / EMBEDDINGS_DISABLED → none
 *   override 'openai' OR (no override AND key present) → OpenAI
 *   override 'local' OR (no key) → local (if loadable)
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (injectedProvider !== undefined) return injectedProvider;
  if (embeddingsDisabledByEnv()) return null;
  const override = providerOverride();
  if (override === 'off') return null;
  // A demoted OpenAI embedder routes to local for this process lifetime
  // (breaker opened on quota/auth, or twice on transient — see recordFailure).
  if (demotedToLocal && override !== 'openai' && localEmbeddingsAllowed()) return loadLocalProvider();
  if (override !== 'local' && getOpenAiApiKey()) {
    if (override !== 'openai' && providerCooldown(OPENAI_PROVIDER)) {
      if (!localEmbeddingsAllowed()) return null;
      return loadLocalProvider();
    }
    return OPENAI_PROVIDER;
  }
  if (override === 'openai') return null; // forced openai but no key
  if (!localEmbeddingsAllowed()) return null;
  return loadLocalProvider();
}

/** Sync best-effort view of the active provider (no model load). Used by the
 *  many sync gates (recall fast-path, graph). Returns the local provider only
 *  if it has ALREADY loaded; warmup below makes that the common case. */
function activeProviderSync(): EmbeddingProvider | null {
  if (injectedProvider !== undefined) return injectedProvider;
  if (embeddingsDisabledByEnv()) return null;
  const override = providerOverride();
  if (override === 'off') return null;
  // Demoted → local only. Deliberately NOT falling back to OPENAI_PROVIDER
  // while the local model is still loading: OpenAI is known-bad here, and a
  // brief lexical-only window beats re-poisoning recall with timeouts.
  if (demotedToLocal && override !== 'openai' && localEmbeddingsAllowed()) return localProvider ?? null;
  if (override !== 'local' && getOpenAiApiKey()) {
    if (override !== 'openai' && providerCooldown(OPENAI_PROVIDER)) {
      if (!localEmbeddingsAllowed()) return null;
      void loadLocalProvider();
      return localProvider ?? null;
    }
    return OPENAI_PROVIDER;
  }
  if (override === 'openai') return null;
  if (!localEmbeddingsAllowed()) return null;
  return localProvider ?? null; // null until warmup completes
}

export function activeEmbeddingModel(): string | null { return activeProviderSync()?.model ?? null; }
export function activeEmbeddingDim(): number | null { return activeProviderSync()?.dim ?? null; }

/**
 * Stable identity for the vector space currently allowed to participate in
 * recall/graph computations. Consumers that cache derived geometry or
 * similarity must include this key: a provider/model/dimension switch can
 * happen before the replacement backfill writes any rows (and therefore
 * before SQLite's memory generation changes).
 */
export function activeEmbeddingSpaceKey(): string {
  const provider = activeProviderSync();
  if (!provider?.model || !Number.isFinite(provider.dim)) return 'disabled';
  return `${provider.name || 'unknown'}:${provider.model}:${provider.dim}`;
}

function activeEmbeddingSelector(): { model: string; dim: number } | null {
  const provider = activeProviderSync();
  if (!provider?.model || !Number.isFinite(provider.dim)) return null;
  return { model: provider.model, dim: provider.dim };
}

export function isEmbeddingsEnabled(): boolean {
  // Enabled when a provider resolves. OpenAI is sync (key presence); the local
  // provider becomes "enabled" once warmup loads it (kicked off below on
  // no-key installs), degrading to lexical until then — same as the old
  // no-key behavior. EMBEDDINGS_DISABLED=true forces off for every provider.
  return activeProviderSync() !== null;
}

/** Test-only: inject (or clear with `null`) a deterministic provider. */
export function _setEmbeddingProviderForTest(p: EmbeddingProvider | null | undefined): void {
  injectedProvider = p;
  embedQueryInflight.clear();
}
/** Test-only: reset the lazily-probed local provider. */
export function _resetLocalProviderForTest(): void {
  localProvider = undefined;
  localProbeInFlight = null;
}
/** Test-only: seed the lazily-probed local provider without loading ONNX. */
export function _setLocalProviderForTest(p: EmbeddingProvider | null | undefined): void {
  localProvider = p;
  localProbeInFlight = null;
}

// Eager local warmup on no-key installs so isEmbeddingsEnabled() flips true
// before the first recall, instead of reporting "off" for the first turn.
// Fire-and-forget; failures already degrade to lexical inside loadLocalProvider.
if (
  localEmbeddingsAllowed()
  && providerOverride() !== 'off'
  && providerOverride() !== 'openai'
  && !embeddingsDisabledByEnv()
  && !getOpenAiApiKey()
) {
  void loadLocalProvider();
}

/**
 * Convert a Float32Array to a Buffer for SQLite BLOB storage.
 * We copy the underlying ArrayBuffer to be safe — Float32Array views
 * can share buffers in surprising ways.
 */
export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function bufferToVector(buffer: Buffer): Float32Array {
  // Slice to ensure we own the bytes and aren't aliasing the SQLite buffer.
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Dim mismatch ⇒ 0, never a garbage truncated score. Before the provider
  // abstraction this used Math.min(a,b) and would silently compare a 1536-dim
  // OpenAI vector against a 384-dim local one as if the overlap were meaningful,
  // corrupting ranking/dedup. Different dims = different spaces = not comparable.
  if (a.length !== b.length) return 0;
  const len = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface EmbeddingsApiResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Embed a batch of texts via the OpenAI API. The OpenAI provider's `embed`.
 * Returns vectors in input order. Throws on hard failure — callers decide.
 */
async function openaiEmbedBatch(texts: string[]): Promise<Float32Array[]> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (texts.length === 0) return [];

  const safeInputs = texts.map((t) => (t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t));

  // keepalive:false forces undici to NOT pool this connection. After
  // hours of daemon uptime, the keep-alive pool fills with stale
  // Cloudflare-edge IPs that no longer route — every subsequent call
  // times out at undici's 10s connect timeout. Opting out of the pool
  // means every embedding call does a fresh DNS lookup + TCP connect.
  // That's a few-ms tax per call but avoids the multi-hour outage.
  const attempt = async (): Promise<Float32Array[]> => {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: safeInputs,
      }),
      keepalive: false,
      signal: AbortSignal.timeout(fetchTimeoutMs()),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Embeddings API ${response.status}: ${body.slice(0, 400)}`);
    }

    const json = await response.json() as EmbeddingsApiResponse;
    // Sort by `index` defensively; the API returns in order but we don't rely on it.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((row) => Float32Array.from(row.embedding));
  };

  try {
    return await attempt();
  } catch (err) {
    // One retry on a genuinely TRANSIENT blip (timeout / network / 5xx) before it
    // counts toward the breaker — a single slow call must not drop recall to FTS
    // for minutes. NOT retried: terminal (auth/quota), rate-limit (429), AND a
    // persistent CLIENT error (400 oversized-input / 404 bad-model) — those fail
    // identically on retry and just DOUBLE the synchronous JIT/recall latency on
    // this pre-turn path (07-06 ship-review finding).
    if (embedErrorIsRetryable(err)) {
      await new Promise((r) => setTimeout(r, 300));
      return await attempt();
    }
    throw err;
  }
}

/**
 * Public API: embed a single query string. Convenience for the recall
 * rerank path. Returns null if embeddings are disabled or the call fails
 * — recall falls back to FTS-only ordering.
 */
// Short-TTL in-FLIGHT cache (Phase 3): the same query is embedded twice in one
// turn — the per-turn vault-hybrid recall AND the fact-recall vector prime both
// embed `options.input`, concurrently (Promise.all). Caching the PROMISE (not just
// the resolved value) dedupes the concurrent pair into ONE provider call, and a
// short TTL also absorbs sequential repeats. Bounded so it never grows unbounded;
// failures (null) are evicted so a transient miss never sticks.
const EMBED_QUERY_CACHE_TTL_MS = 60_000;
const EMBED_QUERY_CACHE_MAX = 256;
const embedQueryInflight = new Map<string, { at: number; p: Promise<Float32Array | null> }>();

function urgentFactEmbeddingBusyWaitMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_EMBED_URGENT_BUSY_WAIT_MS', '1000') || '1000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

function embeddingProviderCacheKey(provider: EmbeddingProvider): string {
  return `${provider.name ?? 'unknown'}:${provider.model ?? 'unknown'}:${provider.dim}`;
}

function providerUsesRemoteSingleFlight(provider: EmbeddingProvider): boolean {
  return provider.name === 'openai';
}

function providerBusyReason(provider: EmbeddingProvider): string | null {
  if (!providerUsesRemoteSingleFlight(provider)) return null;
  const key = embeddingProviderCacheKey(provider);
  const since = providerInFlightSince.get(key);
  if (!since) return null;
  return `embedding provider already has an in-flight probe (${Math.max(0, Date.now() - since)}ms old)`;
}

async function waitForProviderIdle(provider: EmbeddingProvider, timeoutMs: number): Promise<boolean> {
  if (!providerUsesRemoteSingleFlight(provider) || timeoutMs <= 0) return !providerBusyReason(provider);
  const done = providerInFlightDone.get(embeddingProviderCacheKey(provider));
  if (!done) return true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callProviderEmbed(provider: EmbeddingProvider, texts: string[]): Promise<Float32Array[]> {
  if (!providerUsesRemoteSingleFlight(provider)) return provider.embed(texts);
  const key = embeddingProviderCacheKey(provider);
  providerInFlightSince.set(key, Date.now());
  let call: Promise<Float32Array[]>;
  try {
    call = provider.embed(texts);
  } catch (err) {
    providerInFlightSince.delete(key);
    throw err;
  }
  const done = call.then(() => undefined, () => undefined);
  providerInFlightDone.set(key, done);
  try {
    return await call;
  } finally {
    if (providerInFlightDone.get(key) === done) {
      providerInFlightDone.delete(key);
      providerInFlightSince.delete(key);
    }
  }
}

async function fallbackProviderAfterFailure(failedProvider: EmbeddingProvider): Promise<EmbeddingProvider | null> {
  if (inCooldown()) return null;
  const next = await getEmbeddingProvider();
  if (!next) return null;
  if (embeddingProviderCacheKey(next) === embeddingProviderCacheKey(failedProvider)) return null;
  return next;
}

type EmbedBatchResult =
  | { provider: EmbeddingProvider; vectors: Float32Array[] }
  | { skipped: true; reason: string };

async function embedBatchWithProviderFailover(
  provider: EmbeddingProvider,
  texts: string[],
  logContext: Record<string, unknown>,
  options: { busyWaitMs?: number } = {},
): Promise<EmbedBatchResult | null> {
  if (inCooldown()) return null;
  if (options.busyWaitMs && providerBusyReason(provider)) {
    await waitForProviderIdle(provider, options.busyWaitMs);
  }
  const busy = providerBusyReason(provider);
  if (busy) return { skipped: true, reason: busy };
  try {
    const vectors = await callProviderEmbed(provider, texts);
    recordSuccess(provider);
    return { provider, vectors };
  } catch (err) {
    const failure = recordFailure(err);
    if (failure.opened) markProviderCooldown(provider, failure.cls, failure.untilMs, failure.failures);
    const fallback = await fallbackProviderAfterFailure(provider);
    if (fallback) {
      try {
        const vectors = await callProviderEmbed(fallback, texts);
        recordSuccess(fallback);
        logger.warn(
          { ...logContext, err, provider: embeddingProviderCacheKey(provider), fallback: embeddingProviderCacheKey(fallback) },
          'embedding provider failed; fallback provider succeeded',
        );
        return { provider: fallback, vectors };
      } catch (fallbackErr) {
        const fallbackFailure = recordFailure(fallbackErr);
        if (fallbackFailure.opened) markProviderCooldown(fallback, fallbackFailure.cls, fallbackFailure.untilMs, fallbackFailure.failures);
        logger.warn(
          { ...logContext, err: fallbackErr, provider: embeddingProviderCacheKey(fallback) },
          'embedding fallback provider failed',
        );
      }
    }
    logger.warn(
      { ...logContext, err, provider: embeddingProviderCacheKey(provider) },
      'embedding provider failed; no fallback provider available',
    );
    return null;
  }
}

async function embedQueryWithProvider(provider: EmbeddingProvider, query: string): Promise<Float32Array | null> {
  const result = await embedBatchWithProviderFailover(provider, [query], { operation: 'embedQuery' });
  if (result && 'skipped' in result) return null;
  return result?.vectors[0] ?? null;
}

export async function embedQuery(query: string): Promise<Float32Array | null> {
  const provider = await getEmbeddingProvider();
  if (!provider) return null;
  const now = Date.now();
  const key = `${embeddingProviderCacheKey(provider)}\n${query}`;
  const hit = embedQueryInflight.get(key);
  if (hit && now - hit.at < EMBED_QUERY_CACHE_TTL_MS) return hit.p;
  const p = embedQueryWithProvider(provider, query);
  embedQueryInflight.set(key, { at: now, p });
  // Evict a null/failed result so a transient miss is never served from cache.
  p.then((v) => { if (v == null) embedQueryInflight.delete(key); }).catch(() => embedQueryInflight.delete(key));
  // Bound: drop the oldest entry (Map preserves insertion order) past the cap.
  if (embedQueryInflight.size > EMBED_QUERY_CACHE_MAX) {
    const oldest = embedQueryInflight.keys().next().value;
    if (oldest !== undefined) embedQueryInflight.delete(oldest);
  }
  return p;
}

/**
 * Public API: embed a batch of texts in one call. Convenience for rankers that
 * need many vectors at once (e.g. semantic tool retrieval). Returns vectors in
 * input order, or null if embeddings are disabled / in cooldown / the call
 * fails — callers fall back to a non-semantic path. Never throws.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const provider = await getEmbeddingProvider();
  if (!provider) return null;
  const result = await embedBatchWithProviderFailover(provider, texts, { operation: 'embedTexts', count: texts.length });
  if (result && 'skipped' in result) return null;
  return result?.vectors ?? null;
}

export interface EmbedBackfillStats {
  enabled: boolean;
  candidateChunks: number;
  batched: number;
  embedded: number;
  failed: number;
  durationMs: number;
  reason?: string;
}

/**
 * Find chunks that don't yet have embeddings and embed them.
 * - Caller-controlled `maxChunks` so the daemon can run small batches
 *   per tick (default 200) without saturating the API.
 * - Idempotent: rerunning picks up where it left off because we only
 *   look at chunks missing from the `embeddings` table.
 * - One INSERT per successful chunk; failed batches are logged and
 *   skipped without blocking the others.
 */
export async function embedMissingChunks(options: { maxChunks?: number } = {}): Promise<EmbedBackfillStats> {
  const start = Date.now();
  let provider = await getEmbeddingProvider();
  const stats: EmbedBackfillStats = {
    enabled: provider !== null,
    candidateChunks: 0,
    batched: 0,
    embedded: 0,
    failed: 0,
    durationMs: 0,
  };

  if (!provider) {
    stats.reason = 'no embedding provider (no OpenAI key + local unavailable)';
    stats.durationMs = Date.now() - start;
    return stats;
  }
  if (inCooldown()) {
    stats.reason = 'circuit breaker open — skipping this backfill tick';
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const db = openMemoryDb();
  const limit = Math.max(1, options.maxChunks ?? 200);

  // Re-embed when missing OR when the stored vectors came from a DIFFERENT
  // provider model/dim (e.g. switched OpenAI↔local) — mixed dims would corrupt
  // cosine (now guarded to 0), so a provider change rebuilds the affected rows.
  const rows = db.prepare(`
    SELECT vc.id AS id, vc.content AS content
    FROM vault_chunks vc
    LEFT JOIN embeddings e ON e.chunk_id = vc.id
    WHERE e.chunk_id IS NULL OR e.model != ? OR e.dim != ?
    ORDER BY vc.id ASC
    LIMIT ?
  `).all(provider.model, provider.dim, limit) as { id: number; content: string }[];

  stats.candidateChunks = rows.length;
  if (rows.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO embeddings (chunk_id, model, dim, vector, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    stats.batched++;
    const result = await embedBatchWithProviderFailover(provider, batch.map((r) => r.content), {
      operation: 'embedMissingChunks',
      batchStart: i,
      batchSize: batch.length,
    });
    if (result && 'skipped' in result) {
      stats.reason = result.reason;
      break;
    }
    if (!result) {
      stats.failed += batch.length;
      // If the breaker tripped on this batch, bail the whole tick —
      // hammering N more batches just to time out N more times wastes
      // 6s per batch and floods the log.
      if (inCooldown()) {
        stats.reason = 'circuit breaker opened mid-tick';
        break;
      }
      continue;
    }
    provider = result.provider;
    const vectors = result.vectors;

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!vector) continue;
        insert.run(batch[j].id, result.provider.model, vector.length, vectorToBuffer(vector), now);
        stats.embedded++;
      }
    });
    try {
      tx();
    } catch (err) {
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i }, 'embed batch insert failed');
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Load embeddings for a set of chunk ids. Returns a Map for O(1)
 * lookup during the rerank scan.
 */
export function loadEmbeddingsForChunks(chunkIds: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (chunkIds.length === 0) return out;
  const active = activeEmbeddingSelector();
  if (!active) return out;
  const db = openMemoryDb();
  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT chunk_id AS id, vector
     FROM embeddings
     WHERE chunk_id IN (${placeholders})
       AND model = ?
       AND dim = ?`
  ).all(...chunkIds, active.model, active.dim) as { id: number; vector: Buffer }[];
  for (const row of rows) out.set(row.id, bufferToVector(row.vector));
  return out;
}

/**
 * Find consolidated_facts that don't yet have an embedding — or whose
 * stored embedding is stale because the fact's content changed — and
 * embed them. Mirrors `embedMissingChunks` exactly (same batching,
 * circuit breaker, idempotency) but over the `fact_embeddings` table.
 *
 * Staleness check: `fact_embeddings.content_hash != consolidated_facts.
 * content_hash`. updateFact recomputes the fact's content_hash, so a
 * Mem0 UPDATE naturally re-embeds on the next backfill tick.
 */
export async function embedMissingFacts(options: { maxChunks?: number; newestFirst?: boolean } = {}): Promise<EmbedBackfillStats> {
  const start = Date.now();
  let provider = await getEmbeddingProvider();
  const stats: EmbedBackfillStats = {
    enabled: provider !== null,
    candidateChunks: 0,
    batched: 0,
    embedded: 0,
    failed: 0,
    durationMs: 0,
  };

  if (!provider) {
    stats.reason = 'no embedding provider (no OpenAI key + local unavailable)';
    stats.durationMs = Date.now() - start;
    return stats;
  }
  if (inCooldown()) {
    stats.reason = 'circuit breaker open — skipping this backfill tick';
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const db = openMemoryDb();
  const limit = Math.max(1, options.maxChunks ?? 200);
  // newestFirst (M1 embed-at-write): prioritize the just-written facts (highest
  // id) so same-session semantic recall sees them within ~1s, instead of the
  // oldest-first order the nightly backfill uses for eventual full coverage.
  const order = options.newestFirst ? 'DESC' : 'ASC';

  // Re-embed on missing, stale content, OR a provider model/dim change.
  const rows = db.prepare(`
    SELECT cf.id AS id, cf.content AS content, cf.content_hash AS hash
    FROM consolidated_facts cf
    LEFT JOIN fact_embeddings fe ON fe.fact_id = cf.id
    WHERE cf.active = 1
      AND (fe.fact_id IS NULL OR fe.content_hash != cf.content_hash OR fe.model != ? OR fe.dim != ?)
    ORDER BY cf.id ${order}
    LIMIT ?
  `).all(provider.model, provider.dim, limit) as { id: number; content: string; hash: string }[];

  stats.candidateChunks = rows.length;
  if (rows.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    stats.batched++;
    const result = await embedBatchWithProviderFailover(provider, batch.map((r) => r.content), {
      operation: 'embedMissingFacts',
      batchStart: i,
      batchSize: batch.length,
    }, {
      busyWaitMs: options.newestFirst ? urgentFactEmbeddingBusyWaitMs() : 0,
    });
    if (result && 'skipped' in result) {
      stats.reason = result.reason;
      break;
    }
    if (!result) {
      stats.failed += batch.length;
      if (inCooldown()) {
        stats.reason = 'circuit breaker opened mid-tick';
        break;
      }
      continue;
    }
    provider = result.provider;
    const vectors = result.vectors;

    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vector = vectors[j];
        if (!vector) continue;
        insert.run(batch[j].id, result.provider.model, vector.length, vectorToBuffer(vector), batch[j].hash, now);
        stats.embedded++;
      }
    });
    try {
      tx();
    } catch (err) {
      stats.failed += batch.length;
      logger.warn({ err, batchStart: i }, 'embed fact batch insert failed');
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Load embeddings for a set of fact ids. Returns a Map for O(1) lookup
 * during the semantic findSimilarFacts rerank. Mirrors
 * `loadEmbeddingsForChunks`.
 */
export function loadFactEmbeddings(factIds: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (factIds.length === 0) return out;
  const active = activeEmbeddingSelector();
  if (!active) return out;
  const db = openMemoryDb();
  const placeholders = factIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT fe.fact_id AS id, fe.vector AS vector
     FROM fact_embeddings fe
     JOIN consolidated_facts cf ON cf.id = fe.fact_id
     WHERE fe.fact_id IN (${placeholders})
       AND fe.model = ?
       AND fe.dim = ?
       AND fe.content_hash = cf.content_hash`
  ).all(...factIds, active.model, active.dim) as { id: number; vector: Buffer }[];
  for (const row of rows) out.set(row.id, bufferToVector(row.vector));
  return out;
}

let activeFactEmbeddingCache: {
  key: string;
  vectors: Map<number, Float32Array>;
} | null = null;
let activeFactEmbeddingCacheDb: object | null = null;

/** Load the complete active fact-vector set in the current embedding space.
 * Cached by the DB's semantic generation, provider model, and dimension so
 * recall does not trade correctness for an updated_at prefilter. */
export function loadActiveFactEmbeddings(kind?: string): Map<number, Float32Array> {
  const active = activeEmbeddingSelector();
  if (!active) return new Map();
  const db = openMemoryDb();
  const generation = (db.prepare(
    'SELECT generation FROM memory_generation WHERE id = 1',
  ).get() as { generation: number } | undefined)?.generation ?? 0;
  const key = `${generation}:${active.model}:${active.dim}:${kind ?? '*'}`;
  if (activeFactEmbeddingCacheDb === db && activeFactEmbeddingCache?.key === key) return activeFactEmbeddingCache.vectors;
  const rows = db.prepare(`
    SELECT fe.fact_id AS id, fe.vector AS vector
    FROM fact_embeddings fe
    JOIN consolidated_facts cf ON cf.id = fe.fact_id
    WHERE cf.active = 1
      ${kind ? 'AND cf.kind = ?' : ''}
      AND fe.model = ?
      AND fe.dim = ?
      AND fe.content_hash = cf.content_hash
  `).all(...(kind ? [kind] : []), active.model, active.dim) as Array<{ id: number; vector: Buffer }>;
  const vectors = new Map<number, Float32Array>();
  for (const row of rows) vectors.set(row.id, bufferToVector(row.vector));
  activeFactEmbeddingCache = { key, vectors };
  activeFactEmbeddingCacheDb = db;
  return vectors;
}

export interface EmbeddingStats {
  enabled: boolean;
  count: number;
  model: string | null;
  dim: number | null;
}

export function readEmbeddingStats(): EmbeddingStats {
  const stats: EmbeddingStats = {
    enabled: isEmbeddingsEnabled(),
    count: 0,
    model: null,
    dim: null,
  };
  try {
    const db = openMemoryDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS c, MAX(model) AS model, MAX(dim) AS dim
      FROM embeddings
    `).get() as { c: number; model: string | null; dim: number | null };
    stats.count = row.c;
    stats.model = row.model;
    stats.dim = row.dim;
  } catch {
    // Table may not exist or DB may not be openable in some edge tests.
  }
  return stats;
}

export function readFactEmbeddingStats(): EmbeddingStats {
  const stats: EmbeddingStats = {
    enabled: isEmbeddingsEnabled(),
    count: 0,
    model: null,
    dim: null,
  };
  try {
    const db = openMemoryDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS c, MAX(model) AS model, MAX(dim) AS dim
      FROM fact_embeddings
    `).get() as { c: number; model: string | null; dim: number | null };
    stats.count = row.c;
    stats.model = row.model;
    stats.dim = row.dim;
  } catch {
    // Table may not exist or DB may not be openable in some edge tests.
  }
  return stats;
}

/** Active facts that don't yet have an embedding — the backfill backlog. A
 *  growing value while the breaker is open means semantic recall is degrading. */
export function countUnembeddedActiveFacts(): number {
  try {
    const db = openMemoryDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM consolidated_facts f
      WHERE f.active = 1
        AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = f.id)
    `).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
