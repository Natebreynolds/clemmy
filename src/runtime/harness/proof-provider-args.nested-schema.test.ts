/**
 * Leaf pins for the nested-schema repair diagnostic.
 *
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/proof-provider-args.nested-schema.test.ts
 *
 * The host already holds the exact provider schema and already computes the
 * nested failure; these pins prove it now names WHERE the payload left the
 * schema (RFC 6901 pointers), renders the bounded required shape around each
 * failing pointer, keys the refusal on the failing-path set (never on
 * argument values), and never sends the model to discovery.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectProviderSchemaFailures,
  createProofProviderForegroundPayloadValidator,
  proofProviderRepairKey,
  proofProviderSchemaDigest,
  renderBoundedSchemaSubtree,
  validateProofProviderArguments,
  type ProofProviderSchemaFailure,
} from './proof-provider-args.js';

const REPAIR_PREFIX = '[provider-dispatch:not-started:invalid-args]';
const CLOSING = 'Retry this same operation exactly once with one corrected JSON object; do not call tool_search or substitute another operation. No provider request was sent.';
const HEX64 = /^[a-f0-9]{64}$/;

/** Opaque nested write shape (no provider names): a destination id plus an
 * `insertion.range` object whose children are snake_case with one enum. The
 * annotation sentinels must never reach the model. */
const OPAQUE_TABLE_INSERT_V7 = {
  type: 'object',
  required: ['destination_id', 'insertion'],
  properties: {
    destination_id: { type: 'string', description: 'SENTINEL_DESCRIPTION' },
    insertion: {
      type: 'object',
      description: 'SENTINEL_DESCRIPTION',
      required: ['range'],
      properties: {
        range: {
          type: 'object',
          title: 'SENTINEL_TITLE',
          required: ['axis', 'start_index', 'end_index'],
          properties: {
            sheet_id: { type: 'integer', examples: ['SENTINEL_EXAMPLE'] },
            axis: { type: 'string', enum: ['ROWS', 'COLUMNS'], default: 'SENTINEL_DEFAULT' },
            start_index: { type: 'integer' },
            end_index: { type: 'integer' },
          },
        },
        inherit_from_before: { type: 'boolean', deprecated: true, readOnly: false, writeOnly: false },
      },
    },
    response_ranges: { type: 'array', items: { type: 'string' } },
  },
};

const CORRECTED = {
  destination_id: 'dest-1',
  insertion: {
    range: { sheet_id: 7, axis: 'ROWS', start_index: 1, end_index: 2 },
    inherit_from_before: false,
  },
};

function validator() {
  const built = createProofProviderForegroundPayloadValidator({
    operationId: 'OPAQUE_TABLE_INSERT_V7',
    schema: OPAQUE_TABLE_INSERT_V7,
  });
  assert.ok(built);
  return built!;
}

/** The diagnostic may say "do not call tool_search"; it must never recommend it. */
function assertNeverRecommendsDiscovery(repair: string): void {
  assert.doesNotMatch(repair, /call the first-class local tool_search/i);
  assert.doesNotMatch(repair, /inspect .*tool_search/i);
  assert.equal(repair.replace(/do not call tool_search/g, '').includes('tool_search'), false,
    'the only mention of tool_search is the negative instruction');
}

test('camelCase children under a nested object fail at their exact pointers with the required shape', () => {
  const refused = validator()({
    destination_id: 'dest-1',
    insertion: { range: { sheetId: 7, axis: 'ROWS', startIndex: 1, endIndex: 2 } },
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.ok(refused.repair.startsWith(`${REPAIR_PREFIX} OPAQUE_TABLE_INSERT_V7 arguments did not match its exact current schema.`));
  assert.match(refused.repair, /Failing paths: "\/insertion\/range\/start_index" \(missing required, expected integer\), "\/insertion\/range\/end_index" \(missing required, expected integer\), "\/insertion\/range\/sheetId" \(unknown field\), "\/insertion\/range\/startIndex" \(unknown field\), "\/insertion\/range\/endIndex" \(unknown field\)\./);
  assert.match(refused.repair, /Required shape at "\/insertion\/range": object; required: \[axis, start_index, end_index\]; sheet_id: integer, axis\*: enum\["ROWS","COLUMNS"\], start_index\*: integer, end_index\*: integer\./);
  assert.ok(refused.repair.endsWith(CLOSING));
  assert.doesNotMatch(refused.repair, /Required top-level fields|Allowed top-level fields/);
  assert.doesNotMatch(refused.repair, /SENTINEL_/);
  assertNeverRecommendsDiscovery(refused.repair);
  assert.match(refused.repairKey, HEX64);
  assert.equal(refused.schemaAvailable, true);
  assert.ok(refused.repair.length <= 2_000);

  const validation = validateProofProviderArguments({
    schema: OPAQUE_TABLE_INSERT_V7,
    payload: { destination_id: 'dest-1', insertion: { range: { sheetId: 7, axis: 'ROWS', startIndex: 1, endIndex: 2 } } },
  });
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.deepEqual(validation.failingPaths, [
    '/insertion/range/endIndex',
    '/insertion/range/end_index',
    '/insertion/range/sheetId',
    '/insertion/range/startIndex',
    '/insertion/range/start_index',
  ]);
  // The pre-existing top-level lists stay for their callers.
  assert.deepEqual(validation.requiredFields, ['destination_id', 'insertion']);
  assert.deepEqual(validation.invalidFields, ['insertion']);
  assert.equal(validation.repairKey, refused.repairKey);
});

test('wrong nesting reports the missing nested object and the stray siblings at their pointers', () => {
  const refused = validator()({
    destination_id: 'dest-1',
    insertion: { axis: 'ROWS', start_index: 1, end_index: 2 },
  });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.repair, /"\/insertion\/range" \(missing required, expected object\)/);
  assert.match(refused.repair, /"\/insertion\/axis" \(unknown field\)/);
  assert.match(refused.repair, /"\/insertion": object; required: \[range\]; range\*: object\{sheet_id: integer, axis\*: enum\["ROWS","COLUMNS"\], start_index\*: integer, end_index\*: integer\}, inherit_from_before: boolean/);
  assertNeverRecommendsDiscovery(refused.repair);
});

test('the live class: a missing nested object plus one stray top-level key renders the root and the nested shape', () => {
  const refused = validator()({ destination_id: 'dest-1', sheet_name: 'Log' });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.repair, /Failing paths: "\/insertion" \(missing required, expected object\), "\/sheet_name" \(unknown field\)\./);
  assert.match(refused.repair, /Required shape at "\/": object; required: \[destination_id, insertion\]; destination_id\*: string, insertion\*: object\{range\*: object, inherit_from_before: boolean\}, response_ranges: array<string>/);
  assert.match(refused.repair, /"\/insertion": object; required: \[range\]/);
  assertNeverRecommendsDiscovery(refused.repair);
});

test('same failing paths with different values mint one repair key; a different failing-path set mints another', () => {
  const validate = validator();
  const first = validate({
    destination_id: 'dest-1',
    insertion: { range: { sheetId: 7, axis: 'ROWS', startIndex: 1, endIndex: 2 } },
  });
  const second = validate({
    destination_id: 'a completely different destination',
    insertion: { range: { sheetId: 99, axis: 'COLUMNS', startIndex: 40, endIndex: 41 } },
  });
  const flat = validate({
    destination_id: 'dest-1',
    insertion: { axis: 'ROWS', start_index: 1, end_index: 2 },
  });
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(flat.ok, false);
  if (first.ok || second.ok || flat.ok) return;
  assert.equal(first.repairKey, second.repairKey, 'argument values never mint a new repair key');
  assert.notEqual(first.repairKey, flat.repairKey, 'a new failing-path set is a new key');
  assert.match(flat.repairKey, HEX64);
});

test('the repair key binds the schema digest and is independent of failure order', () => {
  const failures: ProofProviderSchemaFailure[] = [
    { path: '/b', code: 'unknown_field' },
    { path: '/a', code: 'missing_required', expected: 'string' },
    { path: '/a', code: 'missing_required' },
  ];
  const schemaDigest = proofProviderSchemaDigest(OPAQUE_TABLE_INSERT_V7);
  assert.match(schemaDigest, HEX64);
  const forward = proofProviderRepairKey({ schemaDigest, failures });
  const reversed = proofProviderRepairKey({ schemaDigest, failures: [...failures].reverse() });
  assert.equal(forward, reversed);
  assert.equal(
    proofProviderRepairKey({ schemaDigest, failures: failures.slice(0, 2) }),
    forward,
    'duplicate (path, code) pairs collapse; `expected` prose is not key material',
  );
  const otherSchema = {
    ...OPAQUE_TABLE_INSERT_V7,
    properties: { ...OPAQUE_TABLE_INSERT_V7.properties, extra: { type: 'string' } },
  };
  assert.notEqual(
    proofProviderRepairKey({ schemaDigest: proofProviderSchemaDigest(otherSchema), failures }),
    forward,
  );
  // Key-sorted digest: property order in the JSON never changes the schema digest.
  const reordered = {
    properties: OPAQUE_TABLE_INSERT_V7.properties,
    required: OPAQUE_TABLE_INSERT_V7.required,
    type: 'object',
  };
  assert.equal(proofProviderSchemaDigest(reordered), schemaDigest);
});

test('a corrected snake_case nested object passes through exactly', () => {
  assert.deepEqual(validator()(CORRECTED), { ok: true });
  const validation = validateProofProviderArguments({ schema: OPAQUE_TABLE_INSERT_V7, payload: CORRECTED });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(validation.args, CORRECTED);
  assert.notEqual(validation.args, CORRECTED, 'provider arguments cross as a defensive clone');
});

test('the failure walk is empty exactly when the exact matcher accepts (metamorphic)', () => {
  const payloads: unknown[] = [
    CORRECTED,
    { ...CORRECTED, response_ranges: ['A1:B2'] },
    { ...CORRECTED, response_ranges: [1] },
    { ...CORRECTED, destination_id: 7 },
    { destination_id: 'd' },
    { destination_id: 'd', insertion: { range: { axis: 'ROWS', start_index: 1, end_index: 2 } } },
    { destination_id: 'd', insertion: { range: { axis: 'rows', start_index: 1, end_index: 2 } } },
    { destination_id: 'd', insertion: { range: { axis: 'ROWS', start_index: 1.5, end_index: 2 } } },
    { destination_id: 'd', insertion: null },
    'not an object',
    null,
    [],
  ];
  for (const payload of payloads) {
    const failures: ProofProviderSchemaFailure[] = [];
    collectProviderSchemaFailures(payload, OPAQUE_TABLE_INSERT_V7, '', failures);
    const validation = validateProofProviderArguments({ schema: OPAQUE_TABLE_INSERT_V7, payload });
    assert.equal(
      failures.length === 0,
      validation.ok,
      `matcher/collector disagreement for ${JSON.stringify(payload)}: ${JSON.stringify(failures)}`,
    );
    if (!validation.ok) {
      assert.ok(validation.failures.length > 0);
      assert.ok(validation.failures.every((failure) => failure.path === '' || failure.path.startsWith('/')));
    }
  }
});

test('enum, const, anyOf and array items are reported at their pointer', () => {
  const schema = {
    type: 'object',
    required: ['mode', 'kind', 'value', 'tags', 'tuple'],
    properties: {
      mode: { type: 'string', enum: ['fast', 'slow'] },
      kind: { const: 'fixed' },
      value: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      tags: { type: 'array', items: { type: 'string' } },
      tuple: { type: 'array', items: [{ type: 'string' }] },
    },
  };
  const failures: ProofProviderSchemaFailure[] = [];
  collectProviderSchemaFailures(
    { mode: 'medium', kind: 'other', value: true, tags: ['ok', 3], tuple: ['x'] },
    schema,
    '',
    failures,
  );
  assert.deepEqual(failures, [
    { path: '/mode', code: 'enum_mismatch', expected: 'enum["fast","slow"]' },
    { path: '/kind', code: 'const_mismatch', expected: 'const("fixed")' },
    { path: '/value', code: 'type_mismatch', expected: 'oneOf(string|integer)' },
    { path: '/tags/1', code: 'type_mismatch', expected: 'string' },
    { path: '/tuple', code: 'items_mismatch', expected: 'array' },
  ]);
  const rendered = renderBoundedSchemaSubtree(schema, ['/tags/1', '/mode']);
  assert.match(rendered, /"\/": object; required: \[mode, kind, value, tags, tuple\]; mode\*: enum\["fast","slow"\], kind\*: const\("fixed"\), value\*: oneOf\(string\|integer\), tags\*: array<string>, tuple\*: array/);
});

test('the walk stays within its entry and depth budget and the pointers escape RFC 6901 tokens', () => {
  const wide: Record<string, unknown> = { destination_id: 'd', insertion: CORRECTED.insertion };
  for (let index = 0; index < 40; index += 1) wide[`stray_${index}`] = index;
  const wideValidation = validateProofProviderArguments({ schema: OPAQUE_TABLE_INSERT_V7, payload: wide });
  assert.equal(wideValidation.ok, false);
  if (wideValidation.ok) return;
  assert.equal(wideValidation.failures.length, 24);
  assert.equal(wideValidation.fieldsTruncated, true);

  const deepSchema = (depth: number): Record<string, unknown> => (depth === 0
    ? { type: 'string' }
    : { type: 'object', required: ['n'], properties: { n: deepSchema(depth - 1) } });
  const deepPayload = (depth: number): unknown => (depth === 0 ? 42 : { n: deepPayload(depth - 1) });
  const deepFailures: ProofProviderSchemaFailure[] = [];
  collectProviderSchemaFailures(deepPayload(9), deepSchema(9), '', deepFailures);
  assert.deepEqual(deepFailures, [{ path: '/n/n/n/n/n/n', code: 'unresolved_shape', expected: 'object' }]);
  const deepOk: ProofProviderSchemaFailure[] = [];
  collectProviderSchemaFailures({ n: { n: { n: { n: { n: { n: { n: { n: { n: 'leaf' } } } } } } } } }, deepSchema(9), '', deepOk);
  assert.deepEqual(deepOk, []);

  const escaped: ProofProviderSchemaFailure[] = [];
  collectProviderSchemaFailures(
    { 'a/b': 1, 'c~d': 2 },
    { type: 'object', properties: { 'a/b': { type: 'string' } } },
    '',
    escaped,
  );
  assert.deepEqual(escaped, [
    { path: '/a~1b', code: 'type_mismatch', expected: 'string' },
    { path: '/c~0d', code: 'unknown_field' },
  ]);
  assert.match(
    renderBoundedSchemaSubtree({ type: 'object', properties: { 'a/b': { type: 'string' } } }, ['/a~1b']),
    /"\/": object; required: \[\]; a\/b: string/,
  );
});

test('the subtree renderer honors its limits and never prints annotations', () => {
  const full = renderBoundedSchemaSubtree(OPAQUE_TABLE_INSERT_V7, ['/insertion/range/axis']);
  assert.doesNotMatch(full, /SENTINEL_/);
  assert.match(full, /"\/insertion\/range": object/);
  const tight = renderBoundedSchemaSubtree(OPAQUE_TABLE_INSERT_V7, ['/insertion/range/axis'], {
    maxDepth: 3, maxFields: 24, maxChars: 40,
  });
  assert.equal(tight.length, 40);
  assert.ok(tight.endsWith('...'));
  const shallow = renderBoundedSchemaSubtree(OPAQUE_TABLE_INSERT_V7, ['/sheet_name'], {
    maxDepth: 1, maxFields: 2, maxChars: 900,
  });
  assert.match(shallow, /destination_id\*: string, insertion\*: object, \.\.\.\(\+1 more\)/);
});

test('a wide schema keeps the repair within 2000 chars with its closing instruction intact', () => {
  const properties: Record<string, unknown> = {};
  const payload: Record<string, unknown> = {};
  for (let index = 0; index < 40; index += 1) {
    properties[`declared_property_with_a_long_name_${index}`] = { type: 'string' };
    payload[`undeclared_property_with_a_long_name_${index}`] = 'x';
  }
  const wide = createProofProviderForegroundPayloadValidator({
    operationId: 'OPAQUE_WIDE_OPERATION',
    schema: { type: 'object', properties },
  })!;
  const refused = wide(payload);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.ok(refused.repair.length <= 2_000);
  assert.ok(refused.repair.startsWith(`${REPAIR_PREFIX} OPAQUE_WIDE_OPERATION`));
  assert.ok(refused.repair.endsWith(CLOSING));
  assert.match(refused.repair, /\(\+\d+ more\)/);
  assertNeverRecommendsDiscovery(refused.repair);
});
