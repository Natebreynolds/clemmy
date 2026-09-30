import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-saved-script-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const store = await import('./store.js');
const carrier = await import('./workspace-script-carrier.js');
const authority = await import('./workspace-script-authority.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const compiler = await import('../execution/workflow-live-call-compiler.js');
const registry = await import('../tools/tool-registry.js');
const manifests = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const refusals = await import('../runtime/harness/host-pre-dispatch-refusal.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const leases = await import('../runtime/harness/dispatch-lease.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function fixture(slug: string, body = 'console.log(JSON.stringify({ rows: [1, 2] }));') {
  const source = { id: 'items', runner: 'refresh.mjs', schedule: '*/30 * * * *', timezone: 'America/Los_Angeles' };
  store.spaceStore.save({ id: slug, title: slug, status: 'active', dataSources: [source] });
  const directory = store.resolveInSpace(slug, 'data');
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, source.runner);
  const count = path.join(directory, 'crossings.txt');
  writeFileSync(target, `import { appendFileSync } from 'node:fs';\nappendFileSync('crossings.txt', 'x');\n${body}\n`);
  const args = carrier.captureWorkspaceScriptArguments({ slug, source_id: source.id, occurrence_id: `occurrence:${slug}`, cause: 'scheduled' });
  return { slug, source, directory, target, count, args };
}

function approvalFor(args: ReturnType<typeof fixture>['args'], decision: 'approved' | 'rejected' | null = 'approved') {
  const prepared = authority.prepareWorkspaceScriptCall(args);
  assert.deepEqual(prepared.prepared.prepared.canonicalArgs, args, 'the adapter compiler must preserve exact script arguments');
  if (!eventlog.getSession(prepared.sessionId)) eventlog.createSession({ id: prepared.sessionId, kind: 'workflow', title: 'Saved script fixture' });
  const row = approvals.registerResumable({ sessionId: prepared.sessionId,
    subject: 'Execute the exact controlled saved script once; dependencies and effects remain live.',
    tool: prepared.consent.tool, args: { ...prepared.consent.args }, resumeKey: prepared.consent.resumeKey }).row;
  if (decision) assert.equal(approvals.resolve(row.approvalId, decision, 'saved-script-fixture').ok, true);
  return { prepared, approvalId: row.approvalId };
}

function arm(args: ReturnType<typeof fixture>['args']) {
  const { approvalId } = approvalFor(args);
  return authority.activateApprovedWorkspaceScriptCall({ args, approvalId });
}

function counts(sessionId: string) {
  const db = eventlog.openEventLog();
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n;
  return { logical: count('logical_tool_calls'), physical: count('physical_dispatches'), settlements: count('logical_call_settlements') };
}

test('the adapter is host-only, carries opaque execution consent and cannot be compiled as a read/write', () => {
  const item = fixture('script-surface');
  const prepared = authority.prepareWorkspaceScriptCall(item.args);
  assert.equal(prepared.prepared.effect, 'admin');
  assert.deepEqual(registry.TOOL_REGISTRY.find(row => row.name === 'workspace_source_script')?.lanes, []);
  const observed = manifests.observeReviewedLocalTool('workspace_source_script');
  assert.ok(observed);
  const manifest = manifests.reviewedLocalCapabilityManifest(observed)!;
  assert.equal(manifest.effect, 'admin');
  assert.deepEqual(manifest.reconciliation, { supported: false, policy: 'uncertain_if_absent' });
  for (const expectedEffect of ['read', 'write', 'send'] as const) {
    const compiled = compiler.compileLiveCatalogWorkflowCallPlan({ ownerId: item.slug,
      nodeId: item.source.id, operationId: 'workspace_source_script', args: item.args, expectedEffect });
    assert.equal(compiled.ok, false);
  }
  assert.equal(compiler.liveCallEffectEscalates('admin', 'admin'), false);
  assert.equal(existsSync(item.count), false);
});

test('calling the carrier directly cannot start a child, even with exact serialized arguments', async () => {
  const item = fixture('script-direct');
  await assert.rejects(carrier.executeReviewedWorkspaceScript(item.args), /exact workflow call authority/);
  assert.equal(existsSync(item.count), false);
});

test('provider error names or serialized host errors cannot claim that no effects occurred', () => {
  const real = refusals.hostPreDispatchRefusal('no child started');
  assert.equal(refusals.isHostPreDispatchRefusal(real), true);
  const forged = new Error(real.message);
  forged.name = real.name;
  for (const value of [forged, structuredClone(real), { name: real.name, message: real.message }, real.message]) {
    assert.equal(refusals.isHostPreDispatchRefusal(value), false);
  }
});

for (const decision of [null, 'rejected'] as const) {
  test(`a ${decision ?? 'pending'} approval cannot arm or start a source script`, () => {
    const item = fixture(`script-${decision ?? 'pending'}`);
    const { approvalId, prepared } = approvalFor(item.args, decision);
    assert.throws(() => authority.activateApprovedWorkspaceScriptCall({ args: item.args, approvalId }), /lacks approval/);
    assert.equal(existsSync(item.count), false);
    assert.deepEqual(counts(prepared.sessionId), { logical: 0, physical: 0, settlements: 0 });
  });
}

test('exact consent executes once through the shared kernel; reopening replays the retained JSON', async () => {
  const item = fixture('script-replay');
  const { approvalId } = approvalFor(item.args);
  const active = authority.activateApprovedWorkspaceScriptCall({ args: item.args, approvalId });
  const result = await kernel.executeWorkflowV3Call(active);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  if (result.status !== 'completed') return;
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.deepEqual((result.result as { data: unknown }).data, { rows: [1, 2] });
  eventlog.closeEventLog();
  const resumed = authority.activateApprovedWorkspaceScriptCall({ args: item.args, approvalId });
  const replayed = await kernel.executeWorkflowV3Call(resumed);
  assert.equal(replayed.status, 'replayed', JSON.stringify(replayed));
  if (replayed.status === 'replayed') assert.deepEqual(replayed.result, result.result);
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.deepEqual(counts(`workspace-script:${item.slug}`), { logical: 1, physical: 1, settlements: 1 });
  assert.equal(readdirSync(item.directory).some(file => file.startsWith('.clementine-entry-')), false);
  rmSync(item.target);
  eventlog.closeEventLog();
  const afterRemoval = await kernel.executeWorkflowV3Call(active);
  assert.equal(afterRemoval.status, 'replayed', 'retained results need neither the old script nor new admission');
  if (afterRemoval.status === 'replayed') assert.deepEqual(afterRemoval.result, result.result);
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
});

test('approval for one occurrence cannot authorize a new tick or changed arguments', () => {
  const item = fixture('script-occurrence');
  const { approvalId } = approvalFor(item.args);
  for (const args of [{ ...item.args, occurrence_id: 'a-different-tick' }, { ...item.args, cause: 'manual' as const }]) {
    assert.throws(() => authority.activateApprovedWorkspaceScriptCall({ args, approvalId }), /lacks approval/);
  }
  assert.equal(existsSync(item.count), false);
});

for (const drift of ['script', 'declaration', 'archive'] as const) {
  test(`${drift} drift after activation refuses the process before it starts`, async () => {
    const item = fixture(`script-drift-${drift}`);
    const active = arm(item.args);
    if (drift === 'script') writeFileSync(item.target, "throw new Error('must not run');");
    if (drift === 'declaration') store.spaceStore.save({ id: item.slug, title: item.slug, dataSources: [{ ...item.source, schedule: '1 * * * *' }] });
    if (drift === 'archive') store.spaceStore.save({ id: item.slug, title: item.slug, status: 'archived', dataSources: [item.source] });
    const result = await kernel.executeWorkflowV3Call(active);
    assert.equal(result.status, 'failed', JSON.stringify(result));
    if (result.status === 'failed') assert.match(result.reason, /Saved (script|source)/);
    assert.equal(existsSync(item.count), false);
  });
}

test('symlinked scripts and data directories never become an execution capability', () => {
  const item = fixture('script-path');
  const external = path.join(TEST_HOME, 'external.mjs');
  writeFileSync(external, 'console.log("null");');
  rmSync(item.target);
  symlinkSync(external, item.target);
  assert.throws(() => carrier.captureWorkspaceScriptArguments(item.args), /symlink/);
  rmSync(item.directory, { recursive: true });
  const other = path.join(TEST_HOME, 'other-data');
  mkdirSync(other);
  writeFileSync(path.join(other, 'refresh.mjs'), 'console.log("null");');
  symlinkSync(other, item.directory);
  assert.throws(() => carrier.captureWorkspaceScriptArguments(item.args), /directory escapes/);
});

test('script JSON cannot claim host receipts or expose fabricated authority', async () => {
  const item = fixture('script-output', 'console.log(JSON.stringify({ receipt: "fake", authority: "fake", complete: true }));');
  const result = await kernel.executeWorkflowV3Call(arm(item.args));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  if (result.status !== 'completed') return;
  const output = result.result as Record<string, unknown>;
  assert.equal(output.kind, 'workspace_script_result');
  assert.equal(output.receipt, undefined);
  assert.equal(output.authority, undefined);
  assert.deepEqual(output.data, { receipt: 'fake', authority: 'fake', complete: true });
});

test('a process that wrote then failed is uncertain and is never retried', async () => {
  const item = fixture('script-uncertain', 'process.exit(7);');
  const active = arm(item.args);
  const first = await kernel.executeWorkflowV3Call(active);
  assert.equal(first.status, 'blocked', JSON.stringify(first));
  if (first.status === 'blocked') {
    assert.equal(first.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(first.zeroBody, false);
  }
  eventlog.closeEventLog();
  const again = await kernel.executeWorkflowV3Call(active);
  assert.equal(again.status, 'blocked', JSON.stringify(again));
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.equal(counts(`workspace-script:${item.slug}`).physical, 1);
});

test('Stop reaches the actual script and does not turn cancellation into successful source data', async () => {
  const item = fixture('script-cancel', 'await new Promise(resolve => setTimeout(resolve, 20000)); console.log("[]");');
  const signal = new AbortController();
  const active = arm(item.args);
  const pending = kernel.executeWorkflowV3Call({ ...active, signal: signal.signal });
  for (let n = 0; n < 100 && !existsSync(item.count); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(item.count), true);
  const stoppedAt = Date.now();
  signal.abort();
  const result = await pending;
  assert.notEqual(result.status, 'completed', JSON.stringify(result));
  assert.ok(Date.now() - stoppedAt < 5000);
  const replay = await kernel.executeWorkflowV3Call(active);
  assert.notEqual(replay.status, 'completed');
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.equal(readdirSync(item.directory).some(file => file.startsWith('.clementine-entry-')), false);
});

test('concurrent reentry shares one physical execution and cannot cancel the winning call', async () => {
  const item = fixture('script-concurrent', 'await new Promise(resolve => setTimeout(resolve, 750)); console.log("[]");');
  const active = arm(item.args);
  const first = kernel.executeWorkflowV3Call(active);
  for (let n = 0; n < 100 && !existsSync(item.count); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(item.count), true);
  const second = await kernel.executeWorkflowV3Call(active);
  assert.equal(second.status, 'blocked', JSON.stringify(second));
  if (second.status === 'blocked') assert.equal(second.reason, 'prior_crossing_unknown_no_redispatch');
  const winner = await first;
  assert.equal(winner.status, 'completed', JSON.stringify(winner));
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.deepEqual(counts(`workspace-script:${item.slug}`), { logical: 1, physical: 1, settlements: 1 });
});

test('a deadline after launch holds uncertain effects and does not replay the process', async () => {
  const item = fixture('script-timeout', 'await new Promise(resolve => setTimeout(resolve, 20000)); console.log("[]");');
  const active = arm(item.args);
  const previous = process.env.SPACE_RUNNER_TIMEOUT_MS;
  process.env.SPACE_RUNNER_TIMEOUT_MS = '750';
  try {
    const first = await kernel.executeWorkflowV3Call(active);
    assert.equal(first.status, 'blocked', JSON.stringify(first));
    const second = await kernel.executeWorkflowV3Call(active);
    assert.equal(second.status, 'blocked', JSON.stringify(second));
    assert.equal(readFileSync(item.count, 'utf8'), 'x');
  } finally {
    if (previous === undefined) delete process.env.SPACE_RUNNER_TIMEOUT_MS;
    else process.env.SPACE_RUNNER_TIMEOUT_MS = previous;
  }
});

test('a revoked dispatch lease stops its running process without a caller AbortSignal', async () => {
  const item = fixture('script-revoked', 'await new Promise(resolve => setTimeout(resolve, 20000)); console.log("[]");');
  const active = arm(item.args);
  const pending = kernel.executeWorkflowV3Call(active);
  for (let n = 0; n < 100 && !existsSync(item.count); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(item.count), true);
  const started = Date.now();
  const owner = callAuthority.readWorkflowV3CallAuthority(active.activationId);
  assert.equal(owner.status, 'ok');
  if (owner.status !== 'ok') return;
  // Terminal closure rightly refuses unsettled work. Cancellation revokes its
  // physical generation first; a root cannot be declared finished mid-I/O.
  const lease = eventlog.openEventLog().prepare(`SELECT scope_id AS scopeId, lease_id AS leaseId,
    session_id AS sessionId FROM run_dispatch_leases WHERE session_id = ? AND accepted_task_id = ?
    AND logical_tool_call_id = ? AND revoked_at IS NULL`).get(owner.authority.identity.sessionId,
    owner.authority.identity.acceptedTaskId, owner.authority.workflow!.logicalCallId) as Parameters<typeof leases.revokeDispatchLeaseBeforeRecovery>[0];
  assert.ok(lease);
  await leases.revokeDispatchLeaseBeforeRecovery(lease);
  assert.equal(leases.isDispatchLeaseCurrent(lease), false);
  const result = await pending;
  assert.notEqual(result.status, 'completed', JSON.stringify(result));
  assert.ok(Date.now() - started < 5000);
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
  assert.equal(readdirSync(item.directory).some(file => file.startsWith('.clementine-entry-')), false);
});

test('malformed JSON after a successful process exit is uncertain, not publishable source data', async () => {
  const item = fixture('script-malformed', 'console.log("a log message instead of data");');
  const active = arm(item.args);
  const first = await kernel.executeWorkflowV3Call(active);
  assert.equal(first.status, 'blocked', JSON.stringify(first));
  if (first.status === 'blocked') assert.equal(first.zeroBody, false);
  const second = await kernel.executeWorkflowV3Call(active);
  assert.equal(second.status, 'blocked', JSON.stringify(second));
  assert.equal(readFileSync(item.count, 'utf8'), 'x');
});

for (const mode of ['completed', 'uncertain'] as const) {
  test(`the emitted production carrier preserves ${mode} execution across two fresh processes`, () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'clem-saved-script-process-'));
    try {
      const run = (phase: 'execute' | 'replay') => {
        const env = { ...process.env, CLEMENTINE_HOME: home, MCP_AUTO_IMPORT_ENABLED: 'false' };
        delete env.CLEMMY_TEST_ISOLATED_HOME;
        delete env.NODE_TEST_CONTEXT;
        const child = spawnSync(process.execPath, ['--import', 'tsx',
          fileURLToPath(new URL('./workspace-script-process.fixture.ts', import.meta.url)), phase, mode],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
        const line = child.stdout.split('\n').find(row => row.startsWith('SAVED_SCRIPT_PROCESS_RESULT '));
        assert.ok(line, child.stdout);
        return JSON.parse(line.slice('SAVED_SCRIPT_PROCESS_RESULT '.length));
      };
      const first = run('execute');
      const second = run('replay');
      assert.equal(first.result.status, mode === 'completed' ? 'completed' : 'blocked');
      assert.equal(second.result.status, mode === 'completed' ? 'replayed' : 'blocked');
      assert.equal(first.crossings, 'x');
      assert.equal(second.crossings, 'x');
      assert.deepEqual(first.counts, { logical_tool_calls: 1, physical_dispatches: 1, logical_call_settlements: 1 });
      assert.deepEqual(second.counts, first.counts);
      if (mode === 'completed') assert.deepEqual(second.result.result, first.result.result);
      else assert.equal(second.result.reason, 'prior_crossing_unknown_no_redispatch');
      const emitted = JSON.parse(readFileSync(new URL('../runtime/harness/implementation-artifacts/emitted/manifest.json', import.meta.url), 'utf8'));
      assert.equal(first.provenance.kind, 'invoke');
      assert.equal(first.provenance.transportDigest, emitted.artifacts.transport.sha256);
      assert.equal(second.provenance.transportDigest, emitted.artifacts.transport.sha256);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
