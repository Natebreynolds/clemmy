-- The sqlite3 CLI defaults foreign-key enforcement off. Session deletion must
-- enter through the parent while enforcement is on so events, attempts,
-- dispatch leases, and every future session-owned table cascade together.
PRAGMA foreign_keys = ON;

DELETE FROM sessions
 WHERE id LIKE 'console:%smoke%'
    OR id LIKE 'devsmoke:%';
