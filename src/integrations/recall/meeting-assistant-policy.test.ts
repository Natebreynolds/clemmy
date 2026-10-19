import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-policy-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
const { createMeetingAssistantPolicyStore, MeetingAssistantPolicyError, MeetingModelPinSchema } = await import('./meeting-assistant-policy.js');
test.after(() => rmSync(home, { recursive: true, force: true }));
let index = 0;
function fixture() {
  let connected = true;
  const filename = path.join(home, `policy-${++index}.json`);
  const store = createMeetingAssistantPolicyStore(filename, {
    choices: () => connected ? [{ id: 'controlled-model', label: 'Controlled model', providerLabel: 'Controlled provider', available: true }] : [],
    resolve: role => ({ modelId: `controlled-${role}`, provider: 'codex' }),
    validate: (_role, id) => id === 'controlled-model' && connected ? { ok: true, provider: 'codex' } : { ok: false, reason: 'unavailable' },
    live: () => connected,
    label: id => id,
  });
  return { filename, store, disconnect: () => { connected = false; } };
}
const update = (expectedRevision = 0) => ({ expectedRevision, before: { calendarPrepSuggestions: true },
  during: { modelId: 'controlled-model' }, after: { modelId: null } });
function code(expected: string) {
  return (error: unknown) => error instanceof MeetingAssistantPolicyError && error.code === expected;
}
test('new policy suggests nothing and inherits Quick during and brain after without mutating global roles', () => {
  const f = fixture(); const environment = { ...process.env };
  const policy = f.store.read();
  assert.equal(policy.revision, 0); assert.equal(policy.before.calendarPrepSuggestions, false);
  const quick = f.store.resolve('controlled-meeting', 'live');
  const brain = f.store.resolve('controlled-meeting', 'after');
  assert.deepEqual([quick.role, quick.modelId, quick.selection, quick.fallback], ['quick', 'controlled-quick', 'inherited', 'none']);
  assert.deepEqual([brain.role, brain.modelId], ['brain', 'controlled-brain']);
  assert.equal(Object.isFrozen(quick), true);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(environment), 'meeting policy does not change process settings');
});
test('revision comparison prevents stale updates and persisted model pins survive store restart', () => {
  const f = fixture(); const next = f.store.write(update());
  assert.equal(next.revision, 1);
  const pin = f.store.resolve('controlled-meeting', 'live');
  assert.equal(pin.modelId, 'controlled-model'); assert.equal(pin.profileRevision, 1);
  const retained = readFileSync(f.filename, 'utf8');
  assert.throws(() => f.store.write(update()), code('conflict'));
  assert.equal(readFileSync(f.filename, 'utf8'), retained);
  const cold = createMeetingAssistantPolicyStore(f.filename);
  assert.deepEqual(cold.read(), next);
  f.store.write({ ...update(1), during: { modelId: null } });
  assert.equal(f.store.resolve('controlled-meeting', 'live').modelId, 'controlled-quick');
  assert.equal(pin.modelId, 'controlled-model', 'a running job retains its exact original selection');
});
test('disconnected saved selection stays visible but never silently moves to a fallback', () => {
  const f = fixture(); f.store.write(update()); f.disconnect();
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.modelOptions.live[0]?.available, false);
  assert.equal(snapshot.modelOptions.live[0]?.id, 'controlled-model');
  assert.equal(snapshot.defaults.live.available, false);
  assert.throws(() => f.store.resolve('controlled-meeting', 'live'), code('model_unavailable'));
  assert.doesNotThrow(() => f.store.write({ ...update(1), before: { calendarPrepSuggestions: false } }));
});
test('malformed, oversized and unreadable saved choices cannot turn into writable defaults', () => {
  const f = fixture(); writeFileSync(f.filename, '{damaged');
  assert.throws(() => f.store.read(), code('unavailable'));
  assert.throws(() => f.store.write(update()), code('unavailable'));
  assert.equal(readFileSync(f.filename, 'utf8'), '{damaged');
  writeFileSync(f.filename, ' '.repeat(32_769));
  assert.throws(() => f.store.read(), code('unavailable'));
  assert.throws(() => f.store.write({ ...update(), permission: 'all' }), code('invalid'));
});
test('new unknown model is refused before saving and pin shape excludes undeclared fallback', () => {
  const f = fixture();
  assert.throws(() => f.store.write({ ...update(), during: { modelId: 'unknown' } }), code('model_unavailable'));
  assert.equal(f.store.read().revision, 0);
  assert.throws(() => f.store.resolve('', 'live'), code('invalid'));
  assert.equal(MeetingModelPinSchema.safeParse({ ...f.store.resolve('meeting', 'live'), fallback: 'brain' }).success, false);
});
