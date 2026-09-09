import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext } from '@openai/agents';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-publish-plan-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const publisher = await import('./publish-plan.js');
const log = await import('../runtime/harness/eventlog.js');
const local = await import('../runtime/harness/local-planning-capability.js');
const runtime = await import('./local-runtime-tools.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const catalog = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const { closedCanonicalJson } = await import('../shared/closed-canonical-json.js');
test.after(() => { log.closeEventLog(); catalog.installHostCapabilityCatalogFactory(null); manifests.installCapabilityManifestStore(null); rmSync(home, { recursive: true, force: true }); });
function outline(capabilityRef: string | null, args: Record<string, unknown>): any {
  return { executionDraft: capabilityRef ? {
    criteria: ['One exact native workflow definition is saved.'], cardinality: null,
    destination: { posture: 'create_new', family: 'workflow', handleRequired: true },
    topology: { version: 1, operations: [{ id: 'create_workflow', effect: 'local_write', coverage: null, dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } }], universes: [] },
    bindings: [{ operationId: 'create_workflow', role: 'destination', capabilityRef, evidence: ['local_commit_receipt'] }],
    deliverables: [{ id: 'workflow', kind: 'workflow' }], evidenceRequirements: ['local_commit_receipt'],
  } : null,
  steps: [{ id: 'create_workflow', action: 'Create the reviewed workflow.', effect: 'local_write', capabilityRef, staticArguments: args, dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Durable native commit receipt.' }],
  successCriteria: ['The exact native workflow is saved.'], subagents: [] };
}
async function fixture(name = 'workflow_create') {
  log.resetEventLog(); catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory()); manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const session = log.createSession({ id: 'workflow-preparation', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Create a workflow with a single compute step.', taskMode: { version: 1, kind: 'plan' } } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok, JSON.stringify(primed)); if (!primed.ok) throw new Error(primed.reason);
  const { getCoreTools } = await import('./registry.js');
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({ name, carrier: 'work_call', configuredNames: new Set(getCoreTools().map(tool => tool.name)) });
  assert.ok(candidate && !('refused' in candidate)); if (!candidate || 'refused' in candidate) throw new Error('no native candidate');
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates: [candidate] });
  return { ...identity, planning: primed.planning, capabilityRef: refs[name]! };
}

test('core file schema survives discovered Plan publication and exact Execute reopen without a deferred registry row', async () => {
  const f = await fixture('write_file');
  assert.equal(runtime.getLocalToolSchemas().has('write_file'), false, 'the actual carrier mismatch remains in the fixture');
  const raw = outline(f.capabilityRef, { path: path.join(home, 'review.md'), content: 'Acorn: 60%\nCedar: 110%\n' });
  raw.executionDraft.destination.family = 'file';
  raw.executionDraft.deliverables = [{ id: 'brief', kind: 'file' }];
  const prepared = await publisher.preparePlanOutline({ ...f, raw, ready: true });
  assert.ok((prepared.preparedBindings as any[])[0].inputSchema.properties.content);
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const reviewed = await import('../runtime/harness/reviewed-plan-runtime.js');
  const artifact = plans.publishPlanRevision({ ...f, principalId: f.sessionId, fullText: 'Write the reviewed brief.', structuredPlan: prepared, readiness: 'ready' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const source = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute the reviewed brief.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  plans.claimPlanExecution({ sessionId: f.sessionId, sourceUserSeq: source.seq, principalId: f.sessionId, executeRef: ref });
  log.closeEventLog();
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: f.sessionId, sourceUserSeq: source.seq });
  assert.ok(primed.ok); if (!primed.ok) return;
  await reviewed.revalidateReviewedPlanPreparation(primed.planning);
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0, 'publication and reopen never execute the file write');
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: { ...raw, steps: [{ ...raw.steps[0], staticArguments: { path: 42 } }] }, ready: true }), /static arguments/);
});

test('the real publication failure emits the machine code consumed by settlement', async () => {
  const { executionDraft, ...publicOutline } = outline(null, {});
  publicOutline.steps = publicOutline.steps.map(({ staticArguments: _args, ...step }: any) => ({ ...step, staticArgumentsJson: '{}' }));
  const result = await publisher.buildPublishPlanTool().invoke(new RunContext(), JSON.stringify({ execution_draft: executionDraft,
    full_text: 'A plan with no accepted foreground context.', structured_plan: publicOutline, readiness: 'needs_input', missing_prerequisites: [], base_ref_json: null }));
  const refusal = JSON.parse(String(result));
  assert.equal(refusal.error, 'plan_preparation_failed');
  assert.equal(refusal.code, 'plan_preparation_failed', 'the producer must supply the exact machine code; the test must not invent it');
});
test('ready workflow plan records real native schema/ref/effect and canonical reopen preserves identity', async () => {
  const f = await fixture();
  assert.equal(f.capabilityRef, 'cap:local:workflow_create:reversible');
  const args = { name: 'Reviewed Workflow', description: 'Compute a fixture result.', steps: [{ id: 'compute', prompt: 'Return the literal complete.', sideEffect: 'read' }] };
  const prepared = await publisher.preparePlanOutline({ ...f, raw: outline(f.capabilityRef, args), ready: true });
  const binding = (prepared.preparedBindings as any[])[0];
  assert.equal(binding.identity.kind, 'local_registry'); assert.equal(binding.identity.definition.descriptor.effect, 'local_write');
  assert.equal(binding.argumentValidation, 'static_schema_checked'); assert.ok(binding.inputSchema.properties.steps);
  const revalidated = await local.revalidateLocalPlanningDefinition(JSON.parse(closedCanonicalJson(binding.identity.definition)));
  assert.equal(revalidated.ok, true, JSON.stringify(revalidated));
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0, 'preparation does not invoke native workflow creation');
});
test('missing tools remain inspectable draft prerequisites, never ready capabilities', async () => {
  const f = await fixture();
  const draft = await publisher.preparePlanOutline({ ...f, raw: outline(null, {}), ready: false });
  assert.equal((draft.preparedBindings as any[]).length, 0); assert.match(String((draft.preparationIssues as any[])[0]), /discover and cite/);
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: outline('cap:local:invented', {}), ready: true }), /discover and cite/);
});
test('wrong native arguments and mismatched effects/dependencies cannot be called ready', async () => {
  const f = await fixture();
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: outline(f.capabilityRef, { name: 'Missing graph' }), ready: true }), /static arguments/);
  const wrongEffect = outline(f.capabilityRef, {}); wrongEffect.steps[0]!.effect = 'external_write';
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: wrongEffect, ready: true }), /disagrees/);
  wrongEffect.executionDraft.topology.operations[0].effect = 'external_write';
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: wrongEffect, ready: true }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /has effect local_write, not external_write/);
    assert.match(error.message, /both this step.effect and its matching execution_draft topology operation.effect to local_write/);
    assert.doesNotMatch(error.message, /discover and cite/);
    return true;
  });
  const cycle = outline(f.capabilityRef, {}); cycle.steps[0]!.dependsOn = ['create_workflow'];
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: cycle, ready: true }), /cycle/);
});

test('ready native plan retains full large reviewed arguments with no truncation', async () => {
  const f = await fixture();
  const content = 'Exact reviewed workflow instructions.\n'.repeat(2_500);
  assert.ok(Buffer.byteLength(content) > 75_000);
  const args = { name: 'Reviewed Full Workflow', description: 'Exact full prompt proof.', steps: [{ id: 'compute', prompt: content, sideEffect: 'read' }] };
  const prepared = await publisher.preparePlanOutline({ ...f, raw: outline(f.capabilityRef, args), ready: true });
  assert.equal((prepared.steps as any[])[0].staticArguments.steps[0].prompt, content);
});

test('publication exposes the outline shape and rejects the live guessed account metadata before preparation', () => {
  const tool = publisher.buildPublishPlanTool();
  const parameters = tool.parameters as any;
  const schema = parameters.properties.structured_plan;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['steps', 'subagents', 'successCriteria']);
  assert.ok(schema.properties.steps.items.properties.staticArgumentsJson);
  assert.equal(parameters.properties.structured_plan_json, undefined, 'the entire outline is no longer hidden inside a string');
  const raw = outline(null, {});
  const { executionDraft: _draft, ...publicOutline } = raw;
  publicOutline.steps = raw.steps.map(({ staticArguments, ...step }: any) => ({ ...step, staticArgumentsJson: JSON.stringify(staticArguments) }));
  for (const key of ['account', 'targetAccount']) {
    const result = publisher.PlanPublicationOutlineSchema.safeParse({ ...publicOutline, [key]: { toolkit: 'outlook', identity: 'fixture@example.invalid' } });
    assert.equal(result.success, false, `live guessed field ${key} cannot enter the typed outline`);
  }
});

test('typed publication preserves arbitrary tool input bytes and identifies malformed input by step', () => {
  const raw = outline(null, {});
  const exact = { body: 'First line.\nSecond line stays here.', literalEscape: 'Keep \\n literally.', content: 'Complete reviewed content.\n'.repeat(3_500) };
  const { executionDraft, ...publicOutline } = raw;
  publicOutline.steps = raw.steps.map(({ staticArguments: _args, ...step }: any) => ({ ...step, staticArgumentsJson: JSON.stringify(exact) }));
  const parsed = publisher.PlanPublicationOutlineSchema.parse(publicOutline);
  const decoded = publisher.decodePublishedPlanOutline(parsed, executionDraft) as any;
  assert.deepEqual(decoded.steps[0].staticArguments, exact);
  assert.equal(decoded.steps[0].staticArgumentsJson, undefined);
  for (const invalid of ['{', 'null', '[]', '"plain text"']) {
    const changed = structuredClone(parsed); changed.steps[0]!.staticArgumentsJson = invalid;
    assert.throws(() => publisher.decodePublishedPlanOutline(changed, executionDraft), /Step create_workflow: staticArgumentsJson/);
  }
});

test('actual SDK publication errors expose repair paths without echoing invocation data or context', async () => {
  const f = await fixture();
  const raw = outline(null, {});
  const { executionDraft, ...publicOutline } = raw;
  publicOutline.steps = raw.steps.map(({ staticArguments: _args, ...step }: any) => ({ ...step, staticArgumentsJson: '{}' }));
  // The outer request is valid JSON but omits a required nested field, which
  // the SDK used to flatten into the unhelpful "Invalid JSON input for tool".
  delete publicOutline.steps[0].verification;
  const context = new RunContext({ privateRunMarker: 'DO-NOT-ECHO-CONTEXT' });
  const tool = publisher.buildPublishPlanTool();
  const result = await tool.invoke(context, JSON.stringify({ execution_draft: executionDraft,
    full_text: 'DO-NOT-ECHO-PLAN-BODY', structured_plan: publicOutline, readiness: 'needs_input',
    missing_prerequisites: [], base_ref_json: null }));
  const parsed = JSON.parse(String(result));
  assert.equal(parsed.ok, false); assert.equal(parsed.published, false);
  assert.equal(parsed.error, 'invalid_plan_input');
  assert.ok(parsed.issues.some((issue: any) => issue.path === '/structured_plan/steps/0/verification' && issue.code === 'invalid_type'), String(result));
  assert.doesNotMatch(String(result), /DO-NOT-ECHO|Invalid JSON input for tool/);
  const malformed = await tool.invoke(context, '{"private":"DO-NOT-ECHO-MALFORMED"');
  assert.equal(JSON.parse(String(malformed)).error, 'invalid_plan_input');
  assert.doesNotMatch(String(malformed), /DO-NOT-ECHO/);
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0);
});
