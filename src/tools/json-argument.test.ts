import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';
import { jsonArgumentText, jsonObjectArgument, jsonValueArgument } from './json-argument.js';
import { normalizeZodForDeferredJson, normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';

test('JSON document validation preserves every data key and nested value before one serialization', () => {
  const document = JSON.parse('{"__proto__":{"fixture":true},"constructor":"data","prototype":null,"nested":{"__proto__":false},"values":[0,false,null,"雪"]}');
  for (const schema of [jsonObjectArgument(), jsonValueArgument(),
    normalizeZodForDeferredJson(jsonObjectArgument().nullish()),
    normalizeZodForDeferredJson(jsonValueArgument().nullish())]) {
    const parsed = schema.parse(document);
    assert.equal(parsed, document, 'validation must not reconstruct or drop document keys');
    assert.equal(jsonArgumentText(parsed), JSON.stringify(document));
    assert.ok(Object.hasOwn(JSON.parse(jsonArgumentText(parsed)!), '__proto__'));
    const wire = z.toJSONSchema(schema, { io: 'input' });
    const validate = new Ajv2020({ strict: false }).compile(wire);
    assert.equal(validate(document), true, 'advertised object values match runtime acceptance');
    for (const invalid of [1, true]) assert.equal(schema.safeParse(invalid).success, false);
    assert.equal(schema.safeParse(new Date(0)).success, false, 'non-JSON object instances are not document records');
  }
  assert.equal(jsonObjectArgument().safeParse([]).success, false);
  assert.equal(jsonObjectArgument().safeParse(null).success, false);
  assert.equal(normalizeZodForDeferredJson(jsonObjectArgument()).safeParse([]).success, false);
  assert.equal(normalizeZodForDeferredJson(jsonObjectArgument()).safeParse(null).success, false);
  assert.equal(jsonValueArgument().safeParse([document]).success, true);
  const array = normalizeZodForDeferredJson(jsonValueArgument()).parse([document]);
  assert.equal(jsonArgumentText(array), JSON.stringify([document]));
  const strict = normalizeZodForCodexStrict(jsonObjectArgument());
  assert.equal(strict.safeParse(document).success, false, 'first-class strict tools retain their legacy text grammar');
  assert.equal(strict.safeParse(JSON.stringify(document)).success, true);
  const lookalike = z.unknown().meta({ type: 'object', additionalProperties: {} });
  assert.notEqual(normalizeZodForDeferredJson(lookalike), lookalike,
    'untrusted schema metadata cannot opt into exact-parser retention');
});

test('legacy document strings stay exact and missing documents stay distinct', () => {
  const text = ' { "text": "quoted \\\" value", "count": 3 } ';
  assert.equal(jsonArgumentText(jsonObjectArgument().parse(text)), text);
  assert.equal(jsonArgumentText(null), null);
  assert.equal(jsonArgumentText(undefined), undefined);
});
