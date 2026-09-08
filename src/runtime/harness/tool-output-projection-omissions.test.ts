import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactStructuredJsonToolOutput } from './tool-output-digest.js';
const receipt = `[exact-output-receipt:v1 nonce=11111111-1111-4111-8111-111111111111 sha256=${'a'.repeat(64)}]`;

function assertNoInventedAbsence(shown: unknown, original: unknown, path: string[] = []): void {
  if (shown === null) { assert.equal(original, null, `synthetic null at ${JSON.stringify(path)}`); return; }
  if (Array.isArray(shown)) {
    assert.ok(Array.isArray(original));
    if (shown.length === 0) assert.equal(original.length, 0, `synthetic empty array at ${JSON.stringify(path)}`);
    assert.ok(shown.length <= original.length);
    for (let index = 0; index < shown.length; index += 1) assertNoInventedAbsence(shown[index], original[index], [...path, String(index)]);
    return;
  }
  if (shown && typeof shown === 'object') {
    assert.ok(original && typeof original === 'object' && !Array.isArray(original));
    const entries = Object.entries(shown).filter(([key]) => path.length !== 0 || key !== '__clementine');
    if (entries.length === 0 && path.length > 0) assert.equal(Object.keys(original).length, 0, `synthetic empty object at ${JSON.stringify(path)}`);
    for (const [key, value] of entries) {
      assert.ok(Object.hasOwn(original, key));
      assertNoInventedAbsence(value, (original as Record<string, unknown>)[key], [...path, key]);
    }
    return;
  }
  if (typeof shown === 'string') assert.equal(typeof original, 'string'); // an explicit clipped-string marker may be present
  else assert.equal(shown, original, `source scalar/index changed at ${JSON.stringify(path)}`);
}

test('budget omissions never fabricate null, empty objects or empty arrays and never shift an array suffix', () => {
  const original = { actualNull: null, actualZero: 0, actualEmpty: '',
    many: Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`field_${i}`, 'text'.repeat(2000)])),
    rows: Array.from({ length: 40 }, (_, i) => ({ ordinal: i, caption: 'caption '.repeat(1000), nested: ['large '.repeat(1000), i, false] })),
  };
  for (const maxChars of [800, 1500, 4000, 20000]) {
    const text = compactStructuredJsonToolOutput(JSON.stringify(original), { maxChars, callId: 'raw-source', exactOutputReceipt: receipt });
    assert.ok(text); assert.ok(text.length <= maxChars);
    const shown = JSON.parse(text);
    assertNoInventedAbsence(shown, original);
    assert.equal(shown.__clementine.truncated, true);
    assert.match(shown.__clementine.projectionSemantics, /not null or empty/);
    assert.equal(shown.__clementine.receipt, receipt);
    assert.ok(shown.__clementine.projection.clippedStrings > 0 || shown.__clementine.projection.omittedValues > 0 || shown.__clementine.projection.omittedObjectKeys > 0);
    if (maxChars <= 1500) assert.ok(shown.__clementine.projection.omittedValues > 0);
  }
});

test('an oversized deep subtree is omitted explicitly while fitting deep values keep their source meaning', () => {
  let value: unknown = { tooLarge: 'deep'.repeat(50000), actualNull: null, actualZero: 0, actualEmpty: '' };
  for (let depth = 0; depth < 18; depth += 1) value = { child: value, sibling: depth };
  const original = { data: value, actualNull: null };
  const text = compactStructuredJsonToolOutput(JSON.stringify(original), { maxChars: 4000, callId: 'deep-source', exactOutputReceipt: receipt });
  assert.ok(text); const shown = JSON.parse(text);
  assertNoInventedAbsence(shown, original);
  assert.ok(shown.__clementine.projection.omittedValues > 0);
  assert.equal(shown.__clementine.truncated, true);
});
