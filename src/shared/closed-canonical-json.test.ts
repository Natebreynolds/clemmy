import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClosedCanonicalJsonError,
  closedCanonicalJson,
} from './closed-canonical-json.js';

test('closed canonical JSON is key-order stable over plain JSON only', () => {
  const left = closedCanonicalJson({ z: [3, { b: true, a: null }], a: 'value' });
  const right = closedCanonicalJson({ a: 'value', z: [3, { a: null, b: true }] });
  assert.equal(left, right);
  assert.equal(left, '{"a":"value","z":[3,{"a":null,"b":true}]}');
});

test('accessors are rejected without invoking them', () => {
  let reads = 0;
  const value = Object.defineProperty({}, 'hidden', {
    enumerable: true,
    get() {
      reads += 1;
      return 'must-not-run';
    },
  });
  assert.throws(
    () => closedCanonicalJson(value),
    (error: unknown) => error instanceof ClosedCanonicalJsonError
      && error.code === 'accessor_property',
  );
  assert.equal(reads, 0);
});

test('prototype, symbol, sparse-array, reserved-key, cycle, and unsupported values fail closed', () => {
  class Foreign { value = 1; }
  const symbolValue = { value: 1 } as Record<PropertyKey, unknown>;
  symbolValue[Symbol('hidden')] = 2;
  const reserved = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(reserved, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });
  const sparse = new Array(2);
  sparse[1] = 'present';
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  const cases: Array<[unknown, ClosedCanonicalJsonError['code']]> = [
    [new Foreign(), 'non_plain_object'],
    [new Date(0), 'non_plain_object'],
    [new Map(), 'non_plain_object'],
    [symbolValue, 'symbol_key'],
    [{ nested: reserved }, 'reserved_key'],
    [sparse, 'sparse_array'],
    [cyclic, 'cyclic'],
    [{ missing: undefined }, 'unsupported_type'],
    [{ number: Number.POSITIVE_INFINITY }, 'non_finite_number'],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => closedCanonicalJson(value),
      (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === code,
      code,
    );
  }
});

test('depth, node, string, and total-byte budgets are enforced while traversing', () => {
  assert.throws(
    () => closedCanonicalJson({ a: { b: { c: true } } }, { maxDepth: 2 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'depth_limit',
  );
  assert.throws(
    () => closedCanonicalJson([1, 2, 3, 4], { maxNodes: 4 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'node_limit',
  );
  assert.throws(
    () => closedCanonicalJson('12345', { maxStringBytes: 4 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'string_limit',
  );
  assert.throws(
    () => closedCanonicalJson({ value: '12345' }, { maxTotalBytes: 8 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'total_byte_limit',
  );
});


test('provider ingestion omits only enumerable undefined object members while strict authority encoding remains closed', () => {
  const schema = { omitted: undefined, anyOf: [{ description: undefined, type: 'string', optional: undefined }], tail: undefined };
  assert.throws(() => closedCanonicalJson(schema), (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'unsupported_type');
  const options = { omitUndefinedObjectMembers: true };
  assert.equal(closedCanonicalJson(schema, options), '{"anyOf":[{"type":"string"}]}');
  let reads = 0;
  const accessor = Object.defineProperty({}, 'description', { enumerable: true, get() { reads += 1; return undefined; } });
  const hidden = Object.defineProperty({}, 'description', { enumerable: false, value: undefined });
  const symbol = { [Symbol('extra')]: undefined };
  for (const value of [[undefined], accessor, hidden, symbol, { value: NaN }, { value() {} }]) {
    assert.throws(() => closedCanonicalJson(value, options));
  }
  assert.equal(reads, 0);
});


test('omitted SDK members still consume traversal limits', () => {
  assert.throws(() => closedCanonicalJson({ a: undefined, b: undefined }, { omitUndefinedObjectMembers: true, maxNodes: 2 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'node_limit');
  assert.throws(() => closedCanonicalJson({ oversized: undefined }, { omitUndefinedObjectMembers: true, maxStringBytes: 2 }),
    (error: unknown) => error instanceof ClosedCanonicalJsonError && error.code === 'string_limit');
});
