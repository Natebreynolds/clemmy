/**
 * Pins for "one action of a multi-action tool that only reads is a read": a
 * tool that can delete declares itself destructive for every action, and its
 * list used to ask like its delete. Each pin runs the real reading (stage one
 * through the real fast-classifier client with its fetch seam, stage two
 * through the real configured-brain semantic port with an injected
 * completion), the real risk loader and the real consent reducer, through the
 * production host adapter.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-interactive-consent-variant-read.integration.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-variant-read-consent-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
const { _setApprovedWriteKindsForTests } = await import('../../agents/plan-scope.js');
_setApprovedWriteKindsForTests('all');
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
const variantRead = await import('./exact-call-variant-read.js');
const hostInvocation = await import('./host-tool-invocation.js');
const jev = await import('../jev/client.js');
const ports = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort } = await import('../semantic-boundary/configured-brain-semantic-port.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const OPERATION = 'EXAMPLE_MANAGE_SESSIONS';
const SCHEMA = {
  type: 'object',
  description: 'Manage hosted sessions. Use "list" to see existing sessions, "get" for one session\'s details, "create" to start a new session, and "delete" to end one.',
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'get', 'delete'] },
    session_id: { type: 'string', description: '(get, delete) the session to act on.' },
    query: { type: 'string', description: '(list) text filter.' },
    status: { type: 'string', enum: ['active', 'all'], description: '(list) filter by status.' },
  },
  required: ['action'],
  additionalProperties: false,
};

// ─── Model seams (no live model call, no keychain) ─────────────────────────

let jevChange = 0.03;
const jevRequests: Array<Record<string, unknown>> = [];
jev._setTypesafeKeyForTests('fixture-key');
jev._setSystemOneFetchForTests(async (_url, init) => {
  jevRequests.push(JSON.parse(init.body) as Record<string, unknown>);
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-fixture',
      answers: { changes: { type: 'noul', noul: jevChange } },
      usage: { input_tokens: 40, output_tokens: 2 },
    }),
  };
});

let judgeAnswer: { changesAnything: 'yes' | 'no' | 'uncertain'; confidence: number } = { changesAnything: 'no', confidence: 0.97 };
const judgeRequests: Array<{ purpose: string; user: string }> = [];
ports.installTurnSemanticModelPort(configuredBrainSemanticPort(async (request) => {
  judgeRequests.push(request);
  const user = JSON.parse(request.user) as { definitionDigest: string };
  return {
    raw: { ...judgeAnswer, definitionDigest: user.definitionDigest },
    modelIdentity: 'judge-fixture-model',
    inputTokens: 120,
    outputTokens: 18,
    latencyMs: 3,
  };
}));

beforeEach(() => {
  variantRead._resetOperationVariantReadForTests();
  jevChange = 0.03;
  judgeAnswer = { changesAnything: 'no', confidence: 0.97 };
  jevRequests.length = 0;
  judgeRequests.length = 0;
});

after(() => {
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  ports.installTurnSemanticModelPort(null);
  stores.installCapabilityManifestStore(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─── One exact accepted call through the production host adapter ──────────

async function acceptedCall(options: {
  args: Record<string, unknown>;
  destructive?: boolean | null;
  learningPolicy?: unknown;
  schema?: Record<string, unknown>;
  operationId?: string;
}) {
  const sessionId = `variant-read-${randomUUID()}`;
  const operationId = options.operationId ?? OPERATION;
  const schema = options.schema ?? SCHEMA;
  const schemaDigest = canonicalExternalInputSchemaDigestV1(schema)!;
  const effect = 'external_write' as const;
  const capabilityId = `cap:variant-read:${operationId}:${String(options.destructive ?? true)}`;
  const accountId = 'account:variant-read:owner';
  const fingerprint = sha(`${operationId}:${schemaDigest}`);
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: capabilityId, providerKind: 'composio', operationId,
    providerIdentity: 'composio:variant-read-fixture', providerVersion: 'catalog-v1',
    operationVersion: '1', definitionFingerprint: fingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest: schemaDigest,
      semanticName: operationId,
      behaviorHints: { readOnly: false, destructive: options.destructive === undefined ? true : options.destructive,
        idempotent: null, openWorld: null } },
    effect, accountId,
    destination: { family: 'external_resource', posture: 'create_new' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'result' }, purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'], producedOutputKinds: ['result'], applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:variant-read:test', issuedAt: '2026-10-14T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId: 'host:variant-read-fixture:invoke',
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
  observations.clearIndependentCapabilityObservations();
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId, accountId,
    definitionFingerprint: fingerprint, providerVersion: manifest.providerVersion,
    operationVersion: '1', observedAt: Date.now(), origin: 'independent' }).ok, true);
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Show me my sessions.',
      ...(options.learningPolicy === undefined ? {} : { learningPolicy: options.learningPolicy }) } });
  const catalogRevisionDigest = sha(`catalog:${sessionId}`);
  const bindingRevisionDigest = sha(`binding:${sessionId}`);
  const root = authority.armHostCallAuthority({ sessionId, sourceUserSeq: source.seq,
    catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 8, maxParallelCalls: 2 });
  assert.equal(root.status, 'armed');
  if (root.status !== 'armed') throw new Error('fixture root missing');
  const acceptedTaskId = root.authority.identity.acceptedTaskId;
  const logical = contracts.durableLogicalCallContract(acceptedTaskId, operationId, options.args)!;
  const logicalToolCallId = 'variant-read-call';
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
      acceptedTaskId, logicalToolCallId }, tool: operationId, args: options.args });
    assert.equal(admitted.status, 'inserted', JSON.stringify(admitted));
    const bound = bindings.persistHostCallCapabilityBinding({ db: eventlog.openEventLog(),
      attestation, sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId,
      toolName: logical.toolName, argumentDigest: logical.argumentDigest, effect });
    assert.equal(bound.status, 'bound', JSON.stringify(bound));
  });
  const request = { attestation, args: options.args, inputSchema: schema };
  const result = await consent.evaluateUncoveredHostMutationConsent(request);
  return { result, request, sessionId };
}

function decided(result: Awaited<ReturnType<typeof acceptedCall>>['result']) {
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided') throw new Error('consent was not decided');
  return result;
}

function basisEvents(sessionId: string) {
  return eventlog.listEvents(sessionId, { types: ['exact_call_variant_read_basis'] });
}

// ─── Pins ──────────────────────────────────────────────────────────────────

test('a list on a tool that declares itself destructive proceeds as a read, and the next list reads at once', async () => {
  const first = await acceptedCall({ args: { action: 'list', status: 'active', query: 'demo' } });
  const outcome = decided(first.result);
  assert.equal(outcome.decision.kind, 'proceed', JSON.stringify(outcome.decision));
  assert.equal(outcome.decision.kind === 'proceed' ? outcome.decision.basis : null, 'exact_variant_read');
  assert.equal(outcome.consentSubject, undefined, 'no card');
  assert.equal(jevRequests.length, 1);
  assert.equal(judgeRequests.length, 1);
  const judged = JSON.parse(judgeRequests[0]!.user) as Record<string, unknown>;
  assert.deepEqual(judged.fixedArguments, { action: 'list', status: 'active' }, 'only the enumerated values are fixed');
  assert.equal(JSON.stringify(judged).includes(OPERATION), false, 'the operation name is not part of what is judged');
  const frozen = basisEvents(first.sessionId);
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]!.data.outcome, 'judged');
  const receipt = eventlog.listEvents(first.sessionId, { types: ['interactive_consent_decided'] });
  assert.equal(receipt.at(-1)?.data.basis, 'exact_variant_read', 'the receipt settlement reads back');

  const second = await acceptedCall({ args: { action: 'list', status: 'active', query: 'other' } });
  const again = decided(second.result);
  assert.equal(again.decision.kind === 'proceed' ? again.decision.basis : null, 'exact_variant_read');
  assert.equal(jevRequests.length, 1, 'remembered: no second screen');
  assert.equal(judgeRequests.length, 1, 'remembered: no second confirm');
  assert.equal(basisEvents(second.sessionId)[0]!.data.outcome, 'remembered');
});

test('a delete on the same tool keeps its card: the screen says it changes things and the judge is never asked', async () => {
  jevChange = 0.97;
  const deleted = await acceptedCall({ args: { action: 'delete', session_id: 's-1' } });
  const outcome = decided(deleted.result);
  assert.equal(outcome.decision.kind, 'needs_user', JSON.stringify(outcome.decision));
  assert.ok(outcome.consentSubject, 'the card binds an exact approval subject');
  assert.equal(judgeRequests.length, 0);
  assert.equal(basisEvents(deleted.sessionId)[0]!.data.outcome, 'screen_not_confident');
  assert.equal(basisEvents(deleted.sessionId)[0]!.data.verdict, null);
});

test('the judge disagrees with the screen: the call asks and nothing is remembered', async () => {
  judgeAnswer = { changesAnything: 'uncertain', confidence: 0.6 };
  const first = await acceptedCall({ args: { action: 'get', session_id: 's-2' } });
  assert.equal(decided(first.result).decision.kind, 'needs_user');
  assert.equal(basisEvents(first.sessionId)[0]!.data.outcome, 'confirm_disagreed');
  // A fresh process state with the judge now agreeing must ask the models
  // again: nothing was stored from the disagreement.
  variantRead._resetOperationVariantReadForTests();
  judgeAnswer = { changesAnything: 'no', confidence: 0.97 };
  const second = await acceptedCall({ args: { action: 'get', session_id: 's-3' } });
  assert.equal(decided(second.result).decision.kind === 'proceed', true);
  assert.equal(basisEvents(second.sessionId)[0]!.data.outcome, 'judged');
});

test('a source held from learning gets the reading for its own call, and nothing is remembered from it', async () => {
  const policy = { version: 1, mode: 'exclude', reason: 'controlled_test' };
  const held = await acceptedCall({ args: { action: 'list' }, learningPolicy: policy });
  assert.equal(decided(held.result).decision.kind === 'proceed', true);
  const again = await acceptedCall({ args: { action: 'list' }, learningPolicy: policy });
  assert.equal(decided(again.result).decision.kind === 'proceed', true);
  assert.equal(judgeRequests.length, 2, 'judged again: the held source remembered nothing');
});

test('only enumerated values the schema accepts are fixed; a call that sets none is never read this way', () => {
  assert.deepEqual(variantRead.operationVariantOf(SCHEMA, { action: 'list', query: 'x', status: 'all' }),
    { action: 'list', status: 'all' });
  assert.equal(variantRead.operationVariantOf(SCHEMA, { action: 'not-in-enum', query: 'x' }), null);
  assert.equal(variantRead.operationVariantOf(SCHEMA, { query: 'x' }), null);
  assert.equal(variantRead.operationVariantOf({ type: 'object', properties: { text: { type: 'string' } } }, { text: 'list' }), null);
});

test('a tool that does not declare itself destructive is never read this way', async () => {
  const ordinary = await acceptedCall({ args: { action: 'list' }, destructive: false });
  const outcome = decided(ordinary.result);
  assert.notEqual(outcome.decision.kind === 'proceed' ? outcome.decision.basis : null, 'exact_variant_read');
  assert.equal(basisEvents(ordinary.sessionId).length, 0, 'not asked');
  assert.equal(jevRequests.length, 0);
});

test('a call admitted as a variant read is booked as a read', () => {
  const identity = { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't', logicalToolCallId: 'c', toolName: OPERATION, args: { action: 'list' } };
  const booked = hostInvocation.hostCallAccounting({ identity, effect: 'external_write', boundary: 'host_owned_external',
    consentBasis: 'exact_variant_read' } as Parameters<typeof hostInvocation.hostCallAccounting>[0]);
  assert.deepEqual(booked, { learnedRead: true, mutating: false, projectsExternalWrite: false });
  const write = hostInvocation.hostCallAccounting({ identity, effect: 'external_write', boundary: 'host_owned_external',
    consentBasis: 'exact_user_grant' } as Parameters<typeof hostInvocation.hostCallAccounting>[0]);
  assert.equal(write.mutating, true);
});

// A tool that sends one request wherever its caller names: what a call does
// lives in its method and endpoint, so a lookup (GET, or the POST many APIs
// read with) is judged for that endpoint and remembered per endpoint.
const REQUEST_OPERATION = 'EXAMPLE_API_REQUEST';
const REQUEST_SCHEMA = {
  type: 'object',
  description: 'Make a request to any endpoint of the Example data API. Data endpoints under /v3/labs return results for the target; task endpoints create paid tasks.',
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', description: 'The endpoint path, for example /v3/labs/rank_overview/live.' },
    data: { type: 'array', items: { type: 'object' } },
  },
  required: ['method', 'path'],
  additionalProperties: false,
};

test('a POST lookup through a generic request tool reads for its endpoint, remembered per endpoint', async () => {
  const call = (path: string, target: string) => acceptedCall({ schema: REQUEST_SCHEMA, operationId: REQUEST_OPERATION,
    args: { method: 'POST', path, data: [{ target }] } });
  const first = decided((await call('/v3/labs/rank_overview/live', 'example.com')).result);
  assert.equal(first.decision.kind === 'proceed' ? first.decision.basis : null, 'exact_variant_read', JSON.stringify(first.decision));
  assert.equal(first.consentSubject, undefined, 'no card');
  const judged = JSON.parse(judgeRequests[0]!.user) as Record<string, unknown>;
  assert.deepEqual(judged.fixedArguments, { method: 'POST', path: '/v3/labs/rank_overview/live' }, 'the method and endpoint are fixed; the body is not');

  const same = decided((await call('/v3/labs/rank_overview/live', 'other.example')).result);
  assert.equal(same.decision.kind === 'proceed' ? same.decision.basis : null, 'exact_variant_read');
  assert.equal(judgeRequests.length, 1, 'the same endpoint is remembered');

  const other = decided((await call('/v3/labs/traffic_overview/live', 'example.com')).result);
  assert.equal(other.decision.kind === 'proceed' ? other.decision.basis : null, 'exact_variant_read');
  assert.equal(judgeRequests.length, 2, 'another endpoint is judged on its own');
});

test('a request tool that declares itself non-destructive is still judged for its endpoint', async () => {
  // The live shape: the connector's "make any request" tool carries destructive: false,
  // so its consequence stays unknown with ordinary reversibility; the read check used to skip it.
  const call = decided((await acceptedCall({ schema: REQUEST_SCHEMA, operationId: REQUEST_OPERATION, destructive: false,
    args: { method: 'POST', path: '/v3/labs/history/live', data: [{ target: 'example.com' }] } })).result);
  assert.equal(call.decision.kind === 'proceed' ? call.decision.basis : null, 'exact_variant_read', JSON.stringify(call.decision));
  assert.equal(judgeRequests.length, 1);
});

test('a PUT through the same request tool keeps its card and asks neither model', async () => {
  const put = decided((await acceptedCall({ schema: REQUEST_SCHEMA, operationId: REQUEST_OPERATION,
    args: { method: 'PUT', path: '/v3/labs/rank_overview/live', data: [{ target: 'example.com' }] } })).result);
  assert.equal(put.decision.kind, 'needs_user', JSON.stringify(put.decision));
  assert.equal(jevRequests.length, 0);
  assert.equal(judgeRequests.length, 0);
});

test('a POST the judge does not confirm as a lookup keeps its card', async () => {
  judgeAnswer = { changesAnything: 'yes', confidence: 0.95 };
  const task = decided((await acceptedCall({ schema: REQUEST_SCHEMA, operationId: REQUEST_OPERATION,
    args: { method: 'POST', path: '/v3/labs/task_post', data: [{ target: 'example.com' }] } })).result);
  assert.equal(task.decision.kind, 'needs_user', JSON.stringify(task.decision));
});
