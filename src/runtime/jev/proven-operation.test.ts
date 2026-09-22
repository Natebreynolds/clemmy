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
  // The door stays open, and the ref is named for what it is (live 277962:
  // the cap:… ref was sent to tool_output_query as a call_id).
  assert.match(text, /tool_search stays available/);
  assert.match(text, /not a result/);
  assert.match(text, /outlook_get_calendar_view/);
  assert.match(text, /work_call/);
  assert.match(text, /cap:resolved:outlook_get_calendar_view/);
  assert.match(text, /start_datetime/);
  // No bound account was disclosed: nothing is claimed about accounts.
  assert.doesNotMatch(text, /Operating account already bound/);

  // Live 279653: three Outlook accounts connected, the host had routed the
  // account, and the brain still spent a 31 s frame on tool_search
  // account_selection. The guidance names the bound account and says so.
  const bound = renderProvenOperationGuidance({
    id: 'strat-cal',
    objective: 'whats on my calendar today',
    keywords: ['calendar', 'today'],
    toolsUsed: ['outlook_get_calendar_view'],
    workerCount: 0,
    durationMs: 40_000,
    createdAt: new Date().toISOString(),
    uses: 1,
  }, {}, [{ tool: 'work_call', args: { requirement_id: 'cap:resolved:outlook_get_calendar_view', name: 'composio_execute_tool', args_json: '{}' } }],
  [{ slug: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_one', label: 'alex@corp.example' }]);
  assert.match(bound, /Operating account already bound by the host/);
  assert.match(bound, /no account_selection and no tool_search/);
  // The turn that holds exact operation ids is the turn that can author them
  // as exact call steps instead of prompt steps that re-describe the read.
  assert.match(bound, /If this becomes a saved workflow, author these as exact call steps: call\.tool = the operation id \(OUTLOOK_GET_CALENDAR_VIEW\)/);
  assert.match(bound, /\{\{now\}\}, \{\{now\+24h\}\}/);
  assert.match(bound, /the host binds the account/);
  assert.match(bound, /OUTLOOK_GET_CALENDAR_VIEW: alex@corp\.example \(ca_one\)/);
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

test('the authoring line names only real operations: bound slugs first, else tools with a schema, never a step-only control tool', () => {
  // Live 281953: a workflow-step strategy (outlook_get_calendar_view +
  // workflow_step_result) was matched to a chat authoring request; the line
  // must not tell the brain to author workflow_step_result as a call step.
  const base = {
    id: 'strat-step', objective: 'Workflow: Invite digest Step: draft_digest', keywords: ['invite', 'digest'],
    toolsUsed: ['outlook_get_calendar_view', 'workflow_step_result'], workerCount: 0, durationMs: 1_000, createdAt: new Date().toISOString(), uses: 2,
  };
  const withSchema = renderProvenOperationGuidance(base, { outlook_get_calendar_view: { start_datetime: 'string' } }, [{ tool: 'work_call', args: {} }]);
  assert.match(withSchema, /author these as exact call steps: call\.tool = the operation id \(outlook_get_calendar_view\)/);
  assert.doesNotMatch(withSchema, /operation id \([^)]*workflow_step_result/);
  const noSchema = renderProvenOperationGuidance(base, {}, [{ tool: 'work_call', args: {} }]);
  assert.doesNotMatch(noSchema, /If this becomes a saved workflow/);
});

test('a strategy thins the surface only when it covers the request, not when it merely touches it', async () => {
  const { provenStrategyCoversRequest } = await import('./proven-operation.js');
  const { strategyKeywords } = await import('../../memory/run-strategy-store.js');
  const calendar = { keywords: strategyKeywords('whats on my calendar tomorrow') };
  assert.equal(provenStrategyCoversRequest('whats on my calendar tomorrow', calendar), true, 'the same short request is covered');
  assert.equal(provenStrategyCoversRequest('calendar tomorrow please', calendar), true);
  // Live 282184: an authoring request mentioning the calendar once.
  assert.equal(provenStrategyCoversRequest(
    "Create a workflow named 'Invite digest'. Steps: read my Outlook calendar for the next 24 hours, draft a short digest of invites awaiting my reply, ask me to review the draft before saving it to a file. Manual trigger only.",
    calendar,
  ), false, 'a sliver of a long request is not coverage');
});
