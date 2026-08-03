/**
 * Run: npx tsx --test src/tools/execution-tools.test.ts
 *
 * Focuses on the pure `pickFocusTarget` matcher — the part of
 * execution_focus that decides which execution the user means when
 * they say `/focus social media` or `/focus 4a2b...`. The matcher is
 * the place where a subtle bug (matching too eagerly, picking the
 * wrong record on a substring collision) would silently pause the
 * wrong work.
 *
 * The pause/resume/clear-focus logic itself is a straight wrapper
 * over ExecutionStore.update, covered indirectly by the runtime
 * e2e and the existing store tests. The matcher gets dedicated
 * coverage here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionRecord } from '../types.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-execution-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  pickFocusTarget,
  registerExecutionTools,
  renderActiveExecutionsForAgent,
  activeExecutionCountForSession,
  _setExecutionToolCompletionJudgeForTests,
} = await import('./execution-tools.js');
const { ExecutionStore } = await import('../execution/store.js');
const { compileProjectPlan } = await import('../execution/project-compiler.js');
const { canonicalProjectPlan } = await import('../execution/project-plan-ir.js');
const { workflowDefinitionHash } = await import('../execution/workflow-run-definition.js');
const {
  appendEvent,
  createSession,
  listEvents,
  resetEventLog,
  TOOL_OUTPUT_MAX_BYTES,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');
const {
  ToolCallsCounter,
  withHarnessRunContext,
} = await import('../runtime/harness/brackets.js');
const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(EXECUTIONS_FILE, '[]', 'utf-8');
  resetEventLog();
  _setExecutionToolCompletionJudgeForTests(null);
});

function baseExec(overrides: Partial<ExecutionRecord>): ExecutionRecord {
  const iso = new Date().toISOString();
  return {
    id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: 'sess-test',
    title: 'untitled',
    objective: 'do a thing',
    reason: 'because',
    status: 'active',
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    startedFromMessage: 'go',
    confidence: 0.5,
    reasons: [],
    ...overrides,
  } as ExecutionRecord;
}

function createTrackedExecution(overrides: Partial<Parameters<InstanceType<typeof ExecutionStore>['create']>[0]> = {}) {
  return new ExecutionStore().create({
    sessionId: 'sess-exec-tool',
    title: 'Send the report',
    objective: 'Send the finished report and provide a send receipt',
    reason: 'test',
    startedFromMessage: 'send it',
    confidence: 0.9,
    reasons: ['test'],
    successCriteria: 'A send receipt id is present',
    nextStep: 'Send report and capture receipt',
    ...overrides,
  });
}

function createGraphExecution(sessionId: string, label: string) {
  createSession({ id: sessionId, kind: 'chat', title: `graph ${label}` });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Run durable graph ${label}.` },
  });
  const plan = canonicalProjectPlan({
    planId: `tool-graph-${label}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 48),
    objective: `Complete durable graph ${label} with verified evidence.`,
    nodes: [{
      id: 'finish',
      executor: {
        kind: 'model',
        instruction: 'Produce the verified project result.',
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read',
      maxTurns: 4,
      evidence: { type: 'object', requiredKeys: ['summary'], nonEmpty: ['summary'] },
    }],
  });
  const compiled = compileProjectPlan(plan);
  return new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: `Durable graph ${label}`,
    objective: `Complete durable graph ${label} with verified evidence.`,
    reason: 'test graph',
    startedFromMessage: `Run durable graph ${label}.`,
    confidence: 1,
    reasons: ['test'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: {},
      },
    },
  }).execution;
}

function registeredToolHandlers(): Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>);
    },
  };
  registerExecutionTools(server as never);
  return handlers;
}

function appendExactToolLifecycle(input: {
  sessionId: string;
  callId: string;
  tool?: string;
  effect?: 'read' | 'compute';
  arguments?: unknown;
  effectiveTool?: string;
  output: string;
  invocationNonce?: string | null;
  returnData?: Record<string, unknown>;
  parentReturn?: boolean;
}): void {
  const tool = input.tool ?? 'composio_execute_tool';
  const effect = input.effect ?? 'read';
  const called = appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'system',
    type: 'tool_called',
    data: {
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      effect,
      arguments: input.arguments ?? {
        tool_slug: 'GOOGLESHEETS_GET_RANGE',
        arguments: { range: 'Sheet1!A:Z' },
      },
      ...(input.effectiveTool ? { effectiveTool: input.effectiveTool } : {}),
    },
  });
  writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    tool,
    invocationNonce: input.invocationNonce === undefined
      ? `nonce-${input.callId}`
      : input.invocationNonce,
    output: input.output,
  });
  appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'tool',
    type: 'tool_returned',
    ...(input.parentReturn === false ? {} : { parentEventId: called.id }),
    data: {
      tool,
      callId: input.callId,
      canonicalCallId: input.callId,
      effect,
      ok: true,
      ...(input.effectiveTool ? { effectiveTool: input.effectiveTool } : {}),
      ...input.returnData,
    },
  });
}

test('pickFocusTarget: exact id match wins even if a substring would also match', () => {
  const target = baseExec({ id: 'exec-the-id', title: 'something else' });
  const other = baseExec({ id: 'exec-other', title: 'mentions exec-the-id in title' });
  const result = pickFocusTarget('exec-the-id', [target, other]);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') {
    assert.equal(result.target.id, 'exec-the-id');
  }
});

test('pickFocusTarget: substring match against title (case-insensitive)', () => {
  const records = [
    baseExec({ id: 'e1', title: 'ExampleCo social media post' }),
    baseExec({ id: 'e2', title: 'morning briefing cron' }),
    baseExec({ id: 'e3', title: 'end-of-day cron' }),
  ];
  const result = pickFocusTarget('social media', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'e1');
});

test('pickFocusTarget: substring match against objective when title misses', () => {
  const records = [
    baseExec({ id: 'a', title: 'unrelated', objective: 'write a Twitter post about ExampleCo' }),
    baseExec({ id: 'b', title: 'unrelated 2', objective: 'morning briefing' }),
  ];
  const result = pickFocusTarget('twitter', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'a');
});

test('pickFocusTarget: empty list → none', () => {
  const result = pickFocusTarget('anything', []);
  assert.equal(result.kind, 'none');
});

test('pickFocusTarget: nothing matches → none', () => {
  const records = [
    baseExec({ id: 'a', title: 'morning briefing', objective: 'summarize inbox' }),
  ];
  const result = pickFocusTarget('rocket science', records);
  assert.equal(result.kind, 'none');
});

test('pickFocusTarget: multiple matches → ambiguous with all candidates returned', () => {
  const records = [
    baseExec({ id: 'a', title: 'social media post for ExampleCo' }),
    baseExec({ id: 'b', title: 'social media plan for the next quarter' }),
    baseExec({ id: 'c', title: 'unrelated cron job' }),
  ];
  const result = pickFocusTarget('social', records);
  assert.equal(result.kind, 'ambiguous');
  if (result.kind === 'ambiguous') {
    assert.equal(result.matches.length, 2);
    const ids = result.matches.map((e) => e.id).sort();
    assert.deepEqual(ids, ['a', 'b']);
  }
});

test('pickFocusTarget: matcher is case-insensitive for query vs title', () => {
  const records = [baseExec({ id: 'x', title: 'ExampleCo Marketing' })];
  for (const q of ['exampleCO', 'EXAMPLECO', 'ExampleCo', 'exampleco']) {
    const r = pickFocusTarget(q, records);
    assert.equal(r.kind, 'match', `query "${q}" should match`);
  }
});

test('pickFocusTarget: records with undefined title/objective are skipped, not crashed on', () => {
  const records = [
    baseExec({ id: 'good', title: 'find social media drafts' }),
    // Force a malformed record through the type system — should not throw.
    { ...baseExec({ id: 'bad' }), title: undefined as unknown as string, objective: undefined as unknown as string },
  ];
  const result = pickFocusTarget('social', records);
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') assert.equal(result.target.id, 'good');
});

test('legacy execution mutation tools refuse graph-owned lifecycle before binding or store mutation', async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const sessionId = `sess-graph-mutations-${suffix}`;
  const graph = createGraphExecution(sessionId, `mutations-${suffix}`);
  const followUp = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Try to mutate that durable project from this later request.' },
  });
  const before = readFileSync(EXECUTIONS_FILE, 'utf-8');
  let judgeCalls = 0;
  _setExecutionToolCompletionJudgeForTests(async () => {
    judgeCalls += 1;
    return { done: true, reason: 'must never run for a graph-owned record' };
  });
  const handlers = registeredToolHandlers();
  const calls: Array<[string, Record<string, unknown>]> = [
    ['execution_update_step', { id: graph.id, nextStep: 'Try a legacy update.' }],
    ['execution_reconcile_write', {
      id: graph.id,
      call_id: 'graph-write',
      verdict: 'absent',
      evidence_call_id: 'graph-read',
    }],
    ['execution_mark_blocked', { id: graph.id, blocker: 'Try a legacy blocker.' }],
    ['execution_pause', { id: graph.id, reason: 'Try a legacy pause.' }],
    ['execution_resume', { id: graph.id }],
    ['execution_complete', { id: graph.id, summary: 'Try a legacy completion.' }],
  ];

  for (const [name, args] of calls) {
    const handler = handlers.get(name);
    assert.ok(handler, `${name} should be registered`);
    const result = await withHarnessRunContext(
      {
        sessionId,
        sourceUserSeq: followUp.seq,
        counter: new ToolCallsCounter(20),
      },
      () => handler(args),
    );
    assert.match(result.content[0].text, /durable project graph/i, name);
    assert.match(result.content[0].text, /root workflow owns lifecycle/i, name);
  }

  assert.equal(judgeCalls, 0, 'legacy completion validation never runs for a graph');
  assert.equal(
    readFileSync(EXECUTIONS_FILE, 'utf-8'),
    before,
    'none of the refusals binds the source request or changes graph state',
  );
});

test('focus, clear-focus, and autonomy context operate on legacy executions while a graph is active', async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const sessionId = `sess-graph-focus-${suffix}`;
  const graph = createGraphExecution(sessionId, `focus-${suffix}`);
  const store = new ExecutionStore();
  const target = store.create({
    sessionId,
    title: `Legacy focus target ${suffix}`,
    objective: 'Advance the exact legacy execution selected by the user.',
    reason: 'focus test',
    startedFromMessage: 'Focus this legacy execution.',
    confidence: 1,
    reasons: ['test'],
    nextStep: 'Advance the selected legacy lane.',
  });
  const other = store.create({
    sessionId,
    title: `Legacy focus sibling ${suffix}`,
    objective: 'Remain independently pausable by the legacy focus controller.',
    reason: 'focus test',
    startedFromMessage: 'Track another legacy execution.',
    confidence: 1,
    reasons: ['test'],
    nextStep: 'Wait while the other legacy lane is focused.',
  });
  const handlers = registeredToolHandlers();
  const focus = handlers.get('execution_focus')!;
  const clear = handlers.get('execution_clear_focus')!;

  const result = await focus({ query: target.id });
  assert.match(result.content[0].text, /Paused 1 other execution/i);
  assert.equal(store.get(target.id)?.status, 'active');
  assert.equal(store.get(other.id)?.status, 'paused');
  assert.equal(store.get(other.id)?.pausedBy, 'focus');
  assert.equal(store.get(graph.id)?.status, 'active', 'focus never attempts to pause the graph');

  const graphFocus = await focus({ query: graph.id });
  assert.match(graphFocus.content[0].text, /No active execution matches/i);
  assert.equal(store.get(graph.id)?.status, 'active');

  const rendered = renderActiveExecutionsForAgent(sessionId);
  assert.match(rendered, new RegExp(target.id));
  assert.doesNotMatch(rendered, new RegExp(graph.id));
  assert.equal(activeExecutionCountForSession(sessionId), 1);

  const cleared = await clear({});
  assert.match(cleared.content[0].text, /Resumed 1 focus-paused execution/i);
  assert.equal(store.get(other.id)?.status, 'active');
  assert.equal(store.get(graph.id)?.status, 'active');
  assert.equal(activeExecutionCountForSession(sessionId), 2);
});

test('execution_create accepts natural criteria arrays and preserves the full audit trail', async () => {
  const sessionId = `sess-exec-array-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'criteria-array' });
  const handler = registeredToolHandlers().get('execution_create');
  assert.ok(handler, 'execution_create should be registered');

  const result = await withHarnessRunContext(
    { sessionId, counter: new ToolCallsCounter(10) },
    () => handler({
      title: 'Verify a disposable deployment',
      objective: 'Create one disposable deployment and verify its public response exactly.',
      successCriteria: [
        'Exactly one resource is created.',
        'The public endpoint returns HTTP 200.',
        'The exact sentinel appears once.',
      ],
      nextStep: 'Create the disposable resource once.',
    }),
  );
  assert.match(result.content[0].text, /Created execution/);
  const created = new ExecutionStore().getActiveForSession(sessionId);
  assert.match(created?.successCriteria ?? '', /1\. Exactly one resource/);
  assert.match(created?.successCriteria ?? '', /3\. The exact sentinel/);
});

test('execution_update_step authorizes exactly one retry from proven failed write lineage', async () => {
  const sessionId = `sess-exec-retry-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'retry lineage' });
  const sourceA = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved reports to these exact recipients.' },
  });
  const recipients = Array.from({ length: 10 }, (_, index) => `recipient-${index + 1}@example.com`);
  const execution = createTrackedExecution({
    sessionId,
    sourceUserSeq: sourceA.seq,
    status: 'active',
  } as never);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-proven-not-started',
      canonicalCallId: 'send-proven-not-started',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      correlationFingerprint: 'send-payload-a',
      targets: recipients,
      preDispatch: true,
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-proven-not-started',
      canonicalCallId: 'send-proven-not-started',
      actionKey: 'email:send',
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      correlationFingerprint: 'send-payload-a',
      targets: recipients,
    },
  });
  const sourceB = appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Authentication is repaired; continue this exact execution.' },
  });
  const handler = registeredToolHandlers().get('execution_update_step');
  assert.ok(handler, 'execution_update_step should be registered');
  const callUpdate = (retryOfCallId: string) => withHarnessRunContext(
    {
      sessionId,
      sourceUserSeq: sourceB.seq,
      counter: new ToolCallsCounter(20),
    },
    () => handler({
      id: execution.id,
      nextStep: 'Retry the exact corrected send once.',
      summary: 'Authentication is now available.',
      retryOfCallId,
    }),
  );

  const concurrent = await Promise.all([
    callUpdate('send-proven-not-started'),
    callUpdate('send-proven-not-started'),
  ]);
  assert.equal(
    concurrent.filter((result) => /advanced/i.test(result.content[0].text)).length,
    1,
  );
  assert.equal(
    concurrent.filter((result) => /already has a one-shot retry authorization/i.test(result.content[0].text)).length,
    1,
    'the list→check→mint path is one admission CAS even when callers race',
  );
  const [authorization] = listEvents(sessionId, {
    types: ['external_write_retry_authorized'],
  });
  assert.equal(authorization?.data.sourceUserSeq, sourceB.seq);
  assert.equal(authorization?.data.executionId, execution.id);
  assert.equal(authorization?.data.retryOfCallId, 'send-proven-not-started');
  assert.equal(authorization?.data.actionKey, 'email:send');
  assert.deepEqual(
    authorization?.data.duplicateIdentityKeys,
    [...recipients].sort(),
    'the complete recipient set is retained beyond eight identities',
  );
  assert.ok(
    new ExecutionStore().get(execution.id)?.sourceUserSeqs?.includes(sourceB.seq),
    'the exact continuation request is durably bound to the execution',
  );

  const repeated = await callUpdate('send-proven-not-started');
  assert.match(repeated.content[0].text, /already has a one-shot retry authorization/i);
  assert.equal(
    listEvents(sessionId, { types: ['external_write_retry_authorized'] }).length,
    1,
  );

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'targetless-post-not-started',
      canonicalCallId: 'targetless-post-not-started',
      actionKey: 'social:publish',
      correlationFingerprint: 'transport-specific-fingerprint-must-not-win',
      targets: [],
      duplicateIdentityKeys: ['payload:semantic-v1:exact-post'],
    },
  });
  const targetlessAccepted = await callUpdate('targetless-post-not-started');
  assert.match(targetlessAccepted.content[0].text, /advanced/i);
  const targetlessAuthorization = listEvents(sessionId, {
    types: ['external_write_retry_authorized'],
  }).find((event) => event.data.retryOfCallId === 'targetless-post-not-started');
  assert.deepEqual(
    targetlessAuthorization?.data.duplicateIdentityKeys,
    ['payload:semantic-v1:exact-post'],
    'retry lineage preserves the provider-neutral identity recorded by the failed attempt',
  );

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_orphaned',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-ambiguous',
      canonicalCallId: 'send-ambiguous',
      actionKey: 'email:send',
      targets: ['ambiguous@example.com'],
    },
  });
  const orphanRefusal = await callUpdate('send-ambiguous');
  assert.match(orphanRefusal.content[0].text, /not a currently proven failed write/i);

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: 999_999,
      callId: 'send-foreign-lineage',
      canonicalCallId: 'send-foreign-lineage',
      actionKey: 'email:send',
      targets: ['foreign@example.com'],
    },
  });
  const lineageRefusal = await callUpdate('send-foreign-lineage');
  assert.match(lineageRefusal.content[0].text, /outside this execution's explicit request lineage/i);

  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_failed',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-later-succeeded',
      canonicalCallId: 'send-later-succeeded',
      actionKey: 'email:send',
      targets: ['settled@example.com'],
    },
  });
  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write_succeeded',
    data: {
      sourceUserSeq: sourceA.seq,
      callId: 'send-later-succeeded',
      canonicalCallId: 'send-later-succeeded',
      actionKey: 'email:send',
      targets: ['settled@example.com'],
    },
  });
  const settledRefusal = await callUpdate('send-later-succeeded');
  assert.match(settledRefusal.content[0].text, /not a currently proven failed write/i);
});

test('execution_complete rejects completion when the judge finds no deliverable evidence', async () => {
  const execution = createTrackedExecution();
  let judgeCalls = 0;
  _setExecutionToolCompletionJudgeForTests(async (objective, evidence) => {
    judgeCalls += 1;
    assert.match(objective, /Send the finished report/);
    assert.match(evidence, /send it next/i);
    return { done: false, reason: 'no receipt id is present' };
  });

  const handler = registeredToolHandlers().get('execution_complete');
  assert.ok(handler, 'execution_complete should be registered');
  const result = await handler({
    id: execution.id,
    summary: "I'll send it next.",
  });

  assert.equal(judgeCalls, 1);
  assert.match(result.content[0].text, /Completion not accepted/);
  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.status, 'active');
  assert.match(updated?.lastAssistantSummary ?? '', /Completion not accepted/);
  assert.ok(updated?.activity?.some((item) =>
    item.type === 'status' && /Completion not accepted/.test(item.message)
  ));
});

test('execution_complete closes only after completion validation passes', async () => {
  const execution = createTrackedExecution();
  _setExecutionToolCompletionJudgeForTests(async () => ({ done: true, reason: 'receipt id present' }));

  const handler = registeredToolHandlers().get('execution_complete');
  assert.ok(handler, 'execution_complete should be registered');
  const result = await handler({
    id: execution.id,
    summary: 'Report sent. Receipt id msg_123.',
  });

  assert.match(result.content[0].text, /completed/);
  const updated = new ExecutionStore().get(execution.id);
  assert.equal(updated?.status, 'completed');
  assert.match(updated?.lastAssistantSummary ?? '', /msg_123/);
});

test('execution_complete cannot persist success when one current-request write remains orphaned', async () => {
  const sessionId = `sess-exec-mixed-write-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'mixed write truth' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send both approved reports.' },
  });
  const execution = createTrackedExecution({
    sessionId,
    sourceUserSeq: source.seq,
  } as never);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { callId: 'send-a', shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['a@example.com'] },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { callId: 'send-b', shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['b@example.com'] },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: { callId: 'send-b', shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['b@example.com'] },
  });
  let judgeCalls = 0;
  _setExecutionToolCompletionJudgeForTests(async () => {
    judgeCalls += 1;
    return {
      done: true,
      reason: 'the summary claims both sends completed',
    };
  });

  const handler = registeredToolHandlers().get('execution_complete');
  assert.ok(handler, 'execution_complete should be registered');
  const result = await withHarnessRunContext(
    { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(10) },
    () => handler({
      id: execution.id,
      summary: 'Both approved reports were sent successfully with receipts.',
    }),
  );

  assert.match(result.content[0].text, /Completion not accepted/i);
  assert.match(result.content[0].text, /ambiguous/i);
  assert.equal(judgeCalls, 0, 'explicit negative evidence is reconciled without an LM judge call');
  const persisted = new ExecutionStore().get(execution.id);
  assert.equal(persisted?.status, 'blocked');
  assert.match(persisted?.blocker ?? '', /read-only reconciliation/i);
  assert.equal(
    new ExecutionStore().list(20).find((item) => item.id === execution.id)?.status,
    'blocked',
    'the dashboard-facing store contract must not expose a clean completed state',
  );
});

test('execution_complete gives the judge exact durable readback receipts without making the summary repeat every cell', async () => {
  const sessionId = `sess-exec-receipts-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'receipt-backed completion' });
  const execution = createTrackedExecution({
    sessionId,
    title: 'Create and verify a disposable sheet',
    objective: 'Write the supplied company and email rows, then verify the exact range',
    successCriteria: 'Read-back of Sheet1!A1:B4 matches all 8 expected cells',
    nextStep: 'Write and verify Sheet1!A1:B4',
  });
  const callId = `sheet-read-${Math.random().toString(36).slice(2, 10)}`;
  const argumentsJson = JSON.stringify({
    tool_slug: 'GOOGLESHEETS_BATCH_GET',
    arguments: { spreadsheet_id: 'sheet-test', ranges: ['Sheet1!A1:B4'] },
  });
  const called = appendEvent({
    sessionId,
    turn: 1,
    role: 'agent',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId,
      accounting: 'top_level',
      effect: 'read',
      arguments: argumentsJson,
    },
  });
  writeToolOutput({
    sessionId,
    callId,
    tool: 'composio_execute_tool',
    output: JSON.stringify({
      successful: true,
      data: {
        valueRanges: [{
          range: 'Sheet1!A1:B4',
          values: [
            ['company', 'email'],
            ['Acme', 'acme@example.com'],
            ['Beacon', 'beacon@example.com'],
            ['Cedar', 'cedar@example.com'],
          ],
        }],
      },
    }),
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId,
      accounting: 'top_level',
      effect: 'read',
      ok: true,
    },
  });

  let judgeCalls = 0;
  _setExecutionToolCompletionJudgeForTests(async (_objective, evidence) => {
    judgeCalls += 1;
    assert.match(evidence, /Verified tool receipts from this execution/);
    assert.match(evidence, /GOOGLESHEETS_BATCH_GET/);
    assert.match(evidence, /Sheet1!A1:B4/);
    assert.match(evidence, /Beacon/);
    assert.match(evidence, /beacon@example\.com/);
    return { done: true, reason: 'the durable readback contains all expected cells' };
  });

  const handler = registeredToolHandlers().get('execution_complete');
  assert.ok(handler, 'execution_complete should be registered');
  const result = await handler({
    id: execution.id,
    summary: 'The exact write was completed and its requested range was read back successfully.',
  });

  assert.equal(judgeCalls, 1);
  assert.match(result.content[0].text, /completed/);
  assert.equal(new ExecutionStore().get(execution.id)?.status, 'completed');
});

test('execution_reconcile_write settles an ambiguous attempt from ANY read whose evidence names the target — absent unlocks ONE retry, present records done', async () => {
  const sessionId = `sess-exec-reconcile-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'reconcile settlement' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Draft the follow-up email for Annie.' },
  });
  const execution = createTrackedExecution({
    sessionId, sourceUserSeq: source.seq, status: 'active',
  } as never);
  // The ambiguous attempt: dispatch started, outcome never settled (the live
  // 2026-07-30 rail — the model verified the draft absent and had NO verb to
  // record it, so the duplicate-safety hold wedged forever).
  appendEvent({
    sessionId, turn: 1, role: 'system', type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      callId: 'draft-ambiguous', canonicalCallId: 'draft-ambiguous',
      actionKey: 'email:draft', shapeKey: 'OUTLOOK_CREATE_DRAFT',
      targets: ['annie@example.com'], preDispatch: true,
    },
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write');
  assert.ok(reconcile, 'execution_reconcile_write should be registered');
  const update = registeredToolHandlers().get('execution_update_step')!;
  const ctx = { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(20) };
  const call = (args: Record<string, unknown>) => withHarnessRunContext(ctx, () => reconcile!(args));

  // 1. The refusal path teaches the truth: retry of an ambiguous write is
  //    refused by CLEMENTINE'S ledger — never blamed on the provider.
  const refused = await withHarnessRunContext(ctx, () => update({
    id: execution.id, nextStep: 'retry draft', retryOfCallId: 'draft-ambiguous',
  }));
  assert.match(refused.content[0].text, /Clementine's OWN duplicate-safety ledger, not the provider refusing/i);
  assert.match(refused.content[0].text, /execution_reconcile_write/);

  // 2. Evidence must exist and postdate the attempt.
  const missingEvidence = await call({
    id: execution.id, call_id: 'draft-ambiguous', verdict: 'absent', evidence_call_id: 'no-such-read',
  });
  assert.match(missingEvidence.content[0].text, /no exact invocation-scoped output/i);

  // 3. A LIST read (no target in args) whose OUTPUT names the target counts —
  //    the shape-agnostic evidence rule.
  appendExactToolLifecycle({
    sessionId,
    callId: 'list-drafts',
    arguments: { tool_slug: 'OUTLOOK_LIST_DRAFTS', arguments: {} },
    invocationNonce: 'nonce-list-drafts',
    output: 'Drafts (2): weekly summary to team@example.com; intro to bob@example.com. No draft addressed to annie@example.com exists.',
  });
  const settled = await call({
    id: execution.id, call_id: 'draft-ambiguous', verdict: 'absent', evidence_call_id: 'list-drafts',
  });
  assert.match(settled.content[0].text, /Reconciled draft-ambiguous as ABSENT/i);
  assert.match(settled.content[0].text, /retryOfCallId/);

  // 4. The settlement is a REAL proven failure: the one-shot retry now mints.
  const retried = await withHarnessRunContext(ctx, () => update({
    id: execution.id, nextStep: 'Re-issue the corrected draft once.', retryOfCallId: 'draft-ambiguous',
  }));
  assert.match(retried.content[0].text, /advanced/i);
  const settlement = listEvents(sessionId, { types: ['external_write_failed'] })
    .find((event) => event.data.callId === 'draft-ambiguous');
  assert.equal(settlement?.data.reason, 'reconciled_absent');
  assert.equal(settlement?.data.evidenceCallId, 'list-drafts');
  const reservation = listEvents(sessionId, { types: ['external_write'] })
    .find((event) => event.data.callId === 'draft-ambiguous');
  assert.equal(settlement?.parentEventId, reservation?.id, 'reconciliation binds the exact reservation');

  // 5. Already-settled attempts refuse re-reconciliation.
  const again = await call({
    id: execution.id, call_id: 'draft-ambiguous', verdict: 'present', evidence_call_id: 'list-drafts',
  });
  assert.match(again.content[0].text, /already has a settled outcome/i);
});

test('execution_reconcile_write verdict PRESENT records success; unrelated evidence is refused', async () => {
  const sessionId = `sess-exec-reconcile-p-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'reconcile present' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the row for acct-991.' },
  });
  const execution = createTrackedExecution({ sessionId, sourceUserSeq: source.seq, status: 'active' } as never);
  appendEvent({
    sessionId, turn: 1, role: 'system', type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      callId: 'row-ambiguous', canonicalCallId: 'row-ambiguous',
      actionKey: 'sheet:append', shapeKey: 'GOOGLESHEETS_APPEND',
      targets: ['acct-991'], preDispatch: true,
    },
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(20) };

  // Unrelated evidence (never names the target) is refused.
  appendExactToolLifecycle({
    sessionId,
    callId: 'other-read',
    invocationNonce: 'nonce-other-read',
    output: 'Rows: acct-100, acct-101.',
  });
  const unrelated = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id, call_id: 'row-ambiguous', verdict: 'present', evidence_call_id: 'other-read',
  }));
  assert.match(unrelated.content[0].text, /never mentions the attempt's target/i);

  // Evidence naming the target settles it as landed.
  appendExactToolLifecycle({
    sessionId,
    callId: 'target-read',
    invocationNonce: 'nonce-target-read',
    output: 'Row found: acct-991 | Follow-up | 2026-07-30',
  });
  const present = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id, call_id: 'row-ambiguous', verdict: 'present', evidence_call_id: 'target-read',
  }));
  assert.match(present.content[0].text, /Reconciled row-ambiguous as PRESENT/i);
  assert.match(present.content[0].text, /Do NOT send it again/i);
  const settlement = listEvents(sessionId, { types: ['external_write_succeeded'] })
    .find((event) => event.data.callId === 'row-ambiguous');
  assert.equal(settlement?.data.reason, 'reconciled_present');
  const reservation = listEvents(sessionId, { types: ['external_write'] })
    .find((event) => event.data.callId === 'row-ambiguous');
  assert.equal(settlement?.parentEventId, reservation?.id);
  assert.equal(settlement?.data.settlementKey, `external-write:${reservation?.id}`);
});

test('execution_reconcile_write rejects reused evidence ids and PRESENT against exact NOT FOUND bytes', async () => {
  const sessionId = `sess-exec-reconcile-evidence-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'exact evidence identity' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the row for acct-991.' },
  });
  const execution = createTrackedExecution({ sessionId, sourceUserSeq: source.seq, status: 'active' } as never);
  appendEvent({
    sessionId, turn: 1, role: 'system', type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      callId: 'row-ambiguous-exact', canonicalCallId: 'row-ambiguous-exact',
      actionKey: 'sheet:append', shapeKey: 'GOOGLESHEETS_APPEND',
      targets: ['acct-991'], preDispatch: true,
    },
  });
  appendEvent({
    sessionId, turn: 2, role: 'system', type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'read-reused', canonicalCallId: 'read-reused', effect: 'read', arguments: { tool_slug: 'GOOGLESHEETS_GET_RANGE', arguments: { range: 'Sheet1!A:Z' } } },
  });
  writeToolOutput({
    sessionId, callId: 'read-reused', invocationNonce: 'nonce-old-present', tool: 'composio_execute_tool',
    output: `Row found: acct-991 ${'stale '.repeat(1_000)}`,
  });
  writeToolOutput({
    sessionId, callId: 'read-reused', invocationNonce: 'nonce-current-absent', tool: 'composio_execute_tool',
    output: 'NOT FOUND: acct-991',
  });
  const reusedCalled = listEvents(sessionId, { types: ['tool_called'] })
    .find((event) => event.data.callId === 'read-reused');
  assert.ok(reusedCalled);
  appendEvent({
    sessionId, turn: 2, role: 'tool', type: 'tool_returned', parentEventId: reusedCalled.id,
    data: { tool: 'composio_execute_tool', callId: 'read-reused', canonicalCallId: 'read-reused', effect: 'read', ok: true },
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(20) };
  const reused = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'row-ambiguous-exact',
    verdict: 'present',
    evidence_call_id: 'read-reused',
  }));
  assert.match(reused.content[0].text, /2 candidate invocation|stale and current/i);
  assert.equal(listEvents(sessionId, { types: ['external_write_succeeded'] }).length, 0);

  appendExactToolLifecycle({
    sessionId,
    callId: 'read-exact-absent',
    invocationNonce: 'nonce-exact-absent',
    output: 'NOT FOUND: acct-991',
  });
  const contradicted = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'row-ambiguous-exact',
    verdict: 'present',
    evidence_call_id: 'read-exact-absent',
  }));
  assert.match(contradicted.content[0].text, /cannot prove PRESENT|failure\/absence-shaped/i);
  assert.equal(listEvents(sessionId, { types: ['external_write_succeeded'] }).length, 0);

  appendExactToolLifecycle({
    sessionId,
    callId: 'read-sibling-empty',
    invocationNonce: 'nonce-sibling-empty',
    output: JSON.stringify({ successful: true, data: { rows: [{ account: 'acct-991', status: 'present' }], results: [] } }),
  });
  const siblingEmpty = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'row-ambiguous-exact',
    verdict: 'absent',
    evidence_call_id: 'read-sibling-empty',
  }));
  assert.match(siblingEmpty.content[0].text, /returns the write target|empty sibling/i);
  assert.equal(listEvents(sessionId, { types: ['external_write_failed'] }).length, 0);

  appendExactToolLifecycle({
    sessionId,
    callId: 'read-request-echo',
    arguments: { tool_slug: 'GOOGLESHEETS_GET_RANGE', arguments: { account: 'acct-991' } },
    invocationNonce: 'nonce-request-echo',
    output: JSON.stringify({ successful: true, data: { request: { account: 'acct-991' }, records: [{ account: 'acct-OTHER' }] } }),
  });
  const requestEcho = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'row-ambiguous-exact',
    verdict: 'present',
    evidence_call_id: 'read-request-echo',
  }));
  assert.match(requestEcho.content[0].text, /does not return the write target|request arguments alone/i);
  assert.equal(listEvents(sessionId, { types: ['external_write_succeeded'] }).length, 0);

  const absent = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'row-ambiguous-exact',
    verdict: 'absent',
    evidence_call_id: 'read-exact-absent',
  }));
  assert.match(absent.content[0].text, /Reconciled row-ambiguous-exact as ABSENT/i);
  const settlement = listEvents(sessionId, { types: ['external_write_failed'] })[0];
  assert.equal(settlement?.data.evidenceInvocationNonce, 'nonce-exact-absent');
  assert.match(String(settlement?.data.evidenceSha256), /^[a-f0-9]{64}$/);
});

test('execution_reconcile_write accepts only one exact parented provider-read lifecycle as settlement authority', async () => {
  const sessionId = `sess-exec-reconcile-authority-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'reconcile authority boundary' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the row for acct-authority.' },
  });
  const execution = createTrackedExecution({ sessionId, sourceUserSeq: source.seq, status: 'active' } as never);
  appendEvent({
    sessionId, turn: 1, role: 'system', type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      callId: 'authority-write', canonicalCallId: 'authority-write',
      actionKey: 'sheet:append', shapeKey: 'GOOGLESHEETS_APPEND',
      targets: ['acct-authority'], preDispatch: true,
    },
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(50) };
  const settleAbsent = (evidenceCallId: string) => withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'authority-write',
    verdict: 'absent',
    evidence_call_id: evidenceCallId,
  }));
  const absenceOutput = 'NOT FOUND: acct-authority';

  const derivedReaders = [
    { callId: 'direct-recall', tool: 'recall_tool_result', arguments: { call_id: 'provider-origin' } },
    { callId: 'direct-query', tool: 'tool_output_query', arguments: { call_id: 'provider-origin', query: 'acct-authority' } },
    { callId: 'local-recall', tool: 'mcp__clementine-local__recall_tool_result', arguments: { call_id: 'provider-origin' } },
    { callId: 'local-query', tool: 'mcp__clementine-local__tool_output_query', arguments: { call_id: 'provider-origin', query: 'acct-authority' } },
    {
      callId: 'carrier-recall',
      tool: 'call_tool',
      effectiveTool: 'recall_tool_result',
      arguments: { name: 'recall_tool_result', args_json: '{"call_id":"provider-origin"}' },
    },
    {
      callId: 'carrier-query',
      tool: 'call_tool',
      effectiveTool: 'tool_output_query',
      arguments: { name: 'tool_output_query', args_json: '{"call_id":"provider-origin","query":"acct-authority"}' },
    },
  ];
  for (const reader of derivedReaders) {
    appendExactToolLifecycle({
      sessionId,
      ...reader,
      output: absenceOutput,
    });
    const result = await settleAbsent(reader.callId);
    assert.match(result.content[0].text, /Reconciliation refused/i, reader.callId);
    assert.match(result.content[0].text, /presentation-only|not successful authority/i, reader.callId);
  }

  appendExactToolLifecycle({
    sessionId,
    callId: 'failed-read',
    output: absenceOutput,
    returnData: { ok: false, error: 'provider read failed' },
  });
  assert.match((await settleAbsent('failed-read')).content[0].text, /not successful authority|explicitly failed/i);

  appendExactToolLifecycle({
    sessionId,
    callId: 'truncated-read',
    output: `${absenceOutput}\n${'x'.repeat(TOOL_OUTPUT_MAX_BYTES)}`,
  });
  assert.match((await settleAbsent('truncated-read')).content[0].text, /no complete exact output/i);

  writeToolOutput({
    sessionId,
    callId: 'orphan-read',
    tool: 'composio_execute_tool',
    invocationNonce: 'nonce-orphan-read',
    output: absenceOutput,
  });
  assert.match((await settleAbsent('orphan-read')).content[0].text, /parented provider read/i);

  appendExactToolLifecycle({
    sessionId,
    callId: 'legacy-read',
    invocationNonce: null,
    output: absenceOutput,
  });
  assert.match((await settleAbsent('legacy-read')).content[0].text, /legacy presentation state/i);

  appendExactToolLifecycle({
    sessionId,
    callId: 'compute-result',
    tool: 'run_shell_command',
    effect: 'compute',
    arguments: { command: 'printf "NOT FOUND: acct-authority"' },
    output: absenceOutput,
  });
  assert.match((await settleAbsent('compute-result')).content[0].text, /parented provider read/i);

  appendExactToolLifecycle({
    sessionId,
    callId: 'stale-reused-read',
    output: absenceOutput,
  });
  const laterCall = appendEvent({
    sessionId, turn: 3, role: 'system', type: 'tool_called',
    data: {
      tool: 'composio_execute_tool', callId: 'stale-reused-read',
      canonicalCallId: 'stale-reused-read', effect: 'read',
      arguments: { tool_slug: 'GOOGLESHEETS_GET_RANGE', arguments: { range: 'Sheet1!A:Z' } },
    },
  });
  appendEvent({
    sessionId, turn: 3, role: 'tool', type: 'tool_returned', parentEventId: laterCall.id,
    data: {
      tool: 'composio_execute_tool', callId: 'stale-reused-read',
      canonicalCallId: 'stale-reused-read', effect: 'read', ok: true,
    },
  });
  assert.match((await settleAbsent('stale-reused-read')).content[0].text, /does not identify one exact successful lifecycle/i);

  appendExactToolLifecycle({
    sessionId,
    callId: 'ambiguous-read',
    output: absenceOutput,
  });
  writeToolOutput({
    sessionId,
    callId: 'ambiguous-read',
    tool: 'composio_execute_tool',
    invocationNonce: 'nonce-ambiguous-read-second',
    output: 'Row found: acct-authority',
  });
  assert.match((await settleAbsent('ambiguous-read')).content[0].text, /2 candidate invocation/i);

  assert.equal(
    listEvents(sessionId, { types: ['external_write_failed', 'external_write_succeeded'] }).length,
    0,
    'no presentation, failed, incomplete, stale, ambiguous, compute, legacy, or orphan row settles the write',
  );

  appendExactToolLifecycle({
    sessionId,
    callId: 'provider-read-exact',
    invocationNonce: 'nonce-provider-read-exact',
    output: absenceOutput,
  });
  const settled = await settleAbsent('provider-read-exact');
  assert.match(settled.content[0].text, /Reconciled authority-write as ABSENT/i);
  const settlement = listEvents(sessionId, { types: ['external_write_failed'] })[0];
  assert.equal(settlement?.data.evidenceInvocationNonce, 'nonce-provider-read-exact');
  assert.equal(settlement?.data.evidenceCallId, 'provider-read-exact');
});

test('execution_reconcile_write refuses a reused call id with multiple unsettled reservations', async () => {
  const sessionId = `sess-exec-reconcile-reused-${Math.random().toString(36).slice(2, 10)}`;
  createSession({ id: sessionId, kind: 'chat', title: 'reused call reconciliation' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the account row.' },
  });
  const execution = createTrackedExecution({ sessionId, sourceUserSeq: source.seq, status: 'active' } as never);
  for (const actionKey of ['sheet:append:first', 'sheet:append:second']) {
    appendEvent({
      sessionId, turn: 1, role: 'system', type: 'external_write',
      data: {
        sourceUserSeq: source.seq,
        callId: 'sdk-reused-call', canonicalCallId: 'sdk-reused-call',
        actionKey, shapeKey: 'GOOGLESHEETS_APPEND', targets: ['acct-reused'], preDispatch: true,
      },
    });
  }
  writeToolOutput({
    sessionId,
    callId: 'reused-read',
    invocationNonce: 'nonce-reused-read',
    tool: 'composio_execute_tool',
    output: 'Row found: acct-reused',
  });
  const reconcile = registeredToolHandlers().get('execution_reconcile_write')!;
  const ctx = { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(20) };
  const result = await withHarnessRunContext(ctx, () => reconcile({
    id: execution.id,
    call_id: 'sdk-reused-call',
    verdict: 'present',
    evidence_call_id: 'reused-read',
  }));
  assert.match(result.content[0].text, /multiple|2 unsettled|exact reservation/i);
  assert.equal(listEvents(sessionId, { types: ['external_write_succeeded'] }).length, 0);
});
