/**
 * A COMPOSIO DISCOVERY MUST BECOME CALLABLE, NOT MERELY VISIBLE.
 *
 * `composio_search_tools` advertises itself, in its own catalog summary, as the
 * thing to use "BEFORE concluding an action is unavailable" — and it used to
 * produce nothing the model could then call. It recorded `capability_discovered`
 * with an exact slug and a live schema fingerprint but no `capabilityRef`, and
 * staged no catalog entry at all.
 *
 * Live 2026-09-11, session sess-desktop-f99c78cc64078f8eada66007 (22:18-22:20):
 *
 *   22:19:40.674  call_tool → GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT with
 *                 connected_account_id ca_P57D3YdQqviX — the right slug AND the
 *                 right live account, the same one that read this very document
 *                 successfully at 19:56 that morning.
 *   22:19:40.676  refused: catalog_entry_or_manifest_missing:candidates=0:proven=none
 *   22:19:40.804  tool_choice_recall returned the ACTIVE recorded choice for
 *                 googledocs.get_document_plaintext. It counted for nothing.
 *   22:19:41-42   three capability_discovered landed from composio_search_tools —
 *                 GOOGLEDOCS, APIFY, DATAFORSEO — every one carrying a live
 *                 schemaFingerprint and no capabilityRef.
 *   22:20:02      governor: gained [], terminalize
 *                 authority_acquisition:no_new_evidence — for a turn that had
 *                 just discovered every toolkit it was asked to inventory.
 *
 * Zero `capability_resolution` events exist in that entire session. One gap
 * produced both deaths: nothing became callable, and nothing counted as
 * progress. These pin the fix at the boundary the fix actually moved.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-discovery-staging-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const { __test__: composioClientTest } = await import('../integrations/composio/client.js');
const { stageDiscoveredComposioCapabilities } = await import('./composio-tools.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');

const DOCS_CONNECTION = 'ca_fixture_docs';

/** The live shape this pin is built from: ONE active googledocs connection
 *  that carries no mailbox identity at all (`account: null` in the 22:18:59
 *  composio_status of the failing session). */
function connectedAccounts(): Promise<Array<Record<string, unknown>>> {
  return Promise.resolve([{
    id: DOCS_CONNECTION,
    status: 'ACTIVE',
    toolkit: { slug: 'googledocs' },
    user_id: 'fixture-owner',
    data: {},
  }]);
}

const SCHEMA = {
  type: 'object',
  properties: { document_id: { type: 'string' } },
  required: ['document_id'],
} as const;

after(() => {
  composioClientTest.setConnectedAccountsLoader(null);
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function acceptedSource(text: string) {
  const session = eventlog.createSession({ kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: event.seq };
}

/** Run inside the ambient harness run context the discovery path really has —
 *  without it the staging helper has no accepted source to stage against, which
 *  is itself part of the contract below. */
async function underRunContext<T>(
  identity: { sessionId: string; sourceUserSeq: number },
  body: () => Promise<T>,
): Promise<T> {
  return harnessRunContextStorage.run({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    turn: 1,
    counter: { limit: 8, used: 0, increment() { this.used += 1; } },
  } as never, body);
}

function capabilityResolutionEntries(sessionId: string): Array<Record<string, unknown>> {
  return eventlog.listEvents(sessionId, { types: ['capability_resolution'] })
    .flatMap((event) => (Array.isArray(event.data.entries)
      ? event.data.entries as Array<Record<string, unknown>>
      : []));
}

test('a schema-bearing composio_search_tools disclosure reaches the SAME staging boundary tool_search uses', async () => {
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  const identity = acceptedSource('Read https://docs.example.invalid/document/d/FIXTURE/edit and plan the research from it');

  const blockers = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));

  const entries = capabilityResolutionEntries(identity.sessionId);
  const docs = entries.find((entry) => entry.identifier === 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT');
  assert.ok(docs, `discovery must stage a resolution entry, not just a visible row: ${JSON.stringify({ entries, blockers })}`);
  assert.equal(docs!.status, 'proven');
  assert.equal(docs!.connection, 'active');
  assert.equal(docs!.effectClass, 'read');
  assert.equal(docs!.accountIdentity, DOCS_CONNECTION,
    'the ONE connected googledocs account resolves, exactly as it does for tool_search');
});

test('a disclosure with no executable schema is never staged — it cannot be called and must not claim it can', async () => {
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  const identity = acceptedSource('Find something in Google Docs');

  const blockers = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_SOMETHING_WITHOUT_A_SCHEMA' },
    { slug: 'GOOGLEDOCS_ALSO_SCHEMALESS', inputParameters: undefined },
  ]));

  assert.deepEqual(blockers, {});
  assert.equal(capabilityResolutionEntries(identity.sessionId).length, 0,
    'a search hint without an executable contract is not a proven capability');
});

test('staging never turns a discovery into a failed turn', async () => {
  // No ambient run context: the search still returns its results.
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  assert.deepEqual(
    await stageDiscoveredComposioCapabilities([{ slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA }]),
    {},
    'without an accepted source there is nothing to stage against, and that is not an error',
  );

  // An unreachable provider is a degraded search, never a dead turn — and
  // whatever it could not finish is REPORTED, so "found nothing" and "found it
  // but you still cannot call it" stop reading identically from the outside.
  composioClientTest.setConnectedAccountsLoader(() => Promise.reject(new Error('provider unreachable')));
  const identity = acceptedSource('Read the plan doc');
  const blockers = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));
  for (const [slug, blocker] of Object.entries(blockers)) {
    assert.match(blocker.code, /^(account_selection_required|capability_publication_required)$/,
      `${slug} must report a typed blocker the model can act on, not an opaque failure`);
  }
});

test('both composio_search_tools discovery lanes await staging — the wiring, not just the helper', async () => {
  // WHO CALLS THIS. The helper is worthless if the two live discovery lanes do
  // not reach it, and neither lane is reachable from a test home without a
  // Composio key and a network. Pin the exact call edges at the source.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./composio-tools.ts', import.meta.url), 'utf8');
  const awaited = source.match(/await stageDiscoveredComposioCapabilities\(/g) ?? [];
  assert.equal(awaited.length, 2,
    'the SDK lane and the CLI-only lane must each hand their disclosed matches to staging');
  // Recording alone is what shipped the dead end; it must never be the last word.
  for (const call of source.match(/recordDiscoveredComposioCapabilities\((matches|visibleMatches)\);\n(.*)/g) ?? []) {
    assert.match(call, /stageDiscoveredComposioCapabilities/,
      'every discovery that records a capability must also stage it');
  }
});
