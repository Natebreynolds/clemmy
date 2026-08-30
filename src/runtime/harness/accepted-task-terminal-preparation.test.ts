import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-preparation-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-preparation\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const authority = await import('./accepted-task-authority.js');
const preparation = await import('./accepted-task-terminal-preparation.js');
const admission = await import('./expected-work-admission.js');
const workManifest = await import('./work-manifest.js');
const attempts = await import('./attempt-settlement.js');
const workflowStore = await import('../../memory/workflow-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptWithoutExpectedWork(text: string) {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** Exact host-v1 pre-planning shape: the source is accepted, but discovery
 * starts before an expected-task graph/authority has been persisted. */
function acceptBeforePlanning(text: string) {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function accept(text: string) {
  const task = acceptWithoutExpectedWork(text);
  const fixed = contracts.freezeDeterministicExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed', JSON.stringify(fixed));
  return task;
}

function settleRead(input: {
  task: ReturnType<typeof accept>;
  tool: string;
  args: unknown;
  payload: unknown;
}) {
  const logicalToolCallId = `logical:terminal-preparation:${serial}`;
  const physicalDispatchId = `dispatch:terminal-preparation:${serial}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 0,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: input.tool, args: input.args },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  return { logicalToolCallId, physicalDispatchId };
}

test('a direct conversation prepares a real zero-obligation terminal without provider work', () => {
  const task = accept('Hello, how are you?');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'manifested_verifying');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 0);
});

test('a settled complete read mints and satisfies host evidence at the production seam', () => {
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }, { id: 'b' }] },
      meta: { complete: true },
    },
  });
  const first = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(first.status, 'ready', JSON.stringify(first));
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);

  eventlog.closeEventLog();
  const replay = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(replay.status, 'ready', JSON.stringify(replay));
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);
});

test('an incomplete collection remains repairable and cannot freeze a manifest', () => {
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
    payload: {
      successful: true,
      data: { records: [{ id: 'a' }] },
      meta: { complete: false },
      next_cursor: 'opaque-next',
    },
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  const loaded = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'armed');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 0);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length, 0);
});


function acceptActivatedAction(text: string) {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function recordCanonicalSdkReturn(input: {
  task: ReturnType<typeof acceptActivatedAction>;
  tool: string;
  callId: string;
  successfulBusinessResult?: true;
  successfulAuthoringResult?: true;
}): void {
  const called = eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      topologyRole: input.successfulAuthoringResult ? 'control' : 'business',
    },
  });
  eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      accounting: 'top_level',
      ok: true,
      ...(input.successfulBusinessResult ? { successfulBusinessResult: true } : {}),
      ...(input.successfulAuthoringResult ? { successfulAuthoringResult: true } : {}),
    },
  });
}

test('only the canonical successful SDK authoring return closes an uncontracted workflow-create action', () => {
  const task = acceptActivatedAction('Create a daily digest workflow.');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: 1,
    role: 'system',
    type: 'sdk_tool_use_recorded',
    data: { sourceUserSeq: task.sourceUserSeq, tools: ['workflow_create'] },
  });
  const summaryOnly = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(summaryOnly.status, 'needs_verification', JSON.stringify(summaryOnly));

  recordCanonicalSdkReturn({
    task,
    tool: 'workflow_create',
    callId: 'toolu_workflow_create_success',
    successfulAuthoringResult: true,
  });
  const returned = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(returned.status, 'ready', JSON.stringify(returned));
  assert.match(
    returned.status === 'ready' ? returned.verdict.facts.join('; ') : '',
    /durable work evidence/,
  );
});

test('a successful-looking SDK control return without the host authoring verdict remains held', () => {
  const task = acceptActivatedAction('Create a daily digest workflow.');
  recordCanonicalSdkReturn({
    task,
    tool: 'workflow_create',
    callId: 'toolu_workflow_create_unproven',
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
});

function settleReturnedLocalControlRead(input: {
  task: ReturnType<typeof acceptActivatedAction>;
  tool: string;
  args: unknown;
  result: unknown;
  eventArgs?: unknown;
  eventCallId?: string;
  returnedParent?: 'called' | 'accepted_source';
  returnedDataExtras?: Record<string, unknown>;
  lane?: 'agents_runner' | 'claude_sdk';
}): ReturnType<typeof attempts.settleToolAttempt> {
  const callId = `toolu_local_control_read_${serial}`;
  const eventCallId = input.eventCallId ?? callId;
  const eventArgs = input.eventArgs ?? input.args;
  const called = eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: eventCallId,
      canonicalCallId: eventCallId,
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: input.tool,
      arguments: JSON.stringify(eventArgs),
    },
  });
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      acceptedTaskId: identities.acceptedTaskIdFor(
        input.task.sessionId,
        input.task.sourceUserSeq,
      ),
      logicalToolCallId: callId,
    },
    tool: input.tool,
    args: input.args,
  }).status, 'inserted');
  const settled = attempts.settleToolAttempt({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    turn: 1,
    lane: input.lane ?? 'agents_runner',
    toolName: input.tool,
    callId,
    args: input.args,
    mutating: false,
    businessCall: true,
    result: input.result,
  });
  const acceptedSource = eventlog.listEvents(input.task.sessionId, {
    sinceSeq: input.task.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  })[0];
  assert.equal(acceptedSource?.seq, input.task.sourceUserSeq);
  eventlog.appendEvent({
    sessionId: input.task.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: input.returnedParent === 'accepted_source'
      ? acceptedSource!.id
      : called.id,
    data: {
      ...input.returnedDataExtras,
      sourceUserSeq: input.task.sourceUserSeq,
      tool: input.tool,
      callId: eventCallId,
      canonicalCallId: eventCallId,
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: input.tool,
      result: input.result,
    },
  });
  return settled;
}

function seedTerminalReadWorkflow(): void {
  workflowStore.writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Review one Slack channel on a weekday cadence.',
    enabled: true,
    trigger: {
      schedule: '0 8,12,16 * * 1-5',
      timezone: 'America/Los_Angeles',
    },
    steps: [{ id: 'review', prompt: 'Review the configured channel.' }],
  });
}

test('an exact successful local workflow read verifies a read-only act-routed request (live 2026-08-20)', () => {
  seedTerminalReadWorkflow();
  const task = acceptActivatedAction(
    'CANARY-WORKFLOW-READ: Read only the frontmatter for workflow platform-49-slack-channel-review. '
    + 'Do not run or update it, and return only its schedule and timezone.',
  );
  const settled = settleReturnedLocalControlRead({
    task,
    tool: 'workflow_get',
    args: { name: 'platform-49-slack-channel-review', section: 'metadata', step: null },
    result: WORKFLOW_READ_RESULT,
  });
  assert.equal(settled.outcome.kind, 'succeeded');
  const settlementRow = eventlog.openEventLog().prepare(`
    SELECT execution_kind, business_call
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    execution_kind: string;
    business_call: number;
  };
  assert.equal(settlementRow.execution_kind, 'local_execution');
  assert.equal(settlementRow.business_call, 0, 'workflow_get retains its control topology role');

  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Schedule: `0 8,12,16 * * 1-5`; timezone: America/Los_Angeles.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /durable work evidence/,
  );
});

test('a prerequisite local workflow read cannot verify a requested control write', () => {
  const task = acceptActivatedAction(
    'Schedule workflow platform-49-slack-channel-review to run every weekday at 8am.',
  );
  settleReturnedLocalControlRead({
    task,
    tool: 'workflow_get',
    args: { name: 'platform-49-slack-channel-review', section: 'metadata', step: null },
    result: WORKFLOW_READ_RESULT,
  });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Updated the workflow schedule to 8am every weekday.',
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
});

test('MCP and serialized carrier variants cannot impersonate the host-owned direct result', () => {
  const envelope = { content: [{ type: 'text', text: WORKFLOW_READ_RESULT }] };
  for (const result of [envelope, JSON.stringify(envelope)]) {
    assertLocalControlReadDoesNotCertify({
      tool: 'workflow_get',
      args: WORKFLOW_READ_ARGS,
      result,
      assertOutcome: 'succeeded',
    });
  }
});

const WORKFLOW_READ_OBJECTIVE =
  'CANARY-WORKFLOW-READ: Read only the frontmatter for workflow platform-49-slack-channel-review. '
  + 'Do not run or update it, and return only its schedule and timezone.';
const WORKFLOW_READ_ARGS = {
  name: 'platform-49-slack-channel-review',
  section: 'metadata',
  step: null,
};
const WORKFLOW_READ_RESULT =
  'Workflow metadata (step prompts and workflow body omitted):\n'
  + JSON.stringify({
    name: 'Platform 49 Slack Channel Review',
    description: 'Review one Slack channel on a weekday cadence.',
    enabled: true,
    trigger: {
      schedule: '0 8,12,16 * * 1-5',
      timezone: 'America/Los_Angeles',
      manual: false,
    },
    step_count: 1,
    steps: [{ id: 'review', executor: { kind: 'model' } }],
  }, null, 2);

function assertLocalControlReadDoesNotCertify(input: {
  tool: string;
  args: unknown;
  result?: unknown;
  eventArgs?: unknown;
  eventCallId?: string;
  returnedParent?: 'called' | 'accepted_source';
  returnedDataExtras?: Record<string, unknown>;
  lane?: 'agents_runner' | 'claude_sdk';
  assertOutcome?: 'succeeded' | 'empty_result';
}): void {
  seedTerminalReadWorkflow();
  const task = acceptActivatedAction(WORKFLOW_READ_OBJECTIVE);
  const settled = settleReturnedLocalControlRead({
    task,
    tool: input.tool,
    args: input.args,
    result: input.result ?? WORKFLOW_READ_RESULT,
    ...(input.eventArgs === undefined ? {} : { eventArgs: input.eventArgs }),
    ...(input.eventCallId === undefined ? {} : { eventCallId: input.eventCallId }),
    ...(input.returnedParent === undefined ? {} : { returnedParent: input.returnedParent }),
    ...(input.returnedDataExtras === undefined ? {} : { returnedDataExtras: input.returnedDataExtras }),
    ...(input.lane === undefined ? {} : { lane: input.lane }),
  });
  if (input.assertOutcome) assert.equal(settled.outcome.kind, input.assertOutcome);
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Done. I read the requested workflow and verified its schedule.',
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
}

test('a >400-character direct Claude SDK metadata result reaches terminal verification intact', () => {
  assert.ok(WORKFLOW_READ_RESULT.length > 400, 'fixture must exceed the generic SDK event preview');
  seedTerminalReadWorkflow();
  const task = acceptActivatedAction(WORKFLOW_READ_OBJECTIVE);
  const settled = settleReturnedLocalControlRead({
    task,
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    result: WORKFLOW_READ_RESULT,
    lane: 'claude_sdk',
  });
  assert.equal(settled.outcome.kind, 'succeeded');
  const prepared = preparation.prepareAcceptedTaskTerminal({
    ...task,
    proposedReply: 'Schedule: `0 8,12,16 * * 1-5`; timezone: America/Los_Angeles.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
});

test('a control executor declared read cannot certify a workflow definition read', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_run',
    args: { name: 'platform-49-slack-channel-review' },
    assertOutcome: 'succeeded',
  });
});

test('an unrelated workflow status read cannot certify a workflow definition read', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_run_status',
    args: { name: 'platform-49-slack-channel-review' },
    assertOutcome: 'succeeded',
  });
});

test('an unrelated harness bookkeeping read cannot certify a workflow definition read', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'browser_harness_status',
    args: {},
    result: 'Browser Harness is available.',
    assertOutcome: 'succeeded',
  });
});

test('workflow_get for a name absent from the accepted objective cannot certify it', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: { name: 'different-workflow', section: 'metadata', step: null },
    assertOutcome: 'succeeded',
  });
});

test('incidental workflow-read nouns cannot impersonate the resolved workflow target', () => {
  for (const name of ['schedule', 'timezone', 'frontmatter', 'only']) {
    assertLocalControlReadDoesNotCertify({
      tool: 'workflow_get',
      args: { name, section: 'metadata', step: null },
      assertOutcome: 'succeeded',
    });
  }
});

test('workflow_get metadata and step conflict prose cannot certify frontmatter', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: {
      name: 'platform-49-slack-channel-review',
      section: 'metadata',
      step: 'review',
    },
    result: 'Choose either section="metadata" for the bounded workflow overview or step="<id>" for one full step; they cannot be combined.',
    assertOutcome: 'succeeded',
  });
});

test('workflow_get missing-step prose cannot certify frontmatter', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: { name: 'platform-49-slack-channel-review', step: 'missing-step' },
    result: 'Workflow "Platform 49 Slack Channel Review" has no step "missing-step". Steps: "review".',
    assertOutcome: 'succeeded',
  });
});

test('workflow_get full-definition mode cannot certify a bounded metadata request', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: { name: 'platform-49-slack-channel-review', section: 'full', step: null },
    result: 'Trigger: schedule: 0 8,12,16 * * 1-5\nTimezone: America/Los_Angeles\nSteps: full prompt body',
    assertOutcome: 'succeeded',
  });
});

test('workflow_get whitespace step conflict cannot certify bounded metadata', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: { name: 'platform-49-slack-channel-review', section: 'metadata', step: '   ' },
    result: 'Choose either section="metadata" for the bounded workflow overview or step="<id>" for one full step; they cannot be combined.',
    assertOutcome: 'succeeded',
  });
});

test('canonical metadata for another workflow cannot certify the requested target', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    result: WORKFLOW_READ_RESULT.replace(
      'Platform 49 Slack Channel Review',
      'Different Workflow',
    ),
    assertOutcome: 'succeeded',
  });
});

test('a workflow display name cannot shadow the accepted target slug at return time', () => {
  workflowStore.writeWorkflow('target-slug', {
    name: 'Collision Protected Workflow',
    description: 'The workflow explicitly named by the accepted objective.',
    enabled: true,
    trigger: { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'review', prompt: 'Review the accepted target.' }],
  });
  workflowStore.writeWorkflow('shadow-workflow', {
    name: 'target-slug',
    description: 'An unrelated workflow whose display name shadows the target slug.',
    enabled: true,
    trigger: { schedule: '0 12 * * 1-5', timezone: 'America/New_York' },
    steps: [{ id: 'shadow', prompt: 'This is not the accepted target.' }],
  });
  try {
    const task = acceptActivatedAction(
      'Read only the frontmatter for workflow Collision Protected Workflow. '
      + 'Do not run or update it, and return only its schedule and timezone.',
    );
    const wrongWorkflowResult = WORKFLOW_READ_RESULT.replace(
      'Platform 49 Slack Channel Review',
      'target-slug',
    );
    const settled = settleReturnedLocalControlRead({
      task,
      tool: 'workflow_get',
      args: { name: 'target-slug', section: 'metadata', step: null },
      result: wrongWorkflowResult,
    });
    assert.equal(settled.outcome.kind, 'succeeded');
    const prepared = preparation.prepareAcceptedTaskTerminal({
      ...task,
      proposedReply: 'Done. I read the requested workflow and verified its schedule.',
    });
    assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
    assert.deepEqual(
      prepared.status === 'needs_verification' ? prepared.missing : [],
      ['work_contract_missing'],
    );
  } finally {
    workflowStore.deleteWorkflow('target-slug');
    workflowStore.deleteWorkflow('shadow-workflow');
  }
});

test('serialized contradictory envelopes cannot launder canonical metadata text', () => {
  for (const contradiction of [
    { isError: true },
    { successful: false },
    { success: false },
    { ok: false },
    { error: 'permission denied' },
    { status: 'failed' },
  ]) {
    assertLocalControlReadDoesNotCertify({
      tool: 'workflow_get',
      args: WORKFLOW_READ_ARGS,
      result: JSON.stringify({
        ...contradiction,
        content: [{ type: 'text', text: WORKFLOW_READ_RESULT }],
      }),
    });
  }
});

test('array envelope contradictions cannot hide beside canonical metadata text', () => {
  const textItem = { type: 'text', text: WORKFLOW_READ_RESULT };
  const errorItem = { isError: true, error: 'permission denied' };
  for (const items of [
    [textItem, errorItem],
    [errorItem, textItem],
  ]) {
    for (const result of [items, JSON.stringify(items)]) {
      assertLocalControlReadDoesNotCertify({
        tool: 'workflow_get',
        args: WORKFLOW_READ_ARGS,
        result,
        assertOutcome: 'succeeded',
      });
    }
  }
});

test('returned-event wrapper contradictions cannot launder a canonical result sibling', () => {
  for (const returnedDataExtras of [
    { ok: false },
    { error: 'failed' },
    { status: 'failed' },
  ]) {
    assertLocalControlReadDoesNotCertify({
      tool: 'workflow_get',
      args: WORKFLOW_READ_ARGS,
      returnedDataExtras,
      assertOutcome: 'succeeded',
    });
  }
});

test('an incidental catalog workflow cannot certify when the explicitly named target is absent', () => {
  workflowStore.deleteWorkflow('platform-49-slack-channel-review');
  workflowStore.writeWorkflow('schedule', {
    name: 'schedule',
    description: 'An intentionally colliding incidental catalog noun.',
    enabled: true,
    steps: [{ id: 'read', prompt: 'Read the schedule.' }],
  });
  try {
    const task = acceptActivatedAction(WORKFLOW_READ_OBJECTIVE);
    const settled = settleReturnedLocalControlRead({
      task,
      tool: 'workflow_get',
      args: { name: 'schedule', section: 'metadata', step: null },
      result: WORKFLOW_READ_RESULT,
    });
    assert.equal(settled.outcome.kind, 'succeeded');
    const prepared = preparation.prepareAcceptedTaskTerminal({
      ...task,
      proposedReply: 'Done. I read the requested workflow and verified its schedule.',
    });
    assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
    assert.deepEqual(
      prepared.status === 'needs_verification' ? prepared.missing : [],
      ['work_contract_missing'],
    );
  } finally {
    workflowStore.deleteWorkflow('schedule');
  }
});

test('a catalog slug prefix cannot certify when the explicitly named target is absent', () => {
  workflowStore.deleteWorkflow('platform-49-slack-channel-review');
  workflowStore.writeWorkflow('platform-49', {
    name: 'Platform 49',
    description: 'An intentionally colliding prefix of the requested workflow.',
    enabled: true,
    steps: [{ id: 'read', prompt: 'Read Platform 49.' }],
  });
  try {
    for (const objective of [
      WORKFLOW_READ_OBJECTIVE,
      'CANARY-WORKFLOW-READ: Read only the frontmatter for workflow Platform 49 Slack Channel Review. '
        + 'Do not run or update it, and return only its schedule and timezone.',
      'CANARY-WORKFLOW-READ: Read only the frontmatter for workflow Platform 49 with Slack Channel Review. '
        + 'Do not run or update it, and return only its schedule and timezone.',
      'CANARY-WORKFLOW-READ: Read only the frontmatter for workflow Platform 49 and Slack Channel Review. '
        + 'Do not run or update it, and return only its schedule and timezone.',
    ]) {
      const task = acceptActivatedAction(objective);
      const settled = settleReturnedLocalControlRead({
        task,
        tool: 'workflow_get',
        args: { name: 'platform-49', section: 'metadata', step: null },
        result: WORKFLOW_READ_RESULT,
      });
      assert.equal(settled.outcome.kind, 'succeeded');
      const prepared = preparation.prepareAcceptedTaskTerminal({
        ...task,
        proposedReply: 'Done. I read the requested workflow and verified its schedule.',
      });
      assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
      assert.deepEqual(
        prepared.status === 'needs_verification' ? prepared.missing : [],
        ['work_contract_missing'],
      );
    }
  } finally {
    workflowStore.deleteWorkflow('platform-49');
  }
});

test('workflow_get event arguments whose digest differs from settlement cannot certify it', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    eventArgs: { ...WORKFLOW_READ_ARGS, step: '1' },
    assertOutcome: 'succeeded',
  });
});

test('a sibling event call id cannot borrow a workflow_get settlement', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    eventCallId: `toolu_local_control_read_sibling_${serial + 1}`,
    assertOutcome: 'succeeded',
  });
});

test('a workflow_get return misparented to the accepted source cannot certify it', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    returnedParent: 'accepted_source',
    assertOutcome: 'succeeded',
  });
});

test('an empty local workflow_get result cannot certify the requested read', () => {
  assertLocalControlReadDoesNotCertify({
    tool: 'workflow_get',
    args: WORKFLOW_READ_ARGS,
    result: '',
    assertOutcome: 'empty_result',
  });
});

// The fan-out lane's durable work manifest is completion authority for an
// accepted action that never froze a work_call contract: refusing it replaced
// a fully settled 12/12 completion with a canned blocked terminal (live
// 2026-08-11, long-horizon-manifest run 5).
test('a fully settled source-bound work manifest publishes done without a frozen work contract', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-fanout-manifest',
    contractVersion: '1',
    phases: [{ id: 'analyze' }, { id: 'validate', dependsOn: ['analyze'] }],
    items: [{ id: 'record-001' }, { id: 'record-002' }],
  });
  for (const phase of ['analyze', 'validate']) {
    for (const itemId of ['record-001', 'record-002']) {
      workManifest.checkpointWorkItem({
        sessionId: task.sessionId,
        manifestId: 'pin-fanout-manifest',
        contractVersion: '1',
        phase,
        itemId,
        status: 'succeeded',
        evidence: [{ kind: 'worker_result', ref: `worker:${phase}:${itemId}` }],
      });
    }
  }
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /4 item-phase\(s\)/,
  );
});


// A mid-run contract revision (steer) supersedes earlier checkpoints; they
// remain in the ledger as STALE history. Completion is judged on canonical
// current coverage — a steered task that redid all items under v2 carried 42
// stale v1 rows and was wrongly blocked (live 2026-08-11,
// background-steer-in-flight, goal validation had already passed).
test('a revised manifest fully settled under the new contract publishes despite stale rows', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-steered-manifest',
    contractVersion: '1',
    phases: [{ id: 'research' }],
    items: [{ id: 'account-01' }],
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    contractVersion: '1',
    phase: 'research',
    itemId: 'account-01',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:v1:account-01' }],
  });
  workManifest.reviseWorkContract({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    fromVersion: '1',
    toVersion: '2',
    instruction: 'Use the corrected keyword for every account.',
    evidencePolicy: 'redo',
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-steered-manifest',
    contractVersion: '2',
    phase: 'research',
    itemId: 'account-01',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:v2:account-01' }],
  });
  const summary = workManifest.summarizeWorkManifest(task.sessionId, 'pin-steered-manifest');
  assert.ok((summary?.staleCheckpoints ?? 0) > 0, 'the superseded v1 checkpoint is stale history');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
});

test('a half-settled work manifest keeps the verification gap and names the open phases', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  workManifest.declareWorkManifest({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: 'pin-open-manifest',
    contractVersion: '1',
    phases: [{ id: 'analyze' }],
    items: [{ id: 'record-001' }, { id: 'record-002' }],
  });
  workManifest.checkpointWorkItem({
    sessionId: task.sessionId,
    manifestId: 'pin-open-manifest',
    contractVersion: '1',
    phase: 'analyze',
    itemId: 'record-001',
    status: 'succeeded',
    evidence: [{ kind: 'worker_result', ref: 'worker:analyze:record-001' }],
  });
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'needs_verification' ? prepared.reason : '',
    /not fully settled/,
  );
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['cardinality_item_missing'],
  );
});

test('a worked turn without manifest or contract publishes on its durable work evidence', () => {
  // The dispatch lands in the pre-activation window (restart/bridge race) —
  // post-activation, the dispatch-ledger backstop refuses unbound dispatch
  // outright. A turn that DID work publishes as it always has; the
  // zero-evidence action-claim pin below is what fails closed.
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Write the current office calendar time to the local note now.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq };
  const identity = {
    ...task,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId: `logical:terminal-preparation:mutating:${serial}`,
    physicalDispatchId: `dispatch:terminal-preparation:mutating:${serial}`,
    ordinal: 0,
  };
  // A provider business dispatch is refused pre-dispatch without a binding
  // (work_binding_required backstop) — the mutation lane this branch guards is
  // the LOCAL one, where a mutating local execution settles without any
  // provider crossing.
  const begun = dispatch.beginPhysicalDispatch({
    identity,
    tool: 'write_file',
    args: { path: '/tmp/pin.txt', content: 'x' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'write_file',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      ...task,
      turn: 1,
      acceptedTaskId: identity.acceptedTaskId,
      logicalToolCallId: identity.logicalToolCallId,
    },
    contract: { toolName: 'write_file', args: { path: '/tmp/pin.txt', content: 'x' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { path: '/tmp/pin.txt', bytesWritten: 1 } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: 1 },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'ready' ? prepared.verdict.facts.join('; ') : '',
    /durable work evidence/,
  );
});

// A question about current state is retrieval, not an action whose lack of
// mutations can be waved through as conversation. It must remain read work and
// obtain accepted-source-local freshness evidence before publication.
test('a current-state question is not activated as an action and waits for read evidence', () => {
  const task = accept('what time is it?');
  const activated = admission.activateActionExpectedWork(task);
  assert.equal(activated.status, 'not_action', JSON.stringify(activated));
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.ok(
    prepared.status === 'needs_verification'
      && (
        prepared.missing.includes('requirement_unobserved')
        || prepared.missing.includes('freshness_current_state_read_missing')
      ),
    JSON.stringify(prepared),
  );
});


// The classifier reads reply-directives as action intent ("ping — reply with
// one word" scored action 0.65, identical to a real work ask). The reply
// decides: claim-free content publishes; a claim-shaped "Done." with zero
// evidence still holds (live 2026-08-11 dev-daemon smoke: plain ping was
// replaced by the verification hold on the real home).
test('a zero-evidence action terminal publishes a claim-free reply and holds a claim-shaped one', () => {
  const task = acceptActivatedAction('ping the harness and reply with one word please');
  const published = preparation.prepareAcceptedTaskTerminal({ ...task, proposedReply: 'pong' });
  assert.equal(published.status, 'ready', JSON.stringify(published));
  const held = preparation.prepareAcceptedTaskTerminal({ ...task, proposedReply: 'Done from the model.' });
  assert.equal(held.status, 'needs_verification', JSON.stringify(held));
});

test('a zero-call done claim on an action-intent ask still fails closed', () => {
  const task = acceptActivatedAction('Email alex@example.com the update for every record.');
  const prepared = preparation.prepareAcceptedTaskTerminal(task);
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['work_contract_missing'],
  );
});

test('an accepted action that bypassed durable activation fails closed at terminal preparation', () => {
  const session = eventlog.createSession({ id: `terminal-preparation-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Email alex@example.com with the update.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  assert.deepEqual(contracts.requireKnownExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }), { status: 'action_deferred' });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(prepared.status, 'conflict', JSON.stringify(prepared));
  assert.match(
    prepared.status === 'conflict' ? prepared.reason : '',
    /not durably activated before execution/,
  );
});

test('a retrieve answered through an unbound local CLI execution publishes done (live 2026-08-11)', () => {
  // The exact incident shape: "How do I access Salesforce?" compiled to the
  // deterministic retrieve route, the model answered through one read-only
  // `sf` CLI call (an UNBOUND agents_runner local execution, classified
  // 'compute' by the safety taxonomy), the answer was complete and the
  // delivery verdict passed — and the terminal still blocked as
  // verification_required, replacing the answer with fallback text.
  const task = accept('How do I access Salesforce?');
  const args = { command: 'sf org display user --json' };
  const logicalToolCallId = `logical:terminal-preparation:${serial}:shell`;
  assert.equal(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: 'run_shell_command',
    args,
  }).status, 'inserted');
  const settled = attempts.settleToolAttempt({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    lane: 'agents_runner',
    toolName: 'run_shell_command',
    callId: logicalToolCallId,
    args,
    mutating: false,
    businessCall: true,
    result: JSON.stringify({
      status: 0,
      result: {
        instanceUrl: 'https://example.my.salesforce.com',
        username: 'user@example.com',
        connectedStatus: 'Connected',
      },
    }),
  });
  assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Go to https://example.my.salesforce.com and sign in as user@example.com.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length,
    1,
    'the retrieve resolution finalizes instead of holding the turn open',
  );
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['obligation_manifest'] }).length,
    1,
  );
});

test('a retrieve answered by a provider collection read without a completeness signal publishes done (live 2026-08-12)', () => {
  // The calendar incident: "What's on my calendar tomorrow?" compiled to the
  // deterministic retrieve route; the Composio Outlook read dispatched,
  // settled succeeded with 10 records, NO cursor and completeness 'unknown' —
  // a bounded view has nothing more to say. The old completeness obligation
  // demanded exhaustion proof the provider cannot express, and the terminal
  // replaced a correct grounded answer with verification_required fallback.
  const task = accept('Find all current alpha records.');
  settleRead({
    task,
    tool: 'alpha_records_list_view',
    args: { window: 'tomorrow' },
    payload: {
      successful: true,
      data: { records: [{ id: 'evt-1' }, { id: 'evt-2' }] },
      // Deliberately NO meta.complete and NO cursor: completeness stays
      // 'unknown', which previously could never discharge the read.
    },
  });
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'You have two events tomorrow.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.status === 'ready' && prepared.verdict.status, 'done');
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['evidence_receipt'] }).length, 1);
  assert.equal(eventlog.listEvents(task.sessionId, { types: ['obligation_satisfied'] }).length, 1);
});

/**
 * A turn that TRIED to act, never got a plan admitted, and performed no
 * business call may not answer as though it were ordinary conversation.
 *
 * Live 2026-08-26 (sess-mob-3c4d…, sourceUserSeq 90213): asked "how many
 * accounts does my team have by seller", Clem ran discovery, attempted
 * plan_task SEVEN times — every one refused "cites a capability that was not
 * disclosed to this source" — settled ZERO business calls, and then published
 * status `done`, kind `answer`:
 *
 *   "I can confirm 120 accounts across 8 active sellers, but I can't
 *    retrieve the live owner-by-owner breakdown right now."
 *
 * Both numbers were invented, "I can confirm" asserted verification that never
 * happened, and the honest-sounding hedge about the breakdown made the
 * fabrication MORE credible. A tool that fails loudly costs a retry; one that
 * fabricates a figure and calls it confirmed costs a decision.
 *
 * Whether evidence was REQUIRED was being decided by a regex over the user's
 * wording (`today|now|latest|…`). That question has nothing to do with phrasing:
 * the durable record already shows what the turn itself decided it needed.
 * Repeated plan_task attempts with no admitted contract are not "this was never
 * action work" — they are action work that failed to admit.
 */
test('a source that attempted action admission and did nothing cannot answer as done', () => {
  // This is the live-shaped failed-admission state: graph accepted, but every
  // plan_task attempt refused before any expected-work contract could freeze.
  const task = acceptWithoutExpectedWork('How many accounts does my team have by seller');

  // The model decided this needed action and tried repeatedly; nothing was ever
  // admitted, and no business call settled.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    eventlog.appendEvent({
      sessionId: task.sessionId,
      turn: task.turn,
      role: 'system',
      type: 'tool_called',
      data: { sourceUserSeq: task.sourceUserSeq, tool: 'plan_task', callId: `plan-${attempt}` },
    });
  }

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.notEqual(prepared.status, 'ready',
    'a turn that provably performed no work must not be cleared to answer as done');
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  if (prepared.status !== 'needs_verification') return;
  assert.ok(
    prepared.missing.includes('action_attempted_without_evidence'),
    `the hold must name the real reason, got ${JSON.stringify(prepared.missing)}`,
  );
});

test('a failed admission attempt does not override successful business evidence', () => {
  const task = acceptWithoutExpectedWork('How many accounts does my team have by seller');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'tool_called',
    data: { sourceUserSeq: task.sourceUserSeq, tool: 'plan_task', callId: 'plan-before-read' },
  });
  settleRead({
    task,
    tool: 'accounts_by_seller',
    args: { groupBy: 'seller' },
    payload: {
      successful: true,
      data: { records: [{ seller: 'Alex', accounts: 12 }] },
      meta: { complete: true },
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(prepared.status, 'unstaged', JSON.stringify(prepared));
});

test('a frozen zero-operation contract cannot launder a later failed action admission', () => {
  const task = accept('Hello, how are you?');
  const contract = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(contract.status, 'ok', JSON.stringify(contract));
  if (contract.status !== 'ok') return;
  assert.equal(contract.contract.operations.length, 0, 'fixture must reach the zero-op finalization path');

  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'tool_called',
    data: { sourceUserSeq: task.sourceUserSeq, tool: 'plan_task', callId: 'plan-zero-op' },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['action_attempted_without_evidence'],
  );
});

test('an ordinary conversational turn that never attempted action is unaffected', () => {
  const task = accept('hey how is it going');
  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.notEqual(prepared.status, 'needs_verification',
    'plain conversation owes no external evidence; this gate must not touch it');
});

test('failed discovery for an unplanned current-state read cannot publish done (live source 91056)', () => {
  const task = acceptBeforePlanning(
    'Read the single most recent message in my Outlook Inbox and return only its subject and received time.',
  );
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'tool_search',
      callId: 'discovery-timeout',
      canonicalCallId: 'discovery-timeout',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      callId: 'discovery-timeout',
      outcome: 'timed_out',
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'I cannot complete this read here. ASK: Could you re-run it?',
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['discovery_attempted_without_business_evidence'],
  );
});

test('successful tool discovery for an ordinary catalog question remains a completed answer', () => {
  const task = acceptBeforePlanning('Which tools are available in this session?');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'tool_search',
      callId: 'discovery-success',
      canonicalCallId: 'discovery-success',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      callId: 'discovery-success',
      outcome: 'succeeded',
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'Outlook and Slack tools are available.',
  });
  assert.equal(prepared.status, 'unstaged', JSON.stringify(prepared));
});

test('a failed tool search while answering an ordinary catalog question remains conversational', () => {
  const task = acceptBeforePlanning('Which tools are available in this session?');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'tool_search',
      callId: 'ordinary-discovery-timeout',
      canonicalCallId: 'ordinary-discovery-timeout',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      callId: 'ordinary-discovery-timeout',
      outcome: 'timed_out',
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'The catalog search timed out.',
  });
  assert.equal(prepared.status, 'unstaged', JSON.stringify(prepared));
});

test('failed discovery for a graph-classified retrieve holds even without freshness wording', () => {
  const task = acceptWithoutExpectedWork('Find emails from Bob.');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'tool_search',
      callId: 'retrieve-discovery-timeout',
      canonicalCallId: 'retrieve-discovery-timeout',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      callId: 'retrieve-discovery-timeout',
      outcome: 'timed_out',
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'I could not search the mailbox because discovery timed out.',
  });
  assert.equal(prepared.status, 'needs_verification', JSON.stringify(prepared));
  assert.deepEqual(
    prepared.status === 'needs_verification' ? prepared.missing : [],
    ['discovery_attempted_without_business_evidence'],
  );
});

test('graph-backed catalog introspection remains conversational after failed discovery', () => {
  const task = acceptWithoutExpectedWork('Which tools are available in this session?');
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      tool: 'tool_search',
      callId: 'graph-catalog-discovery-timeout',
      canonicalCallId: 'graph-catalog-discovery-timeout',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  eventlog.appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: task.sourceUserSeq,
      callId: 'graph-catalog-discovery-timeout',
      outcome: 'timed_out',
    },
  });

  const prepared = preparation.prepareAcceptedTaskTerminal({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposedReply: 'The catalog search timed out.',
  });
  assert.equal(prepared.status, 'unstaged', JSON.stringify(prepared));
});
