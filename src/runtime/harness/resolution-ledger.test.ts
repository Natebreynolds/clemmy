import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-resolution-ledger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-resolution-ledger\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const ledger = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');
const identity = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const settlements = await import('./logical-call-settlement-store.js');
const outcomes = await import('./attempt-outcome.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text: string) {
  const session = eventlog.createSession({ id: `resolution-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(recorded, 'accepted task has one durable graph');
  const graph = recorded.data.graph as import('../graph/turn-graph-ir.js').TurnGraphIR;
  const work = graph.nodes.find((node) =>
    node.kind === 'retrieve' || node.kind === 'execute' || node.kind === 'fanout');
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1, graph, work };
}

function runRaceChild(input: {
  script: string;
  mode: 'record' | 'finalize';
  task: Record<string, unknown>;
  ready: string;
  barrier: string;
}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', input.script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RESOLUTION_RACE_MODE: input.mode,
        RESOLUTION_RACE_TASK: JSON.stringify(input.task),
        RESOLUTION_RACE_READY: input.ready,
        RESOLUTION_RACE_BARRIER: input.barrier,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('frozen operation authority stores argument structure and digest but never raw values', () => {
  const task = accept('Find the current alpha records.');
  assert.ok(task.work);
  const secret = 'private-value-that-must-not-enter-authority';
  assert.equal(ledger.recordResolvedOperation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    nodeId: task.work.id,
    operationId: 'read-alpha',
    resolvedTool: 'alpha_records_search',
    logicalToolCallId: 'logical:read-alpha',
    args: { query: secret, nested: { token: secret } },
    outcomeKind: 'succeeded',
    dispatchState: 'not_started',
  }), true);
  assert.equal(ledger.finalizeResolution(task), true);

  const frozen = ledger.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozen.status, 'ok');
  if (frozen.status !== 'ok') return;
  assert.equal(frozen.resolution.operationCount, 1);
  assert.equal(frozen.operations[0]?.effectKind, 'read');
  assert.deepEqual(frozen.operations[0]?.argumentKeys, ['nested', 'query']);

  const db = eventlog.openEventLog();
  const persisted = db.prepare(`
    SELECT argument_keys_json, argument_digest
      FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    argument_keys_json: string;
    argument_digest: string;
  };
  assert.deepEqual(JSON.parse(persisted.argument_keys_json), ['nested', 'query']);
  assert.match(persisted.argument_digest, /^[a-f0-9]{64}$/);
  const mirror = eventlog.listEvents(task.sessionId, { types: ['resolution_operation'] });
  assert.equal(mirror.length, 1);
  assert.equal(JSON.stringify({ persisted, mirror }).includes(secret), false);
});

test('finalization is a one-way CAS and no later operation can enter the frozen set', () => {
  const task = accept('Send the finished report to Alice.');
  assert.ok(task.work);
  assert.equal(ledger.recordResolvedOperation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    nodeId: task.work.id,
    operationId: 'send-report',
    resolvedTool: 'report_send',
    logicalToolCallId: 'logical:send-report',
  }), true);
  assert.equal(ledger.finalizeResolution(task), true);
  assert.equal(ledger.finalizeResolution(task), false, 'a close is not silently replayed as a new close');
  assert.equal(ledger.recordResolvedOperation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    nodeId: task.work.id,
    operationId: 'late-read',
    resolvedTool: 'report_search',
    logicalToolCallId: 'logical:late-read',
  }), false, 'an operation cannot appear after the frozen count');

  const frozen = ledger.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozen.status, 'ok');
  if (frozen.status !== 'ok') return;
  assert.equal(frozen.resolution.operationCount, 1);
  assert.deepEqual(frozen.operations.map((operation) => operation.operationId), ['send-report']);
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['resolution_finalized'] }).length,
    1,
  );
});

test('concurrent operation admission and finalization produce one serial history', async () => {
  const task = accept('Find the current alpha records.');
  assert.ok(task.work);
  const script = path.join(TMP_HOME, 'resolution-race-child.mts');
  const barrier = path.join(TMP_HOME, 'resolution-race.release');
  const recordReady = path.join(TMP_HOME, 'resolution-race.record.ready');
  const finalizeReady = path.join(TMP_HOME, 'resolution-race.finalize.ready');
  const ledgerPath = path.resolve('src/runtime/harness/resolution-ledger.ts');
  writeFileSync(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    const mode = process.env.RESOLUTION_RACE_MODE;
    const task = JSON.parse(process.env.RESOLUTION_RACE_TASK || '{}');
    const ready = process.env.RESOLUTION_RACE_READY || '';
    const barrier = process.env.RESOLUTION_RACE_BARRIER || '';
    const ledger = await import(${JSON.stringify(ledgerPath)});
    writeFileSync(ready, mode || 'unknown');
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
    const result = mode === 'record'
      ? ledger.recordResolvedOperation({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          nodeId: task.nodeId,
          operationId: 'racing-read',
          resolvedTool: 'alpha_records_search',
          logicalToolCallId: 'logical:racing-read',
        })
      : ledger.finalizeResolution({
          sessionId: task.sessionId,
          sourceUserSeq: task.sourceUserSeq,
          turn: task.turn,
        });
    console.log(JSON.stringify({ mode, result }));
  `, 'utf8');
  const payload = {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    nodeId: task.work.id,
  };
  const recording = runRaceChild({ script, mode: 'record', task: payload, ready: recordReady, barrier });
  const finalizing = runRaceChild({ script, mode: 'finalize', task: payload, ready: finalizeReady, barrier });
  const deadline = Date.now() + 30_000;
  while ((!existsSync(recordReady) || !existsSync(finalizeReady)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(existsSync(recordReady) && existsSync(finalizeReady), 'both processes reached the same barrier');
  writeFileSync(barrier, 'release\n', 'utf8');
  const results = await Promise.all([recording, finalizing]);
  for (const result of results) assert.equal(result.code, 0, result.output);

  const decoded = results.map((result) => {
    const line = result.output.trim().split('\n')
      .findLast((entry) => entry.startsWith('{') && entry.includes('"mode"'));
    return JSON.parse(line ?? '{}') as { mode?: string; result?: boolean };
  });
  assert.equal(decoded.find((entry) => entry.mode === 'finalize')?.result, true);
  const recordWon = decoded.find((entry) => entry.mode === 'record')?.result === true;
  const frozen = ledger.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozen.status, 'ok');
  if (frozen.status !== 'ok') return;
  assert.equal(frozen.resolution.operationCount, recordWon ? 1 : 0);
  assert.equal(frozen.operations.length, frozen.resolution.operationCount);

  const lifecycle = eventlog.listEvents(task.sessionId, {
    types: ['resolution_operation', 'resolution_finalized'],
  });
  assert.equal(lifecycle.filter((event) => event.type === 'resolution_finalized').length, 1);
  if (recordWon) {
    assert.deepEqual(lifecycle.map((event) => event.type), [
      'resolution_operation',
      'resolution_finalized',
    ]);
  } else {
    assert.deepEqual(lifecycle.map((event) => event.type), ['resolution_finalized']);
  }
});

test('physical dispatch evidence must belong to the same task and an in-flight crossing blocks close', () => {
  const task = accept('Find the current alpha records.');
  const other = accept('Find the current beta records.');
  assert.ok(task.work);
  const acceptedTaskId = identity.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const physicalDispatchId = 'dispatch:alpha:1';
  const admitted = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: 'logical:alpha',
      physicalDispatchId,
      ordinal: 0,
    },
    tool: 'alpha_records_search',
    args: {},
    turn: task.turn,
  });
  assert.equal(admitted.status, 'inserted');
  if (admitted.status !== 'inserted') return;
  assert.equal(
    ledger.finalizeResolution(task),
    false,
    'provider work cannot remain in flight while the observed set closes',
  );
  assert.equal(ledger.recordResolvedOperation({
    sessionId: other.sessionId,
    sourceUserSeq: other.sourceUserSeq,
    nodeId: other.work?.id ?? '',
    operationId: 'forged-cross-task',
    resolvedTool: 'alpha_records_search',
    logicalToolCallId: 'logical:alpha',
    physicalDispatchId,
  }), false);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: admitted.identity,
    tool: 'alpha_records_search',
    outcome: 'returned',
    turn: task.turn,
  }).status, 'inserted');
  const logicalSettlement = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: 'logical:alpha',
    },
    contract: { toolName: 'alpha_records_search', args: {} },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { records: [{ id: 'alpha' }] } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(
    logicalSettlement.status,
    'committed',
    logicalSettlement.status === 'storage_error' ? logicalSettlement.reason : undefined,
  );
  assert.deepEqual(
    ledger.resolvedOperationsFor(task.sessionId, task.sourceUserSeq)
      .map((operation) => operation.logicalToolCallId),
    ['logical:alpha'],
  );
  assert.equal(ledger.finalizeResolution(task), true);
});

test('a zero-crossing logical refusal must settle before the accepted operation set can freeze', () => {
  const task = accept('Find the current alpha records.');
  const acceptedTaskId = identity.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const admitted = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: 'logical:refused-before-dispatch',
    },
    tool: 'alpha_records_search',
    args: { query: 'alpha' },
  });
  assert.equal(admitted.status, 'inserted');
  assert.equal(ledger.finalizeResolution(task), false, 'an unclosed refusal is still live work');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: 'logical:refused-before-dispatch',
    },
    contract: { toolName: 'alpha_records_search', args: { query: 'alpha' } },
    execution: { kind: 'refused_pre_dispatch' },
    outcome: outcomes.classifyAttemptOutcome({ preDispatch: true, policyRefused: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'native_mcp', turn: task.turn },
  }).status, 'committed');
  assert.equal(ledger.finalizeResolution(task), true);
});

test('a damaged frozen operation set fails closed instead of becoming ready with zero nodes', () => {
  const task = accept('Find the current alpha records.');
  assert.ok(task.work);
  assert.equal(ledger.recordResolvedOperation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    nodeId: task.work.id,
    operationId: 'read-alpha',
    resolvedTool: 'alpha_records_search',
    logicalToolCallId: 'logical:damage-test',
  }), true);
  assert.equal(ledger.finalizeResolution(task), true);
  eventlog.openEventLog().prepare(`
    DELETE FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).run(task.sessionId, task.sourceUserSeq);

  const frozen = ledger.frozenResolutionFor(task.sessionId, task.sourceUserSeq);
  assert.equal(frozen.status, 'ambiguous');
  const compiled = manifests.compileObligationManifest({ graph: task.graph });
  assert.equal(compiled.validation.ok, false);
  assert.equal(compiled.manifest.readiness, 'unresolved');
  assert.deepEqual(compiled.manifest.nodes, []);
});
