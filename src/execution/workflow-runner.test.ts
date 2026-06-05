import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  enqueueWorkflowOutcomeTurn,
  shouldNotifyCancelledRun,
  coerceOutputForContract,
  applyContractToPrompt,
  describeOutputShape,
  isTransientStepError,
  creationTestVerdict,
} = await import('./workflow-runner.js');
const { SessionStore: RunnerSessionStore } = await import('../memory/session-store.js');
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

// ── D: contract binding (parse JSON-text output + inject the shape) ──────────

const objContract = { type: 'object', required_keys: ['proposed_prospects', 'existing_airtable_count', 'dedupe_summary'] } as never;

test('coerceOutputForContract: no contract → output unchanged', () => {
  assert.equal(coerceOutputForContract('just text', undefined), 'just text');
});

test('coerceOutputForContract: an already-structured object is returned as-is', () => {
  const o = { proposed_prospects: [], existing_airtable_count: 0, dedupe_summary: 'x' };
  assert.equal(coerceOutputForContract(o, objContract), o);
});

test('coerceOutputForContract: a JSON-TEXT output is parsed into the object (the live failure)', () => {
  const text = '{"proposed_prospects":[{"account_name":"Acme"}],"existing_airtable_count":3,"dedupe_summary":"ok"}';
  const out = coerceOutputForContract(text, objContract);
  assert.equal(typeof out, 'object');
  assert.equal((out as { existing_airtable_count: number }).existing_airtable_count, 3);
  assert.equal(((out as { proposed_prospects: unknown[] }).proposed_prospects).length, 1);
});

test('coerceOutputForContract: a fenced ```json block is parsed', () => {
  const text = 'Here you go:\n```json\n{"proposed_prospects":[],"existing_airtable_count":0,"dedupe_summary":"none"}\n```';
  const out = coerceOutputForContract(text, objContract);
  assert.equal((out as { dedupe_summary: string }).dedupe_summary, 'none');
});

test('coerceOutputForContract: JSON embedded in surrounding prose is extracted', () => {
  const text = 'Done. {"proposed_prospects":[],"existing_airtable_count":1,"dedupe_summary":"d"} — that is the batch.';
  const out = coerceOutputForContract(text, objContract);
  assert.equal((out as { existing_airtable_count: number }).existing_airtable_count, 1);
});

test('coerceOutputForContract: non-JSON text is returned unchanged (verifier then fails loudly, as before)', () => {
  assert.equal(coerceOutputForContract('I could not find any prospects.', objContract), 'I could not find any prospects.');
});

test('coerceOutputForContract: a type:"string" contract is NEVER coerced — a JSON-looking string stays a string (regression #1)', () => {
  const strContract = { type: 'string' } as never;
  assert.equal(coerceOutputForContract('{"a":1}', strContract), '{"a":1}');
  assert.equal(coerceOutputForContract('[1,2,3]', strContract), '[1,2,3]');
});

test('coerceOutputForContract: a parse that does NOT satisfy the contract is rejected (no wrong-pass, regression #2)', () => {
  // objContract requires proposed_prospects/existing_airtable_count/dedupe_summary.
  // A JSON object WITHOUT those keys must NOT be accepted — return the original
  // so the verifier fails loudly instead of binding a wrong-shaped object.
  const wrong = '{"reply":"found some","summary":"3 prospects"}';
  assert.equal(coerceOutputForContract(wrong, objContract), wrong);
});

test('describeOutputShape: names the actual produced shape (so a contract failure is diagnosable)', () => {
  assert.match(describeOutputShape({ reply: 'x', summary: 'y' }), /object with keys: reply, summary/);
  assert.match(describeOutputShape([1, 2, 3]), /array \(3 items\)/);
  assert.match(describeOutputShape('hello world'), /string \(11 chars\)/);
  assert.equal(describeOutputShape(null), 'null');
});

test('applyContractToPrompt: no contract → prompt unchanged', () => {
  assert.equal(applyContractToPrompt({ id: 'a', prompt: 'do' }, 'do'), 'do');
});

test('applyContractToPrompt: injects the EXACT required keys so the agent knows the shape', () => {
  const out = applyContractToPrompt({ id: 'a', prompt: 'do', output: objContract } as never, 'find prospects');
  assert.match(out, /REQUIRED OUTPUT/);
  assert.match(out, /"proposed_prospects"/);
  assert.match(out, /"existing_airtable_count"/);
  assert.match(out, /"dedupe_summary"/);
  assert.ok(out.startsWith('find prospects'), 'the task text is preserved first');
});

test('applyContractToPrompt: surfaces url_present as a hard requirement', () => {
  const c = { type: 'object', required_keys: ['airtable_table_url'], verify: { url_present: ['airtable_table_url'] } } as never;
  const out = applyContractToPrompt({ id: 'w', prompt: 'write', output: c } as never, 'write records');
  assert.match(out, /https:\/\/ URL/i);
  assert.match(out, /airtable_table_url/);
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

// ---------------------------------------------------------------------------
// Gap E — enqueueWorkflowOutcomeTurn: re-enter the origin chat in-context.
// ---------------------------------------------------------------------------

test('enqueueWorkflowOutcomeTurn: appends ONE role:user outcome turn to the origin session', () => {
  enqueueWorkflowOutcomeTurn({ id: 'gapE-1', workflow: 'wf' as never, originSessionId: 'sessE1' }, 'My WF', 'done', 'the deliverable');
  const turns = new RunnerSessionStore().get('sessE1').turns;
  const mine = turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-1 '));
  assert.equal(mine.length, 1, 'exactly one outcome turn');
  assert.equal(mine[0].role, 'user');
  assert.match(mine[0].text, /completed]/);
  assert.match(mine[0].text, /the deliverable/);
});

test('enqueueWorkflowOutcomeTurn: idempotent — a second call (drain retry / restart) does not double-post', () => {
  enqueueWorkflowOutcomeTurn({ id: 'gapE-2', workflow: 'wf' as never, originSessionId: 'sessE2' }, 'My WF', 'done', 'r');
  enqueueWorkflowOutcomeTurn({ id: 'gapE-2', workflow: 'wf' as never, originSessionId: 'sessE2' }, 'My WF', 'done', 'r');
  const turns = new RunnerSessionStore().get('sessE2').turns;
  assert.equal(turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-2 ')).length, 1);
});

// shouldNotifyCancelledRun — backlog-spam guard (review must-fix #1)
const NOW = 1_780_000_000_000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

test('shouldNotifyCancelledRun: a RECENT, un-reported cancel → notify', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c1', finishedAt: isoAgo(60_000) }, NOW, new Set()), true);
});

test('shouldNotifyCancelledRun: a STALE cancel (older than 12h) → do NOT re-notify (the backlog-sweep bug)', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c2', finishedAt: isoAgo(6 * 24 * 60 * 60_000) }, NOW, new Set()), false);
  // falls back to createdAt when finishedAt is absent
  assert.equal(shouldNotifyCancelledRun({ id: 'c3', createdAt: isoAgo(13 * 60 * 60_000) }, NOW, new Set()), false);
});

test('shouldNotifyCancelledRun: an already-reported cancel → do NOT double-notify', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c4', finishedAt: isoAgo(60_000) }, NOW, new Set(['c4'])), false);
});

test('shouldNotifyCancelledRun: a recent cancel with an unparseable timestamp still notifies (fresh, not stale)', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c5' }, NOW, new Set()), true);
});

test('enqueueWorkflowOutcomeTurn: NO originSessionId → no-op (scheduled/cron stay notification-only)', () => {
  // Must not throw and must not create a turn anywhere addressable.
  assert.doesNotThrow(() => enqueueWorkflowOutcomeTurn({ id: 'gapE-3', workflow: 'wf' as never }, 'My WF', 'done', 'r'));
});

test('enqueueWorkflowOutcomeTurn: failed/blocked outcomes carry the right in-context guidance', () => {
  enqueueWorkflowOutcomeTurn({ id: 'gapE-4', workflow: 'wf' as never, originSessionId: 'sessE4' }, 'My WF', 'failed', 'boom');
  enqueueWorkflowOutcomeTurn({ id: 'gapE-5', workflow: 'wf' as never, originSessionId: 'sessE5' }, 'My WF', 'blocked', 'gap');
  const f = new RunnerSessionStore().get('sessE4').turns.find((t: { text?: string }) => t.text?.startsWith('[workflow run gapE-4 '));
  const b = new RunnerSessionStore().get('sessE5').turns.find((t: { text?: string }) => t.text?.startsWith('[workflow run gapE-5 '));
  assert.match(f!.text, /FAILED]/);
  assert.match(f!.text, /did NOT complete/i);
  assert.match(b!.text, /needs attention]/);
  assert.match(b!.text, /NEEDS ATTENTION/i);
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

// ---------------------------------------------------------------------------
// Feature B — bounded autonomous self-heal + re-run
// ---------------------------------------------------------------------------

const { writeWorkflow: writeWorkflowForHeal } = await import('../memory/workflow-store.js');
const { recordProposedFix } = await import('./workflow-diagnosis.js');

function editStepDiagnosis(stepId: string, autoApplicable = true, kind: 'edit_step' | 'reconnect_service' = 'edit_step') {
  return {
    summary: 'A step blocked.',
    rootCause: 'The step was too vague about how to reach Salesforce.',
    fix: {
      kind,
      stepId,
      description: 'Bind the step to the proven sf CLI.',
      newStepPrompt: kind === 'edit_step' ? `Query Salesforce. Use this exact, proven command: \`sf data query --json --query "SELECT Id FROM Account"\` via run_shell_command.` : null,
      service: kind === 'reconnect_service' ? 'Salesforce' : null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

function writeHealWorkflow(name: string, steps: Array<{ id: string; prompt: string; requiresApproval?: boolean }>): void {
  writeWorkflowForHeal(name, {
    name,
    description: 'Self-heal test workflow.',
    enabled: true,
    trigger: { manual: true },
    steps: steps.map((s) => ({ id: s.id, prompt: s.prompt, requiresApproval: s.requiresApproval })),
  });
}

function freshRunsFor(wf: string, origId: string): Array<Record<string, unknown>> {
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as Record<string, unknown>)
    .filter((r) => r.workflow === wf);
}

test('self-heal: below cap → applies the edit_step fix + re-queues a fresh run carrying attempt+1', () => {
  const wf = 'heal-below-cap';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-h' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));

  const out = workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-h', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }] as never,
    diagnosis: editStepDiagnosis('find') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.ok(out, 'heal fired');
  assert.equal(out!.attempt, 1);
  const fresh = freshRunsFor(wf, origId) as Array<{ workflow: string; selfHealAttempt?: number; originSessionId?: string }>;
  assert.equal(fresh.length, 1, 'one fresh re-run queued');
  assert.equal(fresh[0].selfHealAttempt, 1, 'carries the bumped attempt counter');
  assert.equal(fresh[0].originSessionId, 'sess-h', 'carries origin so the re-run re-enters chat');
});

test('self-heal: at the attempt cap → escalates (no auto re-run)', () => {
  const wf = 'heal-at-cap';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));
  const max = workflowRunnerInternalsForTest.selfHealAutoMaxAttempts();

  const out = workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: max },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'x' }] as never,
    diagnosis: editStepDiagnosis('find') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.equal(out, null, 'at cap → does not auto-heal');
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no fresh run queued at cap');
});

test('self-heal: a completed UPSTREAM mutating step blocks auto re-run (no double side-effects)', () => {
  const steps = [{ id: 'send', prompt: 'Send the emails.', requiresApproval: true }, { id: 'find', prompt: 'x' }];
  // send (mutating) already completed → guard trips.
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(steps as never, 'find', new Set(['send', 'find'])),
    true,
  );
  // the blocked step itself being requiresApproval does NOT trip the guard.
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(
      [{ id: 'find', prompt: 'x', requiresApproval: true }] as never, 'find', new Set(['find'])),
    false,
  );
});

test('self-heal: a non-edit_step (reconnect) fix is never auto-applied', () => {
  const wf = 'heal-reconnect';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'x' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find', false, 'reconnect_service'));
  const out = workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'x' }] as never,
    diagnosis: editStepDiagnosis('find', false, 'reconnect_service') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.equal(out, null, 'reconnect_service escalates, never auto-applies');
});

test('self-heal: a completed upstream IRREVERSIBLE-SEND step (unmarked) blocks auto re-run', () => {
  // Adversarial review B-1: requiresApproval alone is insufficient — an unmarked
  // "send the emails" step that completed must still block a fresh re-run.
  const steps = [{ id: 'send', prompt: 'Send the prospect emails to each contact.' }, { id: 'find', prompt: 'x' }];
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(steps as never, 'find', new Set(['send', 'find'])),
    true,
  );
  // A benign read upstream does NOT block.
  const reads = [{ id: 'read', prompt: 'Read the prospect list from the sheet.' }, { id: 'find', prompt: 'x' }];
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(reads as never, 'find', new Set(['read', 'find'])),
    false,
  );
});

// ── G8: transient classifier covers "fetch failed" + err.cause (no-fail retry) ──

test('G8: a bare "fetch failed" (undici) is now classified transient → retryable', () => {
  assert.equal(isTransientStepError(new Error('fetch failed')), true);
  assert.equal(isTransientStepError(new Error('workflow step "x" failed via harness: fetch failed')), true);
});

test('G8: a transient cause one level down is detected even when the top message is generic', () => {
  const e = new Error('request to https://api.example.com failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.equal(isTransientStepError(e), true);
});

test('G8: deterministic failures are NOT retried (real bugs fail fast, no loop)', () => {
  assert.equal(isTransientStepError(new Error('missing required input "url"')), false);
  assert.equal(isTransientStepError(new Error('TypeError: x is not a function')), false);
  assert.equal(isTransientStepError(new Error('failed its contract')), false);
  // a self-referential cause must not loop forever (bounded recursion)
  const loop = new Error('weird');
  (loop as { cause?: unknown }).cause = loop;
  assert.equal(isTransientStepError(loop), false);
});

// ── G5: scheduled enabled workflow auto-approves its declarative gate ──────────

test('G5: an unattended SCHEDULED run auto-approves the gate (no human at 8am → no deadlock)', async () => {
  const runId = 'g5-scheduled-gate';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    JSON.stringify({ id: runId, workflow: 'Daily Dash', status: 'running', source: 'schedule' }), 'utf-8');
  const ctx = {
    workflow: { name: 'Daily Dash', enabled: true, steps: [] }, workflowSlug: 'daily-dash',
    runId, inputs: {}, stepOutputs: {}, assistant: {} as never, completedItems: new Map(),
    forEachFailures: [], qualityAdvisories: [],
  } as never;
  const step = { id: 'deploy', prompt: 'deploy', requiresApproval: true, approvalPreview: 'Deploy' } as never;
  // Must NOT throw (no park) and must NOT register a pending human approval.
  await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step);
  const pending = approvalRegistry.listPending({ sessionId: `workflow-gate:${runId}:deploy`, status: 'pending' });
  assert.equal(pending.length, 0, 'auto-approved — no human approval registered for the unattended run');
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), { force: true });
});

test('G5: a MANUAL run still registers the gate (a person is present to approve)', async () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'g5-manual-gate';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    JSON.stringify({ id: runId, workflow: 'Daily Dash', status: 'running', source: 'manual', originSessionId: 'sess-x' }), 'utf-8');
  const ctx = {
    workflow: { name: 'Daily Dash', enabled: true, steps: [] }, workflowSlug: 'daily-dash2',
    runId, inputs: {}, stepOutputs: {}, assistant: {} as never, completedItems: new Map(),
    forEachFailures: [], qualityAdvisories: [],
  } as never;
  const step = { id: 'deploy', prompt: 'deploy', requiresApproval: true, approvalPreview: 'Deploy' } as never;
  let threw: Error | null = null;
  try { await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step); } catch (e) { threw = e as Error; }
  assert.ok(threw, 'manual run parks — registers the gate + throws to release the slot');
  const pending = approvalRegistry.listPending({ sessionId: `workflow-gate:${runId}:deploy`, status: 'pending' });
  assert.equal(pending.length, 1, 'manual run registers a human approval (unchanged)');
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

// ---------------------------------------------------------------------------
// Part B — creation-test verdict (did a read-only step actually return data?)
// ---------------------------------------------------------------------------

test('creationTestVerdict: real data → ok', () => {
  assert.equal(creationTestVerdict('scrape', { records: [{ id: 1 }] }).status, 'ok');
  assert.equal(creationTestVerdict('scrape', 'some real scraped text').status, 'ok');
  assert.equal(creationTestVerdict('scrape', [{ a: 1 }]).status, 'ok');
});

test('creationTestVerdict: empty results → empty (the scorpion failure — caught at creation)', () => {
  assert.equal(creationTestVerdict('scrape', null).status, 'empty');
  assert.equal(creationTestVerdict('scrape', '').status, 'empty');
  assert.equal(creationTestVerdict('scrape', '   ').status, 'empty');
  assert.equal(creationTestVerdict('scrape', []).status, 'empty');
  assert.equal(creationTestVerdict('scrape', {}).status, 'empty');
});

test('creationTestVerdict: a blocked/self-reported failure → failed (with reason)', () => {
  const blocked = creationTestVerdict('scrape', { blocked: true, reason: 'Apify actor not bound' });
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.detail ?? '', /Apify/);
});

test('creationTestVerdict: reuses the canonical detector — prose "blocked …" string + ok:false → failed', () => {
  // The Part A directive ("block with a reason if it can't return data") may
  // surface as a string OR an object; both must be caught, same as a real run.
  assert.equal(creationTestVerdict('scrape', 'blocked: the Apify actor returned no posts').status, 'failed');
  assert.equal(creationTestVerdict('scrape', { ok: false, note: 'no data' }).status, 'failed');
  // An empty object is "no data", not a healthy result.
  assert.equal(creationTestVerdict('scrape', {}).status, 'empty');
});

test('creationTestVerdict: NESTED failure envelope → failed (the live-smoke false-pass)', () => {
  // Exact shape the smoke caught: the step wrapped an error one level deep to
  // satisfy a contract key. Top-level looks fine; the failure is buried.
  const out = { records: { ok: false, error: 'Unable to retrieve tool with slug NONEXISTENT_SMOKE_TOOLKIT_XYZ' } };
  const v = creationTestVerdict('scrape', out);
  assert.equal(v.status, 'failed');
  assert.match(v.detail ?? '', /ok=false|Unable to retrieve/);
});

test('creationTestVerdict: empty dominant list (wrapped) → empty', () => {
  assert.equal(creationTestVerdict('scrape', { records: [] }).status, 'empty');
  assert.equal(creationTestVerdict('scrape', { data: { records: [] } }).status, 'empty');
  // A NON-empty wrapped list is real data → ok.
  assert.equal(creationTestVerdict('scrape', { data: { records: [{ id: 1 }] } }).status, 'ok');
});
