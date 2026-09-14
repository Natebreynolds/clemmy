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
  assert.match((prepared.preparedBindings as any[])[0].description, /Missing parent directories are created automatically/);
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

test('an unresolved question publishes without inventing an executable outline and cannot be executed', async () => {
  const f = await fixture();
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const input = { full_text: 'I can outline the briefing once its audience is known. Which team is this for?',
    readiness: 'needs_input', missing_prerequisites: ['Team selection'] };
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  const published = await invoke(input);
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.match(published.message, /answer continues planning/);
  log.closeEventLog();
  const artifact = plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId });
  assert.equal(artifact?.fullText, input.full_text);
  assert.deepEqual(artifact?.structuredPlan?.steps, []);
  assert.deepEqual(artifact?.structuredPlan?.preparedBindings, []);
  const executeSource = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Execute it.', taskMode: { version: 1, kind: 'execute', executeRef: published.planArtifactRef } } });
  assert.throws(() => plans.claimPlanExecution({ sessionId: f.sessionId, sourceUserSeq: executeSource.seq,
    principalId: f.sessionId, executeRef: published.planArtifactRef }),
    (error: any) => error.code === 'not_ready', 'a partial question cannot confer execution authority');
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0);
  const recovered = await invoke({ ...input, readiness: 'ready' });
  assert.equal(recovered.status, 'already_published');
  assert.equal(recovered.readiness, 'needs_input', 'recovery cannot upgrade the saved question');
  assert.deepEqual(recovered.planArtifactRef, published.planArtifactRef);
});
test('wrong native arguments and mismatched effects/dependencies cannot be called ready', async () => {
  const f = await fixture();
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: outline(f.capabilityRef, { name: 'Missing graph' }), ready: true }), /static arguments/);
  const wrongEffect = outline(f.capabilityRef, {}); wrongEffect.steps[0]!.effect = 'external_write';
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: wrongEffect, ready: true }), /disagrees/);
  wrongEffect.executionDraft.topology.operations[0].effect = 'external_write';
  wrongEffect.steps[0].staticArguments = { name: 'Derived effect', description: 'Compute a fixture result.', steps: [{ id: 'compute', prompt: 'Return complete.', sideEffect: 'read' }] };
  const corrected = await publisher.preparePlanOutline({ ...f, raw: wrongEffect, ready: true }) as any;
  assert.equal(corrected.steps[0].effect, 'local_write');
  assert.equal(corrected.executionDraft.topology.operations[0].effect, 'local_write');
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


test('the host compiles one reviewed outline and reports independent argument problems together', async () => {
  const f = await fixture();
  const raw = outline(f.capabilityRef, { name: 'One Outline', description: 'A prepared fixture.', steps: [{ id: 'compute', prompt: 'Return complete.', sideEffect: 'read' }] });
  raw.executionDraft = null;
  const prepared = await publisher.preparePlanOutline({ ...f, raw, ready: true }) as any;
  assert.equal(prepared.executionDraft.topology.operations.length, 1);
  assert.equal(prepared.executionDraft.bindings[0].capabilityRef, f.capabilityRef);
  assert.deepEqual(prepared.executionDraft.criteria, raw.successCriteria);
  assert.deepEqual(prepared.executionDraft.evidenceRequirements, ['local_commit_receipt']);
  assert.deepEqual(prepared.steps[0].staticArguments, raw.steps[0].staticArguments);
  const invalid = { ...raw, steps: [
    { ...raw.steps[0], id: 'missing_name', staticArguments: { steps: raw.steps[0].staticArguments.steps } },
    { ...raw.steps[0], id: 'missing_graph', staticArguments: { name: 'Missing graph' } },
  ] };
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw: invalid, ready: true }), error => {
    assert.match(String(error), /missing_name/); assert.match(String(error), /missing_graph/); return true;
  });
});

test('data bindings supply dependency edges; invalid producers and cycles still fail', async () => {
  const f = await fixture('write_file');
  const raw = outline(f.capabilityRef, { path: path.join(home, 'consumer.md') });
  raw.executionDraft = null;
  raw.steps[0].dynamicBindings = [{ producerStepId: 'producer', outputPath: '/content', targetPath: '/content', expectedType: 'string' }];
  raw.steps.unshift({ ...raw.steps[0], id: 'producer', dynamicBindings: [],
    staticArguments: { path: path.join(home, 'producer.md'), content: 'Exact source' } });
  const prepared = await publisher.preparePlanOutline({ ...f, raw, ready: true }) as any;
  assert.deepEqual(prepared.steps[1].dependsOn, ['producer']);
  assert.deepEqual(prepared.executionDraft.topology.operations[1].dependsOn, ['producer']);
  assert.deepEqual(prepared.executionDraft.topology.operations[1].dataFrom, ['producer']);
  raw.steps[0].dependsOn = ['create_workflow'];
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw, ready: true }), /cycle/);
  raw.steps.shift();
  await assert.rejects(publisher.preparePlanOutline({ ...f, raw, ready: true }), /does not exist/);
});


test('the model sees one outline, without the duplicate action grammar', () => {
  const parameters = publisher.buildPublishPlanTool().parameters as any;
  assert.equal(parameters.properties.execution_draft.type, 'null');
  assert.doesNotMatch(JSON.stringify(parameters), /workspace_social_posts_v1|evidenceRequirements|memberIdPointer/);
});

test('failed preparation retains the full outline across reopen and exhaustion publishes an unexecutable draft without another model call', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const drafts = await import('../runtime/harness/plan-preparation-draft.js');
  const { modelCheckInForExhaustedTurn } = await import('../runtime/harness/loop.js');
  const raw = outline(f.capabilityRef, { path: path.join(home, 'unprepared.md') });
  raw.executionDraft = null;
  const { executionDraft, ...publicOutline } = raw;
  publicOutline.steps = raw.steps.map(({ staticArguments, ...step }: any) => ({ ...step, staticArgumentsJson: JSON.stringify(staticArguments) }));
  const fullText = 'The investigated plan, preserved in full.\n'.repeat(2_000) + 'END-OF-REVIEWED-PLAN';
  const invoke = () => withHarnessRunContext(f, () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify({
    execution_draft: executionDraft, structured_plan: publicOutline, full_text: fullText,
    readiness: 'ready', missing_prerequisites: [], base_ref_json: null,
  })));
  const rejected = JSON.parse(String(await invoke()));
  assert.equal(rejected.code, 'plan_preparation_failed');
  assert.match(rejected.message ?? rejected.detail ?? JSON.stringify(rejected), /content/);
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId }), null);
  log.closeEventLog();
  const stop = { status: 'blocked', blockedReason: 'control_no_progress_exhausted', finalOutput: 'Old engine stop.', turn: 1 } as any;
  const outcome = await modelCheckInForExhaustedTurn(stop, { ...f, run: async () => { throw new Error('No additional model request is needed.'); } });
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.blockedReason, 'plan_preparation_incomplete');
  assert.ok(outcome.finalOutput?.startsWith(fullText));
  const artifact = plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId });
  assert.equal(artifact?.readiness, 'needs_input');
  assert.match(artifact!.missingPrerequisites.join('\n'), /content/);
  assert.equal(drafts.publishRetainedPlanDraft(f), null, 'fallback publication is idempotent');
  const executeRef = { planId: artifact!.planId, revision: artifact!.revision, digest: artifact!.digest };
  const execute = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute.', taskMode: { version: 1, kind: 'execute', executeRef } } });
  assert.throws(() => plans.claimPlanExecution({ sessionId: f.sessionId, sourceUserSeq: execute.seq, principalId: f.sessionId, executeRef }), /not ready|needs input|prerequisites/i, 'an unresolved outline must not execute');
  assert.equal(drafts.publishRetainedPlanDraft({ ...f, sourceUserSeq: execute.seq }), null, 'Act cannot publish a Plan fallback');
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0, 'retaining and publishing never executes a tool');
});

test('a minimal object-based plan repairs one retained step after SQLite reopen without repeating its text', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const tool = publisher.buildPublishPlanTool(f.planning);
  assert.equal(tool.strict, false);
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f, () => tool.invoke(new RunContext(), JSON.stringify(args)))));
  const fullText = 'Investigated plan with complete source notes.\n'.repeat(1500);
  const unchanged = { path: path.join(home, 'second.md'), content: 'Literal \\n and real\nnewline.' };
  const first = await invoke({ full_text: fullText, structured_plan: { successCriteria: ['Both exact files saved'], steps: [
    { id: 'first', action: 'Save first file', verification: 'Exact contents', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'first.md') } },
    { id: 'second', action: 'Save second file', verification: 'Exact contents', capabilityRef: f.capabilityRef, staticArguments: unchanged },
  ] } });
  assert.equal(first.published, false, JSON.stringify(first)); assert.match(first.draft_digest, /^[a-f0-9]{64}$/);
  assert.match(first.message, /content/); assert.doesNotMatch(first.message, /tool_slug/);
  const unknownStep = await invoke({ draft_digest: first.draft_digest, step_patches: [{ step_id: 'new_step', changes: { action: 'Add a new step' } }] });
  assert.match(unknownStep.message, /Unknown step_id.*new_step/);
  assert.match(unknownStep.message, /structured_plan/);
  assert.match(unknownStep.message, /without draft_digest and step_patches/);
  const duplicatePatch = await invoke({ draft_digest: first.draft_digest, step_patches: [
    { step_id: 'first', changes: { verification: 'one change' } },
    { step_id: 'first', changes: { action: 'another change' } },
  ] });
  assert.match(duplicatePatch.message, /Duplicate patch.*first/);
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId }), null);
  log.closeEventLog();
  const second = await invoke({ draft_digest: first.draft_digest, step_patches: [{ step_id: 'first', changes: { staticArguments: { path: path.join(home, 'first.md'), content: 7 } } }] });
  assert.equal(second.published, false, JSON.stringify(second)); assert.notEqual(second.draft_digest, first.draft_digest);
  const stale = await invoke({ draft_digest: first.draft_digest, step_patches: [{ step_id: 'first', changes: { verification: 'stale repair' } }] });
  assert.match(stale.message, /stale/);
  const done = await invoke({ draft_digest: second.draft_digest, step_patches: [{ step_id: 'first', changes: { staticArguments: { path: path.join(home, 'first.md'), content: 'Correct content' } } }] });
  assert.equal(done.ok, true, JSON.stringify(done));
  const artifact = plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId })!;
  assert.equal(artifact.fullText, fullText);
  const outline = artifact.structuredPlan as any;
  assert.deepEqual(outline.steps[1].staticArguments, unchanged);
  assert.equal(outline.steps[0].effect, 'local_write');
  assert.deepEqual(outline.steps[0].dependsOn, []);
  assert.equal(outline.executionDraft.topology.operations[0].effect, 'local_write');
  assert.equal(log.listEvents(f.sessionId, { types: ['plan_revision_published'] }).length, 1);
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0);
});

test('more than 32 distinct prepared steps do not require splitting the owner task', async () => {
  const f = await fixture('write_file');
  const steps = Array.from({ length: 40 }, (_, i) => ({ id: `file_${i}`, action: `Save file ${i}`, verification: 'Exact file contents',
    capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, `file-${i}.md`), content: `Content ${i}` } }));
  const plan = await publisher.preparePlanOutline({ ...f, ready: true, raw: { steps, successCriteria: ['All 40 files retained'] } }) as any;
  assert.equal(plan.steps.length, 40); assert.equal(plan.executionDraft.topology.operations.length, 40);
});

test('one reviewed operation compiles 50 members to the existing per-member ledger', async () => {
  const f = await fixture('write_file');
  const items = Array.from({ length: 50 }, (_, i) => ({ path: path.join(home, `member-${i}.md`), content: `Member ${i}\n` }));
  const plan = await publisher.preparePlanOutline({ ...f, ready: true, raw: { steps: [{
    id: 'save', action: 'Save one file per member', verification: 'Each exact file saved', capabilityRef: f.capabilityRef,
    forEach: { items, memberIdPath: '/path', bindings: [{ itemPath: '/path', targetPath: '/path' }, { itemPath: '/content', targetPath: '/content' }] },
  }], successCriteria: ['All 50 files saved exactly once'] } }) as any;
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.executionDraft.topology.operations[0].cardinality, { kind: 'each', universeId: 'members:save' });
  assert.equal(plan.executionDraft.topology.universes[0].members.length, 50);
  assert.deepEqual(plan.steps[0].forEach.items, items);
  const duplicate = structuredClone(plan.steps[0]); duplicate.forEach.items.push(items[0]);
  await assert.rejects(publisher.preparePlanOutline({ ...f, ready: true, raw: { steps: [duplicate], successCriteria: ['No duplicates'] } }), /unique/);
});


test('publication reviews the current candidate and retains a rejected draft for repair', async () => {
  const f = await fixture();
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const review = await import('../runtime/harness/plan-publication-review.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const seen: string[] = [];
  const invoke = async (full_text: string, verdict: 'continue' | 'done') => JSON.parse(String(await withHarnessRunContext(f,
    () => review.withPlanCompletionReview(async candidate => { seen.push(candidate.fullText); return verdict; },
      () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify({ full_text,
        readiness: 'needs_input', missing_prerequisites: ['Audience selection'] }))))));
  const rejected = await invoke('Which audience should I write for?', 'continue');
  assert.equal(rejected.status, 'review_feedback');
  assert.ok(rejected.draft_digest);
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId }), null);
  const repaired = await invoke('I have the comparison method ready. Which team will read the briefing?', 'done');
  assert.equal(repaired.ok, true);
  assert.ok(repaired.planArtifactRef);
  assert.deepEqual(seen, ['Which audience should I write for?', 'I have the comparison method ready. Which team will read the briefing?']);
});

test('publication recovery returns the saved artifact without judging or replacing another draft', async () => {
  const f = await fixture();
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const review = await import('../runtime/harness/plan-publication-review.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  let reviews = 0;
  const invoke = (full_text: string) => withHarnessRunContext(f,
    () => review.withPlanCompletionReview(async () => { reviews++; return 'done'; },
      () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify({
        full_text, readiness: 'needs_input', missing_prerequisites: ['Audience'] }))));
  const first = JSON.parse(String(await invoke('Which audience should this research cover?')));
  log.closeEventLog();
  const recovered = JSON.parse(String(await invoke('Different retry text that was never published.')));
  assert.equal(recovered.status, 'already_published');
  assert.deepEqual(recovered.planArtifactRef, first.planArtifactRef);
  assert.equal(reviews, 1);
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId })?.fullText, 'Which audience should this research cover?');
  assert.equal(log.listEvents(f.sessionId, { types: ['plan_revision_published'] }).length, 1);
});

test('a cancelled publication cannot save a late positive review', async () => {
  const f = await fixture();
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
  const review = await import('../runtime/harness/plan-publication-review.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const verdict = new Promise<void>(resolve => { release = resolve; });
  const pending = withHarnessRunContext(f, () => runWithToolAbortSignal(controller.signal,
    () => review.withPlanCompletionReview(async () => { entered(); await verdict; return 'done'; },
      () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify({
        full_text: 'Which audience should this research cover?', readiness: 'needs_input', missing_prerequisites: ['Audience'] })))));
  await started;
  controller.abort(new Error('Owner stopped this turn.'));
  release();
  const result = JSON.parse(String(await pending));
  assert.equal(result.ok, false);
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId }), null);
  assert.equal(log.listEvents(f.sessionId, { types: ['plan_revision_published'] }).length, 0);
});

test('an early graph error retains the full draft and accepts a targeted repair after reopen', async () => {
  const f = await fixture();
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  const fullText = 'Complete research method.\n'.repeat(500) + 'Decisive final verification.';
  const first = await invoke({ full_text: fullText, structured_plan: { steps: [
    { id: 'rubric', action: 'Build the evidence rubric.', effect: 'compute', dependsOn: ['rubric'], verification: 'Every source question represented.' },
  ], successCriteria: ['A complete source-backed research method.'] } });
  assert.equal(first.ok, false);
  assert.match(first.message, /cycle/);
  assert.equal(typeof first.draft_digest, 'string');
  log.closeEventLog();
  const fixed = await invoke({ draft_digest: first.draft_digest, step_patches: [{ step_id: 'rubric', changes: { dependsOn: [] } }] });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  const plans = await import('../runtime/harness/plan-artifacts.js');
  assert.equal(plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId })?.fullText, fullText);
});

test('an interpreted collection can be repaired to a single bound input without resending the plan', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  const fullText = 'Interpret the evidence, then save the complete briefing.';
  const first = await invoke({ full_text: fullText, structured_plan: { steps: [
    { id: 'synthesize', action: 'Produce the complete briefing.', effect: 'compute', verification: 'All source questions answered.' },
    { id: 'save', action: 'Save the briefing.', capabilityRef: f.capabilityRef,
      staticArguments: { path: path.join(home, 'brief.md') },
      forEach: { producerStepId: 'synthesize', memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] },
      verification: 'Read the saved briefing.' },
  ], successCriteria: ['Complete briefing saved.'] } });
  assert.equal(first.ok, false);
  assert.match(first.message, /collection producer must be a tool step/);
  assert.equal(typeof first.draft_digest, 'string');
  log.closeEventLog();
  const fixed = await invoke({ draft_digest: first.draft_digest, step_patches: [{ step_id: 'save', changes: {
    forEach: null, dynamicBindings: [{ producerStepId: 'synthesize', outputPath: '', targetPath: '/content' }],
  } }] });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const saved = plans.getPlanRevisionForSource({ ...f, principalId: f.sessionId })!;
  assert.equal(saved.fullText, fullText);
  assert.equal((saved.structuredPlan!.steps as any[])[1].forEach, undefined);
});


for (const ownerRefuses of [false, true]) test(`Execute scope reads durable owner text rather than expanded plan prose (ownerRefuses=${ownerRefuses})`, async () => {
  const f = await fixture('write_file');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const execution = await import('../runtime/harness/accepted-plan-execution.js');
  const scope = await import('../runtime/mcp-tool-scope.js');
  const raw = { steps: [{ id: 'save', action: 'Save the briefing.', capabilityRef: f.capabilityRef,
    staticArguments: { path: path.join(home, 'brief.md'), content: 'Reviewed brief.' }, verification: 'Local receipt.' }], successCriteria: ['Briefing saved.'] };
  const structuredPlan = await publisher.preparePlanOutline({ ...f, raw, ready: true });
  const artifact = plans.publishPlanRevision({ ...f, principalId: f.sessionId, readiness: 'ready', structuredPlan,
    fullText: 'As part of this step’s own read-only investigation (not a separate mandatory graph dependency): (i) call research-lab__api_request against /v3/visibility/live.' });
  const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const literal = ownerRefuses ? 'Execute this approved revision. Do not use research-lab.' : 'Execute this approved revision and save the completed briefing.';
  const source = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: literal, taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
  plans.claimPlanExecution({ sessionId: f.sessionId, sourceUserSeq: source.seq, principalId: f.sessionId, executeRef: ref });
  log.closeEventLog();
  const expanded = execution.acceptedPlanExecutionText(f.sessionId, source.seq)!;
  const ownerText = execution.acceptedPlanOwnerScopeInput(f.sessionId, source.seq, expanded);
  assert.equal(ownerText, literal);
  const selected = scope.resolveMcpToolScope({ userInput: ownerText, configuredServerNames: ['research-lab'] });
  assert.equal(selected.deniedServerSlugs?.includes('research_lab') ?? false, ownerRefuses, JSON.stringify(selected));
  if (!ownerRefuses) {
    const old = scope.resolveMcpToolScope({ userInput: expanded, configuredServerNames: ['research-lab'] });
    assert.ok(old.deniedServerSlugs?.includes('research_lab'), 'the retained clause must reproduce the original false exclusion');
  }
});
