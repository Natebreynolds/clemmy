import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import type { RegisteredHostCapability } from '../harness/host-capability-catalog-factory.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proven-op-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { renderProvenOperationGuidance, prepareProvenOperationForRequest, resolveCallableProvenDiscoverySkip, pickProvenRunStrategy, buildCachedProvenResolutionEntries } = await import('./proven-operation.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} = await import('../harness/host-capability-catalog-factory.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('../harness/capability-manifest.js');

function descriptor(id: string): HostCapabilityDescriptorV1 {
  return {
    id,
    effect: 'read',
    purpose: id,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
    inputShape: 'evidence',
    outputShape: 'evidence',
    outputKind: 'evidence',
    deliverableKind: 'evidence',
    destinationPosture: null,
    evidenceKinds: ['tool_result'],
    handleRequired: false,
    readbackRequired: false,
    accountScope: 'runtime',
    manifestDigest: id,
  };
}

const { recordRunStrategy } = await import('../../memory/run-strategy-store.js');
const { selectLearnedStrategyTools } = await import('../harness/host-run-strategy-learning.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('proven operation guidance tells the brain to skip tool_search when an invocation is disclosed', () => {
  const text = renderProvenOperationGuidance({
    id: 'strat-cal',
    objective: 'whats on my calendar today',
    keywords: ['calendar', 'today'],
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    createdAt: new Date().toISOString(),
    uses: 1,
  }, {
    outlook_get_calendar_view: { start_datetime: 'string', end_datetime: 'string' },
  }, [{
    tool: 'work_call',
    args: {
      requirement_id: 'cap:resolved:outlook_get_calendar_view',
      name: 'composio_execute_tool',
      args_json: '{"tool_slug":"OUTLOOK_GET_CALENDAR_VIEW","arguments":{"<argument>":"<value>"}}',
    },
  }]);
  assert.match(text, /skip tool_search/i);
  assert.match(text, /outlook_get_calendar_view/);
  assert.match(text, /work_call/);
  assert.match(text, /cap:resolved:outlook_get_calendar_view/);
  assert.match(text, /start_datetime/);
});

test('paraphrases and same-tool strategies bind without exact wording', async () => {
  const receipt = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:cal-para',
    sourceId: 'cal-para',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
  recordRunStrategy({
    objective: 'whats on my calendar today',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: receipt,
  });
  recordRunStrategy({
    objective: 'what is on my calendar tomorrow',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: evaluateLearningCandidate({
      target: 'strategy',
      authority: 'background_delivery_verifier',
      sessionId: 'background:cal-tom',
      sourceId: 'cal-tom',
      terminalSuccess: true,
      controllerValidation: true,
    }).receipt!,
  });
  const paraphrased = await prepareProvenOperationForRequest({ query: 'what on my calendar today' });
  assert.ok(paraphrased.text);
  assert.deepEqual(paraphrased.tools, ['outlook_get_calendar_view']);

  const sameTools = pickProvenRunStrategy([
    { score: 0.67, strategy: { id: 'a', objective: 'whats on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
    { score: 0.5, strategy: { id: 'b', objective: 'what is on my calendar tomorrow', keywords: ['calendar', 'tomorrow'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(sameTools?.id, 'a');

  const polluted = pickProvenRunStrategy([
    { score: 0.8, strategy: { id: 'dirty', objective: 'whats on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['workspace_roots', 'outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 7 } },
    { score: 0.67, strategy: { id: 'clean', objective: 'what on my calendar today', keywords: ['calendar', 'today'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(polluted?.toolsUsed.includes('outlook_get_calendar_view'), true);
  assert.equal(selectLearnedStrategyTools(polluted!.toolsUsed).join(), 'outlook_get_calendar_view');

  const disagree = pickProvenRunStrategy([
    { score: 0.6, strategy: { id: 'cal', objective: 'calendar today', keywords: ['calendar'], toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
    { score: 0.55, strategy: { id: 'sf', objective: 'find tim', keywords: ['tim'], toolsUsed: ['salesforce_sf_soql_query'], workerCount: 0, durationMs: 1, createdAt: '', uses: 1 } },
  ]);
  assert.equal(disagree, null);
});

test('an exact prior successful run names the proven tools without withholding search until they are callable', async () => {
  const receipt = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: 'background:cal',
    sourceId: 'cal-1',
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
  recordRunStrategy({
    objective: 'whats on my calendar today',
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    learningReceipt: receipt,
  });
  const prepared = await prepareProvenOperationForRequest({ query: 'whats on my calendar today' });
  assert.ok(prepared.text);
  assert.deepEqual(prepared.tools, ['outlook_get_calendar_view']);
  assert.equal(prepared.skipDiscoverySearch, false);
  assert.equal(prepared.capabilityRefs.length, 0);
  assert.match(prepared.text!, /outlook_get_calendar_view/);
});

test('cached proven skip entries require a unique active connection and a schema', () => {
  assert.deepEqual(buildCachedProvenResolutionEntries(['OUTLOOK_GET_CALENDAR_VIEW']), []);
});

test('skipDiscoverySearch stays off when a recorded skip has no currently callable ref', () => {
  const withheld = resolveCallableProvenDiscoverySkip({
    skipDiscoverySearch: true,
    descriptors: [descriptor('cap:resolved:fixture_local_read:stale')],
  });
  assert.equal(withheld.skipDiscoverySearch, false);

  const empty = resolveCallableProvenDiscoverySkip({
    skipDiscoverySearch: true,
    descriptors: [],
  });
  assert.equal(empty.skipDiscoverySearch, false);
});

test('skipDiscoverySearch remains gated on a currently callable disclosed ref', () => {
  const fingerprint = createHash('sha256').update('live:fixture_local_read').digest('hex');
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: 'cap:fixture-local-read',
    providerKind: 'local_registry',
    operationId: 'fixture_local_read',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: 'read',
    accountId: 'acct-local',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
    argumentCompiler: { id: 'compile:proof-schema:v1', version: '1' },
    invokePortId: 'invoke:fixture-local-read:v1',
  });
  const entry: RegisteredHostCapability = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  };
  const prior = peekHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory([entry]));
  try {
    assert.equal(isCurrentCallableCatalogEntry(entry), true);
    const callable = resolveCallableProvenDiscoverySkip({
      skipDiscoverySearch: true,
      descriptors: [descriptor(entry.capabilityId)],
    });
    assert.equal(callable.skipDiscoverySearch, true);
    assert.deepEqual(callable.descriptors.map((row) => row.id), [entry.capabilityId]);

    const stale = resolveCallableProvenDiscoverySkip({
      skipDiscoverySearch: true,
      descriptors: [descriptor('cap:resolved:fixture_local_read:missing')],
    });
    assert.equal(stale.skipDiscoverySearch, false);
  } finally {
    installHostCapabilityCatalogFactory(prior);
  }
});
