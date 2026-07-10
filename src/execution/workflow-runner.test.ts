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
process.env.CLEMENTINE_WORKFLOW_CONCURRENCY = '5';

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
  callToolSideEffectClass,
  runDeterministicWorkflowStepForTest,
  workflowRunnerInternalsForTest,
  explainDeterministicSpawnError,
  reapResolvedParkedRuns,
  executeStep,
  findContractViolationStep,
  tightenWorkflowContractsFromCleanRun,
  describeStepNonCompletion,
  processWorkflowRuns,
  workflowAdvisoryRequiresAttention,
  workflowReportLaneForOutcome,
  enqueueWorkflowOutcomeTurn,
  shouldNotifyCancelledRun,
  coerceOutputForContract,
  applyContractToPrompt,
  describeOutputShape,
  isTransientStepError,
  runWithStepRetry,
  creationTestVerdict,
  shouldHaltResumeForSideEffect,
  stepSideEffectClass,
  isPhantomStepCompletion,
  phantomBlockedOutput,
  decideBatchSettlement,
  ParkRunSignal,
  finalizeStepOutput,
  inferredOutputContractAdvisory,
  sendAlreadyClaimed,
  stepExternalWriteAlreadyClaimed,
  stepSendAlreadyFired,
  seedFailedItemRetryRun,
  detectEmptyDeliverableReads,
  stepConsumesOutput,
  summarizeRunArtifacts,
  looksLikeWorkflowStepStructuralResultMiss,
  WorkflowStepStructuralResultError,
  isWorkflowStepStructuralResultError,
} = await import('./workflow-runner.js');
// The workflow watcher would otherwise place a REAL judge call from any
// multi-step test run (live OAuth tokens make the judge reachable on dev
// machines). Silent-on-track stub = the byte-identical no-steer path.
const { _setWorkflowWatcherForTests } = await import('./workflow-runner.js');
_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));

// ─── Re-hunt Lane 4 regression (2026-07-09) ───────────────────────
// The RUNTIME call-node classifier must agree with the validator (both route
// through isIrreversibleSendSlug). The old regex called VAPI_CREATE_CALL /
// TWILIO_MAKE_OUTBOUND_CALL / RESPOND_TO_EVENT 'write'/'read', so the
// unattended-scheduled auto-approve carve-out fired them with no consent.
test('callToolSideEffectClass: telephony + comm-object dispatches are SEND (validator/runtime agree)', () => {
  for (const t of ['VAPI_CREATE_CALL', 'TWILIO_MAKE_OUTBOUND_CALL', 'ELEVENLABS_MAKE_OUTBOUND_CALL', 'make_outbound_call', 'GOOGLECALENDAR_RESPOND_TO_EVENT', 'GMAIL_SEND_EMAIL', 'DISCORD_CREATE_MESSAGE', 'outlook_send_draft', 'outlook_forward_mail']) {
    assert.equal(callToolSideEffectClass(t), 'send', `${t} must classify as send at runtime`);
  }
  // Reversible writes stay 'write'; call-reads stay 'read'; no over-gating.
  assert.equal(callToolSideEffectClass('GOOGLESHEETS_CREATE_SPREADSHEET'), 'write');
  assert.equal(callToolSideEffectClass('OUTLOOK_CREATE_DRAFT'), 'write');
  assert.equal(callToolSideEffectClass('VAPI_GET_CALL'), 'read');
  assert.equal(callToolSideEffectClass('TWILIO_LIST_CALLS'), 'read');
});
const { SessionStore: RunnerSessionStore } = await import('../memory/session-store.js');
const { readWorkflowEvents, appendWorkflowEvent, computeResumeState } = await import('./workflow-events.js');
const { clearStepWatermark, readSeenItemKeys } = await import('./workflow-watermark-store.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { resetEventLog, listEvents, appendEvent } = await import('../runtime/harness/eventlog.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { setClaudeAgentSdkWorkflowStepRunForTest } = await import('../runtime/harness/claude-agent-workflow-step.js');
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

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(over)) {
    prev[key] = process.env[key];
    if (over[key] === undefined) delete process.env[key];
    else process.env[key] = over[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(over)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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

test('pre-start missing-input workflow failure is recorded in Activity runs', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'prestart-missing-activity';
  const workflowName = 'Prestart Missing Activity';
  const runId = `prestart-missing-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Requires a URL before it can run.',
    enabled: true,
    trigger: { manual: true },
    inputs: { url: { description: 'Target URL' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}}' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  await processWorkflowRuns({} as never);

  const runFile = JSON.parse(readFileSync(filePath, 'utf-8')) as { status?: string; error?: string };
  assert.equal(runFile.status, 'error');
  assert.match(runFile.error ?? '', /Missing required workflow input: url/);
  const activityRun = runEvents.getRun(runId);
  assert.equal(activityRun?.status, 'failed');
  assert.match(activityRun?.error ?? '', /Missing required workflow input: url/);
  assert.equal(activityRun?.events.at(-1)?.type, 'failed');
});

test('fresh workflow run records a sanitized graph snapshot event', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'graph-snapshot-runner';
  const workflowName = 'Graph Snapshot Runner';
  const runId = `graph-snapshot-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Records the workflow graph shape when a run starts.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'pull',
        prompt: 'Pull the source records.',
        deterministic: { runner: 'emit.mjs' },
        sideEffect: 'read',
      },
      {
        id: 'summarize',
        prompt: 'Summarize the source records.',
        dependsOn: ['pull'],
        deterministic: { runner: 'emit.mjs' },
        sideEffect: 'read',
      },
    ],
  });
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'emit.mjs'),
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));',
    'utf-8',
  );

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  await processWorkflowRuns({} as never);

  const events = readWorkflowEvents(slug, runId);
  const graphEvent = events.find((event) => event.kind === 'workflow_graph_created');
  assert.ok(graphEvent, `expected workflow_graph_created, got ${events.map((event) => event.kind).join(', ')}`);
  const graph = graphEvent.meta?.graph as {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<{ source: string; target: string; type: string }>;
    entryNodeIds?: string[];
  } | undefined;
  assert.deepEqual(graph?.entryNodeIds, ['pull']);
  assert.deepEqual(graph?.nodes?.map((node) => node.id), ['pull', 'summarize']);
  assert.equal(graph?.nodes?.some((node) => Object.hasOwn(node, 'prompt')), false);
  assert.ok(graph?.edges?.some((edge) => edge.source === 'pull' && edge.target === 'summarize' && edge.type === 'dependency'));
});

test('fresh workflow run records ready batch metadata for parallel scheduler lanes', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'parallel-ready-runner';
  const workflowName = 'Parallel Ready Runner';
  const runId = `parallel-ready-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Records node readiness for parallel scheduler lanes.',
    enabled: true,
    trigger: { manual: true },
    steps: Array.from({ length: 6 }, (_, index) => ({
      id: `root_${index + 1}`,
      prompt: `Root ${index + 1}`,
      deterministic: { runner: 'emit.mjs' },
      sideEffect: 'read' as const,
    })),
  });
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'emit.mjs'),
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));',
    'utf-8',
  );

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  await processWorkflowRuns({} as never);

  const ready = readWorkflowEvents(slug, runId).filter((event) => event.kind === 'workflow_node_ready');
  const roundOne = ready.filter((event) => event.meta?.round === 1);
  assert.equal(roundOne.length, 6);
  assert.equal(roundOne.filter((event) => event.meta?.scheduled === true).length, 5);
  assert.equal(roundOne.filter((event) => event.meta?.deferredByConcurrency === true).length, 1);
  assert.equal(roundOne.every((event) => event.meta?.readyWidth === 6), true);
  assert.equal(roundOne.every((event) => event.meta?.concurrencyCap === 5), true);
  const deferredStep = roundOne.find((event) => event.meta?.deferredByConcurrency === true)?.stepId;
  assert.ok(deferredStep);
  assert.ok(ready.some((event) =>
    event.stepId === deferredStep
    && event.meta?.round === 2
    && event.meta?.scheduled === true
    && event.meta?.deferredByConcurrency === false,
  ));
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

test('reapResolvedParkedRuns is a no-op when WORKFLOW_APPROVAL_PARKING is off (kill-switch)', () => {
  // Parking now defaults ON (P1-7), so the kill-switch must be set EXPLICITLY to
  // get the legacy no-scan behavior (was: rely on the default).
  process.env.WORKFLOW_APPROVAL_PARKING = 'off';
  const filePath = writeParkedRun('park-test-off', ['apr-irrelevant']);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked'); // scan disabled → untouched
  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
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

test('inferredOutputContractAdvisory: accepts legacy prose with concrete URL evidence', () => {
  const note = inferredOutputContractAdvisory(
    { id: 'publish', prompt: 'Build and publish the website page URL.' } as never,
    'Published at https://example.com/landing',
  );
  assert.equal(note, null);
});

test('inferredOutputContractAdvisory: accepts legacy prose with an existing file path', () => {
  const filePath = path.join(tmp, 'legacy-report.md');
  writeFileSync(filePath, '# Report\n', 'utf-8');
  const note = inferredOutputContractAdvisory(
    { id: 'report', prompt: 'Create an HTML file and output the file path.' } as never,
    `Saved to ${filePath}.`,
  );
  assert.equal(note, null);
});

test('inferredOutputContractAdvisory: flags a legacy deliverable step with no list evidence', () => {
  const note = inferredOutputContractAdvisory(
    { id: 'leads', prompt: 'Generate a list of weekly leads.' } as never,
    'No leads found.',
  );
  assert.match(note ?? '', /non-empty list/);
  assert.match(note ?? '', /produced string/);
});

test('inferredOutputContractAdvisory: explicit output contracts own their own enforcement path', () => {
  const note = inferredOutputContractAdvisory(
    {
      id: 'leads',
      prompt: 'Generate a list of weekly leads.',
      output: { type: 'object', required_keys: ['items'], non_empty: ['items'] },
    } as never,
    { items: [] },
  );
  assert.equal(note, null);
});

test('workflowAdvisoryRequiresAttention: confident quality misses are not clean success', () => {
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'target_missed' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'foreach_overflow' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'skill_not_executed' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'idempotent_skip' }), true);
  // Move 3: a Claude-lane figure that contradicts the run's own tool results is
  // the trust-killer — it must surface for review, never pass as clean success.
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'ungrounded_output' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'inferred_output_contract' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'goal_validation_unavailable' }), false);
  // T1.2: a degraded synthesis rollup is a presentation loss, not a failed run —
  // every step already completed and verified.
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'synthesis_degraded' }), false);
});

test('workflowReportLaneForOutcome: non-review advisories stay on done lane', () => {
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: false,
    advisories: [{ kind: 'goal_validation_unavailable' }],
  }), 'done');
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: false,
    advisories: [{ kind: 'skill_not_executed' }],
  }), 'blocked');
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: true,
    advisories: [{ kind: 'goal_validation_unavailable' }],
  }), 'blocked');
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

test('renderWorkflowOriginLineageBlock includes harness transcript/action ledger and ignores legacy ghosts', () => {
  resetEventLog();
  const sid = 'workflow-origin-lineage';
  HarnessSession.create({ id: sid, kind: 'chat', channel: 'desktop', title: 'Origin chat' });
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use the approved Denver list only.' } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Sent Casey once and saved the follow-up brief.' } });
  new RunnerSessionStore().appendTurn(sid, {
    role: 'user',
    text: '[workflow run wf-ghost completed] synthetic ghost only',
    createdAt: new Date().toISOString(),
  });

  const out = workflowRunnerInternalsForTest.renderWorkflowOriginLineageBlock(sid);

  assert.match(out, /ORIGIN SESSION LINEAGE/);
  assert.match(out, /USER: Use the approved Denver list only/);
  assert.match(out, /YOU: Sent Casey once/);
  assert.match(out, /ALREADY DONE/);
  assert.match(out, /OUTLOOK_SEND_EMAIL/);
  assert.match(out, /casey@example\.com/);
  assert.doesNotMatch(out, /wf-ghost/);
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

test('looksLikeWorkflowStepStructuralResultMiss: catches no-live-tool and result-channel prose', () => {
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      'This execution context has no live tool access, so I cannot call workflow_step_result for this step.',
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      "I can't continue the workflow step from that interrupted tool state here. Please rerun the step so I can call workflow_step_result.",
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      "I can't complete this step because workflow_step_result is not exposed in this text-only subprocess.",
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss({ blocked: true, reason: 'source returned no rows' }),
    false,
    'honest structured blockers must flow through as step data, not a harness structural miss',
  );
  assert.equal(looksLikeWorkflowStepStructuralResultMiss('{"accounts":[]}'), false);
});

test('runWithStepRetry: workflow structural result miss is retryable when opted in', async () => {
  let attempts = 0;
  const retryReasons: string[] = [];
  const out = await runWithStepRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkflowStepStructuralResultError(
          'find_or_create_tracker',
          'This execution context has no live tool access, so I cannot call workflow_step_result.',
        );
      }
      return { ok: true };
    },
    {
      budget: 1,
      backoffBaseMs: 1,
      isRetryable: isWorkflowStepStructuralResultError,
      onRetry: ({ err }) => retryReasons.push(isWorkflowStepStructuralResultError(err) ? 'structural_result' : 'other'),
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(out, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(retryReasons, ['structural_result']);
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

test('enqueueWorkflowOutcomeTurn: duplicate observer origins each receive one report-back', () => {
  const run = {
    id: 'gapE-multi',
    workflow: 'wf' as never,
    originSessionId: 'sessE-multi-a',
    originSessionIds: ['sessE-multi-a', 'sessE-multi-b', 'sessE-multi-b'],
  };

  enqueueWorkflowOutcomeTurn(run, 'My WF', 'done', 'the deliverable');
  enqueueWorkflowOutcomeTurn(run, 'My WF', 'done', 'the deliverable');

  for (const sessionId of ['sessE-multi-a', 'sessE-multi-b']) {
    const turns = new RunnerSessionStore().get(sessionId).turns;
    const mine = turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-multi '));
    assert.equal(mine.length, 1, `${sessionId} gets exactly one report-back`);
    assert.match(mine[0].text, /the deliverable/);
  }
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

test('renderStepContextBlock offloads large upstream values to the run workspace with a read_file path', () => {
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `A${i}`,
    domain: `domain-${i}.example.com`,
    notes: `context payload ${i} ${'x'.repeat(70)}`,
  }));
  const lastNeedle = 'domain-259.example.com';
  const largeOutput = { rows, count: rows.length };
  assert.ok(JSON.stringify(largeOutput).length > 8000, 'fixture must exceed inline context clip threshold');

  const bound = workflowRunnerInternalsForTest.bindStepContext(
    { id: 'select', prompt: 'Select the best accounts.', dependsOn: ['fetch_accounts'] },
    {
      inputs: {},
      stepOutputs: { fetch_accounts: largeOutput },
      workflowSlug: 'context-offload-workflow',
      runId: 'run-context-offload',
    } as never,
  );

  assert.ok(bound);
  const rendered = workflowRunnerInternalsForTest.renderStepContextBlock(bound, {
    workflowName: 'context-offload-workflow',
    runId: 'run-context-offload',
    nowIso: '2026-07-09T00:00:00.000Z',
  });

  assert.match(rendered, /__clementine_context_ref/);
  assert.match(rendered, /workspace_artifact_query/);
  assert.match(rendered, /read_file/);
  assert.doesNotMatch(rendered, new RegExp(lastNeedle), 'large tail data should live in the artifact, not the prompt');

  const pathMatch = rendered.match(/"path": "([^"]+)"/);
  assert.ok(pathMatch?.[1], 'offloaded context must include an absolute artifact path');
  const artifact = readFileSync(pathMatch[1], 'utf-8');
  assert.match(artifact, new RegExp(lastNeedle), 'artifact carries the exact full upstream payload');
});

test('final synthesis and goal evidence render large completed outputs as queryable step artifacts', () => {
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `A${i}`,
    domain: `domain-${i}.example.com`,
    notes: `synthesis payload ${i} ${'x'.repeat(70)}`,
  }));
  const lastNeedle = 'domain-259.example.com';
  const largeOutput = { rows, count: rows.length };
  const workflowName = 'synthesis-artifact-workflow';
  const runId = 'run-synthesis-artifact';
  finalizeStepOutput(
    workflowName,
    runId,
    { id: 'fetch_accounts', prompt: 'Fetch accounts.' } as never,
    largeOutput,
  );

  const opts = { workflowName, runId, nowIso: '2026-07-09T00:00:00.000Z' };
  const rendered = workflowRunnerInternalsForTest.formatStepOutputs(
    [{ id: 'fetch_accounts', prompt: 'Fetch accounts.' }] as never,
    { fetch_accounts: largeOutput },
    opts,
  );

  assert.match(rendered, /__clementine_context_ref/);
  assert.match(rendered, /workspace_artifact_query/);
  assert.match(rendered, /artifacts\/step-fetch_accounts\.json/);
  assert.doesNotMatch(rendered, new RegExp(lastNeedle), 'large tail data should stay in the artifact during synthesis');

  const pathMatch = rendered.match(/"path": "([^"]+)"/);
  assert.ok(pathMatch?.[1], 'synthesis handoff must include an absolute artifact path');
  const artifact = readFileSync(pathMatch[1], 'utf-8');
  assert.match(artifact, new RegExp(lastNeedle), 'artifact carries the exact full completed step output');

  const evidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Final summary.', { fetch_accounts: largeOutput }, opts);
  assert.match(evidence, /workspace_artifact_query/);
  assert.match(evidence, /Artifact:/);
  assert.match(evidence, /Preview:/);
  assert.doesNotMatch(evidence, new RegExp(lastNeedle), 'goal evidence stays bounded and points to the artifact');
});

test('workflow step model route uses the intent-bound worker model and trace metadata', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth',
    MODEL_ROUTING_MODE: undefined,
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_WORKER_INTENT_ROUTING: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, () => {
    const route = workflowRunnerInternalsForTest.resolveWorkflowStepModel({
      id: 'design',
      prompt: 'Design the hero.',
      intent: 'design',
    });
    assert.equal(route.model, 'minimax-01');
    assert.deepEqual(route.trace, {
      seam: 'workflow',
      stepId: 'design',
      attemptedIntent: 'design',
      matchedIntent: 'design',
      modelId: 'minimax-01',
      provider: 'byo',
      source: 'chat-rule',
    });
  });
});

test('workflow step explicit model wins over intent routing', () => {
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, () => {
    const route = workflowRunnerInternalsForTest.resolveWorkflowStepModel({
      id: 'design',
      prompt: 'Design the hero.',
      intent: 'design',
      model: 'gpt-5.5',
    });
    assert.equal(route.model, 'gpt-5.5');
    assert.equal(route.trace, undefined);
  });
});

test('workflow Claude-routed read-only step uses Claude Agent SDK and returns structured output', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'auth.json'),
    JSON.stringify({ codexOauth: { accessToken: 'codex-workflow-test-token', refreshToken: 'refresh' } }),
    'utf-8',
  );
  writeFileSync(
    path.join(stateDir, 'claude-auth.json'),
    JSON.stringify({
      accessToken: 'sk-ant-oat01-workflow-step-test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
    'utf-8',
  );

  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
    CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
  };
  let captured: any;
  try {
    process.env.AUTH_MODE = 'codex_oauth';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
    delete process.env.WORKFLOW_USE_HARNESS;
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'worker', modelId: 'claude-sonnet-4-6', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]);
    setClaudeAgentSdkWorkflowStepRunForTest(async (options) => {
      captured = options;
      return {
        text: '{"status":"completed","output":{"report":"CLAUDE_WORKFLOW_STEP_OK"}}',
        structuredOutput: { status: 'completed', output: { report: 'CLAUDE_WORKFLOW_STEP_OK' } },
        sessionId: 'sdk-workflow-step-session',
        model: 'claude-sonnet-4-6',
        toolUses: ['mcp__clementine-local__skill_read'],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    });

    const step = {
      id: 'design_report',
      prompt: 'Design the report section using the installed test-skill.',
      intent: 'design',
      usesSkill: 'test-skill',
      sideEffect: 'read' as const,
      output: { type: 'object' as const, required_keys: ['report'], non_empty: ['report'] },
    };
    const ctx = {
      workflow: { name: 'Claude Workflow Step Smoke', description: 'test', enabled: true, steps: [step], trigger: { manual: true } },
      workflowSlug: 'claude-workflow-step-smoke',
      runId: 'wf-sdk-1',
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('legacy assistant should not be called'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];

    const output = await executeStep(step, ctx);
    assert.deepEqual(output, { report: 'CLAUDE_WORKFLOW_STEP_OK' });
    assert.equal(captured.modelId, 'claude-sonnet-4-6');
    assert.ok(captured.prompt.includes('Test Skill Instructions'));
    assert.ok(captured.allowedLocalMcpTools.includes('skill_read'));
    assert.deepEqual(captured.outputSchema.required, ['status', 'output']);

    const routed = listEvents('workflow:wf-sdk-1:design_report', { types: ['worker_model_routed'] });
    assert.equal(routed.length, 1);
    const data = routed[0].data as Record<string, unknown>;
    assert.equal(data.seam, 'workflow');
    assert.equal(data.modelId, 'claude-sonnet-4-6');
    assert.equal(data.transport, 'claude_agent_sdk_workflow_step');
    assert.deepEqual(data.toolUses, ['mcp__clementine-local__skill_read']);
    assert.deepEqual(data.modelRoute, {
      routeKind: 'claude_agent_sdk_workflow_step',
      requestedModel: 'claude-sonnet-4-6',
      effectiveModel: 'claude-sonnet-4-6',
      provider: 'claude',
      transport: 'claude_agent_sdk_workflow_step',
    });
    assert.equal(
      HarnessSession.load('workflow:wf-sdk-1:design_report')?.sessionRow.status,
      'completed',
      'Claude SDK workflow-step lane closes the harness step session',
    );
    const completed = readWorkflowEvents('claude-workflow-step-smoke', 'wf-sdk-1')
      .filter((event) => event.kind === 'step_completed' && event.stepId === 'design_report');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].meta?.modelRoute, data.modelRoute);
  } finally {
    setClaudeAgentSdkWorkflowStepRunForTest(null);
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('workflow Claude-routed step marks its harness session failed when the SDK throws', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'auth.json'),
    JSON.stringify({ codexOauth: { accessToken: 'codex-workflow-test-token', refreshToken: 'refresh' } }),
    'utf-8',
  );
  writeFileSync(
    path.join(stateDir, 'claude-auth.json'),
    JSON.stringify({
      accessToken: 'sk-ant-oat01-workflow-step-test-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
    'utf-8',
  );

  const prev: Record<string, string | undefined> = {
    AUTH_MODE: process.env.AUTH_MODE,
    CLEMMY_MODEL_ROLES_REGISTRY: process.env.CLEMMY_MODEL_ROLES_REGISTRY,
    CLEMMY_WORKER_INTENT_ROUTING: process.env.CLEMMY_WORKER_INTENT_ROUTING,
    CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP,
    CLEMMY_MODEL_ROLES: process.env.CLEMMY_MODEL_ROLES,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
  };
  try {
    process.env.AUTH_MODE = 'codex_oauth';
    process.env.CLEMMY_MODEL_ROLES_REGISTRY = 'on';
    process.env.CLEMMY_WORKER_INTENT_ROUTING = 'on';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'on';
    delete process.env.WORKFLOW_USE_HARNESS;
    process.env.CLEMMY_MODEL_ROLES = JSON.stringify([
      { role: 'worker', modelId: 'claude-sonnet-4-6', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]);
    setClaudeAgentSdkWorkflowStepRunForTest(async () => {
      throw new Error('permanent sdk failure');
    });

    const step = {
      id: 'design_fail',
      prompt: 'Design the report section.',
      intent: 'design',
      sideEffect: 'read' as const,
    };
    const ctx = {
      workflow: { name: 'Claude Workflow Step Failure', description: 'test', enabled: true, steps: [step], trigger: { manual: true } },
      workflowSlug: 'claude-workflow-step-failure',
      runId: 'wf-sdk-fail',
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('legacy assistant should not be called'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];

    await assert.rejects(() => executeStep(step, ctx), /permanent sdk failure/);
    assert.equal(
      HarnessSession.load('workflow:wf-sdk-fail:design_fail')?.sessionRow.status,
      'failed',
      'thrown SDK workflow step closes the harness step session as failed',
    );
  } finally {
    setClaudeAgentSdkWorkflowStepRunForTest(null);
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test('deterministic workflow step now runs a .ts runner via the shared tsx interpreter', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-ts-test', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'echo.ts'),
    [
      'let input = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk: string) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input) as { stepId: string; inputs: { account: string } };',
      '  process.stdout.write(JSON.stringify({ stepId: payload.stepId, account: payload.inputs.account }));',
      '});',
    ].join('\n'),
    'utf-8',
  );

  const output = await runDeterministicWorkflowStepForTest('echo.ts', {
    workflow: 'Det TS Test',
    workflowSlug: 'det-ts-test',
    runId: 'run-ts',
    stepId: 'script',
    inputs: { account: 'Acme' },
    stepOutputs: {},
  });

  assert.deepEqual(output, { stepId: 'script', account: 'Acme' });
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

test('forEach batches an oversized fan-out and still attempts every item', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const ctx = {
      workflow: { name: 'Choke Test', steps: [] },
      workflowSlug: 'foreach-cap-test',
      runId: 'fc-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull' } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    const overflow = qualityAdvisories.find((a) => a.kind === 'foreach_overflow');
    assert.equal(overflow, undefined, 'batching is not a terminal overflow advisory when every item is attempted');
    assert.deepEqual(output.map((item) => item.itemKey), ['a', 'b', 'c', 'd', 'e']);
    const started = readWorkflowEvents('foreach-cap-test', 'fc-1').filter((e) => e.kind === 'item_started');
    assert.equal(started.length, 5, 'all pending items are attempted in bounded windows');
    const batched = readWorkflowEvents('foreach-cap-test', 'fc-1')
      .find((e) => e.kind === 'step_advisory' && e.meta?.reason === 'foreach_batched');
    assert.equal(batched?.meta?.batchSize, 2);
    assert.equal(batched?.meta?.batches, 3);
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEach resolves {{steps.x.output.path}} sources at runtime', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const ctx = {
      workflow: { name: 'Path ForEach Test', steps: [] },
      workflowSlug: 'foreach-path-test',
      runId: 'fp-1',
      inputs: {},
      stepOutputs: { pull: { created_records: [{ id: 'r1' }, { id: 'r2' }] } },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = {
      id: 'enrich',
      prompt: 'Process {{item.id}}.',
      forEach: '{{steps.pull.output.created_records}}',
    } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    assert.deepEqual(output.map((item) => item.itemKey), ['r1', 'r2']);
    const started = readWorkflowEvents('foreach-path-test', 'fp-1').filter((e) => e.kind === 'item_started');
    assert.deepEqual(started.map((e) => e.itemKey), ['r1', 'r2']);
  } finally {
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEachNewOnly watermarks completed items and retries failed items on the next run', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const workflowSlug = 'foreach-watermark-test';
  const stepId = 'blast';
  clearStepWatermark(workflowSlug, stepId);
  try {
    let failB = true;
    const respond = async (req: { message?: string }) => {
      const message = String(req.message ?? '');
      if (failB && message.includes('Item: b')) throw new Error('temporary b failure');
      const item = message.match(/Item: ([^\n]+)/)?.[1] ?? 'unknown';
      return { text: `done-${item}` };
    };
    const mkCtx = (runId: string) => ({
      workflow: { name: 'New Only Fanout Test', steps: [] },
      workflowSlug,
      runId,
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c'] },
      assistant: { respond },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1]);
    const step = {
      id: stepId,
      prompt: 'Process the item.',
      forEach: 'pull',
      forEachNewOnly: true,
      useHarness: false,
    } as unknown as Parameters<typeof executeStep>[0];

    const first = await executeStep(step, mkCtx('fw-1')) as Array<{ itemKey: string; output: unknown }>;
    assert.deepEqual(first.map((item) => item.itemKey), ['a', 'c'], 'failed item is absent from completed aggregate');
    assert.deepEqual([...readSeenItemKeys(workflowSlug, stepId)].sort(), ['a', 'c'], 'only completed items advance the watermark');

    failB = false;
    const second = await executeStep(step, mkCtx('fw-2')) as Array<{ itemKey: string; output: unknown }>;
    assert.deepEqual(second.map((item) => item.itemKey), ['b'], 'next run processes only the previously failed item');
    assert.deepEqual(
      readWorkflowEvents(workflowSlug, 'fw-2').filter((e) => e.kind === 'item_started').map((e) => e.itemKey),
      ['b'],
      'watermarked items are not started again',
    );
    assert.deepEqual([...readSeenItemKeys(workflowSlug, stepId)].sort(), ['a', 'b', 'c']);
  } finally {
    clearStepWatermark(workflowSlug, stepId);
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEach batching resumes after already-completed items and drains remaining pending items', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const completedItems = new Map<string, unknown>([
      ['a', 'done-a'],
      ['b', 'done-b'],
    ]);
    const ctx = {
      workflow: { name: 'Choke Resume Test', steps: [] },
      workflowSlug: 'foreach-cap-resume-test',
      runId: 'fc-resume-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems,
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull', useHarness: false } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    const overflow = qualityAdvisories.find((a) => a.kind === 'foreach_overflow');
    assert.equal(overflow, undefined, 'resume batching does not turn fully attempted work into an overflow');
    assert.deepEqual(output.map((item) => item.itemKey), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(output.slice(0, 2).map((item) => item.output), ['done-a', 'done-b']);
    const started = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .filter((e) => e.kind === 'item_started')
      .map((e) => e.itemKey);
    assert.deepEqual(started, ['c', 'd', 'e'], 'resume processes only pending items, across all windows');
    const batched = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .find((e) => e.kind === 'step_advisory' && e.meta?.reason === 'foreach_batched');
    assert.equal(batched?.meta?.batchSize, 2);
    assert.equal(batched?.meta?.batches, 2);
    const completed = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .findLast((e) => e.kind === 'step_completed');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.completed, 5, 'step metadata counts resumed + newly processed items');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.resumed, 2);
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.processed, 3);
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEach batching attributes item failures to their original keys across windows', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
    const ctx = {
      workflow: { name: 'Choke Failure Attribution Test', steps: [] },
      workflowSlug: 'foreach-batch-failure-test',
      runId: 'fc-fail-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: {
        respond: async (req: { message?: string }) => {
          if (/\bItem:\s*d\b/.test(req.message ?? '')) throw new Error('downstream d failed');
          return { text: 'done' };
        },
      },
      completedItems: new Map(),
      forEachFailures,
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull', useHarness: false } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    assert.deepEqual(output.map((item) => item.itemKey), ['a', 'b', 'c', 'e']);
    assert.deepEqual(forEachFailures.map((f) => f.itemKey), ['d'], 'run-level failure summary names the failed item');
    assert.match(forEachFailures[0]?.error ?? '', /downstream d failed/);
    const itemFailed = readWorkflowEvents('foreach-batch-failure-test', 'fc-fail-1')
      .find((e) => e.kind === 'item_failed');
    assert.equal(itemFailed?.itemKey, 'd');
    const completed = readWorkflowEvents('foreach-batch-failure-test', 'fc-fail-1')
      .findLast((e) => e.kind === 'step_completed');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.failed, 1);
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('W1b: a forEach item that fails TRANSIENTLY retries and succeeds BY DEFAULT (flag unset)', async () => {
  const prevH = process.env.WORKFLOW_USE_HARNESS;
  const prevB = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevL = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  const prevR = process.env.CLEMMY_FOREACH_ITEM_RETRY;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  delete process.env.CLEMMY_FOREACH_ITEM_RETRY; // default-ON: retry is the shipped behavior
  try {
    const attempts: Record<string, number> = {};
    const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
    const ctx = {
      workflow: { name: 'W1b Item Retry Test', steps: [] },
      workflowSlug: 'w1b-item-retry',
      runId: 'w1b-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'd'] },
      assistant: {
        respond: async (req: { message?: string }) => {
          const k = (req.message ?? '').match(/\bItem:\s*(\w+)\b/)?.[1] ?? '?';
          attempts[k] = (attempts[k] ?? 0) + 1;
          // item 'd' hits a transient 503 on its FIRST attempt, recovers on retry.
          if (k === 'd' && attempts[k] === 1) throw new Error('upstream 503 service unavailable');
          return { text: 'done' };
        },
      },
      completedItems: new Map(),
      forEachFailures,
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull', useHarness: false } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string }>;

    assert.deepEqual(output.map((i) => i.itemKey).sort(), ['a', 'd'], 'the transient item recovered on retry');
    assert.equal(forEachFailures.length, 0, 'no item failure after a successful retry');
    assert.equal(attempts.d, 2, 'item d ran twice — fail then retry-success');
    const retried = readWorkflowEvents('w1b-item-retry', 'w1b-1').find((e) => e.kind === 'item_retry');
    assert.equal(retried?.itemKey, 'd', 'an item_retry advisory was recorded');
  } finally {
    restoreEnv('WORKFLOW_USE_HARNESS', prevH);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevB);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevL);
    restoreEnv('CLEMMY_FOREACH_ITEM_RETRY', prevR);
  }
});

test('W1b: CLEMMY_FOREACH_ITEM_RETRY=off is the kill-switch — a transient item failure is NOT retried', async () => {
  const prevH = process.env.WORKFLOW_USE_HARNESS;
  const prevB = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevL = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  const prevR = process.env.CLEMMY_FOREACH_ITEM_RETRY;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  process.env.CLEMMY_FOREACH_ITEM_RETRY = 'off'; // explicit kill-switch
  try {
    const attempts: Record<string, number> = {};
    const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
    const ctx = {
      workflow: { name: 'W1b Flag Off Test', steps: [] },
      workflowSlug: 'w1b-flagoff',
      runId: 'w1b-off-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'd'] },
      assistant: {
        respond: async (req: { message?: string }) => {
          const k = (req.message ?? '').match(/\bItem:\s*(\w+)\b/)?.[1] ?? '?';
          attempts[k] = (attempts[k] ?? 0) + 1;
          if (k === 'd') throw new Error('upstream 503 service unavailable');
          return { text: 'done' };
        },
      },
      completedItems: new Map(),
      forEachFailures,
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull', useHarness: false } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string }>;

    assert.deepEqual(output.map((i) => i.itemKey), ['a'], 'flag off → failed item is dropped, not retried');
    assert.deepEqual(forEachFailures.map((f) => f.itemKey), ['d']);
    assert.equal(attempts.d, 1, 'item d ran exactly once (no retry when flag off)');
    assert.equal(readWorkflowEvents('w1b-flagoff', 'w1b-off-1').some((e) => e.kind === 'item_retry'), false, 'no item_retry when flag off');
  } finally {
    restoreEnv('WORKFLOW_USE_HARNESS', prevH);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevB);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevL);
    restoreEnv('CLEMMY_FOREACH_ITEM_RETRY', prevR);
  }
});

test('failed-item retry seeding inherits upstream + completed items but not stale downstream outputs', () => {
  const workflow = {
    name: 'Retry Seed Test',
    steps: [
      { id: 'pull', prompt: 'Pull records.' },
      { id: 'blast', prompt: 'Process one record.', forEach: 'pull', dependsOn: ['pull'] },
      { id: 'summarize', prompt: 'Summarize all processed records.', dependsOn: ['blast'] },
    ],
  } as never;
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'step_completed', stepId: 'pull', output: ['a', 'b', 'c'] });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_completed', stepId: 'blast', itemKey: 'a', output: 'done-a' });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_completed', stepId: 'blast', itemKey: 'c', output: 'done-c' });
  appendWorkflowEvent('retry-seed-test', 'source-run', {
    kind: 'step_completed',
    stepId: 'blast',
    output: [
      { itemKey: 'a', output: 'done-a' },
      { itemKey: 'c', output: 'done-c' },
    ],
  });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'step_completed', stepId: 'summarize', output: 'old summary missing b' });

  const seeded = seedFailedItemRetryRun(workflow, 'retry-seed-test', 'retry-run', {
    fromRunId: 'source-run',
    stepId: 'blast',
    itemKeys: ['b'],
  });

  assert.deepEqual(seeded, { inheritedSteps: 1, inheritedItems: 2, sentSkips: 0 });
  const state = computeResumeState('retry-seed-test', 'retry-run');
  assert.equal(state.completedSteps.get('pull')?.toString(), 'a,b,c');
  assert.equal(state.completedSteps.has('blast'), false, 'retry step reruns with failed item pending');
  assert.equal(state.completedSteps.has('summarize'), false, 'downstream summary must recompute after retry');
  assert.deepEqual(Array.from(state.completedItems.get('blast')?.keys() ?? []), ['a', 'c']);
  const seededEvent = readWorkflowEvents('retry-seed-test', 'retry-run')
    .find((ev) => ev.kind === 'step_advisory' && ev.meta?.reason === 'failed_item_retry_seeded');
  assert.equal(seededEvent?.meta?.inheritedSteps, 1);
  assert.equal(seededEvent?.meta?.inheritedItems, 2);
});

test('workflow conversion: a plain step routes through the GATED harness loop when CLEMMY_HARNESS_WORKFLOW=on (not the legacy core)', async () => {
  // Proves the staged workflow-step conversion (respondPreferHarness on the
  // default-off `workflow` surface) actually rides the harness when flipped on,
  // and the legacy core is NOT used. Combined with the architect/home behavioral
  // smoke (respondPreferHarness returns valid step text) + the unchanged chaining
  // (renderTemplate/stepOutputs), this closes the workflow-conversion validation.
  const prev = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevWUH = process.env.WORKFLOW_USE_HARNESS;
  process.env.CLEMMY_HARNESS_WORKFLOW = 'on';
  // Force the legacy/fallback branch (where this conversion lives): the PRIMARY
  // path already rides the harness via runStepViaHarness when WORKFLOW_USE_HARNESS
  // is on. This conversion gates the fallback through the bridge instead.
  process.env.WORKFLOW_USE_HARNESS = 'off';
  const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed',
      lastDecision: { reply: 'HARNESS-STEP-OUTPUT', nextAction: 'completed' },
    })) as never,
  });
  try {
    let legacyCalled = false;
    const ctx = {
      workflow: { name: 'WF Harness Route', steps: [] },
      workflowSlug: 'wf-harness-route', runId: 'wf-hr-1', inputs: {}, stepOutputs: {},
      assistant: { respond: async () => { legacyCalled = true; return { text: 'LEGACY-OUTPUT', sessionId: 'x' }; } },
      completedItems: new Map(), forEachFailures: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'route', prompt: 'produce output' } as unknown as Parameters<typeof executeStep>[0];
    const out = await executeStep(step, ctx);
    assert.equal(out, 'HARNESS-STEP-OUTPUT', 'step output came from the gated harness loop');
    assert.equal(legacyCalled, false, 'legacy ungated core NOT used when the flag is on');
  } finally {
    _setBridgeImplsForTests({});
    if (prev === undefined) delete process.env.CLEMMY_HARNESS_WORKFLOW; else process.env.CLEMMY_HARNESS_WORKFLOW = prev;
    if (prevWUH === undefined) delete process.env.WORKFLOW_USE_HARNESS; else process.env.WORKFLOW_USE_HARNESS = prevWUH;
  }
});

test('executeStep: legacy plain deliverable step records inferred output-contract advisory', async () => {
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const ctx = {
      workflow: { name: 'Legacy Deliverable Advisory', steps: [] },
      workflowSlug: 'legacy-deliverable-advisory',
      runId: 'legacy-deliverable-1',
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => ({ text: 'No leads found.' }) },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = {
      id: 'lead_list',
      prompt: 'Generate a list of weekly leads.',
      useHarness: false,
    } as unknown as Parameters<typeof executeStep>[0];

    const out = await executeStep(step, ctx);
    assert.equal(out, 'No leads found.');
    const advisory = qualityAdvisories.find((a) => a.kind === 'inferred_output_contract');
    assert.match(advisory?.note ?? '', /non-empty list/);
    const event = readWorkflowEvents('legacy-deliverable-advisory', 'legacy-deliverable-1')
      .find((ev) => ev.kind === 'step_advisory' && ev.meta?.reason === 'inferred_output_contract');
    assert.equal(event?.stepId, 'lead_list');
  } finally {
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
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

test('P1-9 finalizeStepOutput: empty-only violation → "produced no usable data" + empty_output reason (skips the Doctor)', () => {
  // The SF→Airtable shape: required_keys are present, but the list is empty.
  const step = {
    id: 'pull',
    prompt: 'x',
    output: { required_keys: ['prospects'], non_empty: ['prospects'] },
  } as never;
  assert.throws(
    () => finalizeStepOutput('empty-route-test', 'er-1', step, { prospects: [], note: 'Blocked: SF expired' }),
    /produced no usable data/,
  );
  const failed = readWorkflowEvents('empty-route-test', 'er-1').find((e) => e.kind === 'step_failed');
  assert.equal((failed as { meta?: { reason?: string } })?.meta?.reason, 'empty_output');
  // empty_output is a DATA problem → NOT routed to the Doctor.
  assert.equal(findContractViolationStep(readWorkflowEvents('empty-route-test', 'er-1')), null);
});

test('P1-9 finalizeStepOutput: a shape violation alongside an empty one stays output_contract (routes to Doctor)', () => {
  const step = {
    id: 'pull',
    prompt: 'x',
    output: { required_keys: ['prospects', 'summary'], non_empty: ['prospects'] },
  } as never;
  // Missing `summary` (shape) + empty `prospects` (emptiness) → mixed → contract.
  assert.throws(
    () => finalizeStepOutput('empty-route-test', 'er-2', step, { prospects: [] }),
    /failed its contract/,
  );
  const failed = readWorkflowEvents('empty-route-test', 'er-2').find((e) => e.kind === 'step_failed');
  assert.equal((failed as { meta?: { reason?: string } })?.meta?.reason, 'output_contract');
  assert.equal(findContractViolationStep(readWorkflowEvents('empty-route-test', 'er-2'))?.stepId, 'pull');
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

// ---- Wave 2.1: substance gap — empty read feeding downstream is a MISS ----

test('stepConsumesOutput: dependsOn, forEach, and {{steps.x.output}} all count as consuming', () => {
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', dependsOn: ['a'] } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', forEach: 'a' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', forEach: '{{steps.a.output.items}}' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'use {{steps.a.output}} now' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'unrelated' } as any, 'a'), false);
  // a different step id that is a prefix must NOT match (steps.a vs steps.account)
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'use {{steps.account.output}}' } as any, 'a'), false);
});

test('detectEmptyDeliverableReads: an empty read feeding a forEach is flagged', () => {
  const steps = [
    { id: 'find_prospects', prompt: 'query CRM for prospects' },
    { id: 'email_each', prompt: 'email them', forEach: 'find_prospects' },
  ] as any;
  const hits = detectEmptyDeliverableReads(steps, { find_prospects: [], email_each: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].stepId, 'find_prospects');
  assert.equal(hits[0].consumerId, 'email_each');
});

test('detectEmptyDeliverableReads: a NON-empty read is not flagged', () => {
  const steps = [
    { id: 'find', prompt: 'query' },
    { id: 'use', prompt: 'use {{steps.find.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { find: [{ id: 1 }], use: 'ok' }).length, 0);
});

test('detectEmptyDeliverableReads: a TERMINAL empty read (no consumer) is not flagged (legit "nothing found")', () => {
  const steps = [{ id: 'find_overdue', prompt: 'find overdue invoices' }] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { find_overdue: [] }).length, 0);
});

test('detectEmptyDeliverableReads: an empty WRITE/SEND step is not flagged (only reads)', () => {
  const steps = [
    { id: 'send_blast', prompt: 'send the email blast to the list', sideEffect: 'send' },
    { id: 'log_it', prompt: 'record {{steps.send_blast.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { send_blast: {}, log_it: 'x' }).length, 0);
});

test('detectEmptyDeliverableReads: a declared non_empty contract is NOT double-flagged (contract enforces it)', () => {
  const steps = [
    { id: 'pull', prompt: 'pull rows', output: { non_empty: [''] } },
    { id: 'next', prompt: 'use {{steps.pull.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { pull: [], next: 'x' }).length, 0);
});

test("detectEmptyDeliverableReads: a step that didn't run is skipped (partial resume)", () => {
  const steps = [
    { id: 'a', prompt: 'read' },
    { id: 'b', prompt: 'use {{steps.a.output}}' },
  ] as any;
  // 'a' not in outputs (never ran) → nothing to flag
  assert.equal(detectEmptyDeliverableReads(steps, { b: 'x' }).length, 0);
});

// ---- Wave 2.2: structured run summary — artifacts (files/URLs/counts) ----

test('summarizeRunArtifacts: collects URLs, declared files, and row counts', () => {
  const steps = [
    { id: 'pull', prompt: 'query', output: {} },
    { id: 'render', prompt: 'render', output: { verify: { path_exists: ['path'] } } },
    { id: 'publish', prompt: 'deploy' },
  ] as any;
  const art = summarizeRunArtifacts(steps, {
    pull: { contacts: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    render: { path: '/Users/x/report.html' },
    publish: { url: 'https://demo.netlify.app' },
  });
  assert.deepEqual(art.counts, ['contacts: 3']);
  assert.deepEqual(art.files, ['/Users/x/report.html']);
  assert.deepEqual(art.urls, ['https://demo.netlify.app']);
});

test('summarizeRunArtifacts: a top-level array output is counted by step id', () => {
  const steps = [{ id: 'rows', prompt: 'pull' }] as any;
  const art = summarizeRunArtifacts(steps, { rows: [1, 2, 3, 4] });
  assert.deepEqual(art.counts, ['rows: 4']);
});

test('summarizeRunArtifacts: an empty run produces NO artifacts (so the no-op stays silent)', () => {
  const steps = [
    { id: 'find', prompt: 'find new' },
    { id: 'act', prompt: 'use {{steps.find.output}}' },
  ] as any;
  const art = summarizeRunArtifacts(steps, { find: [], act: {} });
  assert.equal(art.counts.length, 0);
  assert.equal(art.files.length, 0);
  assert.equal(art.urls.length, 0);
});

test('summarizeRunArtifacts: dedupes URLs and ignores _meta when counting', () => {
  const steps = [{ id: 's', prompt: 'x' }] as any;
  const art = summarizeRunArtifacts(steps, {
    s: { _meta: { ok: true }, rows: ['a', 'b'], link: 'see https://x.com and https://x.com again' },
  });
  assert.deepEqual(art.counts, ['rows: 2']);
  assert.deepEqual(art.urls, ['https://x.com']);
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
      newOutputContractJson: null,
      service: kind === 'reconnect_service' ? 'Salesforce' : null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

/** RSH-1: an edit_contract fix — corrects a too-strict output contract. */
function editContractDiagnosis(stepId: string, contractJson: string, autoApplicable = true) {
  return {
    summary: 'The step produced valid data but its contract was too strict.',
    rootCause: 'The declared output contract required a key the real data legitimately omits.',
    fix: {
      kind: 'edit_contract' as const,
      stepId,
      description: 'Loosen the output contract to match the real data shape.',
      newStepPrompt: null,
      newOutputContractJson: contractJson,
      newInputsJson: null,
      newAllowedToolsJson: null,
      service: null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

/** RSH-3: an edit_input fix — corrects a step's typed input binding. */
function editInputDiagnosis(stepId: string, inputsJson: string, autoApplicable = true) {
  return {
    summary: 'The step could not resolve a required input.',
    rootCause: 'The input binding pointed at a source that does not exist.',
    fix: {
      kind: 'edit_input' as const,
      stepId,
      description: 'Rebind the input to the correct source.',
      newStepPrompt: null,
      newOutputContractJson: null,
      newInputsJson: inputsJson,
      newAllowedToolsJson: null,
      service: null,
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

test('self-heal: below cap → applies the edit_step fix + re-queues a fresh run carrying attempt+1', async () => {
  // T3.2: the cross-family veto judge would attempt a live model call here —
  // disable it (kill-switch) so the heal proceeds on the fail-open path.
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-below-cap';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-h' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
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
  // T3.2: the healed re-run carries the reversible backup id so a non-stick
  // heal auto-reverts.
  assert.equal(typeof (fresh[0] as { selfHealBackupId?: string }).selfHealBackupId, 'string', 'carries the heal backup id');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-1: an edit_contract fix auto-applies (loosens the contract) + re-queues', async () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-contract';
  writeHealWorkflow(wf, [{ id: 'gather', prompt: 'Gather leads and return them.' }]);
  // give the step a too-strict contract, then heal it
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  entry.writeWorkflow(wf, { ...cur, steps: [{ ...cur.steps[0], output: { type: 'object', required_keys: ['name', 'email', 'phone'] } }] });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-c' }), 'utf-8');
  const diag = editContractDiagnosis('gather', '{"type":"object","required_keys":["name","email"]}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-c', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'gather', prompt: 'Gather leads and return them.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['gather']),
    // RSH-2: the real output satisfies the loosened contract → probe passes.
    rawStepOutputs: { gather: { name: 'Ada', email: 'ada@x.co' } },
  });
  assert.ok(out, 'contract heal fired');
  // the workflow's contract was loosened on disk
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].output, { type: 'object', required_keys: ['name', 'email'] });
  // and a fresh re-run was queued carrying the backup id for auto-revert
  const fresh = freshRunsFor(wf, origId) as Array<{ selfHealBackupId?: string }>;
  assert.equal(fresh.length, 1);
  assert.equal(typeof fresh[0].selfHealBackupId, 'string');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-3: an edit_input fix auto-applies (rebinds the input) + re-queues', async () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-input';
  writeHealWorkflow(wf, [{ id: 'fetch', prompt: 'Fetch {{input.url}} and return it.' }]);
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  entry.writeWorkflow(wf, {
    ...cur, inputs: { url: { type: 'string' } },
    steps: [{ ...cur.steps[0], inputs: { url: { from: 'input.wrongname' } } }],
  });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: { url: 'https://x.co' }, status: 'completed', originSessionId: 'sess-i' }), 'utf-8');
  const diag = editInputDiagnosis('fetch', '{"url":{"from":"input.url"}}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-i', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} and return it.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['fetch']),
  });
  assert.ok(out, 'input heal fired');
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].inputs, { url: { from: 'input.url' } });
  const fresh = freshRunsFor(wf, origId) as Array<{ selfHealBackupId?: string }>;
  assert.equal(fresh.length, 1);
  assert.equal(typeof fresh[0].selfHealBackupId, 'string');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-2: probe blocks a doomed contract fix (real output still fails it) — no apply, no re-run', async () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-probe-block';
  writeHealWorkflow(wf, [{ id: 'gather', prompt: 'Gather leads.' }]);
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  const strict = { type: 'object' as const, required_keys: ['name', 'email', 'phone'] };
  entry.writeWorkflow(wf, { ...cur, steps: [{ ...cur.steps[0], output: strict }] });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  // the Doctor proposes requiring [name,email] — but the REAL output only has name,
  // so even the data we have would fail the "fixed" contract → probe must reject.
  const diag = editContractDiagnosis('gather', '{"type":"object","required_keys":["name","email"]}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'gather', prompt: 'Gather leads.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['gather']),
    rawStepOutputs: { gather: { name: 'Ada' } }, // missing email → fails the proposed contract
  });
  assert.equal(out, null, 'doomed contract fix → escalate, do not auto-heal');
  // the workflow contract is UNTOUCHED (fix never applied) and no re-run queued
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].output, strict);
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no wasted re-run');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal: at the attempt cap → escalates (no auto re-run)', async () => {
  const wf = 'heal-at-cap';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));
  const max = workflowRunnerInternalsForTest.selfHealAutoMaxAttempts();

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
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

test('self-heal: a non-edit_step (reconnect) fix is never auto-applied', async () => {
  const wf = 'heal-reconnect';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'x' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find', false, 'reconnect_service'));
  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
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

test('self-heal: an ungated future post/send step blocks auto re-run after a prompt edit', async () => {
  const wf = 'heal-ungated-post';
  writeHealWorkflow(wf, [
    { id: 'research', prompt: 'Research the topic.' },
    { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.' },
  ]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-post' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('research'));

  const steps = [
    { id: 'research', prompt: 'Research the topic.' },
    { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.' },
  ] as never;
  assert.equal(workflowRunnerInternalsForTest.hasUngatedIrreversibleAction(steps), true);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-post', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps,
    diagnosis: editStepDiagnosis('research') as never,
    proposedFix: fix,
    completedStepIds: new Set(['research']),
  });

  assert.equal(out, null, 'ungated future post escalates instead of auto-requeueing');
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no fresh run queued');
});

test('self-heal: an approval-gated future post/send step may auto-heal because execution will park', () => {
  assert.equal(
    workflowRunnerInternalsForTest.hasUngatedIrreversibleAction([
      { id: 'research', prompt: 'Research the topic.' },
      { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.', requiresApproval: true },
    ] as never),
    false,
  );
  assert.equal(
    workflowRunnerInternalsForTest.hasUngatedIrreversibleAction([
      { id: 'post', prompt: 'Prepare a caption for review.', sideEffect: 'send', requiresApproval: true },
    ] as never),
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

// ---------------------------------------------------------------------------
// Wave 3 P0-3 — crash-resume side-effect guard
// ---------------------------------------------------------------------------

function resumeState(inFlightStepId: string | undefined, completed: string[] = [], failed: string[] = []) {
  return {
    inFlightStepId,
    completedSteps: new Map<string, unknown>(completed.map((id) => [id, 'out'] as [string, unknown])),
    failedSteps: new Set<string>(failed),
  };
}
function wfWith(steps: unknown[]): Parameters<typeof shouldHaltResumeForSideEffect>[0] {
  return { name: 'rt', description: '', enabled: true, trigger: { manual: true }, steps } as never;
}

test('stepSideEffectClass: declared field wins, else heuristic', () => {
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'anything', sideEffect: 'send' }), 'send');
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'Send the outreach emails to the list.' }), 'send');
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'Read the leads from the sheet.' }), 'read');
});

test('P0-3 halts crash-resume of an autonomous write/send step', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write', dependsOn: ['pull'] },
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['save'] },
  ]);
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('save', ['pull'])), { stepId: 'save', cls: 'write', declared: true });
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull', 'save'])), { stepId: 'send', cls: 'send', declared: true });
});

test('P0-3 ledger-aware resume: harness write with no recorded external_write auto-resumes', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write', dependsOn: ['pull'] },
  ]);
  assert.equal(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save', ['pull']),
      undefined,
      { harnessEnabled: true, claimedExternalWrite: false },
    ),
    null,
  );
});

test('P0-3 ledger-aware resume: claimed external_write still halts', () => {
  const wf = wfWith([
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save'),
      undefined,
      { harnessEnabled: true, claimedExternalWrite: true },
    ),
    { stepId: 'save', cls: 'write', declared: true },
  );
});

test('P0-3 ledger-aware resume stays conservative for legacy/non-harness steps', () => {
  const wf = wfWith([
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save'),
      undefined,
      { harnessEnabled: false, claimedExternalWrite: false },
    ),
    { stepId: 'save', cls: 'write', declared: true },
  );
});

test('P0-3 halt reports declared=false when the class was only inferred from prose', () => {
  // The scorpion-facebook-trends failure mode: no declared sideEffect, prose
  // heuristic guesses write → halt. The message uses declared=false to teach
  // the one-line `sideEffect: read` fix.
  const wf = wfWith([
    { id: 'scrape', prompt: 'Normalize the scraped page data and write rows into the result.' },
  ]);
  const halt = shouldHaltResumeForSideEffect(wf, resumeState('scrape'));
  assert.ok(halt, 'inferred write step should halt');
  assert.equal(halt?.declared, false);
});

test('P0-3 does NOT halt a read step, a completed step, or the targeted re-run path', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['pull'] },
  ]);
  // read step in flight → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('pull')), null);
  // in-flight step already completed → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull', 'send'])), null);
  // explicit single-step re-run → exempt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull']), 'send'), null);
  // nothing in flight → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState(undefined)), null);
});

test('Lane B (bug #8 FIXED): a crashed forEach SEND auto-resumes (no halt) — now SAFE via per-item dedup', () => {
  // forEach steps are item-tracked, so a crashed forEach SHOULD auto-resume
  // (skip done items, retry the rest) rather than halt-for-a-human. The bug was
  // the crash WINDOW: an item whose send fired but whose item_completed wasn't
  // recorded got re-sent. The fix is NOT to halt forEach (that loses the
  // auto-resume) — it's the runner-level per-item guard (itemSendAlreadyFired:
  // an item with a prior external_write under its deterministic session is
  // skipped on resume). So shouldHaltResumeForSideEffect STILL returns null for
  // forEach (auto-resume), and that is now correct + safe.
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'blast', prompt: 'Email each lead.', sideEffect: 'send', forEach: 'pull', dependsOn: ['pull'] },
  ]);
  assert.equal(
    shouldHaltResumeForSideEffect(wf, resumeState('blast', ['pull'])),
    null,
    'forEach send auto-resumes (no halt); the per-item dedup, not a halt, prevents the double-send',
  );
});

test('Lane B (bug #8 / audit #2.2): stepSendAlreadyFired — a PLAIN step whose send fired is detected, so a transient error does NOT re-run it (no double-send)', () => {
  resetEventLog();
  const runId = 'r-step-dup';
  const stepId = 'notify_nate';
  const sid = `workflow:${runId}:${stepId}`;
  // Nothing fired yet → a transient error IS retryable.
  assert.equal(stepSendAlreadyFired(runId, stepId), false, 'no send yet → not claimed');
  // The send fires: an external_write is recorded under the step's deterministic
  // session id. A later transient model error (e.g. 529 before step_completed)
  // must NOT re-run the step — the guard catches the prior send.
  HarnessSession.create({ id: sid, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'GMAIL_SEND', targets: ['x@y.com'] } });
  assert.equal(stepSendAlreadyFired(runId, stepId), true, 'a fired send suppresses the transient retry (no double-send)');
  assert.equal(stepExternalWriteAlreadyClaimed(runId, stepId), true, 'generic write ledger helper sees the same claim');
  // A failure compensation nets it back out → the send did NOT claim → retry ok.
  appendEvent({ sessionId: sid, turn: 0, role: 'tool', type: 'external_write_failed', data: { shapeKey: 'GMAIL_SEND', targets: ['x@y.com'] } });
  assert.equal(stepSendAlreadyFired(runId, stepId), false, 'a netted failure means the send did not claim → retry allowed');
});

test('Lane B (bug #8): sendAlreadyClaimed — more external_writes than failures ⇒ a send fired', () => {
  assert.equal(sendAlreadyClaimed(1, 0), true, 'one send, no failure → claimed');
  assert.equal(sendAlreadyClaimed(1, 1), false, 'one send fully netted by a failure → not claimed');
  assert.equal(sendAlreadyClaimed(0, 0), false, 'nothing fired → not claimed');
  assert.equal(sendAlreadyClaimed(2, 1), true, '2 writes, 1 failed → 1 net send claimed');
});

test('P0-3 approval-gated step is exempt (parking emits step_started before the gate)', () => {
  const wf = wfWith([
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', requiresApproval: true },
  ]);
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send')), null);
});

test('P0-3 runtime-request_approval park is exempt (in-flight step has a step_failed event)', () => {
  // The regression case: a PLAIN send step (requiresApproval=false) that called
  // request_approval mid-run parks via ParkRunSignal → caught + logged as
  // step_failed → reaper re-admits. On resume it must RESUME (not halt), or the
  // now-default-ON parking flow would break for every send step.
  const wf = wfWith([
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send' },
  ]);
  // Without the park marker it WOULD halt (plain crashed send) …
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('send')), { stepId: 'send', cls: 'send', declared: true });
  // … with a logged step_failed (the park signature) it is exempt.
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send', [], ['send'])), null);
});

test('P0-3 forEach step is exempt (resume is item-level idempotent)', () => {
  const wf = wfWith([
    { id: 'blast', prompt: 'Email each prospect.', sideEffect: 'send', forEach: 'pull' },
  ]);
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('blast')), null);
});

test('P0-3 end-to-end: park → approve → crash mid-send HALTS (closes the double-send hole)', () => {
  // Build the real event sequence through the durability layer and feed the
  // resulting ResumeState to the guard — the post-approval re-start must clear
  // the park marker so a mid-send crash is caught, not blind-re-run.
  const slug = 'p03-e2e';
  const wf = wfWith([{ id: 'send', prompt: 'Email the batch.', sideEffect: 'send' }]);

  // 1. parked on a runtime approval → exempt (resumes from the gate).
  appendWorkflowEvent(slug, 'r1', { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent(slug, 'r1', { kind: 'step_failed', stepId: 'send', error: 'Workflow run parked on approval.' });
  assert.equal(shouldHaltResumeForSideEffect(wf, computeResumeState(slug, 'r1')), null, 'still-parked send resumes');

  // 2. approved → re-started → crashed mid-send → HALT (no double send).
  appendWorkflowEvent(slug, 'r1', { kind: 'step_started', stepId: 'send' });
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, computeResumeState(slug, 'r1')),
    { stepId: 'send', cls: 'send', declared: true },
    'post-approval mid-send crash halts',
  );
});

test('isPhantomStepCompletion: a send/write step that called no real tool is flagged (phantom completion #2)', () => {
  // phantom: send step, zero tools → it never sent
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send', prompt: 'call notify_user' }, [], {}), true);
  // phantom: only StructuredOutput (schema emission, not an action)
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['StructuredOutput'], {}), true);
  // phantom: write step, zero tools
  assert.equal(isPhantomStepCompletion({ id: 'w', sideEffect: 'write' }, [], 'done'), true);

  // NOT phantom: it actually called the send tool
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['mcp__clementine-local__notify_user'], {}), false);
  // NOT phantom: read step (no action expected)
  assert.equal(isPhantomStepCompletion({ id: 'r', sideEffect: 'read' }, [], {}), false);
  // NOT phantom: deterministic runner doesn't call brain tools
  assert.equal(isPhantomStepCompletion({ id: 'd', sideEffect: 'send', deterministic: { runner: 'x.mjs' } }, [], {}), false);
  // NOT phantom: already-blocked output is honest, leave it
  assert.equal(isPhantomStepCompletion({ id: 'b', sideEffect: 'send' }, [], { blocked: true, reason: 'no data' }), false);
});

test('isPhantomStepCompletion: kill-switch off → never flags', () => {
  process.env.CLEMMY_WORKFLOW_PHANTOM_GUARD = 'off';
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, [], {}), false);
  delete process.env.CLEMMY_WORKFLOW_PHANTOM_GUARD;
});

test('isPhantomStepCompletion: workflow_step_result is result emission, not action (orchestrator-lane parity)', () => {
  // phantom: the step emitted its structured result but never called an acting tool
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['workflow_step_result'], { ok: true }), true);
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['StructuredOutput', 'workflow_step_result'], {}), true);
  // NOT phantom: emitted the result AND actually acted
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['workflow_step_result', 'mcp__clementine-local__notify_user'], {}), false);
});

test('decideBatchSettlement: park OUTRANKS a sibling failure (T1.3 — the approval survives)', () => {
  const stepA = { id: 'a', prompt: 'read stuff' };
  const stepB = { id: 'b', prompt: 'send stuff', sideEffect: 'send' as const };
  const stepC = { id: 'c', prompt: 'also read' };
  const park = new ParkRunSignal([{ stepId: 'b', kind: 'gate' as const, approvalIds: ['apr-1'] }]);
  const decision = decideBatchSettlement(
    [stepA, stepB, stepC],
    [
      { status: 'fulfilled', value: { step: stepA, output: { ok: true } } },
      { status: 'rejected', reason: park },
      { status: 'rejected', reason: new Error('provider blew up') },
    ],
  );
  // park wins over the sibling failure — the run parks instead of dying
  assert.equal(decision.action, 'park');
  assert.deepEqual(decision.parkedSteps, [{ stepId: 'b', kind: 'gate', approvalIds: ['apr-1'] }]);
  // the failure is preserved for the advisory (not swallowed)
  assert.deepEqual(decision.failures, [{ stepId: 'c', message: 'provider blew up' }]);
  // the completed sibling is kept
  assert.deepEqual(decision.completions, [{ stepId: 'a', output: { ok: true } }]);
});

test('decideBatchSettlement: failures with no park → fail; all fulfilled → continue', () => {
  const stepA = { id: 'a', prompt: 'x' };
  const stepB = { id: 'b', prompt: 'y' };
  const failed = decideBatchSettlement(
    [stepA, stepB],
    [
      { status: 'fulfilled', value: { step: stepA, output: 'done' } },
      { status: 'rejected', reason: new Error('boom') },
    ],
  );
  assert.equal(failed.action, 'fail');
  assert.deepEqual(failed.failures, [{ stepId: 'b', message: 'boom' }]);
  assert.deepEqual(failed.completions, [{ stepId: 'a', output: 'done' }]);

  const clean = decideBatchSettlement(
    [stepA],
    [{ status: 'fulfilled', value: { step: stepA, output: 1 } }],
  );
  assert.equal(clean.action, 'continue');
  assert.equal(clean.failures.length, 0);
  assert.equal(clean.parkedSteps.length, 0);
});

test('tightenWorkflowContractsFromCleanRun applies to current workflow without clobbering newer edits', async () => {
  const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'clean-tighten-current';
  const runStartDef = {
    name: 'Clean Tighten Current',
    description: 'Original run-start definition',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'same', prompt: 'Gather current data.' },
      { id: 'changed', prompt: 'Gather old data.' },
    ],
  };
  writeWorkflow(slug, {
    ...runStartDef,
    description: 'User-edited definition while the run was active',
    steps: [
      { id: 'same', prompt: 'Gather current data.' },
      { id: 'changed', prompt: 'User changed this step while run was active.' },
    ],
  });

  // T3.1 conservative: tightening requires ≥3 invariant clean runs. Prime two,
  // which must NOT tighten yet, then the third applies.
  const outputs = { same: [{ id: 'A' }], changed: [{ id: 'B' }] };
  assert.deepEqual(tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-1'), []);
  assert.deepEqual(tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-2'), []);
  const applied = tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-3');

  assert.deepEqual(applied, ['same']);
  const saved = readWorkflow(slug)!.data;
  // the user's concurrent edit to `changed` is preserved, and only `same` (whose
  // prompt was unchanged) is tightened — the anti-clobber guard still holds.
  assert.equal(saved.description, 'User-edited definition while the run was active');
  assert.equal(saved.steps.find((s) => s.id === 'same')?.output?.type, 'array');
  assert.equal(saved.steps.find((s) => s.id === 'changed')?.output, undefined);
  assert.equal(saved.steps.find((s) => s.id === 'changed')?.prompt, 'User changed this step while run was active.');
});

test('phantomBlockedOutput: blocked shape names the step and its side-effect class', () => {
  const send = phantomBlockedOutput({ id: 'notify', sideEffect: 'send', prompt: '' });
  assert.equal(send.blocked, true);
  assert.match(send.reason, /"notify".*send step.*without calling any tool/s);
  const write = phantomBlockedOutput({ id: 'save', sideEffect: 'write', prompt: '' });
  assert.match(write.reason, /write step/);
  assert.match(write.reason, /write was not actually performed/);
});

// ─── WATCHER (workflow mount): trajectory steer at step boundaries ───────────

test('applyWatcherSteerToPrompt: appends the trajectory block only when a steer is pending', async () => {
  const { applyWatcherSteerToPrompt } = await import('./workflow-runner.js');
  assert.equal(applyWatcherSteerToPrompt({}, 'do the step'), 'do the step', 'no steer → byte-identical');
  const steered = applyWatcherSteerToPrompt({ watcherSteer: 'criterion 2 untouched. Address it before drafting.' }, 'do the step');
  assert.match(steered, /TRAJECTORY CHECK/);
  assert.match(steered, /criterion 2 untouched/);
  assert.match(steered, /remain authoritative/);
});

test('renderWatcherWorkflowDigest: completed outputs clipped, remaining steps named as NOT drift', async () => {
  const { renderWatcherWorkflowDigest } = await import('./workflow-runner.js');
  const digest = renderWatcherWorkflowDigest(
    [{ id: 'pull' }, { id: 'enrich' }, { id: 'send' }],
    { pull: { rows: 12, note: 'x'.repeat(500) }, enrich: 'twelve rows enriched' },
  );
  assert.match(digest.summary, /2 of 3 steps completed/);
  assert.match(digest.summary, /step "pull"/);
  assert.match(digest.summary, /Steps still to run \(NOT drift[^)]*\): send/);
  assert.ok(digest.summary.length < 1200, 'outputs are clipped');
  assert.match(digest.latest, /completed step "enrich"/);
});

test('workflow watcher: drift at a step boundary records a steer advisory with the right cadence and digest', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { _setWorkflowWatcherForTests: setWatcher } = await import('./workflow-runner.js');
  const slug = 'watcher-steer-runner';
  const workflowName = 'Watcher Steer Runner';
  const runId = `watcher-steer-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Three-step chain to exercise the step-boundary watcher.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'a', prompt: 'Step A.', deterministic: { runner: 'emit.mjs' }, sideEffect: 'read' },
      { id: 'b', prompt: 'Step B.', dependsOn: ['a'], deterministic: { runner: 'emit.mjs' }, sideEffect: 'read' },
      { id: 'c', prompt: 'Step C.', dependsOn: ['b'], deterministic: { runner: 'emit.mjs' }, sideEffect: 'read' },
    ],
  });
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'emit.mjs'),
    'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));',
    'utf-8',
  );
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: workflowName, status: 'queued', inputs: {}, createdAt: new Date().toISOString(),
  }), 'utf-8');

  const digestsSeen: Array<{ summary: string; count: number }> = [];
  setWatcher(async (input) => {
    digestsSeen.push({ summary: input.toolCallSummary, count: input.toolCallCount });
    return { onTrack: false, miss: 'the enrichment ignored the stated goal', steer: 'Re-anchor on the goal before the final step.' };
  });
  try {
    await processWorkflowRuns({} as never);
  } finally {
    setWatcher(async () => ({ onTrack: true, miss: '', steer: '' }));
  }

  // Cadence: default interval 2 over 3 sequential steps → exactly ONE check
  // (after step 2; never after the final step — end-of-run judges own that).
  assert.equal(digestsSeen.length, 1, `expected one watcher check, saw ${digestsSeen.length}`);
  assert.equal(digestsSeen[0].count, 2, 'checked at the 2-completed-steps boundary');
  assert.match(digestsSeen[0].summary, /Steps still to run[^:]*: c/, 'digest names the remaining step');
  const events = readWorkflowEvents(slug, runId);
  const steer = events.find((e) => e.kind === 'step_advisory' && (e.meta as { reason?: string } | undefined)?.reason === 'watcher_steer');
  assert.ok(steer, `expected a watcher_steer advisory, got kinds: ${events.map((e) => e.kind).join(', ')}`);
  assert.match(String((steer!.meta as { steer?: string }).steer ?? ''), /Re-anchor on the goal/);
});
