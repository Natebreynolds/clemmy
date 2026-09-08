/**
 * Recovery must not be a one-guess cul-de-sac, and it must permit the tools its
 * own advice names.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/recovery-not-a-dead-end.test.ts
 *
 * Live 2026-09-07 — the owner's "read the Sheet, check the data, plan the fix"
 * task failed FOUR times, always identically:
 *
 *   terminal: control_no_progress_exhausted / recovery_surface_mismatch
 *   last governor: action=continue, reason=consequence_progress, retriesRemaining=1
 *
 * The governor said CONTINUE with budget left. The turn ended anyway.
 *
 * Worse, in source 148817 the harness contradicted itself out loud: a refusal
 * told the model verbatim "Call tool_output_query {…} — this output holds
 * structured records", the model did exactly that, and the frame was refused as
 * outside the recovery surface and terminalized. Advice and surface were
 * computed independently.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { HostRecoveryState, hostNoProgressRecoveryToolNames } from './host-turn-runner.js';
import {
  createNoProgressConsequence,
  initializeNoProgressGovernor,
  NO_PROGRESS_RETRY_BUDGET,
  observeNoProgress,
} from './no-progress-governor.js';

const SRC = readFileSync(new URL('./host-turn-runner.ts', import.meta.url), 'utf8');

const consequence = (tools: string[]) => createNoProgressConsequence({
  stage: 'schema_invalid:call:deadbeefdeadbeef',
  recovery: 'repair_model',
  // known_terminal is the state that previously collapsed the surface to the
  // single named tool — the exact Platform 49 shape.
  effectState: 'known_terminal',
  recoveryToolNames: tools,
});

test('THE 148817 CASE: the surface admits the tools recovery advice names', () => {
  const permitted = hostNoProgressRecoveryToolNames(
    consequence(['file_query']),
    ['file_query', 'tool_output_query', 'recall_tool_result', 'workflow_create', 'space_save'],
  );
  assert.ok(permitted.has('tool_output_query'),
    'the harness told the model to call this; it must not then refuse it');
  assert.ok(permitted.has('recall_tool_result'));
  assert.ok(permitted.has('file_query'));
});

test('retained-result readers do not smuggle in writes', () => {
  const permitted = hostNoProgressRecoveryToolNames(
    consequence(['file_query']),
    ['file_query', 'workflow_create', 'space_save', 'write_file', 'composio_execute_tool'],
  );
  for (const write of ['workflow_create', 'space_save', 'write_file']) {
    assert.ok(!permitted.has(write), `${write} must stay out of the recovery surface`);
  }
});

test('a stop_factual or reconcile consequence still permits nothing', () => {
  for (const [recovery, effectState] of [
    ['stop_factual', 'known_terminal'],
    ['reconcile', 'unknown'],
  ] as const) {
    const permitted = hostNoProgressRecoveryToolNames(
      createNoProgressConsequence({
        stage: 'execution:effect_unknown', recovery, effectState, recoveryToolNames: [],
      }),
      ['file_query', 'tool_output_query'],
    );
    assert.equal(permitted.size, 0, `${recovery} must not gain readers`);
  }
});

test('an ask_user consequence still routes only to the question', () => {
  const permitted = hostNoProgressRecoveryToolNames(
    createNoProgressConsequence({
      stage: 'input:needed', recovery: 'ask_user', effectState: 'not_started',
      recoveryToolNames: [], userInput: { question: 'Which sheet?', choices: [] },
    }),
    ['ask_user_question', 'file_query', 'tool_output_query'],
  );
  assert.deepEqual([...permitted], ['ask_user_question']);
});

test('a surface miss resumes after its committed refusal instead of re-admitting that frame', () => {
  const start = SRC.indexOf('const permittedForDiagnostic =');
  const end = SRC.indexOf('const canonicalFrameDigest =', start);
  assert.ok(start >= 0 && end > start, 'the exact recovery-surface branch is present');
  const site = SRC.slice(start, end);
  assert.match(site, /commitAdmittedToolFrame[\s\S]*recordZeroCrossingRefusal/,
    'the refusal is durably paired and metered before continuation');
  assert.match(site, /return recoveryContinuationOutcome\(\s*acceptedFrame\.ref,\s*'recovery_surface_reprompt'/,
    'continue after the balanced checkpoint; do not re-admit its call IDs');
  assert.doesNotMatch(site, /return recoveryOutcome\(/,
    'the already committed refusal must not reopen an admit/finalize checkpoint');
});

test('a repeated pre-dispatch repair preserves its finite budget through HostRecoveryState reopen', () => {
  const sessionId = 'surface-recovery-budget';
  const sourceUserSeq = 11;
  const taskKey = 'accepted-surface-recovery-budget';
  const authority = { operation: [], account: [], target: [], evidence: [], effect: [] };
  let state = initializeNoProgressGovernor({ taskKey, authority });
  const repair = createNoProgressConsequence({ stage: 'host_disposition:refused_pre_dispatch',
    recovery: 'repair_model', effectState: 'not_started', recoveryToolNames: ['call_tool'] });
  const ref = { sessionId, sourceUserSeq, acceptedTaskId: taskKey, batchOrdinal: 1,
    batchId: 'a'.repeat(64), authorityDigest: 'b'.repeat(64) };
  for (let attempt = 1; attempt <= NO_PROGRESS_RETRY_BUDGET; attempt++) {
    const decision = observeNoProgress(state, { taskKey, authority, attemptClass: 'zero_crossing_repair', consequence: repair });
    assert.equal(decision.action, 'continue', 'available recovery budget reaches the model');
    const saved = new HostRecoveryState(sessionId, sourceUserSeq, 'continue', [], [], [],
      undefined, undefined, 'host_v1', { state: decision.state, historyCursor: 0,
        recoveryOnly: true, recoveryDirectiveWritten: false }, attempt, ref);
    const resumed = HostRecoveryState.fromString(saved.toString());
    assert.equal(resumed.phase, 'continue');
    assert.deepEqual(resumed.acceptedModelBatchRef, ref);
    assert.deepEqual(resumed.frameHistory, [], 'no completed frame is re-admitted');
    assert.ok(resumed.noProgressCheckpoint);
    state = resumed.noProgressCheckpoint.state;
    assert.deepEqual(state, decision.state, 'resume cannot reset a spent retry or observation');
    assert.equal(state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET - attempt);
    assert.equal(state.noProgressAttempts, attempt - 1);
    assert.deepEqual(state.seenConsequenceKeys, [repair.key]);
    assert.deepEqual(state.authority, authority);
  }
  const stopped = observeNoProgress(state, { taskKey, authority, attemptClass: 'zero_crossing_repair', consequence: repair });
  assert.equal(stopped.action, 'terminalize', 'a genuine no-progress loop still has a finite end');
  assert.equal(stopped.reason, 'control_no_progress_exhausted');
});

test('a REQUIRED question is still terminal', () => {
  // That one genuinely needs the user; re-prompting would loop forever.
  assert.match(SRC, /required_question_not_issued/,
    'a required question still terminalizes — re-prompting it would loop forever');
  // and the re-prompt path explicitly excludes it
  assert.match(SRC, /if \(!nonCanonicalNoProgressAsk && noProgressState\)/);
});

test('a refused recovery frame names the permitted surface in its durable result', () => {
  // The one-shot request directive is never canonical history, so if the
  // refusal itself does not name the surface, the next step / resume / retry
  // sees a silently narrowed tool list. Live 2026-09-07: four Platform 49 runs
  // died on a single unguided guess.
  const src = readFileSync(
    new URL('./host-turn-runner.ts', import.meta.url), 'utf8',
  );
  const site = src.slice(src.indexOf('NAME THE SURFACE IN THE REFUSAL ITSELF'));
  assert.ok(
    /pairLocallyRefusedFrame\(canonicalCalls, false, surfaceDiagnostics\)/.test(site.slice(0, 2000)),
    'the recovery-surface refusal must pair a host-authored diagnostic',
  );
  assert.ok(
    /only these capabilities are available/.test(site.slice(0, 2000)),
    'the diagnostic must enumerate the permitted set',
  );
});

test('retained readers are a registry declaration, not a list in the turn runner', () => {
  const src = readFileSync(
    new URL('./host-turn-runner.ts', import.meta.url), 'utf8',
  );
  assert.ok(
    !/RETAINED_RESULT_READERS/.test(src),
    'recovery admissibility must not carry a hardcoded tool list',
  );
  assert.ok(
    /toolReadsRetainedOutput\(bare\)/.test(src),
    'it must read the registry declaration instead',
  );
});
