import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-plan-runtime-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });

const { resolveReviewedStepArguments, checkReviewedPlanPreparation, revalidateReviewedPlanPreparation } = await import('./reviewed-plan-runtime.js');
const log = await import('./eventlog.js');
const plans = await import('./plan-artifacts.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const schemas = await import('../../tools/composio-schema-cache.js');
const identity = await import('./reviewed-provider-identity.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const local = await import('./local-planning-capability.js');
const publisher = await import('../../tools/publish-plan.js');

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
test.after(() => { log.closeEventLog(); catalogs.installHostCapabilityCatalogFactory(null); manifestStores.installCapabilityManifestStore(null); rmSync(home, { recursive: true, force: true }); });

const step = { staticArguments: { subject: 'Reviewed exact LF\nsubject', nested: {} }, dependsOn: ['read'], dynamicBindings: [{ producerStepId: 'read', outputPath: '/data/id', targetPath: '/nested/id', expectedType: 'string' }] };
test('dynamic reviewed argument resolves exact durable producer path with static bytes unchanged', () => {
  const calls: string[] = [];
  assert.deepEqual(resolveReviewedStepArguments(step, id => { calls.push(id); return { data: { id: 'provider-exact-id' } }; }), { subject: step.staticArguments.subject, nested: { id: 'provider-exact-id' } });
  assert.deepEqual(calls, ['read']);
});
test('missing producer fields, wrong types, absent dependencies and static overrides refuse without guessing', () => {
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: {} })), /did not return/);
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: Object.create({ id: 'inherited-id' }) })), /did not return/);
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: { id: 42 } })), /type/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, dependsOn: [] }, () => ({})), /malformed/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, staticArguments: { nested: { id: 'override' } } }, () => ({ data: { id: 'actual' } })), /both a static/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, dynamicBindings: [...step.dynamicBindings, ...step.dynamicBindings] }, () => ({ data: { id: 'actual' } })), /ambiguous/);
});

test('reviewed native artifact arguments retain full bytes above the generic64KB limit', () => {
  const content = 'Exact reviewed native HTML content.\n'.repeat(2_500);
  assert.ok(Buffer.byteLength(content) > 75_000);
  assert.equal(resolveReviewedStepArguments({ staticArguments: { view_html: content }, dependsOn: [], dynamicBindings: [] }, () => { throw new Error('no producer required'); }).view_html, content);
});

test('whole settled results preserve arrays and objects without a guessed /data wrapper', () => {
  for (const payload of [[{ id: 'a' }], { actualProviderWrapper: { rows: [1, 2] } }]) {
    const result = resolveReviewedStepArguments({ staticArguments: {}, dependsOn: ['source'], dynamicBindings: [{ producerStepId: 'source', outputPath: '', targetPath: '/data', expectedType: 'json' }] }, () => payload);
    assert.deepEqual(result, { data: payload });
  }
});

/** A reviewed-CLI-style entry: no externalDefinition, schema deposited in the contract cache, digest sealed at registration. */
function reviewedCliEntry(operationId: string) {
  const manifest = manifests.attachSemanticContract({
    version: 1, manifestId: `cap:fixture:reviewed-cli:${operationId}`, providerKind: 'reviewed_cli', operationId,
    providerIdentity: '/usr/bin/fixture-cli', providerVersion: 'fixture-v1', operationVersion: '1',
    definitionFingerprint: sha256(`definition:${operationId}`), effect: 'read', accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-09-01T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' },
  });
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  schemas.rememberToolSchema(operationId, schema, Date.now());
  const cached = schemas.getCachedToolSchema(operationId)!;
  const entry = {
    capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, providerInputSchemaDigest: identity.providerInputSchemaDigestOf(cached),
    manifest, invoke: async () => ({ records: [], has_more: false }),
  };
  return { manifest, schema, cached, entry };
}

function providerPlanFixture(operationId: string) {
  log.resetEventLog();
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  const f = reviewedCliEntry(operationId);
  factory.register(f.entry);
  const session = log.createSession({ id: `reviewed-runtime-${operationId}`, kind: 'chat', userId: 'owner' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan the query.', taskMode: { version: 1, kind: 'plan' } } });
  const canonical = catalogs.canonicalCatalogIdentityOf(f.entry)!;
  const structuredPlan = {
    steps: [{ id: 'query', action: 'Run the reviewed query.', effect: 'read', capabilityRef: f.manifest.manifestId, staticArguments: { query: 'SELECT Id FROM Account' },
      dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Rows returned.' }],
    successCriteria: ['Rows returned.'], subagents: [], executionDraft: null,
    preparedBindings: [{ stepId: 'query', capabilityRef: f.manifest.manifestId, identity: canonical, inputSchema: f.cached,
      argumentValidation: 'static_schema_checked', source: { sessionId: session.id, sourceUserSeq: source.seq } }],
    preparationIssues: [],
  } as never;
  const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'owner', fullText: 'Run the reviewed query.', structuredPlan, readiness: 'ready' });
  return { ...f, factory, session, source, artifact, canonical };
}

test('checkReviewedPlanPreparation passes a current reviewed-CLI step and refuses a mutated schema, a changed identity and a missing entry by reason', async () => {
  const f = providerPlanFixture('reviewed_cli_check_fixture');
  const checked = await checkReviewedPlanPreparation(f.artifact);
  assert.equal(checked.length, 1);
  assert.equal(checked[0]!.kind, 'provider');
  assert.equal(log.listEvents(f.session.id, { types: ['guardrail_tripped'] }).length, 0, 'a passing check journals nothing');
  const reasons = () => log.listEvents(f.session.id, { types: ['guardrail_tripped'] })
    .filter(event => event.data.kind === 'plan_execution_revalidation_refused').map(event => event.data.reason);

  schemas.rememberToolSchema(f.manifest.operationId, { ...f.schema, properties: { query: { type: 'string' }, limit: { type: 'number' } } }, Date.now());
  await assert.rejects(checkReviewedPlanPreparation(f.artifact, { sessionId: f.session.id, sourceUserSeq: f.source.seq }), /changed or is unavailable/);
  assert.deepEqual(reasons(), ['schema_digest_mismatch']);
  schemas.rememberToolSchema(f.manifest.operationId, f.schema, Date.now());
  await checkReviewedPlanPreparation(f.artifact);

  const drifted = { ...f.entry, account: 'reviewed_cli:other', manifest: { ...f.manifest, accountId: 'reviewed_cli:other' } };
  drifted.manifestDigest = manifests.capabilityManifestDigest(drifted.manifest);
  f.factory.forget(f.entry.capabilityId);
  f.factory.register(drifted);
  await assert.rejects(checkReviewedPlanPreparation(f.artifact, { sessionId: f.session.id }), /changed or is unavailable/);
  assert.deepEqual(reasons(), ['schema_digest_mismatch', 'identity_mismatch']);

  f.factory.forget(f.entry.capabilityId);
  await assert.rejects(checkReviewedPlanPreparation(f.artifact, { sessionId: f.session.id }), /changed or is unavailable/);
  assert.deepEqual(reasons(), ['schema_digest_mismatch', 'identity_mismatch', 'entry_missing']);
  assert.equal(plans.getPlanExecutionClaim({ sessionId: f.session.id, principalId: 'owner', ref: { planId: f.artifact.planId, revision: f.artifact.revision, digest: f.artifact.digest } }), null,
    'the check never needs or mints a claim');
});

test('revalidateReviewedPlanPreparation still requires the claim, runs the same check, and attaches the exact local selection to the execution source', async () => {
  log.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const session = log.createSession({ id: 'reviewed-runtime-attach', kind: 'chat' });
  const planSource = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Write the brief.', taskMode: { version: 1, kind: 'plan' } } });
  const planIdentity = { sessionId: session.id, sourceUserSeq: planSource.seq };
  const primedPlan = await semantic.primePrimaryModelPlanningCatalog(planIdentity);
  assert.ok(primedPlan.ok, JSON.stringify(primedPlan)); if (!primedPlan.ok) return;
  const { getCoreTools } = await import('../../tools/registry.js');
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({ name: 'write_file', carrier: 'work_call', configuredNames: new Set(getCoreTools().map(tool => tool.name)) });
  assert.ok(candidate && !('refused' in candidate)); if (!candidate || 'refused' in candidate) return;
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primedPlan.planning.authority, candidates: [candidate] });
  const capabilityRef = refs.write_file!;
  const prepared = await publisher.preparePlanOutline({ planning: primedPlan.planning, ...planIdentity, ready: true, raw: {
    steps: [{ id: 'save', action: 'Save the brief.', effect: 'local_write', capabilityRef, staticArguments: { path: path.join(home, 'brief.md'), content: 'hello' },
      dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Read it back.' }],
    successCriteria: ['Saved.'], subagents: [],
  } });
  const artifact = plans.publishPlanRevision({ ...planIdentity, principalId: session.id, fullText: 'Save the brief.', structuredPlan: prepared, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const executeSource = log.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute it.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  const executeIdentity = { sessionId: session.id, sourceUserSeq: executeSource.seq };
  // Before the claim only the pure check is available: it needs no accepted
  // execution and attaches nothing.
  const preflight = await checkReviewedPlanPreparation(artifact);
  assert.deepEqual(preflight.map(row => row.kind), ['local_registry']);
  assert.equal(plans.getPlanExecutionClaim({ sessionId: session.id, principalId: session.id, ref }), null);
  plans.claimPlanExecution({ ...executeIdentity, principalId: session.id, executeRef: ref });
  log.closeEventLog();
  const primed = await semantic.primePrimaryModelPlanningCatalog(executeIdentity);
  assert.ok(primed.ok); if (!primed.ok) return;
  const checked = await checkReviewedPlanPreparation(artifact);
  assert.deepEqual(checked.map(row => row.kind), ['local_registry']);
  await revalidateReviewedPlanPreparation(primed.planning);
  const attached = semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority)?.capabilities.find(row => row.id === capabilityRef);
  assert.ok(attached, 'revalidation attaches the exact approved local selection to the execution source');
  assert.equal(attached.effect, 'local_write');
  assert.equal(log.listEvents(session.id, { types: ['tool_called'] }).length, 0);
});
