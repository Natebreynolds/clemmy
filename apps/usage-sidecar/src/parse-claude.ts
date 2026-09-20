import { canonicalCacheAccounting, num } from './accounting.js';
import type { CanonicalCall, NativeSource } from './types.js';

export interface ClaudeFileMeta {
  sessionId?: string;
  entrypoint?: string;
  promptSource?: string;
  cwd?: string;
  model?: string;
  agentId?: string;
  isSidechain?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isSdkSession(meta: ClaudeFileMeta): boolean {
  const entry = (meta.entrypoint ?? '').toLowerCase();
  const prompt = (meta.promptSource ?? '').toLowerCase();
  return entry === 'sdk-cli' || entry.startsWith('sdk') || prompt === 'sdk';
}

export function updateClaudeMeta(line: unknown, meta: ClaudeFileMeta): ClaudeFileMeta {
  const row = asRecord(line);
  if (!row) return meta;
  const next = { ...meta };
  const sessionId = typeof row.sessionId === 'string' && row.sessionId
    ? row.sessionId
    : (typeof row.session_id === 'string' ? row.session_id : '');
  if (sessionId) next.sessionId = sessionId;
  if (typeof row.entrypoint === 'string' && row.entrypoint) next.entrypoint = row.entrypoint;
  if (typeof row.promptSource === 'string' && row.promptSource) next.promptSource = row.promptSource;
  if (typeof row.cwd === 'string' && row.cwd) next.cwd = row.cwd;
  if (typeof row.agentId === 'string' && row.agentId) next.agentId = row.agentId;
  if (row.isSidechain === true) next.isSidechain = true;
  const message = asRecord(row.message);
  if (typeof message?.model === 'string' && message.model) next.model = message.model;
  return next;
}

function thinkingTokens(usage: Record<string, unknown>): number {
  const details = asRecord(usage.output_tokens_details);
  return num(details?.thinking_tokens);
}

export function parseClaudeAssistantUsage(
  line: unknown,
  meta: ClaudeFileMeta,
  opts: { source: NativeSource; rootSessionId: string; skipSdk: boolean; fromSubagentPath?: boolean },
): CanonicalCall | null {
  const row = asRecord(line);
  if (!row || row.type !== 'assistant') return null;
  const message = asRecord(row.message);
  const usage = asRecord(message?.usage);
  if (!usage) return null;
  const messageId = typeof message?.id === 'string' && message.id ? message.id : undefined;
  if (!messageId) return null;
  const merged = updateClaudeMeta(row, meta);
  if (opts.skipSdk && isSdkSession(merged)) return null;
  const at = typeof row.timestamp === 'string' && row.timestamp
    ? row.timestamp
    : typeof row._audit_timestamp === 'string' ? row._audit_timestamp : '';
  if (!at) return null;
  const sessionId = typeof row.sessionId === 'string' && row.sessionId
    ? row.sessionId
    : (typeof row.session_id === 'string' && row.session_id
      ? row.session_id
      : (merged.sessionId ?? opts.rootSessionId));
  const agentId = typeof row.agentId === 'string' && row.agentId
    ? row.agentId
    : merged.agentId;
  const isSubagent = row.isSidechain === true
    || merged.isSidechain === true
    || opts.fromSubagentPath === true
    || Boolean(agentId);
  const accounted = canonicalCacheAccounting({
    cacheDialect: 'exclusive',
    inputTokens: num(usage.input_tokens),
    cachedInputTokens: num(usage.cache_read_input_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
    outputTokens: num(usage.output_tokens),
    reasoningTokens: thinkingTokens(usage),
  });
  const model = typeof message?.model === 'string' ? message.model : (merged.model ?? '');
  return {
    id: messageId,
    at,
    lane: 'native',
    source: opts.source,
    sessionId,
    rootSessionId: sessionId || opts.rootSessionId,
    model,
    agentId,
    isSubagent,
    entrypoint: merged.entrypoint,
    promptSource: merged.promptSource,
    cwd: merged.cwd,
    inputTokens: num(usage.input_tokens),
    cachedReadTokens: accounted.cachedReadTokens,
    cacheWriteTokens: accounted.cacheWriteTokens,
    outputTokens: num(usage.output_tokens),
    reasoningTokens: thinkingTokens(usage),
    promptTokens: accounted.promptTokens,
    uncachedWorkTokens: accounted.uncachedWorkTokens,
    hitRate: accounted.hitRate,
    certified: accounted.certified,
  };
}

export function claudeRootSessionId(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  const file = parts[parts.length - 1] ?? '';
  const sub = parts.indexOf('subagents');
  if (sub > 0) return parts[sub - 1] ?? file.replace(/\.jsonl$/, '');
  const local = [...parts].reverse().find((p) => /^local_[0-9a-f-]+$/i.test(p));
  if (local) return local.replace(/^local_/i, '');
  if (file.endsWith('.jsonl')) return file.replace(/\.jsonl$/, '');
  return file;
}
