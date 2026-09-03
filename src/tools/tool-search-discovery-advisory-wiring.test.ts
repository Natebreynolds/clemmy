/** Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-discovery-advisory-wiring.test.ts
 *
 * The redundant-discovery detector must be wired to the lane the model uses.
 *
 * discovery-advisory.ts describes exactly this failure — "the model searching
 * the same toolkit over and over with progressively broader queries... you
 * don't parallelize search, you STOP and commit" — but it was only called from
 * composio_search_tools / composio_list_tools, while the model searches via
 * tool_search. Same shape as the fan-out advisory being suppressed on the
 * work_call lane: a working detector installed on a path nobody takes.
 *
 * Live 2026-09-03 run 27: five progressively narrower searches for one SEO
 * operation, converging on a slug that does not exist, while THIRTEEN
 * dispatchable operations from that toolkit — including one an earlier run had
 * used successfully — sat in results already returned. Zero business calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./tool-search-tool.ts', import.meta.url), 'utf8');

test('tool_search consults the redundant-discovery detector', () => {
  assert.match(SRC, /import \{ maybeDiscoveryAdvisory \}/, 'the detector must be imported');
  assert.match(SRC, /maybeDiscoveryAdvisory\(\{/, 'and actually called');
  assert.match(SRC, /kind: 'search'/, "the find lane's public kind is 'search'");
});

// It must be a FIELD, never appended. Concatenating prose onto this JSON
// payload corrupted it ("Unexpected non-whitespace character after JSON") and
// broke two suites — the exact hazard the nestedDispatch guard on the fan-out
// advisory exists to prevent. Structured signals ride the structure.
test('the advisory is a JSON field, never appended prose', () => {
  assert.match(SRC, /discovery_advisory: discoveryAdvisory/,
    'the advisory must ride the envelope as a field');
  assert.doesNotMatch(SRC, /text \+ discoveryAdvisory/,
    'concatenating onto a JSON payload corrupts it');
});

test('no toolkit is named in code — the signal stays behavioural', () => {
  const i = SRC.indexOf('const advisoryToolkit');
  assert.ok(i > 0, 'the toolkit must be derived, not hardcoded');
  const block = SRC.slice(i, i + 500);
  assert.match(block, /registeredToolkitOfSlug/, 'derived from the rows actually returned');
  assert.doesNotMatch(block, /dataforseo|outlook|salesforce/i, 'no provider name in code');
});
