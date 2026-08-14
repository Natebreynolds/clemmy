/**
 * Read-only gauntlet trace for recent chat turns.
 *
 * For each accepted source, prints the ask, the frozen contract shape, every
 * settlement (carrier / execution kind / outcome), the recorded operations,
 * the resolution verdict, receipts, and the terminal — so a blocked or wrong
 * turn names its deciding gate in one glance instead of a forensic session.
 *
 *   npx tsx scripts/turn-trace.ts            # last 10 accepted sources
 *   npx tsx scripts/turn-trace.ts 25         # last 25
 *   CLEMENTINE_HOME=... npx tsx scripts/turn-trace.ts
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.CLEMENTINE_HOME ?? path.join(os.homedir(), '.clementine-next');
const DB_PATH = path.join(HOME, 'state', 'harness.db');
const LIMIT = Math.max(1, Math.min(200, Number(process.argv[2]) || 10));

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

interface SourceRow {
  session_id: string;
  seq: number;
  created_at: string;
  data_json: string;
}

const sources = db.prepare(`
  SELECT a.session_id, a.source_user_seq AS seq, e.created_at, e.data_json
    FROM accepted_task_authority a
    JOIN events e
      ON e.session_id = a.session_id AND e.seq = a.source_user_seq
   ORDER BY a.source_user_seq DESC
   LIMIT ?
`).all(LIMIT) as SourceRow[];

function preview(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function rows<T>(sql: string, ...params: unknown[]): T[] {
  try { return db.prepare(sql).all(...params) as T[]; } catch { return []; }
}

for (const source of sources.reverse()) {
  const ask = preview((JSON.parse(source.data_json) as { text?: string }).text ?? '');
  console.log(`\n━━ seq ${source.seq} · ${source.created_at} · ${source.session_id}`);
  console.log(`   ask: ${ask}`);

  const graph = rows<{ data_json: string }>(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = 'turn_graph_compiled'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `, source.session_id, source.seq)[0];
  if (graph) {
    const g = JSON.parse(graph.data_json) as { route?: string; fastPath?: string; effectCeiling?: string };
    console.log(`   route: ${g.route ?? '?'} · fastPath ${g.fastPath ?? '-'} · ceiling ${g.effectCeiling ?? '-'}`);
  }

  const contract = rows<{ contract_json: string }>(`
    SELECT contract_json FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `, source.session_id, source.seq)[0];
  if (contract) {
    const parsed = JSON.parse(contract.contract_json) as {
      plannerSource?: string;
      operations?: Array<{ id: string; effect: string; coverage?: string; cardinality?: { kind?: string } }>;
    };
    const ops = (parsed.operations ?? [])
      .map((op) => `${op.id}[${op.effect}/${op.coverage ?? '-'}/${op.cardinality?.kind ?? '-'}]`)
      .join(' ');
    console.log(`   contract: ${parsed.plannerSource ?? '?'} · ${ops || '(zero operations)'}`);
  } else {
    console.log('   contract: (none frozen)');
  }

  for (const s of rows<Record<string, unknown>>(`
    SELECT l.tool_name, s.execution_kind, s.outcome_kind, s.business_call,
           s.continues_requirement, s.observer_lane, s.physical_crossing_count,
           s.host_crossing_count, s.result_handle_id
      FROM logical_call_settlements s
      JOIN logical_tool_calls l
        ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
       AND l.logical_tool_call_id = s.logical_tool_call_id
     WHERE s.session_id = ? AND s.source_user_seq = ?
  `, source.session_id, source.seq)) {
    console.log(
      `   settle: ${s.tool_name} · ${s.execution_kind} · ${s.outcome_kind}`
      + ` · biz=${s.business_call}${s.continues_requirement ? ' · CONTINUES' : ''}`
      + ` · lane=${s.observer_lane} · xing p${s.physical_crossing_count}/h${s.host_crossing_count ?? 0}`
      + ` · handle=${s.result_handle_id ? 'yes' : 'NO'}`,
    );
  }

  for (const o of rows<Record<string, unknown>>(`
    SELECT operation_id, graph_node_id, resolved_tool, effect_kind, outcome_kind, dispatch_state
      FROM accepted_task_operations WHERE session_id = ? AND source_user_seq = ?
  `, source.session_id, source.seq)) {
    console.log(
      `   op: ${o.graph_node_id} ← ${o.resolved_tool} · effect=${o.effect_kind}`
      + ` · ${o.outcome_kind} · dispatch=${o.dispatch_state}`,
    );
  }

  const resolution = rows<Record<string, unknown>>(`
    SELECT state, operation_count, expectations_satisfied
      FROM accepted_task_resolutions WHERE session_id = ? AND source_user_seq = ?
  `, source.session_id, source.seq)[0];
  const finalizedEvent = rows<{ data_json: string }>(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = 'resolution_finalized'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `, source.session_id, source.seq)[0];
  const match = finalizedEvent
    ? (JSON.parse(finalizedEvent.data_json) as { expectedWorkMatch?: string }).expectedWorkMatch
    : undefined;
  console.log(
    `   resolution: ${resolution ? `${resolution.state} · ops=${resolution.operation_count}`
      + ` · satisfied=${resolution.expectations_satisfied}` : '(none)'}${match ? ` · match=${match}` : ''}`,
  );

  for (const r of rows<Record<string, unknown>>(`
    SELECT kind, obligation, node_id FROM evidence_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `, source.session_id, source.seq)) {
    console.log(`   receipt: ${r.kind} · ${r.obligation} · ${r.node_id}`);
  }

  const terminal = rows<{ data_json: string }>(`
    SELECT data_json FROM events
     WHERE session_id = ? AND type = 'conversation_completed'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
  `, source.session_id, source.seq)[0];
  if (terminal) {
    const t = JSON.parse(terminal.data_json) as {
      blockedReason?: string;
      delivered?: boolean;
      reply?: string;
      presentation?: { status?: string; text?: string };
      verificationDetail?: string;
      verificationMissing?: string[];
      failureDetail?: string;
    };
    const verdict = t.blockedReason
      ? `BLOCKED (${t.blockedReason})`
      : (t.presentation?.status ?? 'done').toUpperCase();
    console.log(`   terminal: ${verdict} · delivered=${t.delivered !== false}`);
    if (t.verificationDetail || t.verificationMissing?.length) {
      console.log(`   gate: ${t.verificationDetail ?? ''}${t.verificationMissing?.length ? ` [${t.verificationMissing.join(', ')}]` : ''}`);
    }
    if (t.failureDetail) console.log(`   failure: ${preview(t.failureDetail, 160)}`);
    console.log(`   reply: ${preview(t.presentation?.text ?? t.reply ?? '')}`);
  } else {
    console.log('   terminal: (none — turn open or failed before terminal)');
  }
}
console.log(`\n${sources.length} source(s) from ${DB_PATH}\n`);
