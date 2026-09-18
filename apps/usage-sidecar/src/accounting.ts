import type { CacheDialect } from './types.js';

export interface CanonicalUsage {
  dialect: CacheDialect;
  certified: boolean;
  invalid: boolean;
  promptTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  uncachedWorkTokens: number;
  hitRate: number;
}

const finite = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);

/**
 * Same debit rules as Clementine `canonicalCacheAccounting`, plus cache-write
 * as a separate first-turn tax. Exclusive Claude samples include cache writes
 * in prompt size (context the model saw) but not in uncached work.
 */
export function canonicalCacheAccounting(event: {
  cacheDialect?: CacheDialect;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}): CanonicalUsage {
  const dialect = event.cacheDialect ?? 'unknown';
  const input = event.inputTokens ?? 0;
  const cached = event.cachedInputTokens ?? 0;
  const cacheWrite = event.cacheCreationInputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  const reasoning = event.reasoningTokens ?? 0;
  const total = event.totalTokens ?? 0;
  const conservativeFloor = Math.max(
    finite(total),
    finite(input) + finite(output),
    finite(cached),
    finite(output),
  );
  const invalid = (base: Partial<CanonicalUsage> = {}): CanonicalUsage => ({
    dialect, certified: false, invalid: true,
    promptTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0,
    uncachedInputTokens: 0, uncachedWorkTokens: conservativeFloor, hitRate: 0, ...base,
  });
  for (const value of [input, cached, cacheWrite, output, reasoning, total]) {
    if (!Number.isFinite(value) || value < 0) return invalid();
  }
  if (dialect === 'inclusive') {
    if (cached > input) return invalid();
    const promptTokens = input;
    return {
      dialect, certified: true, invalid: false,
      promptTokens,
      cachedReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      uncachedInputTokens: input - cached,
      uncachedWorkTokens: Math.max(total, input + output) - cached,
      hitRate: promptTokens > 0 ? cached / promptTokens : 0,
    };
  }
  if (dialect === 'exclusive') {
    const promptTokens = input + cached + cacheWrite;
    return {
      dialect, certified: true, invalid: false,
      promptTokens,
      cachedReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      uncachedInputTokens: input,
      uncachedWorkTokens: input + output + reasoning,
      hitRate: promptTokens > 0 ? cached / promptTokens : 0,
    };
  }
  if (dialect === 'none') {
    if (cached > 0) return invalid();
    return {
      dialect, certified: true, invalid: false,
      promptTokens: input,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: input,
      uncachedWorkTokens: Math.max(total, input + output),
      hitRate: 0,
    };
  }
  return {
    dialect: 'unknown', certified: false, invalid: false,
    promptTokens: Math.max(input, cached),
    cachedReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    uncachedInputTokens: input,
    uncachedWorkTokens: Math.max(total, input + output),
    hitRate: 0,
  };
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
