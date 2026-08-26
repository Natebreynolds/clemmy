/**
 * Production-composition regression for infrastructure recovery budgeting.
 *
 * Retry allowance belongs to one logical error episode under one accepted
 * source. A new user source in the same long-lived session gets its complete
 * allowance, while a daemon crash cannot reset an episode already in flight.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-infra-recovery-source-scope-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_UNATTENDED_AUTO_RECOVER = 'on';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Runner } from '@openai/agents';

const {
  closeEventLog,
  listEvents,
  resetEventLog,
} = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
const { BoundaryError } = await import('../boundary-error.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;

const LOOP_MODULE = fileURLToPath(new URL('./loop.ts', import.meta.url));
const EVENTLOG_MODULE = fileURLToPath(new URL('./eventlog.ts', import.meta.url));
const SESSION_MODULE = fileURLToPath(new URL('./session.ts', import.meta.url));
const BOUNDARY_MODULE = fileURLToPath(new URL('../boundary-error.ts', import.meta.url));

function makeRunner(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function makeAgent(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

function persistentInfraErrorRunner(onCall?: () => void): RunRunnerFn {
  return async () => {
    onCall?.();
    throw BoundaryError.from(new Error('backend 529 persistent'), {
      kind: 'model.overloaded',
      retryable: true,
      userMessage: 'The model runtime is temporarily unavailable.',
    });
  };
}

interface RecoveryEventData {
  attempt?: unknown;
  max?: unknown;
  sourceUserSeq?: unknown;
  logicalErrorEpisodeId?: unknown;
}

function recoveryRows(sessionId: string) {
  return listEvents(sessionId, { types: ['infra_auto_recover'] });
}

function sourceRows(sessionId: string) {
  return listEvents(sessionId, { types: ['user_input_received'] })
    .filter((event) => event.role === 'user' && event.data.synthetic !== true);
}

test.beforeEach(() => {
  resetEventLog();
});

test.after(() => {
  closeEventLog();
  if (!process.env.CLEM_TEST_KEEP_HOME) {
    rmSync(TMP_HOME, { recursive: true, force: true });
  }
});

test('attended recovery gives a fresh accepted source its full one-retry budget in the same session', async () => {
  const session = HarnessSession.create({
    id: 'infra-recovery-attended-source-scope',
    kind: 'chat',
  });
  let sourceACalls = 0;
  const sourceAResult = await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'accepted source A',
    makeRunner,
    runRunner: persistentInfraErrorRunner(() => { sourceACalls += 1; }),
  });
  assert.equal(sourceAResult.status, 'awaiting_user_input');
  assert.equal(sourceACalls, 2, 'source A spends its one quiet retry, then asks');

  let sourceBCalls = 0;
  const sourceBResult = await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'accepted source B',
    makeRunner,
    runRunner: persistentInfraErrorRunner(() => { sourceBCalls += 1; }),
  });
  assert.equal(sourceBResult.status, 'awaiting_user_input');
  assert.equal(sourceBCalls, 2, 'a genuinely new source retains the complete attended budget');

  const sources = sourceRows(session.id);
  assert.equal(sources.length, 2);
  const recoveries = recoveryRows(session.id);
  assert.equal(recoveries.length, 2, 'one retry is durably charged to each accepted source');
  assert.deepEqual(
    recoveries.map((event) => (event.data as RecoveryEventData).sourceUserSeq),
    sources.map((event) => event.seq),
  );
  assert.deepEqual(
    recoveries.map((event) => (event.data as RecoveryEventData).max),
    [1, 1],
    'the attended policy remains exactly one quiet retry per source',
  );
  const episodeIds = recoveries.map(
    (event) => (event.data as RecoveryEventData).logicalErrorEpisodeId,
  );
  assert.ok(episodeIds.every((value) => typeof value === 'string' && value.length > 0));
  assert.notEqual(episodeIds[0], episodeIds[1], 'new accepted sources own different error episodes');
});

test('two separate attended error episodes under one accepted source each stay bounded independently', async () => {
  const session = HarnessSession.create({
    id: 'infra-recovery-logical-episode-scope',
    kind: 'chat',
  });
  let calls = 0;
  const result = await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'Give me a short explanation of retry episodes.',
    makeRunner,
    runRunner: async (_runner, _agent, items) => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        throw BoundaryError.from(new Error(`backend 529 episode ${calls}`), {
          kind: 'model.overloaded',
          retryable: true,
          userMessage: 'The model runtime is temporarily unavailable.',
        });
      }
      return {
        history: items,
        lastResponseId: undefined,
        finalOutput: calls === 2
          ? {
              summary: 'The first error episode recovered; continue the same accepted request.',
              reply: null,
              done: false,
              nextAction: 'awaiting_handoff_result',
              reason: null,
            }
          : {
              summary: 'Both independent error episodes recovered.',
              reply: 'Both independent error episodes recovered.',
              done: true,
              nextAction: 'completed',
              reason: null,
            },
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 4, 'each separate episode consumes exactly one retry');
  const source = sourceRows(session.id)[0];
  const recoveries = recoveryRows(session.id);
  assert.equal(recoveries.length, 2);
  assert.ok(recoveries.every(
    (event) => (event.data as RecoveryEventData).sourceUserSeq === source.seq,
  ));
  assert.deepEqual(
    recoveries.map((event) => (event.data as RecoveryEventData).attempt),
    [1, 1],
  );
  assert.equal(
    new Set(recoveries.map(
      (event) => (event.data as RecoveryEventData).logicalErrorEpisodeId,
    )).size,
    2,
    'a successful physical turn closes the first episode before the later failure',
  );
});

test('unattended recovery gives a fresh accepted source its full two-retry budget in the same session', async () => {
  const session = HarnessSession.create({
    id: 'workflow:infra-recovery-unattended-source-scope',
    // The allocation-time workflow prefix is the production unattended signal.
    // Keep this a chat-shaped harness fixture so unrelated workflow authority
    // admission cannot mask the recovery-budget seam under test.
    kind: 'chat',
  });
  let sourceACalls = 0;
  const sourceAResult = await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'accepted unattended source A',
    makeRunner,
    runRunner: persistentInfraErrorRunner(() => { sourceACalls += 1; }),
  });
  assert.equal(sourceAResult.status, 'failed');
  assert.equal(sourceACalls, 3, 'source A spends two retries, then fails honestly');

  let sourceBCalls = 0;
  const sourceBResult = await runConversation({
    agent: makeAgent(),
    sessionId: session.id,
    input: 'accepted unattended source B',
    makeRunner,
    runRunner: persistentInfraErrorRunner(() => { sourceBCalls += 1; }),
  });
  assert.equal(sourceBResult.status, 'failed');
  assert.equal(sourceBCalls, 3, 'a genuinely new source retains the complete unattended budget');

  const sources = sourceRows(session.id);
  assert.equal(sources.length, 2);
  const recoveries = recoveryRows(session.id);
  assert.equal(recoveries.length, 4);
  for (const source of sources) {
    const owned = recoveries.filter(
      (event) => (event.data as RecoveryEventData).sourceUserSeq === source.seq,
    );
    assert.equal(owned.length, 2);
    assert.deepEqual(owned.map((event) => (event.data as RecoveryEventData).attempt), [1, 2]);
    assert.ok(owned.every((event) => (event.data as RecoveryEventData).max === 2));
    assert.equal(
      new Set(owned.map((event) => (event.data as RecoveryEventData).logicalErrorEpisodeId)).size,
      1,
      'both retries belong to one stable logical error episode',
    );
  }
});

function childFor(home: string, mode: 'crash' | 'resume'): ChildProcess {
  const script = `
    import { EventEmitter } from 'node:events';
    process.env.CLEMENTINE_HOME = ${JSON.stringify(home)};
    process.env.CLEMMY_UNATTENDED_AUTO_RECOVER = 'on';
    process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
    const { listEvents } = await import(${JSON.stringify(EVENTLOG_MODULE)});
    const { HarnessSession } = await import(${JSON.stringify(SESSION_MODULE)});
    const { runConversation } = await import(${JSON.stringify(LOOP_MODULE)});
    const { BoundaryError } = await import(${JSON.stringify(BOUNDARY_MODULE)});
    const makeRunner = () => new EventEmitter();
    const agent = {};
    const fail = () => {
      throw BoundaryError.from(new Error('backend 529 persistent'), {
        kind: 'model.overloaded', retryable: true, userMessage: 'transient',
      });
    };
    const sessionId = 'workflow:infra-recovery-process-restart';
    if (${JSON.stringify(mode)} === 'crash') {
      const session = HarnessSession.create({ id: sessionId, kind: 'chat' });
      let calls = 0;
      await runConversation({
        agent, sessionId: session.id, input: 'same logical error episode', makeRunner,
        runRunner: async () => {
          calls += 1;
          if (calls === 1) fail();
          const source = listEvents(sessionId, { types: ['user_input_received'] })[0];
          const recovery = listEvents(sessionId, { types: ['infra_auto_recover'] })[0];
          process.stdout.write('READY ' + JSON.stringify({ sourceUserSeq: source.seq, recovery: recovery.data }) + '\\n');
          await new Promise(() => { setInterval(() => {}, 1000); });
        },
      });
    } else {
      const source = listEvents(sessionId, { types: ['user_input_received'] })[0];
      let calls = 0;
      const result = await runConversation({
        agent, sessionId, sourceUserSeq: source.seq, input: 'same logical error episode', makeRunner,
        runRunner: async () => { calls += 1; fail(); },
      });
      const recoveries = listEvents(sessionId, { types: ['infra_auto_recover'] });
      process.stdout.write('DONE ' + JSON.stringify({
        calls, status: result.status, sourceUserSeq: source.seq,
        recoveries: recoveries.map((event) => event.data),
      }) + '\\n');
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForMarker(
  child: ChildProcess,
  prefix: 'READY' | 'DONE',
  killAfterMarker = false,
): Promise<Record<string, unknown>> {
  let stdout = '';
  let stderr = '';
  let marker: Record<string, unknown> | undefined;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith(`${prefix} `)) {
        marker = JSON.parse(line.slice(prefix.length + 1)) as Record<string, unknown>;
      }
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
  if (killAfterMarker) child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  if (!killAfterMarker) assert.equal(child.exitCode, 0, stderr || stdout);
  return marker;
}

test('one logical unattended error episode stays bounded across a real process restart', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-infra-recovery-process-'));
  try {
    const beforeCrash = await waitForMarker(childFor(home, 'crash'), 'READY', true);
    const resumed = await waitForMarker(childFor(home, 'resume'), 'DONE');
    assert.equal(resumed.status, 'failed');
    assert.equal(resumed.calls, 2, 'one persisted retry leaves exactly one retry after restart');
    const sourceUserSeq = resumed.sourceUserSeq;
    const recoveries = resumed.recoveries as RecoveryEventData[];
    assert.equal(recoveries.length, 2);
    assert.deepEqual(recoveries.map((event) => event.attempt), [1, 2]);
    assert.ok(recoveries.every((event) => event.max === 2));
    assert.ok(recoveries.every((event) => event.sourceUserSeq === sourceUserSeq));
    assert.equal(
      new Set(recoveries.map((event) => event.logicalErrorEpisodeId)).size,
      1,
      'the persisted retry and post-restart retry retain one episode id',
    );
    assert.deepEqual(beforeCrash.recovery, recoveries[0]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
