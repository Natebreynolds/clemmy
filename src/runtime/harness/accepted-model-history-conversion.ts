/** Bounded, resumable exact representation conversion. No retention, model
 * calls, credential access or execution of recovered work. Schema 90 must be
 * installed before using this writer. Dry-run inspection is read-only. */
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { prepareAcceptedModelHistory, storePreparedAcceptedModelHistory,
  withPreparedAcceptedModelHistoryReader, type ExistingAcceptedModelHistory } from './accepted-model-history-store.js';

const LANES = {
  admission_pre: ['accepted_model_batch_admissions', 'pre_history'],
  admission_frame: ['accepted_model_batch_admissions', 'frame_history'],
  checkpoint: ['accepted_model_batch_checkpoints', 'history'],
} as const;
export type HistoryConversionLane = keyof typeof LANES;
export interface HistoryConversionBudget { maxRows?: number; maxInputBytes?: number; maxDurationMs?: number }
interface RowSize { rowid: string; bytes: number; referenced: number }
interface SourceHistory { json: string; digest: string; itemCount: number }
export interface HistoryConversionResult {
  lane: HistoryConversionLane;
  scanned: number;
  converted: number;
  inputBytes: number;
  inlineBytesRemoved: number;
  encodedBytesAdded: number;
  state: 'caught_up' | 'budget_exhausted' | 'blocked' | 'deferred';
  blockedRowid: string | null;
  requiredInputBudget: number | null;
  durationMs: number;
}

function budget(options: HistoryConversionBudget) {
  const result = { maxRows: options.maxRows ?? 4, maxInputBytes: options.maxInputBytes ?? 4 * 1024 * 1024,
    maxDurationMs: options.maxDurationMs ?? 25 };
  if (!Object.values(result).every(n => Number.isSafeInteger(n) && n > 0)
    || result.maxRows > 1_000 || result.maxInputBytes > 32 * 1024 * 1024 || result.maxDurationMs > 5_000) {
    throw new Error('invalid exact history conversion budget');
  }
  return result;
}

function nextRow(db: Database.Database, lane: HistoryConversionLane, lastRowid: string | null): RowSize | undefined {
  const [table, column] = LANES[lane];
  return db.prepare(`SELECT CAST(rowid AS TEXT) AS rowid, octet_length(${column}_json) AS bytes,
    ${column}_object_digest IS NOT NULL AS referenced FROM ${table} source
    ${lastRowid === null ? '' : 'WHERE source.rowid > CAST(? AS INTEGER)'} ORDER BY source.rowid LIMIT 1`)
    .get(...(lastRowid === null ? [] : [lastRowid])) as RowSize | undefined;
}

/** Prepare outside the writer lock, then atomically publish the object, source
 * conversion and durable cursor after rechecking the observed row/cursor.
 * Work/time limits yield between rows; raw input bytes are a hard per-call bound. An
 * eligible row larger than that budget is reported without reading its body,
 * not silently skipped. Histories outside codec bounds remain inline. */
export function convertAcceptedModelHistoryBatch(db: Database.Database, options: HistoryConversionBudget & {
  lane: HistoryConversionLane;
  /** Rechecked under the SQLite writer lock before each row. False yields
   * without advancing; no foreground task has to wait for a whole batch. */
  shouldContinue?: () => boolean;
}): HistoryConversionResult {
  const limits = budget(options);
  const [table, column] = LANES[options.lane];
  const started = performance.now();
  const result: HistoryConversionResult = { lane: options.lane, scanned: 0, converted: 0, inputBytes: 0,
    inlineBytesRemoved: 0, encodedBytesAdded: 0, state: 'budget_exhausted', blockedRowid: null,
    requiredInputBudget: null, durationMs: 0 };
  const cursor = db.prepare(`SELECT CAST(last_rowid AS TEXT) AS last_rowid FROM accepted_model_history_conversion_v1 WHERE lane = ?`);
  const sourceHistory = db.prepare(`SELECT ${column}_json AS json, ${column}_digest AS digest,
    ${column}_item_count AS itemCount FROM ${table} WHERE rowid = CAST(? AS INTEGER)`);
  const sourceProof = db.prepare(`SELECT ${column}_digest AS digest, ${column}_item_count AS itemCount
    FROM ${table} WHERE rowid = CAST(? AS INTEGER)`);
  const advance = db.prepare(`UPDATE accepted_model_history_conversion_v1 SET last_rowid = CAST(? AS INTEGER),
    scanned = scanned + 1, converted = converted + ?, inline_bytes = inline_bytes + ?,
    encoded_bytes_added = encoded_bytes_added + ?, state = 'ready', blocked_rowid = NULL, updated_at = ? WHERE lane = ?`);
  while (result.scanned < limits.maxRows && performance.now() - started < limits.maxDurationMs) {
    let candidateRowid: string | null = null;
    let candidatePosition: string | null = null;
    let candidateMetadata: RowSize | undefined;
    try {
      // A short deferred read snapshot binds the cursor/row/body. Close it
      // before CPU-heavy parse/hash/deflate so foreground writes and WAL
      // checkpoints do not wait for codec preparation.
      const inspected = db.transaction(() => {
        const position = cursor.get(options.lane) as { last_rowid: string | null } | undefined;
        if (!position) throw new Error('history conversion schema is not ready');
        candidatePosition = position.last_rowid;
        const row = nextRow(db, options.lane, position.last_rowid);
        candidateMetadata = row;
        candidateRowid = row?.rowid ?? null;
        const eligible = !!row && !row.referenced && row.bytes >= 32 * 1024 && row.bytes <= 32 * 1024 * 1024;
        const source = eligible && row.bytes <= limits.maxInputBytes - result.inputBytes
          ? sourceHistory.get(row.rowid) as SourceHistory : undefined;
        const existing = source ? db.prepare(`SELECT encoded, codec, plaintext_bytes, digest, item_count
          FROM accepted_model_history_objects_v1 WHERE digest = ?`).get(source.digest) as ExistingAcceptedModelHistory | undefined : undefined;
        return { position: position.last_rowid, row, eligible, source, existing };
      })();
      const prepared = inspected.source ? prepareAcceptedModelHistory(inspected.source.json, inspected.existing) : undefined;
      const publish = () => db.transaction(() => {
        if (options.shouldContinue && !options.shouldContinue()) return { kind: 'deferred' } as const;
        const position = cursor.get(options.lane) as { last_rowid: string | null } | undefined;
        if (!position) throw new Error('history conversion schema is not ready');
        if (position.last_rowid !== inspected.position) return { kind: 'retry' } as const;
        const row = nextRow(db, options.lane, position.last_rowid);
        if (row?.rowid !== inspected.row?.rowid || row?.bytes !== inspected.row?.bytes
          || row?.referenced !== inspected.row?.referenced) return { kind: 'retry' } as const;
        if (!row) {
          db.prepare(`UPDATE accepted_model_history_conversion_v1 SET state = 'caught_up', blocked_rowid = NULL,
            updated_at = ? WHERE lane = ?`).run(new Date().toISOString(), options.lane);
          return { kind: 'done' } as const;
        }
        const eligible = inspected.eligible;
        if (eligible && row.bytes > limits.maxInputBytes - result.inputBytes) {
          return { kind: 'budget', required: row.bytes } as const;
        }
        let removed = 0;
        let added = 0;
        let converted = 0;
        if (eligible) {
          const source = sourceProof.get(row.rowid) as Pick<SourceHistory, 'digest' | 'itemCount'> | undefined;
          if (!source || !inspected.source || !prepared) throw new Error('history preparation is unavailable');
          if (source.digest !== inspected.source.digest
            || source.itemCount !== inspected.source.itemCount) return { kind: 'retry' } as const;
          // The unchanged SQL UPDATE fence compares the prepared object's
          // decoded bytes against the current OLD JSON, not our read snapshot.
          // Avoid copying the large body into JavaScript a second time here.
          const before = (db.prepare('SELECT total(length(encoded)) AS bytes FROM accepted_model_history_objects_v1 WHERE digest = ?')
            .get(source.digest) as { bytes: number }).bytes;
          const stored = storePreparedAcceptedModelHistory(db, prepared);
          if (stored.objectDigest) {
            db.prepare(`UPDATE ${table} SET ${column}_json = '[]', ${column}_object_digest = ? WHERE rowid = CAST(? AS INTEGER)`)
              .run(stored.objectDigest, row.rowid);
            const encoded = (db.prepare('SELECT length(encoded) AS bytes FROM accepted_model_history_objects_v1 WHERE digest = ?')
              .get(stored.objectDigest) as { bytes: number }).bytes;
            added = before ? 0 : encoded;
            removed = row.bytes - 2;
            converted = 1;
          }
        }
        advance.run(row.rowid, converted, removed, added, new Date().toISOString(), options.lane);
        return { kind: 'scanned', converted, removed, added, input: eligible ? row.bytes : 0 } as const;
      }).immediate();
      const step = prepared ? withPreparedAcceptedModelHistoryReader(db, prepared, publish) : publish();
      if (step.kind === 'retry') continue;
      if (step.kind === 'deferred') { result.state = 'deferred'; break; }
      if (step.kind === 'done') { result.state = 'caught_up'; break; }
      if (step.kind === 'budget') { result.requiredInputBudget = step.required; break; }
      result.scanned += 1;
      result.converted += step.converted;
      result.inlineBytesRemoved += step.removed;
      result.encodedBytesAdded += step.added;
      result.inputBytes += step.input;
    } catch (error) {
      // Publication rolled back. Do not advance past damaged proof, expose
      // source content in an error, or prevent unrelated lanes progressing.
      // A competing writer is contention, not damaged evidence. The worker
      // reports it as deferred; no blocked marker or cursor is published.
      const code = (error as { code?: string })?.code;
      if (candidateRowid === null || code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED')) throw error;
      const marked = db.transaction(() => {
        const position = cursor.get(options.lane) as { last_rowid: string | null } | undefined;
        const current = position ? nextRow(db, options.lane, position.last_rowid) : undefined;
        if (!position || position.last_rowid !== candidatePosition || current?.rowid !== candidateRowid
          || current?.bytes !== candidateMetadata?.bytes || current?.referenced !== candidateMetadata?.referenced) return false;
        db.prepare(`UPDATE accepted_model_history_conversion_v1 SET state = 'blocked', blocked_rowid = CAST(? AS INTEGER),
          updated_at = ? WHERE lane = ?`).run(candidateRowid, new Date().toISOString(), options.lane);
        return true;
      }).immediate();
      if (!marked) continue;
      result.state = 'blocked';
      result.blockedRowid = candidateRowid;
      break;
    }
  }
  result.durationMs = performance.now() - started;
  return result;
}

/** Metadata-only sample of the next lane, not a whole-DB savings forecast.
 * Works against pre-89 stores too, without running a schema migration. */
export function inspectAcceptedModelHistoryConversion(db: Database.Database, lane: HistoryConversionLane, maxRows = 32) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000) throw new Error('invalid history inspection budget');
  const [table, column] = LANES[lane];
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(row => row.name === `${column}_json`)) throw new Error('history source unavailable');
  const hasRef = columns.some(row => row.name === `${column}_object_digest`);
  const hasCursor = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accepted_model_history_conversion_v1'`).get();
  const position = hasCursor ? db.prepare('SELECT CAST(last_rowid AS TEXT) AS rowid FROM accepted_model_history_conversion_v1 WHERE lane = ?')
    .get(lane) as { rowid: string | null } | undefined : undefined;
  const rows = db.prepare(`SELECT CAST(rowid AS TEXT) AS rowid, octet_length(${column}_json) AS bytes,
    ${hasRef ? `${column}_object_digest IS NOT NULL` : '0'} AS referenced FROM ${table} source
    ${position?.rowid == null ? '' : 'WHERE source.rowid > CAST(? AS INTEGER)'} ORDER BY source.rowid LIMIT ?`)
    .all(...(position?.rowid == null ? [] : [position.rowid]), maxRows) as RowSize[];
  return { lane, sampledRows: rows.length, eligibleRows: rows.filter(row => !row.referenced && row.bytes >= 32 * 1024 && row.bytes <= 32 * 1024 * 1024).length,
    sampledInlineBytes: rows.reduce((sum, row) => sum + (row.referenced ? 0 : row.bytes), 0),
    largestInlineBytes: rows.reduce((max, row) => Math.max(max, row.referenced ? 0 : row.bytes), 0),
    lastRowid: position?.rowid ?? null };
}
