import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-governor-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const {
  DiscoveryGovernor,
  DISCOVERY_GOVERNOR_EVENT_NAME,
} = await import('./discovery-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `governor-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('fails closed until the exact accepted task is initialized', () => {
  const key = acceptedTask('uninitialized');
  const decision = new DiscoveryGovernor().admit({
    ...key,
    category: 'broad_discovery',
    callId: 'call-before-preflight',
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'task_not_initialized');
  assert.equal(decision.consumedBudget, false);
  assert.equal(decision.telemetry.eventName, DISCOVERY_GOVERNOR_EVENT_NAME);
  assert.deepEqual(decision.telemetry.eventData, {
    ...key,
    category: 'broad_discovery',
    epoch: 0,
    subject: '',
    callId: 'call-before-preflight',
    decision: 'denied',
    reason: 'task_not_initialized',
    replay: false,
    consumedBudget: false,
    knownCapability: null,
    allowance: 0,
    used: 0,
  });
});

test('known capability ranks candidates but never withholds the one bounded broad search', () => {
  const key = acceptedTask('known');
  const governor = new DiscoveryGovernor();

  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');
  const tightened = governor.initializeTask({ ...key, knownCapability: true });
  assert.equal(tightened.status, 'tightened');
  assert.equal(tightened.policy.knownCapability, true);
  assert.equal(tightened.policy.broadDiscoveryAllowance, 1);

  const cannotLoosen = governor.initializeTask({ ...key, knownCapability: false });
  assert.equal(cannotLoosen.status, 'existing');
  assert.equal(cannotLoosen.policy.knownCapability, true);

  const admitted = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'known-search',
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.reason, 'novel_discovery_admitted');
  assert.equal(admitted.telemetry.eventData.allowance, 1);
  assert.equal(governor.getTaskState(key)?.claims.broad_discovery?.callId, 'known-search');

  // Once the attempted candidate is observed to fail, the next evidence epoch
  // receives one fresh slot. A receipt ranks candidates; the durable claim is
  // what bounds search.
  assert.equal(
    governor.recordEvidence({ ...key, kind: 'candidate_unsupported' }).outcome,
    'epoch_opened',
  );
  const afterEvidence = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'known-search-after-failure',
  });
  assert.equal(afterEvidence.admitted, true);
  assert.equal(afterEvidence.reason, 'new_evidence_admitted');
  assert.equal(
    governor.getTaskState(key)?.policy.knownCapability,
    true,
    'the remembered fact is untouched; only the budget moved',
  );
});

test('novel task receives one broad discovery and a separate one-shot schema refresh', () => {
  const key = acceptedTask('novel');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  const broad = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'broad-1',
  });
  assert.equal(broad.admitted, true);
  assert.equal(broad.reason, 'novel_discovery_admitted');
  assert.equal(broad.consumedBudget, true);

  // A second look is ADMITTED and spends no additional budget. Refusing it
  // never saved the call — the model had already paid for it — and only bought
  // a reformulated retry, which is the thrash the cap existed to prevent.
  const extraBroad = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'broad-2',
  });
  assert.equal(extraBroad.admitted, true);
  assert.equal(extraBroad.reason, 'subject_replay');
  assert.equal(extraBroad.consumedBudget, false, 'a replay must not spend a second claim');

  const refresh = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'refresh-1',
  });
  assert.equal(refresh.admitted, true);
  assert.equal(refresh.reason, 'schema_refresh_admitted');
  assert.equal(refresh.telemetry.eventData.allowance, 1);

  // Same for a repeated schema refresh: the allowance is spent once, and the
  // repeat replays it instead of being refused.
  const extraRefresh = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'refresh-2',
  });
  assert.equal(extraRefresh.admitted, true);
  assert.equal(extraRefresh.reason, 'subject_replay');
  assert.equal(extraRefresh.consumedBudget, false);
});

test('same call-id replay is free and a failed claim remains spent after daemon restart', () => {
  const key = acceptedTask('restart-failure');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  const admitted = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-1',
  });
  assert.equal(admitted.admitted, true);

  const failed = governor.settle({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-1',
    outcome: 'failed',
    detail: ' provider_validation_failed '.repeat(30),
  });
  assert.equal(failed.recorded, true);
  assert.equal(failed.reason, 'outcome_recorded');
  assert.equal(failed.claim?.outcome, 'failed');
  assert.ok((failed.claim?.outcomeDetail.length ?? 0) <= 256);

  eventlog.closeEventLog();
  const restarted = new DiscoveryGovernor();
  const replay = restarted.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-1',
  });
  assert.equal(replay.admitted, true);
  assert.equal(replay.reason, 'same_call_replay');
  assert.equal(replay.replay, true);
  assert.equal(replay.consumedBudget, false);
  assert.equal(replay.claim?.outcome, 'failed');
  assert.equal(replay.telemetry.eventData.priorOutcome, 'failed');

  // A FAILED claim no longer forecloses the retry. A provider failure is
  // exactly when another attempt is legitimate, and refusing it does not save
  // the call the model already made — it only forces a reformulated one. The
  // claim keeps its recorded failure; the retry simply replays it for free.
  const retryWithNewCall = restarted.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-2',
  });
  assert.equal(retryWithNewCall.admitted, true);
  assert.equal(retryWithNewCall.reason, 'subject_replay');
  assert.equal(retryWithNewCall.consumedBudget, false, 'the claim is still spent exactly once');
  assert.equal(retryWithNewCall.claim?.outcome, 'failed', 'the failure stays on the record');

  const settlementReplay = restarted.settle({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-1',
    outcome: 'failed',
  });
  assert.equal(settlementReplay.recorded, false);
  assert.equal(settlementReplay.replay, true);
  assert.equal(settlementReplay.reason, 'same_outcome_replay');
});

test('known tasks may spend the independent exact-schema-refresh slot once', () => {
  const key = acceptedTask('known-schema-drift');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: true });

  const first = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'schema-drift-1',
  });
  assert.equal(first.admitted, true);
  assert.equal(first.reason, 'schema_refresh_admitted');

  const timedOut = governor.settle({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'schema-drift-1',
    outcome: 'timed_out',
    detail: 'provider_timeout',
  });
  assert.equal(timedOut.recorded, true);

  // A timeout is the canonical retryable outcome; refusing the second attempt
  // stranded the task on a transient provider failure. The slot is still spent
  // once and the timeout stays on the record.
  const second = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'schema-drift-2',
  });
  assert.equal(second.admitted, true);
  assert.equal(second.reason, 'subject_replay');
  assert.equal(second.consumedBudget, false);
  assert.equal(second.claim?.outcome, 'timed_out');
});

async function childAdmission(
  moduleUrl: string,
  key: { sessionId: string; sourceUserSeq: number },
  callId: string,
): Promise<{ admitted: boolean; consumedBudget: boolean; reason: string }> {
  const code = `
    const { DiscoveryGovernor } = await import(process.env.CLEM_GOVERNOR_MODULE_URL);
    const key = JSON.parse(process.env.CLEM_GOVERNOR_TASK_KEY);
    const result = new DiscoveryGovernor().admit({
      ...key,
      category: 'broad_discovery',
      callId: process.env.CLEM_GOVERNOR_CALL_ID,
    });
    process.stdout.write(JSON.stringify({
      admitted: result.admitted,
      consumedBudget: result.consumedBudget,
      reason: result.reason,
    }));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_GOVERNOR_MODULE_URL: moduleUrl,
      CLEM_GOVERNOR_TASK_KEY: JSON.stringify(key),
      CLEM_GOVERNOR_CALL_ID: callId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [exitCode] = await once(child, 'close') as [number | null];
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout) as { admitted: boolean; consumedBudget: boolean; reason: string };
}

test('concurrent daemon processes atomically elect one broad-discovery winner', async () => {
  const key = acceptedTask('cross-process-race');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  const moduleUrl = pathToFileURL(path.resolve('src/runtime/harness/discovery-governor.ts')).href;

  const decisions = await Promise.all(
    Array.from({ length: 6 }, (_, index) => childAdmission(moduleUrl, key, `race-${index}`)),
  );
  // THE INVARIANT IS ATOMICITY, NOT REFUSAL: exactly one process may create the
  // claim. The losers of that race are handed the existing claim rather than
  // refused — they have already paid for their call.
  assert.equal(
    decisions.filter((decision) => decision.consumedBudget).length,
    1,
    'exactly one process may spend the claim',
  );
  assert.equal(decisions.filter((decision) => decision.admitted).length, 6);
  assert.equal(
    decisions.filter((decision) => decision.reason === 'subject_replay').length,
    5,
  );
  assert.equal(governor.getTaskState(key)?.claims.broad_discovery?.outcome, 'pending');
});

test('task initialization rejects a sequence that is not this session accepted input', () => {
  const first = acceptedTask('source-owner-a');
  const second = acceptedTask('source-owner-b');
  assert.throws(
    () => new DiscoveryGovernor().initializeTask({
      sessionId: first.sessionId,
      sourceUserSeq: second.sourceUserSeq,
      knownCapability: false,
    }),
    /not an accepted user task/i,
  );
});
