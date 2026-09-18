import { canonicalCacheAccounting, num } from './accounting.js';
import type { CanonicalCall } from './types.js';

const CHAT_KINDS = new Set(['chat']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isClementineChatKind(kind: string | undefined): boolean {
  return CHAT_KINDS.has(kind ?? '');
}

export function parseClementineUsage(line: unknown): CanonicalCall | null {
  const row = asRecord(line);
  if (!row) return null;
  const at = typeof row.at === 'string' ? row.at : '';
  const source = typeof row.source === 'string' ? row.source : '';
  const model = typeof row.model === 'string' ? row.model : '';
  if (!at || !source) return null;
  const trace = asRecord(row.trace);
  const brain = typeof trace?.brain === 'string' ? trace.brain : undefined;
  const canonical = asRecord(row.canonical);
  const accounted = canonical && typeof canonical.uncachedWorkTokens === 'number'
    ? {
        certified: canonical.certified === true,
        promptTokens: num(canonical.promptTokens),
        cachedReadTokens: num(canonical.cachedReadTokens),
        uncachedWorkTokens: num(canonical.uncachedWorkTokens),
        hitRate: num(canonical.promptTokens) > 0
          ? num(canonical.cachedReadTokens) / num(canonical.promptTokens)
          : 0,
        cacheWriteTokens: num(row.cacheCreationInputTokens),
      }
    : (() => {
        const raw = canonicalCacheAccounting({
          cacheDialect: row.cacheDialect === 'inclusive' || row.cacheDialect === 'exclusive'
            || row.cacheDialect === 'none' || row.cacheDialect === 'unknown'
            ? row.cacheDialect
            : 'unknown',
          inputTokens: num(row.inputTokens),
          cachedInputTokens: num(row.cachedInputTokens),
          cacheCreationInputTokens: num(row.cacheCreationInputTokens),
          outputTokens: num(row.outputTokens),
          reasoningTokens: num(row.reasoningTokens),
          totalTokens: num(row.totalTokens),
        });
        return raw;
      })();
  const promptComponents = asRecord(row.promptComponents) as Record<string, number> | null;
  const responseId = typeof row.responseId === 'string' && row.responseId
    ? row.responseId
    : `${source}:${at}`;
  return {
    id: responseId,
    at,
    lane: 'clementine',
    source: 'clementine',
    sessionId: source,
    rootSessionId: source,
    model,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    brain,
    inputTokens: num(row.inputTokens),
    cachedReadTokens: accounted.cachedReadTokens,
    cacheWriteTokens: 'cacheWriteTokens' in accounted ? accounted.cacheWriteTokens : num(row.cacheCreationInputTokens),
    outputTokens: num(row.outputTokens),
    reasoningTokens: num(row.reasoningTokens),
    promptTokens: accounted.promptTokens,
    uncachedWorkTokens: accounted.uncachedWorkTokens,
    hitRate: accounted.hitRate,
    certified: accounted.certified,
    promptComponents: promptComponents ?? undefined,
  };
}

export function clementineBrainMatches(pairing: 'claude' | 'codex', brain: string | undefined): boolean {
  if (!brain) return false;
  return brain === pairing;
}
