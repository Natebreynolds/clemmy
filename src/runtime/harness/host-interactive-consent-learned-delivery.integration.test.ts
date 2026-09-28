/**
 * Pins for "one card per action": a call that delivers nothing stops asking
 * separately once two models have read its own definition, while every send
 * keeps its card. Each pin runs the real learner (stage one through the real
 * fast-classifier client with its fetch seam, stage two through the real
 * configured-brain semantic port with an injected completion), the real risk
 * loader, the real projector and the real consent reducer, through the
 * production host adapter.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-interactive-consent-learned-delivery.integration.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learned-delivery-consent-'));
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
const learner = await import('./learned-operation-delivery.js');
const deliveryStore = await import('./learned-operation-delivery-store.js');
const jev = await import('../jev/client.js');
const ports = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort } = await import('../semantic-boundary/configured-brain-semantic-port.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Named with a word the structural classifier reads as a send. */
const OPEN_OPERATION = 'EXAMPLE_OPEN_DM';
const OPEN_DESCRIPTION = 'Opens a direct conversation with one or more people, or resumes the existing one, and returns its conversation id. No message is posted and nobody is notified.';
const OPEN_SCHEMA = {
  type: 'object',
  properties: { users: { type: 'string', description: 'Comma-separated people to open the conversation with.' } },
  required: ['users'],
  additionalProperties: false,
};
/** Same operation shape, but its schema exposes an outbound delivery control. */
const OPEN_WITH_NOTIFY_SCHEMA = {
  type: 'object',
  properties: {
    users: { type: 'string' },
    notify_users: { type: 'boolean' },
  },
  required: ['users', 'notify_users'],
  additionalProperties: false,
};
const SEND_OPERATION = 'EXAMPLE_SEND_MESSAGE';
const SEND_DESCRIPTION = 'Posts a message with the given text to a conversation. Everyone in the conversation receives it.';
const SEND_SCHEMA = {
  type: 'object',
  properties: { channel: { type: 'string' }, text: { type: 'string' } },
  required: ['channel', 'text'],
  additionalProperties: false,
};

// ─── Model seams (no live model call, no keychain) ─────────────────────────

let jevAnswers = { delivers: 0.02, irreversible: 0.01 };
const jevRequests: Array<Record<string, unknown>> = [];
jev._setTypesafeKeyForTests('fixture-key');
jev._setSystemOneFetchForTests(async (_url, init) => {
  const request = JSON.parse(init.body) as Record<string, unknown>;
  jevRequests.push(request);
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: 'jev-fixture',
      answers: {
        delivers: { type: 'noul', noul: jevAnswers.delivers },
        irreversible: { type: 'noul', noul: jevAnswers.irreversible },
      },
      usage: { input_tokens: 40, output_tokens: 2 },
    }),
  };
});

let judgeAnswer: {
  deliversToOthers: 'yes' | 'no' | 'uncertain';
  deletesOrIrreversible: 'yes' | 'no' | 'uncertain';
  confidence: number;
} = { deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.96 };
const judgeRequests: Array<{ purpose: string; system: string; user: string; schemaName: string }> = [];
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
  deliveryStore._resetLearnedOperationDeliveryForTests();
  learner._resetOperationDeliveryLearningForTests();
  jevAnswers = { delivers: 0.02, irreversible: 0.01 };
  judgeAnswer = { deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.96 };
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

interface FixtureOptions {
  /** Distinguishes manifests whose definitions differ. */
  tag: string;
  operationId: string;
  schema: Record<string, unknown>;
  args: Record<string, unknown>;
  posture?: 'create_new' | 'named_existing' | 'not_applicable';
  destructive?: boolean | null;
  accountId?: string;
  operationSemantics?: { version: 1; reversibility: 'reversible' | 'ordinary_non_destructive' | 'irreversible' };
}

async function acceptedCall(options: FixtureOptions) {
  const sessionId = `learned-delivery-${randomUUID()}`;
  const operationId = options.operationId;
  const schemaDigest = canonicalExternalInputSchemaDigestV1(options.schema)!;
  const effect = 'external_write' as const;
  const capabilityId = `cap:learned-delivery:${options.tag}`;
  const accountId = options.accountId ?? 'account:learned-delivery:owner';
  const fingerprint = sha(`${operationId}:${schemaDigest}`);
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: capabilityId, providerKind: 'composio', operationId,
    providerIdentity: 'composio:learned-delivery-fixture', providerVersion: 'catalog-v1',
    operationVersion: '1', definitionFingerprint: fingerprint,
    externalDefinition: { version: 1, providerInputSchemaDigest: schemaDigest,
      semanticName: operationId,
      behaviorHints: { readOnly: false, destructive: options.destructive ?? null,
        idempotent: null, openWorld: null } },
    effect, accountId,
    ...(options.operationSemantics ? { operationSemantics: options.operationSemantics } : {}),
    destination: { family: 'external_resource', posture: options.posture ?? 'create_new' },
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'result' }, purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'], producedOutputKinds: ['result'], applicableDeliverableKinds: ['result'],
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:learned-delivery:test', issuedAt: '2026-09-25T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' }, invokePortId: 'host:learned-delivery-fixture:invoke',
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
  // This fixture's definition is the one the provider serves right now.
  observations.clearIndependentCapabilityObservations();
  assert.equal(observations.registerIndependentCapabilityObservation({ operationId, accountId,
    definitionFingerprint: fingerprint, providerVersion: manifest.providerVersion,
    operationVersion: '1', observedAt: Date.now(), origin: 'independent' }).ok, true);
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Message my teammate about the interview.' } });
  const catalogRevisionDigest = sha(`catalog:${sessionId}`);
  const bindingRevisionDigest = sha(`binding:${sessionId}`);
  const root = authority.armHostCallAuthority({ sessionId, sourceUserSeq: source.seq,
    catalogRevisionDigest, bindingRevisionDigest, maxLogicalCalls: 8, maxParallelCalls: 2 });
  assert.equal(root.status, 'armed');
  if (root.status !== 'armed') throw new Error('fixture root missing');
  assert.equal(root.authority.sourceEventId, source.id, 'the call binding names the accepted source event');
  const acceptedTaskId = root.authority.identity.acceptedTaskId;
  const logical = contracts.durableLogicalCallContract(acceptedTaskId, operationId, options.args)!;
  const logicalToolCallId = 'learned-delivery-call';
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
  const request = { attestation, args: options.args, inputSchema: options.schema };
  const result = await consent.evaluateUncoveredHostMutationConsent(request);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(sessionId) as { n: number }).n, 0, 'consent never dispatches');
  return { result, request, sourceCreatedAt: source.createdAt };
}

function decided(result: Awaited<ReturnType<typeof acceptedCall>>['result']) {
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided') throw new Error('consent was not decided');
  return result;
}

function assertAsks(result: Awaited<ReturnType<typeof acceptedCall>>['result'], message: string) {
  const outcome = decided(result);
  assert.equal(outcome.decision.kind, 'needs_user', `${message}: ${JSON.stringify(outcome.decision)}`);
  assert.equal(outcome.decision.kind === 'needs_user' ? outcome.decision.need : null, 'approval', message);
  assert.ok(outcome.consentSubject, `${message}: the card binds an exact approval subject`);
  return outcome;
}

function assertProceedsWithoutCard(result: Awaited<ReturnType<typeof acceptedCall>>['result'], message: string) {
  const outcome = decided(result);
  assert.equal(outcome.decision.kind, 'proceed', `${message}: ${JSON.stringify(outcome.decision)}`);
  assert.equal(outcome.decision.kind === 'proceed' ? outcome.decision.basis : null, 'exact_ordinary_work', message);
  assert.equal(outcome.consentSubject, undefined, `${message}: no approval subject, no card`);
  return outcome;
}

async function learnOpen(schema: Record<string, unknown> = OPEN_SCHEMA, description = OPEN_DESCRIPTION) {
  return learner.learnOperationDelivery({
    providerKind: 'composio', operationId: OPEN_OPERATION, description, inputSchema: schema,
  });
}

// ─── Pins ──────────────────────────────────────────────────────────────────

test('an operation that only opens a conversation asks before learning and proceeds as an ordinary create after', async () => {
  const before = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U1' } });
  const card = assertAsks(before.result, 'before learning the send-shaped name still asks');
  assert.deepEqual(card.call.risk, { reversibility: 'irreversible', consequence: 'send', destructive: false });

  await wait(5);
  assert.equal(await learnOpen(), 'learned');
  const verdict = deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION);
  assert.ok(verdict, 'both models agreed, so the verdict is recorded');
  assert.equal(verdict.screen.model, 'jev-fixture');
  assert.equal(verdict.screen.deliveryProbability, 0.02);
  assert.equal(verdict.screen.irreversibleProbability, 0.01);
  assert.equal(verdict.confirm.model, 'judge-fixture-model');
  assert.equal(verdict.confirm.confidence, 0.96);
  assert.equal(verdict.inputSchemaDigest, canonicalExternalInputSchemaDigestV1(OPEN_SCHEMA));
  // Neither model was shown the operation's name: the definition decides.
  assert.equal(jevRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(jevRequests[0]!.state), /EXAMPLE_OPEN_DM|OPEN_DM/);
  assert.match(JSON.stringify(jevRequests[0]!.state), /returns its conversation id/);
  assert.equal(judgeRequests.length, 1);
  assert.equal(judgeRequests[0]!.purpose, 'operation_delivery_judge');
  assert.equal(judgeRequests[0]!.schemaName, 'OperationDeliveryJudgeV1');
  assert.deepEqual(Object.keys(JSON.parse(judgeRequests[0]!.user)).sort(), ['definitionDigest', 'description', 'inputSchema']);
  assert.doesNotMatch(judgeRequests[0]!.user, /OPEN_DM/);

  await wait(5);
  const after = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U1' } });
  const ordinary = assertProceedsWithoutCard(after.result, 'a later source proceeds with no card');
  assert.deepEqual(ordinary.call.risk, { reversibility: 'ordinary_non_destructive', consequence: 'create', destructive: false });
  assert.notEqual(ordinary.call.semanticBasis.digest, card.call.semanticBasis.digest,
    'the learned verdict is part of the attested semantic basis');
  const receipts = eventlog.listEvents(after.request.attestation.sessionId, { types: ['interactive_consent_decided'] });
  assert.equal(receipts.length, 1, 'a decision made on a learned semantic is journaled');
  const source = receipts[0]!.data.semanticSource as Record<string, unknown>;
  assert.equal(source.origin, 'learned_operation_delivery');
  assert.match(String(source.sourceDigest), /^[a-f0-9]{64}$/);
  assert.equal(source.definitionDigest, verdict.definitionDigest);
  assert.deepEqual(source.screen, { model: 'jev-fixture', deliveryProbability: 0.02, irreversibleProbability: 0.01 });
  assert.deepEqual(source.confirm, { role: 'judge', model: 'judge-fixture-model', confidence: 0.96 });
});

test('a card raised before learning is resumed on the same facts: its approval still redeems', async () => {
  const before = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U2' } });
  const card = assertAsks(before.result, 'the first encounter asks');
  await wait(5);
  assert.equal(await learnOpen(), 'learned', 'the verdict lands while the card is open');

  const subject = card.consentSubject!;
  const approval = approvals.registerResumable({ sessionId: before.request.attestation.sessionId,
    subject: 'Approve opening the conversation.', tool: before.request.attestation.toolName,
    args: before.request.args,
    resumeKey: consent.hostInteractiveConsentApprovalResumeKey(subject)! }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'learned-delivery-test').ok, true);
  const resumed = await consent.evaluateUncoveredHostMutationConsent({
    ...before.request,
    durableApproval: { approvalId: approval.approvalId, persistedSubject: subject,
      outerToolName: before.request.attestation.toolName, outerRawArguments: JSON.stringify(before.request.args) },
  });
  const granted = decided(resumed);
  assert.equal(granted.decision.kind === 'proceed' ? granted.decision.basis : null, 'exact_user_grant',
    'the owner approved this card; a verdict learned meanwhile waits for the next source');
  assert.deepEqual(granted.call, card.call, 'the resumed call carries the same risk and semantic basis');
});

test('an operation whose definition delivers keeps its card: both models say it delivers and nothing is recorded', async () => {
  jevAnswers = { delivers: 0.97, irreversible: 0.2 };
  judgeAnswer = { deliversToOthers: 'yes', deletesOrIrreversible: 'no', confidence: 0.98 };
  const outcome = await learner.learnOperationDelivery({
    providerKind: 'composio', operationId: SEND_OPERATION, description: SEND_DESCRIPTION, inputSchema: SEND_SCHEMA,
  });
  assert.equal(outcome, 'screen_not_confident');
  assert.equal(judgeRequests.length, 0, 'a delivering screen never reaches the judge');
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', SEND_OPERATION), null);
  // Even a judge that is asked directly and agrees it delivers records nothing.
  jevAnswers = { delivers: 0.05, irreversible: 0.02 };
  assert.equal(await learner.learnOperationDelivery({
    providerKind: 'composio', operationId: SEND_OPERATION, description: SEND_DESCRIPTION, inputSchema: SEND_SCHEMA,
  }), 'confirm_disagreed');
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', SEND_OPERATION), null);
  await wait(5);
  const call = await acceptedCall({ tag: 'send', operationId: SEND_OPERATION, schema: SEND_SCHEMA,
    args: { channel: 'D1', text: 'Hello' } });
  const card = assertAsks(call.result, 'a real send keeps its card');
  assert.equal(card.call.risk.consequence, 'send');
});

test('the fast classifier says nothing is delivered but the judge disagrees: nothing is recorded and it asks', async () => {
  judgeAnswer = { deliversToOthers: 'yes', deletesOrIrreversible: 'no', confidence: 0.9 };
  assert.equal(await learnOpen(), 'confirm_disagreed');
  assert.equal(jevRequests.length, 1);
  assert.equal(judgeRequests.length, 1);
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION), null);
  // An uncertain or under-confident judge is no agreement either.
  judgeAnswer = { deliversToOthers: 'uncertain', deletesOrIrreversible: 'no', confidence: 0.95 };
  assert.equal(await learnOpen(), 'confirm_not_confident');
  judgeAnswer = { deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 0.6 };
  assert.equal(await learnOpen(), 'confirm_not_confident');
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION), null);
  await wait(5);
  const call = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U3' } });
  assertAsks(call.result, 'without agreement the conservative default stays');
});

test('a changed definition ignores the stored verdict and asks', async () => {
  assert.equal(await learnOpen(), 'learned');
  await wait(5);
  const learned = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U4' } });
  assertProceedsWithoutCard(learned.result, 'the learned definition proceeds');

  // A changed input schema: the loader re-digests the current definition and
  // the verdict no longer matches it.
  const changedSchema = {
    ...OPEN_SCHEMA,
    properties: { ...OPEN_SCHEMA.properties, topic: { type: 'string' } },
  };
  const schemaChanged = await acceptedCall({ tag: 'open-changed-schema', operationId: OPEN_OPERATION,
    schema: changedSchema, args: { users: 'U4' } });
  assertAsks(schemaChanged.result, 'a changed schema asks again');

  // A changed description observed at discovery removes the verdict before
  // anything is asked, even when the new reading cannot finish.
  ports.installTurnSemanticModelPort(null);
  try {
    const scheduled = learner.scheduleOperationDeliveryLearning([{
      providerKind: 'composio', operationId: OPEN_OPERATION,
      description: 'Opens a direct conversation and posts a greeting to everyone in it.', inputSchema: OPEN_SCHEMA,
    }]);
    assert.equal(scheduled, 1);
    assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION), null,
      'the old verdict is gone at observation time');
    await learner._drainOperationDeliveryLearningForTests();
  } finally {
    ports.installTurnSemanticModelPort(configuredBrainSemanticPort(async (request) => {
      judgeRequests.push(request);
      const user = JSON.parse(request.user) as { definitionDigest: string };
      return { raw: { ...judgeAnswer, definitionDigest: user.definitionDigest },
        modelIdentity: 'judge-fixture-model', inputTokens: 120, outputTokens: 18, latencyMs: 3 };
    }));
  }
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION), null,
    'no judge, no confirmation, no verdict');
  await wait(5);
  const descriptionChanged = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U4' } });
  assertAsks(descriptionChanged.result, 'a changed description asks again');
});

test('unreadable observed metadata retires the learned exception without changing the input schema', async () => {
  assert.equal(await learnOpen(), 'learned');
  await wait(5);
  const learned = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION,
    schema: OPEN_SCHEMA, args: { users: 'U4' } });
  assertProceedsWithoutCard(learned.result, 'the readable learned definition proceeds');

  const screens = jevRequests.length;
  const judges = judgeRequests.length;
  assert.equal(learner.scheduleOperationDeliveryLearning([{
    providerKind: 'composio', operationId: OPEN_OPERATION, inputSchema: OPEN_SCHEMA,
  }]), 0);
  const observed = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION,
    schema: OPEN_SCHEMA, args: { users: 'U4' } });
  assertAsks(observed.result, 'the next accepted source uses the existing structural send behavior');
  assert.equal(jevRequests.length, screens, 'retiring the exception does not ask a model');
  assert.equal(judgeRequests.length, judges);
});

test('an outbound-delivery argument on a downgraded operation is still a send and still asks', async () => {
  assert.equal(await learnOpen(OPEN_WITH_NOTIFY_SCHEMA), 'learned');
  await wait(5);
  const quiet = await acceptedCall({ tag: 'open-notify', operationId: OPEN_OPERATION,
    schema: OPEN_WITH_NOTIFY_SCHEMA, args: { users: 'U5', notify_users: false } });
  assertProceedsWithoutCard(quiet.result, 'with its delivery control off, the downgraded operation proceeds');
  const loud = await acceptedCall({ tag: 'open-notify', operationId: OPEN_OPERATION,
    schema: OPEN_WITH_NOTIFY_SCHEMA, args: { users: 'U5', notify_users: true } });
  const card = assertAsks(loud.result, 'an affirmative delivery argument asks');
  assert.deepEqual(card.call.risk, { reversibility: 'irreversible', consequence: 'send', destructive: false });
});

/** Record a verdict directly, as if two models had agreed a minute ago. */
function remember(operationId: string, schema: Record<string, unknown>): void {
  assert.equal(deliveryStore.rememberLearnedOperationDelivery({
    version: 1, providerKind: 'composio', operationId,
    verdict: 'delivers_nothing_non_destructive',
    definitionDigest: sha(`definition:${operationId}`),
    inputSchemaDigest: canonicalExternalInputSchemaDigestV1(schema)!,
    screen: { model: 'jev-fixture', deliveryProbability: 0, irreversibleProbability: 0 },
    confirm: { role: 'judge', model: 'judge-fixture-model', deliversToOthers: 'no', deletesOrIrreversible: 'no', confidence: 1 },
    learnedAt: new Date(Date.now() - 60_000).toISOString(),
  }), true);
}

test('a learned verdict never lowers a delete, a destructive declaration, or an unknown consequence', async () => {
  // Simulate two models wrongly agreeing about operations the learner would
  // never ask about: the loader's own floors still hold.
  remember('EXAMPLE_DELETE_MESSAGE', SEND_SCHEMA);
  const deletion = await acceptedCall({ tag: 'delete', operationId: 'EXAMPLE_DELETE_MESSAGE', schema: SEND_SCHEMA,
    posture: 'named_existing', args: { channel: 'D1', text: 'x' } });
  assert.equal(assertAsks(deletion.result, 'a delete keeps its card').call.risk.consequence, 'delete');

  remember(OPEN_OPERATION, OPEN_SCHEMA);
  const destructive = await acceptedCall({ tag: 'open-destructive', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA,
    destructive: true, args: { users: 'U6' } });
  assert.equal(assertAsks(destructive.result, 'a carrier-declared destructive operation keeps its card').call.risk.destructive, true);

  const unknownConsequence = await acceptedCall({ tag: 'open-no-posture', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA,
    posture: 'not_applicable', args: { users: 'U6' } });
  assert.equal(assertAsks(unknownConsequence.result, 'with no known consequence it still asks').call.risk.consequence, 'send');
});

test('a semantic the manifest seals wins over a learned verdict', async () => {
  remember(OPEN_OPERATION, OPEN_SCHEMA);
  const sealed = await acceptedCall({ tag: 'open-sealed-irreversible', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA,
    operationSemantics: { version: 1, reversibility: 'irreversible' }, args: { users: 'U7' } });
  const card = assertAsks(sealed.result, 'an adapter-sealed irreversible semantic keeps its card');
  assert.equal(card.call.risk.reversibility, 'irreversible');
  // The same verdict does apply where nothing is sealed.
  const learned = await acceptedCall({ tag: 'open', operationId: OPEN_OPERATION, schema: OPEN_SCHEMA, args: { users: 'U7' } });
  assertProceedsWithoutCard(learned.result, 'without a sealed semantic the verdict applies');
});

const CONDITIONAL_SCHEMA = {
  ...OPEN_SCHEMA,
  description: 'Open or resume a conversation; the conditional lookup never creates or notifies.',
  properties: { ...OPEN_SCHEMA.properties,
    lookup_only: { type: 'boolean', description: 'When true, only find an existing conversation. Never create or notify.' } },
};

test('exact conditional lookup gets no setup card on its first call and reuses proof with models unavailable', async () => {
  const args = { users: 'U-first', lookup_only: true };
  const first = await acceptedCall({ tag: 'conditional', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA, args });
  const outcome = assertProceedsWithoutCard(first.result, 'first encounter uses exact schema and arguments');
  assert.equal(jevRequests.length, 1);
  assert.equal(judgeRequests.length, 1);
  const schema = JSON.parse((jevRequests[0]!.state as { inputSchema: string }).inputSchema);
  assert.deepEqual(schema.allOf, [CONDITIONAL_SCHEMA, { const: args }], 'the entire schema survives the exact-argument intersection');
  assert.deepEqual((jevRequests[0]!.state as Record<string, unknown>).effectiveArguments, args);
  assert.deepEqual(JSON.parse(judgeRequests[0]!.user).effectiveArguments, args);
  assert.equal(deliveryStore.learnedOperationDeliveryVerdict('composio', OPEN_OPERATION), null,
    'a conditional proof cannot become an operation-wide waiver');
  const snapshots = eventlog.listEvents(first.request.attestation.sessionId, { types: ['exact_call_delivery_basis'] });
  assert.equal(snapshots.length, 1);
  assert.ok((snapshots[0]!.data.verdict as Record<string, unknown>).callBindingDigest);
  jev._setTypesafeKeyForTests(null);
  try {
    const resumed = await consent.evaluateUncoveredHostMutationConsent(first.request);
    assert.deepEqual(decided(resumed).call, outcome.call, 'same exact risk on replay');
    const next = await acceptedCall({ tag: 'conditional', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA, args });
    assertProceedsWithoutCard(next.result, 'later turn uses the already checked exact call');
    assert.equal(jevRequests.length, 1, 'no additional model calls');
  } finally { jev._setTypesafeKeyForTests('fixture-key'); }
});

test('changed arguments, recipient and definition cannot inherit an exact lookup proof', async () => {
  await acceptedCall({ tag: 'conditional-drift', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA,
    args: { users: 'U1', lookup_only: true } });
  jevAnswers = { delivers: 0.8, irreversible: 0.3 };
  for (const args of [{ users: 'U1', lookup_only: false }, { users: 'U2', lookup_only: true }]) {
    const changed = await acceptedCall({ tag: 'conditional-drift', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA, args });
    assertAsks(changed.result, 'changed exact arguments retain approval without new proof');
  }
  const changed = await acceptedCall({ tag: 'conditional-drift-v2', operationId: OPEN_OPERATION,
    schema: { ...CONDITIONAL_SCHEMA, description: 'This now notifies participants.' }, args: { users: 'U1', lookup_only: true } });
  assertAsks(changed.result, 'changed definition retains approval');
  assert.equal(judgeRequests.length, 1, 'only the first lookup passed the screen');
});

test('negative first-call evidence stays frozen after another source learns; explicit sends do not add semantic calls', async () => {
  jevAnswers = { delivers: 0.8, irreversible: 0.2 };
  const first = await acceptedCall({ tag: 'conditional-frozen', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA,
    args: { users: 'U-frozen', lookup_only: true } });
  const card = assertAsks(first.result, 'uncertainty keeps the card');
  const basis = eventlog.listEvents(first.request.attestation.sessionId, { types: ['exact_call_delivery_basis'] })[0]!;
  assert.equal(basis.data.verdict, null);
  jevAnswers = { delivers: 0.02, irreversible: 0.01 };
  assert.equal(await learner.learnOperationDelivery({ providerKind: 'composio', operationId: OPEN_OPERATION,
    description: CONDITIONAL_SCHEMA.description, inputSchema: CONDITIONAL_SCHEMA,
    exactCall: { bindingDigest: String(basis.data.callBindingDigest), arguments: first.request.args } }), 'learned');
  const again = await consent.evaluateUncoveredHostMutationConsent(first.request);
  assert.deepEqual(decided(again).call, card.call, 'a later proof cannot rewrite the pending risk subject');
  const count = jevRequests.length;
  const send = await acceptedCall({ tag: 'actual-send', operationId: SEND_OPERATION,
    schema: { ...SEND_SCHEMA, description: SEND_DESCRIPTION }, args: { channel: 'C1', text: 'Hello' } });
  assertAsks(send.result, 'a real send still needs content approval');
  assert.equal(jevRequests.length, count, 'an unambiguous send needs no new classifier call');
});

test('an exact lookup proof cannot cross accounts or override outbound/destructive evidence', async () => {
  const args = { users: 'U-boundary', lookup_only: true };
  const first = await acceptedCall({ tag: 'boundary', operationId: OPEN_OPERATION, schema: CONDITIONAL_SCHEMA, args });
  assertProceedsWithoutCard(first.result, 'known exact lookup');
  jevAnswers = { delivers: 0.8, irreversible: 0.3 };
  const other = await acceptedCall({ tag: 'boundary-other', accountId: 'account:other', operationId: OPEN_OPERATION,
    schema: CONDITIONAL_SCHEMA, args });
  assertAsks(other.result, 'another account has no inherited proof');
  const calls = jevRequests.length;
  const destructive = await acceptedCall({ tag: 'boundary-destructive', operationId: OPEN_OPERATION,
    schema: CONDITIONAL_SCHEMA, args, destructive: true });
  assertAsks(destructive.result, 'destructive provider hint is never lowered');
  const notify = await acceptedCall({ tag: 'boundary-notify', operationId: OPEN_OPERATION,
    schema: { ...OPEN_WITH_NOTIFY_SCHEMA, description: CONDITIONAL_SCHEMA.description },
    args: { users: 'U-boundary', notify_users: true } });
  assertAsks(notify.result, 'outbound argument remains a send');
  assert.equal(jevRequests.length, calls, 'destructive and outbound floors do not ask a model to waive them');
});

test('schema-bound provider preparation contract avoids setup cards without any semantic model', async () => {
  const { validatedDocumentedComposioDefinitionContracts } = await import('../../integrations/composio/operation-semantics.js');
  const schema = { type: 'object', properties: {
    users: { type: 'string' }, channel: { type: 'string' },
    prevent_creation: { type: 'boolean' }, return_im: { type: 'boolean' },
  } };
  const contract = validatedDocumentedComposioDefinitionContracts({ operationId: 'SLACK_OPEN_DM', inputSchema: schema, outputSchema: null });
  assert.ok(contract.ok && contract.operationSemantics);
  if (!contract.ok || !contract.operationSemantics) throw Error('adapter contract missing');
  jev._setTypesafeKeyForTests(null);
  try {
    const call = await acceptedCall({ tag: 'documented-setup', operationId: 'SLACK_OPEN_DM', schema,
      args: { users: 'U1' }, destructive: false,
      operationSemantics: contract.operationSemantics as FixtureOptions['operationSemantics'] });
    assertProceedsWithoutCard(call.result, 'documented non-delivery setup is ordinary work');
    assert.equal(decided(call.result).call.effect, 'external_write', 'creation never masquerades as a read');
    assert.equal(jevRequests.length, 0);
    assert.equal(judgeRequests.length, 0);
    const send = await acceptedCall({ tag: 'documented-real-send', operationId: 'SLACK_SEND_MESSAGE', schema: SEND_SCHEMA,
      args: { channel: 'D1', text: 'Test' } });
    assertAsks(send.result, 'a real message retains content approval');
  } finally { jev._setTypesafeKeyForTests('fixture-key'); }
});
