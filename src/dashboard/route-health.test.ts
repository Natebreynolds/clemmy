/**
 * Run: npx tsx --test src/dashboard/route-health.test.ts
 *
 * Track 3/B5 instrumentation: readRouteHealth() summarizes turn_model_routed
 * events by routeKind × surface over a window. Legacy-lane retirement is gated
 * on a sustained legacyTotal of 0 here — this test pins the counting and the
 * readiness detail line.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-route-health';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetEventLog, createSession, appendEvent } = await import('../runtime/harness/eventlog.js');
const { readRouteHealth } = await import('./diagnostics.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  resetEventLog();
});

test('readRouteHealth counts routeKind × surface and reports legacy-lane readiness', () => {
  const sess = createSession({ kind: 'chat' }).id;
  for (let i = 0; i < 3; i++) {
    appendEvent({ sessionId: sess, turn: i, role: 'system', type: 'turn_model_routed', data: { model: 'gpt-5.5', routeKind: 'harness', surface: 'home' } });
  }
  appendEvent({ sessionId: sess, turn: 4, role: 'system', type: 'turn_model_routed', data: { model: 'claude-opus-4-8', routeKind: 'claude_agent_sdk_brain', surface: 'discord' } });

  const zero = readRouteHealth(7);
  assert.equal(zero.legacyTotal, 0);
  assert.match(zero.detail, /0 legacy-routed turns of 4/);
  assert.deepEqual(
    zero.counts.find((c) => c.routeKind === 'harness'),
    { routeKind: 'harness', surface: 'home', count: 3 },
  );

  // One legacy turn flips readiness and names the surface.
  appendEvent({ sessionId: sess, turn: 5, role: 'system', type: 'turn_model_routed', data: { model: 'gpt-5.5', routeKind: 'legacy', surface: 'cron' } });
  const withLegacy = readRouteHealth(7);
  assert.equal(withLegacy.legacyTotal, 1);
  assert.match(withLegacy.detail, /1 legacy-routed turn\(s\) of 5 .* on: cron/);
});
