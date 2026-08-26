/**
 * Run: npx tsx --test src/integrations/composio/provider-keyword-relaxation.test.ts
 *
 * A connected carrier must never answer an ordinary request with silence.
 *
 * Measured live 2026-08-26 against the real account (19 connected toolkits,
 * Google Sheets among them, every manifest installed and 'current'): the
 * provider's `search` filter is a KEYWORD match that narrows as terms are
 * added, not a semantic one. The role text the model actually sends —
 * "create a Google Sheet and write a header row" — returned ZERO rows, while
 * "sheet header" returned three and one salient term returned the full page.
 *
 * Discovery handed that English sentence straight to the filter, so a request
 * phrased as a sentence discovered nothing, disclosed nothing, and was refused
 * ten times over as "cites a capability that was not disclosed to this source"
 * — with the toolkit connected the entire time. The user's standard is the
 * pin: a reasonable ask must not fail when the tools are attached.
 *
 * These pins hold the ladder at the provider seam. Nothing here names a real
 * provider, toolkit, or operation: the fake carrier below matches terms the
 * way the live one was measured to, so the contract is about ASKING WELL, not
 * about anyone's catalog.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-keyword-relaxation-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';

const composio = await import('./client.js');

const TOOLKIT = 'quarrystone';
const TARGET = 'QUARRYSTONE_LEDGER_APPEND_HEADER_ROW';
const SCHEMA = { type: 'object', properties: { value: { type: 'string' } } };

/** The operation the request is actually about, plus enough same-carrier
 * neighbours that one broad term fills the provider's whole bounded page. */
const CATALOG = [
  { slug: TARGET, name: 'Append header row', description: 'Append a header row to a ledger' },
  { slug: 'QUARRYSTONE_LEDGER_CREATE', name: 'Create ledger', description: 'Create a new ledger' },
  ...Array.from({ length: 20 }, (_, index) => ({
    slug: `QUARRYSTONE_LEDGER_UNRELATED_${index}`,
    name: `Unrelated ledger operation ${index}`,
    description: 'An unrelated ledger operation',
  })),
].map((row) => ({ ...row, toolkit: { slug: TOOLKIT }, inputParameters: SCHEMA }));

let searches: (string | undefined)[] = [];

/** Mirrors the measured provider: every term must appear, so each added term
 * narrows the match and a full sentence matches nothing. */
function installCarrier(): void {
  searches = [];
  composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('relaxation-key');
  composio.__test__.setComposioClient({
    tools: {
      async getRawComposioTools(input: Record<string, unknown>) {
        const search = input.search as string | undefined;
        searches.push(search);
        const terms = (search ?? '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
        return CATALOG
          .filter((row) => {
            const haystack = `${row.slug} ${row.name} ${row.description}`.toLowerCase();
            return terms.every((term) => haystack.includes(term));
          })
          .slice(0, 16);
      },
    },
  } as never);
}

after(() => {
  composio.__test__.setComposioClient(null as never);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('a role phrased as a sentence still finds the operation it is about', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT],
    'create a quarrystone ledger and append a header row for me',
    16,
  );
  assert.ok(found.length > 0,
    'a connected carrier answered an ordinary request with silence — this is the live defect');
  assert.ok(found.some((tool) => tool.slug === TARGET),
    `the operation the request was about must be discoverable; got ${found.map((t) => t.slug).join(', ')}`);
  assert.ok(searches.length > 1,
    'the exact sentence matched nothing, so discovery must relax and ask again rather than give up');
});

test('every returned row came from a real provider response', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'create a quarrystone ledger and append a header row for me', 16);
  const known = new Set(CATALOG.map((row) => row.slug));
  for (const tool of found) {
    assert.ok(known.has(tool.slug),
      'relaxation widens the QUESTION asked of the provider, never the authority granted');
  }
});

test('relevance owns the bounded window, not arrival order', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'append a header row to the quarrystone ledger', 16);
  const rank = found.findIndex((tool) => tool.slug === TARGET);
  assert.ok(rank >= 0 && rank < 5,
    `a broad sibling term must not spend the window before the requested operation enters it (rank=${rank})`);
});

test('a request that matches no term still reaches what the connection granted', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools(
    [TOOLKIT], 'zzzz unmatchable phrasing nobody indexed', 16);
  assert.ok(found.length > 0,
    'connecting a carrier grants its catalog; an unresolved role may never be answered with nothing');
});

test('a request the provider answers first time costs exactly one search', async () => {
  installCarrier();
  const found = await composio.searchConnectedComposioTools([TOOLKIT], 'ledger', 16);
  assert.ok(found.length > 0);
  assert.equal(searches.length, 1,
    'relaxation is paid only on a miss; the hit path keeps its single bounded search');
});
