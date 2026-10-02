/** Exact immutable history representation. This store grants no execution or
 * memory authority; source rows retain their original proof digests/counts. */
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type Database from 'better-sqlite3';

const MIN_BYTES = 32 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function registerAcceptedModelHistoryReader(db: Database.Database): void {
  db.function('clem_exact_history_v1', { deterministic: true }, (encoded: unknown, codec: unknown,
    plaintextBytes: unknown, digest: unknown, itemCount: unknown) => {
    if (!Buffer.isBuffer(encoded) || codec !== 'deflate-raw'
      || typeof plaintextBytes !== 'number' || !Number.isSafeInteger(plaintextBytes)
      || plaintextBytes < MIN_BYTES || plaintextBytes > MAX_BYTES
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || typeof itemCount !== 'number' || !Number.isSafeInteger(itemCount) || itemCount < 0
      || encoded.length >= plaintextBytes) throw new Error('accepted history object metadata is invalid');
    const opened = inflateRawSync(encoded, { maxOutputLength: plaintextBytes, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    const bytes = opened.buffer;
    if (opened.engine.bytesWritten !== encoded.length || bytes.length !== plaintextBytes || hash(bytes) !== digest) {
      throw new Error('accepted history object bytes do not match their exact digest');
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('accepted history object is not exact UTF-8');
    const history: unknown = JSON.parse(text);
    if (!Array.isArray(history) || history.length !== itemCount) throw new Error('accepted history object item count is invalid');
    return text;
  });
}

/** Called inside the owning admission/checkpoint transaction. Size bounds
 * select storage representation only; larger/incompressible histories remain
 * inline, so compression cannot add a task-size gate. */
export function storeAcceptedModelHistory(db: Database.Database, json: string): { inlineJson: string; objectDigest: string | null } {
  const plain = Buffer.from(json, 'utf8');
  if (plain.length < MIN_BYTES || plain.length > MAX_BYTES) return { inlineJson: json, objectDigest: null };
  const history: unknown = JSON.parse(json);
  if (!Array.isArray(history)) throw new Error('accepted history must be an array');
  const digest = hash(plain);
  const existing = db.prepare(`SELECT clem_exact_history_v1(encoded, codec, plaintext_bytes, digest, item_count) AS json
    FROM accepted_model_history_objects_v1 WHERE digest = ?`).get(digest) as { json: string } | undefined;
  if (existing) {
    if (existing.json !== json) throw new Error('accepted history object digest collision');
    return { inlineJson: '[]', objectDigest: digest };
  }
  const encoded = deflateRawSync(plain, { level: 3 });
  if (encoded.length + 128 >= plain.length) return { inlineJson: json, objectDigest: null };
  db.prepare(`INSERT INTO accepted_model_history_objects_v1 (digest, codec, plaintext_bytes, item_count, encoded)
    VALUES (?, 'deflate-raw', ?, ?, ?)`).run(digest, plain.length, history.length, encoded);
  return { inlineJson: '[]', objectDigest: digest };
}

/** Additive migration. Old immutable rows stay unchanged. Explicit references
 * use empty inline slots, never magic wrappers disguised as model messages.
 * All history consumers must use the verified readable views. */
export function createAcceptedModelHistorySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS accepted_model_history_objects_v1 (
    digest TEXT PRIMARY KEY CHECK(length(digest) = 64),
    codec TEXT NOT NULL CHECK(codec = 'deflate-raw'),
    plaintext_bytes INTEGER NOT NULL CHECK(plaintext_bytes BETWEEN ${MIN_BYTES} AND ${MAX_BYTES}),
    item_count INTEGER NOT NULL CHECK(item_count >= 0),
    encoded BLOB NOT NULL CHECK(typeof(encoded) = 'blob' AND length(encoded) < plaintext_bytes)
  );
  CREATE TRIGGER IF NOT EXISTS accepted_model_history_object_immutable_v1 BEFORE UPDATE ON accepted_model_history_objects_v1
    BEGIN SELECT RAISE(ABORT, 'accepted history objects are immutable'); END;`);
  for (const [table, columns] of [
    ['accepted_model_batch_admissions', ['pre_history', 'frame_history']],
    ['accepted_model_batch_checkpoints', ['history']],
  ] as const) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
    for (const column of columns) {
      if (!existing.has(`${column}_object_digest`)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}_object_digest TEXT
          REFERENCES accepted_model_history_objects_v1(digest) ON DELETE RESTRICT;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${column}_object_index_v1 ON ${table}(${column}_object_digest)
        WHERE ${column}_object_digest IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS ${table}_${column}_object_binding_v1 BEFORE INSERT ON ${table}
        WHEN NEW.${column}_object_digest IS NOT NULL AND (
          NEW.${column}_json != '[]' OR NOT EXISTS (
            SELECT 1 FROM accepted_model_history_objects_v1 object
            WHERE object.digest = NEW.${column}_object_digest
              AND object.digest = NEW.${column}_digest
              AND object.item_count = NEW.${column}_item_count
          )
        ) BEGIN SELECT RAISE(ABORT, 'accepted history reference must bind exact bytes and item count'); END;`);
    }
    const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    const projections = names.map(name => {
      const column = columns.find(column => name === `${column}_json`);
      return column ? `CASE WHEN source.${column}_object_digest IS NULL THEN source.${name}
        ELSE clem_exact_history_v1(${column}.encoded, ${column}.codec,
          ${column}.plaintext_bytes, source.${column}_digest, source.${column}_item_count) END AS ${name}` : `source.${name}`;
    });
    const joins = columns.map(column => `LEFT JOIN accepted_model_history_objects_v1 ${column}
      ON ${column}.digest = source.${column}_object_digest`).join('\n');
    db.exec(`CREATE VIEW IF NOT EXISTS ${table}_readable_v1 AS SELECT ${projections.join(',\n')} FROM ${table} source ${joins};`);
  }
}

/** Schema-authorized representation change, never a change to evidence. The
 * migration transaction replaces the old unconditional UPDATE fences with
 * these exact-byte fences. Keep DELETE fences and every semantic column. */
export function createAcceptedModelHistoryConversionSchema(db: Database.Database): void {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const [table, trigger, columns] of [
    ['accepted_model_batch_admissions', 'trg_accepted_model_batch_admission_immutable', ['pre_history', 'frame_history']],
    ['accepted_model_batch_checkpoints', 'trg_accepted_model_batch_checkpoint_immutable', ['history']],
  ] as const) {
    const names = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    const slots = new Set(columns.flatMap(column => [`${column}_json`, `${column}_object_digest`]));
    const semantic = names.filter(name => !slots.has(name)).map(name => `NEW.${quote(name)} IS OLD.${quote(name)}`);
    const transition = (column: string) => `(OLD.${column}_object_digest IS NULL
      AND NEW.${column}_object_digest IS NOT NULL AND NEW.${column}_json IS '[]'
      AND EXISTS (SELECT 1 FROM accepted_model_history_objects_v1 object
        WHERE object.digest = NEW.${column}_object_digest AND object.digest = OLD.${column}_digest
          AND object.item_count = OLD.${column}_item_count
          AND CAST(clem_exact_history_v1(object.encoded, object.codec, object.plaintext_bytes,
            OLD.${column}_digest, OLD.${column}_item_count) AS BLOB) IS CAST(OLD.${column}_json AS BLOB)))`;
    const pair = columns.map(column => `((NEW.${column}_object_digest IS OLD.${column}_object_digest
      AND CAST(NEW.${column}_json AS BLOB) IS CAST(OLD.${column}_json AS BLOB)) OR ${transition(column)})`);
    // Protect the hidden rowid too: changing it could evade a resumable scan.
    // A no-op UPDATE remains forbidden, as do ref replacement and downgrade.
    db.exec(`DROP TRIGGER IF EXISTS ${trigger};
      CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
      WHEN NOT (NEW.rowid IS OLD.rowid AND ${semantic.join(' AND ')}
        AND ${pair.join(' AND ')} AND (${columns.map(column => `(OLD.${column}_object_digest IS NULL AND NEW.${column}_object_digest IS NOT NULL)`).join(' OR ')}))
      BEGIN SELECT RAISE(ABORT, 'model batch evidence is append-only; only exact history storage conversion is allowed'); END;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS accepted_model_history_conversion_v1 (
    lane TEXT PRIMARY KEY CHECK(lane IN ('admission_pre', 'admission_frame', 'checkpoint')),
    last_rowid INTEGER,
    scanned INTEGER NOT NULL DEFAULT 0 CHECK(scanned >= 0),
    converted INTEGER NOT NULL DEFAULT 0 CHECK(converted >= 0),
    inline_bytes INTEGER NOT NULL DEFAULT 0 CHECK(inline_bytes >= 0),
    encoded_bytes_added INTEGER NOT NULL DEFAULT 0 CHECK(encoded_bytes_added >= 0),
    state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready', 'caught_up', 'blocked')),
    updated_at TEXT NOT NULL,
    blocked_rowid INTEGER
  );`);
  const insert = db.prepare(`INSERT OR IGNORE INTO accepted_model_history_conversion_v1 (lane, updated_at) VALUES (?, ?)`);
  for (const lane of ['admission_pre', 'admission_frame', 'checkpoint']) insert.run(lane, new Date().toISOString());
}
