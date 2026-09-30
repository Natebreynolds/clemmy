/** Saved refresh report outbox. A report is downstream of publication; draining
 * it cannot prepare, approve or execute a script, even after a cold restart. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { deliverOutcomeWithAcknowledgement } from '../runtime/outcome.js';
import type { WorkspaceScriptOccurrenceKey } from './workspace-script-occurrence.js';

interface ReportRow {
  delivery_id: string; workspace_id: string; source_id: string; occurrence_id: string;
  session_id: string; observation_id: string; title: string;
}
const table = 'workspace_script_reports_v1';
const sourceId = (key: WorkspaceScriptOccurrenceKey) => JSON.stringify([key.slug, key.sourceId, key.occurrenceId]);
const deliveryId = (key: WorkspaceScriptOccurrenceKey) =>
  `workspace-script-report:${createHash('sha256').update(sourceId(key)).digest('hex')}`;

/** Must share the transaction that records observation_id. A failed insert
 * rolls back the marker, leaving ordinary publication recovery available. */
export function retainWorkspaceScriptReport(db: Database.Database, input: WorkspaceScriptOccurrenceKey & {
  observationId: string; sessionId: string; title: string;
}): void {
  const id = deliveryId(input);
  db.prepare(`INSERT INTO ${table} (delivery_id, workspace_id, source_id, occurrence_id,
    session_id, observation_id, title, created_at)
    SELECT ?, workspace_id, source_id, occurrence_id, session_id, observation_id, ?, ?
    FROM workspace_script_occurrences_v1
    WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ? AND observation_id = ? AND session_id = ?
    ON CONFLICT(workspace_id, source_id, occurrence_id) DO NOTHING`).run(id, input.title, new Date().toISOString(),
      input.slug, input.sourceId, input.occurrenceId, input.observationId, input.sessionId);
  const row = db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?`)
    .get(input.slug, input.sourceId, input.occurrenceId) as ReportRow | undefined;
  if (!row || row.delivery_id !== id || row.session_id !== input.sessionId || row.observation_id !== input.observationId) {
    throw new Error('Saved refresh report conflicts with its published occurrence.');
  }
}

/** Upgrade repair for previously published occurrences. The committed marker
 * proves saved data, never downstream business effects. Preserve old delivered
 * reports rather than notifying again with a new identity. */
export function recoverPublishedWorkspaceScriptReports(): void {
  const db = openEventLog();
  db.transaction(() => {
    const missing = db.prepare(`SELECT o.workspace_id, o.source_id, o.occurrence_id, o.session_id, o.observation_id
      FROM workspace_script_occurrences_v1 o LEFT JOIN ${table} r
        ON r.workspace_id = o.workspace_id AND r.source_id = o.source_id AND r.occurrence_id = o.occurrence_id
      WHERE o.observation_id IS NOT NULL AND r.delivery_id IS NULL`).all() as ReportRow[];
    for (const row of missing) {
      const key = { slug: row.workspace_id, sourceId: row.source_id, occurrenceId: row.occurrence_id };
      retainWorkspaceScriptReport(db, { ...key, sessionId: row.session_id,
        observationId: row.observation_id, title: row.workspace_id });
      const prior = db.prepare(`SELECT created_at FROM events WHERE session_id = ? AND type = 'user_input_received'
        AND json_valid(data_json) AND json_extract(data_json, '$.synthetic') = 1
        AND json_extract(data_json, '$.source') = 'outcome'
        AND json_extract(data_json, '$.sourceLabel') = 'workspace script refresh'
        AND json_extract(data_json, '$.sourceId') = ? AND json_extract(data_json, '$.status') = 'done'
        AND json_extract(data_json, '$.deliveryPhase') = 'passive' ORDER BY seq LIMIT 1`)
        .get(row.session_id, sourceId(key)) as { created_at: string } | undefined;
      if (prior) db.prepare(`UPDATE ${table} SET acknowledged_at = ? WHERE delivery_id = ?`)
        .run(prior.created_at, deliveryId(key));
    }
  }).immediate();
}

/** Uses the shared Outcome destination and exact idempotency identity. Failed
 * delivery or failed acknowledgement remains pending for boot/timer recovery.
 * No outer transaction surrounds Outcome's post-commit event publication. */
export function drainWorkspaceScriptReports(): number {
  const db = openEventLog();
  const rows = db.prepare(`SELECT * FROM ${table} WHERE acknowledged_at IS NULL ORDER BY attempts, created_at LIMIT 50`)
    .all() as ReportRow[];
  let acknowledged = 0;
  for (const row of rows) {
    try {
      db.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE delivery_id = ?`).run(row.delivery_id);
      const ack = deliverOutcomeWithAcknowledgement({ status: 'done',
        summary: `“${row.title}” refreshed ${row.source_id} and saved its data.`,
        evidence: { work: [{ label: `Refresh ${row.source_id}`, completed: 1, total: 1 }],
          artifacts: [{ kind: 'dataset observation', ref: row.observation_id }] },
      }, { originSessionId: row.session_id, sourceLabel: 'workspace script refresh',
        sourceId: sourceId({ slug: row.workspace_id, sourceId: row.source_id, occurrenceId: row.occurrence_id }),
        deliveryId: row.delivery_id, title: row.title, proactiveTurn: true });
      if (!ack.acknowledged || ack.disposition === 'not_applicable') throw new Error('Saved refresh report was not acknowledged.');
      acknowledged += db.prepare(`UPDATE ${table} SET acknowledged_at = ?, last_error = NULL
        WHERE delivery_id = ? AND acknowledged_at IS NULL`).run(new Date().toISOString(), row.delivery_id).changes;
    } catch (error) {
      // A full/unavailable database must not turn a saved dataset into a failed
      // script or trigger a replacement execution. Keep the durable intent.
      try { db.prepare(`UPDATE ${table} SET last_error = ? WHERE delivery_id = ? AND acknowledged_at IS NULL`)
        .run(String(error instanceof Error ? error.message : error).slice(0, 500), row.delivery_id); } catch { /* retry later */ }
    }
  }
  return acknowledged;
}
