/**
 * A real OS-process restart proof for the host-derived mutation vertical.
 * SQLite owns durable call/result/settlement state; the provider-body witness
 * is a separate append-only file so reopening rows cannot masquerade as a
 * second provider execution.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'src/journeys/gauntlet-sheet-derived-verification.red.test.ts');
const MARKER = '@@CLEM_DERIVED_RESTART@@';

const CREATE = 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1';
const READ = 'GOOGLESHEETS_BATCH_GET';
const UPDATE = 'GOOGLESHEETS_VALUES_UPDATE';

type DurableProviderCallSnapshot = {
  logicalToolCallId: string;
  operation: string;
  businessCall: boolean;
  logicalRows: number;
  physicalRows: number;
  settlementRows: number;
  resultRows: number;
};

type PhaseResult = {
  phase: 'A' | 'B';
  pid: number;
  sessionId: string;
  sourceUserSeq: number;
  localProviderBodies: string[];
  localModelCalls: number;
  replayAdditionalProviderCrossings: number;
  replayAdditionalModelCalls: number;
  replayAdditionalTerminalEvents: number;
  before: DurableProviderCallSnapshot[];
  snapshot: DurableProviderCallSnapshot[];
};

function spawnPhase(input: {
  home: string;
  bodyLog: string;
  phase: 'A' | 'B';
  prior?: PhaseResult;
}): PhaseResult {
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      CLEMENTINE_HOME: input.home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEM_DERIVED_RESTART_FIXTURE: '1',
      CLEM_DERIVED_RESTART_PHASE: input.phase,
      CLEM_DERIVED_RESTART_BODY_LOG: input.bodyLog,
      ...(input.prior ? {
        CLEM_DERIVED_RESTART_PRIOR: Buffer.from(JSON.stringify({
          sessionId: input.prior.sessionId,
          sourceUserSeq: input.prior.sourceUserSeq,
          snapshot: input.prior.snapshot,
        }), 'utf8').toString('base64url'),
      } : {}),
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const markerLine = child.stdout.split('\n').find((line) => line.startsWith(MARKER));
  assert.ok(markerLine, `restart fixture emitted no result marker:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(markerLine.slice(MARKER.length)) as PhaseResult;
}

test('the four-phase verified mutation reopens in another process with zero redispatch', { timeout: 360_000 }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-derived-process-restart-'));
  const bodyLog = path.join(home, 'provider-bodies.jsonl');
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-derived-process-restart\n', 'utf8');
    writeFileSync(bodyLog, '', { encoding: 'utf8', mode: 0o600 });

    const phaseA = spawnPhase({ home, bodyLog, phase: 'A' });
    assert.deepEqual(phaseA.localProviderBodies, [CREATE, READ, UPDATE, READ]);
    assert.equal(phaseA.snapshot.length, 4);
    assert.deepEqual(phaseA.snapshot.map((call) => call.operation), [CREATE, READ, UPDATE, READ]);
    assert.deepEqual(phaseA.snapshot.map((call) => call.businessCall), [true, false, true, false]);
    assert.equal(new Set(phaseA.snapshot.map((call) => call.logicalToolCallId)).size, 4);
    for (const call of phaseA.snapshot) {
      assert.deepEqual({
        logical: call.logicalRows,
        physical: call.physicalRows,
        settlement: call.settlementRows,
        result: call.resultRows,
      }, { logical: 1, physical: 1, settlement: 1, result: 1 });
    }

    const phaseB = spawnPhase({ home, bodyLog, phase: 'B', prior: phaseA });
    assert.notEqual(phaseB.pid, phaseA.pid, 'the reopen proof must use a distinct OS process');
    assert.equal(phaseB.sessionId, phaseA.sessionId);
    assert.equal(phaseB.sourceUserSeq, phaseA.sourceUserSeq);
    assert.deepEqual(phaseB.localProviderBodies, [], 'process B must execute zero provider bodies');
    assert.equal(phaseB.localModelCalls, 0, 'process B must execute zero model calls');
    assert.deepEqual(phaseB.before, phaseA.snapshot,
      'process B must reopen all four settled phase-A rows byte-for-byte');
    assert.deepEqual(phaseB.snapshot, phaseA.snapshot,
      'replay in process B must add no logical, physical, settlement, or result rows');
    assert.deepEqual({
      provider: phaseB.replayAdditionalProviderCrossings,
      model: phaseB.replayAdditionalModelCalls,
      terminal: phaseB.replayAdditionalTerminalEvents,
    }, { provider: 0, model: 0, terminal: 0 },
    'the final same-process replay in B must also be a zero-work durable replay');

    const bodies = readFileSync(bodyLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        phase: string;
        pid: number;
        operation: string;
        via: string;
      });
    assert.deepEqual(bodies.map((body) => body.operation), [CREATE, READ, UPDATE, READ]);
    assert.deepEqual(bodies.map((body) => body.via), ['work_call', 'catalog', 'work_call', 'catalog']);
    assert.deepEqual(bodies.map((body) => body.phase), ['A', 'A', 'A', 'A']);
    assert.deepEqual(bodies.map((body) => body.pid), [phaseA.pid, phaseA.pid, phaseA.pid, phaseA.pid]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
