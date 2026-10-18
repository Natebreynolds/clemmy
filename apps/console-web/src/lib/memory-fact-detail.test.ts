import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFactDetail, type Fact } from './memory.js';
import {
  assertExactFactAction, assertMemoryChange, correctedFactId, exactFactPayload,
  exactFactState, expectedMemorySnapshot, memoryDetailReadError,
} from './memory-fact-detail.js';

const fact = (patch: Partial<Fact> = {}): Fact => ({ id: 17, kind: 'feedback', content: 'Use a local reader.', active: true,
  pinned: false, updatedAt: '2026-10-18T12:00:00Z', supersededByFactId: null,
  scope: { kind: 'project', projectId: 'sample-project', projectName: 'Sample project', agentId: null, agentName: null },
  evidence: [{ episodeId: 'source-1', excerpt: 'I prefer the local reader.' }], ...patch });

test('the detail read requests one exact retained fact with cancellation and no list fallback', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await getFactDetail('17', controller.signal, async (path, options) => {
    calls.push(path); assert.equal(options?.signal, controller.signal); return { fact: fact() };
  });
  assert.equal(result.id, 17);
  assert.deepEqual(calls, ['/api/console/memory/facts/17/detail']);
  let sent = false;
  for (const id of ['17abc', '017', ' 17', '', 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(getFactDetail(id, undefined, async () => { sent = true; return { fact: fact() }; }), /exact memory link/);
  }
  assert.equal(sent, false);
});

test('an identity mismatch, negative acknowledgement or malformed success cannot substitute another memory', () => {
  for (const value of [null, {}, { ok: false, fact: fact() }, { fact: fact({ id: 18 }) },
    { fact: fact({ content: null as unknown as string }) }, { fact: fact({ evidence: [null] as unknown as Fact['evidence'] }) },
    { fact: fact({ active: undefined }) }, { fact: fact({ pinned: undefined }) }, { fact: fact({ updatedAt: undefined }) },
    { fact: fact({ supersededByFactId: undefined }) },
    { fact: fact({ scope: { kind: 'project', projectName: 4 } as unknown as Fact['scope'] }) },
  ]) assert.throws(() => exactFactPayload(value, 17), /could not be read/);
  assert.equal(exactFactPayload({ fact: fact({ active: false, supersededByFactId: 23 }) }, 17).supersededByFactId, 23);
});

test('a superseded historical record is always read-only, even if inconsistent data says active', () => {
  for (const active of [true, false]) {
    const old = fact({ active, supersededByFactId: 23 });
    const state = exactFactState(old);
    assert.equal(state.successorId, 23);
    assert.equal(state.editable, false);
    assert.equal(state.restorable, false);
    for (const action of ['correct', 'forget', 'restore'] as const) assert.throws(() => assertExactFactAction(old, action), /memory changed/);
  }
});

test('inactive does not mean owner-forgotten and an unknown status never enables a mutation', () => {
  const inactive = fact({ active: false });
  const state = exactFactState(inactive);
  assert.equal(state.label, 'Inactive');
  assert.match(state.description, /do not say who or what/);
  assert.equal(state.restorable, true);
  assert.doesNotThrow(() => assertExactFactAction(inactive, 'restore'));
  assert.throws(() => assertExactFactAction(inactive, 'correct'));
  const unknown = fact({ active: undefined });
  assert.equal(exactFactState(unknown).label, 'Status not recorded');
  for (const action of ['correct', 'forget', 'restore'] as const) assert.throws(() => assertExactFactAction(unknown, action));
});

test('guarded writes carry the full displayed snapshot rather than silently accepting later changes', () => {
  const shown = fact({ pinned: true });
  const snapshot = expectedMemorySnapshot(shown);
  assert.deepEqual(snapshot, { updatedAt: shown.updatedAt, content: shown.content, active: true, supersededByFactId: null, pinned: true });
  shown.content = 'A concurrent correction.';
  shown.updatedAt = '2026-10-18T12:01:00Z';
  assert.equal(snapshot.content, 'Use a local reader.');
  assert.equal(snapshot.updatedAt, '2026-10-18T12:00:00Z');
  for (const incomplete of [{ updatedAt: undefined }, { active: undefined }, { pinned: undefined }, { supersededByFactId: undefined }]) {
    assert.throws(() => expectedMemorySnapshot(fact(incomplete)), /Current memory details/);
  }
});

test('a correction follows the returned successor, including normalized no-op identity', () => {
  assert.equal(correctedFactId({ ok: true, fact: fact({ id: 23 }), supersededFactId: 17 }), 23);
  assert.equal(correctedFactId({ ok: true, fact: fact(), supersededFactId: 17 }), 17);
  for (const value of [{ ok: false, fact: fact({ id: 23 }) }, { ok: true }, { ok: true, fact: { id: '23wrong' } }]) assert.throws(() => correctedFactId(value));
  for (const value of [null, {}, { ok: false }, { ok: 'true' }]) assert.throws(() => assertMemoryChange(value), /not confirmed/);
});

test('missing memory, expired authentication and an unreadable service stay distinct', () => {
  assert.equal(memoryDetailReadError({ status: 404 }), 'missing');
  assert.equal(memoryDetailReadError({ status: 401 }), 'unauthenticated');
  assert.equal(memoryDetailReadError({ status: 500, message: 'private internal details' }), 'unavailable');
  assert.equal(memoryDetailReadError(new Error('network failed')), 'unavailable');
});
