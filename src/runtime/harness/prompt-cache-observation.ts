import { createHash } from 'node:crypto';
import type { ModelRequest } from '@openai/agents-core';
import {
  CACHE_BREAK_SENTINEL,
  CACHE_MEMORY_CONTEXT_SENTINEL,
  CACHE_MEMORY_APPEND_SENTINEL,
  INSTRUCTION_CACHE_DELIM,
  splitCacheDynamicContext,
} from './model-wire-registry.js';

export const PROMPT_CACHE_OBSERVATION_VERSION = 1 as const;

export type PromptCacheLayerName =
  | 'transport'
  | 'stablePolicy'
  | 'turnContext'
  | 'memoryContext'
  | 'catalog'
  | 'task';

export interface PromptCacheLayerObservation {
  bytes: number;
  sha256: string;
}

/**
 * Content-free observation of the exact ModelRequest handed to a provider.
 * Digests are diagnostic/cache evidence only: they carry no authority and
 * cannot be replayed into a later request.
 */
export interface PromptCacheRequestObservationV1 {
  version: typeof PROMPT_CACHE_OBSERVATION_VERSION;
  boundary: 'whole_instructions' | 'layered' | 'invalid';
  cacheEligible: boolean;
  policyRevision: string | null;
  layers: Record<PromptCacheLayerName, PromptCacheLayerObservation>;
  normalizedRequestDigest: string;
  normalizedInputBytes: number;
  issues: string[];
}

export type PromptCacheInvalidationBoundary =
  | 'cold'
  | 'transport'
  | 'policy'
  | 'turn_context'
  | 'memory_context'
  | 'catalog'
  | 'task'
  | 'none';

export interface PromptCacheTransitionV1 {
  version: typeof PROMPT_CACHE_OBSERVATION_VERSION;
  invalidatedAt: PromptCacheInvalidationBoundary;
  stablePrefixReusable: boolean;
  reusableLayers: PromptCacheLayerName[];
  changedLayers: PromptCacheLayerName[];
  reusableInputBytes: number;
}

export interface ProviderPromptCacheUsageV1 {
  version: typeof PROMPT_CACHE_OBSERVATION_VERSION;
  cacheDialect: 'inclusive' | 'exclusive' | 'none';
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
}

export const PROMPT_CACHE_LAYER_ORDER: readonly PromptCacheLayerName[] = [
  'transport',
  'stablePolicy',
  'turnContext',
  'memoryContext',
  'catalog',
  'task',
] as const;

export interface CanonicalPromptCacheRequestV1 {
  observation: PromptCacheRequestObservationV1;
  /** Exact normalized UTF-8 layer bytes. These may contain private prompt
   * content and must only be passed directly to an encrypted durable sink. */
  layers: Record<PromptCacheLayerName, string>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_number');
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (typeof value !== 'object') throw new Error('non_json_value');
  if (seen.has(value)) throw new Error('cyclic_value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function layer(bytes: string): PromptCacheLayerObservation {
  return { bytes: Buffer.byteLength(bytes, 'utf8'), sha256: sha256(bytes) };
}

function occurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  while ((at = value.indexOf(needle, at)) >= 0) {
    count += 1;
    at += needle.length;
  }
  return count;
}

/**
 * Normalize the actual provider-facing ModelRequest into ordered cache layers.
 * Arrays retain wire order; object keys are sorted only to remove construction
 * order noise. The exact counterpart below exposes these sensitive bytes only
 * so its caller can seal them in the authority-owned encrypted payload store.
 */
export function promptCacheNormalizedRequestDigest(input: {
  boundary: PromptCacheRequestObservationV1['boundary'];
  layers: Record<PromptCacheLayerName, string>;
}): string {
  return sha256(canonicalJson({
    version: PROMPT_CACHE_OBSERVATION_VERSION,
    boundary: input.boundary,
    layers: input.layers,
  }));
}

/** Exact counterpart to `observePromptCacheRequest`. Callers must immediately
 * seal `layers`; unlike the ordinary observation, these bytes are sensitive. */
export function canonicalPromptCacheRequest(request: ModelRequest): CanonicalPromptCacheRequestV1 {
  const instructions = request.systemInstructions ?? '';
  const issues: string[] = [];
  const breakCount = occurrences(instructions, CACHE_BREAK_SENTINEL);
  const memoryCount = occurrences(instructions, CACHE_MEMORY_CONTEXT_SENTINEL);
  const appendedMemoryCount = occurrences(instructions, CACHE_MEMORY_APPEND_SENTINEL);
  let boundary: PromptCacheRequestObservationV1['boundary'] = 'whole_instructions';
  let stablePolicy = instructions;
  let dynamic = '';

  if (breakCount === 1) {
    const exactAt = instructions.indexOf(INSTRUCTION_CACHE_DELIM);
    if (exactAt >= 0) {
      boundary = 'layered';
      stablePolicy = instructions.slice(0, exactAt);
      dynamic = instructions.slice(exactAt + INSTRUCTION_CACHE_DELIM.length);
    } else {
      boundary = 'invalid';
      issues.push('cache_break_not_canonical');
      const at = instructions.indexOf(CACHE_BREAK_SENTINEL);
      stablePolicy = instructions.slice(0, at);
      dynamic = instructions.slice(at + CACHE_BREAK_SENTINEL.length);
    }
  } else if (breakCount > 1) {
    boundary = 'invalid';
    issues.push('multiple_cache_breaks');
    const at = instructions.indexOf(CACHE_BREAK_SENTINEL);
    stablePolicy = instructions.slice(0, at);
    dynamic = instructions.slice(at + CACHE_BREAK_SENTINEL.length);
  }

  if (memoryCount > 1) issues.push('multiple_memory_boundaries');
  if (appendedMemoryCount > 1) issues.push('multiple_appended_memory_boundaries');
  if (memoryCount > 0 && boundary !== 'layered') issues.push('memory_boundary_without_cache_break');
  if (appendedMemoryCount > 0 && boundary !== 'layered') issues.push('appended_memory_without_cache_break');
  const dynamicLayers = splitCacheDynamicContext(dynamic);
  if (!stablePolicy.trim()) issues.push('empty_stable_policy');

  let catalogBytes = '';
  let taskBytes = '';
  let transportBytes = '';
  try {
    catalogBytes = canonicalJson({
      tools: request.tools,
      handoffs: request.handoffs,
      outputType: request.outputType,
      toolsExplicitlyProvided: request.toolsExplicitlyProvided,
    });
    taskBytes = canonicalJson({
      input: request.input,
      previousResponseId: request.previousResponseId,
      conversationId: request.conversationId,
    });
    transportBytes = canonicalJson({
      modelSettings: request.modelSettings,
      tracing: request.tracing,
    });
  } catch (error) {
    issues.push(`request_not_canonical_json:${error instanceof Error ? error.message : String(error)}`);
    catalogBytes = 'invalid';
    taskBytes = 'invalid';
    transportBytes = 'invalid';
  }

  const rawLayers: Record<PromptCacheLayerName, string> = {
    transport: transportBytes,
    stablePolicy,
    turnContext: dynamicLayers.turnContext,
    memoryContext: dynamicLayers.memoryContext,
    catalog: catalogBytes,
    task: taskBytes,
  };
  const layers = Object.fromEntries(
    PROMPT_CACHE_LAYER_ORDER.map((name) => [name, layer(rawLayers[name])]),
  ) as Record<PromptCacheLayerName, PromptCacheLayerObservation>;
  const normalizedRequestDigest = promptCacheNormalizedRequestDigest({ boundary, layers: rawLayers });
  const normalizedInputBytes = PROMPT_CACHE_LAYER_ORDER
    .filter((name) => name !== 'transport')
    .reduce((sum, name) => sum + layers[name].bytes, 0);
  const cacheEligible = boundary !== 'invalid' && issues.length === 0;

  return {
    observation: {
      version: PROMPT_CACHE_OBSERVATION_VERSION,
      boundary,
      cacheEligible,
      policyRevision: cacheEligible ? layers.stablePolicy.sha256 : null,
      layers,
      normalizedRequestDigest,
      normalizedInputBytes,
      issues,
    },
    layers: rawLayers,
  };
}

export function observePromptCacheRequest(request: ModelRequest): PromptCacheRequestObservationV1 {
  return canonicalPromptCacheRequest(request).observation;
}

export function comparePromptCacheRequests(
  previous: PromptCacheRequestObservationV1 | null | undefined,
  current: PromptCacheRequestObservationV1,
): PromptCacheTransitionV1 {
  const changedLayers = previous
    ? PROMPT_CACHE_LAYER_ORDER.filter((name) => previous.layers[name].sha256 !== current.layers[name].sha256)
    : [...PROMPT_CACHE_LAYER_ORDER];
  let invalidatedAt: PromptCacheInvalidationBoundary = 'none';
  let reusableCount = PROMPT_CACHE_LAYER_ORDER.length;
  if (!previous) {
    invalidatedAt = 'cold';
    reusableCount = 0;
  } else if (changedLayers.includes('transport')) {
    invalidatedAt = 'transport';
    reusableCount = 0;
  } else if (!previous.cacheEligible || !current.cacheEligible || changedLayers.includes('stablePolicy')) {
    invalidatedAt = 'policy';
    reusableCount = 0;
  } else if (changedLayers.includes('turnContext')) {
    invalidatedAt = 'turn_context';
    reusableCount = 2;
  } else if (changedLayers.includes('memoryContext')) {
    invalidatedAt = 'memory_context';
    reusableCount = 3;
  } else if (changedLayers.includes('catalog')) {
    invalidatedAt = 'catalog';
    reusableCount = 4;
  } else if (changedLayers.includes('task')) {
    invalidatedAt = 'task';
    reusableCount = 5;
  }
  const reusableLayers = PROMPT_CACHE_LAYER_ORDER.slice(0, reusableCount);
  return {
    version: PROMPT_CACHE_OBSERVATION_VERSION,
    invalidatedAt,
    stablePrefixReusable: reusableLayers.includes('stablePolicy'),
    reusableLayers: [...reusableLayers],
    changedLayers,
    reusableInputBytes: reusableLayers
      .filter((name) => name !== 'transport')
      .reduce((sum, name) => sum + current.layers[name].bytes, 0),
  };
}

/** Strict adapter/provider receipt parser. No dialect is inferred from token
 * magnitudes or provider name. Invalid or internally inconsistent data is not
 * certifiable and is therefore omitted from release evidence. */
export function parseProviderPromptCacheUsage(value: unknown): ProviderPromptCacheUsageV1 | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.version !== PROMPT_CACHE_OBSERVATION_VERSION) return null;
  if (row.cacheDialect !== 'inclusive' && row.cacheDialect !== 'exclusive' && row.cacheDialect !== 'none') return null;
  const fields = ['inputTokens', 'cachedInputTokens', 'uncachedInputTokens'] as const;
  if (fields.some((name) => typeof row[name] !== 'number'
    || !Number.isSafeInteger(row[name])
    || (row[name] as number) < 0)) return null;
  const inputTokens = row.inputTokens as number;
  const cachedInputTokens = row.cachedInputTokens as number;
  const uncachedInputTokens = row.uncachedInputTokens as number;
  if (row.cacheDialect === 'inclusive' && inputTokens !== cachedInputTokens + uncachedInputTokens) return null;
  if (row.cacheDialect === 'exclusive' && inputTokens !== uncachedInputTokens) return null;
  if (row.cacheDialect === 'none' && cachedInputTokens !== 0) return null;
  return {
    version: PROMPT_CACHE_OBSERVATION_VERSION,
    cacheDialect: row.cacheDialect,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
  };
}
