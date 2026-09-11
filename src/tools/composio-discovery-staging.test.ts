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
const { stageDiscoveredComposioCapabilities, composioOperationIsCallableNow } = await import('./composio-tools.js');
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

  const staged = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));

  const entries = capabilityResolutionEntries(identity.sessionId);
  const docs = entries.find((entry) => entry.identifier === 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT');
  assert.ok(docs, `discovery must stage a resolution entry, not just a visible row: ${JSON.stringify({ entries, staged })}`);
  assert.equal(docs!.status, 'proven');
  assert.equal(docs!.connection, 'active');
  assert.equal(docs!.effectClass, 'read');
  assert.equal(docs!.accountIdentity, DOCS_CONNECTION,
    'the ONE connected googledocs account resolves, exactly as it does for tool_search');
});

test('a disclosure with no executable schema is never staged — it cannot be called and must not claim it can', async () => {
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  const identity = acceptedSource('Find something in Google Docs');

  const staged = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_SOMETHING_WITHOUT_A_SCHEMA' },
    { slug: 'GOOGLEDOCS_ALSO_SCHEMALESS', inputParameters: undefined },
  ]));

  assert.deepEqual(staged.blockers, {});
  assert.deepEqual(staged.proven, []);
  assert.equal(capabilityResolutionEntries(identity.sessionId).length, 0,
    'a search hint without an executable contract is not a proven capability');
});

test('staging never turns a discovery into a failed turn', async () => {
  // No ambient run context: the search still returns its results.
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  assert.deepEqual(
    await stageDiscoveredComposioCapabilities([{ slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA }]),
    { blockers: {}, proven: [] },
    'without an accepted source there is nothing to stage against, and that is not an error',
  );

  // An unreachable provider is a degraded search, never a dead turn — and
  // whatever it could not finish is REPORTED, so "found nothing" and "found it
  // but you still cannot call it" stop reading identically from the outside.
  composioClientTest.setConnectedAccountsLoader(() => Promise.reject(new Error('provider unreachable')));
  const identity = acceptedSource('Read the plan doc');
  const degraded = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));
  for (const [slug, blocker] of Object.entries(degraded.blockers)) {
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

test('`proven` is verified against the catalog, never inferred from the absence of a blocker', async () => {
  // THE HALF-FIX THIS CLOSES. Staging minted the callable entry and the search
  // payload still read exactly as it had before — "here is a slug, go call
  // composio_execute_tool" — which is the same sentence that preceded a
  // `candidates=0` refusal on the previous run. Live 2026-09-11 23:14: the
  // operation was found (count 1), proven, and account-resolved on four
  // separate searches, and the model executed NOTHING. It searched for the same
  // Google Doc read five times and the turn died on
  // `exact_checkpoint_admission_exhausted` with the document still unread,
  // because nothing in the result told it anything had changed.
  //
  // The claim has to be worth believing, so it is checked the way the dispatch
  // boundary checks it: a CURRENT CALLABLE catalog entry for that exact
  // operation. An operation can finish staging with no blocker and still have
  // no such entry — silence is not proof.
  const { peekHostCapabilityCatalogFactory, isCurrentCallableCatalogEntry } =
    await import('../runtime/harness/host-capability-catalog-factory.js');

  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  const identity = acceptedSource('Read https://docs.example.invalid/document/d/FIXTURE/edit');
  const staged = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));

  // Whatever this test home could publish, the two must agree exactly: every
  // slug reported proven has a current callable entry, and nothing else does.
  const catalog = peekHostCapabilityCatalogFactory();
  const callable = new Set((catalog?.snapshot() ?? [])
    .filter((entry) => isCurrentCallableCatalogEntry(entry))
    .map((entry) => entry.manifest!.operationId));
  for (const slug of staged.proven) {
    assert.ok(callable.has(slug),
      `${slug} was reported PROVEN AND CALLABLE with no current callable catalog entry behind it`);
  }
  // And a blocked operation is never also claimed as proven.
  for (const slug of Object.keys(staged.blockers)) {
    assert.ok(!staged.proven.includes(slug),
      `${slug} cannot be both blocked and callable`);
  }
});

test('the search output tells the model what it just made callable', async () => {
  // WHO READS THIS. The `proven` list is worthless if the payload never carries
  // it — that was the whole defect. Neither discovery lane is reachable from a
  // test home without a Composio key and a network, so pin the exact edges.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./composio-tools.ts', import.meta.url), 'utf8');
  const announcements = source.match(/PROVEN AND CALLABLE NOW for this step/g) ?? [];
  assert.equal(announcements.length, 2,
    'the SDK lane and the CLI-only lane must each report what staging proved');
  assert.match(source, /staging\.proven\.length > 0/, 'the SDK lane branches on verified proof');
  assert.match(source, /cliStaging\.proven\.length > 0/, 'the CLI lane branches on verified proof');
  // Being callable is not being approved; the effect gate is unchanged.
  assert.equal((source.match(/being proven is not approval/g) ?? []).length, 2,
    'both lanes must say that a proven write still crosses the effect gate');
});

test('an operation with no current callable entry is never called callable', async () => {
  // The claim "PROVEN AND CALLABLE NOW" has to be worth believing, because the
  // two states that produced `candidates=0:proven=none` in the first place were
  // nothing registered, and something registered that is not currently
  // callable. Both must answer NO.
  //
  // HONEST LIMIT OF THIS PIN: minting a genuinely callable row needs the
  // module-private attestation in host-capability-catalog-factory, so the
  // POSITIVE case is not constructible here (the factory is not even installed
  // in this home). What is pinned: the negative cases, and — structurally — that
  // this code asks the catalog the same question the dispatch boundary asks
  // rather than a weaker "a row exists" test, which is precisely how a
  // confident sentence would get attached to an uncallable operation.
  assert.equal(composioOperationIsCallableNow('GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT'), false,
    'nothing registered for this operation: not callable');
  assert.equal(composioOperationIsCallableNow('SOMETHING_NEVER_DISCOVERED'), false);
  assert.equal(composioOperationIsCallableNow(''), false, 'a malformed lookup must not throw into discovery');

  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./composio-tools.ts', import.meta.url), 'utf8');
  const check = source.slice(source.indexOf('export function composioOperationIsCallableNow'));
  const body = check.slice(0, check.indexOf('\n}\n'));
  assert.match(body, /isCurrentCallableCatalogEntry\(entry\)/,
    'the positive attestation the dispatch boundary requires, not a presence check');
  assert.match(body, /entry\.manifest\?\.operationId === slug/,
    'the entry must belong to THIS exact operation');
  assert.match(body, /:definition:/,
    'a drifted-but-current successor id must count, or a live operation reads as unavailable');
});

test('a blocked operation is never also announced as callable', async () => {
  // Real and non-vacuous in this home: publication genuinely fails here, so the
  // docs read comes back blocked — and must not appear in `proven`.
  composioClientTest.setConnectedAccountsLoader(connectedAccounts);
  const identity = acceptedSource('Read https://docs.example.invalid/document/d/FIXTURE/edit');
  const staged = await underRunContext(identity, () => stageDiscoveredComposioCapabilities([
    { slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', inputParameters: SCHEMA },
  ]));
  assert.ok(Object.keys(staged.blockers).length > 0 || staged.proven.length > 0,
    'the fixture must exercise one branch or the other, never neither');
  for (const slug of Object.keys(staged.blockers)) {
    assert.ok(!staged.proven.includes(slug), `${slug} cannot be both blocked and callable`);
  }
});
