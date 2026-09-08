/** Schema only. Backfill is incremental at read time, never a migration-wide
 * read of the event payload table. Every index row is disposable projection. */
export const SESSION_HISTORY_SEARCH_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS session_history_index_state_v1 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    scanned_through_seq INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO session_history_index_state_v1(singleton) VALUES (1);
  CREATE TABLE IF NOT EXISTS session_history_index_pending_v1 (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    first_seq INTEGER NOT NULL,
    through_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_history_index_sessions_v1 (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    through_seq INTEGER NOT NULL,
    projection_sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_history_documents_v1 (
    event_seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_user_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    occurred_at TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_session_history_documents_session
    ON session_history_documents_v1(session_id, event_seq);
  CREATE VIRTUAL TABLE IF NOT EXISTS session_history_documents_fts_v1 USING fts5(
    content, content='session_history_documents_v1', content_rowid='event_seq', tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS session_history_documents_fts_insert_v1 AFTER INSERT ON session_history_documents_v1 BEGIN
    INSERT INTO session_history_documents_fts_v1(rowid, content) VALUES (new.event_seq, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS session_history_documents_fts_delete_v1 AFTER DELETE ON session_history_documents_v1 BEGIN
    INSERT INTO session_history_documents_fts_v1(session_history_documents_fts_v1, rowid, content)
      VALUES ('delete', old.event_seq, old.content);
  END;
  CREATE TABLE IF NOT EXISTS session_history_search_receipts_v1 (
    receipt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_user_seq INTEGER NOT NULL REFERENCES events(seq) ON DELETE CASCADE,
    receipt_json TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    receipt_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE
  );
`;
