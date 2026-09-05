import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-direct-consent-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const bindings = await import('./host-call-capability-binding.js');
const dispatch = await import('./dispatch-ledger.js');
const contracts = await import('./logical-call-contract.js');
const manifests = await import('./capability-manifest.js');
const stores = await import('./capability-manifest-store.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const { canonicalExternalInputSchemaDigestV1 } = await import('./external-capability-risk-loader.js');
const consent = await import('./host-interactive-consent.js');
const approvals = await import('./approval-registry.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const inputSchema = {
  type: 'object', properties: { body: { type: 'string' } },
  required: ['body'], additionalProperties: false,
};
const schemaDigest = canonicalExternalInputSchemaDigestV1(inputSchema)!;

after(() => {
  stores.installCapabilityManifestStore(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function exactCall(kind: 'draft' | 'send' | 'delete' | 'admin' | 'unknown') {
  const sessionId = `direct-consent-${randomUUID()}`;
  const operationId = { draft: 'EXAMPLE_CREATE_DRAFT', send: 'EXAMPLE_SEND_MESSAGE',
    delete: 'EXAMPLE_DELETE_RECORD', admin: 'EXAMPLE_ROTATE_API_KEY', unknown: 'EXAMPLE_RECORD' }[kind];
  const effect = kind === 'admin' ? 'admin' as const : 'external_write' as const;
  const capabilityId = `cap:direct:${kind}`;
  const accountId = 'account:direct:owner';
  const fingerprint = sha(`${operationId}:${schemaDigest}`);
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: capabilityId, providerKind: 'composio', operationId,
    providerIdentity: 'composio:direct-fixture', providerVersion: 'catalog-v1',
    operationVersion: '1', definitionFingerprint: fingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest: schemaDigest,
      semanticName: operationId,
      behaviorHints: { readOnly: false, destructive: kind === 'delete', idempotent: null, openWorld: false } },
    effect, accountId,
    ...(kind === 'draft' ? { operationSemantics: { version: 1 as const, reversibility: 'reversible' as const } } : {}),
    destination: { family: 'external_resource', posture: kind === 'draft' ? 'create_new' : 'named_existing' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'result' }, purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'], producedOutputKinds: ['result'], applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:direct-consent:test', issuedAt: '2026-09-04T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId: 'host:direct-fixture:invoke',
    argumentCompiler: { id: 'host:json', version: '1' },
  });
  const manifestDigest = manifests.capabilityManifestDigest(manifest);
  const store = stores.createCapabilityManifestStore([], { durable: true });
  assert.equal(store.install(manifest).ok, true);
  stores.installCapabilityManifestStore(store);
  const catalog = catalogs.createHostCapabilityCatalogFactory();
  catalog.register({ capabilityId, toolName: operationId, schemaVersion: '1',
    schemaDigest: fingerprint, providerInputSchemaDigest: schemaDigest, effect, account: accountId,
    destination: manifest.destination, manifestDigest, providerKind: 'composio', liveFingerprint: fingerprint,
    manifest, invoke: async () => { throw new Error('consent must never invoke the business tool'); } });
  catalogs.installHostCapabilityCatalogFactory(catalog);
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId, accountId,
    definitionFingerprint: fingerprint, providerVersion: manifest.providerVersion,
    operationVersion: '1', observedAt: Date.now(), origin: 'independent' }).ok, true);
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Perform this exact nominated operation on the connected account.' } });
  const catalogRevisionDigest = sha(`catalog:${sessionId}`);
  const bindingRevisionDigest = sha(`binding:${sessionId}`);
  const root = authority.armHostCallAuthority({ sessionId, sourceUserSeq: source.seq,
    catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 8, maxParallelCalls: 2 });
  assert.equal(root.status, 'armed');
  if (root.status !== 'armed') throw new Error('fixture root missing');
  const acceptedTaskId = root.authority.identity.acceptedTaskId;
  const args = { body: 'Exact requested content.' };
  const logical = contracts.durableLogicalCallContract(acceptedTaskId, operationId, args)!;
  const logicalToolCallId = 'nominated-call';
  const base = { sessionId, sourceUserSeq: source.seq, acceptedTaskId,
    sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId, toolName: logical.toolName, argumentDigest: logical.argumentDigest,
    effect, bindingKind: 'catalog_manifest' as const, capabilityId, providerInputSchemaDigest: schemaDigest,
    schemaFingerprint: fingerprint, accountId, invokePortId: manifest.invokePortId,
    operationId, manifestId: manifest.manifestId, manifestDigest,
    engineVersion: root.authority.engineVersion, surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest, authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest, catalogRevisionDigest, bindingRevisionDigest };
  const attestation = { ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) };
  authority.withHostCallAttestation(attestation, () => {
    const admitted = dispatch.admitLogicalCall({ identity: { sessionId, sourceUserSeq: source.seq,
      acceptedTaskId, logicalToolCallId }, tool: operationId, args });
    assert.equal(admitted.status, 'inserted', JSON.stringify(admitted));
    const bound = bindings.persistHostCallCapabilityBinding({ db: eventlog.openEventLog(),
      attestation, sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId,
      toolName: logical.toolName, argumentDigest: logical.argumentDigest, effect });
    assert.equal(bound.status, 'bound', JSON.stringify(bound));
  });
  const request = { attestation, args, inputSchema };
  const result = await consent.evaluateUncoveredHostMutationConsent(request);
  assert.equal(eventlog.getTurnGraphEventForSource(sessionId, source.seq), null);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(sessionId) as { n: number }).n, 0);
  return { result, request };
}

test('unknown current mutation semantics remain repair, never an invented approval or automatic write', async () => {
  const { result } = await exactCall('unknown');
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided') return;
  assert.deepEqual(result.decision, { kind: 'repair', reason: 'risk_unknown' });
  assert.equal(result.consentSubject, undefined);
});

test('the exact approved direct call reuses the same risk subject and rejects changed scope', async () => {
  const { result, request } = await exactCall('send');
  assert.equal(result.status, 'decided');
  if (result.status !== 'decided' || !result.consentSubject) throw new Error('approval subject missing');
  const subject = result.consentSubject;
  const raw = JSON.stringify(request.args);
  const approval = approvals.registerResumable({ sessionId: request.attestation.sessionId,
    subject: 'Approve this exact send.', tool: request.attestation.toolName, args: request.args,
    resumeKey: consent.hostInteractiveConsentApprovalResumeKey(subject)! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'direct-consent-test').ok, true);
  const durableApproval = { approvalId: approval.approvalId, persistedSubject: subject,
    outerToolName: request.attestation.toolName, outerRawArguments: raw };
  const approved = await consent.evaluateUncoveredHostMutationConsent({ ...request, durableApproval });
  assert.equal(approved.status, 'decided', JSON.stringify(approved));
  if (approved.status !== 'decided') return;
  assert.equal(approved.decision.kind === 'proceed' ? approved.decision.basis : null, 'exact_user_grant');
  assert.deepEqual(approved.call, result.call, 'effect, reversibility, account, schema and risk bytes pass through unchanged');
  assert.deepEqual(approved.coverage, result.coverage);
  const wrongSubject = await consent.evaluateUncoveredHostMutationConsent({ ...request,
    durableApproval: { ...durableApproval, persistedSubject: { ...subject, riskDigest: '0'.repeat(64) } } });
  assert.equal(wrongSubject.status, 'decided');
  assert.equal(wrongSubject.status === 'decided' ? wrongSubject.decision.kind : null, 'repair');
  for (const changed of [
    { ...request, args: { body: 'Changed content' } },
    { ...request, attestation: { ...request.attestation, accountId: 'another-account' } },
    { ...request, inputSchema: { ...inputSchema, required: [] } },
  ]) {
    const refused = await consent.evaluateUncoveredHostMutationConsent({ ...changed, durableApproval });
    assert.notEqual(refused.status, 'decided', 'scope drift never redeems a grant');
  }
});

test('cached schema fallback is exact and a started crossing is reconcile-only', async () => {
  const { request } = await exactCall('draft');
  schemaCache.rememberToolSchema(request.attestation.operationId, inputSchema, Date.now(), '1');
  const cached = await consent.evaluateUncoveredHostMutationConsent({ attestation: request.attestation, args: request.args });
  assert.equal(cached.status === 'decided' ? cached.decision.kind : null, 'proceed');
  const started = authority.withHostCallAttestation(request.attestation, () => dispatch.beginPhysicalDispatch({
    identity: { sessionId: request.attestation.sessionId, sourceUserSeq: request.attestation.sourceUserSeq,
      acceptedTaskId: request.attestation.acceptedTaskId, logicalToolCallId: request.attestation.logicalToolCallId,
      physicalDispatchId: 'possibly-crossed', ordinal: 0 },
    tool: request.attestation.toolName, args: request.args, executionSite: 'host',
  }));
  assert.equal(started.status, 'inserted', JSON.stringify(started));
  const repeated = await consent.evaluateUncoveredHostMutationConsent(request);
  assert.equal(repeated.status, 'decided', JSON.stringify(repeated));
  assert.deepEqual(repeated.status === 'decided' ? repeated.decision : null,
    { kind: 'reconcile', reason: 'possible_effect', retry: 'never_blind' });
});

test('an exact graph-neutral reversible draft reaches the existing reducer without an approval card', async () => {
  const { result } = await exactCall('draft');
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided') return;
  assert.equal(result.decision.kind, 'proceed', JSON.stringify(result));
  assert.equal(result.decision.kind === 'proceed' ? result.decision.basis : null, 'exact_reversible_work');
  assert.equal(result.call.risk.reversibility, 'reversible');
  assert.ok(result.coverage);
  assert.equal(result.consentSubject, undefined);
});

for (const kind of ['send', 'delete', 'admin'] as const) {
  test(`an exact graph-neutral ${kind} retains the reducer's genuine approval subject`, async () => {
    const { result } = await exactCall(kind);
    assert.equal(result.status, 'decided', JSON.stringify(result));
    if (result.status !== 'decided') return;
    assert.equal(result.decision.kind, 'needs_user', JSON.stringify(result));
    assert.equal(result.decision.kind === 'needs_user' ? result.decision.need : null, 'approval');
    assert.equal(result.call.risk.consequence, kind);
    assert.equal(result.call.accountId, 'account:direct:owner');
    assert.ok(result.consentSubject);
  });
}
