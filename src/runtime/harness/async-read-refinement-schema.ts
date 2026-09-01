import type Database from 'better-sqlite3';

export const ASYNC_READ_REFINEMENT_INTENTS_TABLE = 'async_read_refinement_intents' as const;
export const ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE = 'async_read_refinement_start_receipts' as const;
export const ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE = 'async_read_refinement_completion_receipts' as const;
export const ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE = 'async_read_refinement_terminal_receipts' as const;
export const ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE = 'async_read_refinement_recovery_cursor' as const;

const TERMINAL_COLUMNS = [
  'session_id',
  'source_user_seq',
  'accepted_task_id',
  'start_logical_tool_call_id',
  'receipt_version',
  'recipe_digest',
  'terminal_kind',
  'reason',
  'getter_logical_tool_call_id',
  'getter_result_handle_id',
  'getter_raw_payload_sha256',
  'cancellation_run_attempt_id',
  'cancellation_requested_at',
  'recorded_at',
] as const;

const EARLIER_TERMINAL_COLUMNS = TERMINAL_COLUMNS.filter((column) => (
  column !== 'cancellation_run_attempt_id' && column !== 'cancellation_requested_at'
));

function terminalReceiptTableSql(tableName: string): string {
  return `
    CREATE TABLE ${tableName} (
      session_id                    TEXT NOT NULL,
      source_user_seq               INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id              TEXT NOT NULL,
      start_logical_tool_call_id    TEXT NOT NULL,
      receipt_version               INTEGER NOT NULL CHECK (receipt_version = 1),
      recipe_digest                 TEXT NOT NULL CHECK (length(recipe_digest) = 64),
      terminal_kind                 TEXT NOT NULL CHECK (terminal_kind IN (
        'insufficient_evidence', 'provider_failed', 'provider_cancelled',
        'deadline_exhausted', 'attempts_exhausted', 'user_cancelled'
      )),
      reason                        TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
      getter_logical_tool_call_id   TEXT,
      getter_result_handle_id       TEXT,
      getter_raw_payload_sha256     TEXT CHECK (
        getter_raw_payload_sha256 IS NULL OR length(getter_raw_payload_sha256) = 64
      ),
      cancellation_run_attempt_id   TEXT,
      cancellation_requested_at    TEXT,
      recorded_at                   TEXT NOT NULL,
      CHECK (
        (getter_logical_tool_call_id IS NULL AND getter_result_handle_id IS NULL AND getter_raw_payload_sha256 IS NULL)
        OR
        (getter_logical_tool_call_id IS NOT NULL AND getter_result_handle_id IS NOT NULL AND getter_raw_payload_sha256 IS NOT NULL)
      ),
      CHECK (
        (terminal_kind = 'user_cancelled' AND cancellation_run_attempt_id IS NOT NULL AND cancellation_requested_at IS NOT NULL)
        OR
        (terminal_kind != 'user_cancelled' AND cancellation_run_attempt_id IS NULL AND cancellation_requested_at IS NULL)
      ),
      PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
      UNIQUE (session_id, source_user_seq, getter_logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
        REFERENCES ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}(session_id, source_user_seq, start_logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (getter_result_handle_id)
        REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT,
      FOREIGN KEY (cancellation_run_attempt_id)
        REFERENCES run_attempts(attempt_id) ON DELETE RESTRICT
    )`;
}

function terminalReceiptTableHasV72Authority(db: Database.Database): boolean {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE) as { sql: string } | undefined;
  if (!table) return false;
  const columnRows = db.prepare(`PRAGMA table_info(${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE})`).all() as Array<{ name: string }>;
  const columns = columnRows.map((column) => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(TERMINAL_COLUMNS)) return false;
  const normalized = table.sql.replace(/\s+/gu, ' ').toLowerCase();
  if (
    !normalized.includes('getter_raw_payload_sha256 is null or length(getter_raw_payload_sha256) = 64')
    || !normalized.includes('getter_logical_tool_call_id is null and getter_result_handle_id is null and getter_raw_payload_sha256 is null')
    || !normalized.includes('unique (session_id, source_user_seq, getter_logical_tool_call_id)')
    || !normalized.includes("'user_cancelled'")
    || !normalized.includes("terminal_kind = 'user_cancelled' and cancellation_run_attempt_id is not null")
  ) return false;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE})`).all() as Array<{ table: string; from: string; to: string; on_delete: string }>;
  return foreignKeys.some((entry) => (
    entry.table === 'durable_result_handles'
    && entry.from === 'getter_result_handle_id'
    && entry.to === 'handle_id'
    && entry.on_delete.toUpperCase() === 'RESTRICT'
  )) && foreignKeys.some((entry) => (
    entry.table === ASYNC_READ_REFINEMENT_INTENTS_TABLE
    && entry.from === 'start_logical_tool_call_id'
    && entry.to === 'start_logical_tool_call_id'
    && entry.on_delete.toUpperCase() === 'CASCADE'
  )) && foreignKeys.some((entry) => (
    entry.table === 'run_attempts'
    && entry.from === 'cancellation_run_attempt_id'
    && entry.to === 'attempt_id'
    && entry.on_delete.toUpperCase() === 'RESTRICT'
  ));
}

function normalizeEarlierTerminalReceiptTable(db: Database.Database): void {
  const exists = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE) as { ok: number } | undefined;
  if (!exists || terminalReceiptTableHasV72Authority(db)) return;
  const columnRows = db.prepare(`PRAGMA table_info(${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE})`).all() as Array<{ name: string }>;
  const columns = columnRows.map((column) => column.name);
  const currentColumns = JSON.stringify(columns) === JSON.stringify(TERMINAL_COLUMNS);
  const earlierColumns = JSON.stringify(columns) === JSON.stringify(EARLIER_TERMINAL_COLUMNS);
  if (!currentColumns && !earlierColumns) {
    throw new Error('earlier async terminal receipt table has an unsupported column shape');
  }
  const rebuilt = `${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}_v72_rebuild`;
  db.exec(`
    DROP TRIGGER IF EXISTS trg_async_read_refinement_completion_excludes_terminal;
    DROP TRIGGER IF EXISTS trg_async_read_refinement_terminal_excludes_completion;
    DROP TRIGGER IF EXISTS trg_async_read_refinement_terminal_receipt_immutable;
    DROP TRIGGER IF EXISTS trg_async_read_refinement_terminal_receipt_delete_immutable;
    DROP TABLE IF EXISTS ${rebuilt};
    ${terminalReceiptTableSql(rebuilt)};
    INSERT INTO ${rebuilt} (${TERMINAL_COLUMNS.join(',')})
      SELECT ${EARLIER_TERMINAL_COLUMNS.slice(0, -1).join(',')},
             ${currentColumns ? 'cancellation_run_attempt_id' : 'NULL'},
             ${currentColumns ? 'cancellation_requested_at' : 'NULL'},
             recorded_at
        FROM ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE};
    DROP TABLE ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE};
    ALTER TABLE ${rebuilt} RENAME TO ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE};
  `);
}

export function createAsyncReadRefinementSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_INTENTS_TABLE} (
      session_id                    TEXT NOT NULL,
      source_user_seq               INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id              TEXT NOT NULL,
      start_logical_tool_call_id    TEXT NOT NULL,
      requirement_id                TEXT NOT NULL,
      recipe_digest                 TEXT NOT NULL CHECK (length(recipe_digest) = 64),
      owner_binding_digest          TEXT NOT NULL CHECK (length(owner_binding_digest) = 64),
      start_argument_digest         TEXT NOT NULL CHECK (length(start_argument_digest) = 64),
      source_logical_tool_call_id   TEXT NOT NULL,
      source_result_handle_id       TEXT NOT NULL,
      source_projection_call_id     TEXT NOT NULL,
      source_projection_digest      TEXT NOT NULL CHECK (length(source_projection_digest) = 64),
      candidates_json               TEXT NOT NULL CHECK (json_valid(candidates_json) AND json_type(candidates_json) = 'array'),
      candidate_digest              TEXT NOT NULL CHECK (length(candidate_digest) = 64),
      accepted_at                   TEXT NOT NULL,
      max_age_days                  INTEGER NOT NULL CHECK (max_age_days BETWEEN 1 AND 30),
      min_distinct_records          INTEGER NOT NULL CHECK (min_distinct_records BETWEEN 1 AND 8),
      recorded_at                   TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
      UNIQUE (session_id, source_user_seq, requirement_id),
      FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
        REFERENCES expected_work_call_bindings(session_id, source_user_seq, logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (source_result_handle_id)
        REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE} (
      session_id                    TEXT NOT NULL,
      source_user_seq               INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id              TEXT NOT NULL,
      start_logical_tool_call_id    TEXT NOT NULL,
      provider_start_logical_tool_call_id TEXT NOT NULL,
      receipt_version               INTEGER NOT NULL CHECK (receipt_version = 1),
      recipe_digest                 TEXT NOT NULL CHECK (length(recipe_digest) = 64),
      start_result_handle_id        TEXT NOT NULL,
      start_raw_payload_sha256      TEXT NOT NULL CHECK (length(start_raw_payload_sha256) = 64),
      job_id                        TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 512),
      job_url                       TEXT NOT NULL CHECK (length(job_url) BETWEEN 8 AND 2048),
      recorded_at                   TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
      UNIQUE (session_id, source_user_seq, provider_start_logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
        REFERENCES ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}(session_id, source_user_seq, start_logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (start_result_handle_id)
        REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE} (
      session_id                    TEXT NOT NULL,
      source_user_seq               INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id              TEXT NOT NULL,
      start_logical_tool_call_id    TEXT NOT NULL,
      receipt_version               INTEGER NOT NULL CHECK (receipt_version = 1),
      recipe_digest                 TEXT NOT NULL CHECK (length(recipe_digest) = 64),
      getter_logical_tool_call_id   TEXT NOT NULL,
      getter_result_handle_id       TEXT NOT NULL,
      getter_raw_payload_sha256     TEXT NOT NULL CHECK (length(getter_raw_payload_sha256) = 64),
      evidence_json                 TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
      evidence_digest               TEXT NOT NULL CHECK (length(evidence_digest) = 64),
      recorded_at                   TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
      UNIQUE (session_id, source_user_seq, getter_logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
        REFERENCES ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}(session_id, source_user_seq, start_logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (getter_result_handle_id)
        REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_intent_immutable
    BEFORE UPDATE ON ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}
    BEGIN SELECT RAISE(ABORT, 'async read refinement intents are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_start_receipt_immutable
    BEFORE UPDATE ON ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}
    BEGIN SELECT RAISE(ABORT, 'async read refinement start receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_completion_receipt_immutable
    BEFORE UPDATE ON ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
    BEGIN SELECT RAISE(ABORT, 'async read refinement completion receipts are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_intent_delete_immutable
    BEFORE DELETE ON ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'async read refinement intents are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_start_receipt_delete_immutable
    BEFORE DELETE ON ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'async read refinement start receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_completion_receipt_delete_immutable
    BEFORE DELETE ON ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'async read refinement completion receipts are immutable'); END;
  `);
}

/** Historical v72 shape. Keep this byte-compatible for migration rehearsal:
 * some developer homes may already be stamped 72 and therefore require v73's
 * normalizer rather than a rewritten v72 backfill. */
export function createAsyncReadRefinementTerminalRecoverySchemaV72(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE} (
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id TEXT NOT NULL,
      start_logical_tool_call_id TEXT NOT NULL,
      receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
      recipe_digest TEXT NOT NULL CHECK (length(recipe_digest) = 64),
      terminal_kind TEXT NOT NULL CHECK (terminal_kind IN (
        'insufficient_evidence', 'provider_failed', 'provider_cancelled',
        'deadline_exhausted', 'attempts_exhausted'
      )),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
      getter_logical_tool_call_id TEXT,
      getter_result_handle_id TEXT,
      getter_raw_payload_sha256 TEXT CHECK (
        getter_raw_payload_sha256 IS NULL OR length(getter_raw_payload_sha256) = 64
      ),
      recorded_at TEXT NOT NULL,
      CHECK (
        (getter_logical_tool_call_id IS NULL AND getter_result_handle_id IS NULL AND getter_raw_payload_sha256 IS NULL)
        OR
        (getter_logical_tool_call_id IS NOT NULL AND getter_result_handle_id IS NOT NULL AND getter_raw_payload_sha256 IS NOT NULL)
      ),
      PRIMARY KEY (session_id, source_user_seq, start_logical_tool_call_id),
      UNIQUE (session_id, source_user_seq, getter_logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq, start_logical_tool_call_id)
        REFERENCES ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}(session_id, source_user_seq, start_logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (getter_result_handle_id)
        REFERENCES durable_result_handles(handle_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE} (
      cursor_key INTEGER PRIMARY KEY CHECK (cursor_key = 1),
      cursor_recorded_at TEXT NOT NULL,
      cursor_session_id TEXT NOT NULL,
      cursor_source_user_seq INTEGER NOT NULL CHECK (cursor_source_user_seq > 0),
      cursor_logical_tool_call_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_completion_excludes_terminal
    BEFORE INSERT ON ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
    WHEN EXISTS (
      SELECT 1 FROM ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE} terminal
       WHERE terminal.session_id = NEW.session_id
         AND terminal.source_user_seq = NEW.source_user_seq
         AND terminal.start_logical_tool_call_id = NEW.start_logical_tool_call_id
    )
    BEGIN SELECT RAISE(ABORT, 'async read refinement already has a terminal receipt'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_excludes_completion
    BEFORE INSERT ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    WHEN EXISTS (
      SELECT 1 FROM ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE} completion
       WHERE completion.session_id = NEW.session_id
         AND completion.source_user_seq = NEW.source_user_seq
         AND completion.start_logical_tool_call_id = NEW.start_logical_tool_call_id
    )
    BEGIN SELECT RAISE(ABORT, 'async read refinement already has a completion receipt'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_receipt_immutable
    BEFORE UPDATE ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    BEGIN SELECT RAISE(ABORT, 'async read refinement terminal receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_receipt_delete_immutable
    BEFORE DELETE ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'async read refinement terminal receipts are immutable'); END;
  `);
}

/** v73 normalizes every stamped v71/v72 candidate into the final terminal and
 * recovery authority, including the exact Stop witness. */
export function createAsyncReadRefinementTerminalRecoverySchema(db: Database.Database): void {
  normalizeEarlierTerminalReceiptTable(db);
  const terminalExists = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE) as { ok: number } | undefined;
  if (!terminalExists) db.exec(terminalReceiptTableSql(ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE} (
      cursor_key                    INTEGER PRIMARY KEY CHECK (cursor_key = 1),
      cursor_recorded_at            TEXT NOT NULL,
      cursor_session_id             TEXT NOT NULL,
      cursor_source_user_seq        INTEGER NOT NULL CHECK (cursor_source_user_seq > 0),
      cursor_logical_tool_call_id   TEXT NOT NULL,
      updated_at                    TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_completion_excludes_terminal
    BEFORE INSERT ON ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
    WHEN EXISTS (
      SELECT 1 FROM ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE} terminal
       WHERE terminal.session_id = NEW.session_id
         AND terminal.source_user_seq = NEW.source_user_seq
         AND terminal.start_logical_tool_call_id = NEW.start_logical_tool_call_id
    )
    BEGIN SELECT RAISE(ABORT, 'async read refinement already has a terminal receipt'); END;

    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_excludes_completion
    BEFORE INSERT ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    WHEN EXISTS (
      SELECT 1 FROM ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE} completion
       WHERE completion.session_id = NEW.session_id
         AND completion.source_user_seq = NEW.source_user_seq
         AND completion.start_logical_tool_call_id = NEW.start_logical_tool_call_id
    )
    BEGIN SELECT RAISE(ABORT, 'async read refinement already has a completion receipt'); END;

    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_receipt_immutable
    BEFORE UPDATE ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    BEGIN SELECT RAISE(ABORT, 'async read refinement terminal receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS trg_async_read_refinement_terminal_receipt_delete_immutable
    BEFORE DELETE ON ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'async read refinement terminal receipts are immutable'); END;
  `);
}
