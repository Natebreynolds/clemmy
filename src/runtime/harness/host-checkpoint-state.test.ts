/** Canonical checkpoint decoding without the application/store import graph. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  HostInterruptState, HostRecoveryState, MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS,
} from './host-checkpoint-state.js';
import {
  hostInteractiveConsentApprovalResumeKey, parseHostInteractiveConsentSubjectV1,
} from './host-interactive-consent-subject.js';
import { assertSourceBudgetPolicyRef } from './source-budget-policy-ref.js';
import { hostApprovalCheckpointSource, sourceApprovalCheckpointPath, sourceApprovalSnapshotFromMetadata } from './source-approval-checkpoint-data.js';
import { initializeNoProgressGovernor } from './no-progress-governor.js';
import type { HostConnectionProgress } from './host-connection-progress.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const ref = { sessionId: 'checkpoint-fixture', sourceUserSeq: 7, acceptedTaskId: 'task:checkpoint-fixture#7',
  batchOrdinal: 1, batchId: 'a'.repeat(64), authorityDigest: 'b'.repeat(64) };
const subject = { version: 1 as const, sessionId: ref.sessionId, sourceUserSeq: ref.sourceUserSeq,
  acceptedTaskId: ref.acceptedTaskId, logicalToolCallId: 'call-1', decisionSubjectDigest: 'c'.repeat(64),
  callDigest: 'd'.repeat(64), coverageDigest: 'e'.repeat(64), riskDigest: 'f'.repeat(64) };
const call = { callId: 'call-1', name: 'read_file', rawItem: { name: 'read_file', arguments: '{"path":"controlled"}', callId: 'call-1' } };
const history = [{ type: 'message' as const, role: 'user' as const, content: 'Controlled checkpoint objective.' }];
const frame = [{ type: 'function_call' as const, callId: 'call-1', name: 'read_file', arguments: '{}' }];
const results = [{ type: 'function_call_result' as const, callId: 'call-1', name: 'read_file', output: 'controlled result' }];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('cold checkpoint and metadata imports cannot enter application initializers or create a home', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-checkpoint-cold-'));
  const home = path.join(temporary, 'must-stay-absent');
  const allowed = [
    'runtime/harness/host-checkpoint-state.ts', 'runtime/harness/host-interactive-consent-subject.ts',
    'runtime/harness/source-budget-policy-ref.ts', 'runtime/harness/source-approval-checkpoint-data.ts',
    'runtime/harness/host-connection-progress.ts', 'runtime/harness/conversation-protocol.ts',
    'runtime/harness/no-progress-governor.ts', 'shared/closed-canonical-json.ts',
  ];
  const loader = `
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const sourceRoot = ${JSON.stringify(path.join(root, 'src') + path.sep)};
    const allowed = new Set(${JSON.stringify(allowed)});
    export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      if (result.url.startsWith('file:')) {
        const filename = fileURLToPath(result.url);
        if (filename.startsWith(sourceRoot) && !allowed.has(filename.slice(sourceRoot.length).split(path.sep).join('/'))) {
          throw new Error('blocked application import: ' + filename.slice(sourceRoot.length));
        }
        const normalized = filename.split(path.sep).join('/');
        if (normalized.includes('/node_modules/better-sqlite3/') || normalized.includes('/node_modules/@openai/')) throw new Error('blocked store/provider import');
      }
      return result;
    }`;
  const run = (target: string, reject = false) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { register } from 'node:module';
    import { existsSync } from 'node:fs';
    register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);
    const target = ${JSON.stringify(target)};
    try {
      const loaded = await import(target);
      if (${reject}) throw new Error('the guard allowed an application entry');
      if (typeof loaded.HostInterruptState !== 'function') throw new Error('checkpoint entry did not load');
      await import(${JSON.stringify(pathToFileURL(path.join(root, 'src/runtime/harness/source-approval-checkpoint-data.ts')).href)});
      if (existsSync(${JSON.stringify(home)})) throw new Error('cold import initialized a home');
    } catch (error) {
      if (!${reject} || !String(error).includes('blocked application import')) throw error;
    }
  `], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLEMENTINE_HOME: home } });
  try {
    const positive = run(pathToFileURL(path.join(root, 'src/runtime/harness/host-checkpoint-state.ts')).href);
    assert.equal(positive.status, 0, `${positive.stderr}\n${positive.stdout}`);
    const negative = run(pathToFileURL(path.join(root, 'src/runtime/harness/host-turn-runner.ts')).href, true);
    assert.equal(negative.status, 0, `${negative.stderr}\n${negative.stdout}`);
    assert.equal(existsSync(home), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('minimal current interrupt serialization preserves its exact established byte order', () => {
  assert.equal(new HostInterruptState([], []).toString(),
    '{"__clemHostInterrupt":7,"nativeApprovalKeys":true,"history":[],"pending":[],"turnEngine":"host_v1_read_only","objectiveJudgeContinuations":0}');
  assert.equal(HostInterruptState.isHostState('  {"__clemHostInterrupt":7}'), true);
  assert.equal(HostInterruptState.isHostState('{"$schemaVersion":"1.0"}'), false);
});

test('all seven interrupt versions retain their engine and native-card compatibility boundaries', () => {
  for (let version = 1; version <= 7; version++) {
    const wire = JSON.stringify({ __clemHostInterrupt: version, history: [], pending: [], turnEngine: 'host_v1', nativeApprovalKeys: true });
    const state = HostInterruptState.fromString(wire);
    assert.equal(state.turnEngine, version === 1 ? 'host_v1_read_only' : 'host_v1');
    assert.equal(state.nativeApprovalKeys, version === 7);
    assert.equal(state.objectiveJudgeContinuations, 0);
    assert.equal(state.toString(), `{"__clemHostInterrupt":7,"nativeApprovalKeys":${version === 7},"history":[],"pending":[],"turnEngine":"${version === 1 ? 'host_v1_read_only' : 'host_v1'}","objectiveJudgeContinuations":0}`);
  }
  for (const version of [0, 8, '7', null]) assert.throws(() => HostInterruptState.fromString(JSON.stringify({ __clemHostInterrupt: version })), /not a host-owned/);
});

test('pending calls preserve admitted bytes and use exact interruption identity for decisions', () => {
  const state = new HostInterruptState([], [{ ...clone(call), consentSubject: subject }], undefined, 'host_v1', undefined, ref);
  const admitted = state.pending[0].admittedArgumentsJson;
  const key = state.approvalResumeKey(state.pending[0]);
  const item = state.getInterruptions()[0];
  item.rawItem.arguments = '{"path":"owner edit"}';
  state.approve({ rawItem: { ...item.rawItem } });
  assert.equal(state.pending[0].decision, undefined, 'a copied shape is not the held interruption');
  state.approve(item); assert.equal(state.pending[0].decision, 'approved');
  assert.equal(state.pending[0].admittedArgumentsJson, admitted);
  assert.equal(state.approvalResumeKey(state.pending[0]), key);
  const reopened = HostInterruptState.fromString(state.toString());
  assert.equal(reopened.pending[0].admittedArgumentsJson, admitted);
  assert.equal(reopened.pending[0].rawItem.arguments, item.rawItem.arguments);
  const changed = new HostInterruptState([], [clone(call)]);
  changed.requestChange(changed.getInterruptions()[0], 'Change the controlled destination.');
  assert.equal(changed.pending[0].decision, 'rejected');
  assert.equal(HostInterruptState.fromString(changed.toString()).pending[0].changeRequest, undefined,
    'serialized bytes never become new owner instructions');
});

test('legacy fields cannot acquire consent and current malformed consent/admitted bytes stay rejected', () => {
  for (const version of [1, 2]) {
    const state = HostInterruptState.fromString(JSON.stringify({ __clemHostInterrupt: version, history: [], turnEngine: 'host_v1',
      pending: [{ ...clone(call), consentSubject: subject, admittedArgumentsJson: 'untrusted legacy field' }] }));
    assert.equal(state.pending[0].consentSubject, undefined);
    assert.equal(state.pending[0].admittedArgumentsJson, call.rawItem.arguments);
  }
  const current = JSON.parse(new HostInterruptState([], [{ ...clone(call), consentSubject: subject }]).toString());
  assert.throws(() => HostInterruptState.fromString(JSON.stringify({ ...current, pending: [{ ...current.pending[0], admittedArgumentsJson: undefined }] })), /admitted argument bytes/);
  assert.throws(() => HostInterruptState.fromString(JSON.stringify({ ...current, pending: [{ ...current.pending[0], consentSubject: { ...subject, logicalToolCallId: 'foreign' } }] })), /exact consent subject/);
  assert.equal(parseHostInteractiveConsentSubjectV1({ ...subject, extra: true }), null);
  assert.equal(parseHostInteractiveConsentSubjectV1({ ...subject, callDigest: 'bad' }), null);
  assert.equal(hostInteractiveConsentApprovalResumeKey(subject), `host-consent:v1:${hash(closedCanonicalJson(subject))}`);
});

test('recovery phases preserve exact protocol validation, source binding and stable serialization', () => {
  const continued = new HostRecoveryState(ref.sessionId, ref.sourceUserSeq, 'continue', history, [], [], undefined, undefined, 'host_v1', undefined, 1, ref);
  const expected = JSON.stringify({ __clemHostRecovery: 1, sessionId: ref.sessionId, sourceUserSeq: ref.sourceUserSeq, phase: 'continue',
    history, frameHistory: [], resultItems: [], turnEngine: 'host_v1', stepIndex: 1, objectiveJudgeContinuations: 0, acceptedModelBatchRef: ref });
  assert.equal(continued.toString(), expected);
  assert.equal(HostRecoveryState.fromString(expected).toString(), expected);
  for (const phase of ['admit', 'finalize'] as const) {
    const state = new HostRecoveryState(ref.sessionId, ref.sourceUserSeq, phase, history, frame, phase === 'admit' ? [] : results,
      'prior', 'response', 'host_v1', undefined, 1, phase === 'admit' ? undefined : ref);
    assert.equal(HostRecoveryState.fromString(state.toString()).toString(), state.toString());
  }
  const wire = JSON.parse(expected);
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, acceptedModelBatchRef: { ...ref, sourceUserSeq: 8 } })), /continuation payload/);
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, frameHistory: frame })), /continuation payload/);
  const final = new HostRecoveryState(ref.sessionId, ref.sourceUserSeq, 'finalize', history, frame, results, undefined, undefined, 'host_v1', undefined, 1, ref);
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...JSON.parse(final.toString()), resultItems: [{ ...results[0], callId: 'foreign' }] })), /phase payload/);
});

test('retained progress/review/budget validation remains canonical and cannot reset a source allowance', () => {
  const feedback = { version: 1 as const, sessionId: ref.sessionId, sourceUserSeq: ref.sourceUserSeq, objective: 'Controlled objective',
    objectiveDigest: hash('Controlled objective'), reply: 'Controlled reply', replyDigest: hash('Controlled reply'), reason: 'Controlled missing evidence.' };
  const noProgress = { state: initializeNoProgressGovernor({ taskKey: ref.acceptedTaskId,
    authority: { operation: [], account: [], target: [], evidence: [], effect: [] } }),
    historyCursor: 0, recoveryOnly: false, recoveryDirectiveWritten: false };
  const progress: HostConnectionProgress = { version: 1, batch: ref,
    recovery: { turnEngine: 'host_v1', stepIndex: 1, noProgressCheckpoint: noProgress, objectiveJudgeContinuations: 1, completionReviewFeedback: feedback },
    activation: { maxTurns: 5, toolCalls: { used: 2, limit: 5 }, elapsedMs: 10, judgeCompletion: true, outerBudget: { eventId: 'policy', digest: '1'.repeat(64) } },
    continuations: { acceptedReadPlanUsed: true, acceptedUniqueWorkflowUsed: false, workflowStepResultUsed: 0, continueMarkerUsed: 0, planFinalPublishSpent: false, modelStallRetriesRemaining: 0 },
    watcher: { checksUsed: 1, injectionsUsed: 0, deliveredSteers: 0, unresolvedDrift: false, lastCheckedAt: 1, lastFailureSeq: 0, checkInFlight: false } };
  const state = new HostRecoveryState(ref.sessionId, ref.sourceUserSeq, 'continue', history, [], [], undefined, undefined, 'host_v1', noProgress, 1, ref, 1, feedback, progress);
  const wire = JSON.parse(state.toString());
  assert.equal(HostRecoveryState.fromString(state.toString()).toString(), state.toString());
  for (const n of [-1, 0.5, MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS + 1, '1', null]) {
    assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, objectiveJudgeContinuations: n })), /continuation count/);
  }
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, completionReviewFeedback: { ...feedback, reply: 'tampered' } })), /completion-review feedback/);
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, connectionProgress: { ...progress, batch: { ...ref, sessionId: 'foreign' } } })), /connection progress/);
  assert.throws(() => HostRecoveryState.fromString(JSON.stringify({ ...wire, connectionProgress: { ...progress, activation: { ...progress.activation, outerBudget: { eventId: 'policy', digest: 'bad' } } } })), /budget reference/);
  assert.throws(() => assertSourceBudgetPolicyRef({ eventId: '', digest: '1'.repeat(64) }), /budget reference/);
});

test('metadata codecs preserve tombstones, exact source paths and foreign identity refusal', () => {
  assert.equal(sourceApprovalCheckpointPath({ sessionId: ref.sessionId, sourceUserSeq: 7 }), '$.__source_approval_checkpoints."7"');
  assert.throws(() => sourceApprovalCheckpointPath({ sessionId: ref.sessionId, sourceUserSeq: 0 }), /exact accepted source/);
  const state = new HostInterruptState([], [clone(call)], undefined, 'host_v1', undefined, ref);
  assert.equal(hostApprovalCheckpointSource(state.toString(), ref.sessionId), ref.sourceUserSeq);
  assert.throws(() => hostApprovalCheckpointSource(state.toString(), 'foreign'), /one exact source/);
  assert.deepEqual(sourceApprovalSnapshotFromMetadata({ __source_approval_checkpoints: { 7: { revision: 'retired', checkpoint: null } } }, 7), { revision: 'retired', checkpoint: null });
  const metadata = { __source_approval_checkpoints: { 7: { revision: 'retained', checkpoint: { serialized: state.toString(), mcpToolScope: null } } } };
  const snapshot = sourceApprovalSnapshotFromMetadata(metadata, 7);
  snapshot.checkpoint!.serialized = 'changed caller copy';
  assert.equal(metadata.__source_approval_checkpoints[7].checkpoint.serialized, state.toString());
  assert.throws(() => sourceApprovalSnapshotFromMetadata({ __source_approval_checkpoints: [] }, 7), /checkpoint index/);
});
