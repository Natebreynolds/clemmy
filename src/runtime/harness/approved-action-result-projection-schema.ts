import type Database from 'better-sqlite3';

/** Future-only display debt; no accepted-source, dispatch or completion rules change. */
export function installApprovedActionResultProjectionSchema(db: Database.Database): void {
  for (const table of ['approved_action_result_projection_jobs_v1', 'approved_action_result_projections_v1']) {
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)) throw new Error(`schema v98 refuses preexisting table ${table}`);
  }
  db.exec(`CREATE TABLE approved_action_result_projection_jobs_v1 (
    projection_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_user_seq INTEGER NOT NULL CHECK(source_user_seq>0),
    original_source_user_seq INTEGER NOT NULL CHECK(original_source_user_seq>0 AND original_source_user_seq<source_user_seq),
    terminal_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
    binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB))<=16384 AND json_valid(binding_json) AND json_type(binding_json)='object'),
    binding_digest TEXT NOT NULL CHECK(binding_digest=evidence_digest),
    status TEXT NOT NULL CHECK(status IN ('queued','started','published','failed','cancelled','unknown')),
    claim_id TEXT,
    claim_process_id INTEGER CHECK(claim_process_id>0),
    claim_daemon_id TEXT,
    transport_closed_at TEXT,
    transport_closed_kind TEXT CHECK(transport_closed_kind IN ('call_settled','process_dead')),
    usage_job_id TEXT UNIQUE,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(session_id,source_user_seq),
    FOREIGN KEY(session_id,source_user_seq) REFERENCES accepted_task_authority(session_id,source_user_seq) ON DELETE CASCADE,
    CHECK((transport_closed_at IS NULL AND transport_closed_kind IS NULL) OR (transport_closed_at IS NOT NULL AND transport_closed_kind IS NOT NULL)),
    CHECK((status='queued' AND claim_id IS NULL AND claim_process_id IS NULL AND claim_daemon_id IS NULL AND transport_closed_at IS NULL AND usage_job_id IS NULL AND started_at IS NULL AND finished_at IS NULL)
      OR (status='started' AND claim_id IS NOT NULL AND claim_process_id IS NOT NULL AND claim_daemon_id IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NULL)
      OR (status IN ('published','failed','cancelled','unknown') AND finished_at IS NOT NULL))
  );
  CREATE INDEX approved_action_result_projection_queue_v1 ON approved_action_result_projection_jobs_v1(status,created_at,projection_id);
  CREATE INDEX approved_action_result_projection_parent_v1 ON approved_action_result_projection_jobs_v1(session_id,original_source_user_seq);
  CREATE TABLE approved_action_result_projections_v1 (
    projection_id TEXT PRIMARY KEY REFERENCES approved_action_result_projection_jobs_v1(projection_id) ON DELETE CASCADE,
    evidence_digest TEXT NOT NULL,
    text_digest TEXT NOT NULL CHECK(length(text_digest)=64),
    text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600),
    model_identity TEXT NOT NULL CHECK(length(model_identity) BETWEEN 1 AND 256),
    authorship_json TEXT NOT NULL CHECK(length(CAST(authorship_json AS BLOB))<=4096 AND json_valid(authorship_json) AND json_type(authorship_json)='object'),
    usage_job_id TEXT NOT NULL,
    published_at TEXT NOT NULL
  );
  CREATE TRIGGER approved_action_result_projection_insert_v1 BEFORE INSERT ON approved_action_result_projection_jobs_v1
  WHEN NEW.status!='queued' OR NOT EXISTS (
    SELECT 1 FROM accepted_task_authority a JOIN events t ON t.id=a.terminal_event_id
      JOIN approved_action_completion_receipts_v1 r ON r.receipt_id=a.host_completion_receipt_id
      JOIN events original ON original.session_id=NEW.session_id AND original.seq=NEW.original_source_user_seq
    WHERE a.session_id=NEW.session_id AND a.source_user_seq=NEW.source_user_seq AND a.state='terminal'
      AND t.id=NEW.terminal_event_id AND t.type='conversation_completed' AND t.session_id=NEW.session_id
      AND original.role='user' AND original.type='user_input_received'
      AND COALESCE(json_extract(original.data_json,'$.synthetic'),0)!=1
      AND r.session_id=NEW.session_id AND r.source_user_seq=NEW.source_user_seq
      AND json_extract(NEW.binding_json,'$.completionReceiptId')=r.receipt_id
      AND json_extract(NEW.binding_json,'$.sessionId')=NEW.session_id
      AND json_extract(NEW.binding_json,'$.sourceUserSeq')=NEW.source_user_seq
      AND json_extract(NEW.binding_json,'$.originalSourceUserSeq')=NEW.original_source_user_seq
      AND json_extract(NEW.binding_json,'$.terminalEventId')=NEW.terminal_event_id)
  BEGIN SELECT RAISE(ABORT,'projection requires an exact completed action'); END;
  CREATE TRIGGER approved_action_result_projection_transition_v1 BEFORE UPDATE ON approved_action_result_projection_jobs_v1
  WHEN NEW.projection_id IS NOT OLD.projection_id OR NEW.session_id IS NOT OLD.session_id
    OR NEW.source_user_seq IS NOT OLD.source_user_seq OR NEW.original_source_user_seq IS NOT OLD.original_source_user_seq
    OR NEW.terminal_event_id IS NOT OLD.terminal_event_id OR NEW.evidence_digest IS NOT OLD.evidence_digest
    OR NEW.binding_json IS NOT OLD.binding_json OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT OLD.claim_id)
    OR (OLD.claim_process_id IS NOT NULL AND NEW.claim_process_id IS NOT OLD.claim_process_id)
    OR (OLD.claim_daemon_id IS NOT NULL AND NEW.claim_daemon_id IS NOT OLD.claim_daemon_id)
    OR (OLD.transport_closed_at IS NOT NULL AND NEW.transport_closed_at IS NOT OLD.transport_closed_at)
    OR (OLD.transport_closed_kind IS NOT NULL AND NEW.transport_closed_kind IS NOT OLD.transport_closed_kind)
    OR (OLD.usage_job_id IS NOT NULL AND NEW.usage_job_id IS NOT OLD.usage_job_id)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
    OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS NOT OLD.finished_at)
    OR NOT ((OLD.status='queued' AND NEW.status IN ('started','cancelled'))
      OR (OLD.status='started' AND NEW.status IN ('started','published','failed','cancelled','unknown'))
      OR (OLD.status='unknown' AND NEW.status='unknown' AND OLD.transport_closed_at IS NULL AND NEW.transport_closed_at IS NOT NULL))
  BEGIN SELECT RAISE(ABORT,'projection ownership is immutable and cannot replay'); END;
  CREATE TRIGGER approved_action_result_projection_result_v1 BEFORE INSERT ON approved_action_result_projections_v1
  WHEN NOT EXISTS(SELECT 1 FROM approved_action_result_projection_jobs_v1 j WHERE j.projection_id=NEW.projection_id
    AND j.status='started' AND j.evidence_digest=NEW.evidence_digest AND j.usage_job_id=NEW.usage_job_id)
  BEGIN SELECT RAISE(ABORT,'projection result requires its claimed job'); END;
  CREATE TRIGGER approved_action_result_projection_published_v1 BEFORE UPDATE ON approved_action_result_projection_jobs_v1
  WHEN NEW.status='published' AND NOT EXISTS(SELECT 1 FROM approved_action_result_projections_v1 r
    WHERE r.projection_id=NEW.projection_id AND r.evidence_digest=NEW.evidence_digest AND r.usage_job_id=NEW.usage_job_id
      AND r.published_at=NEW.finished_at)
  BEGIN SELECT RAISE(ABORT,'published projection requires its immutable result'); END;
  CREATE TRIGGER approved_action_result_projection_result_immutable_v1 BEFORE UPDATE ON approved_action_result_projections_v1
  BEGIN SELECT RAISE(ABORT,'published projection is immutable'); END;
  CREATE TRIGGER approved_action_result_projection_result_delete_v1 BEFORE DELETE ON approved_action_result_projections_v1
  WHEN EXISTS(SELECT 1 FROM approved_action_result_projection_jobs_v1 j JOIN sessions s ON s.id=j.session_id WHERE j.projection_id=OLD.projection_id)
  BEGIN SELECT RAISE(ABORT,'published projection is immutable'); END;
  CREATE TRIGGER approved_action_result_projection_job_delete_v1 BEFORE DELETE ON approved_action_result_projection_jobs_v1
  WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
  BEGIN SELECT RAISE(ABORT,'projection job is retained'); END;`);
}
