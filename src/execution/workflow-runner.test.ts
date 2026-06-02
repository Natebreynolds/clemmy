import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for usesSkill injection on workflow steps.
 *
 * Why this matters: usesSkill is the composable-expertise primitive —
 * a step says "use the seo-audit skill", the runner pulls the skill's
 * SKILL.md body and prepends it to the step prompt at execution time.
 * The injection has to (a) preserve the rendered prompt downstream,
 * (b) fail gracefully when a skill is missing rather than silently
 * dropping context.
 *
 * Skills live under BASE_DIR (from config). We can't easily redirect
 * the skill-store at runtime, so the test creates a real skill in the
 * runtime BASE_DIR and cleans up after — keeps the assertion honest
 * against the same skill-loader the runner uses in production.
 */

// Set BASE_DIR to a temp dir BEFORE importing modules that resolve it.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'clementine-runner-test-'));
process.env.CLEMENTINE_HOME = tmp;

const skillsDir = path.join(tmp, 'skills');
mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
writeFileSync(
  path.join(skillsDir, 'test-skill', 'SKILL.md'),
  '---\nname: test-skill\ndescription: Sample skill for runner tests\n---\n\n# Test Skill Instructions\n\nDo the thing carefully.',
  'utf-8',
);

// Imports MUST come after the env var + file setup, since skill-store
// resolves BASE_DIR at module load.
const {
  applySkillToPrompt,
  planWorkflowExecutionBatches,
  runDeterministicWorkflowStepForTest,
  workflowRunnerInternalsForTest,
  explainDeterministicSpawnError,
  reapResolvedParkedRuns,
  executeStep,
  findContractViolationStep,
  describeStepNonCompletion,
} = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { resetEventLog } = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const runEvents = await import('../runtime/run-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

// ---------------------------------------------------------------------------
// P0 — event-driven approval parking (WORKFLOW_APPROVAL_PARKING)
// ---------------------------------------------------------------------------

function writeParkedRun(runId: string, approvalIds: string[]): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(
    filePath,
    JSON.stringify({
      id: runId,
      workflow: 'Test Parking WF',
      status: 'parked',
      parked: {
        parkedSteps: [{ stepId: 'send_step', kind: 'gate', approvalIds }],
        parkedAt: new Date().toISOString(),
      },
    }, null, 2),
    'utf-8',
  );
  return filePath;
}

const statusOf = (filePath: string): string | undefined =>
  JSON.parse(readFileSync(filePath, 'utf-8')).status;

test('reapResolvedParkedRuns keeps a run parked while its approval is pending, re-admits once resolved', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const sid1 = 'workflow-gate:park-test-1:send_step';
  HarnessSession.create({ id: sid1, kind: 'workflow', channel: 'workflow', title: 'park-test-1', metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid1,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun('park-test-1', [row.approvalId]);

  // Approval still pending → the run stays parked (slot stays free; it is
  // NOT re-admitted to the drain).
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');

  // Approval resolved → the two-phase flip re-admits it as 'running' so the
  // next drain pass resumes from the parked step.
  approvalRegistry.resolve(row.approvalId, 'approved', 'parking-test');
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'running');

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns marks the Activity run as resumed when approval clears', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'park-test-activity';
  const sid = `workflow-gate:${runId}:send_step`;
  HarnessSession.create({ id: sid, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun(runId, [row.approvalId]);
  runEvents.startRun({
    id: runId,
    sessionId: `workflow:${runId}`,
    channel: 'workflow',
    source: 'workflow',
    title: 'Workflow: Test Parking WF',
    message: 'Running workflow "Test Parking WF"',
  });

  approvalRegistry.resolve(row.approvalId, 'approved', 'parking-test');
  reapResolvedParkedRuns();

  const activityRun = runEvents.getRun(runId);
  assert.equal(activityRun?.status, 'running');
  assert.equal(activityRun?.events.at(-1)?.type, 'run_resumed');

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns re-admits on a rejected approval too (run fails loudly, never stuck)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const sid2 = 'workflow-gate:park-test-2:send_step';
  HarnessSession.create({ id: sid2, kind: 'workflow', channel: 'workflow', title: 'park-test-2', metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid2,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun('park-test-2', [row.approvalId]);
  approvalRegistry.resolve(row.approvalId, 'rejected', 'parking-test');
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'running');
  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns is a no-op when WORKFLOW_APPROVAL_PARKING is off', () => {
  delete process.env.WORKFLOW_APPROVAL_PARKING;
  const filePath = writeParkedRun('park-test-off', ['apr-irrelevant']);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked'); // scan disabled → untouched
  rmSync(filePath, { force: true });
});

test('applySkillToPrompt: no usesSkill returns prompt unchanged', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing' },
    'do thing',
  );
  assert.equal(out, 'do thing');
});

test('applySkillToPrompt: injects skill body when usesSkill resolves', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing', usesSkill: 'test-skill' },
    'do thing carefully',
  );
  assert.ok(out.includes('=== SKILL: test-skill ==='), 'skill header present');
  assert.ok(out.includes('Do the thing carefully.'), 'skill body present');
  assert.ok(out.includes('=== STEP TASK ==='), 'task delimiter present');
  assert.ok(out.includes('do thing carefully'), 'rendered prompt preserved');
  // Skill must come BEFORE task so the model reads the instructions first.
  assert.ok(out.indexOf('=== SKILL') < out.indexOf('=== STEP TASK'), 'skill precedes task');
});

test('applySkillToPrompt: missing skill fails loud (no silent downgrade)', () => {
  assert.throws(
    () => applySkillToPrompt(
      { id: 'a', prompt: 'do thing', usesSkill: 'does-not-exist' },
      'do thing carefully',
    ),
    /does-not-exist/,
    'a missing declared skill must throw so the step fails and reports back, not run the raw prompt',
  );
});

test('applySkillToPrompt: empty usesSkill string is treated as unset', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing', usesSkill: '   ' },
    'do thing carefully',
  );
  assert.equal(out, 'do thing carefully');
});

// ---------------------------------------------------------------------------
// Gap A — a step that ends in any non-`completed` harness status must report
// back honestly, never be captured as prose-success. The throw in
// runStepViaHarness uses describeStepNonCompletion for a legible message; the
// outer processOneRunFile catch then classifies cancel-vs-error. (The
// behavioral throw is verified live; here we lock the message contract that
// drives the report-back.)
// ---------------------------------------------------------------------------

test('describeStepNonCompletion: limit_exceeded explains the guardrail/budget stop', () => {
  const msg = describeStepNonCompletion('limit_exceeded');
  assert.match(msg, /guardrail|loop|budget|limit/i);
  assert.ok(!/unknown/i.test(msg), 'must be specific, not a generic placeholder');
});

test('describeStepNonCompletion: killed explains the abort', () => {
  assert.match(describeStepNonCompletion('killed'), /abort/i);
});

test('describeStepNonCompletion: awaiting_user_input names the background-workflow limitation + the fix', () => {
  const msg = describeStepNonCompletion('awaiting_user_input');
  assert.match(msg, /user input/i);
  assert.match(msg, /requiresApproval|input/i, 'should point at the actionable remedy');
});

test('describeStepNonCompletion: failed describes an unhandled error', () => {
  assert.match(describeStepNonCompletion('failed'), /error/i);
});

test('describeStepNonCompletion: an explicit harness error takes precedence over the canned reason', () => {
  const msg = describeStepNonCompletion('limit_exceeded', 'tool AIRTABLE_LIST repeated 7x');
  assert.equal(msg, 'tool AIRTABLE_LIST repeated 7x');
});

test('describeStepNonCompletion: a blank error falls back to the status reason (no empty report)', () => {
  const msg = describeStepNonCompletion('killed', '   ');
  assert.match(msg, /abort/i, 'whitespace-only error must not produce an empty report-back');
});

test('describeStepNonCompletion: an unknown future status still yields a non-empty reason', () => {
  const msg = describeStepNonCompletion('some_new_status');
  assert.ok(msg.length > 0);
  assert.match(msg, /some_new_status/);
});

test('planWorkflowExecutionBatches: fans out independent dependsOn branches', () => {
  const batches = planWorkflowExecutionBatches([
    { id: 'normalize', prompt: 'normalize' },
    { id: 'site', prompt: 'site', dependsOn: ['normalize'] },
    { id: 'seo', prompt: 'seo', dependsOn: ['normalize'] },
    { id: 'reviews', prompt: 'reviews', dependsOn: ['normalize'] },
    { id: 'aggregate', prompt: 'aggregate', dependsOn: ['site', 'seo', 'reviews'] },
    { id: 'render', prompt: 'render', dependsOn: ['aggregate'] },
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((step) => step.id)),
    [
      ['normalize'],
      ['site', 'seo', 'reviews'],
      ['aggregate'],
      ['render'],
    ],
  );
});

test('planWorkflowExecutionBatches: resumes after completed steps', () => {
  const batches = planWorkflowExecutionBatches([
    { id: 'normalize', prompt: 'normalize' },
    { id: 'site', prompt: 'site', dependsOn: ['normalize'] },
    { id: 'seo', prompt: 'seo', dependsOn: ['normalize'] },
    { id: 'aggregate', prompt: 'aggregate', dependsOn: ['site', 'seo'] },
  ], new Set(['normalize', 'site']));

  assert.deepEqual(
    batches.map((batch) => batch.map((step) => step.id)),
    [
      ['seo'],
      ['aggregate'],
    ],
  );
});

test('planWorkflowExecutionBatches: rejects cyclic graphs', () => {
  assert.throws(
    () => planWorkflowExecutionBatches([
      { id: 'a', prompt: 'a', dependsOn: ['b'] },
      { id: 'b', prompt: 'b', dependsOn: ['a'] },
    ]),
    /blocked or cyclic/,
  );
});

test('bindStepContext carries dependsOn outputs even without explicit step inputs', () => {
  const ctx = {
    inputs: {},
    stepOutputs: {
      fetch_accounts: { rows: [{ id: 'A1', domain: 'example.com' }], count: 1 },
      unrelated: { ignored: true },
    },
    workflowSlug: 'test-workflow',
    runId: 'run-context-test',
  };

  const bound = workflowRunnerInternalsForTest.bindStepContext(
    { id: 'summarize', prompt: 'Summarize the fetched accounts.', dependsOn: ['fetch_accounts'] },
    ctx as never,
  );

  assert.ok(bound);
  assert.deepEqual(bound, {
    values: {},
    upstream: {
      fetch_accounts: { rows: [{ id: 'A1', domain: 'example.com' }], count: 1 },
    },
    item: undefined,
  });
  const rendered = workflowRunnerInternalsForTest.renderStepContextBlock(bound);
  assert.match(rendered, /STEP CONTEXT/);
  assert.match(rendered, /fetch_accounts/);
  assert.match(rendered, /example\.com/);
  assert.doesNotMatch(rendered, /unrelated/);
});

test('workflow harness sessions are deterministic per run step', () => {
  resetEventLog();
  const first = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );
  const second = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );

  assert.equal(first.id, 'workflow:run-123:surface_for_approval');
  assert.equal(second.id, first.id);
  assert.equal(second.sessionRow.metadata.workflowRunId, 'run-123');
});

test('workflow harness resume reuses already parked legacy approval session', () => {
  resetEventLog();
  const legacy = HarnessSession.create({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Daily Outreach::surface_for_approval',
    metadata: {
      source: 'workflow',
      workflowName: 'Daily Outreach',
      stepId: 'surface_for_approval',
    },
  });
  approvalRegistry.register({
    sessionId: legacy.id,
    subject: 'Send the pending cold-prospect emails',
    tool: 'request_approval',
  });

  const resumed = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );

  assert.equal(resumed.id, legacy.id);
  assert.equal(HarnessSession.load('workflow:run-123:surface_for_approval'), null);
});

test('deterministic workflow step runs a bundled scripts/ helper with JSON stdin', async () => {
  const workflowDir = path.join(tmp, 'vault', '00-System', 'workflows', 'deterministic-test');
  const scriptsDir = path.join(workflowDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'echo.mjs'),
    [
      'let input = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => input += chunk);',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input);',
      '  process.stdout.write(JSON.stringify({ stepId: payload.stepId, account: payload.inputs.account, prior: payload.stepOutputs.prior }));',
      '});',
    ].join('\n'),
    'utf-8',
  );

  const output = await runDeterministicWorkflowStepForTest('echo.mjs', {
    workflow: 'Deterministic Test',
    workflowSlug: 'deterministic-test',
    runId: 'run-1',
    stepId: 'script',
    inputs: { account: 'Acme' },
    stepOutputs: { prior: ['one'] },
  });

  assert.deepEqual(output, { stepId: 'script', account: 'Acme', prior: ['one'] });
});

test('deterministic workflow step rejects runners outside scripts/', async () => {
  await assert.rejects(
    () => runDeterministicWorkflowStepForTest('../bad.sh', {
      workflow: 'Deterministic Test',
      workflowSlug: 'deterministic-test',
      runId: 'run-1',
      stepId: 'script',
      inputs: {},
      stepOutputs: {},
    }),
    /inside the workflow scripts|outside scripts|must stay inside/,
  );
});

test('deterministic step ENFORCES its output contract (regression guard: routes through finalizeStepOutput)', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-contract-test', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'emit.mjs'),
    [
      'let i = ""; process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (c) => i += c);',
      'process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));',
    ].join('\n'),
    'utf-8',
  );
  const mkCtx = (runId: string) => ({
    workflow: { name: 'Det Contract Test', steps: [] },
    workflowSlug: 'det-contract-test',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {},
    completedItems: new Map(),
    forEachFailures: [],
  } as unknown as Parameters<typeof executeStep>[1]);

  // The script emits { ok: true }; the contract requires a `url` key → the
  // deterministic step must FAIL its contract (previously this was silently
  // accepted because the deterministic path bypassed verification).
  const failStep = { id: 'd_fail', prompt: 'x', deterministic: { runner: 'emit.mjs' }, output: { type: 'object', required_keys: ['url'] } } as unknown as Parameters<typeof executeStep>[0];
  await assert.rejects(() => executeStep(failStep, mkCtx('det-fail')), /failed its contract/);
  const failKinds = readWorkflowEvents('det-contract-test', 'det-fail').map((e) => e.kind);
  assert.ok(failKinds.includes('step_failed'), 'deterministic contract violation → step_failed');
  assert.ok(!failKinds.includes('step_completed'), 'deterministic contract violation must NOT record step_completed');

  // No declared contract → unverified, completes (backward-compatible).
  const okStep = { id: 'd_ok', prompt: 'x', deterministic: { runner: 'emit.mjs' } } as unknown as Parameters<typeof executeStep>[0];
  const out = await executeStep(okStep, mkCtx('det-ok'));
  assert.deepEqual(out, { ok: true });
  assert.ok(readWorkflowEvents('det-contract-test', 'det-ok').map((e) => e.kind).includes('step_completed'));
});

test('findContractViolationStep: finds the most-recent output_contract failure with its problems', () => {
  const events = [
    { t: '1', kind: 'step_started', stepId: 'a' },
    { t: '2', kind: 'step_failed', stepId: 'a', meta: { reason: 'output_contract', problems: ['missing required output key "url"'] } },
  ] as never;
  const cv = findContractViolationStep(events);
  assert.equal(cv?.stepId, 'a');
  assert.deepEqual(cv?.problems, ['missing required output key "url"']);
});

test('findContractViolationStep: null when the failure is not a contract violation', () => {
  assert.equal(findContractViolationStep([{ t: '1', kind: 'step_failed', stepId: 'a', meta: { reason: 'transient' } }] as never), null);
  assert.equal(findContractViolationStep([{ t: '1', kind: 'step_completed', stepId: 'a' }] as never), null);
  assert.equal(findContractViolationStep([] as never), null);
});

// Cleanup the temp BASE_DIR.
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- #4: deterministic-step spawn error is made legible ----

test('explainDeterministicSpawnError: EPERM names the packaged-app TCC sandbox cause', () => {
  const err = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  const out = explainDeterministicSpawnError(err, 'scripts/fetch.py');
  assert.match(out.message, /sandbox|TCC|entitlement/i);
  assert.match(out.message, /scripts\/fetch\.py/);
});

test('explainDeterministicSpawnError: ENOENT points at a missing interpreter/script', () => {
  const err = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
  const out = explainDeterministicSpawnError(err, 'scripts/fetch.py');
  assert.match(out.message, /missing/i);
});

test('explainDeterministicSpawnError: an unrelated error passes through unchanged', () => {
  const err = new Error('some other failure');
  const out = explainDeterministicSpawnError(err, 'scripts/x.sh');
  assert.equal(out.message, 'some other failure');
});

test('reapResolvedParkedRuns does NOT re-admit when a watched approval row is missing (no auto-approve on a lost row)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  // 'apr-ghost' was never registered → get() returns undefined → cannot
  // confirm resolution → the run must stay parked (the watchdog surfaces it).
  const filePath = writeParkedRun('park-ghost', ['apr-ghost-never-registered']);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns does NOT re-admit a parked run with empty watched approvalIds (thrash guard)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const filePath = writeParkedRun('park-empty', []);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('awaitDeclarativeStepApproval creates the gate session so register() does not FK (live regression)', async () => {
  // Repro of the live e2e bug: a requires_approval gate registered an approval
  // under workflow-gate:<runId>:<stepId> with NO sessions row → pending_approvals
  // FK violation → run_failed before it could park. The fix creates the gate
  // session first. With parking on, the gate registers then throws to release
  // the slot — assert it throws but NOT a FK error, and the row was created.
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'gate-fk-regression';
  const gateSessionId = `workflow-gate:${runId}:send`;
  assert.equal(HarnessSession.load(gateSessionId), null, 'no pre-existing gate session (the bug condition)');

  const ctx = {
    workflow: { name: 'Gate FK WF', steps: [] },
    workflowSlug: 'gate-fk-wf',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {} as never,
    completedItems: new Map(),
    forEachFailures: [],
  } as never;
  const step = { id: 'send', prompt: 'send it', requiresApproval: true, approvalPreview: 'Send the thing' } as never;

  let threw: Error | null = null;
  try {
    await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step);
  } catch (e) {
    threw = e as Error;
  }
  assert.ok(threw, 'parking path throws (ParkRunSignal) to release the slot');
  assert.ok(!/FOREIGN KEY/i.test(threw!.message), `must not FK: ${threw!.message}`);
  assert.ok(HarnessSession.load(gateSessionId), 'gate session row was created');
  const pending = approvalRegistry.listPending({ sessionId: gateSessionId, status: 'pending' });
  assert.equal(pending.length, 1, 'exactly one pending gate approval registered');

  delete process.env.WORKFLOW_APPROVAL_PARKING;
});
