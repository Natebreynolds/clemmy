/**
 * Refused attempts for one accepted source — the clean-attempt measurement.
 *
 * NEITHER evidence source alone is sufficient, which is why two candidates in a
 * row were reported as "zero refused attempts" when they were not:
 *
 *   C19 create (source 137172): `tool_attempt_settled` 137198 carries
 *     executionKind `refused_pre_dispatch` / kind `invalid_arguments`, with NO
 *     ok:false anywhere and NO guardrail row. A counter reading tool returns
 *     misses it entirely.
 *   C17 create: the schema-reader refusal produced `guardrail_tripped` 136993
 *     with kind `refused_pre_dispatch` and NO settlement row at all. A counter
 *     reading settlements misses that one.
 *
 * So: union both, and deduplicate on the logical call so one refusal that
 * happens to emit both forms is counted once.
 */
import { listEvents } from './eventlog.js';

/** Canonical execution kinds that mean "this attempt did not cross". */
const REFUSED_EXECUTION_KINDS: ReadonlySet<string> = new Set([
  'refused_pre_dispatch',
  'refused',
  'rejected',
]);

export interface RefusedAttempt {
  seq: number;
  source: 'settlement' | 'guardrail';
  logicalToolCallId: string;
  tool: string;
  kind: string;
}

export function sourceRefusedAttempts(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { count: number; attempts: readonly RefusedAttempt[] } {
  const byLogicalCall = new Map<string, RefusedAttempt>();
  const record = (attempt: RefusedAttempt): void => {
    // Dedupe on the logical call; a settlement is preferred over a guardrail
    // for the same call because it carries the canonical kind.
    const existing = byLogicalCall.get(attempt.logicalToolCallId);
    if (existing && existing.source === 'settlement') return;
    byLogicalCall.set(attempt.logicalToolCallId, attempt);
  };
  try {
    for (const event of listEvents(input.sessionId, {
      types: ['tool_attempt_settled', 'guardrail_tripped'],
    })) {
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || data.sourceUserSeq !== input.sourceUserSeq) continue;
      const logical = typeof data.logicalToolCallId === 'string' && data.logicalToolCallId
        ? data.logicalToolCallId
        : typeof data.callId === 'string' && data.callId
          ? data.callId
          : `seq:${event.seq}`;
      const tool = typeof data.tool === 'string' ? data.tool : '';
      if (event.type === 'tool_attempt_settled') {
        const executionKind = String(data.executionKind ?? '');
        if (!REFUSED_EXECUTION_KINDS.has(executionKind)) continue;
        record({
          seq: event.seq, source: 'settlement', logicalToolCallId: logical, tool,
          kind: String(data.kind ?? executionKind),
        });
        continue;
      }
      // guardrail_tripped: only the pre-dispatch refusal shape counts. Other
      // guardrails (no_progress_decision, budget notices) are not attempts.
      const kind = String(data.kind ?? '');
      if (!REFUSED_EXECUTION_KINDS.has(kind)) continue;
      record({ seq: event.seq, source: 'guardrail', logicalToolCallId: logical, tool, kind });
    }
  } catch {
    return { count: 0, attempts: [] };
  }
  const attempts = [...byLogicalCall.values()].sort((left, right) => left.seq - right.seq);
  return { count: attempts.length, attempts };
}
