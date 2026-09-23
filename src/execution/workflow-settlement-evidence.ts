import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';

type SettlementRow = {
  sessionId: string; sourceUserSeq: number; callId: string; tool: string;
  argumentDigest: string; executionKind: string; outcome: string;
  mutating: number; resultHandleId: string | null; settlementEventId: string;
};

/** Immutable dispatch facts, not child-authored prose or inferred success.
 * The namespace is deliberately explicit: absent rows cannot prove that no
 * legacy/partition-owned work happened. No provider payload enters the prompt. */
export function readWorkflowSettlementEvidence(runId: string, db?: ReturnType<typeof openEventLog>) {
  try {
    if (!runId.trim()) throw new Error('missing run identity');
    const prefix = `workflow:${runId}:`;
    const rows = (db ?? openEventLog()).prepare(`
      SELECT s.session_id AS sessionId, s.source_user_seq AS sourceUserSeq,
             s.logical_tool_call_id AS callId, l.tool_name AS tool,
             l.argument_digest AS argumentDigest, s.execution_kind AS executionKind,
             s.outcome_kind AS outcome, s.mutating, s.result_handle_id AS resultHandleId,
             s.settlement_event_id AS settlementEventId
        FROM logical_call_settlements s
        JOIN logical_tool_calls l ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq AND l.logical_tool_call_id = s.logical_tool_call_id
        JOIN events source ON source.session_id = s.session_id AND source.seq = s.source_user_seq
         AND source.type = 'user_input_received' AND source.role = 'user'
       WHERE substr(s.session_id, 1, ?) = ?
       ORDER BY s.session_id, s.source_user_seq, s.logical_tool_call_id
    `).all(prefix.length, prefix) as SettlementRow[];
    const grouped = new Map<string, { tool: string; executionKind: string; outcome: string; mutating: boolean; calls: number }>();
    for (const row of rows) {
      const fact = { tool: row.tool, executionKind: row.executionKind, outcome: row.outcome, mutating: row.mutating === 1 };
      const key = JSON.stringify(fact);
      const existing = grouped.get(key);
      if (existing) existing.calls++;
      else grouped.set(key, { ...fact, calls: 1 });
    }
    const groups = [...grouped.values()];
    return {
      available: true,
      coverage: 'run_session_namespace' as const,
      ledgerDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      settledCalls: rows.length,
      groups: groups.slice(0, 40),
      omittedGroups: Math.max(0, groups.length - 40),
      meaning: 'Recorded tool settlements, including writes. Successful execution does not prove correct content or preservation. Missing or omitted calls do not prove unchanged external state; legacy and shared partition sessions are outside this namespace.',
    };
  } catch {
    return { available: false, coverage: 'run_session_namespace' as const,
      meaning: 'Tool settlement evidence unavailable. Do not infer that no writes or refreshes happened.' };
  }
}
