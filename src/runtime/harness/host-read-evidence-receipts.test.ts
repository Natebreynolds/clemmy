import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-read-receipts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-read-receipts\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');
const manifests = await import('./obligation-manifest.js');
const authority = await import('./accepted-task-authority.js');
const handles = await import('./result-handle.js');
const receipts = await import('./evidence-receipts.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

interface Task {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
}

function accept(text: string): Task {
  const session = eventlog.createSession({ id: `host-receipt-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const task = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
  assert.equal(authority.armAcceptedTaskAuthority(task).status, 'armed');
  return task;
}

function returnedCrossing(input: {
  task: Task;
  logicalToolCallId: string;
  physicalDispatchId: string;
  tool: string;
  args: unknown;
  relation?: 'primary' | 'retry' | 'poll';
}) {
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: input.physicalDispatchId,
      ordinal: 0,
      ...(input.relation ? { relation: input.relation } : {}),
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') throw new Error(begun.reason);
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  }).status, 'inserted');
  return begun.identity;
}

function settledTask(input: {
  text?: string;
  tool: string;
  payload: unknown;
  args?: unknown;
  outcome?: 'succeeded' | 'empty_result';
  businessCall?: boolean;
  mutating?: boolean;
  priorPayload?: unknown;
}) {
  const task = accept(input.text ?? 'Find the current alpha records.');
  const logicalToolCallId = `logical:${serial}`;
  const args = input.args ?? { query: 'alpha' };
  const chainId = `chain:${serial}`;
  if (input.priorPayload !== undefined) {
    const first = returnedCrossing({
      task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${serial}:1`,
      tool: input.tool,
      args,
    });
    handles.toResultHandle(input.priorPayload, {
      authority: {
        ...task,
        logicalToolCallId,
        physicalDispatchId: first.physicalDispatchId,
        continuationChainId: chainId,
        toolName: input.tool,
        args,
      },
    });
  }
  const physical = returnedCrossing({
    task,
    logicalToolCallId,
    physicalDispatchId: `dispatch:${serial}:final`,
    tool: input.tool,
    args,
    ...(input.priorPayload === undefined ? {} : { relation: 'poll' as const }),
  });
  const outcome = input.outcome === 'empty_result'
    ? outcomes.classifyAttemptOutcome({ envelopeSuccessful: true, emptyResult: true })
    : outcomes.classifyAttemptOutcome({ envelopeSuccessful: true });
  const committed = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: input.tool, args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: input.payload,
      ...(input.priorPayload === undefined ? {} : { continuationChainId: chainId }),
    },
    outcome,
    recovery: {
      businessCall: input.businessCall !== false,
      mutating: input.mutating === true,
    },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') throw new Error(JSON.stringify(committed));
  return { task, args, logicalToolCallId, physical, settlement: committed.settlement };
}

function manifestSettledTask(settled: ReturnType<typeof settledTask>) {
  assert.equal(resolution.finalizeResolution(settled.task), true);
  const expected = resolution.expectedTaskFor(
    settled.task.sessionId,
    settled.task.sourceUserSeq,
  );
  assert.equal(expected.status, 'ok');
  if (expected.status !== 'ok') throw new Error(expected.reason);
  const compiled = manifests.compileObligationManifest({ graph: expected.graph });
  assert.deepEqual(compiled.validation.errors, []);
  assert.equal(compiled.manifest.readiness, 'ready');
  assert.equal(authority.manifestAcceptedTaskAuthority(compiled.manifest).status, 'manifested');
  assert.equal(compiled.manifest.nodes.length, 1);
  return compiled.manifest;
}

function issueFor(settled: ReturnType<typeof settledTask>, manifest: manifests.ObligationManifest) {
  const node = manifest.nodes[0]!;
  return receipts.issueHostReadEvidenceForManifestNode({
    sessionId: settled.task.sessionId,
    sourceUserSeq: settled.task.sourceUserSeq,
    manifestId: manifest.manifestId,
    nodeId: node.nodeId,
  });
}

function spawnIssuer(input: Parameters<typeof receipts.issueHostReadEvidenceForManifestNode>[0]) {
  const moduleUrl = pathToFileURL(path.resolve('src/runtime/harness/evidence-receipts.ts')).href;
  const code = `
    const receipts = await import(${JSON.stringify(moduleUrl)});
    const result = receipts.issueHostReadEvidenceForManifestNode(${JSON.stringify(input)});
    process.stdout.write('__RECEIPT_RESULT__' + Buffer.from(JSON.stringify(result)).toString('base64') + '__END__');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: { ...process.env, CLEMENTINE_HOME: TMP_HOME, MCP_AUTO_IMPORT_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<ReturnType<typeof receipts.issueHostReadEvidenceForManifestNode>>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `issuer exited ${code}`));
      else {
        const start = stdout.lastIndexOf('__RECEIPT_RESULT__');
        const end = stdout.indexOf('__END__', start);
        if (start < 0 || end < 0) reject(new Error(`issuer returned no result marker: ${stdout}`));
        else {
          const encoded = stdout.slice(start + '__RECEIPT_RESULT__'.length, end);
          resolve(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ReturnType<typeof receipts.issueHostReadEvidenceForManifestNode>);
        }
      }
    });
  });
}

test('point lookup mints an observation without pretending to exhaust a collection', () => {
  const settled = settledTask({
    tool: 'alpha_record_get_by_id',
    args: { id: 'r1' },
    payload: { successful: true, data: { id: 'r1', name: 'Alpha' } },
  });
  const manifest = manifestSettledTask(settled);
  assert.equal(manifest.nodes[0]?.operationMode, 'point_read');
  const issued = issueFor(settled, manifest);
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') return;
  assert.equal(issued.receipt.kind, 'observation');
  assert.equal(issued.receipt.obligation, 'source_observed');
  assert.equal(manifest.nodes[0]?.obligations.includes('source_completeness'), false);
  assert.equal(receipts.redeemHostReadEvidenceReceipt(
    settled.task.sessionId,
    issued.receipt.receiptId,
    { sourceUserSeq: settled.task.sourceUserSeq, expectKind: 'observation' },
  ).ok, true);
});

test('a successful empty business point read remains valid observation with no progress credit', () => {
  const settled = settledTask({
    tool: 'alpha_record_get_by_id',
    args: { id: 'missing' },
    payload: { successful: true, data: null },
    outcome: 'empty_result',
  });
  assert.equal(settled.settlement.outcome.kind, 'empty_result');
  assert.equal(settled.settlement.recovery.progressClaimed, false);
  const manifest = manifestSettledTask(settled);
  const issued = issueFor(settled, manifest);
  assert.equal(issued.status, 'issued');
  assert.equal(issued.status === 'issued' && issued.receipt.kind, 'observation');
});

test('an empty discovery result does not become an observed business operation', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [] }, meta: { complete: true } },
    outcome: 'empty_result',
    businessCall: false,
  });
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accepted_task_operations
    WHERE session_id = ? AND source_user_seq = ?`).get(
    settled.task.sessionId,
    settled.task.sourceUserSeq,
  ) as { n: number }).n, 0);
  assert.equal(resolution.finalizeResolution(settled.task), true);
  const frozen = resolution.frozenResolutionFor(
    settled.task.sessionId,
    settled.task.sourceUserSeq,
  );
  assert.equal(frozen.status, 'ok');
  assert.equal(frozen.status === 'ok' && frozen.resolution.expectationsSatisfied, false);
  assert.equal(receipts.issueHostReadEvidenceForManifestNode({
    sessionId: settled.task.sessionId,
    sourceUserSeq: settled.task.sourceUserSeq,
    manifestId: 'manifest:v1:not-authority',
    nodeId: 'n5:execute/discovery',
  }).status, 'refused');
});

test('a complete collection derives identities from raw bytes and exactly replays', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: {
      successful: true,
      data: { records: [{ id: 'r2' }, { record_id: 'r1' }, { name: 'digest-only' }] },
      meta: { complete: true },
    },
  });
  const manifest = manifestSettledTask(settled);
  const first = issueFor(settled, manifest);
  assert.equal(first.status, 'issued');
  if (first.status !== 'issued') return;
  assert.deepEqual(first.receipt.recordIdentities.slice(0, 2), ['id:r2', 'recordid:r1']);
  assert.match(first.receipt.recordIdentities[2] ?? '', /^sha256:[a-f0-9]{64}$/);
  const replay = issueFor(settled, manifest);
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.status === 'replayed' && replay.receipt.receiptId, first.receipt.receiptId);
  assert.equal(eventlog.listEvents(settled.task.sessionId, { types: ['evidence_receipt'] }).length, 1);
});

for (const fixture of [
  {
    name: 'partial collection',
    payload: { successful: true, data: { records: [{ id: 'r1' }] }, meta: { complete: false } },
  },
  {
    name: 'outstanding cursor despite a complete flag',
    payload: {
      successful: true,
      data: { records: [{ id: 'r1' }] },
      meta: { complete: true },
      next_cursor: 'opaque-next',
    },
  },
] as const) {
  test(`collection receipt refuses ${fixture.name}`, () => {
    const settled = settledTask({ tool: 'alpha_records_search', payload: fixture.payload });
    const manifest = manifestSettledTask(settled);
    assert.equal(issueFor(settled, manifest).status, 'refused');
  });
}

test('collection receipt refuses a repeated opaque cursor', () => {
  const page = {
    successful: true,
    data: { records: [{ id: 'r1' }] },
    meta: { complete: true },
    next_cursor: 'same-opaque-cursor',
  };
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: page,
    priorPayload: page,
  });
  const manifest = manifestSettledTask(settled);
  assert.equal(settled.settlement.resultHandleId !== undefined, true);
  assert.equal(issueFor(settled, manifest).status, 'refused');
});

test('contradictory nested provider envelope cannot commit a successful settlement', () => {
  const task = accept('Find every alpha record.');
  const tool = 'alpha_records_search';
  const args = { query: 'alpha' };
  const logicalToolCallId = `logical:${serial}`;
  returnedCrossing({
    task,
    logicalToolCallId,
    physicalDispatchId: `dispatch:${serial}:contradiction`,
    tool,
    args,
  });
  const committed = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId },
    contract: { toolName: tool, args },
    execution: { kind: 'provider_execution' },
    result: {
      payload: {
        successful: true,
        data: { records: [], error: { code: 'upstream_failed', message: 'source unavailable' } },
        meta: { complete: true },
      },
    },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(committed.status, 'storage_error');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`).get(
    task.sessionId,
    task.sourceUserSeq,
    logicalToolCallId,
  ) as { n: number }).n, 0, 'the contradictory success never becomes settlement authority');
});

test('caller cannot cross tasks, relabel a write, or supply identities and verdicts', () => {
  const first = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [{ id: 'real' }] }, meta: { complete: true } },
  });
  const firstManifest = manifestSettledTask(first);
  const second = settledTask({
    tool: 'beta_records_search',
    payload: { successful: true, data: { records: [{ id: 'other' }] }, meta: { complete: true } },
  });
  const secondManifest = manifestSettledTask(second);
  assert.equal(receipts.issueHostReadEvidenceForManifestNode({
    sessionId: first.task.sessionId,
    sourceUserSeq: first.task.sourceUserSeq,
    manifestId: secondManifest.manifestId,
    nodeId: secondManifest.nodes[0]!.nodeId,
  }).status, 'conflict');

  const supplied = receipts.issueHostReadEvidenceForManifestNode({
    sessionId: first.task.sessionId,
    sourceUserSeq: first.task.sourceUserSeq,
    manifestId: firstManifest.manifestId,
    nodeId: firstManifest.nodes[0]!.nodeId,
    recordIdentities: ['caller-lie'],
    completeness: 'complete',
    kind: 'collection',
  } as Parameters<typeof receipts.issueHostReadEvidenceForManifestNode>[0]);
  assert.equal(supplied.status, 'issued');
  assert.deepEqual(supplied.status === 'issued' && supplied.receipt.recordIdentities, ['id:real']);

  const write = settledTask({
    text: 'Send the alpha report to the recipient.',
    tool: 'alpha_report_send',
    args: { to: 'recipient', body: 'report' },
    payload: { successful: true, data: { receipt_id: 'provider-r1' } },
    mutating: true,
  });
  const writeManifest = manifestSettledTask(write);
  assert.equal(writeManifest.nodes[0]?.effectKind, 'external_write');
  assert.equal(issueFor(write, writeManifest).status, 'refused');
});

test('receipt row and event mirror roll back together on storage failure', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [] }, meta: { complete: true } },
  });
  const manifest = manifestSettledTask(settled);
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_evidence_receipt_failure
    BEFORE INSERT ON evidence_receipts
    BEGIN
      SELECT RAISE(ABORT, 'forced evidence receipt failure');
    END;
  `);
  const failed = issueFor(settled, manifest);
  db.exec('DROP TRIGGER force_evidence_receipt_failure');
  assert.equal(failed.status, 'storage_error');
  assert.equal(eventlog.listEvents(settled.task.sessionId, { types: ['evidence_receipt'] }).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM evidence_receipts
    WHERE session_id = ? AND source_user_seq = ?`).get(
    settled.task.sessionId,
    settled.task.sourceUserSeq,
  ) as { n: number }).n, 0);
  assert.equal(issueFor(settled, manifest).status, 'issued');
});

test('two process issuers serialize to one winner and one exact replay', async () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [{ id: 'r1' }] }, meta: { complete: true } },
  });
  const manifest = manifestSettledTask(settled);
  const input = {
    sessionId: settled.task.sessionId,
    sourceUserSeq: settled.task.sourceUserSeq,
    manifestId: manifest.manifestId,
    nodeId: manifest.nodes[0]!.nodeId,
  };
  eventlog.closeEventLog();
  const results = await Promise.all([spawnIssuer(input), spawnIssuer(input)]);
  assert.deepEqual(results.map((entry) => entry.status).sort(), ['issued', 'replayed']);
  assert.equal((eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM evidence_receipts
    WHERE session_id = ? AND source_user_seq = ?`).get(
    settled.task.sessionId,
    settled.task.sourceUserSeq,
  ) as { n: number }).n, 1);
  assert.equal(eventlog.listEvents(settled.task.sessionId, { types: ['evidence_receipt'] }).length, 1);
});

test('normalized receipt and raw digest redeem after restart; legacy output cannot authorize armed task', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [{ id: 'r1' }] }, meta: { complete: true } },
  });
  const manifest = manifestSettledTask(settled);
  const issued = issueFor(settled, manifest);
  assert.equal(issued.status, 'issued');
  if (issued.status !== 'issued') return;
  eventlog.closeEventLog();
  assert.equal(receipts.redeemHostReadEvidenceReceipt(
    settled.task.sessionId,
    issued.receipt.receiptId,
    { sourceUserSeq: settled.task.sourceUserSeq, manifestId: manifest.manifestId },
  ).ok, true);
  const fakeLegacy = eventlog.appendEvent({
    sessionId: settled.task.sessionId,
    turn: 1,
    role: 'system',
    type: 'evidence_receipt',
    data: { receiptId: 'legacy-fake', kind: 'collection' },
  });
  assert.ok(fakeLegacy);
  const legacy = receipts.redeemEvidenceReceipt(settled.task.sessionId, 'legacy-fake', {
    sourceUserSeq: settled.task.sourceUserSeq,
    expectKind: 'collection',
  });
  assert.equal(legacy.ok, false);
  assert.match(legacy.ok ? '' : legacy.reason, /legacy.*cannot authorize/i);
});

test('corrupt raw bytes fail closed even though settlement and handle ids still match', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, data: { records: [{ id: 'r1' }] }, meta: { complete: true } },
  });
  const manifest = manifestSettledTask(settled);
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_durable_result_identity_immutable');
  try {
    db.prepare(`UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?`)
      .run('{"tampered":true}', settled.settlement.resultHandleId);
  } finally {
    recreateDurableResultImmutableTrigger();
  }
  const refused = issueFor(settled, manifest);
  assert.equal(refused.status, 'refused');
  assert.match(refused.status === 'refused' ? refused.reason : '', /corrupt|digest/i);
});

function recreateDurableResultImmutableTrigger(): void {
  eventlog.openEventLog().exec(`
    CREATE TRIGGER IF NOT EXISTS trg_durable_result_identity_immutable
    BEFORE UPDATE ON durable_result_handles
    BEGIN
      SELECT RAISE(ABORT, 'durable result handles are immutable');
    END;
  `);
}

function recreatePhysicalDispatchImmutableTrigger(): void {
  eventlog.openEventLog().exec(`
    CREATE TRIGGER IF NOT EXISTS trg_physical_dispatch_identity_immutable
    BEFORE UPDATE OF accepted_task_id, logical_tool_call_id,
                     physical_dispatch_id, ordinal, relation, retry_of,
                     tool_name, argument_digest
    ON physical_dispatches
    WHEN OLD.accepted_task_id IS NOT NEW.accepted_task_id
      OR OLD.logical_tool_call_id IS NOT NEW.logical_tool_call_id
      OR OLD.physical_dispatch_id IS NOT NEW.physical_dispatch_id
      OR OLD.ordinal IS NOT NEW.ordinal
      OR OLD.relation IS NOT NEW.relation
      OR OLD.retry_of IS NOT NEW.retry_of
      OR OLD.tool_name IS NOT NEW.tool_name
      OR OLD.argument_digest IS NOT NEW.argument_digest
    BEGIN
      SELECT RAISE(ABORT, 'physical dispatch identity is immutable');
    END;
  `);
}

function recreateLogicalSettlementImmutableTrigger(): void {
  eventlog.openEventLog().exec(`
    CREATE TRIGGER IF NOT EXISTS trg_logical_call_settlement_row_immutable
    BEFORE UPDATE ON logical_call_settlements
    BEGIN
      SELECT RAISE(ABORT, 'logical call settlements are immutable');
    END;
  `);
}

function redeemSettlement(settled: ReturnType<typeof settledTask>) {
  return handles.redeemSuccessfulSettlementResultForHost({
    sessionId: settled.task.sessionId,
    sourceUserSeq: settled.task.sourceUserSeq,
    acceptedTaskId: settled.task.acceptedTaskId,
    logicalToolCallId: settled.logicalToolCallId,
  });
}

test('host redemption re-derives record path and count instead of trusting handle columns', () => {
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: {
      successful: true,
      data: { records: [{ id: 'real' }] },
      shadow: { records: [{ id: 'forged' }] },
      meta: { complete: true },
    },
  });
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_durable_result_identity_immutable');
  try {
    db.prepare(`UPDATE durable_result_handles
      SET record_path = 'shadow.records', record_count = 1
      WHERE handle_id = ?`).run(settled.settlement.resultHandleId);
  } finally {
    recreateDurableResultImmutableTrigger();
  }
  assert.equal(redeemSettlement(settled).status, 'corrupt');
});

test('host redemption re-derives completeness, continuation, and cursor repetition from raw bytes', () => {
  const page = {
    successful: true,
    data: { records: [{ id: 'r1' }] },
    meta: { complete: true },
    next_cursor: 'same-cursor',
  };
  const settled = settledTask({
    tool: 'alpha_records_search',
    payload: page,
    priorPayload: page,
  });
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_durable_result_identity_immutable');
  try {
    db.prepare(`UPDATE durable_result_handles
      SET completeness = 'complete', continuation_ref = NULL,
          cursor_bytes = NULL, cursor_sha256 = NULL, cursor_repeated = 0
      WHERE handle_id = ?`).run(settled.settlement.resultHandleId);
  } finally {
    recreateDurableResultImmutableTrigger();
  }
  assert.equal(redeemSettlement(settled).status, 'corrupt');
});

function multiCrossingSettlement() {
  return settledTask({
    tool: 'alpha_records_search',
    payload: { successful: true, records: [{ id: 'final' }], meta: { complete: true } },
    priorPayload: { successful: true, records: [], meta: { complete: false } },
  });
}

test('host redemption recomputes the frozen crossing digest', () => {
  const badDigest = multiCrossingSettlement();
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_logical_call_settlement_row_immutable');
  try {
    db.prepare(`UPDATE logical_call_settlements
      SET physical_crossings_digest = ?
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`).run(
      '0'.repeat(64),
      badDigest.task.sessionId,
      badDigest.task.sourceUserSeq,
      badDigest.logicalToolCallId,
    );
  } finally {
    recreateLogicalSettlementImmutableTrigger();
  }
  assert.equal(redeemSettlement(badDigest).status, 'corrupt', 'stored digest is recomputed');
});

test('host redemption compares every frozen crossing with its digest', () => {
  const badFrozen = multiCrossingSettlement();
  eventlog.openEventLog().prepare(`UPDATE logical_call_settlement_crossings
    SET tool_name = tool_name || '_forged'
    WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ? AND ordinal = 1`).run(
    badFrozen.task.sessionId,
    badFrozen.task.sourceUserSeq,
    badFrozen.logicalToolCallId,
  );
  assert.equal(redeemSettlement(badFrozen).status, 'corrupt', 'frozen rows must match their digest');
});

test('host redemption compares the exact live and frozen crossing sets', () => {
  const badLive = multiCrossingSettlement();
  const db = eventlog.openEventLog();
  db.exec('DROP TRIGGER IF EXISTS trg_physical_dispatch_identity_immutable');
  try {
    db.prepare(`UPDATE physical_dispatches
      SET tool_name = tool_name || '_forged'
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ? AND ordinal = 1`).run(
      badLive.task.sessionId,
      badLive.task.sourceUserSeq,
      badLive.logicalToolCallId,
    );
  } finally {
    recreatePhysicalDispatchImmutableTrigger();
  }
  assert.equal(redeemSettlement(badLive).status, 'corrupt', 'live crossing set must equal the frozen set');
});
