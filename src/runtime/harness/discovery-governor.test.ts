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

test('known capability defers the FIRST broad search only; knowledge tightens but never strands', () => {
  const key = acceptedTask('known');
  const governor = new DiscoveryGovernor();

  assert.equal(governor.initializeTask({ ...key, knownCapability: false }).status, 'initialized');
  const tightened = governor.initializeTask({ ...key, knownCapability: true });
  assert.equal(tightened.status, 'tightened');
  assert.equal(tightened.policy.knownCapability, true);
  assert.equal(tightened.policy.broadDiscoveryAllowance, 0);

  const cannotLoosen = governor.initializeTask({ ...key, knownCapability: false });
  assert.equal(cannotLoosen.status, 'existing');
  assert.equal(cannotLoosen.policy.knownCapability, true);

  const denied = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'known-search',
  });
  assert.equal(denied.admitted, false);
  assert.equal(denied.reason, 'known_capability');
  assert.equal(denied.telemetry.eventData.allowance, 0);
  assert.equal(governor.getTaskState(key)?.claims.broad_discovery, undefined);

  // The suppression is scoped to the epoch the memory was formed against. Once
  // the remembered path is observed to fail, a warm task searches on exactly
  // the terms a cold one would — a receipt ranks candidates, it never decides
  // whether recovery is permitted.
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

  const extraBroad = governor.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'broad-2',
  });
  assert.equal(extraBroad.admitted, false);
  assert.equal(extraBroad.reason, 'category_budget_exhausted');

  const refresh = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'refresh-1',
  });
  assert.equal(refresh.admitted, true);
  assert.equal(refresh.reason, 'schema_refresh_admitted');
  assert.equal(refresh.telemetry.eventData.allowance, 1);

  const extraRefresh = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'refresh-2',
  });
  assert.equal(extraRefresh.admitted, false);
  assert.equal(extraRefresh.reason, 'category_budget_exhausted');
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

  const retryWithNewCall = restarted.admit({
    ...key,
    category: 'broad_discovery',
    callId: 'provider-call-2',
  });
  assert.equal(retryWithNewCall.admitted, false);
  assert.equal(retryWithNewCall.reason, 'category_budget_exhausted');

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

  const second = governor.admit({
    ...key,
    category: 'exact_schema_refresh',
    callId: 'schema-drift-2',
  });
  assert.equal(second.admitted, false);
  assert.equal(second.reason, 'category_budget_exhausted');
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
  assert.equal(decisions.filter((decision) => decision.admitted).length, 1);
  assert.equal(decisions.filter((decision) => decision.consumedBudget).length, 1);
  assert.equal(
    decisions.filter((decision) => decision.reason === 'category_budget_exhausted').length,
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
