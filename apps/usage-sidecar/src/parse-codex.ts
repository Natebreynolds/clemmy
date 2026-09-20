import { canonicalCacheAccounting, num } from './accounting.js';
import type { CanonicalCall } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface CodexFileMeta {
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  model?: string;
  isSubagent?: boolean;
  agentId?: string;
}

export function updateCodexMeta(line: unknown, meta: CodexFileMeta): CodexFileMeta {
  const row = asRecord(line);
  if (!row) return meta;
  const payload = asRecord(row.payload);
  if (!payload) return meta;
  const next = { ...meta };
  if (typeof payload.session_id === 'string' && payload.session_id) next.sessionId = payload.session_id;
  if (typeof payload.id === 'string' && payload.id && row.type === 'session_meta') next.threadId = payload.id;
  if (typeof payload.parent_thread_id === 'string' && payload.parent_thread_id) {
    next.parentThreadId = payload.parent_thread_id;
  }
  if (payload.thread_source === 'subagent' || asRecord(payload.source)?.subagent) next.isSubagent = true;
  if (typeof payload.agent_nickname === 'string' && payload.agent_nickname) next.agentId = payload.agent_nickname;
  if (typeof payload.model === 'string' && payload.model.trim()) next.model = payload.model.trim();
  const collab = asRecord(payload.collaboration_mode);
  const settings = asRecord(collab?.settings);
  if (typeof settings?.model === 'string' && settings.model.trim()) next.model = settings.model.trim();
  return next;
}

export function parseCodexTokenUsage(line: unknown, meta: CodexFileMeta, fileRoot: string): CanonicalCall | null {
  const row = asRecord(line);
  if (!row || row.type !== 'token_usage_record') return null;
  const payload = asRecord(row.payload);
  const usage = asRecord(payload?.usage);
  if (!usage) return null;
  const at = typeof row.timestamp === 'string' ? row.timestamp : '';
  if (!at) return null;
  const threadId = typeof payload?.thread_id === 'string' && payload.thread_id
    ? payload.thread_id
    : (meta.threadId ?? fileRoot);
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id
    ? payload.session_id
    : (meta.sessionId ?? threadId);
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
  const isSubagent = meta.isSubagent === true
    || Boolean(meta.parentThreadId && meta.parentThreadId !== threadId)
    || (sessionId !== threadId);
  return {
    id: responseId,
    at,
    lane: 'native',
    source: 'codex',
    sessionId: threadId,
    rootSessionId: sessionId,
    model: (typeof payload?.model === 'string' && payload.model.trim()) || meta.model || '',
    agentId: meta.agentId,
    isSubagent,
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
  const collab = asRecord(payload?.collaboration_mode);
  const settings = asRecord(collab?.settings);
  if (typeof settings?.model === 'string' && settings.model.trim()) return settings.model.trim();
  return undefined;
}