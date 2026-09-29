/**
 * What one accepted request cost, all of it: the request, its helpers, the
 * tasks it delegated and their helpers, the router, the reviewers and the
 * learning that named it.
 *
 * Reads a Clementine home without changing it: the event log is opened
 * read-only, task records and usage logs are read as files.
 *
 *   npx tsx scripts/measure-whole-task.mts <home> <sessionId> <sourceUserSeq>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { wholeTaskUsage, type WholeTaskUsageSources } from '../src/runtime/whole-task-usage.js';
import type { UsageEvent } from '../src/runtime/usage-log.js';

const [home, sessionId, seqText] = process.argv.slice(2);
const sourceUserSeq = Number(seqText);
if (!home || !sessionId || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
  console.error('usage: measure-whole-task.mts <home> <sessionId> <sourceUserSeq>');
  process.exit(2);
}

const db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const sources: WholeTaskUsageSources = {
  usageForDate(date) {
    const dir = path.join(home, 'state', 'token-usage');
    const rows: UsageEvent[] = [];
    // The log names its files by day; read both spellings of the day so a
    // home written in another zone is still found.
    for (const name of new Set([`${localDay(date)}.ndjson`, `${date.toISOString().slice(0, 10)}.ndjson`])) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line) as UsageEvent); } catch { /* a torn line is not a row */ }
      }
    }
    return rows;
  },
  events(session, types) {
    if (types.length === 0) return [];
    const rows = db.prepare(`
      SELECT seq, type, created_at AS createdAt, data_json AS data FROM events
       WHERE session_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq
    `).all(session, ...types) as Array<{ seq: number; type: string; createdAt: string; data: string }>;
    return rows.map((row) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { /* unreadable data names nothing */ }
      return { seq: row.seq, type: row.type, createdAt: row.createdAt, data };
    });
  },
  tasks() {
    const dir = path.join(home, 'state', 'background-tasks');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try { return [JSON.parse(readFileSync(path.join(dir, name), 'utf-8'))]; } catch { return []; }
    });
  },
};

try {
  console.log(JSON.stringify(wholeTaskUsage({ sessionId, sourceUserSeq }, sources), null, 2));
} finally {
  db.close();
}
