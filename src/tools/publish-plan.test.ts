import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  // A stale executionDraft on the outline is never a gate: the host derives
  // the only draft from the reviewed steps, and a wrong step effect is
  // corrected from the selected capability rather than refused.
  const wrongEffect = outline(f.capabilityRef, {}); wrongEffect.steps[0]!.effect = 'external_write';
  wrongEffect.executionDraft.topology.operations[0].effect = 'external_write';
  wrongEffect.executionDraft.criteria = ['Stale submitted criterion.'];
  wrongEffect.steps[0].staticArguments = { name: 'Derived effect', description: 'Compute a fixture result.', steps: [{ id: 'compute', prompt: 'Return complete.', sideEffect: 'read' }] };
  const corrected = await publisher.preparePlanOutline({ ...f, raw: wrongEffect, ready: true }) as any;
  assert.equal(corrected.steps[0].effect, 'local_write');
  assert.equal(corrected.executionDraft.topology.operations[0].effect, 'local_write', 'the draft is host-derived, not the stale submission');
  assert.deepEqual(corrected.executionDraft.criteria, wrongEffect.successCriteria, 'the stale submitted draft is ignored');
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
  // The outline is published: the stop says so, never "stopped before publishing".
  assert.match(String(outcome.error ?? ''), /I published the outline as far as it goes/);
  assert.doesNotMatch(String(outcome.error ?? ''), /stopped before publishing/);
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
  assert.match(first.message, /cannot supply a reviewed member set/);
  assert.match(first.message, /items: \[one object per member/, 'the repair names the inline-member shape');
  assert.match(first.message, /tool step in this plan the producerStepId/, 'and the tool-producer shape');
  assert.match(first.message, /never left to be written at execute time/, 'a reviewed write carries its exact arguments');
  assert.match(first.message, /unroll into one single-call step per member/, 'the unrolled shape is named');
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

test('a reviewed-CLI step publishes the sealed catalog digest, revalidates against it, and refuses a mutated schema as a provider change', async () => {
  const { createHash } = await import('node:crypto');
  const schemas = await import('./composio-schema-cache.js');
  const identity = await import('../runtime/harness/reviewed-provider-identity.js');
  const reviewed = await import('../runtime/harness/reviewed-plan-runtime.js');
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
  const plans = await import('../runtime/harness/plan-artifacts.js');
  const operationId = 'reviewed_cli_publish_fixture';
  // Reviewed CLI: providerKind reviewed_cli, NO externalDefinition on the
  // manifest, the exact schema deposited in the contract cache, digest sealed
  // at registration by the producer.
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1, manifestId: `cap:resolved:${operationId}`, providerKind: 'reviewed_cli', operationId,
    providerIdentity: '/usr/bin/fixture-cli', providerVersion: 'fixture-v1', operationVersion: '1',
    definitionFingerprint: sha256(`definition:${operationId}`), effect: 'read', accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' }, reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' }, evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-09-01T00:00:00.000Z', trusted: true }, lifecycle: { state: 'current' },
    advisoryRoles: ['collection'],
  });
  assert.equal(manifest.externalDefinition, undefined);
  const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  schemas.rememberToolSchema(operationId, schema, Date.now());
  const cached = schemas.getCachedToolSchema(operationId)!;
  const entry = {
    capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint, effect: manifest.effect, account: manifest.accountId, advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint, providerInputSchemaDigest: identity.providerInputSchemaDigestOf(cached),
    manifest, invoke: async () => ({ records: [], has_more: false }),
  };
  log.resetEventLog();
  const factory = catalog.createHostCapabilityCatalogFactory();
  factory.register(entry);
  catalog.installHostCapabilityCatalogFactory(factory);
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const session = log.createSession({ id: 'reviewed-cli-publication', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Plan the reviewed CLI query.', taskMode: { version: 1, kind: 'plan' } } });
  const f = { sessionId: session.id, sourceUserSeq: source.seq };
  const resolution = await import('../runtime/harness/capability-resolution.js');
  resolution.recordAdmissionCapabilityResolution({ ...f, acceptedInput: 'Plan the reviewed CLI query.', entries: [{
    kind: 'cli', identifier: operationId, intent: 'the current source selected this reviewed CLI query',
    status: 'proven', connection: 'active', accountIdentity: manifest.accountId, effectClass: 'read',
  }] });
  const primed = await semantic.primePrimaryModelPlanningCatalog(f);
  assert.ok(primed.ok, JSON.stringify(primed)); if (!primed.ok) return;
  const raw = () => ({ steps: [{ id: 'query', action: 'Run the reviewed query.', effect: 'read', capabilityRef: manifest.manifestId, staticArguments: { query: 'SELECT Id FROM Account' },
    dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Rows returned.' }], successCriteria: ['Rows returned.'], subagents: [] });
  const prepared = await publisher.preparePlanOutline({ ...f, planning: primed.planning, raw: raw(), ready: true });
  const binding = (prepared.preparedBindings as any[])[0];
  assert.ok(binding, JSON.stringify(prepared));
  const canonical = catalog.canonicalCatalogIdentityOf(entry)!;
  assert.equal(binding.identity.providerInputSchemaDigest, identity.providerInputSchemaDigestOf(cached));
  assert.equal(binding.identity.providerInputSchemaDigest, canonical.providerInputSchemaDigest, 'publish binding digest === producer digest === canonical digest');
  assert.deepEqual(binding.identity, JSON.parse(JSON.stringify(canonical)), 'the recorded identity is the canonical identity, never a filled copy');
  // Revalidation and admission compare the same identity strictly.
  const artifact = plans.publishPlanRevision({ ...f, principalId: session.id, fullText: 'Run the reviewed query.', structuredPlan: prepared, readiness: 'ready' });
  const checked = await reviewed.checkReviewedPlanPreparation(artifact);
  assert.deepEqual(checked.map(row => row.kind), ['provider']);
  const attestation = { capabilityId: canonical.capabilityId, manifestDigest: canonical.manifestDigest, accountId: canonical.account,
    providerInputSchemaDigest: canonical.providerInputSchemaDigest, operationId: canonical.operationId } as never;
  assert.equal(identity.attestationMatchesReviewedIdentity(attestation, binding.identity), true);
  // A mutated cached schema is a provider change at publish and at revalidation.
  schemas.rememberToolSchema(operationId, { ...schema, properties: { query: { type: 'string' }, limit: { type: 'number' } } }, Date.now());
  await assert.rejects(publisher.preparePlanOutline({ ...f, planning: primed.planning, raw: raw(), ready: true }), /provider schema changed after discovery/);
  await assert.rejects(reviewed.checkReviewedPlanPreparation(artifact), /changed or is unavailable/);
  assert.equal(log.listEvents(session.id, { types: ['guardrail_tripped'] }).find(event => event.data.kind === 'plan_execution_revalidation_refused')?.data.reason, 'schema_digest_mismatch');
  // A callable row with no sealed digest cannot anchor a reviewed plan; nothing fills it from the cache.
  schemas.rememberToolSchema(operationId, schema, Date.now());
  factory.forget(entry.capabilityId);
  factory.register({ ...entry, providerInputSchemaDigest: undefined });
  await assert.rejects(publisher.preparePlanOutline({ ...f, planning: primed.planning, raw: raw(), ready: true }), /catalog entry has no current callable attestation/);
  assert.equal(log.listEvents(session.id, { types: ['tool_called'] }).length, 0);
});

test('every structural problem in a plan is reported in one response', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  const first = await invoke({ full_text: 'Two repeated steps over interpreted sets.', structured_plan: { steps: [
    { id: 'synthesize', action: 'Produce the members.', effect: 'compute', verification: 'Members listed.' },
    { id: 'save_a', action: 'Save each.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'a.md') },
      forEach: { producerStepId: 'synthesize', memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] },
      verification: 'Read a.' },
    { id: 'save_b', action: 'Save each again.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'b.md') },
      forEach: { producerStepId: 'synthesize', memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] },
      verification: 'Read b.' },
  ], successCriteria: ['Both saved.'] } });
  assert.equal(first.ok, false);
  assert.match(first.message, /Step save_a: synthesize records an output/);
  assert.match(first.message, /Step save_b: synthesize records an output/, 'the second problem is reported in the same response');
  // Structural: a duplicate step ID and an undefined subagent assignment are
  // batched into the same single refusal instead of one throw per round.
  const structural = await invoke({ full_text: 'Two structural problems.', structured_plan: { steps: [
    { id: 'save', action: 'Save.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 's.md'), content: 'x' }, subagentRole: 'ghost', verification: 'Read s.' },
    { id: 'save', action: 'Save again.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 't.md'), content: 'y' }, verification: 'Read t.' },
  ], successCriteria: ['Saved.'] } });
  assert.equal(structural.ok, false);
  assert.match(structural.message, /Plan step IDs must be unique/);
  assert.match(structural.message, /undefined subagent assignment/, 'the subagent problem rides the same response as the duplicate ID');
  // Preparation: a collection over a non-read producer and an unresolvable
  // step are reported together; on the live path (ready:false) the collection
  // line is a returned preparation issue, not a lone throw.
  const preparation = await invoke({ full_text: 'Collection over a write.', structured_plan: { steps: [
    { id: 'seed', action: 'Write the seed.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'seed.md'), content: 'seed' }, verification: 'Read seed.' },
    { id: 'fan_out', action: 'Save each.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'fan.md') },
      forEach: { producerStepId: 'seed', memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] }, verification: 'Read fan.' },
    { id: 'orphan', action: 'Use an unknown tool.', capabilityRef: 'cap:local:invented', staticArguments: {}, verification: 'Never.' },
  ], successCriteria: ['Saved.'] } });
  assert.equal(preparation.ok, false);
  assert.match(preparation.message, /a new collection requires a complete read/);
  assert.match(preparation.message, /Step orphan: discover and cite/, 'the collection requirement joins the other preparation issues in ONE response');
  const draft = await publisher.preparePlanOutline({ ...f, ready: false, raw: {
    steps: [
      { id: 'seed', action: 'Write the seed.', effect: 'local_write', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'seed.md'), content: 'seed' }, dynamicBindings: [], dependsOn: [], subagentRole: null, verification: 'Read seed.' },
      { id: 'fan_out', action: 'Save each.', effect: 'local_write', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'fan.md') }, dynamicBindings: [], dependsOn: [], subagentRole: null,
        forEach: { producerStepId: 'seed', memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] }, verification: 'Read fan.' },
    ], successCriteria: ['Saved.'], subagents: [] } });
  assert.ok((draft.preparationIssues as string[]).some(line => /Step fan_out: a new collection requires a complete read/.test(line)), JSON.stringify(draft.preparationIssues));
});

test('a scalar bound where the schema wants a list of that scalar is completed by the host, not refused', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  // write_file's `content` is a string; bind a list where a string is wanted
  // to prove the completion is one-directional (scalar → list only).
  const refused = await invoke({ full_text: 'Save each member.', structured_plan: { steps: [
    { id: 'save', action: 'Save each.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'm.md') },
      forEach: { items: [{ id: 'a', content: ['not a string'] }], memberIdPath: '/id', bindings: [{ itemPath: '/content', targetPath: '/content' }] },
      verification: 'Read it.' },
  ], successCriteria: ['Saved.'] } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /collection member arguments fail/);
});

test('two reviewer send-backs are the budget: the third sound candidate publishes with the reviewer note advisory', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const { withPlanCompletionReview } = await import('../runtime/harness/plan-publication-review.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => withPlanCompletionReview(async () => 'continue', () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args))))));
  const plan = { full_text: 'Save the briefing.', structured_plan: { steps: [
    { id: 'save', action: 'Save the briefing.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'b.md'), content: 'hello' }, verification: 'Read it.' },
  ], successCriteria: ['Saved.'] } };
  const first = await invoke(plan);
  assert.equal(first.published, false);
  assert.equal(first.status, 'review_feedback', 'a reviewer send-back with no spent budget still holds');
  for (let round = 0; round < 2; round += 1) {
    log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'system', type: 'goal_alignment_judged',
      data: { kind: 'completion', fulfills: false, sourceUserSeq: f.sourceUserSeq, reason: `send-back ${round + 1}` } });
  }
  log.closeEventLog();
  const third = await invoke(plan);
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(third.readiness, 'ready');
  assert.ok(third.planArtifactRef, 'the sound plan published despite a would-be third send-back');
  const spent = log.listEvents(f.sessionId, { types: ['guardrail_tripped'] }).find(event => event.data.kind === 'plan_review_budget_spent');
  assert.ok(spent, 'the spent budget is journaled');
});

test('a complete outline paired with a retained digest publishes as a full submission, not a malformed repair', async () => {
  const f = await fixture('write_file');
  const { withHarnessRunContext } = await import('../runtime/harness/brackets.js');
  const invoke = async (args: unknown) => JSON.parse(String(await withHarnessRunContext(f,
    () => publisher.buildPublishPlanTool(f.planning).invoke(new RunContext(), JSON.stringify(args)))));
  const broken = await invoke({ full_text: 'Save it.', structured_plan: { steps: [
    { id: 'save', action: 'Save.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'x.md') }, verification: 'Read it.' },
  ], successCriteria: ['Saved.'] } });
  assert.equal(broken.ok, false);
  assert.equal(typeof broken.draft_digest, 'string');
  log.closeEventLog();
  const full = await invoke({ draft_digest: broken.draft_digest, full_text: 'Save it, complete.', structured_plan: { steps: [
    { id: 'save', action: 'Save.', capabilityRef: f.capabilityRef, staticArguments: { path: path.join(home, 'x.md'), content: 'complete' }, verification: 'Read it.' },
  ], successCriteria: ['Saved.'] } });
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.ok(full.planArtifactRef);
});

test('an affirmed continuation answer publishes a ready plan citing the parent source\'s disclosed ref without rediscovery', async () => {
  // Answering a Plan question is a new accepted source. The ref its parent
  // already disclosed must be citable from the answering card, or every answer
  // pays tool_search plus "discover and cite" from zero.
  const f = await fixture();
  const continuityStore = await import('../memory/task-continuity.js');
  const continuityRuntime = await import('../runtime/harness/task-continuity-runtime.js');
  continuityStore.createTaskContinuityPacket({
    sessionId: f.sessionId, originatingSourceUserSeq: f.sourceUserSeq,
    pause: { kind: 'clarification', question: 'Should the compute step return the literal complete?', options: [] }, capabilities: [],
  });
  const answer = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Yes', displayText: 'Yes', taskMode: { version: 1, kind: 'plan' } } });
  const enriched = await continuityRuntime.enrichAcceptedRequestWithTaskContinuity(
    { sessionId: f.sessionId, sourceUserSeq: answer.seq, message: 'Yes' }, answer.seq, { typedClassification: { disposition: 'affirmed' } });
  assert.equal(enriched.taskContinuation?.disposition, 'affirmed');
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: f.sessionId, sourceUserSeq: answer.seq });
  assert.ok(primed.ok, JSON.stringify(primed)); if (!primed.ok) return;
  assert.deepEqual([...(primed.planning.inheritedSourceUserSeqs ?? [])], [f.sourceUserSeq]);
  assert.ok(primed.planning.capabilities.some(entry => entry.id === f.capabilityRef), 'the parent disclosure is on the answering card');
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_returned'] }).filter(event => event.data.sourceUserSeq === answer.seq).length, 0,
    'the answering source ran no tool_search');
  const args = { name: 'Reviewed Workflow', description: 'Compute a fixture result.', steps: [{ id: 'compute', prompt: 'Return the literal complete.', sideEffect: 'read' }] };
  const prepared = await publisher.preparePlanOutline({ sessionId: f.sessionId, sourceUserSeq: answer.seq, planning: primed.planning, raw: outline(f.capabilityRef, args), ready: true });
  const binding = (prepared.preparedBindings as any[])[0];
  assert.equal(binding.identity.kind, 'local_registry');
  assert.equal(binding.identity.definition.capabilityRef, f.capabilityRef);
  assert.deepEqual(prepared.preparedBindings.length, 1);
  assert.equal(log.listEvents(f.sessionId, { types: ['tool_called'] }).length, 0, 'preparation still invokes nothing');
});

test('a published step without an id is completed from its position, and referenced ids are never touched', async () => {
  const { completedPlanStepIds, decodePublishedPlanOutline, PlanPublicationOutlineSchema } = await import('./publish-plan.js');
  const outline = PlanPublicationOutlineSchema.parse({
    steps: [
      { id: 'read_accounts', action: 'Read the accounts', effect: 'read', capabilityRef: 'cap:x', verification: 'records returned' },
      { action: 'Draft one email per account', effect: 'compute', dependsOn: ['read_accounts'], verification: 'drafts recorded' },
      { id: 'step_2', action: 'Already named like the host would', effect: 'compute', verification: 'ok' },
    ],
    successCriteria: ['done'],
  });
  assert.deepEqual(completedPlanStepIds(outline), [{ index: 1, id: 'step_2_2' }], 'position-based, never colliding with an authored id');
  const decoded = decodePublishedPlanOutline(outline) as { steps: Array<{ id: string; dependsOn: string[] }> };
  assert.deepEqual(decoded.steps.map((step) => step.id), ['read_accounts', 'step_2_2', 'step_2']);
  assert.deepEqual(decoded.steps[1]!.dependsOn, ['read_accounts']);
  assert.deepEqual(completedPlanStepIds({ steps: [{ id: 'a' }, { id: 'b' }] }), []);
});
