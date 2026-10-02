/** Read-only page metadata and three durable progress rows. No history scans,
 * payload opening, schema migrations, deletion, credentials or model calls. */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { StorageDatabaseStatus } from '../shared/storage-inventory.js';

export async function readStorageDatabaseStatus(baseDir: string): Promise<StorageDatabaseStatus> {
  let db: Database.Database | undefined;
  try {
    const root = await realpath(path.resolve(baseDir));
    const file = path.join(root, 'state', 'harness.db');
    // Inventory never follows linked state folders or database files.
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || await realpath(file) !== file) return { state: 'unavailable' };
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 50 });
    db.pragma('query_only = ON');
    const result = db.transaction((): StorageDatabaseStatus => {
      const pageSize = Number(db!.pragma('page_size', { simple: true }));
      const pageCount = Number(db!.pragma('page_count', { simple: true }));
      const freePages = Number(db!.pragma('freelist_count', { simple: true }));
      if (![pageSize, pageCount, freePages].every(n => Number.isSafeInteger(n) && n >= 0)
        || pageSize === 0 || freePages > pageCount || !Number.isSafeInteger(pageSize * pageCount)) throw new Error('invalid page metadata');
      let historyConversion: Extract<StorageDatabaseStatus, { state: 'measured' }>['historyConversion'] = null;
      if (db!.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accepted_model_history_conversion_v1'`).get()) {
        const rows = db!.prepare(`SELECT lane, state, scanned, converted, inline_bytes, encoded_bytes_added
          FROM accepted_model_history_conversion_v1 LIMIT 4`).all() as Array<{
          lane: string; state: string; scanned: number; converted: number; inline_bytes: number; encoded_bytes_added: number;
        }>;
        if (rows.length !== 3 || new Set(rows.map(row => row.lane)).size !== 3
          || rows.some(row => !['admission_pre', 'admission_frame', 'checkpoint'].includes(row.lane)
            || !['ready', 'caught_up', 'blocked'].includes(row.state)
            || ![row.scanned, row.converted, row.inline_bytes, row.encoded_bytes_added].every(n => Number.isSafeInteger(n) && n >= 0)
            || row.converted > row.scanned)) throw new Error('invalid conversion progress');
        const sum = (key: 'scanned' | 'converted' | 'inline_bytes' | 'encoded_bytes_added') => rows.reduce((n, row) => n + row[key], 0);
        const convertedHistories = sum('converted');
        const netLogicalPayloadBytesRemoved = sum('inline_bytes') - sum('encoded_bytes_added') - convertedHistories * 64;
        if (![sum('scanned'), convertedHistories, netLogicalPayloadBytesRemoved].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid conversion totals');
        historyConversion = { state: rows.some(row => row.state === 'blocked') ? 'blocked'
          : rows.every(row => row.state === 'caught_up') ? 'caught_up'
          : sum('scanned') === 0 ? 'not_started' : 'partial', scannedRows: sum('scanned'), convertedHistories,
          netLogicalPayloadBytesRemoved };
      }
      return { state: 'measured', allocatedBytes: pageSize * pageCount, reusableBytes: pageSize * freePages, historyConversion };
    }).deferred();
    const after = await lstat(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()
      || after.nlink !== 1 || await realpath(file) !== file) return { state: 'unavailable' };
    return result;
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_created' : 'unavailable' };
  } finally { db?.close(); }
}
