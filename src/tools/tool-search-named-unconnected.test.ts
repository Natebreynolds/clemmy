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
  assert.match(body.apps_not_connected[0].next, /exact operation names/);
  assert.equal(business, 0);
});
