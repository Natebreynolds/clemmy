/** Controlled authoring/rehearsal and shipped exact-read integration; no model or provider. */
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { z } from 'zod';
import type { WorkspaceSnapshotReadResult } from '../spaces/workspace-read-contract.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-workspace-snapshot-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async () => { providerCalls++; throw new Error('controlled fixture forbids provider requests'); };
const priorArtifactRoot = process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT;
const artifactRoot = path.join(TEST_HOME, 'implementation-artifacts');
process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT = artifactRoot;
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
shipped.emitShippedImplementationArtifacts(artifactRoot);
shipped.installImplementationArtifactRoot(artifactRoot);

const runner = await import('./workflow-runner.js');
const workflows = await import('../memory/workflow-store.js');
const { registerOrchestrationTools } = await import('../tools/orchestration-tools.js');
const { registerSpaceTools } = await import('../tools/space-tools.js');
const spaces = await import('../spaces/store.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const reviewed = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const manifestModule = await import('../runtime/harness/capability-manifest.js');
const manifestStore = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observation = await import('../runtime/harness/independent-capability-observation.js');
const seam = await import('../runtime/harness/implementation-artifacts/host-local-write-carrier.js');
const storage = await import('../runtime/harness/reviewed-local-storage-carrier.js');
const planning = await import('../runtime/harness/local-planning-capability.js');
const { executeWorkflowTransform } = await import('./workflow-transform.js');
const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { executeReviewedWorkspaceSetData } = await import('../spaces/workspace-set-data-carrier.js');
const { ensureReviewedLocalWorkflowCapability } = await import('../runtime/harness/reviewed-local-workflow-capability.js');
const { compileLiveCatalogWorkflowCallPlan } = await import('./workflow-live-call-compiler.js');
const { compileWorkflowNodeInvocationArguments } = await import('./workflow-node-invocation-admission.js');
const { parseWorkflowNodeInvocationPlan } = await import('../memory/workflow-node-invocation-plan.js');
const readKernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');

type Reply = { content: Array<{ text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<Reply>;
const tools = new Map<string, { schema: z.ZodObject<z.ZodRawShape>; handler: Handler; description: string }>();
const capture = { tool(name: string, description: string, shape: z.ZodRawShape, handler: Handler) {
  tools.set(name, { schema: z.object(shape), handler, description });
} };
registerOrchestrationTools(capture as never);
registerSpaceTools(capture as never);
function text(result: Reply): string { return result.content.map(item => item.text ?? '').join('\n'); }

test.after(() => {
  globalThis.fetch = originalFetch;
  seam.bindHostLocalWriteCarrier(storage.reviewedLocalStorageCarrier);
  workspaceDb.closeWorkspaceDb(); eventlog.closeEventLog();
  if (priorArtifactRoot === undefined) delete process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT;
  else process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT = priorArtifactRoot;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function save(slug: string, initialData: Record<string, unknown>) {
  spaces.spaceStore.save({ id: slug, title: 'Controlled saved Workspace', status: 'active',
    viewEntry: 'view/index.html', viewContent: '<!doctype html><title>Controlled saved Workspace</title>',
    dataSources: [], actions: [], initialData });
}
function surface() {
  const observed = reviewed.observeReviewedLocalTool('space_get'); assert.ok(observed);
  const manifest = reviewed.reviewedLocalCapabilityManifest(observed); assert.ok(manifest);
  return { observed, manifest };
}
async function invokeSnapshot(args: Record<string, unknown>): Promise<WorkspaceSnapshotReadResult> {
  const { manifest } = surface();
  const invoke = shipped.loadShippedImplementations().invokeForSealedManifest(manifest);
  assert.equal(shipped.isShippedInvoke(invoke), true);
  return await invoke({ nodeId: 'snapshot', role: 'source', payload: args,
    identity: { sessionId: 'controlled-snapshot-port', sourceUserSeq: 1, acceptedTaskId: 'controlled-snapshot-port' },
    binding: { capabilityId: manifest.manifestId, toolName: manifest.operationId, schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint, args, account: manifest.accountId, effect: manifest.effect,
      manifestDigest: manifestModule.capabilityManifestDigest(manifest), providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint, manifest },
  }) as WorkspaceSnapshotReadResult;
}

test('space_get exact schema matches discovery while legacy native text and optional metadata/paging behavior remain compatible', async () => {
  const { observed } = surface();
  const configured = await planning.observeCurrentLocalPlanningDefinition({ name: 'space_get', carrier: 'work_call' });
  assert.equal(configured.ok, true);
  if (!configured.ok) return;
  assert.deepEqual(observed.schema, configured.schema);
  assert.equal(observed.definition.envelopeFingerprint, configured.definition.envelopeFingerprint);
  const get = tools.get('space_get')!;
  assert.match(get.description, /workspace:\{id,title,status,version,revision,data_sha256\}/);
  assert.match(get.description, /jsonStringify/);
  const slug = 'controlled-native-read';
  save(slug, { selected: { records: [{ id: 'one', text: 'saved value' }] } });
  const legacy = text(await get.handler(get.schema.parse({ slug })));
  assert.match(legacy, /Controlled saved Workspace/);
  assert.match(legacy, /Snapshot revision: [a-f0-9]{64}/);
  assert.doesNotMatch(legacy, /<title>/);
  assert.match(text(await get.handler(get.schema.parse({ slug, metadata_only: true }))), /Dataset omitted \(metadata_only\)/);
  assert.match(text(await get.handler(get.schema.parse({ slug, source_id: 'selected', limit: 1, offset: 0 }))), /one/);
  assert.match(text(await get.handler(get.schema.parse({ slug, expected_revision: 'f'.repeat(64) }))), /changed since the expected revision/);
  const manifestFile = spaces.resolveInSpace(slug, 'space.json');
  const legacyManifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  delete legacyManifest.status;
  writeFileSync(manifestFile, JSON.stringify(legacyManifest));
  assert.equal((await invokeSnapshot({ slug })).workspace.status, 'active', 'a genuine legacy omitted status remains readable');
  unlinkSync(spaces.resolveInSpace(slug, 'data.json'));
  assert.match(text(await get.handler(get.schema.parse({ slug, metadata_only: true }))), /Dataset omitted \(metadata_only\)/,
    'legacy manifest-only metadata reads keep their existing compatibility');
  const actualReadFile = fs.readFileSync;
  const forbidden = [spaces.resolveInSpace(slug, 'data.json'), spaces.resolveInSpace(slug, 'view/index.html')];
  const reads: string[] = [];
  const readMock = mock.method(fs, 'readFileSync', ((file: unknown, ...args: unknown[]) => {
    if (typeof file === 'string' && forbidden.includes(file)) {
      reads.push(file); throw new Error('metadata must not read dataset or view bytes');
    }
    return Reflect.apply(actualReadFile, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  try {
    const metadata = await invokeSnapshot({ slug, metadata_only: true });
    assert.equal(metadata.scope, 'metadata');
    assert.equal(metadata.complete, true);
    assert.equal(metadata.data, null);
    assert.equal(metadata.workspace.revision, undefined);
    assert.equal(metadata.workspace.data_sha256, undefined);
    assert.match(metadata.workspace.metadata_revision!, /^workspace-metadata:v1:[a-f0-9]{64}$/);
    assert.deepEqual(reads, []);
  } finally { readMock.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(invokeSnapshot({ slug }), /manifest and dataset are unavailable/);
});

test('the actual shipped read binds the saved revision including data changes and refuses missing, foreign, deleted, corrupt and symlink targets', async () => {
  const slug = 'controlled-exact-snapshot';
  const long = 'complete saved café 🦊 '.repeat(100);
  const initial = { selected: { records: [{ id: 'selected-immutable', note: long }] }, nearby: { records: [{ id: 'wrong-id' }] } };
  save(slug, initial); save(`${slug}-near`, { selected: { records: [{ id: 'decoy-id' }] } });
  const full = await invokeSnapshot({ slug });
  assert.deepEqual(full.data, initial);
  assert.equal(full.workspace.revision, spaces.spaceStore.snapshot(slug)?.revision);
  const selected = await invokeSnapshot({ slug, source_id: 'selected', expected_revision: full.workspace.revision });
  assert.deepEqual(selected.data, initial.selected);
  assert.equal(selected.complete, true);
  const version = spaces.spaceStore.snapshot(slug)!.record.version;
  await executeReviewedWorkspaceSetData({ slug, source_id: 'selected', data_json: JSON.stringify({ records: [{ id: 'new-revision' }] }) });
  assert.equal(spaces.spaceStore.snapshot(slug)!.record.version, version, 'only dataset bytes changed');
  await assert.rejects(invokeSnapshot({ slug, expected_revision: full.workspace.revision }), /changed since the expected revision/);
  const current = await invokeSnapshot({ slug, source_id: 'selected' });
  assert.notEqual(current.workspace.revision, full.workspace.revision);
  assert.deepEqual(current.data, { records: [{ id: 'new-revision' }] });
  await assert.rejects(invokeSnapshot({ slug, source_id: 'absent' }), /exact named Workspace source has no saved value/);
  await assert.rejects(invokeSnapshot({ slug: 'controlled-no-such-workspace' }), /directory is unavailable/);
  const viewFile = spaces.resolveInSpace(slug, 'view/index.html');
  const viewBytes = readFileSync(viewFile);
  if (process.platform !== 'win32') {
    unlinkSync(viewFile);
    symlinkSync(spaces.resolveInSpace(`${slug}-near`, 'view/index.html'), viewFile);
    await assert.rejects(invokeSnapshot({ slug }), /view path is not safe/);
    assert.equal((await invokeSnapshot({ slug, metadata_only: true })).scope, 'metadata', 'metadata does not read a view');
    unlinkSync(viewFile);
    rmSync(path.dirname(viewFile), { recursive: true });
    symlinkSync(path.dirname(spaces.resolveInSpace(`${slug}-near`, 'view/index.html')), path.dirname(viewFile));
    await assert.rejects(invokeSnapshot({ slug }), /view path is not safe/);
    unlinkSync(path.dirname(viewFile));
  } else unlinkSync(viewFile);
  const viewMissing = await invokeSnapshot({ slug, source_id: 'selected' });
  assert.equal(viewMissing.workspace.revision, spaces.spaceStore.snapshot(slug)?.revision,
    'a genuinely missing saved view keeps the existing viewMissing revision semantics');
  mkdirSync(path.dirname(viewFile), { recursive: true }); writeFileSync(viewFile, viewBytes);
  const manifestFile = spaces.resolveInSpace(slug, 'space.json');
  const originalManifest = readFileSync(manifestFile, 'utf8');
  for (const status of ['paused', 'archived']) {
    writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), status }));
    const retained = await invokeSnapshot({ slug, source_id: 'selected' });
    assert.equal(retained.workspace.status, status);
    assert.deepEqual(retained.data, { records: [{ id: 'new-revision' }] });
  }
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), status: 'unrecognized' }));
  await assert.rejects(invokeSnapshot({ slug }), /status is unavailable or invalid/,
    'the legacy normalizer cannot turn a corrupt retained status into active proof');
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), id: `${slug}-near` }));
  await assert.rejects(invokeSnapshot({ slug }), /exact saved Workspace is unavailable|identity differs/);
  writeFileSync(manifestFile, originalManifest);
  const dataFile = spaces.resolveInSpace(slug, 'data.json');
  writeFileSync(dataFile, '{');
  await assert.rejects(invokeSnapshot({ slug }), /not readable JSON/);
  unlinkSync(dataFile);
  await assert.rejects(invokeSnapshot({ slug }), /manifest and dataset are unavailable/);
  if (process.platform !== 'win32') {
    symlinkSync(spaces.resolveInSpace(`${slug}-near`, 'data.json'), dataFile);
    await assert.rejects(invokeSnapshot({ slug }), /manifest and dataset are unavailable/);
    unlinkSync(dataFile);
    rmSync(spaces.resolveSpaceDir(slug), { recursive: true });
    symlinkSync(spaces.resolveSpaceDir(`${slug}-near`), spaces.resolveSpaceDir(slug));
    await assert.rejects(invokeSnapshot({ slug }), /directory is unavailable/);
    unlinkSync(spaces.resolveSpaceDir(slug));
  } else rmSync(spaces.resolveSpaceDir(slug), { recursive: true });
  await assert.rejects(invokeSnapshot({ slug }), /directory is unavailable/);
  assert.equal(storage.reviewedLocalStorageCarrier.select({ operationId: 'space_get', accountId: 'foreign-account' }), null);
  const controller = new AbortController(); controller.abort(new Error('controlled Stop'));
  await assert.rejects(runWithToolAbortSignal(controller.signal, () => invokeSnapshot({ slug: `${slug}-near` })), /controlled Stop/);
});

test('explicit nullable native arguments compile and cross the actual shared read kernel once without weakening schema, account, effect or invoke checks', async () => {
  manifestStore.installCapabilityManifestStore(manifestStore.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts(); observation.clearIndependentCapabilityObservations();
  const slug = 'controlled-null-workspace-kernel';
  const initial = { selected: { records: [{ id: 'literal-null-reader', text: 'saved café 🦊' }] } };
  save(slug, initial);
  const args = Object.freeze({ slug, source_id: null, metadata_only: null, limit: null, offset: null, expected_revision: null });
  const before = readFileSync(spaces.resolveInSpace(slug, 'data.json'));
  const materialized = ensureReviewedLocalWorkflowCapability({ operationId: 'space_get', args });
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  const compiled = compileLiveCatalogWorkflowCallPlan({ ownerId: 'controlled-null-kernel', nodeId: 'saved-read',
    operationId: 'space_get', args, expectedEffect: 'read' });
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  if (!compiled.ok) throw new Error(compiled.message);
  assert.equal(compiled.plan.version, 1);
  assert.equal(compiled.plan.binding.accountId, 'local_registry:host');
  assert.equal(compiled.plan.binding.effect, 'read');
  for (const key of Object.keys(args).filter(key => key !== 'slug')) assert.equal(compiled.plan.arguments[key]?.type, 'null');
  const rendered = compileWorkflowNodeInvocationArguments(compiled.plan, { workflowInputs: args, stepOutputs: {} });
  assert.equal(rendered.ok, true);
  if (!rendered.ok) throw new Error(rendered.reason);
  assert.deepEqual(rendered.args, args);
  assert.deepEqual(Object.keys(rendered.args).sort(), Object.keys(args).sort(), 'null keys survive admission rather than becoming defaults');
  const replayPlan = parseWorkflowNodeInvocationPlan(JSON.parse(JSON.stringify(compiled.plan)));
  assert.equal(replayPlan.ok, true);
  if (!replayPlan.ok) throw new Error(replayPlan.errors.join(' '));
  assert.deepEqual(compileWorkflowNodeInvocationArguments(replayPlan.plan, { workflowInputs: args, stepOutputs: {} }), rendered);
  const session = eventlog.createSession({ id: 'controlled-null-workspace-kernel', kind: 'workflow' });
  const acquire = (nodeId: string, inputArgs: Record<string, unknown> = args, accountId = 'local_registry:host') =>
    readKernel.acquireWorkflowReadOnlyOperationAuthority({ sessionId: session.id, workflowId: 'controlled-null-kernel',
      runId: `controlled-null-kernel-${nodeId}`, runOccurrenceId: `controlled-null-occurrence-${nodeId}`, nodeId,
      requirementId: `controlled-null-requirement-${nodeId}`, logicalCapabilityId: 'controlled-null-space-read',
      operationId: 'space_get', accountId, args: inputArgs });
  assert.equal(acquire('foreign-account', args, 'foreign-account').status, 'refused');
  let reads = 0, attemptedDispatches = 0;
  const real = storage.reviewedLocalStorageCarrier;
  seam.bindHostLocalWriteCarrier({ select(input) {
    const adapter = real.select(input); if (!adapter) return null;
    return { execute: async call => {
      assert.equal(call.operationId, 'space_get'); attemptedDispatches++;
      const result = await adapter.execute(call);
      reads++;
      assert.deepEqual(call.args, args, 'the physical shipped reader receives the original explicit nulls');
      return result;
    }, reconcile: adapter.reconcile };
  } });
  try {
    const armed = acquire('read');
    assert.equal(armed.status, 'armed', JSON.stringify(armed));
    if (armed.status !== 'armed') throw new Error(armed.reason);
    const parsed = parseWorkflowNodeInvocationPlan(armed.invocationPlan);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.errors.join(' '));
    for (const key of Object.keys(args).filter(key => key !== 'slug')) assert.equal(parsed.plan.arguments[key]?.type, 'null');
    const first = await readKernel.executeWorkflowReadOnlyCall({ ...armed, args });
    assert.equal(first.status, 'completed', JSON.stringify(first));
    if (first.status !== 'completed') throw new Error(JSON.stringify(first));
    assert.deepEqual((first.result as WorkspaceSnapshotReadResult).data, initial);
    assert.equal((first.result as WorkspaceSnapshotReadResult).workspace.revision, spaces.spaceStore.snapshot(slug)?.revision);
    const replay = await readKernel.executeWorkflowReadOnlyCall({ ...armed, args });
    assert.equal(replay.status, 'replayed', JSON.stringify(replay));
    if (replay.status !== 'replayed') throw new Error(JSON.stringify(replay));
    assert.deepEqual(replay.result, first.result);
    assert.equal(reads, 1);
    assert.equal(attemptedDispatches, 1, 'the exact owned read/replay crosses the shipped carrier once');

    const invalidArgs = { ...args, slug: null };
    assert.deepEqual(ensureReviewedLocalWorkflowCapability({ operationId: 'space_get', args: invalidArgs }),
      { ok: false, reason: 'arguments_invalid' }, 'the nullable plan tag does not make a nonnullable target field valid');
    let invalidSnapshotLookups = 0;
    const invalidLookup = mock.method(spaces.spaceStore, 'snapshot', () => {
      invalidSnapshotLookups++; throw new Error('nonnullable target must fail before storage lookup');
    });
    try { await assert.rejects(invokeSnapshot(invalidArgs), /arguments exceed the declared safe mode/); }
    finally { invalidLookup.mock.restore(); }
    assert.equal(attemptedDispatches, 2, 'the invalid native input attempts dispatch, then its target parser refuses it');
    assert.equal(invalidSnapshotLookups, 0);
    assert.equal(reads, 1, 'the invalid attempted dispatch returns no saved data');

    const noPort = acquire('missing-port');
    assert.equal(noPort.status, 'armed', JSON.stringify(noPort));
    if (noPort.status !== 'armed') throw new Error(noPort.reason);
    ports.clearProductionCapabilityPorts();
    const unavailable = await readKernel.executeWorkflowReadOnlyCall({ ...noPort, args });
    assert.equal(unavailable.status, 'blocked', JSON.stringify(unavailable));
    if (unavailable.status !== 'blocked') throw new Error(JSON.stringify(unavailable));
    assert.equal(unavailable.zeroBody, true);
    assert.equal(reads, 1, 'a saved null plan cannot substitute for the exact invoke port');
    assert.equal(attemptedDispatches, 2, 'the missing invoke port starts no additional attempted dispatch');
  } finally { seam.bindHostLocalWriteCarrier(real); }
  const write = ensureReviewedLocalWorkflowCapability({ operationId: 'space_set_data', args: { slug, source_id: 'draft', data_json: '{}' } });
  assert.equal(write.ok, true, JSON.stringify(write));
  const escalation = compileLiveCatalogWorkflowCallPlan({ ownerId: 'controlled-null-kernel', nodeId: 'not-a-read',
    operationId: 'space_set_data', args: { slug, source_id: 'draft', data_json: '{}' }, expectedEffect: 'read' });
  assert.equal(escalation.ok, false);
  assert.equal(readFileSync(spaces.resolveInSpace(slug, 'data.json')).equals(before), true);
  assert.deepEqual(args, { slug, source_id: null, metadata_only: null, limit: null, offset: null, expected_revision: null });
  assert.equal(providerCalls, 0);
});

for (const argumentForm of ['omitted optional fields', 'selected source with null options', 'all optional fields null'] as const) test(`workflow_create accepts the exact native read and production rehearsal reads, transforms JSON and previews save with no reader model or write (${argumentForm})`, async () => {
  manifestStore.installCapabilityManifestStore(manifestStore.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts(); observation.clearIndependentCapabilityObservations();
  const explicitNulls = argumentForm !== 'omitted optional fields';
  const allNulls = argumentForm === 'all optional fields null';
  const suffix = allNulls ? 'all-null-' : explicitNulls ? 'null-' : '';
  const slug = `controlled-workflow-${suffix}snapshot`;
  const selected = { records: [{ id: 'bound-row-1', amount: 12 }, { id: 'bound-row-2', amount: 8 }] };
  const initialData = { selected, draft: { marker: 'unchanged-before-preview' } };
  const expectedData = allNulls ? initialData : selected;
  save(slug, initialData);
  save(`${slug}-near`, { selected: { records: [{ id: 'decoy', amount: 900 }] } });
  const snapshot = spaces.spaceStore.snapshot(slug)!;
  const readArgs = { slug, source_id: allNulls ? null : 'selected', ...(explicitNulls
    ? { metadata_only: allNulls ? null : false, limit: null, offset: null, expected_revision: null }
    : { expected_revision: snapshot.revision }) };
  const stringify = { version: 1 as const, expression: { op: 'jsonStringify' as const,
    value: { op: 'get' as const, from: 'steps.read_saved.output.data' } } };
  const create = tools.get('workflow_create')!;
  const name = allNulls ? 'Controlled Workspace all null snapshot rehearsal' : explicitNulls ? 'Controlled Workspace null snapshot rehearsal' : 'Controlled Workspace snapshot rehearsal';
  const args = create.schema.parse({ name, description: 'Read one exact saved source and prepare a draft replacement.', enabled: false,
    steps: [
      { id: 'read_saved', sideEffect: 'read', call: { tool: 'space_get', args: readArgs }, output: { type: 'object', required_keys: allNulls ? ['workspace', 'data', 'complete'] : ['workspace', 'source_id', 'data', 'complete'] } },
      { id: 'encode_data', sideEffect: 'read', dependsOn: ['read_saved'], transform: JSON.stringify(stringify), output: { type: 'string' } },
      { id: 'save_draft', sideEffect: 'write', dependsOn: ['encode_data'], call: { tool: 'space_set_data', args: { slug, source_id: 'draft', data_json: '{{steps.encode_data.output}}' } } },
    ] });
  const session = eventlog.createSession({ kind: 'chat', userId: 'controlled-workflow-owner' });
  const attempt = eventlog.beginRunAttempt(session.id);
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Create a disabled manual draft from the controlled saved Workspace. Rehearse it without changing the saved data.' } });
  const authored = await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq, callId: `controlled-author-${suffix || 'omitted'}`, toolName: 'workflow_create' }, () => create.handler(args));
  assert.doesNotMatch(text(authored), /was NOT created/);
  const saved = workflows.readWorkflow(allNulls ? 'controlled-workspace-all-null-snapshot-rehearsal' : explicitNulls ? 'controlled-workspace-null-snapshot-rehearsal' : 'controlled-workspace-snapshot-rehearsal');
  assert.ok(saved, text(authored));
  assert.equal(saved.data.enabled, false);
  assert.deepEqual(saved.data.steps[0]?.call?.args, readArgs);
  assert.equal(saved.data.steps.some(step => !!step.prompt?.trim()), false, 'no reader or serialization model step was inserted');
  const dataBefore = readFileSync(spaces.resolveInSpace(slug, 'data.json'));
  const auditFile = spaces.resolveInSpace(slug, 'audit.jsonl');
  const auditBefore = existsSync(auditFile) ? readFileSync(auditFile) : null;
  const observationsBefore = workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 20 }).length;
  const reads: WorkspaceSnapshotReadResult[] = [];
  let writes = 0, modelCalls = 0;
  const real = storage.reviewedLocalStorageCarrier;
  seam.bindHostLocalWriteCarrier({ select(input) {
    const selectedAdapter = real.select(input); if (!selectedAdapter) return null;
    return { execute: async call => {
      if (call.operationId === 'space_set_data') writes++;
      if (call.operationId === 'space_get') assert.deepEqual(call.args, readArgs, 'rehearsal preserves explicit nullable argument keys through the physical reader');
      const value = await selectedAdapter.execute(call);
      if (call.operationId === 'space_get') reads.push(value as WorkspaceSnapshotReadResult);
      return value;
    }, reconcile: selectedAdapter.reconcile };
  } });
  try {
    const result = await runner.runCreationTest(saved.data, saved.name, `controlled-snapshot-rehearsal-run-${suffix || 'omitted'}`, {},
      new Proxy({}, { get() { modelCalls++; throw new Error('model fallback was consulted'); } }) as never);
    assert.deepEqual(result, { pass: true, steps: [
      { stepId: 'read_saved', status: 'ok' }, { stepId: 'encode_data', status: 'ok' }, { stepId: 'save_draft', status: 'previewed' },
    ] });
  } finally { seam.bindHostLocalWriteCarrier(real); }
  assert.equal(modelCalls, 0); assert.equal(writes, 0);
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.workspace.id, slug);
  assert.equal(reads[0]?.workspace.revision, snapshot.revision);
  assert.equal(reads[0]?.source_id, allNulls ? null : 'selected');
  assert.equal(Object.hasOwn(reads[0]!, 'source_id'), true);
  assert.deepEqual(reads[0]?.data, expectedData);
  assert.equal(executeWorkflowTransform({ transform: stringify, inputs: {}, stepOutputs: { read_saved: reads[0] } }), JSON.stringify(expectedData));
  assert.equal(readFileSync(spaces.resolveInSpace(slug, 'data.json')).equals(dataBefore), true);
  assert.equal(spaces.spaceStore.snapshot(slug)?.revision, snapshot.revision);
  assert.equal(workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 20 }).length, observationsBefore);
  assert.deepEqual(existsSync(auditFile) ? readFileSync(auditFile) : null, auditBefore);
  assert.equal(workflows.readWorkflow(saved.name)?.data.enabled, false);
  assert.equal(providerCalls, 0);
});
