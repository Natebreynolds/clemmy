/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/host-process-restart-settled.test.ts
 *
 * A real process boundary for settled host_v1 calls. Provider body evidence is
 * append-only and deliberately lives outside SQLite, so reopening durable
 * result bytes cannot be confused with another in-process callback count.
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
const fixture = path.join(repoRoot, 'src/journeys/host-process-restart.fixture.ts');

type DurableCounts = {
  logical_n: number;
  call_lease_n: number;
  physical_n: number;
  settlement_n: number;
  result_handle_n: number;
};

type PhaseAResult = {
  phase: 'A';
  pid: number;
  task: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
  };
  root: {
    authorityKind: 'host_v1';
    authorityDigest: string;
    sourceEventId: string;
    sourceEventDigest: string;
  };
  expected: {
    read: unknown;
    write: unknown;
  };
  counts: {
    read: DurableCounts;
    write: DurableCounts;
  };
};

type PhaseBResult = {
  phase: 'B';
  pid: number;
  reconstructedRoot: PhaseAResult['root'];
  replayed: {
    read: unknown;
    write: unknown;
  };
  duplicate: {
    read: boolean;
    write: boolean;
    successor: boolean;
  };
  denials: {
    tamperedArgs: string;
    tamperedCallIdentity: string;
  };
  counts: {
    readBefore: DurableCounts;
    readAfter: DurableCounts;
    writeBefore: DurableCounts;
    writeAfter: DurableCounts;
    successorAfterFirst: DurableCounts;
    successorAfterReplay: DurableCounts;
  };
};

function spawnPhase(input: {
  home: string;
  phase: 'A' | 'B';
  bodyLog: string;
  prior?: PhaseAResult;
}) {
  return spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      CLEMENTINE_HOME: input.home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      MCP_AUTO_IMPORT_ENABLED: 'false',
      CLEM_HOST_RESTART_PHASE: input.phase,
      CLEM_HOST_RESTART_BODY_LOG: input.bodyLog,
      ...(input.prior ? {
        CLEM_HOST_RESTART_PRIOR: Buffer.from(JSON.stringify(input.prior), 'utf8').toString('base64url'),
      } : {}),
    },
  });
}

test('settled host_v1 calls reopen across a fresh OS process without another provider crossing', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-host-process-restart-'));
  const bodyLog = path.join(home, 'provider-bodies.jsonl');
  try {
    mkdirSync(path.join(home, 'state'), { recursive: true });
    writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-host-process-restart\n', 'utf8');
    writeFileSync(bodyLog, '', { encoding: 'utf8', mode: 0o600 });

    const first = spawnPhase({ home, phase: 'A', bodyLog });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const phaseA = JSON.parse(first.stdout) as PhaseAResult;
    assert.equal(phaseA.phase, 'A');
    assert.equal(phaseA.root.authorityKind, 'host_v1');

    const second = spawnPhase({ home, phase: 'B', bodyLog, prior: phaseA });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const phaseB = JSON.parse(second.stdout) as PhaseBResult;
    assert.equal(phaseB.phase, 'B');
    assert.notEqual(phaseB.pid, phaseA.pid, 'restart proof must cross an OS process boundary');
    assert.deepEqual(phaseB.reconstructedRoot, phaseA.root);

    assert.deepEqual(phaseB.replayed.read, phaseA.expected.read);
    assert.deepEqual(phaseB.replayed.write, phaseA.expected.write);
    assert.deepEqual(phaseB.duplicate, { read: true, write: true, successor: true });
    assert.match(phaseB.denials.tamperedArgs, /authority failed closed/i);
    assert.match(phaseB.denials.tamperedCallIdentity, /authority failed closed/i);

    assert.deepEqual(phaseB.counts.readAfter, phaseB.counts.readBefore,
      'settled read replay added a logical/call-lease/physical/settlement/handle row');
    assert.deepEqual(phaseB.counts.writeAfter, phaseB.counts.writeBefore,
      'settled write replay added a logical/call-lease/physical/settlement/handle row');
    assert.deepEqual(phaseB.counts.readBefore, phaseA.counts.read);
    assert.deepEqual(phaseB.counts.writeBefore, phaseA.counts.write);
    assert.deepEqual(phaseB.counts.successorAfterReplay, phaseB.counts.successorAfterFirst,
      'same-process successor replay added another durable call-owned row');

    const expectedSettledCounts: DurableCounts = {
      logical_n: 1,
      call_lease_n: 1,
      physical_n: 1,
      settlement_n: 1,
      result_handle_n: 1,
    };
    assert.deepEqual(phaseA.counts.read, expectedSettledCounts);
    assert.deepEqual(phaseA.counts.write, expectedSettledCounts);
    assert.deepEqual(phaseB.counts.successorAfterFirst, expectedSettledCounts);

    const bodyRows = readFileSync(bodyLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { phase: string; pid: number; callId: string });
    assert.deepEqual(bodyRows.map((row) => row.callId), [
      'restaurant-read',
      'sheet-create',
      'successor-read',
    ]);
    assert.deepEqual(bodyRows.map((row) => row.phase), ['A', 'A', 'B']);
    assert.deepEqual(bodyRows.map((row) => row.pid), [phaseA.pid, phaseA.pid, phaseB.pid]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
