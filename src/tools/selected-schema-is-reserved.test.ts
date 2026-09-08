import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./tool-search-tool.ts', import.meta.url), 'utf8');
const FMT = readFileSync(new URL('../runtime/harness/tool-output-format.ts', import.meta.url), 'utf8');

// plan-ux-and-schema-audit.md, step 2. C9 workflow_update event 134811 published
// schemas:{} beside an 18168-character handle: the eviction loop popped from a
// list that INCLUDED the exact-selected schema, so the argument contract was
// removed while the cards and guidance that caused the overflow stayed inline.
test('the eviction list excludes the exact-selected schema', () => {
  assert.match(
    SRC,
    /const shownSchemaNames = \[\.\.\.schemaNames\]\s*\n\s*\.filter\(\(name\) => name !== primarySchemaName\);/,
    'the selected contract must not be in the ordinary eviction list',
  );
});

test('guidance is surrendered BEFORE the selected schema', () => {
  const guidanceAt = SRC.indexOf('delete guidance[selectedExactly.name];');
  const lastResortAt = SRC.lastIndexOf('ensureSchemaHandle(primarySchemaName);');
  assert.ok(guidanceAt > 0 && lastResortAt > 0, 'both steps must exist');
  assert.ok(guidanceAt < lastResortAt, 'guidance must be dropped before the argument contract');
});

test('the selected schema is only evicted as a genuine last resort, and stays addressable', () => {
  const tail = SRC.split('delete guidance[selectedExactly.name];')[1]!.slice(0, 900);
  assert.match(tail, /text\.length > DEFAULT_TOOL_RESULT_MAX_CHARS/);
  assert.match(tail, /ensureSchemaHandle\(primarySchemaName\)/,
    'the bytes must be retained behind the content-addressed handle');
});

// The audit is explicit: "Do not replace 20000 with a new universal arbitrary
// threshold" and "do not independently raise one constant and claim the issue
// solved." This change is ORDER only.
test('the result ceiling constant is unchanged — this is a reordering, not a raise', () => {
  assert.match(FMT, /DEFAULT_TOOL_RESULT_MAX_CHARS\s*=\s*20_?000/,
    'the 20000 ceiling must remain until the host-owned budget (audit step 1) lands');
});
