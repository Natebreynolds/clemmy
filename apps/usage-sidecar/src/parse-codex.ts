import { canonicalCacheAccounting, num } from './accounting.js';
import type { CanonicalCall } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseCodexTokenUsage(line: unknown, rootSessionId: string): CanonicalCall | null {
  const row = asRecord(line);
  if (!row || row.type !== 'token_usage_record') return null;
  const payload = asRecord(row.payload);
  const usage = asRecord(payload?.usage);
  if (!usage) return null;
  const at = typeof row.timestamp === 'string' ? row.timestamp : '';
  if (!at) return null;
  const threadId = typeof payload?.thread_id === 'string' && payload.thread_id
    ? payload.thread_id
    : rootSessionId;
  const responseId = typeof payload?.response_id === 'string' && payload.response_id
    ? payload.response_id
    : `${threadId}:${at}`;
  const input = num(usage.input_tokens);
  const cached = num(usage.cached_input_tokens);
  const cacheWrite = num(usage.cache_write_input_tokens);
  const output = num(usage.output_tokens);
  const reasoning = num(usage.reasoning_output_tokens);
  const total = num(usage.total_tokens);
  const accounted = canonicalCacheAccounting({
    cacheDialect: 'inclusive',
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationInputTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
  });
  return {
    id: responseId,
    at,
    lane: 'native',
    source: 'codex',
    sessionId: threadId,
    rootSessionId: threadId,
    model: typeof payload?.model === 'string' ? payload.model : '',
    inputTokens: input,
    cachedReadTokens: accounted.cachedReadTokens,
    cacheWriteTokens: accounted.cacheWriteTokens,
    outputTokens: output,
    reasoningTokens: reasoning,
    promptTokens: accounted.promptTokens,
    uncachedWorkTokens: accounted.uncachedWorkTokens,
    hitRate: accounted.hitRate,
    certified: accounted.certified,
  };
}

export function codexModelFromLine(line: unknown): string | undefined {
  const row = asRecord(line);
  if (!row) return undefined;
  const payload = asRecord(row.payload);
  if (typeof payload?.model === 'string' && payload.model.trim()) return payload.model.trim();
  const nested = asRecord(payload?.info) ?? asRecord(row.info);
  if (typeof nested?.model === 'string' && nested.model.trim()) return nested.model.trim();
  return undefined;
}