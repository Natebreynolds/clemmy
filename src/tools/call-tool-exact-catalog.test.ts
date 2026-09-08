/** Run only via scripts/run-tests-isolated.mjs. No model, network or owner-home access. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-catalog-call-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  OPENAI_AGENTS_DISABLE_TRACING: '1' });
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No real provider I/O in exact catalog fixture'); };
const events = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const stores = await import('../runtime/harness/capability-manifest-store.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const authority = await import('../runtime/harness/accepted-turn-call-authority.js');
const bindings = await import('../runtime/harness/host-call-capability-binding.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const contracts = await import('../runtime/harness/logical-call-contract.js');
const brackets = await import('../runtime/harness/brackets.js');
const { buildCallTool } = await import('./call-tool.js');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = 'reviewed_cli_exact_catalog_read';
type Manifest = import('../runtime/harness/capability-manifest.js').CapabilityManifestV1;
type Attestation = import('../runtime/harness/accepted-turn-call-authority.js').HostCallAttestation;
type ToolLike = { invoke(context: unknown, input: string, details?: unknown): Promise<unknown> };

afterEach(() => { catalogs.installHostCapabilityCatalogFactory(null); stores.installCapabilityManifestStore(null); ports.clearProductionCapabilityPorts(); });
after(() => { events.closeEventLog(); globalThis.fetch = oldFetch; rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const nonce = randomUUID();
  const calls: Array<{ capabilityId: string; account: string; payload: unknown; sourceUserSeq: number; sessionId: string }> = [];
  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = stores.createCapabilityManifestStore([], { durable: true });
  catalogs.installHostCapabilityCatalogFactory(factory); stores.installCapabilityManifestStore(store);
  const make = (label: string, account = 'account-selected'): Manifest => manifests.attachSemanticContract({
    version: 1, manifestId: `cap:exact-catalog:${nonce}:${label}`, providerKind: 'reviewed_cli',
    operationId, providerIdentity: '/fixture/immutable-reviewed-cli', providerVersion: 'binary-v1',
    operationVersion: '1', definitionFingerprint: hash('exact input schema'), effect: 'read', accountId: account,
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['payload'], readbackRequired: false },
    purpose: 'collect_records', provenance: { issuer: 'isolated:exact-catalog-fixture', trusted: true,
      issuedAt: '2026-09-08T00:00:00.000Z' }, lifecycle: { state: 'current' },
    invokePortId: `fixture:exact-invoke:${nonce}:${label}`, argumentCompiler: { id: 'fixture:args', version: '1' },
  });
  const entryFor = (manifest: Manifest): catalogs.RegisteredHostCapability => ({
    capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, manifest,
    invoke: async () => { throw new Error('Never use a mutable catalog callback as the execution port'); },
  });
  const install = (manifest: Manifest) => {
    assert.equal(store.install(manifest).ok, true);
    factory.register(entryFor(manifest));
    assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
      invoke: async input => {
        assert.equal(input.binding?.capabilityId, manifest.manifestId);
        assert.equal(input.binding?.manifestDigest, manifests.capabilityManifestDigest(manifest));
        assert.equal(input.binding?.account, manifest.accountId);
        calls.push({ capabilityId: manifest.manifestId, account: manifest.accountId,
          payload: input.payload, sessionId: input.identity.sessionId, sourceUserSeq: input.identity.sourceUserSeq });
        return { successful: true, data: { selected: manifest.manifestId, rows: [{ value: 17 }] } };
      },
    }).ok, true);
  };
  const sibling = make('a-sibling'); const selected = make('z-selected'); const foreign = make('b-foreign', 'account-foreign');
  [sibling, foreign, selected].forEach(install);
  return { calls, factory, store, sibling, selected, foreign, entryFor };
}

async function acceptedCall(f: ReturnType<typeof fixture>, input: {
  mutate?: (attestation: Attestation) => void;
  requestArgs?: Record<string, unknown>;
  incomingAttestation?: (attestation: Attestation) => Attestation;
  omitDurableBinding?: boolean;
} = {}) {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Read the selected account records.' } });
  const args = { query: 'SELECT Id FROM Account' };
  const taskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const contract = contracts.durableLogicalCallContract(taskId, operationId, args);
  assert.ok(contract);
  const catalogRevisionDigest = hash(`catalog:${session.id}`); const bindingRevisionDigest = hash(`binding:${session.id}`);
  assert.equal(authority.armHostCallAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
    catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 4, maxParallelCalls: 1 }).status, 'armed');
  const root = authority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(root.status, 'ok'); if (root.status !== 'ok') throw new Error(root.reason);
  const logicalToolCallId = `call-${randomUUID()}`;
  const base = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: taskId,
    sourceEventId: root.authority.sourceEventId, sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId, toolName: contract.toolName, argumentDigest: contract.argumentDigest,
    effect: 'read' as const, bindingKind: 'catalog_manifest' as const, capabilityId: f.selected.manifestId,
    schemaFingerprint: f.selected.definitionFingerprint, accountId: f.selected.accountId,
    invokePortId: f.selected.invokePortId, operationId, manifestId: f.selected.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(f.selected), engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion, authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision, surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest, bindingRevisionDigest };
  const attestation: Attestation = { ...base, bindingDigest: bindings.hostCallAttestationBindingDigest(base) };
  const callTool = buildCallTool({ reachableBuiltinNames: new Set(['work_call']) }) as unknown as ToolLike;
  const context = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  let returned: unknown; let thrown: unknown;
  await brackets.withHarnessRunContext({ ...context, counter: new brackets.ToolCallsCounter(10), hostOwnsToolDeadlineAndSettlement: true },
    () => authority.withHostCallAttestation(attestation, () => identities.withLogicalToolCall({ ...context,
      logicalToolCallId, tool: operationId, args }, async () => {
      if (!input.omitDurableBinding) {
        const admitted = bindings.persistHostCallCapabilityBinding({ db: events.openEventLog(),
          attestation: authority.currentHostCallAttestation(), ...context, logicalToolCallId,
          acceptedTaskId: taskId, toolName: contract.toolName, argumentDigest: contract.argumentDigest, effect: 'read' });
        assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
      }
      input.mutate?.(attestation);
      try {
        const invoke = () => callTool.invoke({ context }, JSON.stringify({ name: operationId,
          args_json: JSON.stringify(input.requestArgs ?? args) }), { toolCall: { callId: logicalToolCallId } });
        returned = input.incomingAttestation
          ? await authority.withHostCallAttestation(input.incomingAttestation(attestation), invoke)
          : await invoke();
      } catch (error) { thrown = error; }
    })));
  const settled = events.openEventLog().prepare('SELECT outcome_kind, physical_crossing_count FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(session.id, source.seq, logicalToolCallId) as { outcome_kind: string; physical_crossing_count: number } | undefined;
  return { returned, thrown, context, settled, logicalToolCallId };
}

test('the real dispatcher invokes only the attested production port among same-name same/different-account rows', async () => {
  const f = fixture(); const out = await acceptedCall(f);
  assert.equal(out.thrown, undefined); const payload = JSON.parse(String(out.returned));
  assert.equal(payload.error, undefined, JSON.stringify(payload));
  assert.equal(payload.data.selected, f.selected.manifestId);
  assert.deepEqual(f.calls, [{ capabilityId: f.selected.manifestId, account: f.selected.accountId,
    payload: { query: 'SELECT Id FROM Account' }, sessionId: out.context.sessionId, sourceUserSeq: out.context.sourceUserSeq }]);
  assert.equal(out.settled?.outcome_kind, 'succeeded');
});

for (const [name, mutate] of [
  ['missing exact row despite a same-account sibling', (f: ReturnType<typeof fixture>) => f.factory.forget(f.selected.manifestId)],
  ['revoked exact manifest', (f: ReturnType<typeof fixture>) => f.store.revoke(f.selected.manifestId)],
  ['superseded exact manifest', (f: ReturnType<typeof fixture>) => f.store.supersede(f.selected.manifestId, { ...f.selected, manifestId: `${f.selected.manifestId}:successor` })],
  ['changed catalog account', (f: ReturnType<typeof fixture>) => f.factory.register(f.entryFor({ ...f.selected, accountId: 'account-foreign' }))],
  ['changed schema fingerprint', (f: ReturnType<typeof fixture>) => f.factory.register(f.entryFor({ ...f.selected, definitionFingerprint: hash('different schema') }))],
  ['changed invoke port identity', (f: ReturnType<typeof fixture>) => f.factory.register(f.entryFor({ ...f.selected, invokePortId: 'fixture:changed-port' }))],
  ['missing immutable port', () => ports.clearProductionCapabilityPorts()],
] as const) {
  test(`${name} is an identity refusal, never a name fallback or argument repair`, async () => {
    const f = fixture(); const out = await acceptedCall(f, { mutate: () => { mutate(f); } });
    assert.equal(out.thrown, undefined, String(out.thrown));
    const refusal = JSON.parse(String(out.returned));
    assert.equal(refusal.error, 'not_reachable'); assert.equal(refusal.reason, 'exact_catalog_binding_missing');
    assert.equal(refusal.repair, undefined); assert.equal(out.settled?.outcome_kind, 'policy_denial');
    assert.equal(out.settled?.physical_crossing_count, 0); assert.deepEqual(f.calls, []);
  });
}

test('a missing durable host binding cannot borrow a current catalog row', async () => {
  const f = fixture(); const out = await acceptedCall(f, { omitDurableBinding: true });
  assert.match(String(out.returned ?? out.thrown), /exact_catalog_binding_missing|host.*binding|authority/i);
  assert.deepEqual(f.calls, []);
});

test('a modified account attestation cannot replace its durable host binding', async () => {
  const f = fixture(); const out = await acceptedCall(f, { incomingAttestation: attestation => {
    const changed = { ...attestation, accountId: f.foreign.accountId };
    return { ...changed, bindingDigest: bindings.hostCallAttestationBindingDigest(changed) };
  } });
  assert.match(String(out.returned ?? out.thrown), /exact_catalog_binding_missing|authority|binding/i);
  assert.deepEqual(f.calls, []);
});

test('different argument bytes cannot ride the exact accepted call', async () => {
  const f = fixture(); const out = await acceptedCall(f, { requestArgs: { query: 'SELECT Secret FROM Account' } });
  assert.deepEqual(f.calls, []);
  // This is an actual logical identity violation, not permission to refine an
  // arbitrary payload after acceptance. Existing settlement guards may throw.
  assert.match(String(out.returned ?? out.thrown), /ToolAttemptSettlementAuthorityError:.*logical call contract conflicts|accepted_arguments_mismatch/);
  const logical = events.openEventLog().prepare('SELECT state FROM logical_tool_calls WHERE session_id=? AND logical_tool_call_id=?').get(out.context.sessionId, out.logicalToolCallId) as { state: string };
  assert.equal(logical.state, 'conflict', 'different accepted argument bytes retain the real identity-conflict boundary');
  assert.ok(!String(out.returned ?? out.thrown).includes('arg_validation'));
});

// Name uniqueness is retained solely for callers without host attestation.
test('unattested duplicate catalog names still refuse instead of guessing an account', async () => {
  const f = fixture();
  const configured = buildCallTool({ reachableBuiltinNames: new Set(['work_call']) }) as unknown as ToolLike;
  const out = await configured.invoke({}, JSON.stringify({ name: operationId, args_json: '{"query":"SELECT Id"}' }));
  assert.match(String(out), /not_reachable/); assert.deepEqual(f.calls, []);
});


test('a catalog removed during port preparation cannot cross on its earlier selection', async () => {
  const f = fixture();
  let preparations = 0; let entered = 0;
  const out = await acceptedCall(f, { mutate: () => {
    ports.clearProductionCapabilityPorts();
    assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(f.selected), {
      admitPreparation() {},
      async prepareInvocation() { preparations += 1; f.factory.forget(f.selected.manifestId); return Object.freeze({}); },
      async invokeWithPreparation(_proof, work) { return work(); },
      async invoke() { entered += 1; return { successful: true }; },
    }).ok, true);
  } });
  assert.equal(preparations, 1); assert.equal(entered, 0); assert.deepEqual(f.calls, []);
  assert.equal(out.thrown, undefined);
  const refusal = JSON.parse(String(out.returned));
  assert.equal(refusal.reason, 'exact_catalog_binding_missing');
  assert.equal(refusal.bindingReason, 'accepted_catalog_identity_unavailable');
  assert.equal(out.settled?.outcome_kind, 'policy_denial');
});

test('an attestation for another source cannot be used inside this accepted logical call', async () => {
  const f = fixture(); const out = await acceptedCall(f, { incomingAttestation: attestation => {
    const foreign = events.appendEvent({ sessionId: attestation.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Unrelated later source.' } });
    return { ...attestation, sourceUserSeq: foreign.seq,
      acceptedTaskId: identities.acceptedTaskIdFor(attestation.sessionId, foreign.seq),
      sourceEventId: foreign.id, sourceEventDigest: hash('cannot match the actual foreign root') };
  } });
  assert.deepEqual(f.calls, []);
  assert.match(String(out.returned ?? out.thrown), /accepted_operation_mismatch|authority|binding/i);
});
