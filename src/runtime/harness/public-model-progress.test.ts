import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventRow } from './eventlog.js';
import { projectHarnessEventForPublic } from './public-presentation.js';

function routeEvent(data: Record<string, unknown>): EventRow {
  return {
    seq: 1,
    id: 'route-event',
    sessionId: 'public-model-progress-test',
    turn: 1,
    role: 'system',
    type: 'turn_model_routed',
    parentEventId: 'private-parent',
    data,
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

test('public model route exposes only bounded identity and safe transition bits', () => {
  const projected = projectHarnessEventForPublic(routeEvent({
    model: 'gpt-5.6-sol',
    provider: 'codex',
    fallover: true,
    preselected: false,
    reason: 'first-content-timeout private diagnostic',
    fromModel: 'grok-4.6',
    transport: 'host_harness',
    attemptId: 'private-attempt',
    apiKey: 'super-secret',
  }));
  assert.deepEqual(projected?.data, {
    phase: 'model',
    model: 'gpt-5.6-sol',
    provider: 'codex',
    fallover: true,
    preselected: false,
  });
  assert.equal(projected?.parentEventId, null);
  assert.doesNotMatch(JSON.stringify(projected), /timeout|grok|transport|attempt|secret/i);
});

test('public model route fails closed on unbounded identity while retaining a valid provider', () => {
  const providerOnly = projectHarnessEventForPublic(routeEvent({
    model: 'not safe/model',
    provider: 'claude',
    reason: 'private',
  }));
  assert.deepEqual(providerOnly?.data, {
    phase: 'model',
    provider: 'claude',
    fallover: false,
    preselected: false,
  });

  assert.equal(projectHarnessEventForPublic(routeEvent({
    model: 'x'.repeat(97),
    provider: 'also not safe',
  })), null);
});

test('active-turn heartbeat remains a kind-only public liveness signal', () => {
  const heartbeat = routeEvent({
    kind: 'active_turn_check_in',
    message: 'private worker detail',
    reason: 'private loop state',
  });
  heartbeat.type = 'heartbeat';
  const projected = projectHarnessEventForPublic(heartbeat);
  assert.deepEqual(projected?.data, { kind: 'active_turn_check_in' });
});
