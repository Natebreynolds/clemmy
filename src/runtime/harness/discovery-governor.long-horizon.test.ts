import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-horizon-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const { DiscoveryGovernor } = await import('./discovery-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface FreshProcessProbe {
  initializationStatus: string;
  broadReplay: {
    admitted: boolean;
    replay: boolean;
    consumedBudget: boolean;
    reason: string;
  };
  broadContinuation: {
    admitted: boolean;
    replay: boolean;
    consumedBudget: boolean;
    reason: string;
  };
  exactReplay: {
    admitted: boolean;
    replay: boolean;
    consumedBudget: boolean;
    reason: string;
  };
  exactContinuation: {
    admitted: boolean;
    replay: boolean;
    consumedBudget: boolean;
    reason: string;
  };
  claimCount: number;
  broadOutcome: string | null;
  exactOutcome: string | null;
}

async function probeContinuationInFreshProcess(input: {
  sessionId: string;
  sourceUserSeq: number;
  moduleUrl: string;
}): Promise<FreshProcessProbe> {
  const childCode = `
    const { DiscoveryGovernor } = await import(process.env.CLEM_GOVERNOR_MODULE_URL);
    const key = JSON.parse(process.env.CLEM_GOVERNOR_TASK_KEY);
    const governor = new DiscoveryGovernor();
    const initialization = governor.initializeTask({ ...key, knownCapability: false });
    const compact = (decision) => ({
      admitted: decision.admitted,
      replay: decision.replay,
      consumedBudget: decision.consumedBudget,
      reason: decision.reason,
    });
    const broadReplay = governor.admit({
      ...key,
      category: 'broad_discovery',
      callId: 'cold-broad-provider-call',
    });
    const broadContinuation = governor.admit({
      ...key,
      category: 'broad_discovery',
      callId: 'post-restart-broad-provider-call',
    });
    const exactReplay = governor.admit({
      ...key,
      category: 'exact_schema_refresh',
      callId: 'cold-exact-provider-call',
    });
    const exactContinuation = governor.admit({
      ...key,
      category: 'exact_schema_refresh',
      callId: 'post-restart-exact-provider-call',
    });
    const state = governor.getTaskState(key);
    process.stdout.write(JSON.stringify({
      initializationStatus: initialization.status,
      broadReplay: compact(broadReplay),
      broadContinuation: compact(broadContinuation),
      exactReplay: compact(exactReplay),
      exactContinuation: compact(exactContinuation),
      claimCount: Object.keys(state?.claims ?? {}).length,
      broadOutcome: state?.claims.broad_discovery?.outcome ?? null,
      exactOutcome: state?.claims.exact_schema_refresh?.outcome ?? null,
    }));
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEM_GOVERNOR_MODULE_URL: input.moduleUrl,
        CLEM_GOVERNOR_TASK_KEY: JSON.stringify({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [exitCode] = await once(child, 'close') as [number | null];
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout) as FreshProcessProbe;
}

test('long horizon: restart and continuations do not repay discovery; a new accepted correction does', async () => {
  const session = eventlog.createSession({
    id: 'discovery-long-horizon-session',
    kind: 'chat',
  });
  const coldSource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the right connected capability and perform the task.' },
  });
  const coldKey = { sessionId: session.id, sourceUserSeq: coldSource.seq };
  const governor = new DiscoveryGovernor();
  assert.equal(
    governor.initializeTask({ ...coldKey, knownCapability: false }).status,
    'initialized',
  );

  const coldBroad = governor.admit({
    ...coldKey,
    category: 'broad_discovery',
    callId: 'cold-broad-provider-call',
  });
  const coldExact = governor.admit({
    ...coldKey,
    category: 'exact_schema_refresh',
    callId: 'cold-exact-provider-call',
  });
  assert.deepEqual(
    [coldBroad.admitted, coldBroad.consumedBudget, coldExact.admitted, coldExact.consumedBudget],
    [true, true, true, true],
  );
  assert.equal(governor.settle({
    ...coldKey,
    category: 'broad_discovery',
    callId: 'cold-broad-provider-call',
    outcome: 'succeeded',
  }).recorded, true);
  assert.equal(governor.settle({
    ...coldKey,
    category: 'exact_schema_refresh',
    callId: 'cold-exact-provider-call',
    outcome: 'succeeded',
  }).recorded, true);

  // A new process with a fresh module registry models a daemon/repository
  // restart while retaining only Clementine's durable home.
  eventlog.closeEventLog();
  const restarted = await probeContinuationInFreshProcess({
    ...coldKey,
    moduleUrl: pathToFileURL(path.resolve('src/runtime/harness/discovery-governor.ts')).href,
  });
  assert.deepEqual(restarted, {
    initializationStatus: 'existing',
    broadReplay: {
      admitted: true,
      replay: true,
      consumedBudget: false,
      reason: 'same_call_replay',
    },
    // THE INVARIANT IS "DOES NOT REPAY", NOT "IS REFUSED": consumedBudget stays
    // false across restarts and continuations, so a long horizon can never mint
    // itself a fresh allowance. The continuation is now admitted as a replay of
    // the claim it already owns — refusing it never saved the call, and only
    // bought a reformulated retry.
    broadContinuation: {
      admitted: true,
      replay: true,
      consumedBudget: false,
      reason: 'subject_replay',
    },
    exactReplay: {
      admitted: true,
      replay: true,
      consumedBudget: false,
      reason: 'same_call_replay',
    },
    exactContinuation: {
      admitted: true,
      replay: true,
      consumedBudget: false,
      reason: 'subject_replay',
    },
    claimCount: 2,
    broadOutcome: 'succeeded',
    exactOutcome: 'succeeded',
  });

  const afterRestart = new DiscoveryGovernor();
  const internalContinuation = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'turn_started',
    data: { reason: 'post_restart_continuation' },
  });
  assert.throws(
    () => afterRestart.initializeTask({
      sessionId: session.id,
      sourceUserSeq: internalContinuation.seq,
      knownCapability: false,
    }),
    /not an accepted user task/i,
  );
  assert.equal(afterRestart.getTaskState(coldKey)?.claims.broad_discovery?.callId, 'cold-broad-provider-call');
  assert.equal(afterRestart.getTaskState(coldKey)?.claims.exact_schema_refresh?.callId, 'cold-exact-provider-call');

  const correctionSource = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Correction: use the other connected system instead.' },
  });
  const correctionKey = { sessionId: session.id, sourceUserSeq: correctionSource.seq };
  assert.notEqual(correctionKey.sourceUserSeq, coldKey.sourceUserSeq);
  assert.equal(
    afterRestart.initializeTask({ ...correctionKey, knownCapability: false }).status,
    'initialized',
  );
  const correctionBroad = afterRestart.admit({
    ...correctionKey,
    category: 'broad_discovery',
    callId: 'correction-broad-provider-call',
  });
  const correctionExact = afterRestart.admit({
    ...correctionKey,
    category: 'exact_schema_refresh',
    callId: 'correction-exact-provider-call',
  });
  assert.deepEqual(
    [
      correctionBroad.admitted,
      correctionBroad.consumedBudget,
      correctionExact.admitted,
      correctionExact.consumedBudget,
    ],
    [true, true, true, true],
  );

  const db = eventlog.openEventLog();
  const claimCounts = db.prepare(`
    SELECT source_user_seq AS sourceUserSeq,
           category,
           COUNT(*) AS claimCount
      FROM discovery_governor_claims
     WHERE session_id = ?
     GROUP BY source_user_seq, category
     ORDER BY source_user_seq, category
  `).all(session.id) as Array<{
    sourceUserSeq: number;
    category: string;
    claimCount: number;
  }>;
  const policyCount = db.prepare(`
    SELECT COUNT(*) AS count
      FROM discovery_governor_tasks
     WHERE session_id = ?
  `).get(session.id) as { count: number };

  assert.deepEqual(claimCounts, [
    { sourceUserSeq: coldKey.sourceUserSeq, category: 'broad_discovery', claimCount: 1 },
    { sourceUserSeq: coldKey.sourceUserSeq, category: 'exact_schema_refresh', claimCount: 1 },
    { sourceUserSeq: correctionKey.sourceUserSeq, category: 'broad_discovery', claimCount: 1 },
    { sourceUserSeq: correctionKey.sourceUserSeq, category: 'exact_schema_refresh', claimCount: 1 },
  ]);
  assert.equal(policyCount.count, 2);
});
