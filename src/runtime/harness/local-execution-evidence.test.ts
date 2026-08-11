import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-local-evidence\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const admissionModule = await import('./expected-work-admission.js');
const seals = await import('./expected-work-universe-seal.js');
const projector = await import('./expected-work-observed-projector.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlement = await import('./attempt-settlement.js');
const settlements = await import('./logical-call-settlement-store.js');
const resolution = await import('./resolution-ledger.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** The count-only shape, with the local tools the live scenario actually used. */
const ASK = 'Read every open lead and write a local follow-up draft file for each one.';
const SOURCE_TOOL = 'read_file';
const DRAFT_TOOL = 'write_file';

let serial = 0;

interface LocalTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  acceptedTaskId: string;
  label: string;
}

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read_leads',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_draft',
        effect: 'local_write' as const,
        dependsOn: ['read_leads'],
        dataFrom: ['read_leads'],
        cardinality: { kind: 'each' as const, universeId: 'leads' },
      },
    ],
    universes: [{
      id: 'leads',
      seal: 'complete_source_receipt' as const,
      producedBy: 'read_leads',
      memberIdPointer: '/id',
    }],
  };
}

function acceptLocalAction(label: string): LocalTask {
  const id = ++serial;
  const session = eventlog.createSession({ id: `local-evidence-${label}-${id}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return {
    ...task,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `${label}-${id}`,
  };
}

/**
 * A local tool's real result shape: bytes the host got back, with no provider
 * envelope and therefore no `successful` flag to read a verdict from.
 */
function localSourcePayload(records: unknown[]): unknown {
  return { records, complete: true };
}

function openAndBind(input: {
  task: LocalTask;
  suffix: string;
  tool: string;
  args: unknown;
  requirementId: string;
  withProposal: boolean;
  universeItemId?: string;
  universeSelector?: { argumentPointer: string; memberIdPointer: string | null };
}): string {
  const logicalToolCallId = `logical:${input.task.label}:${input.suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: input.task.sessionId,
      sourceUserSeq: input.task.sourceUserSeq,
      turn: input.task.turn,
      acceptedTaskId: input.task.acceptedTaskId,
      logicalToolCallId,
    },
    tool: input.tool,
    args: input.args,
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  const bound = admissionModule.admitExpectedWorkInvocation({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    logicalToolCallId,
    proposal: input.withProposal ? proposal() : null,
    requirementId: input.requirementId,
    tool: input.tool,
    args: input.args,
    ...(input.universeItemId ? { universeItemId: input.universeItemId } : {}),
    ...(input.universeSelector ? { universeSelector: input.universeSelector } : {}),
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  return logicalToolCallId;
}

/** Settle exactly as the shared local lane does: bytes in hand, no crossing. */
function settleLocal(input: {
  task: LocalTask;
  logicalToolCallId: string;
  tool: string;
  args: unknown;
  result?: unknown;
  thrown?: unknown;
  requirementId?: string;
  businessCall?: boolean;
}) {
  return settlement.settleToolAttempt({
    sessionId: input.task.sessionId,
    sourceUserSeq: input.task.sourceUserSeq,
    turn: input.task.turn,
    lane: 'agents_runner',
    toolName: input.tool,
    callId: input.logicalToolCallId,
    args: input.args,
    mutating: false,
    businessCall: input.businessCall ?? true,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'result') ? { result: input.result } : {}),
    ...(input.thrown !== undefined ? { thrown: input.thrown } : {}),
  });
}

function settlementRow(task: LocalTask, logicalToolCallId: string) {
  return eventlog.openEventLog().prepare(`
    SELECT execution_kind, outcome_kind, outcome_evidence, outcome_detail,
           physical_crossing_count, host_crossing_count, result_handle_id
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, logicalToolCallId) as {
    execution_kind: string;
    outcome_kind: string;
    outcome_evidence: string;
    outcome_detail: string | null;
    physical_crossing_count: number;
    host_crossing_count: number | null;
    result_handle_id: string | null;
  } | undefined;
}

function frozenContract(task: LocalTask): contracts.AcceptedTaskWorkContractV1 {
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok', JSON.stringify(loaded));
  if (loaded.status !== 'ok') throw new Error('contract missing');
  return loaded.contract;
}

test('the host classifies its own returned execution, and never overrides a real verdict', () => {
  const host = outcomes.classifyAttemptOutcome({ hostExecuted: true });
  assert.equal(host.kind, 'succeeded');
  assert.equal(host.evidence, 'nominal');
  assert.equal(host.detail, 'host_execution');
  assert.equal(
    outcomes.classifyAttemptOutcome({ hostExecuted: true, emptyResult: true }).kind,
    'empty_result',
  );
  // Every nominal and structured verdict still outranks it.
  assert.equal(outcomes.classifyAttemptOutcome({ hostExecuted: true, policyRefused: true }).kind, 'policy_denial');
  assert.equal(
    outcomes.classifyAttemptOutcome({ hostExecuted: true, argumentValidationFailed: true }).kind,
    'invalid_arguments',
  );
  assert.equal(
    outcomes.classifyAttemptOutcome({ hostExecuted: true, envelopeSuccessful: false }).kind,
    'unsupported_capability',
  );
  assert.equal(
    outcomes.classifyAttemptOutcome({ hostExecuted: true, httpStatus: 500 }).kind,
    'transient',
  );
  // And without it, an envelope-less local result is still honestly unknown.
  assert.equal(outcomes.classifyAttemptOutcome({ text: 'file contents' }).kind, 'unknown');
});

test('a local source read settles with redeemable evidence and seals its universe', () => {
  const task = acceptLocalAction('seal');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args,
    requirementId: 'read_leads',
    withProposal: true,
  });

  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: localSourcePayload([{ id: 'lead-002' }, { id: 'lead-001' }]),
    requirementId: 'read_leads',
  });
  assert.equal(settled.outcome.kind, 'succeeded');
  assert.equal(settled.outcome.detail, 'host_execution');

  const row = settlementRow(task, call);
  assert.equal(row?.execution_kind, 'local_execution', 'the settlement still says where it ran');
  assert.equal(row?.outcome_kind, 'succeeded');
  assert.equal(row?.physical_crossing_count, 0, 'nothing left the machine, so nothing counts as provider traffic');
  assert.equal(row?.host_crossing_count, 1, 'the host crossing is counted as its own kind');
  assert.ok(row?.result_handle_id, 'the host kept the bytes it got back');

  const crossing = eventlog.openEventLog().prepare(`
    SELECT relation, state, execution_site, tool_name FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).all(task.sessionId, task.sourceUserSeq, call);
  assert.deepEqual(crossing, [{
    relation: 'primary',
    state: 'returned',
    execution_site: 'host',
    tool_name: SOURCE_TOOL,
  }], 'the crossing records that it never left the process');

  const contract = frozenContract(task);
  const universe = contract.universes.find((entry) => entry.id === 'leads');
  assert.ok(universe && universe.seal === 'complete_source_receipt');
  if (!universe || universe.seal !== 'complete_source_receipt') throw new Error('universe missing');
  const sealed = seals.sealSourceDerivedUniverse({
    db: eventlog.openEventLog(),
    contract,
    universe,
  });
  assert.equal(sealed.status, 'sealed', JSON.stringify(sealed));
  if (sealed.status !== 'sealed') throw new Error('local source did not seal');
  assert.deepEqual(sealed.seal.members, ['lead-001', 'lead-002']);
});

test('a local per-item write discharges its dependency and proves the whole contract', () => {
  const task = acceptLocalAction('endtoend');
  const sourceArgs = { path: 'leads.json' };
  const sourceCall = openAndBind({
    task,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args: sourceArgs,
    requirementId: 'read_leads',
    withProposal: true,
  });
  settleLocal({
    task,
    logicalToolCallId: sourceCall,
    tool: SOURCE_TOOL,
    args: sourceArgs,
    result: localSourcePayload([{ id: 'lead-001' }, { id: 'lead-002' }]),
    requirementId: 'read_leads',
  });

  for (const member of ['lead-001', 'lead-002']) {
    const args = { path: `drafts/${member}.md`, content: `Follow-up for ${member}`, lead_id: member };
    // Binding at all proves the dependency discharged and the universe sealed
    // from a purely local producer read.
    const call = openAndBind({
      task,
      suffix: `draft-${member}`,
      tool: DRAFT_TOOL,
      args,
      requirementId: 'write_draft',
      withProposal: false,
      universeItemId: member,
      universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    });
    const settled = settleLocal({
      task,
      logicalToolCallId: call,
      tool: DRAFT_TOOL,
      args,
      result: { path: `drafts/${member}.md`, bytes: 128 },
      requirementId: 'write_draft',
    });
    assert.equal(settled.outcome.kind, 'succeeded', JSON.stringify(settled.outcome));
    const row = settlementRow(task, call);
    assert.equal(row?.execution_kind, 'local_execution');
    assert.ok(row?.result_handle_id, 'a local write keeps its own durable receipt');
  }

  const projected = projector.projectObservedExpectedWorkHistory({
    contract: frozenContract(task),
    finalized: true,
  });
  assert.equal(projected.status, 'ok');
  if (projected.status !== 'ok') throw new Error(projected.reason);
  assert.deepEqual(
    projected.history.operations.map((operation) => operation.outcome).sort(),
    ['succeeded', 'succeeded', 'succeeded'],
    'local work projects as observed, not failed',
  );
  assert.deepEqual(projected.history.universes.map((entry) => entry.members), [['lead-001', 'lead-002']]);

  const finalized = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  });
  assert.equal(
    finalized.status,
    'finalized',
    JSON.stringify(finalized.status === 'incomplete' ? finalized.match.gaps : finalized),
  );
  if (finalized.status !== 'finalized') throw new Error('a fully local contract did not finalize');
  assert.equal(finalized.match.status, 'complete');
  assert.deepEqual(finalized.match.gaps, []);
});

test('a local execution that threw records no crossing and stays honestly unknown', () => {
  const task = acceptLocalAction('threw');
  const args = { path: 'missing.json' };
  const call = openAndBind({
    task,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args,
    requirementId: 'read_leads',
    withProposal: true,
  });
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    thrown: new Error('ENOENT: no such file'),
    requirementId: 'read_leads',
  });
  assert.notEqual(settled.outcome.kind, 'succeeded');
  const row = settlementRow(task, call);
  assert.equal(row?.physical_crossing_count, 0, 'nothing executed, so nothing is recorded as executed');
  assert.equal(row?.host_crossing_count ?? 0, 0);
  assert.equal(row?.result_handle_id, null);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call) as { n: number }).n, 0);
});

test('a contradicted local envelope mints no evidence', () => {
  const task = acceptLocalAction('contradicted');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args,
    requirementId: 'read_leads',
    withProposal: true,
  });
  const settled = settleLocal({
    task,
    logicalToolCallId: call,
    tool: SOURCE_TOOL,
    args,
    result: { successful: false, error: 'permission denied' },
    requirementId: 'read_leads',
  });
  assert.notEqual(settled.outcome.kind, 'succeeded');
  assert.equal(settlementRow(task, call)?.result_handle_id, null);
});

test('a poisoned logical call records its FIRST cause and later readers report it', () => {
  // platform-49 (live, 2026-08-11): a scheduled workflow poisoned one logical
  // call six times a day for two days, and every reader — including the error
  // that ended the run — reported only that the call was poisoned. The check
  // that actually failed was unrecoverable from the store.
  const task = acceptLocalAction('firstcause');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args,
    requirementId: 'read_leads',
    withProposal: true,
  });

  // Settle the admitted call with a DIFFERENT contract than it was admitted
  // under — the shape a nested call settling its parent's frame produces.
  const settled = settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: call,
    },
    contract: { toolName: SOURCE_TOOL, args: { path: 'a-completely-different-file.json' } },
    execution: { kind: 'local_execution' },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: task.turn },
  });
  assert.equal(settled.status, 'conflict');
  if (settled.status !== 'conflict') throw new Error('the fixture did not conflict');
  assert.match(settled.reason, /contract conflicts with its admission/);

  const row = eventlog.openEventLog().prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call) as {
    state: string;
    conflict_reason: string | null;
  };
  assert.equal(row.state, 'conflict');
  assert.equal(row.conflict_reason, settled.reason, 'the first cause is durable, not just returned');

  // Every later reader now names that first cause instead of the poisoning.
  const authority = dispatch.logicalCallAuthorityState({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: task.acceptedTaskId,
    logicalToolCallId: call,
  });
  assert.equal(authority.status, 'conflict');
  assert.match(
    authority.status === 'conflict' ? authority.reason : '',
    /contract conflicts with its admission/,
  );

  // A second conflict must not overwrite the first cause.
  settlements.commitLogicalCallSettlement({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: call,
    },
    contract: { toolName: SOURCE_TOOL, args: { path: 'yet-another-file.json' } },
    execution: { kind: 'local_execution' },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'agents_runner', turn: task.turn },
  });
  const after = eventlog.openEventLog().prepare(`
    SELECT conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(task.sessionId, task.sourceUserSeq, call) as { conflict_reason: string | null };
  assert.equal(after.conflict_reason, row.conflict_reason, 'the FIRST cause survives later conflicts');
});

test('the execution-site migration is idempotent and preserves existing dispatch rows', () => {
  const before = eventlog.openEventLog()
    .prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number };
  assert.ok(before.n > 0, 'the fixture already wrote pre-existing dispatch rows');
  const digestOf = (): string => createHash('sha256').update(JSON.stringify(
    eventlog.openEventLog().prepare(`
      SELECT session_id, source_user_seq, logical_tool_call_id, physical_dispatch_id,
             ordinal, relation, tool_name, argument_digest, state
        FROM physical_dispatches
       ORDER BY session_id, logical_tool_call_id, ordinal
    `).all(),
  )).digest('hex');
  const beforeDigest = digestOf();

  // Return the store to its pre-migration shape, then let the migration run
  // again exactly as it would on a live store that has never seen it.
  const live = eventlog.openEventLog();
  live.exec('ALTER TABLE physical_dispatches DROP COLUMN execution_site');
  // The runner resumes from MAX(version), so a store rolled back to its
  // pre-v35 shape must lose every version at or above it.
  live.prepare('DELETE FROM schema_version WHERE version >= 35').run();
  assert.equal(
    (live.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
      .some((column) => column.name === 'execution_site'),
    false,
  );
  eventlog.closeEventLog();

  const migrated = eventlog.openEventLog();
  assert.ok(
    (migrated.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
      .some((column) => column.name === 'execution_site'),
    'the migration re-applied on an existing store',
  );
  const after = migrated.prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number };
  assert.equal(after.n, before.n, 'every pre-migration dispatch row survived');
  assert.equal(digestOf(), beforeDigest, 'no pre-migration dispatch row changed');

  // Re-opening again must be a no-op rather than a second ALTER.
  eventlog.closeEventLog();
  const reopened = eventlog.openEventLog();
  assert.equal(
    (reopened.prepare('SELECT COUNT(*) AS n FROM physical_dispatches').get() as { n: number }).n,
    before.n,
  );
  assert.equal(
    (reopened.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 35')
      .get() as { n: number }).n,
    1,
    'the migration is recorded exactly once',
  );
});

test('a store that recorded a PARTIAL earlier version is repaired, not stranded', () => {
  // The live store applied v35 from a build whose v35 did not yet add
  // conflict_reason, recorded version 35, and could therefore never receive
  // that column again — while the code shipping beside it wrote to it on every
  // poisoned call. Editing a shipped migration is a permanent no-op; the
  // correction has to be its own version.
  const live = eventlog.openEventLog();
  const rows = (live.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls').get() as { n: number }).n;
  assert.ok(rows > 0, 'the fixture already wrote logical calls');
  live.exec('ALTER TABLE logical_tool_calls DROP COLUMN conflict_reason');
  live.exec('ALTER TABLE physical_dispatches DROP COLUMN execution_site');
  live.prepare('DELETE FROM schema_version WHERE version = 36').run();
  eventlog.closeEventLog();

  const repaired = eventlog.openEventLog();
  const columns = (table: string): string[] =>
    (repaired.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
  assert.ok(columns('logical_tool_calls').includes('conflict_reason'), 'the missed column arrived');
  assert.ok(columns('physical_dispatches').includes('execution_site'), 'a partially applied version is completed');
  assert.equal(
    (repaired.prepare('SELECT COUNT(*) AS n FROM logical_tool_calls').get() as { n: number }).n,
    rows,
    'the repair preserved every row',
  );
  assert.equal(
    (repaired.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 36')
      .get() as { n: number }).n,
    1,
  );
});
