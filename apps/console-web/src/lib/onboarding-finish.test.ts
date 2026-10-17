import test from 'node:test';
import assert from 'node:assert/strict';
import { finishOnboarding } from './onboarding-finish.js';
import type { SettingsSnapshot } from './settings.js';

function ready(): SettingsSnapshot {
  return { modelRoles: { effectiveBrain: 'api_key', effectiveBrainValue: 'api_key:fixture-model',
    roles: { brain: { modelId: 'fixture-model' } },
    brainOptions: [{ id: 'api_key', value: 'api_key:fixture-model', modelId: 'fixture-model', label: 'Fixture model', available: true }],
  } } as SettingsSnapshot;
}

test('finish uses freshly read exact selection before the native marker, without selecting a model', async () => {
  const order: string[] = [];
  const snapshot = ready();
  const before = structuredClone(snapshot);
  await finishOnboarding(false, { isDesktop: true, readSettings: async () => { order.push('read'); return snapshot; },
    complete: async (payload) => { assert.deepEqual(payload, {}); order.push('marker'); return { ok: true }; } });
  assert.deepEqual(order, ['read', 'marker']);
  assert.deepEqual(snapshot, before);
});

test('disconnected or contradictory current selection refuses marker and keeps retry possible', async () => {
  let markers = 0;
  const snapshot = ready();
  snapshot.modelRoles!.brainOptions![0].available = false;
  const ports = { isDesktop: true, readSettings: async () => snapshot,
    complete: async () => { markers++; return { ok: true as const }; } };
  await assert.rejects(finishOnboarding(false, ports), /Choose a connected main model/);
  assert.equal(markers, 0);
  snapshot.modelRoles!.brainOptions![0].available = true;
  await finishOnboarding(false, ports);
  assert.equal(markers, 1);
});

test('unreadable settings cannot become a model-backed finish', async () => {
  let markers = 0;
  await assert.rejects(finishOnboarding(false, { isDesktop: true,
    readSettings: async () => { throw new Error('local service unavailable'); },
    complete: async () => { markers++; return { ok: true }; } }), /local service unavailable/);
  assert.equal(markers, 0);
});

test('explicit exploration requires no model availability or credential probe', async () => {
  let payload: unknown;
  await finishOnboarding(true, { isDesktop: true,
    readSettings: async () => { throw new Error('must not probe'); },
    complete: async (input) => { payload = input; return { ok: true }; } });
  assert.deepEqual(payload, { exploreWithoutModel: true });
});

test('old shell cannot pretend setup was retained while plain browser has no native marker', async () => {
  let reads = 0;
  const readSettings = async () => { reads++; return ready(); };
  await assert.rejects(finishOnboarding(true, { isDesktop: true, readSettings }), /app update/);
  assert.equal(reads, 0);
  await finishOnboarding(false, { isDesktop: false, readSettings });
  assert.equal(reads, 1);
});

test('missing or rejected native acknowledgment cannot become successful completion', async () => {
  await assert.rejects(finishOnboarding(false, { isDesktop: true, readSettings: async () => ready(),
    complete: async () => { throw new Error('marker write failed'); } }), /marker write failed/);
  await assert.rejects(finishOnboarding(false, { isDesktop: true, readSettings: async () => ready(),
    complete: async () => ({ ok: false } as unknown as { ok: true }) }), /Setup did not finish/);
});
