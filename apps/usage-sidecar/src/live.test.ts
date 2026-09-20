import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clementineRootSessionId } from './parse-clementine.js';
import { buildLiveSnapshot, keepLiveCall } from './live.js';
import type { CanonicalCall } from './types.js';

function call(partial: Partial<CanonicalCall> & Pick<CanonicalCall, 'id' | 'source' | 'sessionId'>): CanonicalCall {
  return {
    at: '2026-09-18T12:00:00.000Z',
    lane: partial.source === 'clementine' ? 'clementine' : 'native',
    rootSessionId: partial.sessionId,
    model: 'gpt-5.6-terra',
    inputTokens: 10,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
    promptTokens: 10,
    uncachedWorkTokens: 12,
    hitRate: 0,
    certified: true,
    ...partial,
  };
}

test('warmup is dropped; chat and workflow tasks are kept', () => {
  assert.equal(keepLiveCall(call({ id: 'w', source: 'clementine', sessionId: 'warmup-1', kind: 'warmup' })), false);
  assert.equal(keepLiveCall(call({ id: 'c', source: 'clementine', sessionId: 'sess-1', kind: 'chat' })), true);
  assert.equal(keepLiveCall(call({ id: 'f', source: 'clementine', sessionId: 'workflow:1', kind: 'workflow' })), true);
});

test('subagent calls stay on the parent task and split by model', () => {
  const now = Date.parse('2026-09-18T12:01:00.000Z');
  const snap = buildLiveSnapshot([
    call({
      id: 'parent', source: 'claude-code', sessionId: 'sess-parent', rootSessionId: 'sess-parent',
      model: 'claude-sonnet-5', uncachedWorkTokens: 200, at: '2026-09-18T12:00:50.000Z',
    }),
    call({
      id: 'kid', source: 'claude-code', sessionId: 'agent-1', rootSessionId: 'sess-parent',
      model: 'claude-haiku-4-5', isSubagent: true, agentId: 'a1',
      uncachedWorkTokens: 50, at: '2026-09-18T12:00:55.000Z',
    }),
  ], '2026-09-18T12:00:00.000Z', now);
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].id, 'sess-parent');
  assert.equal(snap.tasks[0].totals.uncachedWork, 250);
  assert.equal(snap.tasks[0].totals.subagentCalls, 1);
  assert.equal(snap.tasks[0].subagents, 1);
  assert.deepEqual(snap.tasks[0].totals.byModel.map((m) => m.model), ['claude-sonnet-5', 'claude-haiku-4-5']);
  assert.equal(snap.sources['claude-code'].byModel.length, 2);
});

test('Clementine workflow steps share one run task', () => {
  assert.equal(clementineRootSessionId('workflow:trigger-abc:wrap_up', 'trigger-abc'), 'run:trigger-abc');
  const now = Date.parse('2026-09-18T12:01:00.000Z');
  const snap = buildLiveSnapshot([
    call({
      id: 's1', source: 'clementine', sessionId: 'workflow:trigger-abc:wrap_up',
      rootSessionId: 'run:trigger-abc', model: 'gpt-5.6-luna', kind: 'workflow',
      uncachedWorkTokens: 100, at: '2026-09-18T12:00:50.000Z',
    }),
    call({
      id: 's2', source: 'clementine', sessionId: 'workflow:trigger-abc:search',
      rootSessionId: 'run:trigger-abc', model: 'gpt-5.6-sol', kind: 'workflow',
      uncachedWorkTokens: 40, at: '2026-09-18T12:00:55.000Z',
    }),
  ], '2026-09-18T12:00:00.000Z', now);
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].totals.uncachedWork, 140);
  assert.equal(snap.tasks[0].totals.byModel.length, 2);
});

test('live snapshot groups by source and task, marks recent as live', () => {
  const now = Date.parse('2026-09-18T12:01:00.000Z');
  const snap = buildLiveSnapshot([
    call({ id: 'a', source: 'clementine', sessionId: 'sess-1', kind: 'chat', brain: 'codex', uncachedWorkTokens: 100, at: '2026-09-18T12:00:50.000Z' }),
    call({ id: 'b', source: 'codex', sessionId: 'thread-1', uncachedWorkTokens: 40, at: '2026-09-18T12:00:55.000Z' }),
    call({ id: 'c', source: 'claude-code', sessionId: 'old', uncachedWorkTokens: 10, at: '2026-09-18T11:00:00.000Z' }),
  ], '2026-09-18T12:00:00.000Z', now);
  assert.equal(snap.sources.clementine.uncachedWork, 100);
  assert.equal(snap.sources.codex.uncachedWork, 40);
  assert.equal(snap.sources['claude-code'].uncachedWork, 10);
  const live = snap.tasks.filter((t) => t.live);
  assert.equal(live.length, 2);
  assert.ok(live.some((t) => t.source === 'clementine' && t.id === 'sess-1'));
  assert.ok(snap.tasks.find((t) => t.id === 'old')?.live === false);
});
