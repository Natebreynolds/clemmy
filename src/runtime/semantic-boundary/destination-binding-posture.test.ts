/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/destination-binding-posture.test.ts
 * The bound operation's posture wins over the request-derived one (2026-09-15).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryExactDestinationBinding } from './admit-and-compile-accepted-source.js';

const binding = {
  operationId: 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR',
  capabilityId: 'cap:resolved:outlook_update_calendar_event_in_calendar:definition:e94b',
  posture: 'named_existing',
} as unknown as Parameters<typeof carryExactDestinationBinding>[0]['binding'];

test("a request admitted as create_new adopts the bound update operation's named_existing posture instead of refusing", () => {
  const clamped = {
    destination: { posture: 'create_new', family: 'calendar', handleRequired: false },
    destinations: [{ posture: 'create_new', family: 'calendar', handleRequired: false }],
  } as unknown as Parameters<typeof carryExactDestinationBinding>[0]['clamped'];
  const carried = carryExactDestinationBinding({ clamped, binding });
  assert.equal(carried.ok, true, JSON.stringify(carried));
  if (carried.ok) {
    assert.equal(carried.clamped.destination?.posture, 'named_existing');
    assert.equal(carried.clamped.destinations?.[0]?.posture, 'named_existing');
    assert.deepEqual(carried.clamped.destination?.binding, binding);
  }
});

test('a matching posture is carried unchanged', () => {
  const clamped = {
    destination: { posture: 'named_existing', family: 'calendar', handleRequired: false },
    destinations: [{ posture: 'named_existing', family: 'calendar', handleRequired: false }],
  } as unknown as Parameters<typeof carryExactDestinationBinding>[0]['clamped'];
  const carried = carryExactDestinationBinding({ clamped, binding });
  assert.equal(carried.ok, true);
  if (carried.ok) assert.equal(carried.clamped.destination?.posture, 'named_existing');
});
