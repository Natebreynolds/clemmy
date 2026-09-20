import { openEventLog } from './eventlog.js';
import { projectModelRequestProvenance } from './model-request-provenance.js';
import { pageArchivedTaskMessage } from './archived-task-message.js';

export interface ArchivedTaskMessageReference {
  recordId: string; requestDigest: string; itemIndex: number;
}

/** Resolve exact old user text only from validated requests predating the
 * current accepted source. Missing or legacy-unverifiable content stays live. */
export function archivedTaskMessageReferences(sessionId: string, sourceUserSeq: number): Map<string, ArchivedTaskMessageReference> {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM events WHERE session_id=? AND seq=? AND type='user_input_received' AND role='user'")
    .get(sessionId, sourceUserSeq)) return new Map();
  const rows = db.prepare(`SELECT record_id, normalized_request_digest FROM model_request_provenance
    WHERE session_id=? AND source_user_seq<? ORDER BY source_user_seq DESC,request_ordinal DESC LIMIT 3`)
    .all(sessionId, sourceUserSeq) as Array<{ record_id: string; normalized_request_digest: string }>;
  const references = new Map<string, ArchivedTaskMessageReference>();
  for (const row of rows) {
    const projected = projectModelRequestProvenance(row.record_id);
    if (projected.status !== 'ok') continue;
    const task = JSON.parse(projected.layers.task) as { input?: unknown };
    if (!Array.isArray(task.input)) continue;
    task.input.forEach((item: { role?: unknown; type?: unknown; content?: unknown }, itemIndex: number) => {
      if (item?.role !== 'user' || (item.type !== undefined && item.type !== 'message')
        || typeof item.content !== 'string' || references.has(item.content)) return;
      references.set(item.content, { recordId: row.record_id, requestDigest: row.normalized_request_digest, itemIndex });
    });
  }
  return references;
}

/** Historical evidence from this conversation only. Ownership and the exact
 * immutable request digest are checked before decrypting a selected message. */
export function readArchivedTaskContext(input: {
  sessionId: string; sourceUserSeq: number; recordId: string; requestDigest: string;
  itemIndex: number; offset?: number; maxChars?: number;
}) {
  const db = openEventLog();
  const source = db.prepare("SELECT 1 FROM events WHERE session_id=? AND seq=? AND type='user_input_received' AND role='user'")
    .get(input.sessionId, input.sourceUserSeq);
  if (!source) throw new Error('accepted_source_required');
  const row = db.prepare('SELECT session_id, source_user_seq, normalized_request_digest FROM model_request_provenance WHERE record_id=?')
    .get(input.recordId) as { session_id: string; source_user_seq: number; normalized_request_digest: string } | undefined;
  if (!row || row.session_id !== input.sessionId || row.source_user_seq > input.sourceUserSeq
    || row.normalized_request_digest !== input.requestDigest) throw new Error('archive_locator_not_authorized');
  const projected = projectModelRequestProvenance(input.recordId);
  if (projected.status !== 'ok') throw new Error(`archive_unavailable:${projected.reason}`);
  return {
    version: 1, recordId: input.recordId, requestDigest: input.requestDigest,
    sourceUserSeq: row.source_user_seq,
    evidenceOnly: true,
    ...pageArchivedTaskMessage({ taskLayer: projected.layers.task, itemIndex: input.itemIndex,
      offset: input.offset, maxChars: input.maxChars }),
  };
}
