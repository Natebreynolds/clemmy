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

test('an active-turn beat speaks on change, not on the clock', async () => {
  const { activeTurnBeatSpeaks } = await import('./loop.js');
  const quietEvery = 6;
  // The first beat always speaks: a person needs to know the turn is alive.
  assert.equal(activeTurnBeatSpeaks({ changed: false, first: true, unchangedTicks: 0, quietEvery }), true);
  // Any real change speaks.
  assert.equal(activeTurnBeatSpeaks({ changed: true, first: false, unchangedTicks: 3, quietEvery }), true);
  // While nothing moves it stays quiet — a live 21-minute fan-out emitted 64
  // near-identical beats, which is wallpaper, not visibility (owner 2026-09-10).
  for (const unchangedTicks of [1, 2, 3, 4, 5, 7, 8]) {
    assert.equal(activeTurnBeatSpeaks({ changed: false, first: false, unchangedTicks, quietEvery }), false, `tick ${unchangedTicks}`);
  }
  // But a stalled run is still distinguishable from a dead one, rarely.
  assert.equal(activeTurnBeatSpeaks({ changed: false, first: false, unchangedTicks: 6, quietEvery }), true);
  assert.equal(activeTurnBeatSpeaks({ changed: false, first: false, unchangedTicks: 12, quietEvery }), true);
  // Over the same 63 unchanged ticks: 10 beats instead of 63.
  const spoke = Array.from({ length: 63 }, (_, i) => i + 1)
    .filter((unchangedTicks) => activeTurnBeatSpeaks({ changed: false, first: false, unchangedTicks, quietEvery }));
  assert.equal(spoke.length, 10, JSON.stringify(spoke));
});


test('heartbeats retain the host pending-request fact across their own events and clear it after the request', async () => {
  const { withActiveTurnHeartbeat } = await import('./loop.js');
  const events = await import('./eventlog.js');
  const { getHarnessBudgetSettings } = await import('./budget-settings.js');
  const session = events.createSession({ id: 'heartbeat-request-owner', kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan a comparison.' } });
  let pending = true;
  const beats = () => events.listEvents(session.id).filter(e => e.type === 'heartbeat');
  await withActiveTurnHeartbeat({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    budget: getHarnessBudgetSettings(), checkInMs: 5, stage: 'turn', modelRequestInFlight: () => pending,
  }, async () => {
    const deadline = Date.now() + 2000;
    while (beats().length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(beats().length >= 2, 'both the first and subsequent heartbeat are observed');
    assert.ok(beats().every(e => e.data.composing === true));
    assert.match(String(beats().at(-1)?.data.message), /waiting for the model response/);
    pending = false;
    const before = beats().length;
    while (beats().length === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(beats().length > before);
    assert.equal(beats().at(-1)?.data.composing, undefined, 'a finished model request cannot remain pending');
  });
});
