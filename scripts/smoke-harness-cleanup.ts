import Database from 'better-sqlite3';

/** Remove one throwaway live-smoke session through the schema's parent
 * lifecycle. Never delete events first: attempts bind to their exact source
 * event, and every session-owned control row must leave through FK cascades. */
export function deleteSmokeHarnessSession(databasePath: string, sessionId: string): number {
  const db = new Database(databasePath);
  try {
    db.pragma('foreign_keys = ON');
    if (db.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new Error('smoke cleanup requires SQLite foreign-key enforcement');
    }
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId).changes;
  } finally {
    db.close();
  }
}
