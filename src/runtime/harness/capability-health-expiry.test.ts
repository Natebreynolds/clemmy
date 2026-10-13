/**
 * Run: npx tsx --test src/runtime/harness/capability-health-expiry.test.ts
 *
 * A one-time harness observation must not ride into every later prompt as a
 * standing warning. Pins: a record with a retention boundary leaves every
 * read surface (list, read, prompt rendering, the file) once that boundary
 * passes; an open-ended record stays; a caller that has re-probed can retire
 * its own record explicitly.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-capability-health-expiry-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const health = await import('./capability-health.js');
const HEALTH_FILE = path.join(TMP_HOME, 'state', 'capability-health-expiry.json');

beforeEach(() => {
  health._setHarnessCapabilityHealthFileForTest(HEALTH_FILE);
  health._resetHarnessCapabilityHealthForTest();
});
after(() => {
  health._setHarnessCapabilityHealthFileForTest(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function fileIds(): string[] {
  if (!existsSync(HEALTH_FILE)) return [];
  const parsed = JSON.parse(readFileSync(HEALTH_FILE, 'utf-8')) as { capabilities?: Record<string, unknown> };
  return Object.keys(parsed.capabilities ?? {});
}

test('a record with a retention boundary leaves every read surface once it passes', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const rec = health.recordHarnessCapabilityHealth({
    id: 'probe_once', state: 'unavailable', summary: 'One-time refusal.', reason: 'home: probe', now, ttlMs: 60_000,
  });
  assert.equal(rec.expiresAt, '2026-01-01T10:01:00.000Z');

  const before = new Date('2026-01-01T10:00:59.000Z');
  assert.ok(health.readHarnessCapabilityHealth('probe_once', { now: before }));
  assert.ok(health.listHarnessCapabilityHealth({ now: before }).some((row) => row.id === 'probe_once'));
  assert.deepEqual(fileIds(), ['probe_once']);

  const after = new Date('2026-01-01T10:01:00.000Z');
  assert.equal(health.listHarnessCapabilityHealth({ now: after }).some((row) => row.id === 'probe_once'), false);
  assert.equal(health.readHarnessCapabilityHealth('probe_once', { now: after }), null);
  assert.deepEqual(fileIds(), [], 'the retired observation is gone from the durable store too');
  assert.equal(health.renderHarnessCapabilityHealthForContext(), '', 'nothing left to warn a prompt about');
});

test('an open-ended record stays until replaced or cleared, and a repeat without retention drops the boundary', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  const standing = health.recordHarnessCapabilityHealth({
    id: 'standing', state: 'degraded', summary: 'Standing observation.', now,
  });
  assert.equal(standing.expiresAt, undefined);
  const farLater = new Date('2027-01-01T00:00:00.000Z');
  assert.ok(health.readHarnessCapabilityHealth('standing', { now: farLater }));

  health.recordHarnessCapabilityHealth({ id: 'repeat', state: 'unavailable', summary: 'First.', now, ttlMs: 1_000 });
  const repeated = health.recordHarnessCapabilityHealth({ id: 'repeat', state: 'unavailable', summary: 'Second.', now });
  assert.equal(repeated.expiresAt, undefined);
  assert.equal(repeated.count, 2);
  assert.ok(health.readHarnessCapabilityHealth('repeat', { now: farLater }));

  assert.equal(health.clearHarnessCapabilityHealth('standing'), true);
  assert.equal(health.clearHarnessCapabilityHealth('standing'), false);
  assert.equal(health.readHarnessCapabilityHealth('standing', { now }), null);
  assert.deepEqual(fileIds(), ['repeat']);
});

test('a retention boundary survives a reload from the file', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  health.recordHarnessCapabilityHealth({ id: 'persisted', state: 'unavailable', summary: 'Persisted.', now, ttlMs: 5_000 });
  // Fresh in-memory state, same file: the boundary must come back with the record.
  health._setHarnessCapabilityHealthFileForTest(HEALTH_FILE);
  assert.equal(health.readHarnessCapabilityHealth('persisted', { now })?.expiresAt, '2026-01-01T10:00:05.000Z');
  assert.equal(health.readHarnessCapabilityHealth('persisted', { now: new Date('2026-01-01T10:00:06.000Z') }), null);
});
