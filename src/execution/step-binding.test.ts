/**
 * Run: npx tsx --test src/execution/step-binding.test.ts
 *
 * The typed-contract binder: resolution precedence, missing-required
 * detection, `from` path expressions, and parity with renderTemplate's
 * lookup semantics. Pure — no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindStepInputs, resolveFrom } from './step-binding.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

const step = (inputs: WorkflowStepInput['inputs'], dependsOn?: string[]): WorkflowStepInput =>
  ({ id: 's', prompt: 'p', inputs, dependsOn });

test('no declared inputs → empty binding, no missing (today\'s path)', () => {
  const r = bindStepInputs({ id: 's', prompt: 'p' }, { url: 'x' }, {});
  assert.deepEqual(r, { values: {}, upstream: {}, missing: [] });
});

test('conventional resolution: input by its own name', () => {
  const r = bindStepInputs(step({ url: { type: 'string' } }), { url: 'https://x.com' }, {});
  assert.equal(r.values.url, 'https://x.com');
  assert.deepEqual(r.missing, []);
});

test('missing required input is reported (the bleeding-stop signal)', () => {
  const r = bindStepInputs(step({ url: { required: true } }), {}, {});
  assert.deepEqual(r.missing, ['url']);
  assert.equal('url' in r.values, false);
});

test('default satisfies a missing input (not required)', () => {
  const r = bindStepInputs(step({ limit: { default: 10 } }), {}, {});
  assert.equal(r.values.limit, 10);
  assert.deepEqual(r.missing, []);
});

test('from: input.<key>', () => {
  const r = bindStepInputs(step({ site: { from: 'input.url' } }), { url: 'https://x.com' }, {});
  assert.equal(r.values.site, 'https://x.com');
});

test('from: steps.<id>.output and nested path', () => {
  const outputs = { fetch: { accounts: [{ id: 'A1' }], total: 1 } };
  assert.deepEqual(
    bindStepInputs(step({ data: { from: 'steps.fetch.output' } }, ['fetch']), {}, outputs).values.data,
    { accounts: [{ id: 'A1' }], total: 1 },
  );
  assert.equal(
    bindStepInputs(step({ n: { from: 'steps.fetch.output.total' } }, ['fetch']), {}, outputs).values.n,
    1,
  );
});

test('conventional resolution: name matching a dependsOn step output', () => {
  const r = bindStepInputs(step({ fetch: {} }, ['fetch']), {}, { fetch: { ok: true } });
  assert.deepEqual(r.values.fetch, { ok: true });
});

test('upstream always carries dependsOn outputs for the context block', () => {
  const r = bindStepInputs(step({ x: { default: 1 } }, ['a', 'b']), {}, { a: 1, b: 2, c: 3 });
  assert.deepEqual(r.upstream, { a: 1, b: 2 }); // c is not a dep
});

test('resolveFrom: item + item.path', () => {
  assert.equal(resolveFrom('item', {}, {}, 'hello'), 'hello');
  assert.equal(resolveFrom('item.id', {}, {}, { id: 'A1' }), 'A1');
});

test('resolveFrom mirrors renderTemplate: empty-string run input is treated as absent', () => {
  // renderTemplate renders `inputs[key] ?? ''`; the binder treats '' as
  // unresolved so a blank input fast-fails instead of binding empty.
  const r = bindStepInputs(step({ url: { required: true } }), { url: '' }, {});
  assert.deepEqual(r.missing, ['url']);
});
