/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-target-evidence.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-target-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { readWorkflowTargetEvidence } = await import('./workflow-target-evidence.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test('workflow target uses an indexed exact session range with full substring-query parity', () => {
  const actual = eventlog.openEventLog();
  const prepare = actual.prepare;
  let sql = '';
  const spy = mock.method(actual, 'prepare', (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0].includes('FROM logical_call_settlements s')
      && args[0].includes('s.session_id >= ?')) sql = args[0];
    return Reflect.apply(prepare, actual, args);
  });
  try { readWorkflowTargetEvidence('controlled-range-query'); } finally { spy.mock.restore(); }
  assert.ok(sql, 'capture the query actually used by the production reader');
  assert.doesNotMatch(sql, /\bLIMIT\b/i, 'full target review retains every matching settlement');
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE logical_call_settlements (session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT,
      outcome_kind TEXT, outcome_detail TEXT, mutating INTEGER, execution_kind TEXT, requirement_id TEXT,
      PRIMARY KEY(session_id, source_user_seq, logical_tool_call_id));
      CREATE TABLE logical_tool_calls (session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT, tool_name TEXT,
      PRIMARY KEY(session_id, source_user_seq, logical_tool_call_id));
      CREATE TABLE events (session_id TEXT, seq INTEGER, type TEXT, role TEXT, PRIMARY KEY(session_id,seq));`);
    const prefix = 'workflow:controlled-range:';
    const sessions = [prefix + 'read', prefix + 'read:child', prefix + 'Ω', prefix + '😀',
      'workflow:controlled-range0:read', 'workflow:controlled-rang:read', 'workflow:controlled-range;:read',
      'workflow:controlled-range', prefix + 'wrong-source'];
    for (const session of sessions) {
      db.prepare('INSERT INTO logical_call_settlements VALUES (?,1,?, ?,NULL,0,?,NULL)')
        .run(session, 'controlled-call', 'succeeded', 'local_execution');
      db.prepare('INSERT INTO logical_tool_calls VALUES (?,1,?,?)').run(session, 'controlled-call', 'space_get');
      db.prepare('INSERT INTO events VALUES (?,1,?,?)').run(session,
        session.endsWith('wrong-source') ? 'unrelated_event' : 'workflow_node_invocation_activated', 'system');
    }
    const upper = 'workflow:controlled-range;';
    const rows = db.prepare(sql).all(prefix, upper);
    const legacy = sql.replace('WHERE s.session_id >= ? COLLATE BINARY AND s.session_id < ? COLLATE BINARY',
      'WHERE substr(s.session_id, 1, ?) = ?');
    assert.deepEqual(rows, db.prepare(legacy).all(prefix.length, prefix), 'same joins, membership and settlement order');
    assert.deepEqual((rows as Array<{ sessionId: string }>).map(row => row.sessionId), sessions.slice(0, 4), 'neighboring IDs and non-activation sources stay excluded');
    const plan = (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(prefix, upper) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH s USING INDEX .*session_id>\? AND session_id<\?/, 'existing leading session key bounds the scan');
    assert.doesNotMatch(plan, /SCAN s\b/, 'unrelated retained runs are not scanned');
  } finally { db.close(); }
});

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* ignore */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a human decision on a review gate is evidence the goal reviewer sees, with who and when', () => {
  // Live 2026-09-22, "Handoff review fixture": approved on the card, saved
  // four seconds later, judged 4/5 for "saved without your review".
  const runId = 'review-evidence-run';
  const gateSessionId = `workflow-gate:${runId}:save_summary`;
  HarnessSession.create({
    id: gateSessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Handoff review fixture::save_summary (approval gate)',
    metadata: { source: 'workflow', workflowName: 'Handoff review fixture', workflowRunId: runId, stepId: 'save_summary', gate: true },
  });
  const row = approvalRegistry.register({
    sessionId: gateSessionId,
    subject: 'Review the 3-line summary before saving it',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });

  const pending = readWorkflowTargetEvidence(runId).summary;
  assert.match(pending, /Human review gate on step "save_summary"/);
  assert.match(pending, /still pending/);

  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'desktop-command-center');
  assert.equal(resolved.ok, true);
  const approved = readWorkflowTargetEvidence(runId).summary;
  assert.match(approved, new RegExp(`approval ${row.approvalId} approved by desktop-command-center at \\d{4}-`));
  assert.match(approved, /reviewed and approved this step's material BEFORE the step ran/);

  // Another run's gate never leaks into this run's evidence.
  assert.doesNotMatch(readWorkflowTargetEvidence('some-other-run').summary, /Human review gate/);
});

for (const variant of ['verified', 'missing-artifact', 'tampered-artifact', 'invalidated', 'model-output', 'wrong-run'] as const) {
  test(`workflow target uses admitted transform artifacts, not unverified output (${variant})`, async () => {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
    const { workflowDefinitionHash } = await import('./workflow-run-definition.js');
    const { recordStepOutput, runWorkspaceDir } = await import('./workflow-run-workspace.js');
    const { appendWorkflowEvent } = await import('./workflow-events.js');
    const { assessCompletionEvidenceCoverage } = await import('../runtime/harness/objective-judge.js');
    const { judgeWorkflowTarget } = await import('./workflow-objective-judge.js');
    const slug = `transform-evidence-${variant}`;
    const runId = `${slug}-run`;
    const value = { product: 323 };
    const definition = { name: slug, enabled: true, description: 'Return the computed product.',
      trigger: { manual: true }, steps: [{ id: 'compute', prompt: '', sideEffect: 'read',
        ...(variant === 'model-output' ? {} : { transform: { version: 1, expression: { op: 'literal', value } } }) }] };
    mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: variant === 'wrong-run' ? 'another-run' : runId,
      workflowDefinitionSnapshot: { version: 1, workflowSlug: slug, admittedAt: new Date().toISOString(),
        definition, definitionHash: workflowDefinitionHash(definition as never) },
      stepOutputs: { compute: JSON.stringify(value) },
    }));
    const artifact = recordStepOutput({ workflowName: slug, runId, stepId: 'compute', output: value, nowIso: new Date().toISOString() });
    appendWorkflowEvent(slug, runId, { kind: 'step_completed', stepId: 'compute', output: value,
      meta: { mode: variant === 'model-output' ? 'llm' : 'transform', stepOutputArtifact: artifact } });
    if (variant === 'missing-artifact') unlinkSync(path.join(runWorkspaceDir(slug, runId), artifact.path));
    if (variant === 'tampered-artifact') writeFileSync(path.join(runWorkspaceDir(slug, runId), artifact.path), '{"product":999}');
    if (variant === 'invalidated') appendWorkflowEvent(slug, runId, { kind: 'step_invalidated', stepId: 'compute' });
    const evidence = readWorkflowTargetEvidence(runId);
    if (variant === 'verified') assert.deepEqual(evidence.artifactReadback, { checked: 1, verified: 1, unavailable: 0, uncoveredWrites: 0 });
    if (variant === 'missing-artifact' || variant === 'tampered-artifact') {
      assert.deepEqual(evidence.artifactReadback, { checked: 1, verified: 0, unavailable: 1, uncoveredWrites: 0 });
    }
    if (variant === 'invalidated' || variant === 'model-output' || variant === 'wrong-run') {
      assert.deepEqual(evidence.artifactReadback, { checked: 0, verified: 0, unavailable: 0, uncoveredWrites: 0 });
    }
    const coverage = assessCompletionEvidenceCoverage({ objective: 'Return the computed product.', results: evidence.results });
    assert.equal(coverage.complete, variant === 'verified');
    if (variant === 'verified') {
      assert.match(evidence.summary, /Host-executed transform compute/);
      assert.match(evidence.summary, /323/);
      let sawReceipts = false;
      await judgeWorkflowTarget({ workflow: definition as never, inputs: {}, finalOutput: value,
        executionEvidence: () => readWorkflowTargetEvidence(runId),
        judgeFn: async (_objective, _reply, context) => {
          sawReceipts = assessCompletionEvidenceCoverage({ objective: '', results: context?.verifiedReadResults }).complete;
          return { done: true, reason: 'Verified product present.' };
        } });
      assert.equal(sawReceipts, true, 'the reviewer receives structured coverage as well as evidence text');
    } else {
      assert.equal(evidence.results?.filter(row => row.status === 'verified').length ?? 0, 0);
    }
  });
}

test('workflow target current Workspace bytes, not an upstream transform, qualify mixed-write readback', async () => {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const runner = await import('./workflow-runner.js');
  const workflows = await import('../memory/workflow-store.js');
  const queue = await import('../tools/workflow-run-queue.js');
  const local = await import('../runtime/harness/reviewed-local-tool-carrier.js');
  const adapters = await import('../runtime/harness/production-capability-adapters.js');
  const manifests = await import('../runtime/harness/capability-manifest-store.js');
  const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
  const ports = await import('../runtime/harness/production-capability-ports.js');
  const observations = await import('../runtime/harness/independent-capability-observation.js');
  const spaces = await import('../spaces/store.js');
  const db = await import('../spaces/workspace-db.js');
  const datasets = await import('../spaces/workspace-set-data-carrier.js');
  const { recordStepOutput } = await import('./workflow-run-workspace.js');
  const { appendWorkflowEvent } = await import('./workflow-events.js');
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const slug = 'goal-evidence-mixed-space';
  spaces.spaceStore.save({ id: slug, title: 'Controlled mixed result', status: 'active',
    viewEntry: 'view/index.html', viewContent: '<!doctype html><title>Controlled result</title>', dataSources: [], actions: [] });
  const observed = local.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  const manifest = local.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: adapters.invokeForSealedManifest(manifest), reconcile: adapters.reconcileForSealedManifest(manifest),
  }).ok, true);
  const step = { id: 'publish', prompt: '', sideEffect: 'write' as const,
    call: { tool: 'space_set_data', args: { slug, source_id: 'result', data_json: '{"product":323}' } } };
  const definition = { name: 'goal-evidence-mixed-workflow', description: 'Retain the controlled product.',
    enabled: true, trigger: { manual: true }, inputs: {}, steps: [
      { id: 'compute', prompt: '', sideEffect: 'read' as const,
        transform: { version: 1 as const, expression: { op: 'literal' as const, value: { product: 323 } } } }, step,
    ] };
  const persisted = workflows.writeWorkflow(definition.name, definition);
  const queued = queue.queueWorkflowRun(persisted.data.name, {}, { source: 'console', workflowSlug: persisted.name, dedupe: false });
  assert.equal(queued.status, 'queued', queued.message);
  assert.ok(queued.id);
  // The host executed this admitted deterministic transform. Its artifact is
  // intentionally still valid when the later delivered Space data drifts.
  const transform = recordStepOutput({ workflowName: persisted.name, runId: queued.id, stepId: 'compute',
    output: { product: 323 }, nowIso: new Date().toISOString() });
  appendWorkflowEvent(persisted.name, queued.id, { kind: 'step_completed', stepId: 'compute', output: { product: 323 },
    meta: { mode: 'transform', stepOutputArtifact: transform } });
  const ctx = { workflow: persisted.data, workflowSlug: persisted.name, runId: queued.id,
    inputs: {}, stepOutputs: { compute: { product: 323 } },
    assistant: new Proxy({}, { get: () => { throw new Error('No model may be consulted for a reviewed local write.'); } }),
    completedItems: new Map(), forEachFailures: [], qualityAdvisories: [] } as unknown as Parameters<typeof runner.executeStep>[1];
  try {
    await runner.executeStep(step, ctx);
    const original = readWorkflowTargetEvidence(queued.id);
    assert.deepEqual(original.artifactReadback, { checked: 2, verified: 2, unavailable: 0, uncoveredWrites: 0 }, original.summary);
    assert.equal(original.results?.filter(row => row.toolName === 'space_set_data' && row.status === 'verified').length, 1);
    const dataFile = spaces.resolveInSpace(slug, 'data.json');
    const bytes = readFileSync(dataFile);
    eventlog.closeEventLog(); db.closeWorkspaceDb();
    assert.deepEqual(readWorkflowTargetEvidence(queued.id).artifactReadback, original.artifactReadback, 'cold database reopen redeems the exact retained write');
    const originalObservation = db.getCurrentWorkspaceDatasetObservation(slug, 'result')!.id;
    await datasets.executeReviewedWorkspaceSetData({ slug, source_id: 'unrelated_sibling', data_json: '{"count":7}' });
    const withSibling = readFileSync(dataFile);
    assert.notDeepEqual(withSibling, bytes, 'the sibling writer really changed the whole data.json container');
    assert.equal(db.getCurrentWorkspaceDatasetObservation(slug, 'result')?.id, originalObservation);
    const siblingReadback = readWorkflowTargetEvidence(queued.id);
    assert.deepEqual(siblingReadback.artifactReadback, original.artifactReadback,
      'a legitimate different source does not invalidate this run’s unchanged exact source');
    assert.equal(siblingReadback.available, true, siblingReadback.summary);
    const tampered = JSON.parse(withSibling.toString('utf8'));
    tampered.result = { product: 999 };
    writeFileSync(dataFile, JSON.stringify(tampered));
    const changed = readWorkflowTargetEvidence(queued.id);
    assert.deepEqual(changed.artifactReadback, { checked: 2, verified: 1, unavailable: 1, uncoveredWrites: 0 });
    assert.equal(changed.available, false, 'matching intermediate transform bytes cannot verify changed delivered Space bytes');
    writeFileSync(dataFile, withSibling);
    const missingOwnSource = JSON.parse(withSibling.toString('utf8'));
    delete missingOwnSource.result;
    writeFileSync(dataFile, JSON.stringify(missingOwnSource));
    assert.deepEqual(readWorkflowTargetEvidence(queued.id).artifactReadback,
      { checked: 2, verified: 1, unavailable: 1, uncoveredWrites: 0 }, 'an own-source deletion is not rescued by intact sibling content');
    writeFileSync(dataFile, withSibling);
    unlinkSync(dataFile);
    assert.deepEqual(readWorkflowTargetEvidence(queued.id).artifactReadback,
      { checked: 2, verified: 1, unavailable: 1, uncoveredWrites: 0 });
  } finally {
    db.closeWorkspaceDb();
    ports.clearProductionCapabilityPorts(); observations.clearIndependentCapabilityObservations();
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});

test('workflow dataset evidence keeps each own observation when another run supersedes the same source', async () => {
  const runner = await import('./workflow-runner.js');
  const workflows = await import('../memory/workflow-store.js');
  const queue = await import('../tools/workflow-run-queue.js');
  const local = await import('../runtime/harness/reviewed-local-tool-carrier.js');
  const adapters = await import('../runtime/harness/production-capability-adapters.js');
  const manifests = await import('../runtime/harness/capability-manifest-store.js');
  const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
  const ports = await import('../runtime/harness/production-capability-ports.js');
  const observations = await import('../runtime/harness/independent-capability-observation.js');
  const spaces = await import('../spaces/store.js');
  const workspaceDb = await import('../spaces/workspace-db.js');
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts(); observations.clearIndependentCapabilityObservations();
  const slug = 'target-evidence-ordered-source';
  spaces.spaceStore.save({ id: slug, title: 'Controlled ordered source', status: 'active',
    viewEntry: 'view/index.html', viewContent: '<!doctype html><title>Controlled ordered source</title>', dataSources: [], actions: [] });
  const observed = local.observeReviewedLocalTool('space_set_data'); assert.ok(observed);
  const manifest = local.reviewedLocalCapabilityManifest(observed); assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: adapters.invokeForSealedManifest(manifest), reconcile: adapters.reconcileForSealedManifest(manifest),
  }).ok, true);
  const write = (id: string, value: number) => ({ id, prompt: '', sideEffect: 'write' as const,
    call: { tool: 'space_set_data', args: { slug, source_id: 'result', data_json: JSON.stringify({ value }) } } });
  const first = write('first', 1), second = write('second', 2), later = write('later', 3);
  const prepare = (name: string, steps: ReturnType<typeof write>[]) => {
    const persisted = workflows.writeWorkflow(name, { name, enabled: true, description: 'Save only the controlled source.',
      trigger: { manual: true }, inputs: {}, steps });
    const queued = queue.queueWorkflowRun(name, {}, { source: 'console', workflowSlug: persisted.name, dedupe: false });
    assert.equal(queued.status, 'queued', queued.message); assert.ok(queued.id);
    const ctx = { workflow: persisted.data, workflowSlug: persisted.name, runId: queued.id, inputs: {}, stepOutputs: {},
      assistant: new Proxy({}, { get: () => { throw new Error('No model is allowed in this controlled readback.'); } }),
      completedItems: new Map(), forEachFailures: [], qualityAdvisories: [] } as unknown as Parameters<typeof runner.executeStep>[1];
    return { id: queued.id, ctx };
  };
  try {
    const a = prepare('controlled-ordered-source-a', [first, second]);
    await runner.executeStep(first, a.ctx);
    const firstObservation = workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'result')!;
    await runner.executeStep(second, a.ctx);
    const secondObservation = workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'result')!;
    assert.notEqual(firstObservation.id, secondObservation.id);
    const beforeB = readWorkflowTargetEvidence(a.id);
    assert.deepEqual(beforeB.workspaceDatasetHistory, { checked: 2, verified: 2, unavailable: 0 },
      'two same-source writes retain and check both own receipts, not just the last Map entry');
    assert.deepEqual(beforeB.artifactReadback, { checked: 1, verified: 1, unavailable: 0, uncoveredWrites: 0 });

    const b = prepare('controlled-ordered-source-b', [later]);
    await runner.executeStep(later, b.ctx);
    const laterObservation = workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'result')!;
    assert.notEqual(laterObservation.id, secondObservation.id);
    const aAfterB = readWorkflowTargetEvidence(a.id);
    assert.equal(aAfterB.available, true, aAfterB.summary);
    assert.deepEqual(aAfterB.workspaceDatasetHistory, { checked: 2, verified: 2, unavailable: 0 });
    assert.deepEqual(aAfterB.artifactReadback, { checked: 1, verified: 0, unavailable: 0, uncoveredWrites: 0, superseded: 1 });
    assert.match(aAfterB.summary, /earlier value is not claimed current/);
    assert.deepEqual(readWorkflowTargetEvidence(b.id).artifactReadback,
      { checked: 1, verified: 1, unavailable: 0, uncoveredWrites: 0 });
    eventlog.closeEventLog(); workspaceDb.closeWorkspaceDb();
    assert.deepEqual(readWorkflowTargetEvidence(a.id).workspaceDatasetHistory, aAfterB.workspaceDatasetHistory,
      'cold reopen preserves both exact historical observations');
    assert.deepEqual(readWorkflowTargetEvidence(a.id).artifactReadback, aAfterB.artifactReadback);

    const db = workspaceDb.openWorkspaceDb();
    const original = db.prepare('SELECT * FROM workspace_dataset_observations WHERE id = ?').get(firstObservation.id) as Record<string, unknown>;
    const provenance = JSON.parse(String(original.provenance_json));
    const invalidObservations: Array<[string, unknown]> = [
      ['refresh_id', 'foreign-refresh'], ['source_key', 'foreign-source'], ['content_hash', '0'.repeat(64)],
      ['cause', 'foreign-cause'], ['projection_mode', 'document'], ['status', 'error'], ['dataset_id', null],
      ['provenance_json', JSON.stringify({ ...provenance, adapter: 'foreign-adapter' })],
      ['provenance_json', JSON.stringify({ ...provenance, initiatedBy: 'foreign-origin' })],
      ['provenance_json', JSON.stringify({ ...provenance, argsHash: '0'.repeat(64) })],
    ];
    for (const [column, value] of invalidObservations) {
      try {
        db.prepare(`UPDATE workspace_dataset_observations SET ${column} = ? WHERE id = ?`).run(value, firstObservation.id);
        const invalid = readWorkflowTargetEvidence(a.id);
        assert.equal(invalid.available, false, `${column}: B cannot supply A's missing authority`);
        assert.deepEqual(invalid.workspaceDatasetHistory, { checked: 2, verified: 1, unavailable: 1 }, column);
        assert.equal(readWorkflowTargetEvidence(b.id).available, true, 'B keeps its own independently verified receipt');
      } finally {
        db.prepare(`UPDATE workspace_dataset_observations SET ${column} = ? WHERE id = ?`).run(original[column], firstObservation.id);
      }
    }
    const firstBlob = db.prepare('SELECT doc_json FROM workspace_datasets WHERE id = ?').get(firstObservation.datasetId) as { doc_json: string };
    try {
      db.prepare('UPDATE workspace_datasets SET doc_json = ? WHERE id = ?').run('{"value":999}', firstObservation.datasetId);
      assert.deepEqual(readWorkflowTargetEvidence(a.id).workspaceDatasetHistory, { checked: 2, verified: 1, unavailable: 1 },
        'A must reopen its own retained bytes, not accept its metadata or B’s document');
      assert.equal(readWorkflowTargetEvidence(a.id).available, false);
    } finally { db.prepare('UPDATE workspace_datasets SET doc_json = ? WHERE id = ?').run(firstBlob.doc_json, firstObservation.datasetId); }
    const currentBlob = db.prepare('SELECT doc_json FROM workspace_datasets WHERE id = ?').get(laterObservation.datasetId) as { doc_json: string };
    try {
      db.prepare('UPDATE workspace_datasets SET doc_json = ? WHERE id = ?').run('not-json', laterObservation.datasetId);
      const unknownB = readWorkflowTargetEvidence(a.id);
      assert.deepEqual(unknownB.workspaceDatasetHistory, { checked: 2, verified: 2, unavailable: 0 });
      assert.equal(unknownB.available, false, 'an unproved current B cannot be called superseded');
      assert.deepEqual(unknownB.artifactReadback, { checked: 1, verified: 0, unavailable: 1, uncoveredWrites: 0 });
    } finally { db.prepare('UPDATE workspace_datasets SET doc_json = ? WHERE id = ?').run(currentBlob.doc_json, laterObservation.datasetId); }
    const dataFile = spaces.resolveInSpace(slug, 'data.json'); const currentBytes = readFileSync(dataFile);
    for (const contents of ['{"result":{"value":999}}', '{}', null]) {
      try {
        if (contents === null) unlinkSync(dataFile); else writeFileSync(dataFile, contents);
        const changed = readWorkflowTargetEvidence(a.id);
        assert.equal(changed.available, false, 'historical receipts do not hide missing or tampered current source bytes');
        assert.deepEqual(changed.workspaceDatasetHistory, { checked: 2, verified: 2, unavailable: 0 });
        assert.deepEqual(changed.artifactReadback, { checked: 1, verified: 0, unavailable: 1, uncoveredWrites: 0 });
      } finally { writeFileSync(dataFile, currentBytes); }
    }
  } finally {
    workspaceDb.closeWorkspaceDb(); ports.clearProductionCapabilityPorts(); observations.clearIndependentCapabilityObservations();
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});
