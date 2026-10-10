import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRetainedJson } from './retained-json-selection.js';

function selected(value: unknown, pointer: string): unknown {
  const result = selectRetainedJson(value, pointer);
  assert.equal(result.status, 'ok', `expected an exact selection at ${JSON.stringify(pointer)}`);
  if (result.status !== 'ok') throw new Error(result.reason);
  return result.value;
}

function rejected(value: unknown, pointer: string) {
  const result = selectRetainedJson(value, pointer);
  assert.equal(result.status, 'error', `expected a refusal at ${JSON.stringify(pointer)}`);
  if (result.status !== 'error') throw new Error('selection unexpectedly succeeded');
  assert.ok(result.reason.length > 0, 'a refusal explains what could not be selected');
  assert.equal(typeof result.atPath, 'string');
  return result;
}

test('an empty pointer selects the exact retained root, including falsy JSON values', () => {
  const values = [{ result: { count: 0 } }, [false, null], false, null, 0, ''];
  for (const value of values) assert.equal(selected(value, ''), value);
});

test('a pointer reaches a late nested array item without selecting a prefix or changing the source', () => {
  const value = { result: { entries: Array.from({ length: 512 }, (_, index) => ({
    id: `entry-${index}`, measurements: { value: index, accepted: index === 511 },
  })) } };
  const before = JSON.stringify(value);

  assert.equal(selected(value, '/result/entries/511'), value.result.entries[511]);
  assert.equal(selected(value, '/result/entries/511/measurements/accepted'), true);
  assert.equal(selected(value, '/result/entries/0/measurements/value'), 0);
  assert.equal(JSON.stringify(value), before, 'selection preserves the full retained result');
});

test('empty, whitespace and Unicode object keys are exact data rather than normalized aliases', () => {
  const value = {
    '': { '': 'empty child' },
    ' label ': { '値': '日本語', ' e\u0301 ': 'decomposed' },
    label: 'different value',
    'é': 'composed',
  };

  assert.equal(selected(value, '//'), 'empty child');
  assert.equal(selected(value, '/ label /値'), '日本語');
  assert.equal(selected(value, '/ label / e\u0301 '), 'decomposed');
  assert.equal(selected(value, '/label'), 'different value');
  rejected(value, '/ label');
  rejected(value, '/e\u0301');
});

test('JSON Pointer escapes decode exactly once and retain punctuation literally', () => {
  const value = {
    'a/b': { 'm~n': { '~1': 'single-pass escape', '~0': 'literal tilde-zero' } },
    'field.name': { '*': 'literal asterisk' },
  };

  assert.equal(selected(value, '/a~1b/m~0n/~01'), 'single-pass escape');
  assert.equal(selected(value, '/a~1b/m~0n/~00'), 'literal tilde-zero');
  assert.equal(selected(value, '/field.name/*'), 'literal asterisk');
  rejected(value, '/field/name');
  rejected({ values: [1, 2] }, '/values/*');
});

test('absent children retain the last resolved pointer and its real parent for a precise correction', () => {
  const value = { result: { rows: [{ id: 'first' }] } };
  const missingProperty = rejected(value, '/result/not_present/child');
  assert.equal(missingProperty.atPath, '/result');
  assert.equal(missingProperty.parent, value.result);

  const missingIndex = rejected(value, '/result/rows/9/id');
  assert.equal(missingIndex.atPath, '/result/rows');
  assert.equal(missingIndex.parent, value.result.rows);
  assert.equal(selected(value, '/result/rows/0/id'), 'first');
});

test('null and scalar traversal refuses instead of treating the child as empty or missing data', () => {
  for (const value of [null, false, 0, '', 'text']) {
    const result = rejected({ value }, '/value/child');
    assert.equal(result.atPath, '/value');
    assert.equal(result.parent, value);
  }
  assert.equal(selected({ value: false }, '/value'), false);
  assert.equal(selected({ value: null }, '/value'), null);
});

test('array indexes are canonical, in bounds and safe integers', () => {
  const values = Array.from({ length: 12 }, (_, index) => index * 10);
  assert.equal(selected(values, '/0'), 0);
  assert.equal(selected(values, '/10'), 100);

  for (const pointer of ['/01', '/00', '/-1', '/+1', '/1.0', '/1e0', '/-', '/ 1', '/12', '/9007199254740993']) {
    rejected(values, pointer);
  }
  rejected(values, '/length');
});

test('numeric-looking object keys remain literal keys rather than array index rules', () => {
  const value = { '01': 'leading zero', '-': 'dash', '1.0': 'decimal key', '0': 'zero' };
  assert.equal(selected(value, '/01'), 'leading zero');
  assert.equal(selected(value, '/-'), 'dash');
  assert.equal(selected(value, '/1.0'), 'decimal key');
  assert.equal(selected(value, '/0'), 'zero');
});

test('traversal never leaks inherited properties or fills sparse array holes from a prototype', () => {
  const prototype = { inherited: { secret: 'unrelated parent data' } };
  const value = Object.create(prototype) as { own: string };
  value.own = 'retained';
  assert.equal(selected(value, '/own'), 'retained');
  rejected(value, '/inherited/secret');
  rejected({}, '/toString');

  const sparse = new Array(2);
  sparse[1] = 'real item';
  Object.setPrototypeOf(sparse, { 0: 'inherited item' });
  rejected(sparse, '/0');
  assert.equal(selected(sparse, '/1'), 'real item');
});

test('own JSON keys named __proto__ and constructor are read safely without altering prototypes', () => {
  const value = JSON.parse('{"__proto__":{"selected":"own data"},"constructor":{"prototype":{"selected":"also own data"}}}') as Record<string, unknown>;
  const before = JSON.stringify(value);
  const prototypeBefore = Object.getPrototypeOf(value);

  assert.equal(selected(value, '/__proto__/selected'), 'own data');
  assert.equal(selected(value, '/constructor/prototype/selected'), 'also own data');
  assert.equal(Object.getPrototypeOf(value), prototypeBefore);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(({} as Record<string, unknown>).selected, undefined);
  assert.equal(JSON.stringify(value), before);
  rejected({}, '/__proto__/selected');
  rejected({}, '/constructor/prototype');
});

test('malformed pointers and tilde escapes refuse instead of guessing another path syntax', () => {
  const value = { field: 'retained', '%66ield': 'literal percent encoding' };
  for (const pointer of ['field', '.field', '#/field', ' /field', '/field~', '/field~2', '/field~x']) {
    rejected(value, pointer);
  }
  assert.equal(selected(value, '/%66ield'), 'literal percent encoding');

  const invalidLaterStep = rejected({ field: { value: 'retained' } }, '/field/missing/~2');
  assert.equal(invalidLaterStep.atPath, '', 'invalid syntax is identified before any traversal');
  assert.equal(invalidLaterStep.parent, undefined);
  const missingEscapedChild = rejected({ 'a/b': { value: 'retained' } }, '/a~1b/missing');
  assert.equal(missingEscapedChild.atPath, '/a~1b', 'the repair prefix retains valid pointer escaping');
});

test('exact selection respects the depth and pointer-length limits at their boundaries', () => {
  const nested = (depth: number): unknown => {
    let value: unknown = 'leaf';
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };
  assert.equal(selected(nested(64), '/child'.repeat(64)), 'leaf');
  rejected(nested(65), '/child'.repeat(65));

  const allowedKey = 'x'.repeat(2047);
  const refusedKey = 'x'.repeat(2048);
  assert.equal(selected({ [allowedKey]: 'exact boundary' }, `/${allowedKey}`), 'exact boundary');
  rejected({ [refusedKey]: 'over boundary' }, `/${refusedKey}`);
});
