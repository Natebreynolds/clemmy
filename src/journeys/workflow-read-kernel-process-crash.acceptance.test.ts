/**
 * Governing real-process crash matrix for one production workflow read call.
 * Each crash occurs in a child PID. Every recovery occurs in another child PID
 * against the same isolated durable home and a synchronous provider-body log.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/journeys/workflow-read-kernel-process-crash.acceptance.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-process-crash-'));
const FIXTURE = path.join(import.meta.dirname, 'workflow-read-kernel-process-crash.fixture.ts');
const REPO = path.resolve(import.meta.dirname, '../..');

after(() => rmSync(ROOT, { recursive: true, force: true }));

type CrashPoint =
  | 'after_call_lease'
  | 'after_physical_reservation'
  | 'after_io_claim'
  | 'after_physical_settlement'
  | 'after_logical_settlement';

type State = {
  logical_n: number;
  logical_state: string | null;
  lease_n: number;
  lease_id: string | null;
  lease_scope_id: string | null;
  lease_revoked_at: string | null;
  physical_n: number;
  physical_state: string | null;
  io_claimed_at: string | null;
  physical_lease_scope_id: string | null;
  physical_lease_id: string | null;
  settlement_n: number;
  result_handle_id: string | null;
  authority_state: string;
  authority_close_reason: string | null;
};

type FixtureOutput = {
  pid: number;
  ref?: Record<string, unknown>;
  result?: { status: string; reason?: string; result?: unknown };
  state: State;
};

function fixtureEnv(input: {
  home: string;
  label: string;
  counter: string;
  mode: 'prepare' | 'inspect' | 'execute';
  ref?: Record<string, unknown>;
  crashPoint?: CrashPoint;
  crashMarker?: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLEMENTINE_HOME: input.home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    CLEM_WORKFLOW_CRASH_MODE: input.mode,
    CLEM_WORKFLOW_CRASH_LABEL: input.label,
    CLEM_WORKFLOW_CRASH_COUNTER: input.counter,
    ...(input.ref ? { CLEM_WORKFLOW_CRASH_REF: JSON.stringify(input.ref) } : {}),
    ...(input.crashPoint ? { CLEM_WORKFLOW_CRASH_POINT: input.crashPoint } : {}),
    ...(input.crashMarker ? { CLEM_WORKFLOW_CRASH_MARKER: input.crashMarker } : {}),
  };
}

function runFixture(input: Parameters<typeof fixtureEnv>[0]): FixtureOutput {
  const child = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(input),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.trim().split('\n')
    .findLast((candidate) => candidate.startsWith('WORKFLOW_CRASH_FIXTURE:'));
  assert.ok(line, child.stdout);
  return JSON.parse(line.slice('WORKFLOW_CRASH_FIXTURE:'.length)) as FixtureOutput;
}

function crashFixture(input: Parameters<typeof fixtureEnv>[0]): number {
  const child = spawnSync(process.execPath, ['--import', 'tsx', FIXTURE], {
    cwd: REPO,
    env: fixtureEnv(input),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0, 'the crash child unexpectedly returned normally');
  assert.match(child.stderr, new RegExp(`forced workflow kernel crash: ${input.crashPoint}`));
  assert.ok(input.crashMarker && existsSync(input.crashMarker), 'crash child did not publish its PID marker');
  const marker = JSON.parse(readFileSync(input.crashMarker!, 'utf8')) as { pid: number };
  assert.notEqual(marker.pid, process.pid);
  return marker.pid;
}

function bodyCount(counter: string): number {
  if (!existsSync(counter)) return 0;
  return readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length;
}

const cases: Array<{
  point: CrashPoint;
  crashed: Partial<State>;
  bodyAfterCrash: number;
  resumeStatus: 'completed' | 'blocked' | 'replayed';
  resumeReason?: string;
  bodyAfterResume: number;
  closes: boolean;
}> = [
  {
    point: 'after_call_lease',
    crashed: { logical_n: 1, logical_state: 'open', lease_n: 1, physical_n: 0, settlement_n: 0 },
    bodyAfterCrash: 0,
    resumeStatus: 'completed',
    bodyAfterResume: 1,
    closes: true,
  },
  {
    point: 'after_physical_reservation',
    crashed: {
      logical_n: 1,
      logical_state: 'open',
      lease_n: 1,
      physical_n: 1,
      physical_state: 'started',
      io_claimed_at: null,
      settlement_n: 0,
    },
    bodyAfterCrash: 0,
    resumeStatus: 'completed',
    bodyAfterResume: 1,
    closes: true,
  },
  {
    point: 'after_io_claim',
    crashed: {
      logical_n: 1,
      logical_state: 'open',
      lease_n: 1,
      physical_n: 1,
      physical_state: 'started',
      settlement_n: 0,
    },
    bodyAfterCrash: 0,
    resumeStatus: 'blocked',
    resumeReason: 'prior_crossing_unknown_no_redispatch',
    bodyAfterResume: 0,
    closes: false,
  },
  {
    point: 'after_physical_settlement',
    crashed: {
      logical_n: 1,
      logical_state: 'open',
      lease_n: 1,
      physical_n: 1,
      physical_state: 'returned',
      settlement_n: 0,
      result_handle_id: null,
    },
    bodyAfterCrash: 1,
    resumeStatus: 'blocked',
    resumeReason: 'prior_crossing_unknown_no_redispatch',
    bodyAfterResume: 1,
    closes: false,
  },
  {
    point: 'after_logical_settlement',
    crashed: {
      logical_n: 1,
      logical_state: 'settled',
      lease_n: 1,
      physical_n: 1,
      physical_state: 'returned',
      settlement_n: 1,
    },
    bodyAfterCrash: 1,
    resumeStatus: 'replayed',
    bodyAfterResume: 1,
    closes: true,
  },
];

test('five workflow call boundaries survive actual child-process death without duplicate provider I/O', async (t) => {
  for (const candidate of cases) {
    await t.test(candidate.point, () => {
      const home = path.join(ROOT, candidate.point);
      mkdirSync(home, { recursive: true });
      const counter = path.join(home, 'provider-bodies.jsonl');
      const marker = path.join(home, 'crash-pid.json');
      const label = candidate.point.replaceAll('_', '-');

      const prepared = runFixture({ home, label, counter, mode: 'prepare' });
      assert.ok(prepared.ref);
      assert.notEqual(prepared.pid, process.pid);

      const crashPid = crashFixture({
        home,
        label,
        counter,
        mode: 'execute',
        ref: prepared.ref,
        crashPoint: candidate.point,
        crashMarker: marker,
      });
      assert.notEqual(crashPid, prepared.pid);

      const crashed = runFixture({ home, label, counter, mode: 'inspect', ref: prepared.ref });
      assert.notEqual(crashed.pid, crashPid);
      assert.deepEqual(
        Object.fromEntries(Object.keys(candidate.crashed).map((key) => [key, crashed.state[key as keyof State]])),
        candidate.crashed,
      );
      assert.equal(crashed.state.lease_revoked_at, null);
      if (crashed.state.physical_n === 1) {
        assert.equal(crashed.state.physical_lease_id, crashed.state.lease_id);
        assert.equal(crashed.state.physical_lease_scope_id, crashed.state.lease_scope_id);
      }
      if (candidate.point === 'after_io_claim' || candidate.point === 'after_physical_settlement'
          || candidate.point === 'after_logical_settlement') {
        assert.ok(crashed.state.io_claimed_at, 'claimed/returned boundaries retain the exact I/O claim');
      }
      if (candidate.point === 'after_logical_settlement') {
        assert.ok(crashed.state.result_handle_id, 'logical settlement owns the retained result handle');
      }
      assert.equal(bodyCount(counter), candidate.bodyAfterCrash);

      const resumed = runFixture({ home, label, counter, mode: 'execute', ref: prepared.ref });
      assert.notEqual(resumed.pid, process.pid);
      assert.notEqual(resumed.pid, crashPid);
      assert.equal(resumed.result?.status, candidate.resumeStatus, JSON.stringify(resumed.result));
      if (candidate.resumeReason) assert.equal(resumed.result?.reason, candidate.resumeReason);
      assert.equal(bodyCount(counter), candidate.bodyAfterResume);
      assert.equal(resumed.state.lease_id, crashed.state.lease_id, 'restart must adopt the durable lease');
      assert.equal(resumed.state.lease_n, 1);
      assert.equal(resumed.state.physical_n, crashed.state.physical_n || 1);
      if (candidate.closes) {
        assert.equal(resumed.state.logical_state, 'settled');
        assert.equal(resumed.state.physical_state, 'returned');
        assert.equal(resumed.state.settlement_n, 1);
        assert.ok(resumed.state.result_handle_id);
        assert.ok(resumed.state.lease_revoked_at);
        assert.equal(resumed.state.authority_state, 'closed');
        assert.equal(resumed.state.authority_close_reason, 'workflow_completed');
      } else {
        assert.equal(resumed.state.settlement_n, 0);
        assert.equal(resumed.state.lease_revoked_at, null);
        assert.equal(resumed.state.authority_state, 'open');
      }

      const reopened = runFixture({ home, label, counter, mode: 'inspect', ref: prepared.ref });
      assert.notEqual(reopened.pid, resumed.pid);
      assert.deepEqual(reopened.state, resumed.state, 'a later process sees exactly the recovered durable state');
      assert.equal(bodyCount(counter), candidate.bodyAfterResume);
    });
  }
});
