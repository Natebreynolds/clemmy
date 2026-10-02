/** Safe prepatch inspection: read-only metadata, no schema migration or model. */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { inspectAcceptedModelHistoryConversion } from '../src/runtime/harness/accepted-model-history-conversion.js';

if (process.argv.length > 2) throw new Error('inspection accepts no arguments and never applies conversions');
const root = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
const db = new Database(path.join(root, 'state', 'harness.db'), { readonly: true, fileMustExist: true });
try {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freePages = Number(db.pragma('freelist_count', { simple: true }));
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), modelCalls: 0, readonly: true,
    schemaVersion: (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
    databaseAllocatedBytes: pageSize * pageCount, databaseReusableBytes: pageSize * freePages,
    lanes: (['admission_pre', 'admission_frame', 'checkpoint'] as const).map(lane => inspectAcceptedModelHistoryConversion(db, lane)),
    caveat: 'Next 32 rows per lane only. Eligible bytes are not savings. Reusable pages remain allocated on disk. No histories or credentials were read.' }, null, 2));
} finally { db.close(); }
