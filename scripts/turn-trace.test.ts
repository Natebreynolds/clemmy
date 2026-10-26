import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const script = fileURLToPath(new URL('./turn-trace.ts', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(run: (db: Database.Database, trace: (limit?: number) => string) => void, hostTable = true) {
  const home = mkdtempSync(path.join(tmpdir(), 'clem-turn-trace-'));
  mkdirSync(path.join(home, 'state'));
  const dbPath = path.join(home, 'state', 'harness.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER UNIQUE,
      turn INTEGER, role TEXT, type TEXT, created_at TEXT, data_json TEXT);
    CREATE TABLE accepted_task_authority (session_id TEXT, source_user_seq INTEGER);
    ${hostTable ? 'CREATE TABLE accepted_turn_call_authorities (session_id TEXT, source_user_seq INTEGER, authority_kind TEXT, state TEXT);' : ''}
  `);
  const trace = (limit = 10) => {
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, String(limit)], {
      cwd: root,
      env: { ...process.env, CLEMENTINE_HOME: home },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), before, 'trace never writes the database');
    return result.stdout;
  };
  try { run(db, trace); } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
}

function source(db: Database.Database, seq: number, authority: 'host' | 'graph' | 'both', options: {
  session?: string; role?: string; type?: string; synthetic?: boolean;
} = {}) {
  const session = options.session ?? `fixture-${seq}`;
  db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)').run(
    `source-${seq}`, session, seq, 1, options.role ?? 'user', options.type ?? 'user_input_received',
    '2026-10-26T12:00:00Z', JSON.stringify({ text: `Synthetic request ${seq}`, synthetic: options.synthetic ?? false }),
  );
  if (authority !== 'host') db.prepare('INSERT INTO accepted_task_authority VALUES (?,?)').run(session, seq);
  if (authority !== 'graph') db.prepare('INSERT INTO accepted_turn_call_authorities VALUES (?,?,?,?)').run(session, seq, 'host_v1', 'open');
}

test('ordinary host turns appear alongside planned turns without duplicate accepted sources', () => fixture((db, trace) => {
  source(db, 10, 'graph');
  source(db, 20, 'host');
  source(db, 30, 'both');
  const output = trace();
  assert.match(output, /3 source\(s\)/);
  assert.equal((output.match(/━━ seq 20 /g) ?? []).length, 1, 'host-only source appears');
  assert.equal((output.match(/━━ seq 30 /g) ?? []).length, 1, 'host plus plan is one accepted source');
  assert.match(output, /host authority: host_v1 · open/);
  assert.match(output, /no planned graph observed; host call authority above/);
  assert.ok(output.indexOf('━━ seq 10 ') < output.indexOf('━━ seq 20 '));
  assert.ok(output.indexOf('━━ seq 20 ') < output.indexOf('━━ seq 30 '));
}));

test('recent limit applies across host and planned sources', () => fixture((db, trace) => {
  source(db, 10, 'graph'); source(db, 20, 'host'); source(db, 30, 'both'); source(db, 40, 'host');
  const output = trace(2);
  assert.match(output, /2 source\(s\)/);
  assert.doesNotMatch(output, /━━ seq (10|20) /);
  assert.match(output, /━━ seq 30 /);
  assert.match(output, /━━ seq 40 /);
}));

test('authority rows cannot turn foreign, synthetic or non-user events into accepted human sources', () => fixture((db, trace) => {
  source(db, 10, 'host');
  source(db, 20, 'host', { synthetic: true });
  source(db, 30, 'graph', { role: 'system' });
  source(db, 40, 'graph', { type: 'tool_returned' });
  db.prepare('INSERT INTO accepted_turn_call_authorities VALUES (?,?,?,?)').run('foreign-session', 10, 'host_v1', 'open');
  db.prepare('INSERT INTO accepted_turn_call_authorities VALUES (?,?,?,?)').run('orphan-session', 50, 'host_v1', 'open');
  const output = trace();
  assert.match(output, /1 source\(s\)/);
  assert.match(output, /━━ seq 10 /);
  assert.doesNotMatch(output, /━━ seq (20|30|40|50) /);
}));

test('older graph-only databases remain readable', () => fixture((db, trace) => {
  source(db, 10, 'graph');
  assert.match(trace(), /1 source\(s\)/);
}, false));

test('host read-only roots are included without treating other workflow authority kinds as chat', () => fixture((db, trace) => {
  source(db, 10, 'host'); source(db, 20, 'host');
  db.prepare('UPDATE accepted_turn_call_authorities SET authority_kind=? WHERE source_user_seq=?').run('host_v1_read_only', 10);
  db.prepare('UPDATE accepted_turn_call_authorities SET authority_kind=? WHERE source_user_seq=?').run('workflow_v3_call', 20);
  const output = trace();
  assert.match(output, /1 source\(s\)/);
  assert.match(output, /host authority: host_v1_read_only · open/);
  assert.doesNotMatch(output, /━━ seq 20 /);
}));
