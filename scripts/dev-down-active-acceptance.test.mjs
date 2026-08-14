import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(new URL('./dev-down.sh', import.meta.url));

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function fixture(sql) {
  const root = mkdtempSync(join(tmpdir(), 'clem-dev-down-'));
  const home = join(root, 'home');
  const stateDir = join(home, '.clementine-next', 'state');
  const binDir = join(root, 'bin');
  const callsPath = join(root, 'calls.log');
  const dbPath = join(stateDir, 'harness.db');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(callsPath, '', 'utf8');

  const schema = `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE run_attempts (
      attempt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      source_user_seq INTEGER,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
    ${sql}
  `;
  const created = spawnSync('sqlite3', [dbPath], { input: schema, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);

  writeExecutable(join(binDir, 'npx'), 'printf "npx %s\\n" "$*" >> "$DEV_DOWN_CALL_LOG"');
  writeExecutable(join(binDir, 'open'), 'printf "open %s\\n" "$*" >> "$DEV_DOWN_CALL_LOG"');
  writeExecutable(join(binDir, 'lsof'), 'exit 1');

  return {
    root,
    callsPath,
    run() {
      return spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          DEV_DOWN_CALL_LOG: callsPath,
        },
      });
    },
  };
}

test('dev-down refuses before stop or relaunch when an exact non-test chat acceptance is active', (t) => {
  const f = fixture(`
    INSERT INTO sessions (id, kind, status, metadata_json) VALUES
      ('sess-live', 'chat', 'active', '{"__run_in_flight":"2026-08-13T03:43:51.248Z"}');
    INSERT INTO run_attempts
      (attempt_id, session_id, run_id, source_user_seq, status, started_at, finished_at)
    VALUES
      ('attempt-live', 'sess-live', 'run-live', 42, 'active', '2026-08-13T03:43:51.248Z', NULL);
    INSERT INTO events (seq, session_id, type) VALUES
      (42, 'sess-live', 'user_input_received');
  `);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const result = f.run();
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /refusing to stop dev daemon/i);
  assert.match(output, /session=sess-live/);
  assert.match(output, /attempt=attempt-live/);
  assert.match(output, /sourceUserSeq=42/);
  assert.match(output, /send `stop` in the originating Discord/i);
  assert.equal(readFileSync(f.callsPath, 'utf8'), '', 'neither daemon stop nor app relaunch ran');
});

test('dev-down leaves terminal and devsmoke fixture behavior unchanged', (t) => {
  const f = fixture(`
    INSERT INTO sessions (id, kind, status, metadata_json) VALUES
      ('sess-terminal', 'chat', 'completed', '{}'),
      ('devsmoke:active-fixture', 'chat', 'active', '{"__run_in_flight":"2026-08-13T03:43:51.248Z"}');
    INSERT INTO run_attempts
      (attempt_id, session_id, run_id, source_user_seq, status, started_at, finished_at)
    VALUES
      ('attempt-terminal', 'sess-terminal', 'run-terminal', 51, 'completed', '2026-08-13T03:40:00.000Z', '2026-08-13T03:41:00.000Z'),
      ('attempt-devsmoke', 'devsmoke:active-fixture', 'run-devsmoke', 52, 'active', '2026-08-13T03:42:00.000Z', NULL);
    INSERT INTO events (seq, session_id, type) VALUES
      (51, 'sess-terminal', 'user_input_received'),
      (52, 'devsmoke:active-fixture', 'user_input_received');
  `);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const result = f.run();
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  const calls = readFileSync(f.callsPath, 'utf8');
  assert.match(calls, /npx .*src\/index\.ts daemon stop/);
  assert.match(calls, /open -a Clementine/);
  assert.match(output, /installed app relaunching/i);
});
