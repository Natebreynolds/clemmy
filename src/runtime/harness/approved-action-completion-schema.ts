import type Database from 'better-sqlite3';

/** Additive, future-only protocol. Existing stores are never backfilled and
 * preexisting unsanctioned table names are refused rather than blessed. */
export function installApprovedActionCompletionSchema(db: Database.Database): void {
  for (const table of ['approved_action_completion_intents_v1', 'approved_action_completion_receipts_v1']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) throw new Error(`schema v96 refuses preexisting unsanctioned table ${table}`);
  }
  db.exec(`CREATE TABLE approved_action_completion_intents_v1 (
    intent_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL CHECK(source_user_seq>0),
    intent_json TEXT NOT NULL CHECK(json_valid(intent_json) AND json_type(intent_json)='object'),
    intent_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
    prepared_at TEXT NOT NULL,
    UNIQUE(session_id,source_user_seq),
    FOREIGN KEY(session_id,source_user_seq) REFERENCES accepted_task_authority(session_id,source_user_seq) ON DELETE CASCADE
  );
  CREATE TABLE approved_action_completion_receipts_v1 (
    receipt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL CHECK(source_user_seq>0),
    intent_id TEXT NOT NULL UNIQUE REFERENCES approved_action_completion_intents_v1(intent_id) ON DELETE RESTRICT,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND json_type(receipt_json)='object'),
    receipt_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
    issued_at TEXT NOT NULL,
    UNIQUE(session_id,source_user_seq),
    FOREIGN KEY(session_id,source_user_seq) REFERENCES accepted_task_authority(session_id,source_user_seq) ON DELETE CASCADE
  );`);
  for (const table of ['approved_action_completion_intents_v1', 'approved_action_completion_receipts_v1']) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'approved action completion proof is immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
      WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
      BEGIN SELECT RAISE(ABORT,'approved action completion proof is immutable'); END;`);
  }
  const approved = `SELECT 1 FROM approved_action_completion_receipts_v1 r
    JOIN approved_action_completion_intents_v1 i ON i.intent_id=r.intent_id
    JOIN events receipt_event ON receipt_event.id=r.receipt_event_id
    WHERE r.receipt_id=NEW.host_completion_receipt_id AND r.receipt_event_id=NEW.host_completion_event_id
      AND r.session_id=NEW.session_id AND r.source_user_seq=NEW.source_user_seq
      AND i.session_id=NEW.session_id AND i.source_user_seq=NEW.source_user_seq
      AND json_extract(i.intent_json,'$.acceptedTaskId')=NEW.accepted_task_id
      AND json_extract(i.intent_json,'$.graphEventId')=NEW.graph_event_id
      AND json_extract(i.intent_json,'$.graphId')=NEW.graph_id
      AND json_extract(i.intent_json,'$.graphHash')=NEW.graph_hash
      AND receipt_event.session_id=NEW.session_id AND receipt_event.type='approved_action_completion_receipt'
      AND json_extract(receipt_event.data_json,'$.receiptId')=r.receipt_id`;
  // Preserve every previous memory predicate verbatim. Widen only the typed
  // receipt union, not state ordering, exclusivity, monotonicity or identity.
  for (const [name, terminal] of [
    ['trg_accepted_task_host_completion_monotonic', false],
    ['trg_accepted_task_host_terminal_exact', true],
  ] as const) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
    if (!row) throw new Error(`schema v96 prerequisite missing: ${name}`);
    const start = row.sql.indexOf('NOT EXISTS (');
    if (start < 0) throw new Error(`schema v96 prerequisite shape changed: ${name}`);
    const opening = start + 'NOT EXISTS '.length;
    let depth = 1, end = opening + 1;
    for (; end < row.sql.length && depth; end++) {
      if (row.sql[end] === '(') depth++;
      if (row.sql[end] === ')') depth--;
    }
    if (depth) throw new Error('schema v96 receipt trigger is unbalanced');
    const previous = row.sql.slice(opening + 1, end - 1);
    const extra = terminal ? `${approved} AND NEW.manifest_id=r.receipt_id AND NEW.backstop_event_id=r.receipt_event_id
      AND NEW.work_contract_id IS NULL AND EXISTS(SELECT 1 FROM events t WHERE t.id=NEW.terminal_event_id
        AND t.session_id=NEW.session_id AND t.type='conversation_completed'
        AND json_extract(t.data_json,'$.sourceUserSeq')=NEW.source_user_seq)` : approved;
    const sql = row.sql.slice(0, start) + `NOT (EXISTS (${previous}) OR EXISTS (${extra}))` + row.sql.slice(end);
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(sql);
  }
}
