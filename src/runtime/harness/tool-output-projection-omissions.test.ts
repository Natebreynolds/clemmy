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

test('a bounded list view states its denominator and the fields every shown record carries', () => {
  // Ninety-four wide records under a view budget that cannot hold them: the
  // reader must be able to tell how many the source returned, how many it is
  // looking at, and which fields it can rely on across them.
  const rows = Array.from({ length: 94 }, (_, i) => ({
    id: `record-${'x'.repeat(120)}-${i}`,
    subject: `Subject ${i % 7}`,
    start: { dateTime: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T09:00:00`, timeZone: 'Pacific Standard Time' },
    end: { dateTime: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T09:30:00`, timeZone: 'Pacific Standard Time' },
    attendees: Array.from({ length: 10 }, (_, a) => ({ name: `Guest ${a}`, address: `guest${a}@example.test`, response: 'none' })),
  }));
  const original = { data: { value: rows, next_page_token: null }, successful: true };
  for (const maxChars of [2000, 4000, 16000]) {
    const text = compactStructuredJsonToolOutput(JSON.stringify(original), { maxChars, callId: 'list-call', exactOutputReceipt: receipt });
    assert.ok(text); assert.ok(text.length <= maxChars);
    const shown = JSON.parse(text);
    assertNoInventedAbsence(shown, original);
    const records = shown.__clementine.records;
    // Under the smallest budget no record fits; the view then says so.
    const visible: Array<Record<string, unknown>> = shown.data?.value ?? [];
    assert.equal(records.path, 'data.value');
    assert.equal(records.total, 94, 'the denominator is the source list, not what fit');
    assert.equal(records.shown, visible.length);
    assert.ok(records.shown < 94);
    for (const field of records.fieldsInEveryShownRecord) {
      assert.ok(visible.every((row) => Object.hasOwn(row, field)), `${field} is in every shown record`);
    }
    const inSome = new Set(visible.flatMap((row) => Object.keys(row)));
    for (const field of inSome) {
      if (visible.every((row) => Object.hasOwn(row, field as string))) {
        assert.ok(records.fieldsInEveryShownRecord.includes(field), `${String(field)} is shown for every record and is listed`);
      }
    }
  }
});

test('a view that shows the whole list with every field declares no partial coverage', () => {
  const original = { data: { value: [{ id: 1, subject: 'One' }, { id: 2, subject: 'Two' }] }, note: 'n'.repeat(9000) };
  const text = compactStructuredJsonToolOutput(JSON.stringify(original), { maxChars: 4000, callId: 'small-list', exactOutputReceipt: receipt });
  assert.ok(text);
  const shown = JSON.parse(text);
  assert.deepEqual(shown.data.value, original.data.value);
  assert.equal(shown.__clementine.records, undefined);
});
