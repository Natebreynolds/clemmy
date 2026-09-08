import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./tool-search-tool.ts', import.meta.url), 'utf8');
const HINT = SRC.split('const handleReadingGuidance =')[1]!.split('const hintForRows')[0]!;

// C9 workflow_update event 134811 published schemas:{} beside an 18168-character
// handle. Only the FINAL no-carrier fallback ever mentioned schema_handles, and
// production returns through the exact- or mixed-carrier branch first — so the
// model was told to fill `schemas.<tool>` for a schema that had just been
// evicted, and re-ran discovery instead of reading local chunks it already had.
test('handle guidance is emitted on every carrier branch, not just the fallback', () => {
  const branches = [
    'if (exactCarrier) return dispatchHint(exactCarrier) + handleReadingGuidance(hasSchemaHandles);',
    "if (fixedCarrier) return dispatchHint(fixedCarrier) + handleReadingGuidance(hasSchemaHandles);",
  ];
  for (const b of branches) {
    assert.ok(SRC.includes(b), `carrier branch must append handle guidance: ${b}`);
  }
  // the mixed-carrier (dispatchCarrierForName) branch too
  assert.match(
    SRC,
    /copy the disclosed effect exactly\.' \+ handleReadingGuidance\(hasSchemaHandles\);/,
    'the mixed-carrier branch must append handle guidance',
  );
});

test('guidance is conditioned on ACTUAL handle presence, not emitted unconditionally', () => {
  assert.match(HINT, /hasSchemaHandles\s*\?/, 'must branch on real presence');
  assert.match(HINT, /:\s*''/, 'must contribute nothing when no handles exist');
  assert.ok(
    SRC.includes('hintForRows(rows, Object.keys(schemaHandles).length > 0)'),
    'render must pass the real handle presence from the deeper scope',
  );
});

test('the guidance tells the model the schema is NOT under `schemas`', () => {
  // The specific confusion: schemas:{} was published beside a handle, and the
  // per-row argument hint still named schemas.<tool>.
  assert.match(HINT, /schema_handles/);
  assert.match(HINT, /local/i, 'must say the chunk read is local');
  assert.match(HINT, /do not expect those tools under `schemas`/,
    'must correct the wrong location explicitly');
  assert.match(HINT, /does not repeat provider discovery/,
    'must say re-searching is unnecessary — that was the observed waste');
});

test('the fallback branch still mentions handles (unchanged behaviour)', () => {
  assert.match(SRC, /If a complete schema is behind schema_handles, read its ordered local chunks/);
});
