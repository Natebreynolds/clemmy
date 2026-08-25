/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/cold-boot-goal-catalog.test.ts
 *
 * COLD-BOOT registry pin. The connections registry (`peekConnectedToolkits`)
 * is in-memory: the first turn after a daemon restart sees ZERO connected
 * toolkits until something awaits `listConnectedToolkits`. Before the prime,
 * admission-time enumeration on that first turn selected nothing and the
 * construct blocked naming missing FAMILIES — a false "none of your connected
 * apps provide…" on a fully connected account, on exactly the turn a user
 * sends right after restarting.
 *
 * These pins run the PRODUCTION registry view (no installed port): the
 * durable tool-contract store on an isolated home plus the composio client's
 * loader seam. CONTROL proves the cold peek is genuinely empty (the pre-fix
 * failure shape); the fix pin proves `recordConnectedGoalCatalog` primes the
 * registry with one awaited load and then selects the goal families from
 * connected reality.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cold-boot-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-cold-boot\n', 'utf8');

const { createSession, listEvents, openEventLog, closeEventLog } = await import('./eventlog.js');
const { __test__, peekConnectedToolkits } = await import('../../integrations/composio/client.js');
const { saveToolContract } = await import('../../tools/tool-contract-store.js');
const { recordConnectedGoalCatalog, selectGoalCatalog } = await import('./connected-goal-catalog.js');

const OBJECTIVE = 'Find me the top 5 big bear lake restaurants based on Google reviews add them to a Google sheet with the data';

// The durable contract store survives restarts — it is populated.
saveToolContract({
  identifier: 'FIRECRAWL_SEARCH',
  schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'integer' } } },
});
saveToolContract({
  identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
  schema: { type: 'object', required: ['title', 'sheet_name', 'sheet_json'], properties: { title: { type: 'string' }, sheet_name: { type: 'string' }, sheet_json: { type: 'string' } } },
});
saveToolContract({
  identifier: 'GOOGLESHEETS_BATCH_GET',
  schema: { type: 'object', required: ['spreadsheet_id'], properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } } },
});

// The connections API is reachable (the daemon just restarted; Composio is
// up) but nothing has awaited a listing yet — the in-memory cache is cold.
__test__.setConnectedAccountsLoader(async () => [
  { id: 'conn-firecrawl', status: 'ACTIVE', toolkit: { slug: 'firecrawl' } },
  { id: 'conn-sheets', status: 'ACTIVE', toolkit: { slug: 'googlesheets' } },
]);

test('CONTROL: cold registry peek is empty — sync selection alone would false-block the goal families', () => {
  assert.equal(peekConnectedToolkits().length, 0, 'cold boot: in-memory registry must start empty for this pin to mean anything');
  const cold = selectGoalCatalog(OBJECTIVE);
  assert.equal(cold.entries.length, 0);
  assert.ok(cold.gaps.includes('search') && cold.gaps.includes('row_create'), 'the pre-fix shape: every family reads as missing');
});

test('FIX: recordConnectedGoalCatalog primes the registry once and selects from connected reality', async () => {
  openEventLog();
  try {
    const session = createSession({ kind: 'chat', title: 'cold boot', userId: 'user-cold-boot' });
    const selection = await recordConnectedGoalCatalog({
      sessionId: session.id,
      sourceUserSeq: 3,
      objective: OBJECTIVE,
    });
    assert.deepEqual(selection.gaps, [], `no family gap after the prime (got ${JSON.stringify(selection.gaps)})`);
    const ids = selection.entries.map((entry) => entry.identifier);
    // Zero-evidence floor: FIRECRAWL_SEARCH (brand token + generic token,
    // overlap 0 with the objective) is abstained; the search slot falls to
    // the evidence-bearing sheets read. This pin's subject is the PRIME —
    // selection reflects connected reality instead of a false cold gap —
    // and that holds regardless of which evidenced candidate wins a slot.
    assert.ok(!ids.includes('FIRECRAWL_SEARCH'), 'a zero-evidence brand slug is never selected, even primed');
    assert.ok(ids.includes('GOOGLESHEETS_SHEET_FROM_JSON'), 'row create selected from the primed registry');
    assert.ok(ids.includes('GOOGLESHEETS_BATCH_GET'), 'readback selected from the primed registry');

    // The selection is durably recorded for THIS source before host-bind.
    const events = listEvents(session.id, { types: ['capability_resolution'] });
    const own = events.filter((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === 3);
    assert.equal(own.length, 1, 'exactly one capability_resolution for the source');

    // And the primed registry now serves sync peeks for the rest of the turn.
    assert.equal(peekConnectedToolkits().length, 2);
  } finally {
    closeEventLog();
  }
});

test('prime failure serves LAST-GOOD: a refresh error never empties an already-seen registry', async () => {
  __test__.setConnectedAccountsLoader(async () => { throw new Error('composio unreachable'); });
  openEventLog();
  try {
    const session = createSession({ kind: 'chat', title: 'registry refresh down', userId: 'user-cold-boot' });
    const selection = await recordConnectedGoalCatalog({
      sessionId: session.id,
      sourceUserSeq: 4,
      objective: OBJECTIVE,
    });
    // The prior successful load is the last-good view; a failed refresh must
    // not degrade it to "nothing connected" mid-process.
    assert.deepEqual(selection.gaps, []);
    assert.equal(selection.entries.length, 3, 'last-good registry still selects all three goal roles');
  } finally {
    closeEventLog();
    __test__.setConnectedAccountsLoader(null);
  }
});
