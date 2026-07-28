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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionRecord } from '../types.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-execution-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  pickFocusTarget,
  registerExecutionTools,
  _setExecutionToolCompletionJudgeForTests,
} = await import('./execution-tools.js');
const { ExecutionStore } = await import('../execution/store.js');
const {
  appendEvent,
  createSession,
  listEvents,
  resetEventLog,
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
  appendEvent({
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
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId,
      accounting: 'top_level',
      effect: 'read',
      ok: true,
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
