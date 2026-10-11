import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  planStagedFileDownloads,
  planStagedFileUploads,
  StagedFileTransferPlanError,
} from './staged-file-transfer-plan.js';

test('upload planning uses runtime-present nodes and deterministic RFC 6901 order', () => {
  const schema = {
    type: 'object',
    properties: {
      z: { type: 'string', file_uploadable: true },
      'til~de': { type: 'string', file_uploadable: true },
      files: { type: 'array', items: { type: 'string', file_uploadable: true } },
      unused: { type: 'string', file_uploadable: true },
      'a/b': { type: 'string', file_uploadable: true },
    },
  };
  const args = {
    z: '/allowed/z.txt',
    files: Array.from({ length: 12 }, (_, index) => `/allowed/${index}.txt`),
    'til~de': '/allowed/tilde.txt',
    'a/b': '/allowed/slash.txt',
  };

  const nodes = planStagedFileUploads(schema, args);
  assert.deepEqual(nodes.map((node) => node.pointer), [
    '/a~1b',
    '/files/0',
    '/files/1',
    '/files/2',
    '/files/3',
    '/files/4',
    '/files/5',
    '/files/6',
    '/files/7',
    '/files/8',
    '/files/9',
    '/files/10',
    '/files/11',
    '/til~0de',
    '/z',
  ]);
  assert.ok(nodes.every((node) => node.annotation === 'file_uploadable'));
  assert.equal(nodes.some((node) => node.pointer === '/unused'), false, 'absent optional file fields are inert');
});

test('downloads require exact output-schema authority and never copy signed URLs into the plan', () => {
  const signedUrl = `https://files.example.test/object?signature=${'secret'.repeat(7_000)}`;
  assert.ok(Buffer.byteLength(signedUrl, 'utf8') > 32 * 1024, 'fixture exceeds the authority seal inline cap');
  const outputSchema = {
    type: 'object',
    properties: {
      authorized: {
        type: 'object',
        file_downloadable: true,
        required: ['s3url'],
        properties: { s3url: { type: 'string' }, mimetype: { type: 'string' } },
      },
      coincidental: {
        type: 'object',
        properties: { s3url: { type: 'string' } },
      },
    },
  };
  const result = {
    coincidental: { s3url: 'https://attacker.example.test/not-authorized' },
    authorized: { s3url: signedUrl, mimetype: 'application/pdf' },
  };

  const nodes = planStagedFileDownloads(outputSchema, result);
  assert.deepEqual(nodes, [{ pointer: '/authorized', annotation: 'file_downloadable' }]);
  const serializedPlan = JSON.stringify(nodes);
  assert.equal(serializedPlan.includes('signature='), false);
  assert.equal(serializedPlan.includes('attacker.example.test'), false);
  assert.ok(Buffer.byteLength(serializedPlan, 'utf8') < 256, 'large provider returns do not inflate the pointer manifest');
});

test('oneOf selects the sole validating runtime branch', () => {
  const schema = {
    type: 'object',
    properties: {
      payload: {
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'document'],
            properties: {
              kind: { const: 'document' },
              document: { type: 'string', file_uploadable: true },
            },
          },
          {
            type: 'object',
            required: ['kind', 'image'],
            properties: {
              kind: { const: 'image' },
              image: { type: 'string', file_uploadable: true },
            },
          },
        ],
      },
    },
  };

  assert.deepEqual(
    planStagedFileUploads(schema, { payload: { kind: 'image', image: '/allowed/image.png' } }),
    [{ pointer: '/payload/image', annotation: 'file_uploadable' }],
  );
});

test('oneOf refuses zero or multiple validating branches instead of choosing the first', () => {
  const ambiguous = {
    oneOf: [
      { type: 'object', properties: { left: { type: 'string', file_uploadable: true } } },
      { type: 'object', properties: { right: { type: 'string', file_uploadable: true } } },
    ],
  };
  assert.throws(
    () => planStagedFileUploads(ambiguous, { left: '/a', right: '/b' }),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'ambiguous_one_of',
  );

  const noMatch = {
    oneOf: [
      { type: 'object', required: ['kind'], properties: { kind: { const: 'a' } } },
      { type: 'object', required: ['kind'], properties: { kind: { const: 'b' } } },
    ],
  };
  assert.throws(
    () => planStagedFileUploads(noMatch, { kind: 'c' }),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'ambiguous_one_of',
  );
});

test('anyOf allows identical authority and refuses branch-dependent file authority', () => {
  const identical = {
    anyOf: [
      { type: 'object', properties: { file: { type: 'string', file_uploadable: true } } },
      { type: 'object', required: ['file'], properties: { file: { file_uploadable: true } } },
    ],
  };
  assert.deepEqual(
    planStagedFileUploads(identical, { file: '/allowed/file.txt' }),
    [{ pointer: '/file', annotation: 'file_uploadable' }],
  );

  const disagreeing = {
    anyOf: [
      { type: 'object', properties: { left: { type: 'string', file_uploadable: true } } },
      { type: 'object', properties: { right: { type: 'string', file_uploadable: true } } },
    ],
  };
  assert.throws(
    () => planStagedFileUploads(disagreeing, { left: '/a', right: '/b' }),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'ambiguous_any_of',
  );
});

test('internal refs retain annotations while external or unresolved refs are refused', () => {
  const schema = {
    type: 'object',
    $defs: {
      upload: { type: 'string', file_uploadable: true },
    },
    properties: {
      attachment: { $ref: '#/$defs/upload' },
    },
  };
  assert.deepEqual(
    planStagedFileUploads(schema, { attachment: '/allowed/report.pdf' }),
    [{ pointer: '/attachment', annotation: 'file_uploadable' }],
  );
  assert.throws(
    () => planStagedFileUploads({ $ref: 'https://example.test/schema.json' }, '/allowed/file'),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'unsupported_ref',
  );
  assert.throws(
    () => planStagedFileUploads({ $ref: '#/$defs/missing' }, '/allowed/file'),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'invalid_schema',
  );
});

test('runtime accessors are rejected without reading them', () => {
  let reads = 0;
  const args = Object.defineProperty({}, 'attachment', {
    enumerable: true,
    get() {
      reads += 1;
      return '/allowed/secret.txt';
    },
  });
  assert.throws(
    () => planStagedFileUploads({
      type: 'object',
      properties: { attachment: { type: 'string', file_uploadable: true } },
    }, args),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'unsafe_runtime_value',
  );
  assert.equal(reads, 0);
});

test('reserved runtime pointer segments are refused at nested array depth', () => {
  const schema = {
    type: 'object',
    properties: {
      outer: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
  };
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const nested = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nested, segment, {
      value: '/allowed/never-authorized.txt',
      enumerable: true,
    });
    assert.throws(
      () => planStagedFileUploads(schema, { outer: [nested] }),
      (error: unknown) => error instanceof StagedFileTransferPlanError
        && error.code === 'reserved_pointer_segment'
        && error.pointer === `/outer/0/${segment}`,
      segment,
    );
  }
});

test('reserved schema pointer segments are refused even in an unused combinator branch', () => {
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const dangerousProperties = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dangerousProperties, segment, {
      value: { type: 'string', file_uploadable: true },
      enumerable: true,
    });
    const schema = {
      oneOf: [
        { type: 'string' },
        { type: 'object', properties: dangerousProperties },
      ],
    };
    assert.throws(
      () => planStagedFileUploads(schema, 'the first branch is the sole runtime match'),
      (error: unknown) => error instanceof StagedFileTransferPlanError
        && error.code === 'reserved_pointer_segment'
        && error.pointer === `/oneOf/1/properties/${segment}`,
      segment,
    );
  }

  assert.throws(
    () => planStagedFileUploads({ $ref: '#/$defs/constructor', $defs: {} }, '/allowed/file.txt'),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'reserved_pointer_segment',
    'reserved internal-ref token is refused even when unresolved',
  );
});

test('provider pattern is refused before unused-branch matching without regex construction', () => {
  const catastrophic = `(${`a+`.repeat(256)})+$`;
  const schema = {
    oneOf: [
      {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', file_uploadable: true } },
      },
      {
        type: 'string',
        pattern: catastrophic,
      },
    ],
  };
  const NativeRegExp = globalThis.RegExp;
  let constructed = 0;
  globalThis.RegExp = new Proxy(NativeRegExp, {
    construct(target, args, newTarget) {
      constructed += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    assert.throws(
      () => planStagedFileUploads(schema, { file: '/allowed/report.txt' }),
      (error: unknown) => error instanceof StagedFileTransferPlanError
        && error.code === 'unsupported_pattern'
        && error.pointer === '/oneOf/1/pattern',
    );
  } finally {
    globalThis.RegExp = NativeRegExp;
  }
  assert.equal(constructed, 0, 'provider pattern text is never compiled or evaluated');
});

test('patternProperties is refused through nested array/anyOf schema paths', () => {
  const catastrophic = `^(${`a+`.repeat(256)})+$`;
  const schema = {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          patternProperties: {
            [catastrophic]: { type: 'string', file_downloadable: true },
          },
        },
      ],
    },
  };
  const startedAt = Date.now();
  assert.throws(
    () => planStagedFileDownloads(schema, []),
    (error: unknown) => error instanceof StagedFileTransferPlanError
      && error.code === 'unsupported_pattern'
      && error.pointer === '/items/anyOf/1/patternProperties',
  );
  assert.ok(Date.now() - startedAt < 1_000, 'catastrophic provider regex is rejected without evaluation');
});

test('a property NAMED pattern is data, not a provider regular expression', () => {
  // Live 2026-09-15: Outlook's recurrence.pattern object made every event update
  // fail preflight as unsupported_pattern, with no recurrence in the call.
  const schema = {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      recurrence: {
        type: 'object',
        properties: {
          pattern: { type: 'object', properties: { type: { type: 'string' }, interval: { type: 'integer' } } },
          range: { type: 'object', properties: { type: { type: 'string' } } },
        },
      },
    },
  };
  assert.doesNotThrow(() => planStagedFileUploads(schema, { subject: 'Clementine discussion' }));
  assert.doesNotThrow(() => planStagedFileUploads(schema, { subject: 'x', recurrence: { pattern: { type: 'daily', interval: 1 } } }));
  // The keyword in keyword position is still refused where file authority is granted.
  assert.throws(
    () => planStagedFileUploads({ type: 'object', properties: { file: { type: 'string', file_uploadable: true }, code: { type: 'string', pattern: '^[a-z]+$' } } }, { file: '/x', code: 'abc' }),
    (error: unknown) => error instanceof StagedFileTransferPlanError && error.code === 'unsupported_pattern'
      && error.pointer === '/properties/code/pattern',
  );
});

test('a schema that grants no file authority is never refused over an unrelated schema feature', () => {
  // The strict preflight protects file authority. With no annotation anywhere
  // there is nothing to protect, so an unsupported keyword elsewhere is inert.
  const schema = {
    type: 'object',
    properties: { code: { type: 'string', pattern: '^[a-z]+$' }, nested: { type: 'object', patternProperties: { '^x': { type: 'string' } } } },
  };
  assert.deepEqual(planStagedFileUploads(schema, { code: 'abc' }), []);
  // Runtime safety and schema validity stay strict without file authority.
  assert.throws(() => planStagedFileUploads(schema, { code: 123 }), (error: unknown) => error instanceof StagedFileTransferPlanError && error.code === 'schema_mismatch');
  // The same keyword next to a real file annotation is still refused.
  assert.throws(
    () => planStagedFileUploads({ type: 'object', properties: { file: { type: 'string', file_uploadable: true }, code: { type: 'string', pattern: '^[a-z]+$' } } }, { file: '/x', code: 'abc' }),
    (error: unknown) => error instanceof StagedFileTransferPlanError && error.code === 'unsupported_pattern',
  );
});

test('a refused call names the field and the limit it broke, so one repair fixes it', () => {
  const schema = {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      size: { type: 'integer', minimum: 1, maximum: 25 },
      order: { type: 'string', enum: ['newest', 'oldest'] },
      tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
    },
  };
  const refusal = (args: Record<string, unknown>) => {
    try { planStagedFileUploads(schema, args); } catch (error) {
      assert.ok(error instanceof StagedFileTransferPlanError && error.code === 'schema_mismatch');
      return { pointer: error.pointer, message: error.message };
    }
    assert.fail('expected a schema refusal');
  };
  assert.deepEqual(refusal({ query: 'kickoff', size: 50 }),
    { pointer: '/size', message: 'runtime value does not satisfy the exact schema: 50 is above the maximum 25 at /size' });
  assert.match(refusal({ query: 'kickoff', size: 0 }).message, /0 is below the minimum 1 at \/size$/);
  assert.match(refusal({ query: 'kickoff', order: 'latest' }).message, /"latest" is not one of "newest", "oldest" at \/order$/);
  assert.match(refusal({ query: 'kickoff', tags: ['a', 'b', 'c'] }).message, /3 items; the most is 2 at \/tags$/);
  assert.match(refusal({ query: 7 }).message, /7 is not a string at \/query$/);
  assert.match(refusal({ size: 5 }).message, /a required field is missing at \/query$/);
  assert.match(refusal({ query: 'kickoff', page: 2 }).message, /this operation has no such field at \/page$/);
  assert.deepEqual(planStagedFileUploads(schema, { query: 'kickoff', size: 25 }), []);
});
