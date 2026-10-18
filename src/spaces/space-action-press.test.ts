import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after, afterEach } from 'node:test';

const CHILD = process.env.CLEMMY_PRESS_PROCESS_MODE === '1';
const HOME = CHILD ? process.env.CLEMENTINE_HOME! : mkdtempSync(path.join(os.tmpdir(), 'clem-exact-press-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const press = await import('./space-action-press.js');
const bindings = await import('./space-action-press-binding.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const events = await import('../runtime/harness/eventlog.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const gate = await import('./space-action-gate.js');
const store = await import('./store.js');
const data = await import('./data-store.js');
const workspaceDb = await import('./workspace-db.js');
const OPERATION = 'PROOF_SOCIAL_PUBLISH_EXACT';
const countPath = path.join(HOME, 'press-execution-count.txt');
const count = () => existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;
const hash = (input: string) => createHash('sha256').update(input).digest('hex');

function installFixture(accountId = 'account.press.fixture', schema = 'schema.press.fixture') {
  const manifest = manifests.attachSemanticContract({ version: 1, manifestId: 'manifest.press.fixture', providerKind: 'local_registry',
    operationId: OPERATION, providerIdentity: 'runtime.press.fixture', providerVersion: '1', operationVersion: '1',
    definitionFingerprint: hash(schema), effect: 'external_write', accountId,
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, purpose: 'bounded_write', acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'], applicableDeliverableKinds: ['records'], evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'press.fixture', issuedAt: '2026-10-18T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, advisoryRoles: ['write'] });
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), { invoke: async () => {
    writeFileSync(countPath, String(count() + 1)); return { data: { published: true, id: 'fixture-result' } };
  } }).ok, true);
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([{
    capabilityId: 'capability.press.fixture', toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId, advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, manifest, invoke: async () => { throw new Error('Catalog callback cannot execute.'); },
  }]));
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId: OPERATION, accountId,
    definitionFingerprint: manifest.definitionFingerprint, providerVersion: '1', operationVersion: '1', observedAt: Date.now(), origin: 'independent',
    observe: () => ({ operationId: OPERATION, accountId, definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: '1', operationVersion: '1', observedAt: Date.now() }) }).ok, true);
}
function clearFixture() { catalogs.installHostCapabilityCatalogFactory(null); observations.clearIndependentCapabilityObservations(); ports.clearProductionCapabilityPorts(); }
function fixture(slug: string) {
  installFixture();
  const record = store.spaceStore.save({ id: slug, title: 'Exact button fixture',
    actions: [{ id: 'publish', label: 'Publish', composioSlug: OPERATION, argsTemplate: { destination: 'fixture' }, confirm: true }] });
  const view = store.resolveInSpace(slug, record.viewEntry); mkdirSync(path.dirname(view), { recursive: true });
  writeFileSync(view, '<button data-clem-action="publish">Publish fixture</button>');
  const input = { documentId: 'doc_fixture', expectedViewRevision: bindings.workspacePressViewRevision(record),
    actionId: 'publish', args: { message: 'fixture approved bytes' } };
  const prepared = press.prepareSpaceActionPress(slug, input);
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') throw new Error('Expected exact press');
  return { record, input, prepared, view };
}

if (CHILD) {
  installFixture();
  const input = JSON.parse(process.argv[2]!);
  const result = await press.consumeSpaceActionPress(input.slug, input.input, input.token);
  console.log(`PRESS_RESULT:${JSON.stringify({ ok: result.ok, approvalId: result.approvalId, count: count() })}`);
  events.closeEventLog(); workspaceDb.closeWorkspaceDb();
} else {
  afterEach(clearFixture);
  after(() => { events.closeEventLog(); workspaceDb.closeWorkspaceDb(); rmSync(HOME, { recursive: true, force: true }); });

  test('exact press approval executes once; concurrent and restarted replays rejoin its durable occurrence', async () => {
    const { record, input, prepared } = fixture('press-once');
    const before = count();
    const results = await Promise.all([press.consumeSpaceActionPress(record.id, input, prepared.pressToken),
      press.consumeSpaceActionPress(record.id, input, prepared.pressToken)]);
    assert.equal(results[0]!.ok, true);
    assert.ok(results[1]!.ok || results[1]!.status === 'uncertain', 'duplicate rejoins its original status, not another executor');
    assert.equal(count(), before + 1);
    assert.equal(results[0]!.approvalId, results[1]!.approvalId);
    const row = approvals.get(results[0]!.approvalId)!;
    assert.equal(row.resolver, gate.SPACE_BUTTON_PRESS_RESOLVER);
    assert.equal(approvals.approvalDecidedByPerson(row), true);
    assert.equal(events.listEvents(`space-${record.id}`, { types: ['approval_requested'] }).length, 0);
    events.closeEventLog(); workspaceDb.closeWorkspaceDb();
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url),
      JSON.stringify({ slug: record.id, input, token: prepared.pressToken })], { cwd: process.cwd(),
      env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_PRESS_PROCESS_MODE: '1' }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /PRESS_RESULT:\{"ok":true/);
    assert.equal(count(), before + 1, 'a different process reads the original settled result, no new body');
    assert.equal(data.listNotes(record.id).filter(note => note.meta?.approvalId === row.approvalId).length, 1);
    const next = press.prepareSpaceActionPress(record.id, { ...input, documentId: 'doc_next_explicit_click' });
    assert.equal(next.kind, 'prepared', 'a known completed prior effect allows a separate explicit press');
  });

  test('forged, wrong document, action, arguments and view bindings cannot consume a press', async () => {
    const { record, input, prepared, view } = fixture('press-bindings');
    const before = count();
    for (const changed of [{ ...input, documentId: 'doc_foreign' }, { ...input, actionId: 'other' },
      { ...input, args: { message: 'changed' } }, { ...input, expectedViewRevision: '0'.repeat(64) }]) {
      await assert.rejects(() => press.consumeSpaceActionPress(record.id, changed, prepared.pressToken), /does not match/);
    }
    await assert.rejects(() => press.consumeSpaceActionPress(record.id, input, prepared.pressToken.slice(0, -2) + 'ff'), /does not match/);
    writeFileSync(view, '<button>Different page</button>');
    await assert.rejects(() => press.consumeSpaceActionPress(record.id, input, prepared.pressToken), /page or button changed/);
    assert.equal(count(), before);
    assert.equal(approvals.get(bindings.parseSpaceActionPressToken(prepared.pressToken)!.approvalId)?.status, 'pending');
  });

  test('expired, account-drifted and schema-drifted press proofs remain zero body', async () => {
    const expired = fixture('press-expired');
    const id = bindings.parseSpaceActionPressToken(expired.prepared.pressToken)!.approvalId;
    events.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
      .run('2020-01-01T00:00:00.000Z', id);
    const before = count();
    await assert.rejects(() => press.consumeSpaceActionPress(expired.record.id, expired.input, expired.prepared.pressToken), /expired/);
    for (const [slug, accountId, schema] of [['press-account', 'account.foreign', 'schema.press.fixture'],
      ['press-schema', 'account.press.fixture', 'schema.foreign']]) {
      clearFixture(); const item = fixture(slug!); clearFixture(); installFixture(accountId, schema);
      await assert.rejects(() => press.consumeSpaceActionPress(item.record.id, item.input, item.prepared.pressToken), /connection or tool changed/);
    }
    assert.equal(count(), before);
  });

  test('new documents and edited views cannot create fresh occurrences while the same effect is unresolved', async () => {
    const item = fixture('press-unresolved');
    const beforeRows = approvals.listPending({ sessionId: `space-${item.record.id}`, status: 'any' }).length;
    const fresh = () => ({ ...item.input, documentId: 'doc_reloaded',
      expectedViewRevision: bindings.workspacePressViewRevision(store.spaceStore.get(item.record.id)!) });
    assert.throws(() => press.prepareSpaceActionPress(item.record.id, fresh()), /already pending|unconfirmed effect/);
    const approvalId = bindings.parseSpaceActionPressToken(item.prepared.pressToken)!.approvalId;
    assert.equal(approvals.resolve(approvalId, 'approved', gate.SPACE_BUTTON_PRESS_RESOLVER).ok, true);
    writeFileSync(item.view, '<button data-clem-action="publish">New presentation, same effect</button>');
    assert.throws(() => press.prepareSpaceActionPress(item.record.id, fresh()), /unconfirmed effect/);
    data.appendNote(item.record.id, { text: 'Fixture outcome remains uncertain.', kind: 'action', meta: { approvalId, status: 'uncertain' } });
    assert.throws(() => press.prepareSpaceActionPress(item.record.id, fresh()), /unconfirmed effect/);
    assert.equal(approvals.listPending({ sessionId: `space-${item.record.id}`, status: 'any' }).length, beforeRows,
      'all three refusals preserve the original occurrence without another approval');
    const changedIntent = press.prepareSpaceActionPress(item.record.id, { ...fresh(), args: { message: 'different explicit intent' } });
    assert.equal(changedIntent.kind, 'prepared', 'unrelated explicit effect is not globally blocked');
  });

  test('retained legacy approvals without press metadata still block duplicate uncertain effects', () => {
    const item = fixture('press-legacy-unresolved');
    events.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
      .run('2020-01-01T00:00:00.000Z', bindings.parseSpaceActionPressToken(item.prepared.pressToken)!.approvalId);
    const legacy = gate.enqueueSpaceActionApproval(item.record, item.record.actions[0]!, item.input.args);
    assert.equal(approvals.resolve(legacy.approvalId, 'approved', 'workspace-user').ok, true);
    const beforeRows = approvals.listPending({ sessionId: `space-${item.record.id}`, status: 'any' }).length;
    assert.throws(() => press.prepareSpaceActionPress(item.record.id, { ...item.input, documentId: 'doc_reloaded' }), /unconfirmed effect/);
    data.appendNote(item.record.id, { text: 'Fixture historical effect uncertain.', kind: 'action',
      meta: { approvalId: legacy.approvalId, status: 'uncertain' } });
    assert.throws(() => press.prepareSpaceActionPress(item.record.id, { ...item.input, documentId: 'doc_reloaded' }), /unconfirmed effect/);
    assert.equal(approvals.listPending({ sessionId: `space-${item.record.id}`, status: 'any' }).length, beforeRows);
  });

  test('public routes require parent metadata, reject naked press, validate direct revision, and rejoin an exact token', async () => {
    const { default: express } = await import('express');
    const { registerSpaceRoutes } = await import('../dashboard/space-routes.js');
    const item = fixture('press-http');
    // The helper-created proof is not the route under test; expire it without
    // accepting an effect, then let the trusted parent prepare its own one.
    events.openEventLog().prepare('UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?')
      .run('2020-01-01T00:00:00.000Z', bindings.parseSpaceActionPressToken(item.prepared.pressToken)!.approvalId);
    let authorized = false;
    const app = express(); app.use(express.json()); registerSpaceRoutes(app, () => authorized);
    const server = await new Promise<import('node:http').Server>(resolve => { const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate)); });
    const address = server.address() as import('node:net').AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const target = `${base}/api/console/spaces/${item.record.id}/action`;
    const post = (url: string, body: unknown, parent = false) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(parent ? { origin: base, 'sec-fetch-site': 'same-origin',
        'X-Clem-Workspace-Gesture': 'declared-button-v1' } : {}) }, body: JSON.stringify(body) });
    try {
      assert.equal((await post(`${target}/prepare-press`, item.input, true)).status, 401);
      authorized = true;
      assert.equal((await post(`${target}/prepare-press`, item.input)).status, 403);
      assert.equal((await post(target, { actionId: 'publish', args: item.input.args, press: true })).status, 400);
      const preparedResponse = await post(`${target}/prepare-press`, item.input, true);
      assert.equal(preparedResponse.status, 200);
      assert.equal(preparedResponse.headers.get('cache-control'), 'no-store');
      const prepared = await preparedResponse.json() as { pressToken: string };
      const unresolved = await post(`${target}/prepare-press`, { ...item.input, documentId: 'doc_reloaded' }, true);
      assert.equal(unresolved.status, 409);
      assert.equal((await unresolved.json() as { effectState: string }).effectState, 'uncertain');
      const before = count();
      const [first, replay] = await Promise.all([post(target, { ...item.input, pressToken: prepared.pressToken }),
        post(target, { ...item.input, pressToken: prepared.pressToken })]);
      assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
      assert.ok(replay.status === 200 || replay.status === 409, 'duplicate returns the original result or its in-progress status');
      assert.equal(count(), before + 1);
      const bad = await post(target, { ...item.input, args: { message: 'wrong' }, pressToken: prepared.pressToken });
      assert.equal(bad.status, 409);
      assert.equal((await bad.json() as { effectState: string }).effectState, 'not_started');
      // A direct/legacy action remains on its normal authorization path.
      const legacy = store.spaceStore.save({ id: 'press-http-legacy', title: 'Legacy fixture',
        actions: [{ id: 'legacy', runner: 'legacy.mjs', confirm: true }] });
      const file = store.resolveInSpace(legacy.id, legacy.viewEntry); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '<button>Legacy</button>');
      const legacyInput = { documentId: 'doc_legacy', expectedViewRevision: bindings.workspacePressViewRevision(legacy), actionId: 'legacy', args: {} };
      const direct = await post(`${base}/api/console/spaces/${legacy.id}/action/prepare-press`, legacyInput, true);
      assert.deepEqual(await direct.json(), { kind: 'direct' });
      writeFileSync(file, '<button>Changed legacy page</button>');
      assert.equal((await post(`${base}/api/console/spaces/${legacy.id}/action`, legacyInput)).status, 409);
      const ordinary = await post(`${base}/api/console/spaces/${legacy.id}/action`, { actionId: 'legacy', args: {} });
      assert.equal(ordinary.status, 202, 'a normal request still receives its existing card');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
