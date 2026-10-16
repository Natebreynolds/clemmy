/** Named-app status from actual discovery, with synthetic provider transports only. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-named-unconnected-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'));
writeFileSync(path.join(home, 'state/composio-catalog-cache.json'), JSON.stringify({ at: Date.now(),
  data: [{ slug: 'quillboard', name: 'Quillboard', authMode: 'managed', categories: [] }] }));
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in named-app controls'); }) as typeof fetch;
const composio = await import('../integrations/composio/client.js');
const providers = await import('./tool-search-provider-sources.js');
const search = await import('./tool-search-tool.js');
const schemas = await import('./composio-schema-cache.js');
const index = await import('../memory/capability-index.js');
const events = await import('../runtime/harness/eventlog.js');
const cliCatalog = await import('../integrations/cli-catalog/catalog.js');
const cliCoverage = await import('../integrations/cli-catalog/connected-cli-coverage.js');
const query = 'quillboard sentinel pages';
const operation = 'QUILLBOARD_GET_SENTINEL_PAGE';
const schema = { type: 'object', properties: { page: { type: 'string' } } };
const row = (slug = operation) => ({ slug, name: 'Read quillboard sentinel pages',
  description: 'Read quillboard sentinel pages.', toolkit: { slug: 'quillboard' }, inputParameters: schema });
const active = () => [{ id: 'fixture-quillboard-account', status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'quillboard' } }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function source() {
  return providers.buildAuthorizedToolSearchCandidateSources({ reason: 'named-app fixture', authority: 'catalog',
    allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } as never,
  { sessionId: 'named-app-fixture', sourceUserSeq: 1 }).find(candidate => candidate.kind === 'authorized_composio')!;
}
let definitions = 0, business = 0;
function installProvider(read: (input: Record<string, unknown>) => Promise<unknown[]> = async () => [row()]) {
  composio.__test__.setComposioClient({ tools: {
    async getRawComposioTools(input: Record<string, unknown>) { definitions++; return read(input); },
    async execute() { business++; throw new Error('No business execution in discovery controls'); },
  } } as never);
}
beforeEach(() => {
  schemas.resetToolSchemaCache(); index._resetCapabilityIndexForTest(); composio.resetComposioClient();
  composio.__test__.setComposioApiKeyOverride('synthetic-only'); definitions = 0; business = 0;
});
after(() => {
  composio.__test__.setConnectedAccountsLoader(null); composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient(); events.closeEventLog(); globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

test('a cold actually connected named app is never reported disconnected while its shared registry read is pending', async () => {
  const entered = deferred<void>(), release = deferred<ReturnType<typeof active>>();
  let reads = 0;
  composio.__test__.setConnectedAccountsLoader(async () => { reads++; entered.resolve(); return release.promise; });
  installProvider(async () => [row(definitions === 1 ? 'QUILLBOARD_GET_SENTINEL_FIRST' : 'QUILLBOARD_GET_SENTINEL_SECOND')]);
  assert.deepEqual(composio.peekConnectedToolkits(), [], 'cold absence is unknown');
  const pending = source().search({ query, limit: 8 });
  await entered.promise; release.resolve(active());
  const found = await pending;
  assert.ok(found.length > 0);
  assert.equal(found.some(candidate => candidate.connectionRequired), false);
  assert.equal(found.some(candidate => /not connected/i.test(candidate.summary)), false);
  assert.equal(reads, 1, 'same query shares the connection observation');
  assert.equal(definitions, 1, 'an already connected app does not get a second disconnected-app definition lookup');
  assert.equal(business, 0);
});

test('a confirmed empty registry still exposes the named app as setup-only metadata', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => []); installProvider();
  const found = await source().search({ query, limit: 8 });
  assert.equal(found.length, 1); assert.equal(found[0]!.name, operation);
  assert.deepEqual(found[0]!.connectionRequired, { toolkit: 'quillboard', app: 'Quillboard' });
  assert.match(found[0]!.guidance!, /cannot run yet/);
  assert.equal(found[0]!.planningAuthority, undefined);
  assert.equal(definitions, 1); assert.equal(business, 0);
});

test('a freshly authenticated same-vendor CLI does not hide the missing provider alternative', async () => {
  const entry = { id: 'quillboard', name: 'Quillboard', vendor: 'Quillboard', command: 'quillboard',
    description: 'Fixture CLI', tags: ['quillboard'], installCommand: 'npm install -g fixture-quillboard',
    installSource: 'npm' as const, authDocsUrl: 'https://example.invalid/auth' };
  const connection = cliCatalog.recordConnectedCli(entry);
  writeFileSync(path.join(home, 'state/cli-auth-health.json'), JSON.stringify({ version: 'v1', entries: {
    quillboard: { id: 'quillboard', command: 'quillboard', installed: true, authStatus: 'ok',
      connectionRevision: connection.connectionRevision,
      binaryPath: '/controlled/bin/quillboard', checkedAt: new Date().toISOString(), username: 'fixture-owner' },
  } }));
  try {
    assert.equal(cliCoverage.connectedCliCandidatesForApp('quillboard')[0]?.authentication.state, 'confirmed');
    composio.__test__.setConnectedAccountsLoader(async () => []); installProvider();
    const found = await source().search({ query, limit: 8 });
    assert.deepEqual(found.map(candidate => candidate.connectionRequired), [{ toolkit: 'quillboard', app: 'Quillboard' }]);
    assert.equal(found[0]?.planningAuthority, undefined, 'neither candidate inventory nor authentication grants provider dispatch');
    assert.equal(definitions, 1);
    assert.equal(business, 0);
  } finally { cliCatalog.forgetConnectedCli('quillboard'); }
});

for (const lastGood of [false, true]) test(`unknown/error registry cannot prove disconnection${lastGood ? ' from an older empty snapshot' : ''}`, async () => {
  if (lastGood) composio._setConnectedToolkitsSnapshotForTests([]);
  composio.__test__.setConnectedAccountsLoader(async () => { throw new Error('synthetic registry unavailable'); });
  installProvider();
  await assert.rejects(source().search({ query, limit: 8 }), (error: unknown) =>
    error instanceof search.CandidateSourceUnavailableError && error.code === 'no_connections');
  assert.equal(composio.peekCurrentConnectedToolkits(), null);
  assert.equal(definitions, 0, 'no disconnected-app claims or operation discovery from an unknown registry');
  assert.equal(business, 0);
});

test('a connection observation retired while named definitions are pending cannot publish a stale disconnected claim', async () => {
  const entered = deferred<void>(), release = deferred<unknown[]>();
  composio.__test__.setConnectedAccountsLoader(async () => []);
  installProvider(async () => { entered.resolve(); return release.promise; });
  const pending = source().search({ query, limit: 8 });
  await entered.promise;
  composio._setConnectedToolkitsSnapshotForTests([{ slug: 'quillboard', connectionId: 'new-account', status: 'ACTIVE' }]);
  release.resolve([row()]);
  await assert.rejects(pending, (error: unknown) => error instanceof search.CandidateSourceUnavailableError && error.code === 'no_connections');
  assert.equal(business, 0);
});

test('the real broker reports a confirmed disconnected app on page one even below the visible rank cutoff', async () => {
  composio.__test__.setConnectedAccountsLoader(async () => []); installProvider();
  const candidates = await source().search({ query, limit: 8 });
  let handler!: (input: unknown) => Promise<{ content: Array<{ text: string }> }>;
  search.registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set<string>(),
    candidateSources: [{ kind: 'authorized_composio', search: async () => [
      { name: 'QUILLBOARD_SENTINEL_PAGES', summary: query, carrier: 'work_call', score: 1 },
      { name: 'QUILLBOARD_SENTINEL_PAGES_OTHER', summary: query, carrier: 'work_call', score: 0.9 },
      ...candidates.map(candidate => ({ ...candidate, score: -10 })),
    ] }],
  });
  const reply = await handler({ query, limit: 1, cursor: null, role_key: null, account_selection: null });
  const body = JSON.parse(reply.content[0]!.text);
  assert.equal(body.page, 1); assert.equal(body.results.length, 1);
  assert.notEqual(body.results[0].name, operation, 'the disconnected row is genuinely below this page');
  assert.deepEqual(body.apps_not_connected.map((entry: { app: string; operations: string[] }) => [entry.app, entry.operations]), [['Quillboard', [operation]]]);
  assert.match(body.apps_not_connected[0].next, /ask_user_question/);
  assert.equal(body.apps_not_connected[0].toolkit, undefined, 'the toolkit slug stays host-side');
  // The same typed subject an exact-operation search raises, so the owner's
  // question carries the card that connects the app.
  const gap = body.unavailable.find((entry: { dependencySubject?: { kind?: string } }) => entry.dependencySubject?.kind === 'exact_capability_connection');
  assert.ok(gap, 'one named disconnected app is a typed connection gap');
  assert.equal(gap.source, 'authorized_composio');
  assert.equal(gap.code, 'no_connections');
  assert.equal(gap.dependencySubject.capability, operation);
  assert.equal(gap.dependencySubject.capabilityRef, `cap:resolved:${operation.toLowerCase()}`);
  assert.equal(gap.dependencySubject.query, query);
  assert.equal(business, 0);
});

for (const retireBeforeJoin of [false, true]) test(`a late connected search keeps cached contracts and ${retireBeforeJoin ? 'drops a retired named-app observation' : 'joins one authoritative named-app lookup'}`, async () => {
  const connectedEntered = deferred<void>(), namedFinished = deferred<void>(), release = deferred<unknown[]>();
  const controller = new AbortController();
  const cachedOperation = 'PAPERPLANE_GET_SENTINEL_PAGE';
  const connection = { id: 'fixture-paperplane-account', status: 'ACTIVE', user_id: 'fixture-owner', toolkit: { slug: 'paperplane' } };
  composio.__test__.setConnectedAccountsLoader(async () => [connection]);
  schemas.rememberToolSchema(cachedOperation, schema, Date.now(), 'fixture-v1');
  index.recordCapabilityOperations([{ identifier: cachedOperation, carrierKind: 'composio', carrier: 'paperplane',
    displayName: query, description: query, effectClass: 'read', effectProvenance: 'declared' }]);
  let connectedLookups = 0, namedLookups = 0;
  installProvider(async input => {
    if ((input.toolkits as string[] | undefined)?.includes('quillboard')) {
      namedLookups++; namedFinished.resolve(); return [row()];
    }
    connectedLookups++; connectedEntered.resolve(); return release.promise;
  });
  const pending = source().search({ query, limit: 8, deferPreparation: true,
    signal: controller.signal, deadlineAt: Date.now() + 2_000 });
  try {
    await Promise.all([connectedEntered.promise, namedFinished.promise]);
    // The named lookup is complete while the connected transport stays held.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (retireBeforeJoin) composio._setConnectedToolkitsSnapshotForTests([
      { slug: 'paperplane', connectionId: connection.id, status: 'ACTIVE' },
      { slug: 'quillboard', connectionId: 'new-quillboard-account', status: 'ACTIVE' },
    ]);
    const found = await pending;
    assert.ok(found.some(candidate => candidate.name === cachedOperation), 'the ordinary cached connected fallback remains available');
    const named = found.filter(candidate => candidate.connectionRequired);
    assert.equal(named.length, retireBeforeJoin ? 0 : 1);
    if (!retireBeforeJoin) assert.deepEqual(named[0]!.connectionRequired, { toolkit: 'quillboard', app: 'Quillboard' });
    assert.equal(namedLookups, 1, 'the fallback reuses the already completed named lookup');
    assert.equal(connectedLookups, 1, 'the connected transport was still held when the cached answer returned');
    assert.equal(business, 0);
  } finally {
    controller.abort(); release.resolve([]);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});
