import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightlyAdmission } from './nightly-admission.js';
test('catch-up waits through startup and admits one heavy job per tick', () => {
  const gate = new NightlyAdmission(0, 60_000);
  gate.begin(1, 10_000); assert.equal(gate.claim('backup', 10_000), false);
  gate.begin(2, 60_000); assert.equal(gate.claim('backup', 60_000), true);
  gate.begin(2, 60_001); assert.equal(gate.claim('links', 60_001), false);
  gate.begin(3, 75_000); assert.equal(gate.claim('backup', 75_000), false);
  assert.equal(gate.claim('links', 75_000), true);
});
test('wake catch-up gets a settling period without losing pending jobs', () => {
  const gate = new NightlyAdmission(0, 60_000);
  gate.begin(1, 60_000); assert.equal(gate.claim('backup', 60_000), true);
  gate.begin(2, 200_000); assert.equal(gate.claim('links', 200_000), false);
  gate.begin(3, 260_000); assert.equal(gate.claim('links', 260_000), true);
  gate.begin(4, 320_000); gate.begin(5, 380_000);
  assert.equal(gate.claim('backup', 380_000), true);
});
