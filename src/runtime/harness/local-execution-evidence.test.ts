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

/** Open one logical call for a per-item write without binding it yet. */
function openAndBindable(task: LocalTask, suffix: string, member = 'lead-001'): string {
  const logicalToolCallId = `logical:${task.label}:${suffix}`;
  const opened = dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
    },
    tool: DRAFT_TOOL,
    args: { path: `drafts/${member}.md`, content: 'x', lead_id: member },
  });
  assert.equal(opened.status, 'inserted', JSON.stringify(opened));
  return logicalToolCallId;
}

/** Seal this task's `leads` universe from whatever its producer read settled. */
function sealFor(task: LocalTask): seals.ExpectedWorkUniverseSealResult {
  const contract = frozenContract(task);
  const universe = contract.universes.find((entry) => entry.id === 'leads');
  assert.ok(universe && universe.seal === 'complete_source_receipt');
  if (!universe || universe.seal !== 'complete_source_receipt') throw new Error('universe missing');
  return seals.sealSourceDerivedUniverse({ db: eventlog.openEventLog(), contract, universe });
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
  // The runner resumes from MAX(version), so simulating "never received v36"
  // means dropping every version at or above it — the same property this pin
  // exists to document.
  live.prepare('DELETE FROM schema_version WHERE version >= 36').run();
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

test('a host read with no completeness signal is exhausted by construction and seals', () => {
  // THE h7NEP8 WALL. A local source read settled succeeded with a durable
  // handle, but its payload carried no completeness signal — nothing says
  // "complete" when a file is simply handed back whole — so the collection
  // gate read 'unknown' and held the entire per-item lane closed while the
  // plan card said the same read was satisfied. A provider can withhold a
  // page; an in-process call cannot.
  const task = acceptLocalAction('exhausted');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    // No `complete`, no cursor, no envelope — exactly what a whole-file read
    // looks like once its records are in hand.
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }] },
    requirementId: 'read_leads',
  });
  const handle = eventlog.openEventLog().prepare(`
    SELECT completeness FROM durable_result_handles
     WHERE logical_tool_call_id = ?
  `).get(call) as { completeness: string };
  assert.equal(handle.completeness, 'unknown', 'the stored handle stays byte-faithful');

  const contract = frozenContract(task);
  const universe = contract.universes.find((entry) => entry.id === 'leads');
  assert.ok(universe && universe.seal === 'complete_source_receipt');
  if (!universe || universe.seal !== 'complete_source_receipt') throw new Error('universe missing');
  const sealed = seals.sealSourceDerivedUniverse({
    db: eventlog.openEventLog(), contract, universe,
  });
  assert.equal(sealed.status, 'sealed', JSON.stringify(sealed));
  if (sealed.status !== 'sealed') throw new Error('a whole-file host read did not seal');
  assert.deepEqual(sealed.seal.members, ['lead-001', 'lead-002']);

  // And the per-item lane actually opens: the dependency now discharges.
  const admitted = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: openAndBindable(task, 'draft-lead-001'),
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: DRAFT_TOOL,
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
});

test('a host read that hands back a continuation is still partial', () => {
  const task = acceptLocalAction('hostcursor');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    // A local tool that says it has more is believed, exactly like a provider.
    result: { records: [{ id: 'lead-001' }], next_cursor: 'page-2' },
    requirementId: 'read_leads',
  });
  const contract = frozenContract(task);
  const universe = contract.universes.find((entry) => entry.id === 'leads');
  if (!universe || universe.seal !== 'complete_source_receipt') throw new Error('universe missing');
  const sealed = seals.sealSourceDerivedUniverse({
    db: eventlog.openEventLog(), contract, universe,
  });
  assert.equal(sealed.status, 'unsealed');
  assert.match(
    sealed.status === 'unsealed' ? sealed.reason : '',
    /does not prove it exhausted its collection/,
  );
});

test('a host read of a JSON text file seals from the bytes it actually returned', () => {
  // WALL C from h7NEP8: read_file hands back the file as TEXT, so the handle's
  // own facts see a string and find no collection. The bytes ARE the records;
  // refusing there fails the model for a representation detail after it did
  // exactly the right read.
  const task = acceptLocalAction('jsontext');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    result: JSON.stringify([{ id: 'lead-001' }, { id: 'lead-002' }], null, 2),
    requirementId: 'read_leads',
  });
  const handle = eventlog.openEventLog().prepare(`
    SELECT record_path, record_count FROM durable_result_handles WHERE logical_tool_call_id = ?
  `).get(call) as { record_path: string | null; record_count: number };
  assert.equal(handle.record_path, null, 'the stored handle still sees a string');
  assert.equal(handle.record_count, 0);

  const sealed = sealFor(task);
  assert.equal(sealed.status, 'sealed', JSON.stringify(sealed));
  if (sealed.status !== 'sealed') throw new Error('a JSON text file did not seal');
  assert.deepEqual(sealed.seal.members, ['lead-001', 'lead-002']);
});

test('a host text read that is not JSON still refuses, and names the keys when a pointer misses', () => {
  const plain = acceptLocalAction('plaintext');
  const plainArgs = { path: 'notes.txt' };
  const plainCall = openAndBind({
    task: plain, suffix: 'source', tool: SOURCE_TOOL, args: plainArgs,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task: plain, logicalToolCallId: plainCall, tool: SOURCE_TOOL, args: plainArgs,
    result: 'just some notes, not a record collection',
    requirementId: 'read_leads',
  });
  const plainSeal = sealFor(plain);
  assert.equal(plainSeal.status, 'unsealed');
  assert.match(
    plainSeal.status === 'unsealed' ? plainSeal.reason : '',
    /exposes no record collection to seal/,
    'a non-JSON string refuses exactly as before — no lenient parsing',
  );

  // A frozen pointer that misses now names what the records actually carry,
  // which is the only thing that lets the model re-propose correctly.
  const cased = acceptLocalAction('casing');
  const casedArgs = { path: 'leads.json' };
  const casedCall = openAndBind({
    task: cased, suffix: 'source', tool: SOURCE_TOOL, args: casedArgs,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task: cased, logicalToolCallId: casedCall, tool: SOURCE_TOOL, args: casedArgs,
    result: JSON.stringify([{ Id: 'lead-001', company: 'Harbor & Vale LLP' }]),
    requirementId: 'read_leads',
  });
  const casedSeal = sealFor(cased);
  assert.equal(casedSeal.status, 'unsealed');
  const reason = casedSeal.status === 'unsealed' ? casedSeal.reason : '';
  assert.match(reason, /no value at member id pointer '\/id'/);
  assert.match(reason, /record keys: \/Id, \/company/, 'the refusal carries the fix as data');
});

test('the plan card cannot claim a requirement the dependency gate refuses', () => {
  // The h7NEP8 defect itself: one refusal payload carried
  // work_dependency_pending for write_draft AND a plan card saying read_leads
  // was 'satisfied'. Two readers of one question. They now derive from the
  // same discharge test, so the card can only ever agree with the gate or be
  // more conservative — never the reverse.
  const task = acceptLocalAction('agreement');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  // Settles succeeded — the CARD's old test — but hands back a continuation,
  // so the GATE's test refuses it.
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    result: { records: [{ id: 'lead-001' }], next_cursor: 'page-2' },
    requirementId: 'read_leads',
  });

  const refused = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: openAndBindable(task, 'draft-blocked'),
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: DRAFT_TOOL,
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') throw new Error('an unexhausted producer admitted work');
  const producerLine = refused.plan?.find((line) => line.requirementId === 'read_leads');
  assert.ok(producerLine, 'the refusal carries the plan card');
  assert.notEqual(
    producerLine?.state,
    'satisfied',
    'the card must never call a requirement satisfied while the gate refuses work waiting on it',
  );
  assert.equal(producerLine?.settledInstances, 0, 'a settled-but-undischarged read counts for nothing');
});

/** Stage the live shape: records keyed "Id", a contract pointing at '/id'. */
function stageCasedSource(label: string): LocalTask {
  const task = acceptLocalAction(label);
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    result: JSON.stringify([
      { Id: 'lead-001', company: 'Harbor & Vale LLP' },
      { Id: 'lead-002', company: 'Cedarline Physical Therapy' },
    ]),
    requirementId: 'read_leads',
  });
  return task;
}

function bindMember(task: LocalTask, member: string, suffix: string, amendment?: {
  universeId: string;
  memberIdPointer: string;
}) {
  return admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: openAndBindable(task, suffix, member),
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: member,
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: DRAFT_TOOL,
    args: { path: `drafts/${member}.md`, content: 'x', lead_id: member },
    ...(amendment ? { sealAmendment: amendment } : {}),
  });
}

test('a wrong member-id pointer is corrected once, in-turn, and the per-item lane opens', () => {
  // The single-turn self-correction loop: the contract froze '/id' before the
  // read that could prove it, the records carry "Id", and the turn used to die
  // there with no way back.
  const task = stageCasedSource('amend');

  const refused = bindMember(task, 'lead-001', 'draft-first');
  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') throw new Error('a wrong pointer admitted work');
  assert.equal(refused.kind, 'work_universe_unsealed');
  assert.match(refused.reason, /no value at member id pointer '\/id'/);
  assert.match(refused.reason, /record keys: \/Id, \/company/, 'the refusal carries the correction as data');

  // Same turn, one work_call, carrying the correction the refusal named.
  const amended = bindMember(task, 'lead-001', 'draft-amended', {
    universeId: 'leads',
    memberIdPointer: '/Id',
  });
  assert.equal(amended.status, 'bound', JSON.stringify(amended));
  if (amended.status !== 'bound') throw new Error('the corrected pointer did not bind');
  assert.equal(amended.binding.universeItemId, 'lead-001');

  // The correction is durable and auditable, and the seal now reports it.
  const row = eventlog.openEventLog().prepare(`
    SELECT prior_member_id_pointer, member_id_pointer, sealed_member_count
      FROM expected_work_universe_amendments
     WHERE session_id = ? AND source_user_seq = ? AND universe_id = 'leads'
  `).get(task.sessionId, task.sourceUserSeq) as {
    prior_member_id_pointer: string;
    member_id_pointer: string;
    sealed_member_count: number;
  };
  assert.deepEqual(row, {
    prior_member_id_pointer: '/id',
    member_id_pointer: '/Id',
    sealed_member_count: 2,
  });
  assert.equal(
    eventlog.listEvents(task.sessionId, { types: ['expected_work_universe_amended'] }).length,
    1,
    'the correction is one auditable event',
  );
  const sealed = sealFor(task);
  assert.equal(sealed.status, 'sealed');
  assert.deepEqual(
    sealed.status === 'sealed' ? sealed.seal.members : [],
    ['lead-001', 'lead-002'],
    'every later reader re-derives through the corrected pointer',
  );
});

test('the member-id correction is allowed exactly once, and never against evidence that fails', () => {
  const task = stageCasedSource('amend-guards');

  // A correction that does not resolve is refused with the same detail — it is
  // evidence-gated, not a free retry.
  const wrong = bindMember(task, 'lead-001', 'draft-wrong', {
    universeId: 'leads',
    memberIdPointer: '/identifier',
  });
  assert.equal(wrong.status, 'refused');
  if (wrong.status !== 'refused') throw new Error('a non-resolving correction was accepted');
  assert.match(wrong.reason, /no value at member id pointer '\/identifier'/);
  assert.match(wrong.reason, /record keys: \/Id, \/company/);
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM expected_work_universe_amendments
       WHERE session_id = ? AND source_user_seq = ?
    `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n,
    0,
    'a refused correction records nothing',
  );

  // The real correction lands and binds.
  assert.equal(
    bindMember(task, 'lead-001', 'draft-ok', { universeId: 'leads', memberIdPointer: '/Id' }).status,
    'bound',
  );

  // A SECOND correction is refused — the allowance is spent.
  const second = bindMember(task, 'lead-002', 'draft-second', {
    universeId: 'leads',
    memberIdPointer: '/company',
  });
  assert.equal(second.status, 'refused');
  if (second.status !== 'refused') throw new Error('a second correction was accepted');
  assert.match(second.reason, /already used its one member-id correction/);

  // And with a member already bound, identity cannot change underneath it.
  assert.match(second.reason, /already used its one member-id correction|bound member call/);
});

test('a compute requirement no tool ever attempted names its own way out', () => {
  // Live run 5: the model proposed a compute op for drafting, composed the
  // drafts in-model, and every write blocked for 800s behind a requirement
  // nothing would ever settle. The gate was right; it just could not say why.
  const task = acceptLocalAction('compute');
  const composedProposal = {
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
        id: 'draft_per_lead',
        effect: 'compute' as const,
        dependsOn: ['read_leads'],
        dataFrom: ['read_leads'],
        cardinality: { kind: 'each' as const, universeId: 'leads' },
      },
      {
        id: 'write_draft',
        effect: 'local_write' as const,
        dependsOn: ['read_leads', 'draft_per_lead'],
        dataFrom: ['draft_per_lead'],
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
  const args = { path: 'leads.json' };
  const sourceCall = `logical:${task.label}:source`;
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId: sourceCall,
    },
    tool: SOURCE_TOOL,
    args,
  }).status, 'inserted');
  assert.equal(admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sourceCall,
    proposal: composedProposal,
    requirementId: 'read_leads',
    tool: SOURCE_TOOL,
    args,
  }).status, 'bound');
  settleLocal({
    task, logicalToolCallId: sourceCall, tool: SOURCE_TOOL, args,
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }] },
    requirementId: 'read_leads',
  });

  const refused = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: openAndBindable(task, 'draft-blocked-compute', 'lead-001'),
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: DRAFT_TOOL,
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(refused.status, 'refused');
  if (refused.status !== 'refused') throw new Error('an undischargeable dependency admitted work');
  assert.equal(refused.kind, 'work_dependency_pending');
  assert.match(refused.reason, /dependency draft_per_lead is not durably satisfied/);
  assert.match(
    refused.reason,
    /no tool call has ever attempted this compute requirement/,
    'the refusal names the way out as data',
  );
  assert.match(refused.reason, /re-propose without the compute operation/);

  // A NON-compute dependency gets no advisory — an unsettled read may yet
  // settle, and it is not a composition problem.
  const readBlocked = acceptLocalAction('compute-negative');
  const readSource = openAndBind({
    task: readBlocked,
    suffix: 'source',
    tool: SOURCE_TOOL,
    args,
    requirementId: 'read_leads',
    withProposal: true,
  });
  assert.ok(readSource, 'the standard two-op contract froze');
  const blocked = admissionModule.admitExpectedWorkInvocation({
    sessionId: readBlocked.sessionId,
    sourceUserSeq: readBlocked.sourceUserSeq,
    logicalToolCallId: openAndBindable(readBlocked, 'draft-before-source', 'lead-001'),
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: DRAFT_TOOL,
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(blocked.status, 'refused');
  if (blocked.status !== 'refused') throw new Error('an unsettled read admitted work');
  assert.match(blocked.reason, /dependency read_leads is not durably satisfied/);
  assert.doesNotMatch(
    blocked.reason,
    /no tool call has ever attempted/,
    'a read dependency is not a composition problem and gets no compute advisory',
  );
});

test('the live count-only source shape is locked end to end', () => {
  // SHAPE FIDELITY, hand-authored rather than copied from a forensic store.
  // This is the exact production shape the count-only proof reads: five
  // records, Salesforce "Id" casing, pretty-printed JSON arriving as TEXT from
  // a whole-file host read. Every wall this wave closed is on the path between
  // those bytes and a sealed universe, so a regression in any one of them —
  // host exhaustion, the JSON-text records path, the keys detail, the single
  // amendment — surfaces here rather than in a live run.
  //
  // Unlike the other pins in this file it does NOT fail on old code by design:
  // it locks a shape that already works, so a future change cannot quietly
  // stop working for Nathan's actual records.
  const task = acceptLocalAction('liveshape');
  const args = { path: 'leads.json' };
  const call = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: call, tool: SOURCE_TOOL, args,
    result: JSON.stringify([
      { Id: 'lead-001', company: 'Harbor & Vale LLP', lastTouch: 'asked for pricing two weeks ago' },
      { Id: 'lead-002', company: 'Cedarline Physical Therapy', lastTouch: 'went quiet after the demo' },
      { Id: 'lead-003', company: 'Bright Anchor Dental', lastTouch: 'wanted a case study' },
      { Id: 'lead-004', company: 'Kestrel Roofing Co', lastTouch: 'budget freeze until this month' },
      { Id: 'lead-005', company: 'Juniper Family Law', lastTouch: 'new decision maker joined' },
    ], null, 2),
    requirementId: 'read_leads',
  });

  // The handle stays byte-faithful: a string payload exposes no collection and
  // carries no completeness signal.
  const handle = eventlog.openEventLog().prepare(`
    SELECT record_path, record_count, completeness FROM durable_result_handles
     WHERE logical_tool_call_id = ?
  `).get(call) as { record_path: string | null; record_count: number; completeness: string };
  assert.deepEqual(handle, { record_path: null, record_count: 0, completeness: 'unknown' });

  // As proposed, '/id' misses and the refusal hands back the real keys.
  const asProposed = sealFor(task);
  assert.equal(asProposed.status, 'unsealed');
  assert.match(
    asProposed.status === 'unsealed' ? asProposed.reason : '',
    /no value at member id pointer '\/id' \(record keys: \/Id, \/company, \/lastTouch\)/,
  );

  // One correction, and all five members seal from the text bytes.
  const bound = bindMember(task, 'lead-003', 'draft-live', {
    universeId: 'leads',
    memberIdPointer: '/Id',
  });
  assert.equal(bound.status, 'bound', JSON.stringify(bound));
  const sealed = sealFor(task);
  assert.equal(sealed.status, 'sealed');
  assert.deepEqual(
    sealed.status === 'sealed' ? sealed.seal.members : [],
    ['lead-001', 'lead-002', 'lead-003', 'lead-004', 'lead-005'],
  );
});

test('a discharged contract finalizes despite stray unbound bookkeeping, and still waits on its OWN work', () => {
  // Run 6 residual: five drafts provably on disk, terminal replied "I haven't
  // been able to verify the result yet." That sentence is FALLBACK_TEXT
  // (terminal-presentation-repair.ts), reachable only via
  // finalizeResolutionAgainstExpectedWork -> 'not_ready' -> needs_verification.
  // resolution-ledger's not_ready gate is CONTRACT-BLIND: it asks whether ANY
  // logical call is unsettled, not whether the ACCEPTED CONTRACT's work is.
  // This probes whether one stray open bookkeeping row is enough to make a
  // fully discharged contract unverifiable.
  const task = acceptLocalAction('terminal-stray');
  const sourceArgs = { path: 'leads.json' };
  const sourceCall = openAndBind({
    task, suffix: 'source', tool: SOURCE_TOOL, args: sourceArgs,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task, logicalToolCallId: sourceCall, tool: SOURCE_TOOL, args: sourceArgs,
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }] },
    requirementId: 'read_leads',
  });
  for (const member of ['lead-001', 'lead-002']) {
    const args = { path: `drafts/${member}.md`, content: `draft ${member}`, lead_id: member };
    const call = openAndBind({
      task, suffix: `draft-${member}`, tool: DRAFT_TOOL, args,
      requirementId: 'write_draft', withProposal: false,
      universeItemId: member,
      universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    });
    settleLocal({
      task, logicalToolCallId: call, tool: DRAFT_TOOL, args,
      result: { path: args.path, bytes: 64 }, requirementId: 'write_draft',
    });
  }

  // Every contracted requirement is discharged.
  const complete = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn,
  });
  assert.equal(complete.status, 'finalized', JSON.stringify(complete));

  // Now the probe: one stray logical call, opened and never settled, owned by
  // no requirement — the shape a discovery probe or abandoned attempt leaves.
  const strayTask = acceptLocalAction('terminal-stray-2');
  const strayArgs = { path: 'leads.json' };
  const straySource = openAndBind({
    task: strayTask, suffix: 'source', tool: SOURCE_TOOL, args: strayArgs,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task: strayTask, logicalToolCallId: straySource, tool: SOURCE_TOOL, args: strayArgs,
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }] },
    requirementId: 'read_leads',
  });
  for (const member of ['lead-001', 'lead-002']) {
    const args = { path: `drafts/${member}.md`, content: `draft ${member}`, lead_id: member };
    const call = openAndBind({
      task: strayTask, suffix: `draft-${member}`, tool: DRAFT_TOOL, args,
      requirementId: 'write_draft', withProposal: false,
      universeItemId: member,
      universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    });
    settleLocal({
      task: strayTask, logicalToolCallId: call, tool: DRAFT_TOOL, args,
      result: { path: args.path, bytes: 64 }, requirementId: 'write_draft',
    });
  }
  // The stray: opened, never settled, bound to nothing.
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId: strayTask.sessionId,
      sourceUserSeq: strayTask.sourceUserSeq,
      turn: strayTask.turn,
      acceptedTaskId: strayTask.acceptedTaskId,
      logicalToolCallId: `logical:${strayTask.label}:stray-probe`,
    },
    tool: 'list_files',
    args: { path: 'drafts' },
  }).status, 'inserted');

  const withStray = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: strayTask.sessionId, sourceUserSeq: strayTask.sourceUserSeq, turn: strayTask.turn,
  });
  assert.equal(
    withStray.status,
    'finalized',
    'a stray unbound probe must not make discharged work unverifiable',
  );

  // AND THE OTHER DIRECTION: contract-bound work still in flight still blocks.
  const inFlight = acceptLocalAction('terminal-inflight');
  const inFlightSource = openAndBind({
    task: inFlight, suffix: 'source', tool: SOURCE_TOOL, args: sourceArgs,
    requirementId: 'read_leads', withProposal: true,
  });
  settleLocal({
    task: inFlight, logicalToolCallId: inFlightSource, tool: SOURCE_TOOL, args: sourceArgs,
    result: { records: [{ id: 'lead-001' }, { id: 'lead-002' }] },
    requirementId: 'read_leads',
  });
  for (const member of ['lead-001', 'lead-002']) {
    const args = { path: `drafts/${member}.md`, content: `draft ${member}`, lead_id: member };
    const call = openAndBind({
      task: inFlight, suffix: `draft-${member}`, tool: DRAFT_TOOL, args,
      requirementId: 'write_draft', withProposal: false,
      universeItemId: member,
      universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    });
    // lead-002's write is BOUND to the contract and left unsettled.
    if (member === 'lead-001') {
      settleLocal({
        task: inFlight, logicalToolCallId: call, tool: DRAFT_TOOL, args,
        result: { path: args.path, bytes: 64 }, requirementId: 'write_draft',
      });
    }
  }
  const blocked = resolution.finalizeResolutionAgainstExpectedWork({
    sessionId: inFlight.sessionId, sourceUserSeq: inFlight.sourceUserSeq, turn: inFlight.turn,
  });
  assert.equal(blocked.status, 'not_ready', 'the task still waits on its OWN unsettled work');
  assert.match(
    blocked.status === 'not_ready' ? blocked.reason : '',
    /unsettled logical or physical work/,
  );
});
test('a carrier-serialized pre-dispatch refusal never settles as succeeded host work (live 44256)', () => {
  // The composio lane returns `[provider-dispatch:not-started:*]` as a typed
  // instance, but a work_call child receives it as `{output: "…"}` — and the
  // bare string classified as a SUCCEEDED host execution, minting a crossing
  // and a durable handle for an Apify call that never dispatched.
  const session = eventlog.createSession({
    id: `local-evidence-notstarted-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the alpha records we keep on file.' },
  });
  const task: LocalTask = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    label: `notstarted-${serial}`,
  };
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  }));
  const fixed = contracts.freezeDeterministicExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
  });
  assert.ok(fixed.status === 'fixed' || fixed.status === 'replayed');

  const refusalText = '[provider-dispatch:not-started:invalid-args] ⚠️  Operation validation '
    + 'failed before dispatch (schema check): Field: actorId — missing required field(s).';
  for (const [index, result] of [refusalText, { output: refusalText }].entries()) {
    const call = `logical:${task.label}:refusal-${index}`;
    assert.equal(dispatch.admitLogicalCall({
      identity: {
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        acceptedTaskId: task.acceptedTaskId,
        logicalToolCallId: call,
      },
      tool: 'apify_act_run_sync_get_dataset_items_get',
      args: { run_input: {} },
    }).status, 'inserted');
    const settled = settleLocal({
      task,
      logicalToolCallId: call,
      tool: 'apify_act_run_sync_get_dataset_items_get',
      args: { run_input: {} },
      result,
    });
    assert.equal(settled.outcome.kind, 'invalid_arguments', JSON.stringify(settled.outcome));
    const row = settlementRow(task, call);
    assert.equal(row?.execution_kind, 'refused_pre_dispatch', 'the refusal never counts as executed');
    assert.equal(row?.host_crossing_count ?? 0, 0, 'no crossing for a call that never started');
    assert.equal(row?.result_handle_id, null, 'a refusal string is not redeemable evidence');
  }
});
