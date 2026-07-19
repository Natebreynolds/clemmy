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
const EXECUTIONS_FILE = path.join(TMP_HOME, 'state', 'executions.json');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test.beforeEach(() => {
  mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
  writeFileSync(EXECUTIONS_FILE, '[]', 'utf-8');
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
