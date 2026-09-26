/**
 * Learned request effects: a generic provider tool's request shape, found to
 * read only by two models from a settled call's own evidence, is a read from
 * then on, below every declaration and curated rule, and never before a
 * settled call has shown it.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/learned-request-effect.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learned-request-effect-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
const learner = await import('./learned-request-effect.js');
const store = await import('./learned-request-effect-store.js');
const gate = await import('./execution-gate.js');
const declared = await import('../mcp-declared-effects.js');
const jev = await import('../jev/client.js');
const ports = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort } = await import('../semantic-boundary/configured-brain-semantic-port.js');
const catalog = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

// A generic request tool: one definition for every endpoint it can reach.
const TOOL = 'mcp__seo_vendor__api_request';
const OPERATION = 'seo_vendor__api_request';
const LIVE_ARGS = { method: 'POST', path: '/v3/serp/google/organic/live/advanced', data: [{ keyword: 'dui lawyer mesa' }] };
const LIVE_RESPONSE = JSON.stringify({ status_code: 20000, cost: 0.002, tasks: [{ id: '09261234-1535-0066-0000-abc', status_message: 'Ok.', result: [{ items: [{ rank_absolute: 1, url: 'https://example.com' }] }] }] });
const LIVE_SHAPE = { method: 'POST', pathTemplate: '/v3/serp/google/organic/live/advanced' };

let jevAnswer: number | null = 0.02;
let jevModel = 'jev-fixture';
const jevRequests: Array<Record<string, unknown>> = [];
jev._setTypesafeKeyForTests('fixture-key');
jev._setSystemOneFetchForTests(async (_url, init) => {
  jevRequests.push(JSON.parse(init.body) as Record<string, unknown>);
  if (jevAnswer === null) return { status: 503, ok: false, text: async () => 'unavailable' };
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      model: jevModel,
      answers: { changes: { type: 'noul', noul: jevAnswer } },
      usage: { input_tokens: 30, output_tokens: 2 },
    }),
  };
});

type JudgeRaw = Record<string, unknown> | ((evidenceDigest: string) => Record<string, unknown>);
let judgeRaw: JudgeRaw = (evidenceDigest) => ({ changesProvider: 'no', confidence: 0.95, evidenceDigest });
let judgeModel = 'judge-fixture-model';
const judgeRequests: Array<{ purpose: string; system: string; user: string; schemaName: string }> = [];
function installJudge(): void {
  ports.installTurnSemanticModelPort(configuredBrainSemanticPort(async (request) => {
    judgeRequests.push(request);
    const { evidenceDigest } = JSON.parse(request.user) as { evidenceDigest: string };
    return {
      raw: typeof judgeRaw === 'function' ? judgeRaw(evidenceDigest) : judgeRaw,
      modelIdentity: judgeModel,
      inputTokens: 90,
      outputTokens: 12,
      latencyMs: 2,
    };
  }));
}
installJudge();

beforeEach(() => {
  store._resetLearnedRequestEffectsForTests();
  learner._resetRequestEffectLearningForTests();
  declared._resetDeclaredMcpToolEffectsForTest();
  jevAnswer = 0.02;
  jevModel = 'jev-fixture';
  judgeRaw = (evidenceDigest) => ({ changesProvider: 'no', confidence: 0.95, evidenceDigest });
  judgeModel = 'judge-fixture-model';
  jevRequests.length = 0;
  judgeRequests.length = 0;
  installJudge();
});

after(() => {
  jev._setSystemOneFetchForTests(undefined);
  jev._setTypesafeKeyForTests(undefined);
  ports.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('a request shape is the method and the path with identifiers replaced', () => {
  assert.deepEqual(learner.requestShapeOf(LIVE_ARGS), LIVE_SHAPE);
  assert.deepEqual(learner.requestShapeOf(JSON.stringify(LIVE_ARGS)), LIVE_SHAPE, 'string arguments are read the same way');
  assert.deepEqual(
    learner.requestShapeOf({ method: 'get', url: 'https://API.example.com/v2/Tasks/1234567/results?page=2#top' }),
    { method: 'GET', pathTemplate: 'api.example.com/v2/tasks/{id}/results' },
    'a full URL keeps its host; numbers, query and fragment do not make a new shape',
  );
  assert.equal(learner.requestPathTemplate('/a/550e8400-e29b-41d4-a716-446655440000/b/deadbeefcafe1234'), '/a/{id}/b/{id}');
  assert.equal(learner.requestShapeOf({ method: 'POST' }), null, 'a method without a path is no shape');
  assert.equal(learner.requestShapeOf({ path: '/v3/x' }), null, 'a path without a method is no shape');
  assert.equal(learner.requestShapeOf({ method: 'POST', path: 'v3/no-leading-slash' }), null);
  assert.equal(learner.requestShapeOf('not json'), null);
});

test('a verdict round-trips through the store and is exact to its shape', () => {
  const verdict: import('./learned-request-effect-store.js').LearnedRequestEffectVerdictV1 = {
    version: 1, providerKind: 'native_mcp', operationId: OPERATION, shape: LIVE_SHAPE, verdict: 'reads_only',
    evidenceDigest: sha('evidence'),
    screen: { model: 'jev-fixture', changeProbability: 0.02 },
    confirm: { role: 'judge', model: 'judge-fixture-model', changesProvider: 'no', confidence: 0.95 },
    learnedAt: new Date().toISOString(),
  };
  assert.equal(store.rememberLearnedRequestEffect(verdict), true);
  assert.deepEqual(store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE), verdict);
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', OPERATION, { ...LIVE_SHAPE, method: 'PUT' }), null, 'another method is another shape');
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', OPERATION, { ...LIVE_SHAPE, pathTemplate: '/v3/serp/google/organic/task_post' }), null);
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', 'other_vendor__api_request', LIVE_SHAPE), null, 'another operation is another key');
  assert.equal(store.learnedRequestEffectVerdict('composio', OPERATION, LIVE_SHAPE), null, 'only native tools learn request effects today');
  // One model reading twice is one reading; a verdict that says so is not a verdict.
  assert.equal(store.rememberLearnedRequestEffect({ ...verdict, confirm: { ...verdict.confirm, model: 'jev-fixture' } }), false);
  assert.equal(store.rememberLearnedRequestEffect({ ...verdict, screen: { ...verdict.screen, changeProbability: 0.5 } }), false);
  assert.equal(store.rememberLearnedRequestEffect({ ...verdict, confirm: { ...verdict.confirm, confidence: 0.5 } }), false);
  assert.equal(store.forgetLearnedRequestEffect('native_mcp', OPERATION, LIVE_SHAPE), true);
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE), null);
});

test('both models read the request and the response, never the tool name, and only their agreement is recorded', async () => {
  const outcome = await learner.learnRequestEffect(
    { providerKind: 'native_mcp', operationId: OPERATION, args: LIVE_ARGS, result: LIVE_RESPONSE },
    { sessionId: 'session-a' },
  );
  assert.equal(outcome, 'learned');
  const verdict = store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE);
  assert.ok(verdict);
  assert.deepEqual(verdict.screen, { model: 'jev-fixture', changeProbability: 0.02 });
  assert.deepEqual(verdict.confirm, { role: 'judge', model: 'judge-fixture-model', changesProvider: 'no', confidence: 0.95 });

  assert.equal(jevRequests.length, 1);
  const jevText = JSON.stringify(jevRequests[0]);
  assert.match(jevText, /organic\/live\/advanced/);
  assert.match(jevText, /rank_absolute/, 'Jev reads the provider response');
  assert.doesNotMatch(jevText, /seo_vendor|api_request/, 'the tool name is not evidence');
  assert.equal(judgeRequests.length, 1);
  assert.equal(judgeRequests[0]!.purpose, 'request_effect_judge');
  assert.equal(judgeRequests[0]!.schemaName, 'RequestEffectJudgeV1');
  const judgeUser = JSON.parse(judgeRequests[0]!.user) as Record<string, unknown>;
  assert.equal(judgeUser.method, 'POST');
  assert.equal(judgeUser.pathTemplate, LIVE_SHAPE.pathTemplate);
  assert.equal(judgeUser.evidenceDigest, verdict.evidenceDigest);
  assert.doesNotMatch(judgeRequests[0]!.user, /seo_vendor|api_request/);

  assert.equal(await learner.learnRequestEffect(
    { providerKind: 'native_mcp', operationId: OPERATION, args: LIVE_ARGS, result: LIVE_RESPONSE },
  ), 'already_learned', 'a learned shape is not read again');
  assert.equal(jevRequests.length, 1);
});

test('a screen that is unsure but not alarmed hands the request to the judge, who decides', async () => {
  // Live 2026-09-26 14:32: Jev put two live SERP reads at 0.21 and 0.17.
  jevAnswer = 0.21;
  const outcome = await learner.learnRequestEffect(
    { providerKind: 'native_mcp', operationId: OPERATION, args: LIVE_ARGS, result: LIVE_RESPONSE },
  );
  assert.equal(outcome, 'learned');
  assert.equal(judgeRequests.length, 1, 'the judge read the evidence');
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE)?.screen.changeProbability, 0.21);
});

test('disagreement, doubt, a mismatched digest, one model, or missing evidence records nothing', async () => {
  const input = { providerKind: 'native_mcp' as const, operationId: OPERATION, args: LIVE_ARGS, result: LIVE_RESPONSE };
  jevAnswer = 0.4;
  assert.equal(await learner.learnRequestEffect(input), 'screen_not_confident');
  assert.equal(judgeRequests.length, 0, 'an unconvinced screen never reaches the judge');
  jevAnswer = 0.02;
  judgeRaw = (d) => ({ changesProvider: 'yes', confidence: 0.99, evidenceDigest: d });
  assert.equal(await learner.learnRequestEffect(input), 'confirm_disagreed');
  judgeRaw = (d) => ({ changesProvider: 'uncertain', confidence: 0.99, evidenceDigest: d });
  assert.equal(await learner.learnRequestEffect(input), 'confirm_not_confident');
  judgeRaw = (d) => ({ changesProvider: 'no', confidence: 0.6, evidenceDigest: d });
  assert.equal(await learner.learnRequestEffect(input), 'confirm_not_confident');
  judgeRaw = { changesProvider: 'no', confidence: 0.99, evidenceDigest: sha('elsewhere') };
  assert.equal(await learner.learnRequestEffect(input), 'confirm_mismatched');
  judgeRaw = (d) => ({ changesProvider: 'no', confidence: 0.99, evidenceDigest: d });
  judgeModel = 'jev-fixture';
  assert.equal(await learner.learnRequestEffect(input), 'confirm_unavailable', 'two readings by one model are one reading');
  judgeModel = 'judge-fixture-model';
  jevAnswer = null;
  assert.equal(await learner.learnRequestEffect(input), 'screen_unavailable');
  jevAnswer = 0.02;
  assert.equal(await learner.learnRequestEffect({ ...input, args: { data: [{ keyword: 'x' }] } }), 'no_shape');
  assert.equal(await learner.learnRequestEffect({ ...input, result: '' }), 'no_evidence');
  assert.equal(store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE), null);
});

test('a learned read lowers the frame for that shape only, below every declaration and the manifest', () => {
  // Before anything is learned: unknown, so a mutation, as before.
  const before = gate.classifyCanonicalExternalEffect(TOOL, LIVE_ARGS);
  assert.equal(before.mutating, true);
  assert.equal(before.classificationKnown, false);
  // A method typed by the model does not lower the frame (unchanged pin).
  assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, method: 'GET' }), true);

  assert.ok(store.rememberLearnedRequestEffect({
    version: 1, providerKind: 'native_mcp', operationId: OPERATION, shape: LIVE_SHAPE, verdict: 'reads_only',
    evidenceDigest: sha('evidence'),
    screen: { model: 'jev-fixture', changeProbability: 0.02 },
    confirm: { role: 'judge', model: 'judge-fixture-model', changesProvider: 'no', confidence: 0.95 },
    learnedAt: new Date().toISOString(),
  }));
  const learned = gate.classifyCanonicalExternalEffect(TOOL, LIVE_ARGS);
  assert.equal(learned.external, true);
  assert.equal(learned.mutating, false, 'the learned shape is a read');
  assert.equal(learned.classificationKnown, false, 'learned from results, not proven by the provider');
  assert.equal(learned.reversibility, 'unknown');
  assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), false);
  assert.equal(gate.classifyCanonicalExternalEffect('seo_vendor__api_request', LIVE_ARGS).external, false,
    'a carrier-less name still proves no native boundary here, as before');
  assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, keyword: 'other', data: [{ keyword: 'other' }] }), false,
    'any call of the same endpoint shares the shape');
  assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, path: '/v3/serp/google/organic/task_post' }), true,
    'another endpoint is not covered');
  assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, method: 'DELETE' }), true, 'another method is not covered');
  assert.equal(gate.isMutatingExternalWrite('mcp__other_vendor__api_request', LIVE_ARGS), true, 'another tool is not covered');

  // The server's own destructive declaration is never overridden.
  declared.recordDeclaredMcpToolEffect(TOOL, { readOnlyHint: false, destructiveHint: true });
  const destructive = gate.classifyCanonicalExternalEffect(TOOL, LIVE_ARGS);
  assert.equal(destructive.mutating, true);
  assert.equal(destructive.classificationKnown, true);
  declared._resetDeclaredMcpToolEffectsForTest();
  // A declared "may write" (the generic tool's honest hint) is what a learned shape refines.
  declared.recordDeclaredMcpToolEffect(TOOL, { readOnlyHint: false, destructiveHint: false });
  assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), false);
  assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, path: '/v3/serp/google/organic/task_post' }), true);
});

test('the operation a native request is learned under', () => {
  assert.equal(gate.nativeRequestOperationId('mcp__seo_vendor__api_request'), OPERATION);
  assert.equal(gate.nativeRequestOperationId('seo_vendor__api_request'), OPERATION, 'the carrier-less settlement spelling');
  assert.equal(gate.nativeRequestOperationId('api_request'), null, 'no server, no native operation');
  assert.equal(gate.nativeRequestOperationId('composio_execute_tool'), null);
  assert.equal(gate.nativeRequestOperationId('mcp__acme__composio_execute_tool'), null);
  assert.equal(gate.nativeRequestOperationId('mcp__acme__cx_send'), null);
  assert.equal(gate.nativeRequestOperationId(''), null);
});

test('a provider call that settled as an unclassified write offers its evidence, and the next call of that shape is a read', async () => {
  const session = eventlog.createSession({ id: 'learned-request-effect-settlement', kind: 'chat', channel: 'desktop', userId: 'fixture-owner' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'TEST FIXTURE: quick SEO audit.', userId: 'fixture-owner' },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const settle = (label: string, args: unknown, mutating: boolean) => {
    const logicalToolCallId = `logical:${label}`;
    const opened = dispatch.beginPhysicalDispatch({
      identity: { ...task, logicalToolCallId, physicalDispatchId: `dispatch:${label}`, ordinal: 0 },
      tool: OPERATION, args,
    });
    assert.equal(opened.status, 'inserted', JSON.stringify(opened));
    if (opened.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: OPERATION, outcome: 'returned' });
    const committed = settlements.commitLogicalCallSettlement({
      identity: { ...task, logicalToolCallId },
      contract: { toolName: OPERATION, args },
      execution: { kind: 'provider_execution' },
      result: { payload: LIVE_RESPONSE },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating },
      observer: { lane: 'byo', turn: task.turn },
    });
    assert.equal(committed.status, 'committed', JSON.stringify(committed));
  };
  // The live shape: the host classified the call as a write because it could not tell.
  assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), true);
  settle('serp-live', LIVE_ARGS, true);
  await learner._drainRequestEffectLearningForTests();
  assert.equal(jevRequests.length, 1, 'the settled call was offered to Jev');
  assert.equal(judgeRequests.length, 1, 'and confirmed by the judge');
  assert.ok(store.learnedRequestEffectVerdict('native_mcp', OPERATION, LIVE_SHAPE));
  assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), false, 'the next call of that shape is a read from the start');
  // A call that settled as a read offers nothing; neither does a learned shape.
  settle('serp-live-again', LIVE_ARGS, false);
  settle('serp-live-learned', { ...LIVE_ARGS, data: [{ keyword: 'other' }] }, true);
  await learner._drainRequestEffectLearningForTests();
  assert.equal(jevRequests.length, 1);
});

/** The live shape of a native generic tool's manifest (DataForSEO api_request,
 *  2026-09-26): sealed external_write from readOnly:false, nothing documented. */
function sealedMayWriteManifest(hints: { readOnly: boolean | null; destructive: boolean | null }, semantics?: { version: 1; reversibility: 'reversible' }) {
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:test:${sha(OPERATION).slice(0, 20)}`,
    providerKind: 'native_mcp',
    operationId: OPERATION,
    providerIdentity: 'mcp-config:seo_vendor:test',
    providerVersion: 'mcp-config-v1:test',
    operationVersion: 'mcp-tool-v1:test',
    definitionFingerprint: sha(`schema:${OPERATION}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: sha('input-schema'),
      semanticName: 'api_request',
      behaviorHints: { readOnly: hints.readOnly, destructive: hints.destructive, idempotent: false, openWorld: true },
    },
    effect: 'external_write',
    ...(semantics ? { operationSemantics: semantics } : {}),
    destination: { family: 'seo_vendor', posture: 'named_existing' },
    accountId: 'native_mcp:seo_vendor:test',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'result' },
    evidenceContract: { kinds: ['result'], readbackRequired: false },
    provenance: { issuer: 'host:native-mcp-live-materializer:v1', issuedAt: '2026-09-26T20:53:04.058Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['capability'],
  });
  const registered: import('./host-capability-catalog-factory.js').RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  };
  return registered;
}

function withCatalog<T>(entries: ReturnType<typeof sealedMayWriteManifest>[], run: () => T): T {
  catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory(entries));
  try { return run(); } finally { catalog.installHostCapabilityCatalogFactory(null); }
}

test('under the live manifest that seals "may write" as a write, the shape is learnable and a learned read refines it', () => {
  const verdict = {
    version: 1 as const, providerKind: 'native_mcp' as const, operationId: OPERATION, shape: LIVE_SHAPE, verdict: 'reads_only' as const,
    evidenceDigest: sha('evidence'),
    screen: { model: 'jev-fixture', changeProbability: 0.02 },
    confirm: { role: 'judge' as const, model: 'judge-fixture-model', changesProvider: 'no' as const, confidence: 0.95 },
    learnedAt: new Date().toISOString(),
  };
  withCatalog([sealedMayWriteManifest({ readOnly: false, destructive: false })], () => {
    const sealed = gate.classifyCanonicalExternalEffect(TOOL, LIVE_ARGS);
    assert.equal(sealed.mutating, true, 'the sealed declaration is a write before anything is learned');
    assert.equal(sealed.classificationKnown, true, 'and a known one: no approval card is owed (unchanged)');
    assert.equal(gate.requestEffectLearnable(TOOL, LIVE_ARGS), true, 'so a settled call may teach its shape');
    assert.ok(store.rememberLearnedRequestEffect(verdict));
    const learned = gate.classifyCanonicalExternalEffect(TOOL, LIVE_ARGS);
    assert.equal(learned.mutating, false, 'the learned shape is a read under the manifest');
    assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), false);
    assert.equal(gate.isMutatingExternalWrite(TOOL, { ...LIVE_ARGS, path: '/v3/serp/google/organic/task_post' }), true, 'other endpoints stay sealed writes');
    assert.equal(gate.requestEffectLearnable(TOOL, { ...LIVE_ARGS, path: '/v3/serp/google/organic/task_post' }), true);
  });
  // A destructive declaration, or documented semantics, is never refined and never learnable.
  withCatalog([sealedMayWriteManifest({ readOnly: false, destructive: true })], () => {
    assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), true);
    assert.equal(gate.requestEffectLearnable(TOOL, LIVE_ARGS), false);
  });
  withCatalog([sealedMayWriteManifest({ readOnly: false, destructive: false }, { version: 1, reversibility: 'reversible' })], () => {
    assert.equal(gate.isMutatingExternalWrite(TOOL, LIVE_ARGS), true);
    assert.equal(gate.requestEffectLearnable(TOOL, LIVE_ARGS), false);
  });
  // Without a manifest an unknown write is learnable as before; a proven read is not.
  assert.equal(gate.requestEffectLearnable(TOOL, { ...LIVE_ARGS, path: '/v3/other' }), true);
  declared.recordDeclaredMcpToolEffect(TOOL, { readOnlyHint: true });
  assert.equal(gate.requestEffectLearnable(TOOL, LIVE_ARGS), false);
});
