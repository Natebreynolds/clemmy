import path from 'node:path';
import Database from 'better-sqlite3';

export interface AcceptedTaskWorkflowCandidateInventory {
  /** Claimed workflow work only. These rows never establish usage ownership. */
  candidates: Array<{ parentAcceptedSource: string; sourceGroupId: string | null; runIds: string[]; dispatchSeq: number }>;
  issues: string[];
}

const MAX_SOURCES = 128;
const MAX_RUN_IDS = 128;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// Session identity is a bound SQL value, never a path or executable metadata
// identifier. Preserve established literal IDs, including '+' and Unicode.
const safeSessionId = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_.:%-]+$/.test(value)
  && value !== '.' && value !== '..';
const safeRunId = (value: unknown): value is string => safeId(value) && /^[A-Za-z0-9_.:-]+$/.test(value);
const parseRecord = (raw: string): Record<string, unknown> | null => {
  try { const value: unknown = JSON.parse(raw); return isRecord(value) ? value : null; } catch { return null; }
};

/**
 * Read-only, explicit-home candidate inventory. A host-parented dispatch is a
 * useful warning about potentially uncounted work, not an authority receipt.
 * Do not add its sources or usage to canonical totals. That requires the FULL
 * shared seal/activation/member/queue + step-source/attempt proof, including
 * valid settlement/tombstone retention and conflicting direct-record checks.
 * This intentionally neither copies a weaker group decoder nor imports the
 * runtime singleton, scans run files, chooses a latest source, or repairs data.
 */
export function readAcceptedTaskWorkflowCandidates(home: string,
  acceptedSources: readonly { sessionId: string; sourceUserSeq: number }[]): AcceptedTaskWorkflowCandidateInventory {
  const candidates: AcceptedTaskWorkflowCandidateInventory['candidates'] = [];
  const issues = new Set<string>();
  const sources = new Map<string, { sessionId: string; sourceUserSeq: number }>();
  for (const source of acceptedSources) {
    if (!safeSessionId(source?.sessionId) || !Number.isSafeInteger(source?.sourceUserSeq) || source.sourceUserSeq <= 0) {
      issues.add('workflow_candidate_invalid_accepted_source'); continue;
    }
    const key = JSON.stringify([source.sessionId, source.sourceUserSeq]);
    if (sources.has(key)) continue;
    if (sources.size >= MAX_SOURCES) { issues.add('workflow_candidate_sources_omitted'); break; }
    sources.set(key, source);
  }
  if (!sources.size) return { candidates, issues: [...issues] };
  let db: Database.Database;
  try { db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true, fileMustExist: true, timeout: 5_000 }); }
  catch { return { candidates, issues: [...issues, 'workflow_candidate_store_unavailable'] }; }
  try {
    db.pragma('query_only = ON');
    const columns = new Set((db.pragma('table_info(events)') as Array<{ name: string }>).map(row => row.name));
    if (!['seq', 'session_id', 'turn', 'role', 'type', 'data_json'].every(name => columns.has(name))) {
      return { candidates, issues: [...issues, 'workflow_candidate_schema_or_inventory_unavailable'] };
    }
    const hasParentSchema = columns.has('id') && columns.has('parent_event_id');
    const sourceQuery = db.prepare(`SELECT ${columns.has('id') ? 'id' : 'NULL AS id'}, seq, turn, role, type, data_json FROM events
      WHERE session_id = ? AND seq = ? LIMIT 2`);
    // The claim branch catches a foreign-parent row naming this exact source.
    // CASE avoids evaluating JSON extraction against malformed unrelated rows.
    const dispatchQuery = db.prepare(`SELECT seq, turn, role, ${hasParentSchema ? 'parent_event_id' : 'NULL AS parent_event_id'}, data_json FROM events
      WHERE session_id = ? AND type = 'async_work_dispatched'
        AND (${hasParentSchema ? 'parent_event_id = ? OR ' : ''}CASE WHEN json_valid(data_json)
          THEN json_extract(data_json, '$.sourceUserSeq') = ? ELSE 0 END)
      ORDER BY seq LIMIT 2`);
    db.transaction(() => {
      for (const source of sources.values()) {
        const parentAcceptedSource = `${source.sessionId}:${source.sourceUserSeq}`;
        const reject = (reason: string) => issues.add(`workflow_candidate_${reason}:${parentAcceptedSource}`);
        const rows = sourceQuery.all(source.sessionId, source.sourceUserSeq) as Array<{
          id: string | null; seq: number; turn: number; role: string; type: string; data_json: string;
        }>;
        if (rows.length !== 1) { reject(rows.length ? 'source_ambiguous' : 'source_unavailable'); continue; }
        const row = rows[0]!;
        const sourceData = parseRecord(row.data_json);
        if (row.role !== 'user' || row.type !== 'user_input_received'
          || !Number.isSafeInteger(row.turn) || row.turn < 0 || !sourceData) {
          reject('human_source_unavailable'); continue;
        }
        const dispatches = dispatchQuery.all(...(hasParentSchema
          ? [source.sessionId, row.id, source.sourceUserSeq] : [source.sessionId, source.sourceUserSeq])) as Array<{
          seq: number; turn: number; role: string; parent_event_id: string | null; data_json: string;
        }>;
        if (!dispatches.length) continue;
        // Canonical accounting can independently prove synthetic approval
        // continuations. With no async claim this optional inventory must not
        // override that proof; an actual synthetic workflow claim stays unknown.
        if (sourceData.synthetic === true) { reject('human_source_unavailable'); continue; }
        if (dispatches.length !== 1) { reject('dispatch_ambiguous'); continue; }
        // Historical ordinary tasks did not require these optional async
        // columns. Only an observed claim makes their absence relevant.
        if (!hasParentSchema || !safeId(row.id)) { reject('dispatch_parent_schema_unavailable'); continue; }
        const event = dispatches[0]!;
        const data = parseRecord(event.data_json);
        if (!Number.isSafeInteger(event.seq) || event.seq <= source.sourceUserSeq || event.role !== 'system'
          || event.turn !== row.turn || event.parent_event_id !== row.id || !data
          || data.sourceUserSeq !== source.sourceUserSeq) { reject('dispatch_binding_unavailable'); continue; }
        if (data.version !== 2 || data.kind !== 'workflow_run_group' || data.status !== 'dispatched'
          || !safeId(data.sourceGroupId) || !Array.isArray(data.runIds) || !data.runIds.length
          || data.runIds.length > MAX_RUN_IDS || !data.runIds.every(safeRunId)
          || new Set(data.runIds).size !== data.runIds.length) { reject('dispatch_metadata_unavailable'); continue; }
        candidates.push({ parentAcceptedSource, sourceGroupId: data.sourceGroupId,
          runIds: [...data.runIds] as string[], dispatchSeq: event.seq });
      }
    })();
    if (candidates.length) issues.add('workflow_candidate_authority_and_usage_unproved');
    return { candidates, issues: [...issues] };
  } catch {
    // Missing/older schemas and corrupt stores remain explicit unknowns. Never
    // mutate a measurement home to make an optional candidate query succeed.
    return { candidates: [], issues: [...issues, 'workflow_candidate_schema_or_inventory_unavailable'] };
  } finally { db.close(); }
}
