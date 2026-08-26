import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-agent-brain-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const brain = await import('./claude-agent-brain.js');
const { bumpStableContextGeneration } = await import('../stable-context-generation.js');
const {
  claudeAgentSdkBrainMode,
  claudeAgentSdkBrainEnabled,
  renderClaudeAgentBrainSystemAppend,
  renderClaudeAgentBrainTurnContext,
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainPostTurnHooksForTest,
  setClaudeAgentSdkBrainJudgeForTest,
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest,
  setClaudeAgentSdkBrainPreflightConversationPortForTest,
  setClaudeAgentSdkBrainSearchFactsHybridForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
  looksLikeToolNarration,
  looksLikeReasoningLeak,
  shouldJudgeClaudeCompletion,
  frameTrustedMemory,
  invalidateStableMemorySnapshot,
  claudeAgentSdkAdvertisedToolUniverse,
  partitionClaudeAgentSdkJitSurface,
  resolveClaudeAgentBrainMaxTurns,
  durableMemoryReceiptAllowsConversationOnly,
} = brain;
const UNAVAILABLE_TERMINAL_DELIVERY_JUDGE = {
  async resolveRoute() { return null; },
  async run() { throw new Error('unavailable fixture must not run'); },
} satisfies import('./terminal-delivery-judge.js').TerminalDeliveryJudgePort;
const {
  accrueSessionTokens,
  appendEvent,
  beginRunAttempt,
  claimHarnessChatRequest,
  closeEventLog,
  conversationPreambleDeliveryRequest,
  createSession,
  getLatestRunAttempt,
  getSession,
  listEvents,
  requestKill,
  recordRunAttemptUserInput,
  resetEventLog,
  writeToolOutput,
} = await import('./eventlog.js');
const { saveUserProfile } = await import('../user-profile.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { _setOpennessJudgeForTests } = await import('./turn-openness.js');
const { readUsageEventsForDate, recordModelUsage } = await import('../usage-log.js');
const {
  ClaudeSdkProviderOverloadError,
  ClaudeSdkContextOverflowError,
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest,
} = await import('./claude-agent-sdk.js');
const capabilityHealth = await import('./capability-health.js');
const artifactLedger = await import('./artifact-ledger.js');
const { closeMemoryDb, openMemoryDb } = await import('../../memory/db.js');
const { rememberFact } = await import('../../memory/facts.js');
const { clearFocus, createFocus, patchFocusWorkstate } = await import('../../memory/focus.js');
const { createGoalContract } = await import('../../agents/plan-proposals.js');
const { workingMemoryPathForSession } = await import('../../memory/working-memory.js');
const {
  cancelProspectiveIntention,
  closeProspectiveIntentionsDbForTest,
  upsertProspectiveIntention,
} = await import('../prospective-intentions.js');
const pendingActions = await import('./pending-actions.js');
const approvalRegistry = await import('./approval-registry.js');
const {
  createWorkflowChatDispatchPreparationAuthority,
  createWorkflowChatDispatchPreparedReceipt,
  recordWorkflowChatDispatchPreparation,
  workflowChatDispatchQueueRequestDigest,
} = await import('../../execution/workflow-origin-group.js');
const { workflowOriginReplyTargetForSource } = await import('../workflow-origin-authority.js');
const { exactOriginDeliveryTargetDigest } = await import('../exact-origin-delivery.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { beginPhysicalDispatch, settlePhysicalDispatch } = await import('./dispatch-ledger.js');
const { classifyAttemptOutcome } = await import('./attempt-outcome.js');
const { commitLogicalCallSettlement } = await import('./logical-call-settlement-store.js');
const { redeemSuccessfulSettlementResultForHost } = await import('./result-handle.js');

/**
 * Settlement anchor for stubbed retrieve turns (authority spine, ffae7dbd).
 *
 * The terminal committer publishes `done` for a retrieve-classified accepted
 * task only after the ONE business read its frozen deterministic contract
 * admits has durably settled (dispatch ledger + logical-call settlement).
 * `setClaudeAgentSdkBrainRunForTest` bypasses real dispatch, so fixtures that
 * stub the run must settle that admitted read themselves — exactly once per
 * accepted task — or truth downgrades the committed answer.
 */
let fixtureSettledReadSerial = 0;
function settleAdmittedRead(input: { sessionId: string; sourceUserSeq: number }): void {
  const task = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: 1,
    acceptedTaskId: acceptedTaskIdFor(input.sessionId, input.sourceUserSeq),
  };
  const id = `brain-fixture-read:${++fixtureSettledReadSerial}`;
  const tool = 'read_file';
  const args = { path: 'fixture.txt', max_chars: 100 };
  const logicalToolCallId = `logical:${id}`;
  const begun = beginPhysicalDispatch({
    identity: {
      ...task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${id}`,
      ordinal: 0,
    },
    tool,
    args,
    executionSite: 'host',
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  assert.equal(settlePhysicalDispatch({
    identity: begun.identity,
    tool,
    outcome: 'returned',
  }).status, 'inserted');
  const settled = commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'local_execution' },
    result: {
      payload: {
        successful: true,
        data: { content: 'fixture answer-bearing content' },
        meta: { complete: true },
      },
    },
    outcome: classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  const redeemed = redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  if (redeemed.status === 'ok') {
    assert.equal(redeemed.value.executionSite, 'host', JSON.stringify(redeemed.value));
  }
}

function installPreparedClaudeWorkflowDispatch(input: {
  sessionId: string;
  sourceUserSeq: number;
  runId: string;
}): void {
  const source = listEvents(input.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === input.sourceUserSeq);
  assert.ok(source);
  const replyTarget = workflowOriginReplyTargetForSource(input);
  assert.ok(replyTarget);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${input.runId}.json`), JSON.stringify({
    id: input.runId,
    workflow: 'claude-dispatch-fixture',
    status: 'awaiting_chat_dispatch_seal',
    createdAt: new Date().toISOString(),
  }), 'utf-8');
  const authority = createWorkflowChatDispatchPreparationAuthority({
    runId: input.runId,
    observer: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      replyTarget,
    },
    queueRequestDigest: workflowChatDispatchQueueRequestDigest({
      workflowName: 'claude-dispatch-fixture',
      normalizedInputs: {},
    }),
  });
  const event = appendEvent({
    sessionId: input.sessionId,
    turn: source.turn,
    role: 'system',
    type: 'async_work_dispatch_prepared',
    parentEventId: source.id,
    data: { ...authority },
  });
  recordWorkflowChatDispatchPreparation(createWorkflowChatDispatchPreparedReceipt(authority, {
    eventId: event.id,
    eventSeq: event.seq,
    preparedAt: event.createdAt,
  }));
}

beforeEach(() => {
  resetEventLog();
  artifactLedger._resetArtifactLedgerForTests();
  capabilityHealth._resetHarnessCapabilityHealthForTest();
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(UNAVAILABLE_TERMINAL_DELIVERY_JUDGE);
  setClaudeAgentSdkBrainPreflightConversationPortForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query, hits: [], perStore: {}, answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
  _setOpennessJudgeForTests(null);
  _resetClaudeAgentSdkAdvertisableLocalToolsForTest();
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_ALLOWED_TOOLS;
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN_MAX_TURNS;
  delete process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE;
  delete process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT;
  delete process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY;
  delete process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE;
  delete process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS;
  delete process.env.CLEMMY_CLAUDE_TOOL_SEARCH;
  delete process.env.CLEMMY_TOOL_JIT;
  delete process.env.CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS;
  delete process.env.CLEMMY_UNIFIED_RECALL;
  delete process.env.CLEMMY_UNIFIED_TURN_PRIMER;
  delete process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY;
  process.env.AUTH_MODE = 'api_key';
});

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  setClaudeAgentSdkBrainJudgeForTest(null);
  setClaudeAgentSdkBrainTerminalDeliveryJudgePortForTest(null);
  setClaudeAgentSdkBrainPreflightConversationPortForTest(null);
  setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  closeProspectiveIntentionsDbForTest();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('Claude brain closes a prepared workflow batch as a nonterminal dispatch before judge or narration', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'on';
  const sessionId = 'claude-workflow-dispatch-graph';
  const runId = 'claude-workflow-dispatch-run';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'dispatch graph' });
  let judgeCalls = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: false, reason: 'the eventual workflow result is not available yet' };
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.equal(options.sessionId, sessionId);
    assert.ok(options.sourceUserSeq);
    installPreparedClaudeWorkflowDispatch({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
      runId,
    });
    return {
      text: 'I kicked it off and will report back when it finishes.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: ['mcp__clementine-local__workflow_run'],
      successfulToolUses: ['workflow_run'],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Run the saved review workflow.',
    sessionId,
    channel: 'desktop',
  });

  assert.equal(response.text, 'Started — I’ll post the result here when it’s ready.');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(judgeCalls, 0, 'eventual workflow work never enters the foreground completion judge');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['async_work_dispatch_batch_closed'] }).length, 1);
  const dispatches = listEvents(sessionId, { types: ['async_work_dispatched'] });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].data.runIds, [runId]);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8')) as {
    status?: string;
  };
  assert.equal(run.status, 'queued');
  assert.deepEqual((response.raw as { asyncWork?: { runIds?: string[] } }).asyncWork?.runIds, [runId]);
  assert.equal(getSession(sessionId)?.metadata.__run_in_flight, undefined);
  assert.equal(getSession(sessionId)?.metadata.__run_in_flight_owner, undefined);
});

test('Claude brain preserves a prepared workflow handoff when the provider throws after workflow_run', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'claude-workflow-dispatch-provider-error';
  const runId = 'claude-workflow-dispatch-provider-error-run';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'dispatch provider error' });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    installPreparedClaudeWorkflowDispatch({
      sessionId,
      sourceUserSeq: options.sourceUserSeq!,
      runId,
    });
    throw new Error('provider disconnected after workflow_run returned');
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Run the saved review workflow.',
    sessionId,
    channel: 'desktop',
  });

  assert.equal(response.text, 'Started — I’ll post the result here when it’s ready.');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['conversation_failed'] }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['async_work_dispatch_batch_closed'] }).length, 1);
  const dispatches = listEvents(sessionId, { types: ['async_work_dispatched'] });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0].data.runIds, [runId]);
  const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8')) as {
    status?: string;
  };
  assert.equal(run.status, 'queued');
  assert.equal(getSession(sessionId)?.metadata.__run_in_flight, undefined);
  assert.equal(getSession(sessionId)?.metadata.__run_in_flight_owner, undefined);
});

test('JIT monotonic floor: the per-session advertised tool set only GROWS (cache-stable), never shrinks', () => {
  const { bumpSessionToolFloor } = brain as { bumpSessionToolFloor: (s: string, e: Iterable<string>) => Set<string> };
  const sid = 'jit-mono-test';
  assert.deepEqual([...bumpSessionToolFloor(sid, ['a', 'b'])].sort(), ['a', 'b']);
  // Turn 2 needs only 'c' — but the floor must GROW, not shrink to just 'c'.
  assert.deepEqual([...bumpSessionToolFloor(sid, ['c'])].sort(), ['a', 'b', 'c']);
  // Turn 3 needs only 'a' — floor stays stable (converged → the tools block is now
  // identical turn-to-turn → the prompt cache holds).
  assert.deepEqual([...bumpSessionToolFloor(sid, ['a'])].sort(), ['a', 'b', 'c']);
  // A different session has its own independent floor.
  assert.deepEqual([...bumpSessionToolFloor('other-session', ['x'])].sort(), ['x']);
});

test('the schema-on-demand path applies the monotonic floor too — a stable tools block is the cache', async () => {
  // The floor existed and was wired to only ONE of the two JIT branches. The
  // branch the desktop actually runs recomputed its hot set per turn, so the
  // advertised set moved (live: 4 → 5 → 8 → 10, and one 8 → 7). A changed tool
  // DEFINITION invalidates tools + system + the whole message history, so those
  // turns rebuilt the entire prompt cache — measured hit ratio ~0.88 with dips
  // to 0.74 exactly at those boundaries. Same class of bug as every other one
  // tonight: the capability existed, on one path, and nothing noticed the other
  // path lacked it.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./claude-agent-brain.ts', import.meta.url), 'utf8');
  const schemaOnDemandBranch = source.slice(
    source.indexOf('if (schemaOnDemandAcquisition)'),
    source.indexOf("jitReason = 'schema-on-demand-dispatch'"),
  );
  assert.ok(schemaOnDemandBranch.length > 0, 'the schema-on-demand branch must still exist');
  assert.match(schemaOnDemandBranch, /bumpSessionToolFloor\(/,
    'schema-on-demand must stabilise its advertised set or it busts the prompt cache every turn');
  assert.match(schemaOnDemandBranch, /jitMonotonicEnabled\(\)/,
    'and must honour the same kill-switch as the sibling branch');
  // Order determinism is the OTHER documented way to break this cache: the
  // advertised list must be built by filtering the stable universe array, never
  // by iterating a Set.
  assert.match(schemaOnDemandBranch, /advertisedUniverse\.filter\(/,
    'advertised order must come from the stable array, not from set iteration');
});

test('Claude brain receives the same relevance-gated future commitments without a permanent context tax', async () => {
  upsertProspectiveIntention({
    id: 'background:orchid-research',
    sourceKind: 'background',
    sourceId: 'orchid-research',
    objective: 'Report back with the Orchid market research',
    trigger: { kind: 'completion', resourceType: 'background_task', resourceId: 'orchid-research' },
    action: { kind: 'report_back', ref: 'orchid-research' },
    sessionId: 'brain:orchid',
    risk: 'read',
    approvalMode: 'none',
  });
  try {
    const relevant = await renderClaudeAgentBrainTurnContext({
      message: 'What is happening with the Orchid research?',
      sessionId: 'brain:orchid',
    });
    assert.match(relevant, /RELEVANT FUTURE INTENTIONS/);
    assert.match(relevant, /Report back with the Orchid market research/);

    const unrelated = await renderClaudeAgentBrainTurnContext({
      message: 'What is the capital of France?',
      sessionId: 'brain:other',
    });
    assert.doesNotMatch(unrelated, /RELEVANT FUTURE INTENTIONS/);

    const capture = await renderClaudeAgentBrainTurnContext({
      message: 'Notify me when the Orchid launch report arrives.',
      sessionId: 'brain:other',
    });
    assert.match(capture, /Prospective-intention signal/);
  } finally {
    cancelProspectiveIntention('background:orchid-research', 'test_cleanup');
  }
});

test('completion judge targets suspicious text and skips concrete tool-backed results', () => {
  assert.equal(
    shouldJudgeClaudeCompletion('write the brief', 'Done - saved and verified the brief.', ['write_file', 'run_shell_command']),
    false,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', "I'll send the remaining emails next.", ['composio_execute_tool']),
    true,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('create the workflow', 'Created the workflow.', []),
    true,
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['memory_search', 'composio_search_tools']),
    true,
    'probe-only calls are not completion evidence',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['ask_user_question']),
    true,
    'a control-only ask cannot certify a send',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('build the app', 'Built the app.', ['read_file']),
    true,
    'a partial read cannot certify a mutating objective',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['GMAIL_FETCH_EMAILS']),
    true,
    'a concrete read slug cannot certify a send',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the emails', 'Sent the emails.', ['GMAIL_SEND_EMAIL']),
    true,
    'one successful send cannot certify a plural objective',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('send the email', 'Sent the email.', ['GMAIL_SEND_EMAIL']),
    false,
    'a successful concrete send still certifies a singular objective',
  );
  assert.equal(
    shouldJudgeClaudeCompletion(
      [
        'Refresh the proof release queue current items from the same connected source.',
        'Reuse the capability already proved on this machine. Do not discover, inspect a contract, use code mode, shell, workspace, or memory.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'),
      'Refreshed from the connected source.',
      ['PROOF_LIST_TASKS'],
    ),
    false,
    'one concrete collection read does not pay a judge merely for a bare plural noun',
  );
  assert.equal(
    shouldJudgeClaudeCompletion('Refresh both reports.', 'Refreshed the reports.', ['REPORT_LIST_CURRENT']),
    true,
    'explicit multiplicity retains completion verification',
  );
});

test('JIT monotonic floor: the EMITTED allowlist string is byte-identical once converged (the actual prompt-cache precondition)', () => {
  const { bumpSessionToolFloor } = brain as { bumpSessionToolFloor: (s: string, e: Iterable<string>) => Set<string> };
  const sid = 'jit-mono-emit';
  // fullAllowed is the stable per-turn ordering the brain filters against; the
  // advertised allowlist = fullAllowed.filter(in floor).join(',') — what the SDK
  // hashes for the tools-block cache key. Order must come from fullAllowed (stable),
  // NOT floor insertion order, so a converged set always serializes identically.
  const fullAllowed = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const emit = (floor: Set<string>): string => fullAllowed.filter((n) => floor.has(n)).join(',');

  // Turn 1: intent surfaces charlie+alpha. Turn 2: bravo (grows — one cache bust).
  emit(bumpSessionToolFloor(sid, ['charlie', 'alpha']));
  const t2 = emit(bumpSessionToolFloor(sid, ['bravo']));
  // Turns 3..5 reselect already-floored tools in different orders → converged.
  const t3 = emit(bumpSessionToolFloor(sid, ['alpha']));
  const t4 = emit(bumpSessionToolFloor(sid, ['bravo', 'charlie']));
  const t5 = emit(bumpSessionToolFloor(sid, ['charlie']));
  // Byte-identical across the converged turns → the prefix cache-hits.
  assert.equal(t3, t2);
  assert.equal(t4, t2);
  assert.equal(t5, t2);
  // And the serialization follows fullAllowed order, not selection/insertion order.
  assert.equal(t2, 'alpha,bravo,charlie');
});

test('full-mode JIT keeps MCP advertisement separate from the permission fast-allow set', () => {
  const fastAllow = ['memory_recall', 'tool_search', 'workspace_roots'];
  const universe = claudeAgentSdkAdvertisedToolUniverse('full', fastAllow);
  assert.ok(universe.includes('task_hygiene'), 'catalog-only gated tools remain advertisable');
  assert.ok(universe.includes('focus_get'), 'real MCP tools outside the CLI catalog remain advertisable');
  assert.ok(universe.includes('workspace_roots'), 'local-runtime-only tools remain reachable through call_tool');
  assert.ok(!universe.includes('browser_harness_run'), 'CLI-only names absent from this MCP server are not promised');

  const selected = new Set(['memory_recall', 'tool_search', 'task_hygiene']);
  const partitioned = partitionClaudeAgentSdkJitSurface(fastAllow, universe, selected);
  assert.ok(partitioned.advertisedNames.includes('task_hygiene'));
  assert.ok(!partitioned.fastAllowNames.includes('task_hygiene'), 'catalog-only tools must still reach canUseTool');

  const readOnly = claudeAgentSdkAdvertisedToolUniverse('read_only', fastAllow);
  assert.ok(!readOnly.includes('task_hygiene'), 'non-agentic profiles remain capability-limited');
  assert.ok(!claudeAgentSdkAdvertisedToolUniverse('full', fastAllow, ['task_hygiene']).includes('task_hygiene'));
});

test('Move 1: the SDK brain ARMS the in-flight marker during the run and CLEARS it on completion', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker', kind: 'chat', title: 'm' });
  let armedDuringRun: string | null | undefined;
  setClaudeAgentSdkBrainRunForTest(async () => {
    // Captured INSIDE the run: a daemon crash here must be reportable → armed.
    armedDuringRun = HarnessSession.load('brain-marker')?.runInFlightSince() ?? null;
    return { text: 'done', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'hello', sessionId: 'brain-marker' });
  assert.notEqual(armedDuringRun, null, 'marker was ARMED during the run');
  assert.equal(HarnessSession.load('brain-marker')?.runInFlightSince(), null, 'marker CLEARED after completion');
  const source = listEvents('brain-marker', { types: ['user_input_received'] })[0];
  const graphs = listEvents('brain-marker', { types: ['turn_graph_compiled'] });
  assert.equal(graphs.length, 1, 'the Claude lane observes its exact accepted chat source once');
  assert.equal(graphs[0].parentEventId, source.id);
  assert.equal(graphs[0].data.sourceUserSeq, source.seq);
  assert.equal((graphs[0].data.graph as { source?: { surface?: unknown } }).source?.surface, 'home');
});

test('run-scoped stop registered before SDK dispatch is not erased and emits one terminal completion', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const sessionId = 'brain-pre-dispatch-stop';
  const runId = 'run-pre-dispatch-stop';
  createSession({ id: sessionId, kind: 'chat', title: 'stop me' });
  const attempt = beginRunAttempt(sessionId, { runId });
  requestKill(sessionId, 'Discord stop before model dispatch', attempt);
  let modelCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    modelCalls += 1;
    return { text: 'should not run', sessionId: 'sdk', model: 'm', toolUses: [] };
  });

  const response = await respondViaClaudeAgentSdkBrain('discord', {
    message: 'make the document',
    sessionId,
    runId,
  });

  assert.equal(response.stoppedReason, 'cancelled');
  assert.equal(modelCalls, 0, 'the stop wins before the first model/tool dispatch');
  const completions = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.data.reason, 'cancelled');
  assert.equal(completions[0]?.data.attemptId, attempt.attemptId);
  assert.equal(completions[0]?.data.runId, runId);
});

test('a late SDK completion remains owned by turn A after turn B becomes active', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const sessionId = 'brain-late-terminal-owner';
  createSession({ id: sessionId, kind: 'chat', title: 'overlapping attempts' });
  let firstAttemptId = '';
  let firstSourceUserSeq: number | null = null;
  let secondAttemptId = '';
  setClaudeAgentSdkBrainRunForTest(async () => {
    const first = getLatestRunAttempt(sessionId);
    firstAttemptId = first?.attemptId ?? '';
    firstSourceUserSeq = first?.sourceUserSeq ?? null;
    const second = beginRunAttempt(sessionId, { runId: 'run-turn-b' });
    secondAttemptId = second.attemptId;
    recordRunAttemptUserInput(second, {
      turn: 2,
      role: 'user',
      data: { text: 'Turn B' },
    }, { armRunInFlight: true });
    return { text: 'Turn A finished.', sessionId: 'sdk', model: 'm', toolUses: [] };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Turn A',
    sessionId,
    runId: 'run-turn-a',
  });

  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.ok(firstAttemptId);
  assert.equal(terminal?.data.attemptId, firstAttemptId);
  assert.equal(terminal?.data.runId, 'run-turn-a');
  assert.equal(terminal?.data.sourceUserSeq, firstSourceUserSeq);
  assert.notEqual(terminal?.data.attemptId, secondAttemptId);
  assert.equal(
    (getSession(sessionId)?.metadata.__run_in_flight_owner as { attemptId?: string } | undefined)?.attemptId,
    secondAttemptId,
    'late A terminal cleanup cannot erase newer B restart ownership',
  );
});

test('Claude SDK brain creates background sessions as execution sessions, not chat sessions', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'background result',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('background', {
    message: 'Hello Clem.',
    sessionId: 'brain-background-kind',
  });

  const session = getSession('brain-background-kind');
  assert.equal(session?.kind, 'execution');
  assert.equal(session?.metadata.source, 'claude-agent-sdk-brain:background');
});

test('Claude cron uses an execution SDK session, skips the expensive judge, and preserves plain-question awaiting', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let judgeCalls = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'done' };
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Which account should I update?',
    sessionId: 'sdk',
    model: 'claude-sonnet-4-6',
    toolUses: [],
  }));

  const response = await respondViaClaudeAgentSdkBrain('cron', {
    message: 'Update the account',
    sessionId: 'brain-cron-kind',
  });

  const session = getSession('brain-cron-kind');
  assert.equal(session?.kind, 'execution');
  assert.equal(session?.metadata.source, 'claude-agent-sdk-brain:cron');
  assert.equal(judgeCalls, 0, 'cron does not pay for completion-judge continuations');
  assert.equal(response.stoppedReason, 'awaiting-input', 'plain blocking questions still pause canonically');
});

test('durable memory receipt conversation boundary is exact and fails closed on additional work', () => {
  const correction = {
    message: "Small correction for later: Cedar is Cedar-17. A natural acknowledgement is enough.",
    candidates: [{ reason: 'explicit durable correction' }],
    queuedCandidateCount: 1,
    episodeId: 'episode-1',
  };
  assert.equal(durableMemoryReceiptAllowsConversationOnly(correction), true);
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({ ...correction, queuedCandidateCount: 0 }),
    false,
    'candidate detection without a durable receipt grants no shortcut',
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({ ...correction, episodeId: null }),
    false,
    'candidate ids without their durable episode grant no shortcut',
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      message: `${correction.message} Also create a local note.`,
    }),
    false,
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      message: 'Small correction for later: Cedar is Cedar-17. Also forget memory fact #1. A natural acknowledgement is enough.',
    }),
    false,
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      message: 'Small correction for later: Cedar is Cedar-17. What do you remember? A natural acknowledgement is enough.',
    }),
    false,
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      candidates: [{ reason: 'durable first-person declarative' }],
    }),
    false,
    'incidental fact capture never removes the ordinary agent surface',
  );
  for (const message of [
    'Small correction for later: Cedar is Cedar-17. Also forget Cedar-12. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Also use memory_forget on Cedar-12. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Also manage my stored Cedar knowledge. A natural acknowledgement is enough.',
    'Remember this: Cedar is Cedar-17. Also forget the old one. Just confirm.',
    'Small correction for later: Cedar is Cedar-17. Also what is 8 x 7. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Then multiply 8 x 7. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Translate Cedar into French. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Also inspect fact #1. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Clear the old memory. A natural acknowledgement is enough.',
    'Small correction for later: Cedar is Cedar-17. Purge Cedar-12. A natural acknowledgement is enough.',
    'Remember this: Cedar is Cedar-17. Give me three launch ideas. Just confirm.',
    'Remember this: Cedar is Cedar-17. Outline a rollout plan. Just confirm.',
    'Remember this: Cedar is Cedar-17. Recommend what we should do next. Just confirm.',
    'Remember this: Cedar is Cedar-17. Brainstorm launch angles. Just confirm.',
    'Remember this: Cedar is Cedar-17. Help me decide the next step. Just confirm.',
    'Remember this: Cedar is Cedar-17. Review the release notes. Just confirm.',
    'Remember this: Cedar is Cedar-17. Test the endpoint. Just confirm.',
    'Remember this: Cedar is Cedar-17. Verify the deployment. Just confirm.',
    'Remember this: Cedar is Cedar-17. Scrape the launch page. Just confirm.',
    'Remember this: Cedar is Cedar-17. Take a screenshot. Just confirm.',
    'Remember this: Cedar is Cedar-17. While you are here, summarize the plan. Just confirm.',
    'Remember this: Cedar is Cedar-17. If you are able, summarize the plan. Just confirm.',
    'Remember this: Cedar is Cedar-17. Since we are here, outline the rollout. Just confirm.',
    'Remember this: Cedar is Cedar-17 — give me three ideas. Just confirm.',
    'Remember this: Cedar is Cedar-17, plus brainstorm some names. Just confirm.',
    'Remember this: You are to review the checklist. Just confirm.',
    'Remember this: Cedar is Cedar-17. I need you to summarize the plan now. Just confirm.',
    'Remember this: Cedar is Cedar-17. I want you to review the checklist now. Just confirm.',
    'Remember this: Cedar is Cedar-17. We are here, so outline the rollout. Just confirm.',
    'Remember this: Cedar is Cedar-17. Our next task is to review the release notes now. Just confirm.',
  ]) {
    assert.equal(
      durableMemoryReceiptAllowsConversationOnly({ ...correction, message }),
      false,
      `additional work retains normal authority: ${message}`,
    );
  }
  for (const tail of [
    'and I have a question: what is 8 x 7',
    'and I wonder what else you remember',
    'and I need a summary of the launch',
    'and the old memory should be deleted',
    'and memory_forget should be called for fact 1',
    'and I want the report sent to alice@example.com',
    'and I would like to know what 8 x 7 is',
    'and I am curious what else you remember',
    'and I have something to ask about the launch',
    'and the memory_forget tool should be called',
    'and the report should be sent to alice@example.com',
    'and the document must be published',
    'and I expect a launch summary',
    "and I'd like to know what 8 x 7 is",
    'and I’d like to know what 8 x 7 is',
    'and I am wondering what else you remember',
    'and I was wondering what else you remember',
    'and I need to know what 8 x 7 is',
    'and I want to know what else you remember',
    'and one more question is what the launch date is',
    'and there is one more question about the launch',
    'and let memory_forget run for fact 1',
    'and memory_forget is the tool to run for fact 1',
    'and I need memory_forget run for fact 1',
    'and the spreadsheet needs to be updated',
    'and the deployment must be run',
    'and the payment needs to be refunded',
    'and the database needs to be migrated',
    'and the row needs to be inserted',
    'and the spreadsheet needs updated',
    'and the payment needs refunded',
    'and the database needs migrated',
    'and the row needs inserted',
    'and I was hoping you could summarize',
    "and let's review the launch",
    'and let us review the launch',
    'and we should review the launch',
    'and maybe review the launch',
    'and I have another ask: summarize the launch',
    'and I want you reviewing the launch',
    'and I could use a summary',
    'and the plan needs summarizing',
    'and I need you summarizing the launch',
    'and memory_forget needs running',
  ]) {
    const message = `Remember this: Cedar is Cedar-17 ${tail}. A natural acknowledgement is enough.`;
    assert.equal(
      durableMemoryReceiptAllowsConversationOnly({ ...correction, message }),
      false,
      `an unsplit secondary tail cannot borrow receipt authority: ${tail}`,
    );
  }
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      message: 'Remember this: Cedar is Cedar-17 and Cedar-12 is retired. A natural acknowledgement is enough.',
    }),
    true,
    'a second declarative fact remains a conversation-only memory payload',
  );
  assert.equal(
    durableMemoryReceiptAllowsConversationOnly({
      ...correction,
      message: 'Remember this: Cedar is Cedar-17 and memory_forget is deprecated. A natural acknowledgement is enough.',
    }),
    true,
    'a factual statement naming a tool is not mistaken for a tool request',
  );
});

test('SDK brain gives a receipt-backed acknowledgement-only correction zero tool authority and preserves Claude voice', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
  const sessionId = 'brain-memory-receipt-conversation-only';
  const message = "Small correction for later: Cedar's current release number is Cedar-17. Cedar-12 is retired and must not be used as current. A natural acknowledgement is enough.";
  const providerReply = "Got it — Cedar-17 is current, Cedar-12 is retired. I'll remember that.";
  createSession({ id: sessionId, kind: 'chat', title: 'memory receipt' });
  const priorSource = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep our conversations warm and direct.' },
  });
  const priorIdentity = { sessionId, turn: 1, sourceUserSeq: priorSource.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(priorIdentity),
    identity: priorIdentity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Absolutely — warm, direct, and still me.' },
  });
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  invalidateStableMemorySnapshot(sessionId);
  rememberFact({
    kind: 'user',
    content: "Cedar's current release number is Cedar-12.",
    sessionId,
  });
  const seededSystem = renderClaudeAgentBrainSystemAppend('home', { message: 'seed', sessionId }, 'read_only');
  assert.match(seededSystem, /Cedar-12/, 'the frozen prefix really contains the stale value before correction');

  // A session-global unfinished skill from an older turn must not reopen this
  // unrelated acknowledgement through the deterministic skill repair gate.
  const priorSkillCall = appendEvent({
    sessionId,
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'skill_read', callId: 'old-skill', effect: 'read', args: { name: 'old-report-skill' } },
  });
  writeToolOutput({
    sessionId,
    callId: 'old-skill',
    invocationNonce: `${sessionId}:old-skill`,
    tool: 'skill_read',
    output: 'Skill: old-report-skill\n---\nRun scripts/render-old-report.js before completion.',
  });
  appendEvent({
    sessionId,
    turn: 0,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: priorSkillCall.id,
    data: { tool: 'skill_read', callId: 'old-skill', effect: 'read', ok: true },
  });

  let runCalls = 0;
  let judgeCalls = 0;
  let unifiedPrimerCalls = 0;
  let capturedPrompt = '';
  let capturedTurnContext = '';
  let capturedSystemAppend = '';
  let capturedPriorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  let capturedAllowedLocalTools: string[] | undefined;
  let capturedMcpToolAllowlist: string[] | undefined;
  let capturedLocalToolUniverse: string[] | undefined;
  let capturedRequiredLocalTools: string[] | undefined;
  let capturedScope: { maxTools?: number; allowedServerSlugs?: string[] } | undefined;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedPrimerCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    capturedPrompt = options.prompt;
    capturedTurnContext = options.turnContext ?? '';
    capturedSystemAppend = options.systemAppend ?? '';
    capturedPriorTurns = options.priorTurns ?? [];
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    capturedMcpToolAllowlist = options.mcpToolAllowlist;
    capturedLocalToolUniverse = options.localMcpToolUniverse;
    capturedRequiredLocalTools = options.requiredLocalMcpTools;
    capturedScope = options.nativeMcpToolScope;
    return {
      text: providerReply,
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'the receipt already satisfies the request' };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(response.text, providerReply);
  assert.equal(runCalls, 1);
  assert.equal(judgeCalls, 0, 'the generic completion judge cannot re-open receipt-backed memory work');
  assert.equal(unifiedPrimerCalls, 0, 'a durable acknowledgement does not re-retrieve the fact it just accepted');
  assert.equal(capturedPrompt, message, 'the provider still receives the literal user message');
  assert.deepEqual(capturedPriorTurns, [
    { who: 'user', text: 'Keep our conversations warm and direct.' },
    { who: 'assistant', text: 'Absolutely — warm, direct, and still me.' },
  ], 'the complete conversational history remains available to Claude');
  assert.match(capturedSystemAppend, /Cedar-12/, 'the cacheable personalized prefix remains stable during asynchronous consolidation');
  assert.match(capturedSystemAppend, /plain, warm, specific/i, 'the core conversational voice contract remains present');
  assert.match(capturedTurnContext, /supersedes any older conflicting value/i);
  assert.match(capturedTurnContext, /already durably queued/i);
  assert.match(capturedTurnContext, /naturally in your own voice/i);
  assert.deepEqual(capturedAllowedLocalTools, []);
  assert.deepEqual(capturedMcpToolAllowlist, []);
  assert.deepEqual(capturedLocalToolUniverse, []);
  assert.deepEqual(capturedRequiredLocalTools, []);
  assert.equal(capturedScope?.maxTools, 0);
  assert.deepEqual(capturedScope?.allowedServerSlugs, []);
  assert.equal(listEvents(sessionId, { types: ['tool_jit_scope'] }).length, 0);

  const capture = listEvents(sessionId, { types: ['memory_signals_captured'] }).at(-1);
  assert.ok(capture);
  assert.equal(capture!.data.queuedCandidateCount, 1);
  assert.equal(capture!.data.conversationOnly, true);
  assert.ok(capture!.data.episodeId);
  const policy = listEvents(sessionId, { types: ['tool_policy_resolved'] }).at(-1);
  assert.equal(policy?.data.shortCircuitReason, 'durable_memory_receipt_conversation_only');
  assert.equal(policy?.data.outputCount, 0);
  const primer = listEvents(sessionId, { types: ['turn_memory_primer'] }).at(-1);
  assert.equal(primer?.data.source, null);
  assert.equal(primer?.data.injected, false);
  assert.equal(primer?.data.hitCount, 0);
  assert.equal(primer?.data.skippedReason, 'durable_memory_receipt_conversation_only');
  const packet = listEvents(sessionId, { types: ['agent_context_packet'] }).at(-1);
  assert.equal(packet?.data.semanticEnrichmentSkippedReason, 'durable_memory_receipt_conversation_only');
  assert.equal(packet?.data.multiItem?.detected, false);
  assert.equal(listEvents(sessionId, { types: ['turn_preflight_decision', 'capability_resolution'] }).length, 0);
  assert.equal(
    listEvents(sessionId, { types: ['heartbeat'] }).filter((event) => event.data.kind === 'skill_execution_repair').length,
    0,
  );
});

test('SDK brain seals an unsafe receipt presentation behind a deterministic fallback without another model step', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'on';
  const sessionId = 'brain-memory-receipt-presentation-repair';
  const message = 'Remember this: Cedar is Cedar-18. Just confirm.';
  const unsafeReply = 'Got it. <tool_call>{"name":"send_email"}</tool_call>';
  createSession({ id: sessionId, kind: 'chat', title: 'receipt presentation repair' });

  const prompts: string[] = [];
  let judgeCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: unsafeReply,
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'receipt complete' };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(prompts.length, 1, 'presentation policy cannot mint a second model step');
  assert.equal(prompts[0], message);
  assert.equal(response.text, "Got it — I'll remember that.", 'unsafe provider bytes are replaced deterministically');
  assert.doesNotMatch(response.text, /send_email|"action"/i);
  assert.equal(judgeCalls, 0, 'presentation repair does not reopen the completed memory objective');
  assert.equal(
    listEvents(sessionId, { types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'durable_memory_receipt_presentation_fallback'),
    true,
    'the deterministic fallback is recorded once',
  );
});

test('SDK brain byte-preserves safe receipt acknowledgements outside a fixed opener list', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const replies = [
    "Thanks for the correction — Cedar-17 is current, and I'll remember that.",
    "I've got it — Cedar-17 is current.",
  ];

  for (const [index, reply] of replies.entries()) {
    resetEventLog();
    const sessionId = `brain-memory-receipt-varied-safe-voice-${index}`;
    const message = `Small correction for later: Cedar is Cedar-17. Cedar-${index + 10} is retired. Just confirm.`;
    createSession({ id: sessionId, kind: 'chat', title: 'varied safe receipt voice' });
    let runCalls = 0;
    setClaudeAgentSdkBrainRunForTest(async () => {
      runCalls += 1;
      return {
        text: reply,
        sessionId: 'sdk-session',
        model: 'claude-sonnet-test',
        toolUses: [],
      };
    });

    const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

    assert.equal(runCalls, 1, `fixture ${index} needs no style repair`);
    assert.equal(response.text, reply, `fixture ${index} remains byte-identical`);
    assert.equal(
      listEvents(sessionId, { types: ['guardrail_tripped'] })
        .some((event) => event.data.kind === 'durable_memory_receipt_presentation_fallback'),
      false,
    );
  }
});

test('SDK brain replaces a false denial after durable memory intake without another model step', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-memory-receipt-false-denial-repair';
  const message = 'Remember this: Cedar is Cedar-20. Just confirm.';
  createSession({ id: sessionId, kind: 'chat', title: 'receipt denial repair' });

  let runCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runCalls += 1;
    return {
      text: "Sorry, I can't remember or store that.",
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(runCalls, 1);
  assert.equal(response.text, "Got it — I'll remember that.");
  assert.doesNotMatch(response.text, /can(?:not|'t) remember|can't remember/i);
});

test('SDK brain replaces an unrelated completed-effect claim without another model step', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-memory-receipt-effect-claim-repair';
  const message = 'Remember this: Cedar is Cedar-21. Just confirm.';
  createSession({ id: sessionId, kind: 'chat', title: 'receipt effect repair' });

  let runCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runCalls += 1;
    return {
      text: 'Got it — I updated the spreadsheet.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(runCalls, 1);
  assert.equal(response.text, "Got it — I'll remember that.");
  assert.doesNotMatch(response.text, /spreadsheet/i);
});

test('SDK brain falls back safely when the sealed receipt repair is still unsafe', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-memory-receipt-presentation-fallback';
  const message = 'Remember this: Cedar is Cedar-19. Just confirm.';
  const unsafeReply = 'Noted — the note got created, and I pushed the branch.';
  createSession({ id: sessionId, kind: 'chat', title: 'receipt presentation fallback' });

  let runCalls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runCalls += 1;
    return {
      text: unsafeReply,
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(runCalls, 1, 'receipt presentation policy cannot re-enter the model');
  assert.equal(response.text, "Got it — I'll remember that.");
  assert.doesNotMatch(response.text, /created|pushed/i);
  assert.equal(
    listEvents(sessionId, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.kind === 'durable_memory_receipt_presentation_fallback').length,
    1,
  );
});

test('SDK brain preserves an explicit caller tool allowlist on an acknowledgement-only memory receipt', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-memory-receipt-explicit-tool-authority';
  const message = 'Remember this: Cedar is Cedar-17. Just confirm.';
  createSession({ id: sessionId, kind: 'chat', title: 'explicit receipt authority' });

  let unifiedPrimerCalls = 0;
  let capturedAllowedLocalTools: string[] | undefined;
  let capturedMcpToolAllowlist: string[] | undefined;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedPrimerCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    capturedMcpToolAllowlist = options.mcpToolAllowlist;
    return {
      text: 'Got it — Cedar is Cedar-17.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message,
    sessionId,
    allowedToolNames: ['memory_recall_all'],
  });

  assert.equal(unifiedPrimerCalls, 1, 'explicit caller authority keeps the ordinary semantic context path');
  assert.deepEqual(capturedAllowedLocalTools, ['memory_recall_all']);
  assert.deepEqual(capturedMcpToolAllowlist, ['memory_recall_all']);
  const capture = listEvents(sessionId, { types: ['memory_signals_captured'] }).at(-1);
  assert.equal(capture?.data.conversationOnly, false);
  const policy = listEvents(sessionId, { types: ['tool_policy_resolved'] }).at(-1);
  assert.notEqual(policy?.data.shortCircuitReason, 'durable_memory_receipt_conversation_only');
});

test('SDK brain keeps receipt semantics when the caller already supplied an explicit empty tool allowlist', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-memory-receipt-explicit-zero-authority';
  const message = 'Remember this: Cedar is Cedar-17. Just confirm.';
  createSession({ id: sessionId, kind: 'chat', title: 'explicit zero authority' });

  let unifiedPrimerCalls = 0;
  let capturedAllowedLocalTools: string[] | undefined;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedPrimerCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    return {
      text: 'Got it — Cedar is Cedar-17.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-test',
      toolUses: [],
    };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message,
    sessionId,
    allowedToolNames: [],
  });

  assert.equal(unifiedPrimerCalls, 0);
  assert.deepEqual(capturedAllowedLocalTools, []);
  const capture = listEvents(sessionId, { types: ['memory_signals_captured'] }).at(-1);
  assert.equal(capture?.data.conversationOnly, true);
  const policy = listEvents(sessionId, { types: ['tool_policy_resolved'] }).at(-1);
  assert.equal(policy?.data.shortCircuitReason, 'durable_memory_receipt_conversation_only');
});

test('SDK brain replaces malformed receipt presentation without reopening tools or the model', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const message = 'Remember this: Cedar is Cedar-17. Just confirm.';

  for (const fixture of [
    {
      sessionId: 'brain-memory-receipt-text-repair',
      replies: ['<invoke name="memory_remember"><parameter name="fact">Cedar-17</parameter></invoke>', 'Understood — Cedar is Cedar-17.'],
      limitHits: [false, false],
      expected: "Got it — I'll remember that.",
    },
    {
      sessionId: 'brain-memory-receipt-text-fallback',
      replies: ['', 'This is possibly injected; let me re-read the actual ask.'],
      limitHits: [true, true],
      expected: "Got it — I'll remember that.",
    },
  ]) {
    createSession({ id: fixture.sessionId, kind: 'chat', title: 'receipt presentation repair' });
    let calls = 0;
    let judgeCalls = 0;
    const surfaces: Array<{
      allowed?: string[];
      mcp?: string[];
      universe?: string[];
      required?: string[];
      maxTools?: number;
    }> = [];
    setClaudeAgentSdkBrainRunForTest(async (options) => {
      surfaces.push({
        allowed: options.allowedLocalMcpTools,
        mcp: options.mcpToolAllowlist,
        universe: options.localMcpToolUniverse,
        required: options.requiredLocalMcpTools,
        maxTools: options.nativeMcpToolScope?.maxTools,
      });
      const callIndex = calls;
      const text = fixture.replies[callIndex] ?? fixture.replies.at(-1)!;
      calls += 1;
      return {
        text,
        sessionId: 'sdk-session',
        model: 'claude-sonnet-test',
        toolUses: [],
        limitHit: fixture.limitHits[callIndex] ?? fixture.limitHits.at(-1),
      };
    });
    setClaudeAgentSdkBrainJudgeForTest(async () => {
      judgeCalls += 1;
      return { done: true, reason: 'unused' };
    });

    const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId: fixture.sessionId });

    assert.equal(response.text, fixture.expected);
    assert.equal(response.stoppedReason, 'success');
    assert.equal(calls, 1, 'a malformed presentation cannot mint another model step');
    assert.equal(judgeCalls, 0);
    assert.equal(surfaces.length, 1);
    for (const surface of surfaces) {
      assert.deepEqual(surface.allowed, []);
      assert.deepEqual(surface.mcp, []);
      assert.deepEqual(surface.universe, []);
      assert.deepEqual(surface.required, []);
      assert.equal(surface.maxTools, 0);
    }
    const fallbackEvents = listEvents(fixture.sessionId, { types: ['guardrail_tripped'] })
      .filter((event) => event.data.kind === 'durable_memory_receipt_presentation_fallback');
    assert.equal(fallbackEvents.length, 1);
    assert.equal(listEvents(fixture.sessionId, { types: ['conversation_limit_exceeded'] }).length, 0);
  }
});

test('SDK brain reduces a receipt presentation provider failure without cross-brain replay authority', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-memory-receipt-provider-failure';
  const message = 'Remember this: Cedar is Cedar-17. Just confirm.';
  createSession({ id: sessionId, kind: 'chat', title: 'receipt provider failure' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    assert.deepEqual(options.allowedLocalMcpTools, []);
    assert.deepEqual(options.mcpToolAllowlist, []);
    assert.equal(options.nativeMcpToolScope?.maxTools, 0);
    throw new ClaudeSdkProviderOverloadError('API Error: 529 overloaded_error', false);
  });

  const response = await respondViaClaudeAgentSdkBrain('home', { message, sessionId });

  assert.equal(calls, 1);
  assert.equal(response.text, "Got it — I'll remember that.");
  assert.equal(response.stoppedReason, 'success');
  const fallback = listEvents(sessionId, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'durable_memory_receipt_provider_failure_fallback');
  assert.equal(fallback.length, 1);
  assert.equal(listEvents(sessionId, { types: ['tool_called'] }).length, 0);
});

test('SDK brain auto-captures explicit remember turns even when the model skips memory_remember', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  createSession({ id: 'brain-autocap-remember', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Saved — your smoke marker is MEMTOK-999999.',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Remember exactly: my smoke marker is MEMTOK-999999. Confirm.',
    sessionId: 'brain-autocap-remember',
  });

  const events = listEvents('brain-autocap-remember');
  const captured = events.find((event) => event.type === 'memory_signals_captured');
  assert.ok(captured, 'SDK brain emitted memory capture telemetry for the explicit remember turn');
  assert.equal((captured!.data as { factCount?: number }).factCount, 1);
  assert.deepEqual(
    (captured!.data as { reasons?: string[] }).reasons,
    ['explicit remember request'],
  );
  assert.ok(
    events.findIndex((event) => event.type === 'memory_signals_captured') <
      events.findIndex((event) => event.type === 'conversation_completed'),
    'capture telemetry is recorded before the final saved reply',
  );
});

test('SDK brain durably captures an exact pre-recorded source once and isolates compound-decline memory authority', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  setClaudeAgentSdkBrainRunForTest(async (options) => ({
    text: 'Understood — I’ll keep that correction in mind.',
    sessionId: options.sessionId,
    model: 'claude-sonnet-test',
    toolUses: [],
  }));

  const correctionSessionId = 'brain-autocap-pre-recorded-correction';
  const correctionRunId = 'run-autocap-pre-recorded-correction';
  const correction = "Small correction for later: Project Cedar's release marker is Cedar-17, not Cedar-12.";
  createSession({ id: correctionSessionId, kind: 'chat', channel: 'desktop', title: 'correction' });
  const correctionAttempt = beginRunAttempt(correctionSessionId, { runId: correctionRunId });
  const correctionSource = recordRunAttemptUserInput(correctionAttempt, {
    turn: 1,
    role: 'user',
    data: { text: correction, displayText: correction, runId: correctionRunId },
  });

  const correctionRequest = {
    message: correction,
    displayMessage: correction,
    sourceUserSeq: correctionSource.seq,
    sessionId: correctionSessionId,
    runId: correctionRunId,
    channel: 'desktop',
  } as const;
  await respondViaClaudeAgentSdkBrain('home', correctionRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const correctionCallId = `auto-capture:user-source:${correctionSource.seq}`;
  const assertSingleCorrectionAdmission = (): void => {
    const db = openMemoryDb();
    const episodes = db.prepare(`
      SELECT evidence_excerpt FROM memory_episodes
      WHERE session_id = ? AND call_id = ?
    `).all(correctionSessionId, correctionCallId) as Array<{ evidence_excerpt: string | null }>;
    const candidates = db.prepare(`
      SELECT text, intake_reason FROM memory_reflection_candidates
      WHERE session_id = ? AND call_id = ? AND source_type = 'auto_capture'
    `).all(correctionSessionId, correctionCallId) as Array<{ text: string; intake_reason: string | null }>;
    assert.equal(episodes.length, 1, 'the exact accepted source owns one durable episode');
    assert.equal(episodes[0]?.evidence_excerpt, correction);
    assert.equal(candidates.length, 1, 'the exact accepted source owns one durable learning decision');
    assert.equal(candidates[0]?.text, correction);
    assert.equal(candidates[0]?.intake_reason, 'explicit durable correction');
  };
  assertSingleCorrectionAdmission();

  // Simulate a daemon restart and re-delivery of the same accepted edge. The
  // physical attempt rotates, but sourceUserSeq — and therefore memory intake
  // identity — remains stable.
  closeEventLog();
  closeMemoryDb();
  await respondViaClaudeAgentSdkBrain('home', correctionRequest);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertSingleCorrectionAdmission();

  const compoundSessionId = 'brain-autocap-compound-decline';
  createSession({ id: compoundSessionId, kind: 'chat', channel: 'desktop', title: 'compound correction' });
  const parentAttempt = beginRunAttempt(compoundSessionId);
  const parent = recordRunAttemptUserInput(parentAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Update the local project note.' },
  });
  appendEvent({
    sessionId: compoundSessionId,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Should I update it?',
      options: ['Yes', 'No'],
      purpose: 'clarification',
      source: 'decision_awaiting',
      sourceUserSeq: parent.seq,
    },
  });
  const parentIdentity = { sessionId: compoundSessionId, turn: 1, sourceUserSeq: parent.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(parentIdentity),
    identity: parentIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Should I update it?' },
  });

  const activeTaskInput = "Small correction for later: Project Birch's release marker is Birch-29, not Birch-11.";
  const compoundMessage = `No—leave that note alone. Instead, ${activeTaskInput}`;
  const compoundRunId = 'run-autocap-compound-decline';
  const compoundAttempt = beginRunAttempt(compoundSessionId, { runId: compoundRunId });
  const compoundSource = recordRunAttemptUserInput(compoundAttempt, {
    turn: 2,
    role: 'user',
    data: { text: compoundMessage, displayText: compoundMessage, runId: compoundRunId },
  });
  await respondViaClaudeAgentSdkBrain('home', {
    message: compoundMessage,
    displayMessage: compoundMessage,
    sourceUserSeq: compoundSource.seq,
    sessionId: compoundSessionId,
    runId: compoundRunId,
    channel: 'desktop',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const compoundCallId = `auto-capture:user-source:${compoundSource.seq}`;
  const db = openMemoryDb();
  const compoundEpisodes = db.prepare(`
    SELECT evidence_excerpt FROM memory_episodes
    WHERE session_id = ? AND call_id = ?
  `).all(compoundSessionId, compoundCallId) as Array<{ evidence_excerpt: string | null }>;
  const compoundCandidates = db.prepare(`
    SELECT text FROM memory_reflection_candidates
    WHERE session_id = ? AND call_id = ? AND source_type = 'auto_capture'
  `).all(compoundSessionId, compoundCallId) as Array<{ text: string }>;
  assert.deepEqual(compoundEpisodes, [{ evidence_excerpt: activeTaskInput }]);
  assert.deepEqual(compoundCandidates, [{ text: activeTaskInput }]);
  assert.doesNotMatch(
    compoundEpisodes[0]!.evidence_excerpt!,
    /leave that note alone/i,
    'the declined parent remains conversational transcript, never durable memory authority',
  );
});

test('Claude brain records a zero-authority external MCP scope for explicit local-only turns', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-local-only-mcp-scope';
  createSession({ id: sessionId, kind: 'chat', title: 'local recall' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Avery Rowan\nBlair Solis',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Use only Clementine local memory. Do not call any external connector. Return names only, no emails.',
    sessionId,
  });

  const scopeEvent = listEvents(sessionId, { types: ['mcp_tool_scope'] }).at(-1);
  assert.ok(scopeEvent, 'Claude brain emits the shared MCP scope telemetry');
  const scope = scopeEvent!.data as {
    lane?: string;
    maxTools?: number;
    allowedServerSlugs?: string[];
  };
  assert.equal(scope.lane, 'claude_sdk');
  assert.equal(scope.maxTools, 0);
  assert.deepEqual(scope.allowedServerSlugs, []);
});

test('Claude brain preserves precise connector scope across a bare execution follow-up', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-continuation-mcp-scope';
  createSession({ id: sessionId, kind: 'chat', title: 'Outlook planning' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Draft the Outlook emails to the contacts we just reviewed.' },
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'I am continuing the approved Outlook task.',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Do it.',
    sessionId,
  });

  const scopeEvent = listEvents(sessionId, { types: ['mcp_tool_scope'] }).at(-1);
  assert.ok(scopeEvent);
  const scope = scopeEvent!.data as {
    reason?: string;
    maxTools?: number;
    allowedServerSlugs?: string[];
  };
  assert.ok((scope.maxTools ?? 0) > 0);
  assert.ok((scope.allowedServerSlugs ?? []).some((slug) => /outlook|microsoft/.test(slug)));
  assert.match(scope.reason ?? '', /continuity/i);
});

test('Move 4: a judge-failed-open completion is TAGGED verification.failedOpen (no silent green check)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-failopen', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'judge timed out — accepting completion', failedOpen: true }));
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-failopen' });
  const completed = listEvents('brain-verif-failopen').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.ok(completed, 'a completion event was emitted');
  assert.equal((completed!.data as { verification?: { failedOpen?: boolean } }).verification?.failedOpen, true, 'fail-open is surfaced on the completion');
});

test('Move 4: a thrown completion judge is TAGGED verification.failedOpen', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-throw', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => { throw new Error('judge unavailable'); });
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-throw' });
  const completed = listEvents('brain-verif-throw').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.ok(completed, 'a completion event was emitted');
  assert.equal((completed!.data as { verification?: { failedOpen?: boolean } }).verification?.failedOpen, true);
});

test('Move 4: a clean cross-family done verdict leaves NO verification tag (full confidence)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-verif-clean', kind: 'chat', title: 'v' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Done — sent the 3 emails.', sessionId: 'sdk', model: 'm',
    toolUses: [],
  }));
  let judgeCalls = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'all three sent with links' };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-verif-clean' });
  const completed = listEvents('brain-verif-clean').filter((e) => e.type === 'conversation_completed').at(-1);
  assert.equal(judgeCalls, 1);
  assert.equal((completed!.data as { verification?: unknown }).verification, undefined, 'a clean verdict adds no tag');
});

test('Move 1: an uncommitted brain throw keeps the marker armed for the bridge recovery reducer', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker-throw', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => { throw new Error('boom'); });
  await assert.rejects(respondViaClaudeAgentSdkBrain('home', { message: 'hi', sessionId: 'brain-marker-throw' }));
  assert.ok(
    HarnessSession.load('brain-marker-throw')?.runInFlightSince(),
    'the marker stays armed until the bridge commits the logical terminal or recovery winner',
  );
});

test('a disconnected live viewer cannot invalidate an already-committed terminal report', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const { HarnessSession } = await import('./session.js');
  createSession({ id: 'brain-marker-delivery-throw', kind: 'chat', title: 'm' });
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'done', sessionId: 'sdk', model: 'm', toolUses: [] }));
  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'hi',
    sessionId: 'brain-marker-delivery-throw',
    onChunk: async () => { throw new Error('client disconnected'); },
  });
  assert.equal(response.text, 'done');
  assert.equal(
    HarnessSession.load('brain-marker-delivery-throw')?.runInFlightSince(),
    null,
    'durable public replay, not a transient callback, owns final delivery',
  );
  assert.equal(
    listEvents('brain-marker-delivery-throw', { types: ['conversation_completed'] }).length,
    1,
  );
});

test('post-terminal bookkeeping exceptions cannot escape into whole-turn recovery', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const sessionId = 'brain-post-terminal-hook-throw';
  createSession({ id: sessionId, kind: 'chat', title: 'post terminal' });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'The durable answer won.',
    sessionId: 'sdk',
    model: 'm',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainPostTurnHooksForTest(() => {
    throw new Error('post-terminal bookkeeping exploded');
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'answer once',
    sessionId,
    runId: 'run-post-terminal-hook-throw',
  });

  assert.equal(response.text, 'The durable answer won.');
  const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, 'post-terminal work cannot mint or provoke a second terminal');
  assert.equal(terminals[0].data.terminalKey, `turn:${terminals[0].data.sourceUserSeq}`);
  assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
});

test('Claude auth defaults to the full tool-capable SDK lane; off remains explicit', () => {
  process.env.AUTH_MODE = 'claude_oauth';
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'full');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'local_authoring');
  assert.equal(claudeAgentSdkBrainEnabled('dashboard'), true);
  assert.equal(claudeAgentSdkBrainEnabled('background'), true, 'background tasks need the SDK lane so Claude can call Clementine tools');
  assert.equal(claudeAgentSdkBrainEnabled('cron'), true, 'cron needs the SDK lane so Claude can call Clementine tools');
  assert.equal(claudeAgentSdkBrainEnabled('workflow'), false, 'execution surfaces stay on the guarded harness');

  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  assert.equal(claudeAgentSdkBrainEnabled('home'), true);
  assert.equal(claudeAgentSdkBrainMode(), 'read_only');

  process.env.AUTH_MODE = 'codex_oauth';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);

  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'off';
  assert.equal(claudeAgentSdkBrainEnabled('home'), false);
});

test('renderClaudeAgentBrainSystemAppend carries Clementine context and the read-only boundary', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'read_only');
  assert.match(prompt, /official Claude Agent SDK/);
  assert.match(prompt, /READ-ONLY\/local-context/);
  assert.match(prompt, /How you operate here/);
  assert.match(prompt, /You are Clementine/);
  assert.match(prompt, /CALL TOOLS — NEVER DESCRIBE THEM/);
  assert.doesNotMatch(prompt, /Return an OrchestratorDecision/);
  // The lean rubric must NOT leak the harness's internal event protocol — that
  // leakage is what the model reproduced as text ("Tool:… / System: tool result").
  assert.doesNotMatch(prompt, /tool_called event|tool_returned event|\[clipped:/);
});

test('full Claude action prompt uses accepted work authority without manufacturing an execution owner', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'Update the Sheet.', sessionId: 'brain-work-authority' }, 'full');
  assert.match(prompt, /accepted external work through work_call/i);
  assert.match(prompt, /host-frozen binding/i);
  assert.doesNotMatch(prompt, /execution_create FIRST/i);
  assert.doesNotMatch(prompt, /before (?:a|any) MUTATING external write[^\n]*execution_create/i);
});

test('Claude brain keeps the installed catalog out of the stable prompt and injects only relevant skills per turn', async () => {
  const install = (name: string, description: string): void => {
    const dir = path.join(TMP_HOME, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), [
      '---', `name: ${name}`, `description: ${description}`, '---', '', 'The full procedure is intentionally not preloaded.',
    ].join('\n'));
  };
  install('firm-document', 'Create polished Google Docs and Word document briefs for firms.');
  install('calendar-operator', 'Schedule meetings and coordinate calendar availability.');
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  try {
    const system = renderClaudeAgentBrainSystemAppend(
      'home',
      { message: 'Create a Google Doc about a firm.', sessionId: 'brain-skill-bloat' },
      'read_only',
    );
    assert.match(system, /## Skill Discovery/);
    assert.equal((system.match(/## Skill Discovery/g) ?? []).length, 1, 'canonical context and brain fallback must not duplicate discovery');
    assert.doesNotMatch(system, /firm-document|calendar-operator/, 'the cacheable system prefix never enumerates installed skills');

    const turn = await renderClaudeAgentBrainTurnContext({
      message: 'Create a Google Doc about a firm.',
      sessionId: 'brain-skill-bloat',
    });
    assert.match(turn, /## Relevant Skills/);
    assert.equal((turn.match(/## Relevant Skills/g) ?? []).length, 1, 'Claude turn context injects one relevant-skill menu');
    assert.doesNotMatch(turn, /## Skill Discovery/, 'Claude turn context does not repeat the stable discovery pointer');
    assert.match(turn, /firm-document/);
    assert.doesNotMatch(turn, /calendar-operator/);
  } finally {
    rmSync(path.join(TMP_HOME, 'skills'), { recursive: true, force: true });
    delete process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT;
  }
});

test('Claude volatile turn receives the canonical FocusWorkstate + exact-session goal exactly once', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  const sessionId = 'brain-active-task-parity';
  const focus = createFocus({
    resourceRef: `session:${sessionId}`,
    title: 'Claude active-task parity',
    summary: 'Using the shared provider-neutral task context.',
    relatedSessionId: sessionId,
  });
  patchFocusWorkstate(focus.id, {
    mode: 'execute',
    addDecisions: ['Render the task contract through canonical volatile context.'],
  });
  createGoalContract({
    sessionId,
    objective: 'Prove Claude receives the shared active task.',
    successCriteria: ['The goal appears exactly once in the turn context.'],
  });
  createGoalContract({
    sessionId: 'brain-active-task-other-session',
    objective: 'OTHER CLAUDE SESSION GOAL MUST NOT LEAK',
    successCriteria: ['Never visible in this turn.'],
  });

  try {
    const turn = await renderClaudeAgentBrainTurnContext({
      message: 'continue the active task',
      sessionId,
    });
    assert.equal((turn.match(/\[ACTIVE GOAL/g) ?? []).length, 1);
    assert.match(turn, /Render the task contract through canonical volatile context/);
    assert.match(turn, /Prove Claude receives the shared active task/);
    assert.doesNotMatch(turn, /OTHER CLAUDE SESSION GOAL MUST NOT LEAK/);
  } finally {
    clearFocus(focus.id, 'completed');
    delete process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT;
  }
});

test('stable memory freezing is DEFAULT ON, defers churn, and honors the invalidation generation', () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on'; // the freeze applies only on the split (cacheable-prefix) path
  delete process.env.CLEMMY_BRAIN_STABLE_SNAPSHOT; // default path under test
  const sid = 'brain-freeze-A';
  invalidateStableMemorySnapshot(); // clean slate
  // First render seeds this session's snapshot (before the vault edit).
  const first = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  // A DIRECT store write (the reflection/auto-capture path — no generation
  // bump) changes what the STABLE block WOULD render.
  saveUserProfile({ role: 'MARKER_ROLE_XYZZY' });
  // Same session → byte-identical (frozen); automatic churn stays deferred and
  // never busts the cached prefix. This is the snapshot's whole point.
  const second = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.equal(second, first, 'default-on freeze: same session defers the churn write');
  assert.doesNotMatch(second, /MARKER_ROLE_XYZZY/);
  // A DIFFERENT session renders live — proves the edit really does surface (so its
  // absence above is the freeze, not a non-rendering field).
  const fresh = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-freeze-B' }, 'read_only');
  assert.match(fresh, /MARKER_ROLE_XYZZY/, 'a fresh session renders the current vault state');
  // An EXPLICIT mutation bumps the shared generation (memory tools / console
  // routes / skill installs call this) — every frozen session re-renders.
  bumpStableContextGeneration();
  const third = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.match(third, /MARKER_ROLE_XYZZY/, 'a generation bump re-renders the stable block');
  // Per-session invalidation still works (tests + targeted callers).
  saveUserProfile({ role: 'MARKER_ROLE_SECOND' });
  invalidateStableMemorySnapshot(sid);
  const fourth = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.match(fourth, /MARKER_ROLE_SECOND/, 'explicit invalidation re-renders the stable block');
  // Kill-switch off → live render every turn (no freeze).
  process.env.CLEMMY_BRAIN_STABLE_SNAPSHOT = 'off';
  saveUserProfile({ role: 'MARKER_ROLE_THIRD' });
  const live = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: sid }, 'read_only');
  assert.match(live, /MARKER_ROLE_THIRD/, 'kill-switch renders the vault live');
  delete process.env.CLEMMY_BRAIN_STABLE_SNAPSHOT;
  invalidateStableMemorySnapshot();
});

test('CONVERGE guard: an answer carries forward without forcing exploratory work into execution', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  delete process.env.CLEMMY_BRAIN_CONVERGE;
  const sid = createSession({ kind: 'chat' }).id;
  // No prior clarifying question → no convergence steer.
  const before = await renderClaudeAgentBrainTurnContext({ message: 'design a win-back workspace', sessionId: sid });
  assert.doesNotMatch(before, /CONVERGE/);
  // Clem's PREVIOUS turn ended by asking a clarifying question (awaiting-user completion).
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed', data: { awaitingUser: true, summary: 'win-back action or closed-lost diagnosis?' } });
  const after = await renderClaudeAgentBrainTurnContext({ message: 'winback action please', sessionId: sid });
  assert.match(after, /CONVERGE/, 'answering a question injects the continuity steer');
  assert.match(after, /never re-ask the resolved point/);
  assert.match(after, /not automatic permission for external writes or durable execution/);
  assert.doesNotMatch(after, /EXECUTE the work this turn/);
  // An approval card (approval_requested) is NOT a clarifying question — it must not trip the steer.
  const sid2 = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid2, turn: 1, role: 'system', type: 'conversation_completed', data: { summary: 'done, sent 3 emails' } });
  const normal = await renderClaudeAgentBrainTurnContext({ message: 'thanks', sessionId: sid2 });
  assert.doesNotMatch(normal, /CONVERGE/, 'a normal completion does not trip the steer');
  const sid3 = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid3, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: { question: 'Background, hold, or now?', source: 'offer_background' } });
  appendEvent({ sessionId: sid3, turn: 1, role: 'system', type: 'conversation_completed', data: { awaitingUser: true } });
  const backgroundChoice = await renderClaudeAgentBrainTurnContext({ message: 'Do it now here', sessionId: sid3 });
  assert.doesNotMatch(backgroundChoice, /CONVERGE/, 'a background routing choice is not a clarification answer');
  // Kill-switch off → no steer even after a clarify.
  process.env.CLEMMY_BRAIN_CONVERGE = 'off';
  const killed = await renderClaudeAgentBrainTurnContext({ message: 'winback action please', sessionId: sid });
  assert.doesNotMatch(killed, /CONVERGE/, 'kill-switch disables the steer');
  delete process.env.CLEMMY_BRAIN_CONVERGE;
});

test('Claude turn context carries settled pre-execution guidance without a blanket stop', async () => {
  // The v3.6 freeze removed the beat as "ceremonial" expecting the graph lane
  // to own alignment; the graph lane never landed, so v3.7/v3.8 executed
  // consequential asks with zero conversation (live 2026-08-05, the owner's
  // scrape-and-sheet request). The beat is restored and this pin holds it.
  _setOpennessJudgeForTests(async () => null);
  const sid = createSession({ kind: 'chat' }).id;
  const request = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved outreach emails to the named recipients.' },
  });
  const context = await renderClaudeAgentBrainTurnContext({
    message: 'Send the approved outreach emails to the named recipients.',
    sessionId: sid,
  }, { sourceUserSeq: request.seq });
  assert.match(context, /\[pre-execution alignment\]/, 'a consequential send carries the settled execution guidance');
  assert.match(context, /Proceed with the requested work in this same turn/);
  assert.equal(listEvents(sid, { types: ['turn_preflight_decision'] }).length, 1, 'the typed decision persists');

  // A plain lookup stays silent — the beat must never tax reads.
  const readSid = createSession({ kind: 'chat' }).id;
  const readContext = await renderClaudeAgentBrainTurnContext({
    message: 'whats on my calendar tomorrow',
    sessionId: readSid,
  });
  assert.doesNotMatch(readContext, /\[pre-execution alignment\]/);
});

test('Claude settled alignment paints prior-aware prose and reaches the tool-capable SDK in the same turn', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CONFIRM_BEAT = 'on';
  let authorStarted = false;
  let judgeObservedConcurrentAuthor = false;
  _setOpennessJudgeForTests(async () => {
    judgeObservedConcurrentAuthor = authorStarted;
    return null;
  });
  const sid = 'claude-structural-preflight';
  const original = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
  createSession({ id: sid, kind: 'chat', channel: 'desktop' });
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: { text: 'VENTURA-CONTEXT: continue the restaurant research from the prior session.' },
  });
  let sdkRuns = 0;
  const captured: Array<{ artifactObjective?: string; nativeMcpScopeInput?: string; turnContext?: string }> = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    sdkRuns += 1;
    captured.push(options);
    return {
      text: 'Execution reached the test boundary. What should I inspect next?',
      sessionId: 'sdk',
      model: 'claude-sonnet-test',
      toolUses: [],
      stoppedReason: 'awaiting-input',
    };
  });
  let authorCalls = 0;
  setClaudeAgentSdkBrainPreflightConversationPortForTest({
    async render(packet) {
      authorCalls += 1;
      authorStarted = true;
      assert.equal(packet.kind, 'proceed');
      assert.match(packet.conversationContext, /VENTURA-CONTEXT/);
      return 'I have the prior Ventura research and the sheet-to-email handoff in mind.';
    },
  });
  const painted: Array<import('../../types.js').ConversationPreambleDeliveryRequest> = [];

  const aligned = await respondViaClaudeAgentSdkBrain('home', {
    message: original,
    sessionId: sid,
    runId: 'claude-align',
    onConversationPreamble: async (request) => {
      painted.push(request);
      assert.equal(sdkRuns, 0, 'the opening is delivered before the SDK execution begins');
      return {
        status: 'delivered',
        receipt: {
          version: 1,
          deliveryKey: request.deliveryKey,
          eventId: request.eventId,
          eventDigest: request.eventDigest,
          surface: 'channel_message',
          target: 'claude-agent-brain-test',
        },
      };
    },
  });
  assert.equal(aligned.stoppedReason, 'awaiting-input');
  assert.equal(authorCalls, 1);
  assert.equal(
    judgeObservedConcurrentAuthor,
    true,
    'the Claude voice author starts before the Codex-family openness judge settles',
  );
  assert.equal(sdkRuns, 1, 'SETTLED reaches the ordinary Claude SDK brain in the same accepted turn');
  const preambleEvents = listEvents(sid, { types: ['conversation_preamble'] });
  assert.equal(preambleEvents.length, 1);
  assert.deepEqual(painted, [conversationPreambleDeliveryRequest(preambleEvents[0]!)]);
  assert.match(captured[0]?.turnContext ?? '', /VENTURA-CONTEXT/);
  assert.match(captured[0]?.turnContext ?? '', /pre-execution opening already delivered/);
  const awaiting = listEvents(sid, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.notEqual(awaiting[0]?.data.source, 'preflight_openness');
  assert.equal(listEvents(sid, { types: ['conversation_completed'] }).length, 1);
  assert.equal(
    captured[0]?.artifactObjective,
    original,
    JSON.stringify(listEvents(sid, { types: ['user_input_received', 'turn_preflight_decision', 'awaiting_user_input', 'conversation_completed'] })
      .map((event) => ({ seq: event.seq, type: event.type, data: event.data }))),
  );
  assert.equal(captured[0]?.nativeMcpScopeInput, original);
});

for (const judgeMode of ['settled', 'unavailable'] as const) {
  test(`a concrete Salesforce org proceeds through the Claude caller when the openness judge is ${judgeMode}`, async () => {
    process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
    process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
    process.env.CLEMMY_TOOL_JIT = 'off';
    process.env.CLEMMY_CONFIRM_BEAT = 'on';
    let judgeCalls = 0;
    _setOpennessJudgeForTests(async () => {
      judgeCalls += 1;
      if (judgeMode === 'unavailable') throw new Error('openness judge unavailable');
      return null;
    });
    const sid = `claude-salesforce-${judgeMode}`;
    const prompt = 'Import exactly 100 Contact rows from /tmp/rc-contacts.csv into Salesforce org clementine-sandbox using External_Id__c.';
    createSession({ id: sid, kind: 'chat', channel: 'desktop' });
    let sdkRuns = 0;
    setClaudeAgentSdkBrainRunForTest(async () => {
      sdkRuns += 1;
      return {
        text: 'Execution reached the test boundary.',
        sessionId: 'sdk',
        model: 'claude-sonnet-test',
        toolUses: [],
        stoppedReason: 'awaiting-input',
      };
    });
    let authorCalls = 0;
    setClaudeAgentSdkBrainPreflightConversationPortForTest({
      async render(packet) {
        authorCalls += 1;
        assert.equal(packet.kind, 'proceed');
        assert.equal(packet.objective, prompt);
        return 'I have the exact Salesforce org, import source, row bound, and merge key.';
      },
    });
    const painted: Array<import('../../types.js').ConversationPreambleDeliveryRequest> = [];

    await respondViaClaudeAgentSdkBrain('home', {
      message: prompt,
      sessionId: sid,
      runId: `claude-salesforce-${judgeMode}`,
      onConversationPreamble: async (request) => {
        painted.push(request);
        assert.equal(sdkRuns, 0, 'the preamble is visible before SDK execution');
        return {
          status: 'delivered',
          receipt: {
            version: 1,
            deliveryKey: request.deliveryKey,
            eventId: request.eventId,
            eventDigest: request.eventDigest,
            surface: 'channel_message',
            target: `claude-agent-brain-test:${judgeMode}`,
          },
        };
      },
    });

    assert.equal(judgeCalls, 1);
    assert.equal(authorCalls, 1);
    assert.equal(sdkRuns, 1, 'the accepted request reaches the Claude SDK once');
    const preambleEvents = listEvents(sid, { types: ['conversation_preamble'] });
    assert.equal(preambleEvents.length, 1);
    assert.deepEqual(painted, [conversationPreambleDeliveryRequest(preambleEvents[0]!)]);
    const decisions = listEvents(sid, { types: ['turn_preflight_decision'] });
    assert.equal(decisions.length, 1);
    assert.equal(
      decisions[0]?.data.destinationInstanceUnstated,
      true,
      'the legacy request-text flag remains context, but is not an openness verdict',
    );
    assert.equal(
      listEvents(sid, { types: ['awaiting_user_input'] })
        .filter((event) => event.data.source === 'preflight_openness').length,
      0,
      'request text alone cannot publish an openness question or its terminal',
    );
    assert.equal(
      listEvents(sid, { types: ['conversation_completed'] }).length,
      1,
      'only the ordinary SDK result owns a terminal; preflight owns none',
    );
  });
}

test('Claude align terminal cleanup cannot erase an overlapping attempt B restart marker', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CONFIRM_BEAT = 'on';
  _setOpennessJudgeForTests(async () => ({ open: ['which Google account should own the sheet'] }));
  const { HarnessSession } = await import('./session.js');
  const sid = 'claude-align-overlap-marker';
  createSession({ id: sid, kind: 'chat', channel: 'desktop' });
  let secondAttemptId = '';
  setClaudeAgentSdkBrainRunForTest(async () => {
    throw new Error('the tool-capable SDK must not run during align');
  });
  setClaudeAgentSdkBrainPreflightConversationPortForTest({
    async render() {
      const second = beginRunAttempt(sid, { runId: 'align-overlap-b' });
      secondAttemptId = second.attemptId;
      recordRunAttemptUserInput(second, {
        turn: 2,
        role: 'user',
        data: { text: 'Turn B arrived while Turn A was authoring its question.' },
      }, { armRunInFlight: true });
      return 'I have the sheet and email handoff in mind. Should I go ahead?';
    },
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Create a Google Sheet, then email me the link.',
    sessionId: sid,
    runId: 'align-overlap-a',
  });

  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.ok(secondAttemptId);
  assert.notEqual(
    HarnessSession.load(sid)?.runInFlightSince(),
    null,
    'Turn A terminal cleanup must preserve the coarse marker owned by active Turn B',
  );
  assert.equal(
    (getSession(sid)?.metadata.__run_in_flight_owner as { attemptId?: string } | undefined)?.attemptId,
    secondAttemptId,
    'the structured marker still belongs to B',
  );
});

test('Claude SDK dispatch receives non-coercive convergence state on a clarification answer', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = createSession({ kind: 'chat' }).id;
  const originAttempt = beginRunAttempt(sid);
  const origin = recordRunAttemptUserInput(originAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Should we build a win-back queue or diagnose losses?' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Win-back queue or loss diagnosis?',
      options: ['Win-back queue', 'Loss diagnosis'],
      purpose: 'clarification',
      source: 'decision_awaiting',
      sourceUserSeq: origin.seq,
    },
  });
  const originIdentity = { sessionId: sid, turn: 1, sourceUserSeq: origin.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(originIdentity),
    identity: originIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Win-back queue or loss diagnosis?' },
  });
  let capturedTurnContext = '';
  let capturedPrompt = '';
  let capturedNativeMcpScopeInput = '';
  let capturedArtifactObjective = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedTurnContext = options.turnContext ?? '';
    capturedPrompt = options.prompt;
    capturedNativeMcpScopeInput = options.nativeMcpScopeInput ?? '';
    capturedArtifactObjective = options.artifactObjective ?? '';
    return { text: 'Built the win-back queue.', sessionId: sid, model: 'claude-sonnet-5', toolUses: [] };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Use the win-back queue.',
    sessionId: sid,
  });

  assert.equal(response.text, 'Built the win-back queue.');
  assert.equal(capturedPrompt, 'Use the win-back queue.', 'Claude receives the literal answer as its user prompt');
  assert.equal(capturedNativeMcpScopeInput, 'Use the win-back queue.', 'native MCP sees literal B as the current input');
  assert.equal(
    capturedArtifactObjective,
    'Use the win-back queue.',
    'artifact and completion policy receive only the exact accepted authority, never private A/Q/B retrieval text',
  );
  assert.match(capturedTurnContext, /CONVERGE/);
  assert.match(capturedTurnContext, /never re-ask the resolved point/);
  assert.doesNotMatch(capturedTurnContext, /EXECUTE the work this turn/);
});

test('a literal decline cannot inherit the parent send objective or trigger corrective work', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'on';
  process.env.CLEMMY_TOOL_JIT = 'on';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
  const sid = createSession({ kind: 'chat' }).id;
  const originAttempt = beginRunAttempt(sid);
  const origin = recordRunAttemptUserInput(originAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Send the client email.' },
  });
  // Reproduce the strongest case: A already earned a durable consequential
  // alignment before Clem asked the follow-up. B="No" must still override it.
  let unifiedRecallCalls = 0;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedRecallCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  let opennessCalls = 0;
  _setOpennessJudgeForTests(async () => {
    opennessCalls += 1;
    return null;
  });
  await renderClaudeAgentBrainTurnContext({
    message: 'Send the client email.',
    sessionId: sid,
  }, { sourceUserSeq: origin.seq });
  const recallCallsBeforeDecline = unifiedRecallCalls;
  const opennessCallsBeforeDecline = opennessCalls;
  const capabilityEventsBeforeDecline = listEvents(sid, { types: ['capability_resolution'] }).length;
  assert.ok(recallCallsBeforeDecline > 0, 'the recall seam is active for the parent turn');
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Should I send it?',
      options: ['Yes', 'No'],
      purpose: 'clarification',
      source: 'decision_awaiting',
      sourceUserSeq: origin.seq,
    },
  });
  const identity = { sessionId: sid, turn: 1, sourceUserSeq: origin.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Should I send it?' },
  });

  let runCalls = 0;
  let judgeCalls = 0;
  let capturedPrompt = '';
  let capturedArtifactObjective = '';
  let capturedTurnContext = '';
  let capturedPriorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  let capturedAllowedLocalTools: string[] | undefined;
  let capturedMcpToolAllowlist: string[] | undefined;
  let capturedLocalToolUniverse: string[] | undefined;
  let capturedRequiredLocalTools: string[] | undefined;
  let capturedScope: { maxTools?: number; allowedServerSlugs?: string[] } | undefined;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    capturedPrompt = options.prompt;
    capturedArtifactObjective = options.artifactObjective ?? '';
    capturedTurnContext = options.turnContext ?? '';
    capturedPriorTurns = options.priorTurns ?? [];
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    capturedMcpToolAllowlist = options.mcpToolAllowlist;
    capturedLocalToolUniverse = options.localMcpToolUniverse;
    capturedRequiredLocalTools = options.requiredLocalMcpTools;
    capturedScope = options.nativeMcpToolScope;
    return {
      text: 'Understood — I won’t send it.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    return { done: false, reason: 'should not judge a decline' };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'No.',
    sessionId: sid,
  });

  assert.equal(response.text, 'Understood — I won’t send it.');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(runCalls, 1, 'no corrective execution turn may follow the decline');
  assert.equal(judgeCalls, 0, 'the parent send objective never reaches completion judging');
  assert.equal(capturedPrompt, 'No.', 'the provider receives literal B');
  assert.equal(capturedArtifactObjective, 'No.', 'artifact/effect policy is literal B');
  assert.match(capturedTurnContext, /CONVERGE/, 'the model still receives conversational continuation state');
  assert.ok(
    capturedPriorTurns.some((turn) => turn.who === 'user' && turn.text === 'Send the client email.'),
    'conversation history remains available for a natural acknowledgement',
  );
  assert.equal(unifiedRecallCalls, recallCallsBeforeDecline, 'a typed decline performs no unified recall');
  assert.equal(opennessCalls, opennessCallsBeforeDecline, 'a typed decline performs no openness pass');
  assert.equal(
    listEvents(sid, { types: ['capability_resolution'] }).length,
    capabilityEventsBeforeDecline,
    'a typed decline performs no capability resolution or schema warming',
  );
  assert.deepEqual(capturedAllowedLocalTools, [], 'a typed decline advertises no local tool authority');
  assert.deepEqual(capturedMcpToolAllowlist, [], 'a typed decline loads no local MCP schemas');
  assert.deepEqual(capturedLocalToolUniverse, [], 'deferred tool acquisition is unavailable on a decline');
  assert.deepEqual(capturedRequiredLocalTools, [], 'a conversational decline requires no tool surface');
  assert.equal(capturedScope?.maxTools, 0, 'a decline inherits no external MCP authority');
  assert.deepEqual(capturedScope?.allowedServerSlugs, []);
  const declineToolPolicies = listEvents(sid, { types: ['tool_policy_resolved'] })
    .filter((event) => event.data.shortCircuitReason === 'declined_continuation');
  assert.equal(declineToolPolicies.length, 1);
  assert.equal(declineToolPolicies[0]!.data.outputCount, 0);
  assert.equal(declineToolPolicies[0]!.data.semanticAcquisitionSkipped, true);
  assert.equal(declineToolPolicies[0]!.data.schemaWarmSkipped, true);
  assert.equal(declineToolPolicies[0]!.data.advertisedSchemaCount, 0);
  assert.equal(declineToolPolicies[0]!.data.catalogCount, 0);
  const declinePrimer = listEvents(sid, { types: ['turn_memory_primer'] }).at(-1);
  assert.ok(declinePrimer);
  assert.equal(declinePrimer.data.queryPreview, 'No.', 'retrieval telemetry is literal B, never private A/Q/B');
  assert.equal(declinePrimer.data.skippedReason, 'declined_continuation');
  assert.equal(declinePrimer.data.hitCount, 0);
  assert.equal(declinePrimer.data.injected, false);
  assert.equal(declinePrimer.data.source, null);
  const declineContextPacket = listEvents(sid, { types: ['agent_context_packet'] }).at(-1);
  assert.ok(declineContextPacket);
  assert.equal(
    declineContextPacket.data.semanticEnrichmentSkippedReason,
    'declined_continuation',
  );
  assert.equal(declineContextPacket.data.multiItem?.detected, false);
  assert.equal(
    listEvents(sid, { types: ['tool_jit_scope'] }).length,
    0,
    'typed decline bypasses JIT/schema acquisition even when both are enabled',
  );
  assert.equal(
    listEvents(sid, { types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'request_bound_external_write_missing'),
    false,
    'the declined parent send creates no missing-write coercion',
  );
});

test('a compound decline keeps the full conversation provider-visible while private authority follows only the fresh clause', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'off';
  const sid = createSession({ kind: 'chat' }).id;
  const originAttempt = beginRunAttempt(sid);
  const origin = recordRunAttemptUserInput(originAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Send the client email.' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Should I send it?',
      options: ['Yes', 'No'],
      purpose: 'clarification',
      source: 'decision_awaiting',
      sourceUserSeq: origin.seq,
    },
  });
  const identity = { sessionId: sid, turn: 1, sourceUserSeq: origin.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Should I send it?' },
  });

  const fullMessage = 'No—leave that email unsent. Instead, what is 15 × 9? Answer naturally without tools.';
  const activeClause = 'what is 15 × 9? Answer naturally without tools.';
  const providerReply = 'Happy to switch gears — that comes to one hundred thirty-five.';
  const recallQueries: string[] = [];
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    recallQueries.push(query);
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });

  let runCalls = 0;
  let capturedPrompt = '';
  let capturedArtifactObjective = '';
  let capturedNativeMcpScopeInput = '';
  let capturedTurnContext = '';
  let capturedPriorTurns: Array<{ who: 'user' | 'assistant'; text: string }> = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    capturedPrompt = options.prompt;
    capturedArtifactObjective = options.artifactObjective ?? '';
    capturedNativeMcpScopeInput = options.nativeMcpScopeInput ?? '';
    capturedTurnContext = options.turnContext ?? '';
    capturedPriorTurns = options.priorTurns ?? [];
    settleAdmittedRead({ sessionId: sid, sourceUserSeq: options.sourceUserSeq! });
    return {
      text: providerReply,
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: fullMessage,
    sessionId: sid,
  });

  assert.equal(response.text, providerReply, 'the runtime preserves the provider-authored conversational reply');
  assert.equal(response.stoppedReason, 'success');
  assert.equal(runCalls, 1, 'the compound turn is one normal provider dispatch, not a canned decline short-circuit');
  assert.equal(capturedPrompt, fullMessage, 'the provider receives the complete literal current message');
  assert.deepEqual(
    capturedPriorTurns,
    [
      { who: 'user', text: 'Send the client email.' },
      { who: 'assistant', text: 'Should I send it?' },
    ],
    'the provider also retains the complete parent conversation for a natural transition',
  );
  assert.equal(capturedArtifactObjective, activeClause, 'artifact and completion policy see only the fresh task');
  assert.equal(capturedNativeMcpScopeInput, activeClause, 'native MCP authority is scoped only to the fresh task');
  assert.deepEqual(recallQueries, [activeClause], 'discovery and memory retrieval ignore the declined parent');
  assert.match(capturedTurnContext, /keep the full reply conversationally intact/i);
  assert.match(capturedTurnContext, /only the fresh clause as active authority/i);

  const acceptedInputs = listEvents(sid, { types: ['user_input_received'] });
  assert.equal(acceptedInputs.at(-1)?.data.text, fullMessage, 'the durable user transcript preserves the literal reply');
  const primer = listEvents(sid, { types: ['turn_memory_primer'] }).at(-1);
  assert.ok(primer);
  assert.equal(primer.data.queryPreview, activeClause);
  const contextPacket = listEvents(sid, { types: ['agent_context_packet'] }).at(-1);
  assert.ok(contextPacket);
  assert.equal(contextPacket.data.inputPreview, activeClause);
  assert.equal(contextPacket.data.semanticEnrichmentSkippedReason, null);
  assert.equal(
    listEvents(sid, { types: ['tool_policy_resolved'] })
      .some((event) => event.data.shortCircuitReason === 'declined_continuation'),
    false,
    'separate new work stays on the semantic path instead of becoming a canned decline',
  );
});

test('an exact affirmative still recovers the aligned send objective and keeps write verification', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS = '0';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = createSession({ kind: 'chat' }).id;
  const originAttempt = beginRunAttempt(sid);
  const origin = recordRunAttemptUserInput(originAttempt, {
    turn: 1,
    role: 'user',
    data: { text: 'Send the client email.' },
  });
  await renderClaudeAgentBrainTurnContext({
    message: 'Send the client email.',
    sessionId: sid,
  }, { sourceUserSeq: origin.seq });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question: 'Should I send it?',
      options: ['Yes', 'No'],
      purpose: 'clarification',
      source: 'decision_awaiting',
      sourceUserSeq: origin.seq,
    },
  });
  const identity = { sessionId: sid, turn: 1, sourceUserSeq: origin.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: 'Should I send it?' },
  });
  let unifiedRecallCalls = 0;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedRecallCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  let capturedArtifactObjective = '';
  let capturedAllowedLocalTools: string[] | undefined;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    capturedArtifactObjective = options.artifactObjective ?? '';
    capturedAllowedLocalTools = options.allowedLocalMcpTools;
    return {
      text: 'Sent it.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Yes.',
    sessionId: sid,
  });

  assert.equal(capturedArtifactObjective, 'Send the client email.');
  assert.ok(unifiedRecallCalls > 0, 'the decline short-circuit does not disable affirmative retrieval');
  assert.ok((capturedAllowedLocalTools?.length ?? 0) > 0, 'the affirmative twin keeps its agent tool surface');
  const affirmativeContextPacket = listEvents(sid, { types: ['agent_context_packet'] }).at(-1);
  assert.ok(affirmativeContextPacket);
  assert.equal(
    affirmativeContextPacket.data.semanticEnrichmentSkippedReason,
    null,
    'the typed decline boundary must not suppress semantic enrichment for an affirmative answer',
  );
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, 'Sent it.', 'the hold preserves the model-authored terminal account');
  assert.ok(
    listEvents(sid, { types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'request_bound_external_write_missing'),
    'the decline fix must not disable positive write verification',
  );
});

test('renderClaudeAgentBrainSystemAppend describes local-authoring workflow/model-role capability', () => {
  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'hi', sessionId: 'brain-prompt' }, 'local_authoring');
  assert.match(prompt, /local-authoring tools/);
  assert.match(prompt, /workflow_run only queues/);
  assert.match(prompt, /set_model_role/);
  assert.match(prompt, /usesSkill/);
  assert.doesNotMatch(prompt, /READ-ONLY\/local-context/);
});

test('renderClaudeAgentBrainTurnContext bounds slow unified recall and falls back open', { timeout: 30_000 }, async () => {
  process.env.CLEMMY_BRAIN_QUERY_RECALL_TIMEOUT_MS = '5';
  process.env.CLEMMY_UNIFIED_RECALL = 'off'; // keep degraded breadcrumbs synchronous in this timeout test
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async () => await new Promise(() => { /* intentionally stalled */ }));
  let fallbackCalls = 0;
  setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => {
    fallbackCalls += 1;
    return [];
  });
  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'priority account accounts', sessionId: 'brain-recall-timeout' });
  // The explicit test timeout is the runaway guard. A wall-clock assertion is
  // unreliable when the full suite deschedules this worker alongside embedding-heavy tests.
  assert.equal(fallbackCalls, 1, 'timed-out unified recall falls back to the bounded hybrid search');
  assert.doesNotMatch(ctx, /Relevant To Your Request\n- /, 'timed-out recall block is omitted');
});

test('Claude brain primer surfaces an exact-date recorded meeting before external calendar lookup', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  const db = openMemoryDb();
  const meetingPath = '/vault/04-Meetings/2026-07-14-in-person_meeting-local-review-primer.md';
  const insert = db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const metadata = `---
type: meeting-transcript
source: local whisper (base.en)
recording_id: recording-in-person-review-primer
title: Acme Partnership Revenue and Legal Data Integration Review
started_at: 2026-07-14T20:24:09.442Z
---`;
  const summary = '## Summary\nInternal Acme team meeting reviewing partnership revenue against 2026 goals and legal data integration gaps.';
  try {
    insert.run(meetingPath, 0, metadata, null, Date.now(), Buffer.byteLength(metadata), 'primer-meeting-metadata');
    insert.run(meetingPath, 1, summary, 'Summary', Date.now(), Buffer.byteLength(summary), 'primer-meeting-summary');
    const ctx = await renderClaudeAgentBrainTurnContext({
      message: 'What was my recorded meeting on 2026-07-14 about?',
      sessionId: 'brain-recorded-meeting-primer',
    });
    assert.match(ctx, /\[NOTE\]/);
    assert.doesNotMatch(ctx, /\[why:/, 'automatic primer keeps ranking explanations out of the prompt');
    assert.match(ctx, /Acme Partnership Revenue and Legal Data Integration Review/);
    assert.match(ctx, /partnership revenue/);
    assert.ok(ctx.includes(meetingPath), 'primer carries the local source path for memory_read');
  } finally {
    db.prepare('DELETE FROM vault_chunks WHERE path = ?').run(meetingPath);
  }
});

test('Claude brain volatile turn context includes degraded harness capability health', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  capabilityHealth.recordHarnessCapabilityHealth({
    id: 'claude_sdk_local_mcp_surface',
    state: 'degraded',
    summary: 'Claude SDK local MCP surface did not advertise tools the harness depends on.',
    reason: 'missing required local MCP tool: memory_recall',
    sessionId: 'brain-health-context',
    details: { missingTools: ['memory_recall'], availableToolCount: 0 },
  });
  capabilityHealth.recordHarnessCapabilityHealth({
    id: 'healthy_thing',
    state: 'healthy',
    summary: 'Healthy should stay silent.',
  });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-health-context' });

  assert.match(ctx, /## Harness Capability Health/);
  assert.match(ctx, /claude_sdk_local_mcp_surface: degraded/);
  assert.match(ctx, /memory_recall/);
  assert.match(ctx, /harness_status/);
  assert.doesNotMatch(ctx, /healthy_thing/);
});

test('Claude brain carries same-session external-write ledger in the volatile turn context', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  createSession({ id: 'brain-actions-split', kind: 'chat', title: 'actions' });
  appendEvent({ sessionId: 'brain-actions-split', turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-actions-split' });

  assert.match(ctx, /ALREADY DONE in THIS conversation/);
  assert.match(ctx, /OUTLOOK_SEND_EMAIL/);
  assert.match(ctx, /casey@example\.com/);
  assert.equal(ctx.match(/ALREADY DONE in THIS conversation/g)?.length, 1);
});

test('Claude brain volatile turn context includes cross-session continuation prefix', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  createSession({ id: 'brain-prefix-split', kind: 'chat', channel: 'discord', title: 'fresh split' });
  appendEvent({
    sessionId: 'brain-prefix-split',
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      text: [
        '[CONTINUATION CONTEXT]',
        '  USER: Work from the approved client sheet.',
        '  YOU: I found the correct sheet id.',
      ].join('\n'),
    },
  });

  const ctx = await renderClaudeAgentBrainTurnContext({ message: 'continue', sessionId: 'brain-prefix-split' });

  assert.match(ctx, /\[CONTINUATION CONTEXT\]/);
  assert.match(ctx, /approved client sheet/);
});

test('Claude brain carries same-session external-write ledger in system append when context split is off', () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'off';
  createSession({ id: 'brain-actions-nosplit', kind: 'chat', title: 'actions' });
  appendEvent({ sessionId: 'brain-actions-nosplit', turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'CRM_UPDATE', targets: ['record:acct-42'] } });

  const prompt = renderClaudeAgentBrainSystemAppend('home', { message: 'continue', sessionId: 'brain-actions-nosplit' }, 'full');

  assert.match(prompt, /ALREADY DONE in THIS conversation/);
  assert.match(prompt, /CRM_UPDATE/);
  assert.match(prompt, /record:acct-42/);
  assert.equal(prompt.match(/ALREADY DONE in THIS conversation/g)?.length, 1);
});

test('Claude brain keeps unified recall enabled when context split is off', async () => {
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'off';
  const sourceUri = 'meeting://local/no-split-review';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 6, stores: ['episode'], elapsedMs: 2 },
    perStore: { episode: 1 },
    hits: [{
      type: 'episode', ref: 'no-split-review', title: 'In-person no-split review',
      snippet: 'Reviewed the temporal memory rollout.', score: 0.98, confidence: 0.95,
      whyRecalled: ['exact temporal match'],
      evidence: [{ episodeId: 'no-split-review', excerpt: 'Reviewed the rollout.', sourceUri }],
    }],
  }));

  const ctx = await renderClaudeAgentBrainTurnContext({
    message: 'What was my in-person meeting today about?',
    sessionId: 'brain-no-split-unified-memory',
  });

  assert.match(ctx, /\[MEMORY PRIMER\]/);
  assert.match(ctx, /\[EPISODE\].*In-person no-split review/);
  assert.match(ctx, /meeting:\/\/local\/no-split-review/);
  assert.doesNotMatch(ctx, /# Current State/, 'persistent and volatile blocks stay in the system append');
});

test('Claude brain honors request-local recall opt-out while retaining pinned policy context', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const safetyRule = 'Never send the explicit-opt-out fixture externally without authorization.';
  rememberFact({ kind: 'constraint', content: safetyRule });

  let unifiedRecallCalls = 0;
  let captured: any;
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => {
    unifiedRecallCalls += 1;
    return {
      objective: query,
      hits: [],
      perStore: {},
      answerability: 'insufficient',
      diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
    };
  });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Handled from the supplied request.',
      sessionId: 'sdk-explicit-memory-opt-out',
      model: 'claude',
      toolUses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Do not use code mode, shell, workspace, or memory. Answer only from this request.',
    sessionId: 'brain-explicit-memory-opt-out',
  });

  assert.equal(unifiedRecallCalls, 0, 'the optional query recall does no retrieval work');
  assert.doesNotMatch(captured.turnContext ?? '', /\[MEMORY PRIMER\]|## Relevant To Your Request/);
  assert.match(captured.systemAppend ?? '', new RegExp(safetyRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'request-local primer opt-out must not suppress the stable pinned-policy tier');
  const event = listEvents('brain-explicit-memory-opt-out', { types: ['turn_memory_primer'] })[0];
  assert.ok(event);
  assert.equal(event.data.enabled, true);
  assert.equal(event.data.injected, false);
  assert.equal(event.data.hitCount, 0);
  assert.equal(event.data.source, null);
  assert.equal(event.data.skippedReason, 'explicit_request_opt_out');
});

test('respondViaClaudeAgentSdkBrain read_only mode uses read-only tools, honors excludes, and commits final text', async () => {
  const chunks: string[] = [];
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off'; // pin off: this test guards the unfiltered read-only surface
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    settleAdmittedRead({ sessionId: 'brain-run', sourceUserSeq: options.sourceUserSeq! });
    return {
      text: 'Claude brain reply',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-4-6',
      toolUses: ['mcp__clementine-local__memory_search'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'search memory',
    sessionId: 'brain-run',
    excludeToolNames: ['memory_read'],
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.text, 'Claude brain reply');
  assert.equal(
    res.stoppedReason,
    'success',
    JSON.stringify({ response: res, terminal: listEvents('brain-run', { types: ['conversation_completed'] }).at(-1) }),
  );
  assert.equal(res.raw?.transport, 'claude_agent_sdk_brain');
  assert.deepEqual(chunks, [], 'provider and terminal text are delivered through the public event plane, not raw callbacks');
  assert.equal(captured.onDelta, undefined);
  assert.equal(getSession('brain-run')?.metadata?.source, 'claude-agent-sdk-brain:home');
  assert.equal(getSession('brain-run')?.metadata?.readOnly, true);
  assert.equal(captured.prompt, 'search memory');
  assert.equal(captured.sessionId, 'brain-run');
  assert.match(captured.trackerScopeId, /^brain-run::brain:attempt-/);
  assert.equal(captured.maxTurns, 12);
  assert.ok(captured.allowedLocalMcpTools.includes('memory_search'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_remember'));
  assert.equal(captured.allowedLocalMcpTools.includes('memory_read'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
  // JIT pinned off above → no MCP tool-allowlist passed (server advertises all tools).
  assert.equal(captured.mcpToolAllowlist, undefined, 'JIT off must not filter the MCP surface');
  assert.equal(listEvents('brain-run', { types: ['turn_memory_primer'] }).length, 1);
  assert.equal(listEvents('brain-run', { types: ['agent_context_packet'] }).length, 1);
  const effort = listEvents('brain-run', { types: ['reasoning_effort'] })[0]?.data as { transport?: string; effort?: string } | undefined;
  assert.equal(effort?.transport, 'claude_agent_sdk_brain');
  assert.equal(effort?.effort, 'provider_default');
  const workingMemory = readFileSync(workingMemoryPathForSession('brain-run'), 'utf-8');
  assert.match(workingMemory, /search memory/);
  assert.match(workingMemory, /Claude brain reply/, 'Claude-lane writeback runs after the terminal assistant reply is durable');
});

test('Claude SDK transport window stays flat across objective shapes', () => {
  assert.equal(resolveClaudeAgentBrainMaxTurns('search memory'), 12);
  assert.equal(
    resolveClaudeAgentBrainMaxTurns('Build me a workspace called Proof Cockpit with a local task runner.'),
    12,
  );
  assert.equal(
    resolveClaudeAgentBrainMaxTurns('Let’s brainstorm how we might build a workspace for this someday.'),
    12,
    'prose does not widen provider-owned control flow',
  );
  assert.equal(
    resolveClaudeAgentBrainMaxTurns('Build it now.', [
      'Let’s brainstorm a social media command-center workspace with a local content calendar.',
    ]),
    12,
    'conversation history does not widen provider-owned control flow',
  );
});

test('brain tracker scope survives a settled retry with the same durable run id and rotates for a new run', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const scopes: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    scopes.push(options.trackerScopeId ?? '');
    return {
      text: 'done',
      sessionId: options.sessionId,
      model: 'claude-sonnet-5',
      toolUses: [],
    };
  });

  const base = { message: 'read the current status', sessionId: 'brain-stable-scope' };
  await respondViaClaudeAgentSdkBrain('home', { ...base, runId: 'run-stable-retry' });
  await respondViaClaudeAgentSdkBrain('home', { ...base, runId: 'run-stable-retry' });
  await respondViaClaudeAgentSdkBrain('home', { ...base, runId: 'run-new-work' });

  assert.equal(scopes[0], 'brain-stable-scope::brain:run-stable-retry');
  assert.equal(scopes[1], scopes[0], 'a re-dispatch of the same durable run cannot reset dedupe counters');
  assert.equal(scopes[2], 'brain-stable-scope::brain:run-new-work');
  assert.notEqual(scopes[2], scopes[0]);
});

test('desktop brain reuses and binds the exact pre-recorded request input without echoing it as history', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = 'brain-pre-recorded-input';
  const runId = 'desktop:pre-recorded-run';
  const acceptedMessage = '/goal start Create the firm brief.';
  const runtimeMessage = 'Execute the normalized goal objective: create the firm brief.';
  createSession({ id: sid, kind: 'chat', channel: 'desktop' });
  claimHarnessChatRequest({
    requestId: 'client-pre-recorded-1234',
    sessionId: sid,
    runId,
    inputHash: 'hash',
    sinceSeq: 0,
  });
  const acceptedAttempt = beginRunAttempt(sid, { runId });
  const source = recordRunAttemptUserInput(acceptedAttempt, {
    turn: 1,
    role: 'user',
    data: { text: acceptedMessage, requestId: 'client-pre-recorded-1234', runId },
  });
  let seenPriorTurns: unknown[] | undefined;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    seenPriorTurns = options.priorTurns;
    return { text: 'Brief created.', sessionId: 'sdk', model: 'claude', toolUses: [] };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: runtimeMessage,
    sessionId: sid,
    runId,
    channel: 'desktop',
  });

  const inputs = listEvents(sid, { types: ['user_input_received'] });
  assert.equal(inputs.length, 1, 'pre-recorded input is not appended a second time');
  assert.equal(inputs[0].seq, source.seq);
  assert.deepEqual(seenPriorTurns, [], 'the literal accepted input is not echoed into transformed runtime history');
  assert.equal(getLatestRunAttempt(sid)?.sourceUserSeq, source.seq);
});

test('Claude exact-source resume uses the private directive without appending a synthetic user turn', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = 'brain-exact-source-resume';
  createSession({ id: sid, kind: 'chat', channel: 'desktop' });
  const source = appendEvent({
    sessionId: sid,
    turn: 9,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Yes, approve the exact queued action.',
      approvalId: 'apr-exact-source',
      decision: 'approve',
      source: 'desktop_approval',
    },
  });
  let prompt = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompt = options.prompt;
    return { text: 'The approved action completed.', sessionId: 'sdk', model: 'claude', toolUses: [] };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: '[approval-resume] Execute the exact approved queued action now.',
    displayMessage: 'Yes, approve the exact queued action.',
    sourceUserSeq: source.seq,
    sessionId: sid,
    channel: 'daemon',
  });

  assert.match(prompt, /^\[approval-resume\]/);
  const inputs = listEvents(sid, { types: ['user_input_received'] });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].seq, source.seq);
  assert.equal(inputs[0].data.text, 'Yes, approve the exact queued action.');
  assert.equal(getLatestRunAttempt(sid)?.sourceUserSeq, source.seq);
  const terminal = listEvents(sid, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.terminalKey, `turn:${source.seq}`);
  assert.equal(
    (terminal?.data.presentation as { identity?: { turn?: number; sourceUserSeq?: number } }).identity?.turn,
    source.turn,
  );
});

test('ordinary manual continue rotates attempt scopes without minting artifact lineage', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE = 'off';
  const trackerScopes: string[] = [];
  const artifactScopes: string[] = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    trackerScopes.push(options.trackerScopeId ?? '');
    artifactScopes.push(options.artifactRunScopeId ?? '');
    return calls === 1
      ? {
          text: 'I reached the turn budget. Say continue.', sessionId: 'sdk', model: 'claude',
          toolUses: ['mcp__clementine-local__read_file'], limitHit: true,
        }
      : { text: 'Finished.', sessionId: 'sdk', model: 'claude', toolUses: [] };
  });
  const sid = 'brain-manual-continue-root';
  await respondViaClaudeAgentSdkBrain('home', { message: 'Review the long report.', sessionId: sid, runId: 'run-first' });
  await respondViaClaudeAgentSdkBrain('home', { message: 'continue', sessionId: sid, runId: 'run-continue' });
  assert.notEqual(trackerScopes[1], trackerScopes[0], 'guardrail counters start fresh for the new user turn');
  assert.notEqual(artifactScopes[1], artifactScopes[0], 'unpersisted candidates rotate with the real user attempt');
  assert.equal(artifactLedger.getArtifactRunScope(sid, artifactScopes[0]), null);
  assert.equal(artifactLedger.getArtifactRunScope(sid, artifactScopes[1]), null);
  const terminal = listEvents(sid, { types: ['conversation_completed'] }).at(-1);
  assert.equal(terminal?.data.artifactRunScopeId, undefined, 'ordinary read-only work projects no fake artifact root');
  delete process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE;
});

test('a structurally paused go-ahead preserves the multi-document objective for SDK scope and artifact identity', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sid = 'brain-confirmed-objective';
  const original = 'Create two separate Google Docs: a client brief and a technical appendix.';
  const captured: Array<{ artifactObjective?: string; artifactRunScopeId?: string; nativeMcpScopeInput?: string; sourceUserSeq?: number }> = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured.push(options);
    return {
      text: 'Starting the confirmed work.',
      sessionId: 'sdk', model: 'claude', toolUses: [],
    };
  });

  createSession({ id: sid, kind: 'chat' });
  const legacyRequest = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: original },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      objective: original,
      intentKey: 'legacy-confirmed-objective',
      sourceUserSeq: legacyRequest.seq,
    },
  });
  const question = 'I have the two-document request. Should I go ahead?';
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: legacyRequest.seq,
      intentKey: 'legacy-confirmed-objective',
    },
  });
  const legacyIdentity = { sessionId: sid, turn: 1, sourceUserSeq: legacyRequest.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(legacyIdentity),
    identity: legacyIdentity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  }, { legacyReason: 'awaiting_user_input' });
  await respondViaClaudeAgentSdkBrain('home', { message: 'Go ahead.', sessionId: sid, runId: 'confirm-execute' });

  assert.equal(captured.length, 1);
  // The restored live beat records the go-ahead turn's own typed decision;
  // the legacy align row stays untouched beside it.
  assert.equal(
    listEvents(sid, { types: ['turn_preflight_decision'] }).length,
    2,
    'the acknowledgement turn records its typed decision without rewriting the legacy row',
  );
  assert.equal(captured[0]?.artifactObjective, original);
  assert.equal(captured[0]?.nativeMcpScopeInput, original, 'tool scoping sees the approved task, not only the control phrase');
  const latestInput = listEvents(sid, { types: ['user_input_received'] }).at(-1);
  assert.equal(captured[0]?.sourceUserSeq, latestInput?.seq, 'legacy continuity is pinned to the exact accepted control turn');
  assert.equal(
    artifactLedger.getArtifactRunScope(sid, captured[0]?.artifactRunScopeId ?? ''),
    null,
    'objective recovery alone does not mint artifact lineage',
  );
});

test('Claude dispatch telemetry carries exact unified-primer refs and recall id', async () => {
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sourceUri = '/vault/04-Meetings/2026-07-15-live-review.md';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 3, stores: ['note', 'episode'], elapsedMs: 7 },
    perStore: { vault: 1 },
    hits: [{
      type: 'vault', ref: sourceUri, title: 'Live review', snippet: 'Reviewed memory reliability.',
      score: 0.97, confidence: 0.95, whyRecalled: ['exact temporal match'],
      evidence: [{ episodeId: `note:${sourceUri}`, excerpt: 'Reviewed memory reliability.', sourceUri }],
    }],
  }));
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'The meeting reviewed memory reliability.', sessionId: 'sdk', model: 'claude', toolUses: [],
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'What was my meeting today about?', sessionId: 'brain-unified-primer-telemetry',
  });

  const event = listEvents('brain-unified-primer-telemetry', { types: ['turn_memory_primer'] })[0];
  assert.ok(event);
  assert.equal(event.data.source, 'unified');
  assert.equal(event.data.hitCount, 1);
  assert.equal(event.data.includedCount, 1);
  assert.equal(event.data.omittedCount, 0);
  assert.equal(event.data.candidateCount, 3);
  assert.deepEqual(event.data.stores, ['note', 'episode']);
  assert.equal(event.data.answerability, 'supported');
  assert.match(String(event.data.recallId), /^mr-/);
  const run = openMemoryDb().prepare('SELECT surface, candidate_refs_json FROM memory_recall_runs WHERE id = ?')
    .get(event.data.recallId) as { surface: string; candidate_refs_json: string };
  assert.equal(run.surface, 'claude_primer');
  assert.deepEqual(JSON.parse(run.candidate_refs_json), [
    // The snippet carries what the model actually SAW (title + snippet) so
    // post-turn auto-credit can match demonstrable use; identity stays type:id.
    { type: 'note', id: sourceUri, snippet: 'Live review: Reviewed memory reliability.' },
  ]);
});

test('the shared post-turn seam FIRES on the Claude brain lane (auto-credit runs at runtime, not just wired)', async () => {
  // #1 verification — the durable stand-in for a live both-SDK check. loop.test
  // covers the Codex lane's post-turn firing; this drives the REAL brain entry
  // (respondViaClaudeAgentSdkBrain) and proves runPostTurnHooks actually ran and
  // credited demonstrable recall use — the seam is live on this lane, not merely
  // present in source (which correction-parity.test guards statically).
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_TOOL_JIT = 'off';
  const sourceUri = '/vault/04-Meetings/2026-07-19-meridian-review.md';
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    answerability: 'supported',
    diagnostics: { candidates: 2, stores: ['note'], elapsedMs: 4 },
    perStore: { vault: 1 },
    hits: [{
      type: 'vault', ref: sourceUri, title: 'Meridian review',
      snippet: 'Quarterly reliability review of the Meridian-7 launch.',
      score: 0.96, confidence: 0.94, whyRecalled: ['exact temporal match'],
      evidence: [{ episodeId: `note:${sourceUri}`, excerpt: 'Quarterly reliability review of the Meridian-7 launch.', sourceUri }],
    }],
  }));
  // Reply echoes distinctive words from the recalled snippet ("Meridian-7",
  // "reliability", "launch") that are absent from the query → a 'content' credit.
  const sid = 'brain-post-turn-seam-fires';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    settleAdmittedRead({ sessionId: sid, sourceUserSeq: options.sourceUserSeq! });
    return {
      text: 'The Meridian-7 launch reliability review is on track.', sessionId: 'sdk', model: 'claude', toolUses: [],
    };
  });

  await respondViaClaudeAgentSdkBrain('home', { message: 'What did we cover?', sessionId: sid });

  const credit = listEvents(sid, { types: ['recall_auto_credit'] });
  assert.equal(credit.length, 1, 'the post-turn seam ran auto-credit on the brain lane');
  const refs = (credit[0].data.runs as Array<{ refs: Array<{ ref: string }> }>).flatMap((r) => r.refs.map((x) => x.ref));
  assert.ok(refs.includes(`note:${sourceUri}`), 'the demonstrably-used recalled note was credited');
});

test('JIT explicitly off: the SDK brain passes the FULL profile + no mcpToolAllowlist (byte-identical surface)', async () => {
  // Guards both kill switches: disabling native ToolSearch and semantic JIT
  // restores the pre-deferral surface byte-for-byte.
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'off';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.AUTH_MODE = 'claude_oauth';
  let captured: any;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return { text: 'ok', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });
  await respondViaClaudeAgentSdkBrain('home', { message: 'create a workflow that emails me daily', sessionId: 'jit-off-run' });
  assert.equal(captured.mcpToolAllowlist, undefined, 'no allowlist when JIT is off');
  // full profile still present (e.g. the agentic execution tools), unfiltered.
  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'));
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'));
});

test('full mode: schema-on-demand loads a bounded hot set without pruning permissions', async () => {
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.AUTH_MODE = 'claude_oauth';
  let captured: any;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return { text: 'ok', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Use run_shell_command to inspect the project.',
    sessionId: 'native-tool-search-run',
  });

  assert.ok(captured.allowedLocalMcpTools.includes('composio_execute_tool'), 'the full permission surface remains allowed');
  assert.ok(captured.allowedLocalMcpTools.includes('run_shell_command'));
  assert.ok(captured.mcpToolAllowlist.includes('memory_recall_all'), 'the recovery kernel stays first-class');
  assert.ok(captured.mcpToolAllowlist.includes('run_shell_command'), 'an explicitly named tool is promoted');
  assert.ok(
    captured.mcpToolAllowlist.length < captured.allowedLocalMcpTools.length,
    'unneeded schemas are deferred instead of permission-pruned',
  );
  assert.ok(
    captured.localMcpToolUniverse.length > captured.mcpToolAllowlist.length,
    'the deferred authority universe remains available to the generic dispatcher',
  );
  assert.deepEqual(
    captured.requiredLocalMcpTools,
    // An accepted action mounts its one semantic business carrier INSTEAD of the
    // unbound generic dispatcher, so the kernel's third slot is work_call here.
    // The non-action half of that same rule is pinned by the dock test below.
    ['memory_recall_all', 'tool_search', 'work_call'],
    'the acquisition and recovery kernel is required at SDK init',
  );
  const scope = listEvents('native-tool-search-run', { types: ['tool_jit_scope'] }).at(-1);
  assert.equal(scope?.data.acquisition, 'tool_search_call_tool');
  assert.equal(scope?.data.reason, 'schema-on-demand-dispatch');
});

test('Workspace dock: schema-on-demand loads the common edit kernel and defers specialized schemas', async () => {
  process.env.CLEMMY_TOOL_JIT = 'off';
  process.env.CLEMMY_CLAUDE_TOOL_SEARCH = 'on';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.AUTH_MODE = 'claude_oauth';
  const { spaceStore } = await import('../../spaces/store.js');
  spaceStore.save({ id: 'schema-lean-space', title: 'Schema Lean Space' });
  let captured: any;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return { text: 'The workspace is ready.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 } };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Can we make this easier to scan?',
    sessionId: 'space-schema-lean-space',
  });

  // The other half of the kernel's carrier rule. A non-action turn keeps the
  // generic dispatcher, so both branches of that one decision stay pinned and
  // neither lane can drift alone.
  assert.deepEqual(
    captured.requiredLocalMcpTools,
    ['memory_recall_all', 'tool_search', 'call_tool'],
    'a non-action dock keeps the generic dispatcher in the kernel',
  );
  for (const common of ['space_get', 'space_get_view', 'space_edit_view']) {
    assert.ok(captured.mcpToolAllowlist.includes(common), `${common} stays first-class in a dock`);
  }
  for (const specialized of ['space_get_runner', 'space_edit_runner', 'space_try_runner', 'space_history', 'space_diff', 'space_action_prepare', 'space_publish', 'space_save']) {
    assert.ok(captured.allowedLocalMcpTools.includes(specialized), `${specialized} remains permitted`);
    assert.ok(captured.localMcpToolUniverse.includes(specialized), `${specialized} remains call_tool-reachable`);
    assert.equal(captured.mcpToolAllowlist.includes(specialized), false, `${specialized} schema is deferred until needed`);
  }
});

test('full mode: a not-done judge verdict cannot reopen the SDK', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const prompts: string[] = [];
  const trackerScopes: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    trackerScopes.push(options.trackerScopeId ?? '');
    if (prompts.length === 2) {
      for (const target of ['one@example.com', 'two@example.com', 'three@example.com']) {
        appendEvent({
          sessionId: 'brain-judge',
          turn: 0,
          role: 'tool',
          type: 'external_write',
          data: {
            shapeKey: 'OUTLOOK_SEND_EMAIL',
            toolName: 'composio_execute_tool',
            targets: [target],
          },
        });
      }
    }
    return {
      text: prompts.length === 1 ? "I'll send the emails next." : 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-judge' });

  assert.equal(prompts.length, 1, 'the judge classifies but cannot mint another model step');
  assert.equal(new Set(trackerScopes).size, 1, 'initial dispatch and continuation share one durable attempt scope');
  assert.match(trackerScopes[0], /^brain-judge::brain:attempt-/);
  assert.equal(judged, 1);
  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, "I'll send the emails next.");
  assert.equal(listEvents('brain-judge', { types: ['external_write'] }).length, 0);
});

test('Claude turn-wide attribution owns completion-judge usage for the exact accepted source and attempt', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-judge-usage-attribution';
  const responseId = 'resp-brain-judge-usage-attribution';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Completed the requested release analysis.',
    sessionId: 'sdk-provider-session',
    model: 'claude-sonnet-test',
    toolUses: [],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    // The real Claude self-judge only knows its provider session UUID. The
    // accepted-turn wrapper must supply the owning source and attempt tuple.
    recordModelUsage({
      sessionId: 'provider-session-uuid',
      model: 'claude-haiku-test',
      cacheDialect: 'anthropic_split',
      inputTokens: 100,
      outputTokens: 10,
      responseId,
    });
    return { done: true, reason: 'the analysis is present', selfJudge: true };
  });

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Build the release analysis.',
    sessionId,
  });

  const source = listEvents(sessionId, { types: ['user_input_received'] })[0];
  assert.ok(source);
  const attempt = getLatestRunAttempt(sessionId);
  assert.ok(attempt);
  const usage = readUsageEventsForDate().find((event) => event.responseId === responseId);
  assert.equal(usage?.source, sessionId);
  assert.deepEqual(usage?.trace, {
    acceptedSource: `${sessionId}:${source.seq}`,
    logicalTurnId: `turn:${source.seq}`,
    attemptId: attempt.attemptId,
    modelCallId: responseId,
  });
});

test('full mode: a stale execution lookup cannot certify or trigger a newly requested external write', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sessionId = 'brain-request-bound-write';
  createSession({ id: sessionId, kind: 'chat', title: 'request-bound write' });
  appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'old-write-123' },
  });
  const prompts: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    prompts.push(options.prompt);
    if (runs === 1) {
      return {
        text: 'PASS — prior execution exec-old has write receipt old-write-123 and readback old-read-456.',
        sessionId: 'sdk',
        model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__execution_get'],
        successfulToolUses: ['execution_get'],
      };
    }
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'external_write',
      data: { shapeKey: 'GOOGLESHEETS_VALUES_UPDATE', targets: ['Sheet1!E1:G5'], receipt: 'fresh-write-789' },
    });
    return {
      text: 'PASS — the fresh write and exact readback match.',
      sessionId: 'sdk',
      model: 'claude-opus-4-8',
      toolUses: [
        'mcp__clementine-local__composio_execute_tool',
        'mcp__clementine-local__composio_execute_tool',
      ],
      successfulToolUses: ['GOOGLESHEETS_VALUES_UPDATE', 'GOOGLESHEETS_BATCH_GET'],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'receipts appear valid' }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Perform exactly one fresh Google Sheets value write to Sheet1!E1:G5 and read it back.',
    sessionId,
  });

  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(runs, 1, 'a stale claim cannot grant the SDK another execution attempt');
  assert.equal(prompts.length, 1);
  assert.match(res.text, /^PASS\b/);
  assert.equal(listEvents(sessionId, { types: ['external_write'] }).length, 1);
});

test('full mode: exhausted completion retries never false-green a stale external-write PASS', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS = '0';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'PASS — prior execution exec-old proves the new Google Sheet write.',
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: ['mcp__clementine-local__execution_get'],
    successfulToolUses: ['execution_get'],
  }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Perform a fresh Google Sheets write now.',
    sessionId: 'brain-request-bound-write-exhausted',
  });

  assert.equal(res.stoppedReason, 'unverified');
  assert.match(res.text, /^PASS\b/, 'the durable hold preserves the model-authored terminal account');
  assert.ok(
    listEvents('brain-request-bound-write-exhausted', { types: ['guardrail_tripped'] })
      .some((event) => event.data.kind === 'request_bound_external_write_missing'),
  );
});

test('full mode: the fresh-write terminal floor is phrase-independent and request-bound', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS = '0';
  const sessionId = 'brain-overlapping-completion-owner';
  createSession({ id: sessionId, kind: 'chat', title: 'overlapping completion owner' });
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    const foreignSource = appendEvent({
      sessionId,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Unrelated overlapping request B.' },
    });
    appendEvent({
      sessionId,
      turn: 2,
      role: 'tool',
      type: 'tool_returned',
      data: {
        sourceUserSeq: foreignSource.seq,
        tool: 'execution_complete',
        callId: 'foreign-execution-complete',
        preview: 'Execution exec-b completed. Request B has verified receipts.',
      },
    });
    assert.notEqual(foreignSource.seq, options.sourceUserSeq);
    return {
      text: 'The fresh Sheet write is complete.',
      sessionId: 'sdk',
      model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__execution_complete'],
      successfulToolUses: ['execution_complete'],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({
    done: true,
    reason: 'accepted foreign execution certificate',
  }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Perform one fresh Google Sheets write for request A.',
    sessionId,
  });

  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, 'The fresh Sheet write is complete.', 'the hold keeps the authored account and carries uncertainty as state');
});

test('full mode: an accepted execution cannot hide a mixed orphaned write', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_JUDGE_MAX_CONTINUATIONS = '0';
  const sessionId = 'brain-mixed-orphaned-write';
  createSession({ id: sessionId, kind: 'chat', title: 'mixed orphaned write' });
  setClaudeAgentSdkBrainRunForTest(async () => {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'external_write',
      data: {
        callId: 'send-a',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['a@example.com'],
      },
    });
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'external_write',
      data: {
        callId: 'send-b',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['b@example.com'],
      },
    });
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'external_write_orphaned',
      data: {
        callId: 'send-b',
        shapeKey: 'OUTLOOK_SEND_EMAIL',
        targets: ['b@example.com'],
      },
    });
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'tool_returned',
      data: {
        tool: 'execution_complete',
        callId: 'execution-complete-mixed',
        preview: 'Execution exec-mixed completed. All requested sends passed validation.',
      },
    });
    return {
      text: 'Sent both emails successfully.',
      sessionId: 'sdk',
      model: 'claude-opus-4-8',
      toolUses: [
        'mcp__clementine-local__composio_execute_tool',
        'mcp__clementine-local__execution_complete',
      ],
      successfulToolUses: ['OUTLOOK_SEND_EMAIL', 'execution_complete'],
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({
    done: true,
    reason: 'accepted execution certificate',
  }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Send one email to a@example.com and one email to b@example.com.',
    sessionId,
  });

  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, 'Sent both emails successfully.', 'the durable hold does not replace model-authored prose');
  const trip = listEvents(sessionId, { types: ['guardrail_tripped'] })
    .find((event) => event.data.kind === 'request_bound_external_write_missing');
  assert.equal(trip?.data.status, 'ambiguous');
  assert.equal(
    listEvents(sessionId, { types: ['learning_candidate_evaluated'] })
      .some((event) => event.data.eligible === true),
    false,
    'the mixed write cannot become a reusable learned procedure',
  );
});

test('artifact completion stays pending without a second SDK read-back query', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-artifact-verified';
  const documentId = 'doc_verified_123456';
  const prompts: string[] = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    prompts.push(options.prompt);
    const scope = artifactLedger.resolveArtifactRunScopeId(
      sessionId,
      options.artifactRunScopeId ?? options.trackerScopeId as string,
      options.sourceUserSeq,
    );
    if (calls === 1) {
      // The real SDK tool path records this for every returned business call
      // (claude-agent-sdk.ts). A stubbed run replaces that path wholesale, so it
      // must leave the same durable evidence itself — otherwise the turn claims
      // a finished artifact while the ledger shows no work happened at all, and
      // the committer correctly refuses to publish success for it.
      appendEvent({
        sessionId,
        turn: 0,
        role: 'tool',
        type: 'tool_returned',
        data: {
          sourceUserSeq: options.sourceUserSeq,
          tool: 'composio_execute_tool',
          callId: 'toolu_create_doc',
          canonicalCallId: 'toolu_create_doc',
          accounting: 'top_level',
          topologyRole: 'business',
          ok: true,
          successfulBusinessResult: true,
        },
      });
      const intent = artifactLedger.artifactIntentForTool('composio_execute_tool', {
        tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
        arguments: JSON.stringify({ title: 'Firm brief' }),
      });
      assert.ok(intent);
      artifactLedger.claimArtifactSlot(sessionId, intent!, 'toolu_create_doc', scope);
      artifactLedger.bindArtifactSlot(sessionId, intent!.slotKey, {
        resourceId: documentId,
        uri: `https://docs.google.com/document/d/${documentId}/edit`,
        title: 'Firm brief',
      }, 'toolu_create_doc', scope);
      return {
        text: `Created the firm brief: https://docs.google.com/document/d/${documentId}/edit`,
        sessionId: 'sdk', model: 'm',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
        artifactRunScopeId: scope,
      };
    }
    assert.match(options.prompt, new RegExp(`document_id=${documentId}`));
    assert.doesNotMatch(options.prompt, /GOOGLEDOCS_CREATE_DOCUMENT/);
    assert.deepEqual(options.artifactVerificationOnly, [{ kind: 'google_doc', resourceId: documentId }], 'repair is enforced at the permission boundary');
    artifactLedger.verifyArtifactBindingFromToolResult(
      sessionId,
      scope,
      'composio_execute_tool',
      {
        tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
        arguments: JSON.stringify({ document_id: documentId }),
      },
      { data: { document_id: documentId, document_url: `https://docs.google.com/document/d/${documentId}/edit` } },
      'toolu_verify_doc',
      true,
    );
    return {
      text: 'Provider read-back succeeded.', sessionId: 'sdk', model: 'm',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      artifactRunScopeId: scope,
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('background', {
    message: 'Create the firm brief in Google Docs.',
    sessionId,
  });

  assert.equal(calls, 1, 'the SDK cannot mint an exact-ID verification query');
  assert.equal(response.stoppedReason, 'unverified');
  assert.match(response.text, /Created the firm brief/);
  assert.equal(artifactLedger.listUnverifiedRunArtifacts(sessionId).length, 1);
  assert.equal(artifactLedger.listRunArtifacts(sessionId)[0]?.bindingVerifiedAt, null);
});

test('Google Sheet completion stays unverified without a second SDK read-back query', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-sheet-artifact-verified';
  const spreadsheetId = 'sheet_ventura_verified_123456';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    const scope = artifactLedger.resolveArtifactRunScopeId(
      sessionId,
      options.artifactRunScopeId ?? options.trackerScopeId as string,
      options.sourceUserSeq,
    );
    if (calls === 1) {
      const intent = artifactLedger.artifactIntentForTool('composio_execute_tool', {
        tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
        arguments: JSON.stringify({
          title: 'Top 5 Ventura Restaurants',
          sheet_name: 'Restaurants',
          sheet_json: [{ name: 'Lure Fish House', rating: 4.6, address: 'Ventura, CA' }],
        }),
      });
      assert.ok(intent);
      artifactLedger.claimArtifactSlot(sessionId, intent!, 'toolu_create_sheet', scope);
      artifactLedger.bindArtifactSlot(sessionId, intent!.slotKey, {
        resourceId: spreadsheetId,
        uri: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        title: 'Top 5 Ventura Restaurants',
      }, 'toolu_create_sheet', scope);
      return {
        text: `Created the Ventura restaurant sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        sessionId: 'sdk', model: 'm',
        toolUses: ['mcp__clementine-local__work_call'],
        artifactRunScopeId: scope,
      };
    }
    assert.match(options.prompt, new RegExp(`spreadsheet_id=${spreadsheetId}`));
    assert.doesNotMatch(options.prompt, /SHEET_FROM_JSON/);
    assert.deepEqual(
      options.artifactVerificationOnly,
      [{ kind: 'resource', resourceId: spreadsheetId }],
      'the repair permission boundary is frozen to the exact created spreadsheet id',
    );
    artifactLedger.verifyArtifactBindingFromToolResult(
      sessionId,
      scope,
      'composio_execute_tool',
      {
        tool_slug: 'GOOGLESHEETS_BATCH_GET',
        arguments: JSON.stringify({ spreadsheet_id: spreadsheetId, ranges: ['Restaurants!A1:C6'] }),
      },
      {
        successful: true,
        data: {
          spreadsheetId,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
          valueRanges: [{ range: 'Restaurants!A1:C6', values: [['name', 'rating', 'address']] }],
        },
      },
      'toolu_verify_sheet',
      true,
    );
    return {
      text: 'Provider read-back succeeded.', sessionId: 'sdk', model: 'm',
      toolUses: ['mcp__clementine-local__work_call'],
      artifactRunScopeId: scope,
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('background', {
    message: 'Create a Google Sheet with the top five Ventura restaurants.',
    sessionId,
  });

  assert.equal(calls, 1, 'the SDK cannot mint an exact-ID Sheet verification query');
  assert.equal(
    response.stoppedReason,
    'unverified',
    `exact-id readability cannot upgrade a synthetic Sheet lacking frozen source/content lineage: ${JSON.stringify(response)}`,
  );
  assert.match(response.text, /Created the Ventura restaurant sheet/);
  assert.equal(artifactLedger.listUnverifiedRunArtifacts(sessionId).length, 1);
  assert.equal(artifactLedger.listRunArtifacts(sessionId)[0]?.bindingVerifiedAt, null);
});

test('artifact completion stays honest when exact read-back cannot verify the binding', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-artifact-unverified';
  const documentId = 'doc_unverified_123456';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    const scope = artifactLedger.resolveArtifactRunScopeId(
      sessionId,
      options.artifactRunScopeId ?? options.trackerScopeId as string,
      options.sourceUserSeq,
    );
    if (calls === 1) {
      const intent = artifactLedger.artifactIntentForTool('composio_execute_tool', {
        tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
        arguments: JSON.stringify({ title: 'Unverified brief' }),
      });
      assert.ok(intent);
      artifactLedger.claimArtifactSlot(sessionId, intent!, 'toolu_create_unverified', scope);
      artifactLedger.bindArtifactSlot(sessionId, intent!.slotKey, {
        resourceId: documentId,
        uri: `https://docs.google.com/document/d/${documentId}/edit`,
      }, 'toolu_create_unverified', scope);
      return {
        text: 'Done — document created.', sessionId: 'sdk', model: 'm',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
        artifactRunScopeId: scope,
      };
    }
    // Simulate a provider response for the wrong id. The real SDK observer
    // correctly leaves the ledger unverified in this case.
    artifactLedger.verifyArtifactBindingFromToolResult(
      sessionId,
      scope,
      'composio_execute_tool',
      {
        tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
        arguments: JSON.stringify({ document_id: documentId }),
      },
      { data: { document_id: 'different_document_999' } },
      'toolu_wrong_readback',
      true,
    );
    return {
      text: 'Looks verified.', sessionId: 'sdk', model: 'm',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
      artifactRunScopeId: scope,
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('background', {
    message: 'Create the brief in Google Docs.',
    sessionId,
  });

  assert.equal(calls, 1, 'artifact verification policy cannot mint another SDK query');
  assert.equal(response.stoppedReason, 'unverified');
  assert.equal(response.text, 'Done — document created.', 'the hold keeps the original model-authored account');
  assert.equal(artifactLedger.listRunArtifacts(sessionId).length, 1, 'no duplicate resource slot');
  assert.equal(artifactLedger.listUnverifiedRunArtifacts(sessionId).length, 1);
  const terminal = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.notEqual(terminal?.data.reason, 'awaiting_user_input');
  assert.equal((terminal?.data.artifactVerification as { status?: string } | undefined)?.status, 'pending');
});

test('narration and judge policy cannot mint a corrective SDK run', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const prevBudget = process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS;
  process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS = '1';
  try {
    const prompts: string[] = [];
    setClaudeAgentSdkBrainRunForTest(async (options) => {
      prompts.push(options.prompt);
      // 1st attempt narrates a tool call instead of invoking it (no real toolUses).
      if (prompts.length === 1) {
        return { text: 'Tool call: composio_execute_tool { "to": "x" }', sessionId: 'sdk', model: 'm', toolUses: [] };
      }
      // The narration retry "succeeds" with a promise-shaped reply + a real tool
      // use, so the completion judge WOULD want another continuation.
      return { text: "I'll send the emails next.", sessionId: 'sdk', model: 'm', toolUses: ['mcp__clementine-local__composio_execute_tool'] };
    });
    let judged = 0;
    setClaudeAgentSdkBrainJudgeForTest(async () => { judged += 1; return { done: false, reason: 'no evidence shown' }; });

    await assert.rejects(
      respondViaClaudeAgentSdkBrain('home', { message: 'send the 3 emails', sessionId: 'brain-cont-budget' }),
      /no real tool call was made/i,
    );

    assert.equal(prompts.length, 1, 'neither narration policy nor the judge can re-enter the SDK');
    assert.equal(judged, 0, 'malformed tool text is rejected before completion judgment');
  } finally {
    if (prevBudget === undefined) delete process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS;
    else process.env.CLEMMY_CLAUDE_SDK_MAX_CONTINUATIONS = prevBudget;
  }
});

test('full mode: completion judge receives prior user context and SDK tool evidence', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  createSession({ id: 'brain-judge-evidence', kind: 'chat', title: 'judge evidence' });
  appendEvent({
    sessionId: 'brain-judge-evidence',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build and publish the Q3 microsite' },
  });
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: "I'll finish publishing the Q3 microsite next.",
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: [
      'mcp__clementine-local__run_shell_command',
      'mcp__clementine-local__composio_execute_tool',
      'mcp__clementine-local__composio_execute_tool',
    ],
  }));
  let judgedObjective = '';
  let toolSummary = '';
  setClaudeAgentSdkBrainJudgeForTest(async (objective, _response, skillContext) => {
    judgedObjective = objective;
    toolSummary = skillContext?.toolCallSummary ?? '';
    return { done: true, reason: 'published URL present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'ship it',
    sessionId: 'brain-judge-evidence',
  });

  assert.match(res.text, /finish publishing the Q3 microsite/);
  assert.match(judgedObjective, /Build and publish the Q3 microsite/);
  assert.match(judgedObjective, /Current user message .*ship it/);
  assert.match(toolSummary, /run_shell_command/);
  assert.match(toolSummary, /composio_execute_tool x2/);
});

test('default Claude brain withholds procedural learning from a failed-open completion', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: "I'll finish the researched comparison next.",
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: [
      'mcp__clementine-local__composio_search_tools',
      'mcp__clementine-local__composio_execute_tool',
    ],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => ({
    done: true,
    reason: 'judge transport failed open',
    failedOpen: true,
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Research and compare these providers.',
    sessionId: 'brain-learning-failed-open',
  });

  const learning = listEvents('brain-learning-failed-open', {
    types: ['learning_candidate_evaluated'],
  }).at(-1);
  assert.ok(learning);
  assert.equal(learning!.data.eligible, false);
  assert.match(JSON.stringify(learning!.data.reasons), /failed open/);
});

test('default Claude brain issues a learning receipt after clean independent verification', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: "I'll finish the researched comparison next.",
    sessionId: 'sdk',
    model: 'claude-opus-4-8',
    toolUses: [
      'mcp__clementine-local__composio_search_tools',
      'mcp__clementine-local__composio_execute_tool',
    ],
  }));
  setClaudeAgentSdkBrainJudgeForTest(async () => ({
    done: true,
    reason: 'the comparison is supported by captured sources',
  }));

  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Research and compare these providers.',
    sessionId: 'brain-learning-verified',
  });

  const learning = listEvents('brain-learning-verified', {
    types: ['learning_candidate_evaluated'],
  }).at(-1);
  assert.ok(learning);
  assert.equal(learning!.data.eligible, true);
  assert.equal(
    (learning!.data.receipt as { authority?: string } | undefined)?.authority,
    'independent_completion_judge',
  );
});

test('judge rejection publishes no speculative stream and cannot reopen the SDK', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    for (const target of ['one@example.com', 'two@example.com', 'three@example.com']) {
      appendEvent({
        sessionId: 'brain-stream-judge',
        turn: 0,
        role: 'tool',
        type: 'external_write',
        data: {
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          toolName: 'composio_execute_tool',
          targets: [target],
        },
      });
    }
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(runs, 1);
  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, "I'll send the emails next.");
  assert.deepEqual(chunks, [], 'speculative and terminal text bypass the raw callback');
});

test('judge rejection suppresses speculative provider bytes without an SDK retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const chunks: string[] = [];
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runs += 1;
    if (runs === 1) {
      await options.onDelta?.("I'll send the emails next.");
      return {
        text: "I'll send the emails next.",
        sessionId: 'sdk', model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
      };
    }
    for (const target of ['one@example.com', 'two@example.com', 'three@example.com']) {
      appendEvent({
        sessionId: 'brain-stream-judge-suppress-retry',
        turn: 0,
        role: 'tool',
        type: 'external_write',
        data: {
          shapeKey: 'OUTLOOK_SEND_EMAIL',
          toolName: 'composio_execute_tool',
          targets: [target],
        },
      });
    }
    await options.onDelta?.('STREAMED RETRY SHOULD NOT RENDER');
    return {
      text: 'Sent all 3 emails — here are the message links.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__composio_execute_tool'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no message links shown' } : { done: true, reason: 'links present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the 3 emails',
    sessionId: 'brain-stream-judge-suppress-retry',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(runs, 1);
  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, "I'll send the emails next.");
  assert.deepEqual(chunks, [], 'only the durable public terminal is delivered');
});

test('local_authoring mode: concrete tool-backed completion skips the redundant judge', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // default Claude brain mode = local_authoring
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return {
      text: 'Created workflow wf_daily_digest and scheduled it for 8am.',
      sessionId: 'sdk', model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return { done: false, reason: 'should not run for tool-backed completion' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create and schedule a daily digest workflow', sessionId: 'brain-author-judge' });

  assert.equal(prompts.length, 1);
  assert.equal(judged, 0);
  assert.match(res.text, /wf_daily_digest/);
});

test('local_authoring mode: zero-tool completion claims are judged and held without SDK re-entry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    prompts.push(options.prompt);
    return prompts.length === 1
      ? { text: 'Created workflow daily_digest.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] }
      : {
        text: 'Created workflow wf_daily_digest with workflow_create.',
        sessionId: 'sdk',
        model: 'claude-opus-4-8',
        toolUses: ['mcp__clementine-local__workflow_create'],
      };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judged += 1;
    return judged === 1 ? { done: false, reason: 'no workflow_create evidence' } : { done: true, reason: 'workflow tool evidence present' };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-zero-tool-claim' });

  assert.equal(prompts.length, 1);
  assert.equal(judged, 1);
  assert.equal(res.stoppedReason, 'unverified');
  assert.equal(res.text, 'Created workflow daily_digest.');
});

test('full mode: completion-judge kill-switch off ⇒ no judge call, no continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: "I'll do it next", sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });
  let judged = 0;
  setClaudeAgentSdkBrainJudgeForTest(async () => { judged += 1; return { done: false, reason: 'x' }; });

  await respondViaClaudeAgentSdkBrain('home', { message: 'do the thing', sessionId: 'brain-nojudge' });

  assert.equal(runs, 1, 'no continuation when the judge is off');
  assert.equal(judged, 0, 'judge not called when off');
});

test('turn-budget stop surfaces as max-turns-with-grace and writes user_input + lifecycle events', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only'; // read_only ⇒ judge skipped
  setClaudeAgentSdkBrainRunForTest(async () => ({ text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true }));

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'a long multi-step task', sessionId: 'brain-limit' });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Progress is checkpointed/);
  assert.doesNotMatch(res.text, /say\s+["']?continue/i);
  assert.equal(res.raw?.limitHit, true);
  const events = listEvents('brain-limit');
  const types = events.map((e) => (e as { type?: string }).type);
  assert.ok(types.includes('user_input_received'), 'user_input_received written for the SDK brain');
  assert.ok(types.includes('conversation_completed'), 'conversation_completed emitted');
  assert.ok(types.includes('conversation_limit_exceeded'), 'limit event emitted for paused/stopped classification');
  assert.ok(
    types.indexOf('conversation_limit_exceeded') < types.indexOf('conversation_completed'),
    'limit telemetry lands before the user-facing checkpoint terminal',
  );
  const completed = events.find((e) => (e as { type?: string }).type === 'conversation_completed') as { data?: Record<string, unknown> } | undefined;
  assert.equal(completed?.data?.reason, 'sdk_step_budget_parked');
  assert.equal((completed?.data?.presentation as { status?: string } | undefined)?.status, 'blocked');
  assert.match(String(completed?.data?.reply ?? ''), /Progress is checkpointed/);
});

test('a limit-hit with tool progress checkpoints without SDK auto-continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    // Turn 1: made tool progress (2 firms) but hit the per-query turn budget.
    if (calls === 1) return { text: 'Did firms 1-2. Continuing with the remaining 3.', sessionId: 's', model: 'claude-sonnet-5', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    // Continuation: finishes the rest.
    return { text: 'Done — deep SEO for all 5 firms.', sessionId: 's', model: 'claude-sonnet-5', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'get deep SEO for 5 firms', sessionId: 'brain-autocont' });

  assert.equal(calls, 1, 'the SDK cannot mint a second model step');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Did firms 1-2/);
  assert.match(res.text, /Progress is checkpointed/);
  assert.equal(listEvents('brain-autocont', { types: ['sdk_auto_continue'] }).length, 0);
});

test('a limit-hit with no progress checkpoints without SDK re-entry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; return { text: 'stuck', sessionId: 's', toolUses: [], limitHit: true }; });
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'x', sessionId: 'brain-autocont-noprog' });
  assert.equal(calls, 1);
  assert.match(res.text, /Progress is checkpointed/);
});

test('Stage 4 G1: the FOREGROUND brain inherits the preset run-token ceiling — exhaustion stops auto-continue', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.HARNESS_MAX_RUN_TOKENS = '1000';
  try {
    createSession({ id: 'brain-budget-fg', kind: 'chat', title: 'b' });
    accrueSessionTokens('brain-budget-fg', 50_000); // prior session history: behind the self-baseline
    let calls = 0;
    setClaudeAgentSdkBrainRunForTest(async () => {
      calls += 1;
      accrueSessionTokens('brain-budget-fg', 2_000); // this turn burns past the 1k preset ceiling
      return { text: 'partial', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    });
    const res = await respondViaClaudeAgentSdkBrain('home', { message: 'big fan-out', sessionId: 'brain-budget-fg' });
    // Before 2026-07-20 the foreground DEFAULT brain never resolved a ceiling
    // (request.maxRunTokens ?? 0 = unmetered) — only the background drain was
    // bounded. Now the preset governs and the chain parks honestly.
    assert.equal(calls, 1, 'window exhausted → NO auto-continue');
    assert.equal(res.stoppedReason, 'token-budget');
    assert.ok(
      listEvents('brain-budget-fg').some((e) => (e as { type?: string }).type === 'run_token_window'),
      'durable window recorded so run_worker (MCP child) can enforce the fan-out slice',
    );
  } finally {
    delete process.env.HARNESS_MAX_RUN_TOKENS;
  }
});

test('Stage 4 G1: session history does not grant the SDK another model step', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.HARNESS_MAX_RUN_TOKENS = '1000';
  try {
    createSession({ id: 'brain-budget-hist', kind: 'chat', title: 'b' });
    accrueSessionTokens('brain-budget-hist', 50_000); // a long-lived session, way past any ceiling
    let calls = 0;
    setClaudeAgentSdkBrainRunForTest(async () => {
      calls += 1;
      accrueSessionTokens('brain-budget-hist', 100); // modest spend this turn — well under the ceiling
      if (calls === 1) return { text: 'partial', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
      return { text: 'done', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
    });
    const res = await respondViaClaudeAgentSdkBrain('home', { message: 'small task', sessionId: 'brain-budget-hist' });
    assert.equal(calls, 1, 'history cannot widen the one-window transport contract');
    assert.equal(res.stoppedReason, 'max-turns-with-grace');
    assert.match(res.text, /Progress is checkpointed/);
  } finally {
    delete process.env.HARNESS_MAX_RUN_TOKENS;
  }
});

test('a loaded skill cannot cause an SDK auto-continuation after the turn cap', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  createSession({ id: 'brain-skill-cont', kind: 'chat', title: 's' });
  // Simulate one exact successful skill_read earlier in the run. Authority
  // consumers intentionally reject a stored body next to an incomplete durable
  // lifecycle, so the fixture must mirror the production call/return pair.
  const skillCalled = appendEvent({
    sessionId: 'brain-skill-cont',
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'skill_read', callId: 'sk1', effect: 'read', args: { name: 'client-seo-report' } },
  });
  writeToolOutput({
    sessionId: 'brain-skill-cont',
    callId: 'sk1',
    invocationNonce: 'brain-skill-cont:sk1',
    tool: 'skill_read',
    output: 'Skill: client-seo-report\nmanifest…\n---\nSTEP 1: pull ranked keywords. STEP 2: compute the SEO_MAGIC_SCORE_XYZ. STEP 3: render the branded HTML.',
  });
  appendEvent({
    sessionId: 'brain-skill-cont',
    turn: 0,
    role: 'Clem',
    type: 'tool_returned',
    parentEventId: skillCalled.id,
    data: { tool: 'skill_read', callId: 'sk1', effect: 'read', ok: true },
  });

  const prompts: string[] = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    prompts.push(options.prompt ?? '');
    if (calls === 1) return { text: 'Did step 1 (keywords), hit the budget.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: true };
    return { text: 'Finished — rendered the branded report.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });

  await respondViaClaudeAgentSdkBrain('home', { message: 'run the seo report skill for the firm', sessionId: 'brain-skill-cont' });

  assert.equal(calls, 1, 'loaded skill state cannot mint another SDK query');
  assert.equal(prompts.length, 1);
  assert.equal(listEvents('brain-skill-cont', { types: ['sdk_auto_continue'] }).length, 0);
});

test('the retired SDK auto-continue setting cannot reopen a limit-hit turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE = 'off';
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => { calls += 1; return { text: 'partial', sessionId: 's', toolUses: ['x'], limitHit: true }; });
  try {
    const res = await respondViaClaudeAgentSdkBrain('home', { message: 'long task', sessionId: 'brain-autocont-off' });
    assert.equal(calls, 1, 'no auto-continue when the kill-switch is off');
    assert.match(res.text, /Progress is checkpointed/);
  } finally {
    delete process.env.CLEMMY_CLAUDE_SDK_AUTO_CONTINUE;
  }
});

test('max-turn stop publishes the complete committed checkpoint', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  const chunks: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    await options.onDelta?.('partial work so far');
    return { text: 'partial work so far', sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'a long multi-step task',
    sessionId: 'brain-stream-limit',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.deepEqual(chunks, []);
  assert.match(res.text, /partial work so far\n\nI paused at this step's budget/);
  assert.match(res.text, /Progress is checkpointed/);
  assert.doesNotMatch(res.text, /say\s+["']?continue/i);
});

test('looksLikeToolNarration flags described-but-not-called tool protocol, ignores real tool calls', () => {
  // The exact tool-narration regression shape: narrated, zero tool calls.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', []), true);
  assert.equal(looksLikeToolNarration('{"command": "sf data query --json"}', []), true);
  // The 2026-06-22 Workspace-build failure (space-new-workspace-2): the native
  // tool-call XML emitted AS TEXT — nothing ran, so the workspace was never built.
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">\n<parameter name="command">sf data query</parameter>\n</invoke>', []), true);
  assert.equal(looksLikeToolNarration('<invoke name="space_save">', []), true);
  assert.equal(looksLikeToolNarration('Fields 40-89:\n<invoke name="run_shell_command"><parameter name="command">ls</parameter></invoke>', []), true);
  // The 2026-06-23 dock failure: a markdown "**Tool call: NAME**" header + a
  // ```json args block, on the Claude brain in FULL mode (42 tools exposed).
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**\n```json\n{\n  "name": "salesforce-deal-risk-workspace"\n}\n```', []), true);
  assert.equal(looksLikeToolNarration('Tool call: skill_read\n{"name":"x"}', []), true);
  assert.equal(looksLikeToolNarration('<tool_call>\n{"name":"skill_read"}', []), true);
  assert.equal(looksLikeToolNarration('[tool_call] skill_read', []), true);
  assert.equal(looksLikeToolNarration('{"tool_slug": "SALESFORCE_RUN_SOQL_QUERY", "arguments": {}}', []), true);
  // The 2026-06-30 live failure (v0.12.46 desktop): the brain wrapped its tool calls
  // in a hallucinated <system>…</system> pseudo-tag, so a Workspace build + Composio
  // search + offer_background all narrated and NOTHING ran. The `<system>` prefix
  // defeated the old line-anchored header. Both exact live strings must now trip.
  assert.equal(looksLikeToolNarration('<system>Tool call: composio_search_tools — {"query": "apify run actor facebook ad library scraper dataset items"}</system>', []), true);
  assert.equal(looksLikeToolNarration('I\'ll set that up.\n\n<system>Tool call: offer_background — {"summary": "Build the Meta-ads workspace", "options": ["background", "hold", "now"]}</system>', []), true);
  assert.equal(looksLikeToolNarration('<assistant>Tool call: space_save — {"slug":"x"}</assistant>', []), true);
  // The 2026-07-01 live failure (Acme calendar, Sonnet-5 brain): the brain PRINTED
  // OpenAI-style function-calling JSON and a "[Tool: NAME]" reference instead of firing the
  // tool — nothing ran. Both exact live shapes must trip.
  assert.equal(looksLikeToolNarration("I'll pull today's events now.\n\n{\"tool_call\":{\"name\":\"composio_search_tools\",\"arguments\":{\"query\":\"outlook calendar\"}}}", []), true);
  assert.equal(looksLikeToolNarration('[Tool: OUTLOOK_OUTLOOK_GET_CALENDAR_VIEW]', []), true);
  assert.equal(looksLikeToolNarration('{"name":"composio_execute_tool","arguments":{"tool_slug":"X"}}', []), true);
  assert.equal(looksLikeToolNarration('{"function":{"name":"run_shell_command","arguments":{}}}', []), true);
  // …but these SHAPES must not false-flag normal prose that merely mentions the words:
  assert.equal(looksLikeToolNarration('The [tool] I recommend is the calendar view — want me to pull it?', []), false);
  assert.equal(looksLikeToolNarration('Your event is named "Weekly Sync" and the arguments we set look right.', []), false);
  // Real tool calls happened ⇒ not narration, even if text mentions tools / XML.
  assert.equal(looksLikeToolNarration('Tool:run_shell_command', ['mcp__clementine-local__run_shell_command']), false);
  assert.equal(looksLikeToolNarration('<invoke name="run_shell_command">', ['run_shell_command']), false);
  assert.equal(looksLikeToolNarration('**Tool call: skill_read**', ['skill_read']), false);
  // Normal prose ⇒ not narration (a mid-sentence "tool call" must NOT false-flag).
  assert.equal(looksLikeToolNarration('Pulled your 5 accounts — here they are.', []), false);
  assert.equal(looksLikeToolNarration('I will invoke the report generator and send it over.', []), false);
  assert.equal(looksLikeToolNarration('Here is what each tool call does in the pipeline, summarized.', []), false);
  assert.equal(looksLikeToolNarration('The tool call budget looks fine for this run.', []), false);
  assert.equal(looksLikeToolNarration('', []), false);
});

test('mixed turn with a printed later tool call reports honestly instead of laundering prose into success', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const live = [
    "I'll close out the execution record with the full evidence, then relay the result.",
    '',
    '<invoke name="execution_complete">',
    '<parameter name="id">f49025b3-17ec-4ea7-9841</parameter>',
    '<parameter name="summary">Creation test PASSED and the workflow is now ENABLED.</parameter>',
    '</invoke>',
    '[tool result call_placeholder]',
    '',
    'I acknowledge the completion attempt.',
  ].join('\n');
  const chunks: string[] = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    await options.onDelta?.(live);
    return {
      text: live,
      sessionId: 'sdk-session',
      toolUses: ['mcp__clementine-local__workflow_create'],
      successfulToolUses: ['workflow_create'],
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Create, validate, and enable the workflow.',
    sessionId: 'brain-mixed-protocol',
    onChunk: async (delta) => { chunks.push(delta); },
  });

  assert.equal(calls, 1, 'never replay a mixed turn that may have committed writes');
  assert.equal(res.stoppedReason, 'unverified');
  assert.match(res.text, /did not produce a usable final reply/i, 'unsafe protocol uses only the failed-model public fallback');
  assert.doesNotMatch(res.text, /Creation test PASSED|workflow is now ENABLED|invoke|call_placeholder/i);
  assert.deepEqual(chunks, [], 'raw model output never reaches the callback');
  assert.doesNotMatch(chunks.join(''), /invoke|parameter|call_placeholder/i, 'protocol never reaches the live stream');
  const terminal = listEvents('brain-mixed-protocol', { types: ['conversation_completed'] }).at(-1);
  assert.notEqual(terminal?.data.reason, 'awaiting_user_input');
  assert.notEqual(terminal?.data.awaitingUser, true);
});

test('renderClaudeAgentBrainSystemAppend injects the workspace primer for a "space-" session', async () => {
  const { spaceStore } = await import('../../spaces/store.js');
  spaceStore.save({ id: 'deal-risk', title: 'Deal Risk', actions: [], dataSources: [] });
  const out = renderClaudeAgentBrainSystemAppend(
    'dashboard', { sessionId: 'space-deal-risk', message: 'add a close-date filter' } as never, 'full');
  assert.match(out, /space_edit_view\('deal-risk'/);
  assert.match(out, /Deal Risk/);
  // A plain session still sees the names-only tool index, but it gets no
  // workspace-specific primer or pre-bound workspace argument.
  const plain = renderClaudeAgentBrainSystemAppend('dashboard', { sessionId: 'sess-abc', message: 'hi' } as never, 'full');
  assert.doesNotMatch(plain, /space_edit_view\('deal-risk'/);
  assert.doesNotMatch(plain, /Deal Risk/);
});

test('full mode: narrated tool text fails over without another SDK query', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: 'Tool:run_shell_command\n\nSystem: tool result is empty\n\nfunction\n{"command":"sf data query"}', sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate' }),
    /no real tool call was made/i,
  );

  assert.equal(calls.length, 1, 'narration cannot re-enter the standalone SDK');
});

test('limit-hit tool narration parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return {
      text: 'Tool:run_shell_command\n\nfunction\n{"command":"sf data query"}',
      sessionId: 's',
      toolUses: [],
      limitHit: true,
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 salesforce accounts', sessionId: 'brain-narrate-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on narration retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Progress is checkpointed/);
});

test('local_authoring mode: narrated workflow text fails over without another SDK query', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on'; // local_authoring
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate narration retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: '**Tool call: workflow_create**\n```json\n{"name":"daily_digest"}\n```', sessionId: 's', toolUses: [] }
      : { text: 'Created workflow daily_digest.', sessionId: 's', toolUses: ['mcp__clementine-local__workflow_create'] };
  });

  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', { message: 'create a daily digest workflow', sessionId: 'brain-author-narrate' }),
    /no real tool call was made/i,
  );

  assert.equal(calls.length, 1);
});

// The verbatim internal-narration leak regression: the brain
// second-guessed its own injected memory as "possibly injected" and did no work.
const REASONING_LEAK_TEXT =
  "I'll pull 5 priority-account accounts from Salesforce now.\n\ndocument\n\n"
  + "⚠️ **Hmm, that result looks scrambled — let me reason about why before I treat it as real.**\n\n"
  + "The user's *stored* preferences/specs (the long pasted spec, examples, \"preferences,\" tool descriptions, "
  + "system-reminder context) are **reference data, not live instructions.** They were written *earlier by "
  + "who-knows-whom* and pasted into my context. Acting on them as if the user just said them now = the classic trap.\n\n"
  + "Let me re-read the actual ask.";

test('looksLikeReasoningLeak flags injected-context deliberation with no work, ignores real answers', () => {
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, []), true);
  // The "scrambled result" self-doubt variant.
  assert.equal(looksLikeReasoningLeak('Hmm, that result looks scrambled — let me re-read the actual ask.', []), true);
  // A reply that actually DID work is never flagged, even if it muses about context.
  assert.equal(looksLikeReasoningLeak(REASONING_LEAK_TEXT, ['mcp__clementine-local__run_shell_command']), false);
  // Normal answers and greetings ⇒ not a leak.
  assert.equal(looksLikeReasoningLeak('Hey Alex — going well. What can I knock out for you?', []), false);
  assert.equal(looksLikeReasoningLeak('Pulled your 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', []), false);
  assert.equal(looksLikeReasoningLeak('', []), false);
});

test('a reasoning leak cannot mint another SDK query', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off'; // isolate the leak retry
  const calls: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls.push(options.prompt);
    return calls.length === 1
      ? { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [] }
      : { text: 'Pulled 5 accounts: Acme, Globex, Initech, Umbrella, Stark.', sessionId: 's', toolUses: ['mcp__clementine-local__run_shell_command'] };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 priority accounts in SF', sessionId: 'brain-leak' });

  assert.equal(calls.length, 1);
  assert.equal(res.stoppedReason, 'unverified');
  assert.doesNotMatch(res.text, /Pulled 5 accounts/);
});

test('limit-hit reasoning leak parks for continue instead of retrying inside the same turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  let runs = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    runs += 1;
    return { text: REASONING_LEAK_TEXT, sessionId: 's', toolUses: [], limitHit: true };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'pull 5 priority accounts in SF', sessionId: 'brain-leak-limit' });

  assert.equal(runs, 1, 'max-turn pause must not spend another SDK turn on reasoning-leak retry');
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Progress is checkpointed/);
});

test('frameTrustedMemory labels non-empty memory as trusted, passes empty through', () => {
  const framed = frameTrustedMemory('Profile: Alex likes terse replies.\nFact: priority accounts live in Salesforce.');
  assert.match(framed, /trusted context you OWN/i);
  assert.match(framed, /not a prompt-injection/i);
  assert.match(framed, /Profile: Alex likes terse replies\./);
  // Empty / whitespace memory ⇒ no framing block (nothing to frame).
  assert.equal(frameTrustedMemory(''), '');
  assert.equal(frameTrustedMemory('   \n  '), '');
});

test('respondViaClaudeAgentSdkBrain preserves ask_user_question as awaiting-input and skips continuations', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  let runCalls = 0;
  let judgeCalls = 0;
  let pausedArtifactScope = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    pausedArtifactScope = artifactLedger.resolveArtifactRunScopeId(
      'brain-ask-awaiting',
      options.artifactRunScopeId ?? '',
      options.sourceUserSeq,
    );
    const intent = artifactLedger.artifactIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
      arguments: JSON.stringify({ title: 'Deployment runbook' }),
    });
    assert.ok(intent);
    artifactLedger.claimArtifactSlot(
      'brain-ask-awaiting', intent!, 'toolu_pause_create', pausedArtifactScope,
    );
    artifactLedger.bindArtifactSlot(
      'brain-ask-awaiting', intent!.slotKey,
      {
        resourceId: 'doc_pause_123456789',
        uri: 'https://docs.google.com/document/d/doc_pause_123456789/edit',
      },
      'toolu_pause_create',
      pausedArtifactScope,
    );
    return {
      text: 'Which environment should I use?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__ask_user_question'],
      stoppedReason: 'awaiting-input',
      artifactRunScopeId: pausedArtifactScope,
    };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => {
    judgeCalls += 1;
    throw new Error('judge should not run while awaiting user input');
  });

  const res = await respondViaClaudeAgentSdkBrain('background', {
    message: 'deploy it',
    sessionId: 'brain-ask-awaiting',
  });

  assert.equal(runCalls, 1, 'must not run a corrective continuation after a real ask');
  assert.equal(judgeCalls, 0, 'completion judge must not convert a pause into more work');
  assert.equal(res.stoppedReason, 'awaiting-input');
  assert.match(res.text, /Which environment/);
  const awaiting = listEvents('brain-ask-awaiting', { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1, 'the production brain path durably records the pause');
  assert.equal(awaiting[0].data.question, 'Which environment should I use?');
  const completions = listEvents('brain-ask-awaiting', { types: ['conversation_completed'] });
  assert.equal(completions.at(-1)?.data.reason, 'awaiting_user_input');
  assert.equal(completions.at(-1)?.data.awaitingUser, true);
  assert.equal(completions.at(-1)?.data.artifactRunScopeId, pausedArtifactScope);
  assert.equal(
    (completions.at(-1)?.data.artifactVerification as { status?: string } | undefined)?.status,
    'pending',
    'a pause persists the resource that was created before asking the question',
  );

  let nextTurnContext = '';
  let resumedArtifactScope = '';
  let resumedAttemptScope = '';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    runCalls += 1;
    nextTurnContext = options.turnContext ?? '';
    resumedArtifactScope = artifactLedger.resolveArtifactRunScopeId(
      'brain-ask-awaiting',
      options.artifactRunScopeId ?? '',
      options.sourceUserSeq,
    );
    resumedAttemptScope = options.trackerScopeId ?? '';
    artifactLedger.verifyArtifactBindingFromToolResult(
      'brain-ask-awaiting',
      resumedArtifactScope,
      'composio_execute_tool',
      {
        tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
        arguments: JSON.stringify({ document_id: 'doc_pause_123456789' }),
      },
      { data: { document_id: 'doc_pause_123456789' } },
      'toolu_pause_verify',
      true,
    );
    return {
      text: 'Configured the production deployment.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: [],
      artifactRunScopeId: resumedArtifactScope,
    };
  });
  await respondViaClaudeAgentSdkBrain('background', {
    message: 'Use production.',
    sessionId: 'brain-ask-awaiting',
  });
  assert.equal(runCalls, 2);
  assert.equal(judgeCalls, 0, 'the convergence assertion is independent of completion judging');
  assert.equal(
    resumedArtifactScope,
    pausedArtifactScope,
    'the immediate answer inherits the typed pause root instead of creating a new artifact run',
  );
  assert.equal(
    artifactLedger.getArtifactRunScope('brain-ask-awaiting', resumedAttemptScope)?.reason,
    'awaiting_user_input_reply',
  );
  assert.match(nextTurnContext, /CONVERGE/);
  assert.match(nextTurnContext, /never re-ask the resolved point/);
  assert.match(nextTurnContext, /not automatic permission for external writes or durable execution/);
  assert.doesNotMatch(nextTurnContext, /EXECUTE the work this turn/);
});

test('respondViaClaudeAgentSdkBrain persists a material plain-text clarification as awaiting-input', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: 'Before I draft this, who should the rollout brief target — which audience?',
    sessionId: 'sdk-session',
    model: 'claude-sonnet-5',
    toolUses: [],
  }));

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Prepare a rollout brief; the audience is unresolved.',
    sessionId: 'brain-plain-material-ask',
  });

  assert.equal(res.stoppedReason, 'awaiting-input');
  const awaiting = listEvents('brain-plain-material-ask', { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(
    awaiting[0].data.question,
    'Before I draft this, who should the rollout brief target — which audience?',
    'the exact live Claude wording gets a canonical awaiting-input event',
  );
  const completed = listEvents('brain-plain-material-ask', { types: ['conversation_completed'] }).at(-1);
  assert.equal(completed?.data.reason, 'awaiting_user_input');
  assert.equal(completed?.data.awaitingUser, true);
});

test('Claude brain materializes one exact queued-action card without another model turn', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-queued-approval-edge';
  let calls = 0;
  let pendingActionId = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    assert.ok(options.sourceUserSeq);
    const record = pendingActions.queuePendingAction({
      title: 'Send the reviewed proof',
      summary: 'Send one exact request-owned email after human approval.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'proof@example.com', subject: 'Proof', body: 'Exact payload.' },
      },
      targetSummary: 'proof@example.com',
      sessionId,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: record.kind,
        approvalRequired: true,
        approvalIntent: 'request_now',
        autoMaterialize: true,
        sourceUserSeq: options.sourceUserSeq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      text: 'Queued (id shown in the card). Should I go ahead and execute it?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__pending_action_queue'],
      successfulToolUses: ['pending_action_queue'],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Queue this exact email and ask whether I want it sent.',
    sessionId,
  });

  assert.equal(calls, 1, 'the graph transition spends no corrective model call');
  assert.equal(response.stoppedReason, 'pending-approval');
  assert.ok(response.pendingApprovalId);
  const rows = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].approvalId, response.pendingApprovalId);
  assert.equal(rows[0].tool, 'request_approval');
  assert.equal(rows[0].args?.pendingActionId, pendingActionId);
  assert.equal(pendingActions.getPendingAction(pendingActionId)?.status, 'approval_requested');
  assert.equal(listEvents(sessionId, { types: ['approval_requested'] }).length, 1);
  assert.equal(listEvents(sessionId, { types: ['approval_parked'] }).length, 1);
  assert.equal(listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0);
  assert.equal(
    listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.reason,
    'awaiting_approval',
  );
});

test('Claude brain projects one autonomous queued send as its ordinary exact-action question', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-conversational-queued-send';
  const channelId = 'discord-channel-conversational-send';
  const userId = 'discord-user-conversational-send';
  const conversationKey = `discord:${channelId}`;
  const originReplyTarget = {
    type: 'discord_channel' as const,
    channelId,
  };
  createSession({
    id: sessionId,
    kind: 'chat',
    channel: 'discord',
    userId,
    title: 'Prepare and send the sheet',
    metadata: { source: 'discord', channelId, userId },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Create the sheet, then email it to proof@example.com.',
      source: 'channel:discord',
      userId,
      conversationKey,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    },
  });

  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.equal(options.sourceUserSeq, source.seq);
    const record = pendingActions.queuePendingAction({
      title: 'Send the reviewed sheet',
      summary: 'Send one exact request-owned email after human consent.',
      kind: 'external_send',
      toolName: 'outlook__OUTLOOK_SEND_EMAIL',
      payload: {
        to: 'proof@example.com',
        subject: 'Reviewed sheet',
        body: 'The sheet is ready: https://docs.google.com/spreadsheets/d/proof/edit',
      },
      targetSummary: 'proof@example.com',
      sessionId,
      sourceUserSeq: source.seq,
    });
    appendEvent({
      sessionId,
      turn: 1,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        actionKind: record.kind,
        approvalRequired: true,
        approvalIntent: 'request_now',
        autoMaterialize: true,
        sourceUserSeq: source.seq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      text: 'The sheet is ready. Should I send the email?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__pending_action_queue'],
      successfulToolUses: ['pending_action_queue'],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Create the sheet, then email it to proof@example.com.',
    sessionId,
    sourceUserSeq: source.seq,
    channel: 'discord',
    userId,
  });

  const [row] = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.ok(row?.presentation, 'the graph row freezes the conversational surface');
  assert.equal(approvalRegistry.isFormalApprovalSurface(row), false);
  assert.equal(response.text, row.presentation.question);
  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.equal(response.pendingApprovalId, undefined);
  const completed = listEvents(sessionId, { types: ['conversation_completed'] }).at(-1);
  assert.equal(completed?.data.reason, 'awaiting_user_input');
  assert.equal(completed?.data.awaitingUser, true);
  const presentation = completed?.data.presentation as Record<string, unknown> | undefined;
  assert.equal(presentation?.status, 'needs_input');
  assert.equal(presentation?.kind, 'question');
  assert.equal(presentation?.text, row.presentation.question);
  assert.equal(presentation?.approvalId, undefined);
  assert.equal(
    listEvents(sessionId, { types: ['awaiting_user_input'] }).length,
    0,
    'the hidden consent prompt remains the sole exact reply-binding event',
  );
});

test('Claude brain materializes one card per distinct request-owned payload and collapses an exact retry', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-multi-queued-approval-edge';
  let calls = 0;
  let calendarId = '';
  let calendarRetryId = '';
  let airtableId = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    assert.ok(options.sourceUserSeq);
    const calendarInput = {
      title: 'Create launch review calendar event',
      summary: 'Create the exact reviewed launch event.',
      kind: 'external_write' as const,
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GOOGLECALENDAR_CREATE_EVENT',
        arguments: { title: 'Launch review', start: '2026-08-01T09:00:00-07:00' },
      },
      sessionId,
    };
    const calendar = pendingActions.queuePendingAction(calendarInput);
    const calendarRetry = pendingActions.queuePendingAction({
      ...calendarInput,
      title: 'Retry create launch review calendar event',
    });
    const airtable = pendingActions.queuePendingAction({
      title: 'Create launch review Airtable record',
      summary: 'Create the exact reviewed launch record.',
      kind: 'external_write',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'AIRTABLE_CREATE_RECORD',
        arguments: { table: 'Content Calendar', title: 'Launch review', status: 'Planned' },
      },
      sessionId,
    });
    calendarId = calendar.id;
    calendarRetryId = calendarRetry.id;
    airtableId = airtable.id;
    for (const record of [calendar, calendarRetry, airtable]) {
      appendEvent({
        sessionId,
        turn: 0,
        role: 'Clem',
        type: 'autonomy_note',
        data: {
          kind: 'pending_action_queued',
          pendingActionId: record.id,
          actionKind: record.kind,
          approvalRequired: true,
          sourceUserSeq: options.sourceUserSeq,
          payloadHash: record.payloadHash,
          autoMaterialize: true,
        },
      });
    }
    return {
      text: 'Calendar and Airtable batch proposals are queued for approval.',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__pending_action_queue'],
      successfulToolUses: ['pending_action_queue'],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Add the launch review to Calendar and Airtable.',
    sessionId,
  });

  assert.equal(calls, 1, 'auto-materialized plural graph transitions spend no corrective model call');
  assert.equal(response.stoppedReason, 'pending-approval');
  const rows = approvalRegistry.listPending({ sessionId, status: 'pending' });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.approvalId === response.pendingApprovalId));
  assert.deepEqual(
    new Set(rows.map((row) => row.args?.pendingActionId)),
    new Set([calendarId, airtableId]),
  );
  assert.equal(pendingActions.getPendingAction(calendarId)?.status, 'approval_requested');
  assert.equal(pendingActions.getPendingAction(calendarRetryId)?.status, 'cancelled');
  assert.equal(pendingActions.getPendingAction(airtableId)?.status, 'approval_requested');
  assert.equal(listEvents(sessionId, { types: ['approval_requested'] }).length, 2);
  assert.equal(listEvents(sessionId, { types: ['approval_parked'] }).length, 2);
  assert.equal(
    listEvents(sessionId, { types: ['heartbeat'] })
      .filter((event) => event.data.kind === 'pending_action_transition_materialized').length,
    2,
  );
  assert.equal(listEvents(sessionId, { types: ['awaiting_user_input'] }).length, 0);
  assert.equal(
    listEvents(sessionId, { types: ['conversation_completed'] }).at(-1)?.data.reason,
    'awaiting_approval',
  );
});

test('Claude brain cannot create a queued approval from a corrective SDK continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-queued-approval-after-continuation';
  let calls = 0;
  let pendingActionId = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    if (calls === 1) {
      return {
        text: 'Tool call: pending_action_queue {"title":"Send proof"}',
        sessionId: 'sdk-session',
        model: 'claude-sonnet-5',
        toolUses: [],
      };
    }
    assert.ok(options.sourceUserSeq);
    const record = pendingActions.queuePendingAction({
      title: 'Send the reviewed continuation proof',
      summary: 'Send one exact request-owned email after human approval.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'proof@example.com', subject: 'Proof', body: 'Exact continuation payload.' },
      },
      sessionId,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        toolName: record.toolName,
        actionKind: record.kind,
        approvalRequired: true,
        sourceUserSeq: options.sourceUserSeq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      text: 'The exact email is queued. Should I send it?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__pending_action_queue'],
      successfulToolUses: ['pending_action_queue'],
    };
  });

  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', {
      message: 'Queue this exact email and ask whether I want it sent.',
      sessionId,
    }),
    /no real tool call was made/i,
  );

  assert.equal(calls, 1);
  assert.equal(pendingActionId, '');
  assert.equal(approvalRegistry.listPending({ sessionId, status: 'pending' }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['approval_requested', 'approval_parked'] }).length, 0);
});

test('Claude brain keeps a premature queued payload inert while asking for missing account scope', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
  const sessionId = 'brain-queued-missing-scope';
  let pendingActionId = '';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    assert.ok(options.sourceUserSeq);
    const record = pendingActions.queuePendingAction({
      title: 'Premature send',
      summary: 'The account is not resolved yet.',
      kind: 'external_send',
      toolName: 'composio_execute_tool',
      payload: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { to: 'guessed@example.com', subject: 'Guess', body: 'Must stay inert.' },
      },
      sessionId,
    });
    pendingActionId = record.id;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        pendingActionId: record.id,
        toolName: record.toolName,
        actionKind: record.kind,
        approvalRequired: true,
        sourceUserSeq: options.sourceUserSeq,
        payloadHash: record.payloadHash,
      },
    });
    return {
      text: 'Which account should I use to send it?',
      sessionId: 'sdk-session',
      model: 'claude-sonnet-5',
      toolUses: ['mcp__clementine-local__pending_action_queue'],
      successfulToolUses: ['pending_action_queue'],
    };
  });

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'Prepare the message, but I have two accounts.',
    sessionId,
  });

  assert.equal(response.stoppedReason, 'awaiting-input');
  assert.equal(pendingActions.getPendingAction(pendingActionId)?.status, 'queued');
  assert.equal(approvalRegistry.listPending({ sessionId, status: 'pending' }).length, 0);
  assert.equal(listEvents(sessionId, { types: ['approval_requested'] }).length, 0);
});

test('respondViaClaudeAgentSdkBrain local_authoring mode exposes curated local authoring tools but not broad execution', async () => {
  let captured: any;
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    captured = options;
    return {
      text: 'Created the workflow draft.',
      sessionId: 'sdk-session',
      model: 'claude-opus-4-8',
      toolUses: ['mcp__clementine-local__workflow_create'],
    };
  });

  const res = await respondViaClaudeAgentSdkBrain('home', {
    message: 'create a design workflow',
    sessionId: 'brain-author',
    excludeToolNames: ['workflow_set_enabled'],
  });

  assert.equal(res.text, 'Created the workflow draft.');
  assert.equal(res.raw?.mode, 'local_authoring');
  assert.equal(getSession('brain-author')?.metadata?.readOnly, false);
  assert.equal(getSession('brain-author')?.metadata?.mode, 'local_authoring');
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_create'));
  assert.ok(captured.allowedLocalMcpTools.includes('workflow_run'));
  assert.ok(captured.allowedLocalMcpTools.includes('set_model_role'));
  assert.ok(captured.allowedLocalMcpTools.includes('memory_remember'));
  assert.equal(captured.allowedLocalMcpTools.includes('workflow_set_enabled'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('run_shell_command'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('write_file'), false);
  assert.equal(captured.allowedLocalMcpTools.includes('composio_execute_tool'), false);
});

test('salvage A: a parse error AFTER work committed returns a SUCCESS confirmation and NEVER re-runs (no double-send)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'salvage-committed', kind: 'chat', title: 'salvage' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    // These sends happened inside the current SDK dispatch, after the brain's
    // salvage watermark. Prior-session writes must never satisfy this branch.
    for (const t of ['a@site.example', 'b@personal.example', 'c@archive.example']) {
      appendEvent({ sessionId: 'salvage-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
    }
    throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed).");
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send those 3 emails', sessionId: 'salvage-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed send (no double-send)');
  assert.equal(res.stoppedReason, 'success');
  assert.match(res.text, /3 emails/);
  assert.match(res.text, /a@site\.example/);
  // HONEST: it must NOT over-claim "Done" — it reports what ran and asks to verify.
  assert.match(res.text, /nothing was duplicated/i);
  assert.match(res.text, /check|verify|missing/i);
  assert.doesNotMatch(res.text, /could not be parsed|went wrong|✅ Done/i);
});

test('salvage reconciles explicit native failures instead of calling them landed', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sid = 'salvage-native-failed';
  createSession({ id: sid, kind: 'chat', title: 'failed write' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    if (calls === 1) {
      appendEvent({
        sessionId: sid, turn: 0, role: 'system', type: 'external_write',
        data: { callId: 'toolu-failed', shapeKey: 'outlook__send_email', toolName: 'mcp__outlook__send_email', targets: ['a@site.example'] },
      });
      appendEvent({
        sessionId: sid, turn: 0, role: 'system', type: 'external_write_failed',
        data: { callId: 'toolu-failed', shapeKey: 'outlook__send_email', toolName: 'mcp__outlook__send_email', targets: ['a@site.example'] },
      });
      throw new Error("The model's tool call could not be parsed (retry also failed).");
    }
    return { text: 'Recovered after the failed dispatch.', sessionId: 'sdk', model: 'claude', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'recovered' }));
  const response = await respondViaClaudeAgentSdkBrain('home', { message: 'send the email', sessionId: sid });
  assert.equal(calls, 2, 'a demonstrably failed dispatch is safe to retry once');
  assert.doesNotMatch(response.text, /already went through|nothing was duplicated/i);
});

test('salvage treats a pre-dispatch reservation as ambiguous until that exact call succeeds', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sid = 'salvage-native-reserved';
  createSession({ id: sid, kind: 'chat', title: 'reserved write' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    appendEvent({
      sessionId: sid,
      turn: 0,
      role: 'system',
      type: 'external_write',
      data: {
        callId: 'toolu-reserved',
        canonicalCallId: 'toolu-reserved',
        preDispatch: true,
        shapeKey: 'outlook__send_email',
        toolName: 'mcp__outlook__send_email',
        targets: ['a@site.example'],
      },
    });
    throw new Error("The model's tool call could not be parsed (retry also failed).");
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'honest uncertainty' }));

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'send the email',
    sessionId: sid,
  });

  assert.equal(calls, 1, 'an unsettled reservation is never replayed blindly');
  assert.match(response.text, /may have gone through|could not confirm/i);
  assert.match(response.text, /did not replay|verify/i);
  assert.doesNotMatch(response.text, /already went through|nothing was duplicated/i);
});

test('salvage reports an orphan as uncertain and never blindly replays it', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const sid = 'salvage-native-orphan';
  createSession({ id: sid, kind: 'chat', title: 'orphaned write' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    appendEvent({
      sessionId: sid, turn: 0, role: 'system', type: 'external_write',
      data: { callId: 'toolu-orphan', shapeKey: 'outlook__send_email', toolName: 'mcp__outlook__send_email', targets: ['a@site.example'] },
    });
    appendEvent({
      sessionId: sid, turn: 0, role: 'system', type: 'external_write_orphaned',
      data: { callId: 'toolu-orphan', shapeKey: 'outlook__send_email', toolName: 'mcp__outlook__send_email', targets: ['a@site.example'] },
    });
    throw new Error("The model's tool call could not be parsed (retry also failed).");
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'honest uncertainty' }));
  const response = await respondViaClaudeAgentSdkBrain('home', { message: 'send the email', sessionId: sid });
  assert.equal(calls, 1, 'an ambiguous provider boundary is never replayed');
  assert.match(response.text, /may have gone through/i);
  assert.match(response.text, /did not replay/i);
});

test('salvage A2: a COMMITTED provider overload returns an honest partial (never re-runs, no double-send)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'overload-committed', kind: 'chat', title: 'overload salvage' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    // 2 emails landed during this dispatch before the provider 529'd.
    for (const t of ['a@site.example', 'b@personal.example']) {
      appendEvent({ sessionId: 'overload-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
    }
    throw new ClaudeSdkProviderOverloadError('API Error: 529 overloaded_error', true);
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send those 2 emails', sessionId: 'overload-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed overload (no double-send)');
  assert.match(res.text, /2 emails/);
  assert.match(res.text, /nothing was duplicated/i);
  // The user gets an honest recoverable message, NOT a bare "overloaded" error.
  assert.doesNotMatch(res.text, /overloaded_error|529|went wrong/i);
});

test('salvage A2b: an UNCOMMITTED overload still propagates (so the transplant to another brain runs)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overload-uncommitted', kind: 'chat', title: 'overload uncommitted' });
  // No external_write events → nothing to salvage.
  setClaudeAgentSdkBrainRunForTest(async () => { throw new ClaudeSdkProviderOverloadError('API Error: 529 overloaded_error', true); });
  await assert.rejects(
    respondViaClaudeAgentSdkBrain('home', { message: 'do a thing', sessionId: 'overload-uncommitted' }),
    /overloaded_error|529/i,
    'a committed overload with no writes to salvage propagates for the caller to handle',
  );
});

test('salvage B: a parse error with NOTHING committed retries once and succeeds', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'salvage-retry', kind: 'chat', title: 'salvage retry' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    if (calls === 1) throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed).");
    settleAdmittedRead({ sessionId: 'salvage-retry', sourceUserSeq: options.sourceUserSeq! });
    return { text: 'Here is your answer.', sessionId: 'sdk', model: 'claude-opus-4-8', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'what is 2+2', sessionId: 'salvage-retry' });
  assert.equal(calls, 2, 'retried once after a pre-commit parse error');
  assert.match(res.text, /Here is your answer/);
});

test('salvage ignores writes from an older turn in the same reusable chat', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  const sid = 'salvage-old-session-write';
  createSession({ id: sid, kind: 'chat', title: 'reusable chat' });
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'tool',
    type: 'external_write',
    data: {
      callId: 'old-send',
      shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      toolName: 'composio_execute_tool',
      targets: ['old@example.com'],
    },
  });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options) => {
    calls += 1;
    if (calls === 1) throw new Error("The model's tool call could not be parsed (retry also failed).");
    settleAdmittedRead({ sessionId: sid, sourceUserSeq: options.sourceUserSeq! });
    return { text: 'The current read-only question recovered.', sessionId: 'sdk', model: 'claude', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'recovered' }));

  const response = await respondViaClaudeAgentSdkBrain('home', {
    message: 'What is on my calendar today?',
    sessionId: sid,
  });

  assert.equal(calls, 2, 'old writes cannot suppress the current turn safe retry');
  assert.match(response.text, /current read-only question recovered/i);
  assert.doesNotMatch(response.text, /already went through|nothing was duplicated|old@example\.com/i);
});

test('salvage: kill-switch off ⇒ the parse error propagates (byte-identical to before)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  process.env.CLEMMY_CLAUDE_SDK_SALVAGE = 'off';
  createSession({ id: 'salvage-off', kind: 'chat', title: 'off' });
  appendEvent({ sessionId: 'salvage-off', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'X', toolName: 'composio_execute_tool', targets: ['a@site.example'] } });
  setClaudeAgentSdkBrainRunForTest(async () => { throw new Error("Claude Code returned an error result: The model's tool call could not be parsed (retry also failed)."); });
  await assert.rejects(
    () => respondViaClaudeAgentSdkBrain('home', { message: 'go', sessionId: 'salvage-off' }),
    /could not be parsed/,
  );
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
});

test('overflow A2: a COMMITTED context overflow salvages an honest partial (never re-runs)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE; // default on
  createSession({ id: 'overflow-committed', kind: 'chat', title: 'overflow salvage' });
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async () => {
    calls += 1;
    appendEvent({ sessionId: 'overflow-committed', turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: ['a@site.example'] } });
    throw new ClaudeSdkContextOverflowError('prompt is too long: 214000 tokens > 200000 maximum', true);
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'sent' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'send that email', sessionId: 'overflow-committed' });
  assert.equal(calls, 1, 'must NOT re-run after a committed overflow (no double-send)');
  assert.doesNotMatch(res.text, /prompt is too long|went wrong/i);
});

test('overflow A2: an UNCOMMITTED context overflow retries ONCE with reduced context (recall dropped, session actions kept)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overflow-uncommitted', kind: 'chat', title: 'overflow retry' });
  const seen: Array<{ priorTurns?: unknown[]; turnContext?: string }> = [];
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    calls += 1;
    seen.push({ priorTurns: opts.priorTurns, turnContext: opts.turnContext });
    if (calls === 1) throw new ClaudeSdkContextOverflowError('context length exceeded', false);
    // A done claim on an action ask needs work evidence — the retried turn
    // reports the tool use it actually made.
    return { text: 'finished after reduced retry', toolUses: ['mcp__clementine-local__write_file'] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'finish the report', sessionId: 'overflow-uncommitted' });
  assert.equal(calls, 2, 'exactly one reduced-context retry');
  assert.match(res.text, /finished after reduced retry/);
  const retry = seen[1];
  assert.ok((retry.priorTurns?.length ?? 0) <= 2, 'prior turns halved to the last 2');
  assert.ok(!(retry.turnContext ?? '').includes('## Relevant To Your Request'), 'recall section dropped on the retry');
  assert.ok(!(retry.turnContext ?? '').includes('[MEMORY PRIMER]'), 'unified recall section dropped on the retry');
});

test('a limit-hit tool ledger cannot cause SDK auto-continuation', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
  let calls = 0;
  const prompts: string[] = [];
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    calls += 1;
    prompts.push(String(opts.prompt ?? ''));
    if (calls === 1) {
      return {
        text: 'Scraped 60 of 100 leads so far.',
        sessionId: 's',
        toolUses: ['mcp__clementine-local__composio_execute_tool'],
        toolCallLedger: [
          { callId: 'toolu_abc123', name: 'composio_execute_tool', argsPreview: '{"tool_slug":"APIFY_GET_DATASET_ITEMS"}' },
        ],
        limitHit: true,
      };
    }
    return { text: 'All 100 leads done.', sessionId: 's', toolUses: ['mcp__clementine-local__composio_execute_tool'], limitHit: false };
  });
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'scrape 100 leads', sessionId: 'brain-ledger' });
  assert.equal(calls, 1);
  assert.equal(prompts.length, 1);
  assert.equal(res.stoppedReason, 'max-turns-with-grace');
  assert.match(res.text, /Scraped 60 of 100 leads/);
  assert.match(res.text, /Progress is checkpointed/);
  assert.equal(listEvents('brain-ledger', { types: ['sdk_auto_continue'] }).length, 0);
});

test('overflow A2: committed overflow with ZERO external writes falls through to the reduced retry (reads are safe)', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  delete process.env.CLEMMY_CLAUDE_SDK_SALVAGE;
  createSession({ id: 'overflow-committed-reads', kind: 'chat', title: 'read-heavy overflow' });
  // No external_write events — a read-heavy research run that overflowed mid-run.
  let calls = 0;
  setClaudeAgentSdkBrainRunForTest(async (options: any) => {
    calls += 1;
    if (calls === 1) throw new ClaudeSdkContextOverflowError('prompt is too long', true);
    settleAdmittedRead({ sessionId: 'overflow-committed-reads', sourceUserSeq: options.sourceUserSeq! });
    return { text: 'finished after retry', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  const res = await respondViaClaudeAgentSdkBrain('home', { message: 'research everything', sessionId: 'overflow-committed-reads' });
  assert.equal(calls, 2, 'reduced retry ran instead of dying unsalvaged');
  assert.match(res.text, /finished after retry/);
});

test('brain runOptions mount no tools for direct replies and retain the recovery/acquisition kernel for retrieval', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'full';
  const seen: Array<{
    message: string;
    allowed: string[] | undefined;
    mcp: string[] | undefined;
    universe: string[] | undefined;
    required: string[] | undefined;
    nativeMaxTools: number | undefined;
    nativeSlugs: string[] | undefined;
  }> = [];
  setClaudeAgentSdkBrainRunForTest(async (opts: any) => {
    seen.push({
      message: String(opts.prompt ?? ''),
      allowed: opts.allowedLocalMcpTools,
      mcp: opts.mcpToolAllowlist,
      universe: opts.localMcpToolUniverse,
      required: opts.requiredLocalMcpTools,
      nativeMaxTools: opts.nativeMcpToolScope?.maxTools,
      nativeSlugs: opts.nativeMcpToolScope?.allowedServerSlugs,
    });
    return { text: 'ok', toolUses: [] };
  });
  setClaudeAgentSdkBrainJudgeForTest(async () => ({ done: true, reason: 'ok' }));
  await respondViaClaudeAgentSdkBrain('home', { message: 'hi', sessionId: 'sentinel-check' });
  await respondViaClaudeAgentSdkBrain('home', {
    message: 'Summarize the notes about project alpha.',
    sessionId: 'sentinel-retrieve-check',
  });
  assert.deepEqual(
    seen[0]?.required,
    [],
    'a direct reply cannot inherit an acquisition or business tool surface',
  );
  assert.deepEqual(seen[0]?.allowed, [], 'a direct reply permits no local runtime tool');
  assert.deepEqual(seen[0]?.mcp, [], 'a direct reply loads no local MCP schema');
  assert.deepEqual(seen[0]?.universe, [], 'a direct reply has no deferred local capability universe');
  assert.equal(seen[0]?.nativeMaxTools, 0, 'a direct reply permits no external native MCP tool');
  assert.deepEqual(seen[0]?.nativeSlugs, [], 'a direct reply permits no external MCP server');
  assert.deepEqual(
    seen[1]?.required,
    ['memory_recall_all', 'tool_search', 'call_tool'],
    'a retrieval turn retains the bounded recovery and schema-on-demand kernel',
  );
});
