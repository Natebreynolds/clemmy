/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-model-batch-checkpoint-process.test.ts
 *
 * Real-process crash coverage for a Discord-scoped accepted source. The parent
 * sends SIGKILL only after the child reports that the balanced checkpoint is
 * durable, then a fresh process reopens the same source and continues from it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const FIXTURE = fileURLToPath(new URL('./accepted-model-batch-checkpoint-process-fixture.ts', import.meta.url));

interface ChildResult {
  marker: Record<string, unknown>;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function disposableHome(label: string): string {
  const home = mkdtempSync(path.join(os.tmpdir(), `clem-model-batch-process-${label}-`));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  writeFileSync(path.join(home, 'state', 'machine-id'), `machine-model-batch-${label}\n`, 'utf8');
  return home;
}

function childProcess(home: string, mode: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', FIXTURE, mode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      MCP_AUTO_IMPORT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForMarker(
  child: ChildProcess,
  prefix: 'READY' | 'DONE',
  options: { killAfterMarker?: boolean } = {},
): Promise<ChildResult> {
  let stdout = '';
  let stderr = '';
  let marker: Record<string, unknown> | undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith(`${prefix} `)) continue;
      marker = JSON.parse(line.slice(prefix.length + 1)) as Record<string, unknown>;
    }
  });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  const deadline = Date.now() + 20_000;
  while (!marker && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!marker) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw new Error(`${prefix} marker missing; stdout=${stdout}; stderr=${stderr}`);
  }
  if (options.killAfterMarker) child.kill('SIGKILL');
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { marker, stdout, stderr, ...exit };
}

function crashAt(
  home: string,
  mode: 'start-after-read' | 'start-after-write' | 'start-after-write-missing-input',
) {
  return waitForMarker(childProcess(home, mode), 'READY', { killAfterMarker: true });
}

function runToCompletion(
  home: string,
  mode:
    | 'resume-after-read'
    | 'resume-after-write'
    | 'resume-after-write-no-dispatcher'
    | 'resume-after-write-missing-input',
) {
  return waitForMarker(childProcess(home, mode), 'DONE');
}

function auditLines(home: string): string[] {
  const raw = readFileSync(path.join(home, 'state', 'checkpoint-process-audit.log'), 'utf8');
  return raw.trim().split(/\r?\n/).filter(Boolean);
}

function snapshot(home: string) {
  const db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true });
  try {
    const source = db.prepare(`
      SELECT seq FROM events
       WHERE session_id = 'discord-midturn-restart' AND type = 'user_input_received'
    `).get() as { seq: number };
    const root = db.prepare(`
      SELECT accepted_task_id, authority_digest, state
        FROM accepted_turn_call_authorities
       WHERE session_id = 'discord-midturn-restart' AND source_user_seq = ?
    `).get(source.seq) as { accepted_task_id: string; authority_digest: string; state: string };
    const graph = db.prepare(`
      SELECT id, json_extract(data_json, '$.graphId') AS graph_id,
             json_extract(data_json, '$.graphHash') AS graph_hash
        FROM events
       WHERE session_id = 'discord-midturn-restart' AND type = 'turn_graph_compiled'
    `).all() as Array<{ id: string; graph_id: string; graph_hash: string }>;
    const admissions = db.prepare(`
      SELECT batch_ordinal, batch_id, authority_digest, provider_response_id,
             call_ids_json, pre_history_digest
        FROM accepted_model_batch_admissions
       WHERE session_id = 'discord-midturn-restart' AND source_user_seq = ?
       ORDER BY batch_ordinal
    `).all(source.seq) as Array<Record<string, unknown>>;
    const checkpoints = db.prepare(`
      SELECT batch_ordinal, batch_id, authority_digest, disposition,
             history_digest, last_response_id
        FROM accepted_model_batch_checkpoints
       WHERE session_id = 'discord-midturn-restart' AND source_user_seq = ?
       ORDER BY batch_ordinal
    `).all(source.seq) as Array<Record<string, unknown>>;
    const calls = db.prepare(`
      SELECT l.logical_tool_call_id, l.accepted_task_id, l.state AS logical_state,
             COUNT(DISTINCT p.physical_dispatch_id) AS physical_count,
             COUNT(DISTINCT s.settlement_event_id) AS settlement_count,
             COUNT(DISTINCT h.handle_id) AS result_handle_count
        FROM logical_tool_calls l
        LEFT JOIN physical_dispatches p
          ON p.session_id = l.session_id
         AND p.source_user_seq = l.source_user_seq
         AND p.logical_tool_call_id = l.logical_tool_call_id
        LEFT JOIN logical_call_settlements s
          ON s.session_id = l.session_id
         AND s.source_user_seq = l.source_user_seq
         AND s.logical_tool_call_id = l.logical_tool_call_id
        LEFT JOIN durable_result_handles h
          ON h.session_id = l.session_id
         AND h.source_user_seq = l.source_user_seq
         AND h.logical_tool_call_id = l.logical_tool_call_id
       WHERE l.session_id = 'discord-midturn-restart' AND l.source_user_seq = ?
       GROUP BY l.logical_tool_call_id, l.accepted_task_id, l.state
       ORDER BY l.logical_tool_call_id
    `).all(source.seq) as Array<Record<string, unknown>>;
    const terminals = db.prepare(`
      SELECT id, json_extract(data_json, '$.terminalKey') AS terminal_key
        FROM events
       WHERE session_id = 'discord-midturn-restart' AND type = 'conversation_completed'
    `).all() as Array<{ id: string; terminal_key: string }>;
    const session = db.prepare(`
      SELECT channel, metadata_json FROM sessions WHERE id = 'discord-midturn-restart'
    `).get() as { channel: string; metadata_json: string };
    return { source, root, graph, admissions, checkpoints, calls, terminals, session };
  } finally {
    db.close();
  }
}

function assertExactOnce(snapshotValue: ReturnType<typeof snapshot>): void {
  assert.equal(snapshotValue.session.channel, 'discord');
  assert.equal(JSON.parse(snapshotValue.session.metadata_json).source, 'discord');
  assert.equal(snapshotValue.graph.length, 1, 'the same accepted source owns one durable graph');
  assert.equal(snapshotValue.admissions.length, 2, 'the model authored exactly two accepted response frames');
  assert.deepEqual(
    snapshotValue.admissions.map((row) => row.provider_response_id),
    ['model-response-read', 'model-response-write'],
  );
  assert.deepEqual(
    snapshotValue.admissions.map((row) => JSON.parse(String(row.call_ids_json))),
    [['restaurant-read'], ['sheet-create']],
  );
  assert.deepEqual(
    snapshotValue.checkpoints.map((row) => ({
      ordinal: row.batch_ordinal,
      disposition: row.disposition,
      response: row.last_response_id,
    })),
    [
      { ordinal: 1, disposition: 'ready', response: 'model-response-read' },
      { ordinal: 2, disposition: 'ready', response: 'model-response-write' },
    ],
  );
  assert.ok(snapshotValue.admissions.every((row) => row.authority_digest === snapshotValue.root.authority_digest));
  assert.ok(snapshotValue.checkpoints.every((row) => row.authority_digest === snapshotValue.root.authority_digest));
  assert.deepEqual(snapshotValue.calls, [
    {
      logical_tool_call_id: 'restaurant-read',
      accepted_task_id: snapshotValue.root.accepted_task_id,
      logical_state: 'settled',
      physical_count: 1,
      settlement_count: 1,
      result_handle_count: 1,
    },
    {
      logical_tool_call_id: 'sheet-create',
      accepted_task_id: snapshotValue.root.accepted_task_id,
      logical_state: 'settled',
      physical_count: 1,
      settlement_count: 1,
      result_handle_count: 1,
    },
  ]);
  assert.equal(snapshotValue.terminals.length, 1);
  assert.equal(snapshotValue.terminals[0]?.terminal_key, `turn:${snapshotValue.source.seq}`);
}

test('SIGKILL after the restaurant-read checkpoint resumes the same Discord source and creates one Sheet', { timeout: 40_000 }, async () => {
  const home = disposableHome('after-read');
  try {
    const crashed = await crashAt(home, 'start-after-read');
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.marker.crashPoint, 'after-read-checkpoint');
    assert.equal(crashed.marker.batchOrdinal, 1);

    const resumed = await runToCompletion(home, 'resume-after-read');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.marker.resumePoint, 'after-read');
    assert.equal(resumed.marker.sessionId, crashed.marker.sessionId);
    assert.equal(resumed.marker.sourceUserSeq, crashed.marker.sourceUserSeq);
    assert.equal(resumed.marker.acceptedTaskId, crashed.marker.acceptedTaskId);
    assert.equal(resumed.marker.authorityDigest, crashed.marker.authorityDigest);
    assert.equal(resumed.marker.graphEventId, crashed.marker.graphEventId);
    assert.equal(resumed.marker.graphId, crashed.marker.graphId);
    assert.equal(resumed.marker.graphHash, crashed.marker.graphHash);

    const beforeIdempotentResume = auditLines(home);
    const secondResume = await runToCompletion(home, 'resume-after-write');
    assert.equal(secondResume.code, 0, secondResume.stderr);
    assert.equal(secondResume.marker.inserted, false, 'the exact terminal winner is replayed');
    assert.deepEqual(auditLines(home), beforeIdempotentResume, 'completed restart enters no model/provider body');
    assert.deepEqual(auditLines(home), [
      'model:response:read',
      'provider:body:restaurant-read',
      'model:response:write',
      'provider:body:sheet-create',
    ]);
    assertExactOnce(snapshot(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SIGKILL after the Sheet-create checkpoint adopts its receipt with zero repeated model or provider work', { timeout: 40_000 }, async () => {
  const home = disposableHome('after-write');
  try {
    const crashed = await crashAt(home, 'start-after-write');
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.marker.crashPoint, 'after-write-checkpoint');
    assert.equal(crashed.marker.batchOrdinal, 2);
    const auditAtCrash = auditLines(home);
    assert.deepEqual(auditAtCrash, [
      'model:response:read',
      'provider:body:restaurant-read',
      'model:response:write',
      'provider:body:sheet-create',
    ]);

    const resumed = await runToCompletion(home, 'resume-after-write');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.marker.resumePoint, 'after-write');
    assert.equal(resumed.marker.sessionId, crashed.marker.sessionId);
    assert.equal(resumed.marker.sourceUserSeq, crashed.marker.sourceUserSeq);
    assert.equal(resumed.marker.acceptedTaskId, crashed.marker.acceptedTaskId);
    assert.equal(resumed.marker.authorityDigest, crashed.marker.authorityDigest);
    assert.equal(resumed.marker.graphEventId, crashed.marker.graphEventId);
    assert.equal(resumed.marker.graphId, crashed.marker.graphId);
    assert.equal(resumed.marker.graphHash, crashed.marker.graphHash);
    assert.deepEqual(auditLines(home), auditAtCrash, 'restart adopts both settled results without model/provider re-entry');

    const secondResume = await runToCompletion(home, 'resume-after-write');
    assert.equal(secondResume.code, 0, secondResume.stderr);
    assert.equal(secondResume.marker.inserted, false);
    assert.deepEqual(auditLines(home), auditAtCrash);
    assertExactOnce(snapshot(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a ready write checkpoint is not promoted without a restart dispatcher', { timeout: 40_000 }, async () => {
  const home = disposableHome('after-write-no-dispatcher');
  try {
    const crashed = await crashAt(home, 'start-after-write');
    assert.equal(crashed.signal, 'SIGKILL');

    const resumed = await runToCompletion(home, 'resume-after-write-no-dispatcher');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.marker.autoResumed, false);
    assert.equal(resumed.marker.autoResumeSkipped, 'no_dispatcher');
    assert.equal(
      resumed.marker.recoveryStatePresent,
      false,
      'manual recovery must not leave an exact checkpoint owner with no dispatcher',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a ready write checkpoint is not promoted without accepted input bytes', { timeout: 40_000 }, async () => {
  const home = disposableHome('after-write-missing-input');
  try {
    const crashed = await crashAt(home, 'start-after-write-missing-input');
    assert.equal(crashed.signal, 'SIGKILL');
    const auditAtCrash = auditLines(home);

    const resumed = await runToCompletion(home, 'resume-after-write-missing-input');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.marker.batchOrdinal, 2, 'the settled write checkpoint is fully ready');
    assert.equal(resumed.marker.autoResumed, false);
    assert.equal(resumed.marker.autoResumeSkipped, 'identity_missing');
    assert.equal(resumed.marker.dispatches, 0);
    assert.equal(
      resumed.marker.recoveryStatePresent,
      false,
      'missing accepted input cannot mint an exact continuation owner',
    );
    assert.deepEqual(auditLines(home), auditAtCrash, 'no model or provider body is re-entered');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
