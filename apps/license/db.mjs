/**
 * Postgres pool + a migration runner small enough to read in one sitting.
 *
 * Postgres rather than SQLite-on-a-volume: a Railway volume pins the service
 * to one replica and makes every redeploy a hard stop, and this is
 * money-bearing state that wants backups and a psql shell for the 2am case.
 */
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createPool(connectionString) {
  return new pg.Pool({
    connectionString,
    // Railway's managed Postgres presents a cert its own proxy signs.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

/** Applies any migration file not yet recorded. Safe to run on every boot. */
export async function migrate(pool, log = console) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const dir = path.join(HERE, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.info?.(`license: applied migration ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

export async function audit(pool, { actor, action, subjectType, subjectId, meta }) {
  try {
    await pool.query(
      'INSERT INTO audit_log (actor, action, subject_type, subject_id, meta) VALUES ($1,$2,$3,$4,$5)',
      [actor, action, subjectType ?? null, subjectId ? String(subjectId) : null, meta ?? {}],
    );
  } catch {
    // An audit write must never fail the operation it describes.
  }
}
