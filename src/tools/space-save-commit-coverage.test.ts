/** Actual Space producer → committed-byte reader controls. No LLM/network.
 * The success refresh uses the existing kernel fixture-port seam, never a
 * mocked receipt or a raw Space gateway. Run through the isolated wrapper. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-space-save-coverage-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const { registerSpaceTools } = await import('./space-tools.js');
const store = await import('../spaces/store.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const proof = await import('../runtime/harness/host-local-write-commit.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
const tools: Record<string, Handler> = {};
registerSpaceTools({ tool(name: string, _description: string, _schema: unknown, handler: Handler) { tools[name] = handler; } } as unknown as Parameters<typeof registerSpaceTools>[0]);
const text = (value: unknown): string => (value as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
const html = '<html><body><h1>Board</h1><p>One complete local document.</p></body></html>';
const digest = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');

function checked(result: unknown) {
  const facts = proof.parseHostLocalWriteCommitFacts(text(result));
  assert.ok(facts, text(result));
  assert.equal(facts.handle, `spaces/${facts.createdId}/.clementine-workspace-commit.json`);
  const content = proof.readCommittedArtifactContent(facts);
  assert.equal(content.verified, true, content.unresolvedReason);
  const manifest = content.parts.find((part) => part.role === 'manifest');
  const view = content.parts.find((part) => part.role === 'view');
  assert.ok(manifest); assert.ok(view);
  return { facts, content, manifest: JSON.parse(manifest.bytes.toString('utf8')), view: view.bytes.toString('utf8') };
}

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations(); ports.clearProductionCapabilityPorts();
  workspaceDb.closeWorkspaceDb(); eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

test('HTML-only creation and metadata-only save cover the changed manifest without fabricating data', async () => {
  const slug = 'receipt-title';
  const firstResult = await tools.space_save({ slug, title: 'Board', view_html: html });
  const firstFacts = proof.parseHostLocalWriteCommitFacts(text(firstResult)); assert.ok(firstFacts);
  const first = { facts: firstFacts, view: readFileSync(store.resolveInSpace(slug, 'view/index.html'), 'utf8') };
  const secondResult = await tools.space_save({ slug, title: 'Board reviewed' });
  assert.equal(store.spaceStore.get(slug)?.title, 'Board reviewed', 'the actual metadata mutation succeeded');
  const secondFacts = proof.parseHostLocalWriteCommitFacts(text(secondResult)); assert.ok(secondFacts);
  assert.ok(proof.readCommittedArtifactContent(secondFacts).parts.some((part) => part.role === 'manifest'),
    'successful title-only mutation must expose its changed manifest, not only unchanged HTML');
  const second = checked(secondResult);
  assert.equal(second.manifest.title, 'Board reviewed');
  assert.equal(second.manifest.version, 1, 'metadata does not invent a view revision');
  assert.equal(second.view, html);
  assert.equal(first.view, second.view);
  assert.notEqual(first.facts.contentDigest, second.facts.contentDigest, 'unchanged HTML cannot stand in for metadata proof');
  assert.deepEqual(second.content.parts.map((part) => part.role), ['manifest', 'view']);
  assert.equal(existsSync(store.resolveInSpace(slug, 'data.json')), false);
  const descriptor = JSON.parse(readFileSync(path.join(home, second.facts.handle), 'utf8'));
  assert.equal(descriptor.version, 2); assert.equal(descriptor.dataAbsent, true);
  assert.equal(proof.readCommittedArtifactContent(first.facts).verified, false, 'the older descriptor is superseded');
  const manifestPath = store.resolveInSpace(slug, 'space.json');
  const savedManifest = readFileSync(manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...second.manifest, title: 'Foreign title' }));
  assert.equal(proof.readCommittedArtifactContent(second.facts).verified, false, 'title drift invalidates the receipt');
  writeFileSync(manifestPath, savedManifest);
  writeFileSync(store.resolveInSpace(slug, 'data.json'), '{}');
  assert.equal(proof.readCommittedArtifactContent(second.facts).verified, false, 'absent → present is a real snapshot change');
  rmSync(store.resolveInSpace(slug, 'data.json'));
  writeFileSync(store.resolveInSpace(slug, 'view/index.html'), html + 'changed');
  assert.equal(proof.readCommittedArtifactContent(second.facts).verified, false, 'current view drift invalidates metadata receipt');
});

test('metadata plus view update covers both files and preserves existing observed data byte-for-byte', async () => {
  const slug = 'receipt-view-data';
  const existingData = { _mobile: { headline: [{ label: 'Count', value: '3' }] }, count: 3 };
  await tools.space_save({ slug, title: 'Before', view_html: html, initial_data_json: JSON.stringify(existingData) });
  const priorData = readFileSync(store.resolveInSpace(slug, 'data.json'));
  const result = await tools.space_save({ slug, title: 'After', view_html: html.replace('Board', 'Revised') });
  const saved = checked(result);
  assert.equal(saved.manifest.title, 'After'); assert.equal(saved.manifest.version, 2);
  assert.match(saved.view, /Revised/);
  const part = saved.content.parts.find((part) => part.role === 'data'); assert.ok(part);
  assert.equal(digest(part.bytes), digest(priorData));
  assert.equal(digest(readFileSync(store.resolveInSpace(slug, 'data.json'))), digest(priorData));
  assert.doesNotMatch(text(result), /Data refreshed:/, 'observed existing data is not a new acquisition');
  writeFileSync(store.resolveInSpace(slug, 'data.json'), '{"count":999}');
  assert.equal(proof.readCommittedArtifactContent(saved.facts).verified, false, 'present-data drift invalidates receipt');
  rmSync(store.resolveInSpace(slug, 'data.json'));
  assert.equal(proof.readCommittedArtifactContent(saved.facts).verified, false, 'present-data disappearance invalidates receipt');
});

test('missing static data cannot be recertified as an HTML-only Workspace', async () => {
  const slug = 'receipt-missing-static';
  await tools.space_save({ slug, title: 'Static', view_html: html, initial_data_json: '{"count":1}' });
  rmSync(store.resolveInSpace(slug, 'data.json'));
  const result = await tools.space_save({ slug, title: 'Static renamed' });
  assert.equal(proof.parseHostLocalWriteCommitFacts(text(result)), null);
  assert.match(text(result), /static data is missing/);
  assert.equal((result as { isError?: boolean }).isError, true);
});

test('ordinary final proof refuses concurrent authoring/status/view changes before stamping', async () => {
  for (const field of ['title', 'status', 'view'] as const) {
    const slug = `receipt-race-${field}`;
    await tools.space_save({ slug, title: 'Before', view_html: html });
    const original = store.spaceStore.commitSaveResult.bind(store.spaceStore);
    store.spaceStore.commitSaveResult = (input) => {
      if (field === 'view') writeFileSync(store.resolveInSpace(slug, 'view/index.html'), html + 'foreign');
      else {
        const file = store.resolveInSpace(slug, 'space.json');
        const record = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...record, [field]: field === 'title' ? 'Foreign' : 'archived' }));
      }
      return original(input);
    };
    let result: unknown;
    try { result = await tools.space_save({ slug, title: 'Intended', view_html: html.replace('Board', 'Intended') }); }
    finally { store.spaceStore.commitSaveResult = original; }
    assert.equal(proof.parseHostLocalWriteCommitFacts(text(result)), null, field);
    assert.equal((result as { isError?: boolean }).isError, true, field);
  }
});

test('absent-data descriptor rejects a symlink instead of reading or certifying it', async () => {
  const slug = 'receipt-data-link';
  const saved = checked(await tools.space_save({ slug, title: 'Link negative', view_html: html }));
  const secret = path.join(home, 'private-test.txt'); writeFileSync(secret, 'PRIVATE TEST BYTES');
  symlinkSync(secret, store.resolveInSpace(slug, 'data.json'));
  const content = proof.readCommittedArtifactContent(saved.facts);
  assert.equal(content.verified, false);
  assert.equal(content.parts.length, 0);
});

test('legacy direct view edit keeps its exact view-only receipt', async () => {
  const slug = 'receipt-view-only';
  await tools.space_save({ slug, title: 'View only', view_html: html });
  const result = await tools.space_edit_view({ slug, edits: [{ find: 'Board', replace: 'Edited' }] });
  const facts = proof.parseHostLocalWriteCommitFacts(text(result)); assert.ok(facts, text(result));
  assert.equal(facts.handle, `spaces/${slug}/view/index.html`);
  assert.deepEqual(proof.readCommittedArtifactContent(facts).parts.map((part) => part.role), ['file']);
});

test('actual contained local-runner smoke issues a truthful paused snapshot receipt without a provider body', async () => {
  const slug = 'receipt-contained-smoke';
  const view = '<html><script>clem.data().then(data => render(data.pull))</script></html>';
  store.spaceStore.save({ id: slug, title: 'Contained', viewContent: view, dataSources: [{ id: 'pull', runner: 'pull.mjs' }] });
  const runnerFile = store.resolveInSpace(slug, 'data/pull.mjs'); mkdirSync(path.dirname(runnerFile), { recursive: true });
  writeFileSync(runnerFile, 'throw new Error("RUNNER MUST NOT EXECUTE")');
  const args = { slug, title: 'Contained', data_sources: [{ id: 'pull', runner: 'pull.mjs' }] };
  const waiting = await tools.space_save(args);
  assert.equal(checked(waiting).manifest.status, 'active');
  assert.match(text(waiting), /waiting for your one-time approval/);
  const approvals = await import('../runtime/harness/approval-registry.js');
  const pending = approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' });
  assert.equal(pending.length, 1);
  eventlog.openEventLog().prepare(`UPDATE pending_approvals SET status='resolved', resolution='approved', resolver=?, resolved_at=? WHERE approval_id=? AND status='pending'`)
    .run('isolated-space-receipt-fixture', new Date().toISOString(), pending[0]!.approvalId);
  const result = await tools.space_save(args);
  const saved = checked(result);
  assert.equal(saved.manifest.status, 'paused');
  assert.match(text(result), /no shared durable call authority/);
  assert.doesNotMatch(text(result), /Data refreshed:/);
  assert.ok(workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 10 }).some((row) => row.status === 'error'));
});

// Existing durable read-kernel fixture; only the final production port is synthetic.
function installReadCapability(operationId: string): { portBodies: () => number } {
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.space.${operationId}`,
    providerKind: 'local_registry',
    operationId,
    providerIdentity: 'runtime.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema:${operationId}`),
    effect: 'read',
    accountId: `account.space.${operationId}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  let portBodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async () => {
        portBodies += 1;
        return { data: { records: [{ id: 'contact.1' }] }, successful: true };
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => {
      throw new Error('catalog invoke must not own the workspace crossing');
    },
  };
  const factory = catalogs.peekHostCapabilityCatalogFactory()
    ?? catalogs.createHostCapabilityCatalogFactory();
  factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  return { portBodies: () => portBodies };
}

test('actual successful smoke uses durable read authority and certifies post-refresh manifest/data', async () => {
  const slug = 'receipt-success-smoke';
  const operation = 'SALESFORCE_GET_CONTACTS';
  const capability = installReadCapability(operation);
  const result = await tools.space_save({
    slug, title: 'Refreshed',
    view_html: '<html><script>clem.data().then(data => render(data.contacts))</script></html>',
    data_sources: [{ id: 'contacts', composio_slug: operation }],
  });
  assert.equal(capability.portBodies(), 1, 'one registered fixture port invocation, no raw provider dispatch');
  assert.match(text(result), /Data refreshed: contacts/);
  const saved = checked(result);
  assert.equal(saved.manifest.status, 'active');
  assert.ok(saved.manifest.lastRefreshedAt);
  const data = saved.content.parts.find((part) => part.role === 'data'); assert.ok(data);
  assert.match(data.bytes.toString('utf8'), /contact\.1/);
  assert.equal(digest(data.bytes), digest(readFileSync(store.resolveInSpace(slug, 'data.json'))));
  assert.equal(JSON.parse(readFileSync(path.join(home, saved.facts.handle), 'utf8')).version, 1);
  assert.ok(workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 10 }).some((row) => row.status === 'ok'));
});
