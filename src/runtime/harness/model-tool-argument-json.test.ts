import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseModelToolArgumentObject } from './model-tool-argument-json.js';

test('literal JSON string controls preserve the entire synthesis, existing escapes and Unicode', () => {
  const controls = Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('');
  const text = `| Claim | Source |\n| 😀 é | unknown |\r\n\t${controls}`;
  // Only this one value uses malformed literal controls. Escaped quotation
  // marks and backslashes elsewhere must not alter the scanner's string state.
  const prefix = JSON.stringify({ quoted: 'say "hi"', escaped: 'literal \\n and \\u0000', nested: { n: 7 } }).slice(0, -1);
  const raw = `${prefix},"data":{"markdown":"${text}"}}`;
  assert.throws(() => JSON.parse(raw));
  const result = parseModelToolArgumentObject(raw);
  assert.deepEqual(result, { quoted: 'say "hi"', escaped: 'literal \\n and \\u0000', nested: { n: 7 }, data: { markdown: text } });
  assert.deepEqual(parseModelToolArgumentObject(JSON.stringify(result)), result);
});

test('valid argument values keep ordinary JSON semantics and are not double decoded', () => {
  const expected = { data: { markdown: 'line one\nline two', encoded: '{"x":"\\n"}' }, empty: null, n: 0, b: false };
  assert.deepEqual(parseModelToolArgumentObject(JSON.stringify(expected, null, 2)), expected);
});

test('no structural repair or ambiguous escape repair, and tool arguments must be an object', () => {
  const malformed = [
    '{"data":"line\nbut no ending quote}',
    '{"data":"line\nend",}',
    '{"data":"line\nend"} trailing text',
    '{"data":"line\nend"}{"second":true}',
    '{"data":"unescaped "quote"\nend"}',
    '{"data":"backslash\\\nthen newline"}',
    '{"data":"bad escape \\q\nend"}',
    '{"data":"bad Unicode \\u00\nend"}',
    '{"data":"line\nend"\u0000}',
    '["line\nend"]', '"line\nend"', 'null', '1', 'true', '',
  ];
  for (const raw of malformed) assert.equal(parseModelToolArgumentObject(raw), null, JSON.stringify(raw));
});
