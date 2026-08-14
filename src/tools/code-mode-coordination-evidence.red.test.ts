/**
 * Run: npx tsx --test src/tools/code-mode-coordination-evidence.red.test.ts
 *
 * RED PIN — run_tool_program is coordination; its children supply the evidence.
 *
 * The program carrier dispatches children that each cross the full harness
 * boundary and settle on their own. The invariant separates two things the
 * runtime currently conflates on the parent:
 *   - SAFETY: the carrier stays mutation-gated (children can write) — GUARDED;
 *   - EVIDENCE: the carrier owes no evidence identity of its own. Roles come
 *     from the observed CHILD operations — their settlements and their typed
 *     effects — never from the parent's registry entry.
 *
 * Today the parent claims a write evidence identity ('unknown_write' via its
 * registered sideEffect), the child telemetry the parent emits carries NO
 * typed effect at all, and a child source read that succeeded with the full
 * payload discharges nothing. These tests fail until children supply the
 * evidence.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-codemode-coordination-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-codemode-coord\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const contracts = await import('../runtime/harness/expected-work-contract.js');
const admissionModule = await import('../runtime/harness/expected-work-admission.js');
const attemptSettlement = await import('../runtime/harness/attempt-settlement.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const handles = await import('../runtime/harness/result-handle.js');
const outputFormat = await import('../runtime/harness/tool-output-format.js');
const {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
} = await import('../runtime/harness/tool-effect.js');
const { dispatchCodeModeTool, _setCodeModeToolsForTests } = await import('./code-mode-tool.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');

test.after(() => {
  _setCodeModeToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('the coordination carrier owes no evidence identity of its own — its children do', () => {
  // SAFETY stays conservative: an arbitrary program can mutate, so the carrier
  // remains mutation-gated for approval scope. That is the guard half.
  const decision = classifyRuntimeToolEffect('run_tool_program', {
    code: 'return await clem.read_file({ path: "leads.json" })',
  });
  assert.equal(decision.mutating, true, 'GUARD: the program carrier stays mutation-gated for safety');

  // EVIDENCE is a separate question with a different answer: the registry's
  // typed topology says this is control. A generic graph evidence classifier
  // intentionally cannot infer registry provenance from a tool-name string;
  // the live admission/settlement seams consume this topology decision.
  const topology = actionTopologyRoleForRuntimeCall('run_tool_program', {
    code: 'return await clem.read_file({ path: "leads.json" })',
  });
  assert.equal(
    topology,
    'control',
    'run_tool_program is coordination: only its observed child calls are business evidence',
  );
});

test('a code-mode child operation is observed with its typed effect, like every authority event', async () => {
  const sessionId = 'sess-codemode-child-effect';
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  _setCodeModeToolsForTests(new Map([
    ['read_file', {
      name: 'read_file',
      invoke: async () => ({ records: [{ id: 'lead-001' }, { id: 'lead-002' }], complete: true }),
    }],
  ]));
  try {
    await withHarnessRunContext(
      { sessionId, counter: new ToolCallsCounter(100) },
      () => dispatchCodeModeTool('read_file', { path: 'leads.json' }, sessionId, new ToolCallsCounter(100)),
    );
  } catch {
    // The dispatch result is not the subject; the durable observation is.
  } finally {
    _setCodeModeToolsForTests(null);
  }

  const called = eventlog.listEvents(sessionId, { types: ['tool_called'] })
    .find((event) => (event.data as { codeMode?: boolean; tool?: string }).codeMode === true
      && (event.data as { tool?: string }).tool === 'read_file');
  assert.ok(called, 'fixture: the child call was observed at all');
  assert.equal(
    (called!.data as { effect?: string }).effect,
    'read',
    'the child observation must carry the same typed effect the authority lane stamps '
      + '— an effect-less child event cannot feed any evidence consumer',
  );
});

// ── the end-to-end wall: a child source read that completed discharges its
//    requirement; today it discharges nothing ──

const ASK = 'Read every open lead and write a local follow-up draft file for each one.';

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

const codeModeWorkOptions = {
  workCallOptions: {
    reachableBuiltinNames: new Set(['read_file', 'write_file']),
    firstClassNames: new Set<string>(),
    deniedNames: new Set<string>(),
    mcpToolScope: null,
  },
};

function boundWorkInput(input: {
  requirementId: string;
  name: string;
  args: Record<string, unknown>;
  proposal?: unknown;
  universeItemId?: string | null;
  universeSelector?: { argument_pointer: string; member_id_pointer: string | null } | null;
}) {
  return {
    proposal: input.proposal ?? null,
    requirement_id: input.requirementId,
    universe_item_id: input.universeItemId ?? null,
    universe_selector: input.universeSelector ?? null,
    name: input.name,
    args_json: JSON.stringify(input.args),
  };
}

function dispatchBoundCodeModeWork(input: {
  sessionId: string;
  requirementId: string;
  name: string;
  args: Record<string, unknown>;
  counter?: InstanceType<typeof ToolCallsCounter>;
  universeItemId?: string | null;
  universeSelector?: { argument_pointer: string; member_id_pointer: string | null } | null;
}) {
  return dispatchCodeModeTool(
    'work',
    boundWorkInput(input),
    input.sessionId,
    input.counter,
    codeModeWorkOptions,
  );
}

test('a program child source read supplies the contract evidence its requirement needs', async () => {
  const sessionId = 'sess-codemode-child-discharge';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
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
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));

  // Freeze the contract directly (the model proposed this topology); the
  // source read itself is executed by the PROGRAM's child below, not by a
  // separate first-class work_call.
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: proposal(),
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') throw new Error('fixture contract did not prepare');
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  // The program's child read runs through the real code-mode dispatcher and
  // returns the COMPLETE source collection. Keep it above the presentation
  // cap: the program gets the parsed object, while settlement/redemption must
  // retain the exact bytes parked behind the compact digest.
  const records = Array.from({ length: 900 }, (_, index) => ({
    id: `lead-${String(index + 1).padStart(3, '0')}`,
    company: `Alpha Prospect ${index + 1}`,
    note: `Complete source record ${index + 1}`,
  }));
  const exactSourceBytes = JSON.stringify({
    successful: true,
    data: { records },
    meta: { complete: true },
  });
  assert.ok(
    exactSourceBytes.length > outputFormat.DEFAULT_TOOL_RESULT_MAX_CHARS,
    'fixture: the source must cross the model-facing digest limit',
  );
  _setCodeModeToolsForTests(new Map([
    ['read_file', {
      name: 'read_file',
      invoke: async () => outputFormat.formatRecallableToolText(exactSourceBytes),
    }],
  ]));
  let childOutcome: unknown;
  try {
    childOutcome = await withHarnessRunContext(
      { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(100) },
      () => dispatchBoundCodeModeWork({
        sessionId: task.sessionId,
        requirementId: 'read_leads',
        name: 'read_file',
        args: { path: 'leads.json' },
        counter: new ToolCallsCounter(100),
      }),
    );
  } catch (err) {
    childOutcome = { thrown: err instanceof Error ? err.message : String(err) };
  } finally {
    _setCodeModeToolsForTests(null);
  }

  const childSettlement = eventlog.listEvents(task.sessionId, { types: ['tool_attempt_settled'] })
    .map((event) => event.data as Record<string, unknown>)
    .find((data) => data.sourceUserSeq === task.sourceUserSeq && data.tool === 'read_file');
  assert.ok(
    childSettlement,
    `fixture: the code-mode child settled; child outcome ${JSON.stringify(childOutcome).slice(0, 500)}`,
  );
  const logicalToolCallId = String(childSettlement?.logicalToolCallId ?? '');
  const redeemed = handles.redeemSuccessfulSettlementResultForHost({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq),
    logicalToolCallId,
  });
  assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
  assert.equal(
    redeemed.status === 'ok' ? redeemed.value.rawPayload : null,
    exactSourceBytes,
    'host redemption must return the exact lossless source bytes, never the model-facing digest',
  );

  // TARGET: the child's completed source read is the evidence the read_leads
  // requirement named, so the dependent per-item write must now bind. Today
  // the child settlement links to no requirement and the parent carrier has
  // no discharging identity either — the per-item lane never opens.
  const acceptedTaskId = identities.acceptedTaskIdFor(task.sessionId, task.sourceUserSeq);
  const writeCall = 'logical:codemode-child:draft-lead-001';
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      turn: task.turn,
      acceptedTaskId,
      logicalToolCallId: writeCall,
    },
    tool: 'write_file',
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  }).status, 'inserted');
  const admitted = admissionModule.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: writeCall,
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: 'write_file',
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(
    admitted.status,
    'bound',
    'the completed child source read must discharge read_leads and open the per-item lane; '
      + `admission said ${JSON.stringify(admitted)}; child outcome ${JSON.stringify(childOutcome).slice(0, 300)}`,
  );
});

test('an over-cap code-mode read settles as retryable non-success and a narrowed retry satisfies the requirement', async () => {
  const sessionId = 'sess-codemode-truncated-retry';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: proposal(),
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  const rowBytes = Buffer.byteLength('lead-oversized,1\n');
  const huge = `id,value\n${'lead-oversized,1\n'.repeat(
    Math.ceil(eventlog.TOOL_OUTPUT_MAX_BYTES / rowBytes) + 10_000,
  )}`;
  assert.ok(Buffer.byteLength(huge, 'utf8') > eventlog.TOOL_OUTPUT_MAX_BYTES);
  let returned = huge;
  let executions = 0;
  _setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => {
      executions += 1;
      return outputFormat.formatRecallableToolText(returned);
    },
  }]]));
  try {
    await withHarnessRunContext(
      { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
      () => dispatchBoundCodeModeWork({
        sessionId,
        requirementId: 'read_leads',
        name: 'read_file',
        args: { path: 'leads.json', limit: 1000 },
      }),
    );
    const firstSettlement = eventlog.listEvents(sessionId, { types: ['tool_attempt_settled'] })
      .map((event) => event.data as Record<string, unknown>)
      .find((data) => data.sourceUserSeq === source.seq);
    assert.ok(firstSettlement, 'the over-cap child has one durable settlement');
    const settlementAuthority = db.prepare(`
      SELECT outcome_kind, retry_same_candidate, credited_progress, result_handle_id
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      sessionId,
      source.seq,
      String(firstSettlement?.logicalToolCallId ?? ''),
    ) as {
      outcome_kind: string;
      retry_same_candidate: number;
      credited_progress: number;
      result_handle_id: string | null;
    };
    assert.deepEqual(
      {
        outcomeKind: settlementAuthority.outcome_kind,
        retrySameCandidate: settlementAuthority.retry_same_candidate === 1,
        creditedProgress: settlementAuthority.credited_progress === 1,
        resultHandleId: settlementAuthority.result_handle_id,
      },
      {
        outcomeKind: 'invalid_arguments',
        retrySameCandidate: true,
        creditedProgress: false,
        resultHandleId: null,
      },
      'truncation is a typed, retry-authorizing non-success and can never mint result authority',
    );

    returned = JSON.stringify({
      successful: true,
      data: { records: [{ id: 'lead-001' }] },
      meta: { complete: true },
    });
    const second = await withHarnessRunContext(
      { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
      () => dispatchBoundCodeModeWork({
        sessionId,
        requirementId: 'read_leads',
        name: 'read_file',
        args: { path: 'leads.json', limit: 25 },
      }),
    );
    assert.deepEqual(second, JSON.parse(returned), 'the narrowed retry executes and returns exact data');
  } finally {
    _setCodeModeToolsForTests(null);
  }
  assert.equal(executions, 2, 'one oversized attempt and one narrowed retry reached the local tool');

  const writeCall = 'logical:codemode-truncated-retry:draft-lead-001';
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      turn: 1,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
      logicalToolCallId: writeCall,
    },
    tool: 'write_file',
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  }).status, 'inserted');
  const admitted = admissionModule.admitExpectedWorkInvocation({
    sessionId,
    sourceUserSeq: source.seq,
    logicalToolCallId: writeCall,
    proposal: null,
    requirementId: 'write_draft',
    universeItemId: 'lead-001',
    universeSelector: { argumentPointer: '/lead_id', memberIdPointer: null },
    tool: 'write_file',
    args: { path: 'drafts/lead-001.md', content: 'x', lead_id: 'lead-001' },
  });
  assert.equal(admitted.status, 'bound', JSON.stringify(admitted));
});

test('code-mode child readiness follows dependencies, never lexical requirement ids', async () => {
  const sessionId = 'sess-codemode-reverse-id-dependency';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the complete source and then write the local report.' },
  });
  const task = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1 as const,
      operations: [
        {
          id: 'z_source',
          effect: 'read' as const,
          coverage: 'complete_set' as const,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' as const },
        },
        {
          // Canonicalization sorts this before z_source; readiness must not.
          id: 'a_write',
          effect: 'local_write' as const,
          dependsOn: ['z_source'],
          dataFrom: ['z_source'],
          cardinality: { kind: 'once' as const },
        },
      ],
      universes: [],
    },
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  _setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => ({ records: [{ id: 'row-1' }], complete: true }),
  }]]));
  try {
    await withHarnessRunContext(
      { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
      () => dispatchBoundCodeModeWork({
        sessionId,
        requirementId: 'z_source',
        name: 'read_file',
        args: { path: 'source.json' },
      }),
    );
  } finally {
    _setCodeModeToolsForTests(null);
  }

  const writeCall = 'logical:explicit-dependency-write';
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
      logicalToolCallId: writeCall,
    },
    tool: 'write_file',
    args: { path: 'report.md', content: 'done' },
  }).status, 'inserted');
  const selected = admissionModule.admitExpectedWorkInvocation({
    sessionId,
    sourceUserSeq: source.seq,
    logicalToolCallId: writeCall,
    proposal: null,
    requirementId: 'a_write',
    tool: 'write_file',
    args: { path: 'report.md', content: 'done' },
  });
  assert.equal(selected.status, 'bound', JSON.stringify(selected));
});

test('plain program children cannot rely on same-effect ambiguity and leave no open logical call', async () => {
  const sessionId = 'sess-codemode-child-ambiguous';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read both account sources and then write the combined local report.' },
  });
  const task = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const ambiguousProposal = {
    version: 1 as const,
    operations: [
      { id: 'read_alpha', effect: 'read' as const, coverage: 'complete_set' as const, dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const } },
      { id: 'read_beta', effect: 'read' as const, coverage: 'complete_set' as const, dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const } },
      { id: 'write_report', effect: 'local_write' as const, dependsOn: ['read_alpha', 'read_beta'], dataFrom: ['read_alpha', 'read_beta'], cardinality: { kind: 'once' as const } },
    ],
    universes: [],
  };
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: ambiguousProposal,
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  let executed = 0;
  _setCodeModeToolsForTests(new Map([
    ['read_file', {
      name: 'read_file',
      invoke: async () => { executed += 1; return { records: [], complete: true }; },
    }],
    ['write_file', {
      name: 'write_file',
      invoke: async () => { executed += 1; return { ok: true }; },
    }],
  ]));
  try {
    await assert.rejects(
      withHarnessRunContext(
        { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
        () => dispatchCodeModeTool('read_file', { path: 'ambiguous.json' }, sessionId),
      ),
      /work_binding_required.*clem\.work/i,
    );
    await assert.rejects(
      withHarnessRunContext(
        { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
        () => dispatchCodeModeTool(
          'write_file',
          { path: 'report.md', content: 'not authorized yet' },
          sessionId,
        ),
      ),
      /work_binding_required.*clem\.work/i,
    );
  } finally {
    _setCodeModeToolsForTests(null);
  }
  assert.equal(executed, 0, 'an ambiguous or unmatched host binding never runs the child');
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).get(sessionId, source.seq) as { n: number };
  assert.equal(open.n, 0, 'a clean pre-dispatch refusal leaves no orphaned OPEN logical call');
});

test('a plain program child cannot borrow a bound parent or leave a child OPEN', async () => {
  const sessionId = 'sess-codemode-child-bound-parent';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read both account sources and then write the combined local report.' },
  });
  const task = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [
        { id: 'read_alpha', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
        { id: 'read_beta', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
        { id: 'write_report', effect: 'local_write', dependsOn: ['read_alpha', 'read_beta'], dataFrom: ['read_alpha', 'read_beta'], cardinality: { kind: 'once' } },
      ],
      universes: [],
    },
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  const parentId = 'logical:bound-parent:read-alpha';
  const parentArgs = { path: 'alpha.json' };
  assert.equal(dispatch.admitLogicalCall({
    identity: {
      sessionId,
      sourceUserSeq: source.seq,
      acceptedTaskId: identities.acceptedTaskIdFor(sessionId, source.seq),
      logicalToolCallId: parentId,
    },
    tool: 'read_file',
    args: parentArgs,
  }).status, 'inserted');
  const parentBinding = admissionModule.admitExpectedWorkInvocation({
    sessionId,
    sourceUserSeq: source.seq,
    logicalToolCallId: parentId,
    proposal: null,
    requirementId: 'read_alpha',
    tool: 'read_file',
    args: parentArgs,
  });
  assert.equal(parentBinding.status, 'bound', JSON.stringify(parentBinding));
  if (parentBinding.status !== 'bound') return;

  let executed = 0;
  _setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => { executed += 1; return { records: [], complete: true }; },
  }]]));
  try {
    await admissionModule.withExpectedWorkBinding(parentBinding.binding, () => identities.withLogicalToolCall(
      {
        sessionId,
        sourceUserSeq: source.seq,
        logicalToolCallId: parentId,
        tool: 'read_file',
        args: parentArgs,
      },
      () => assert.rejects(
        withHarnessRunContext(
          { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
          () => dispatchCodeModeTool('read_file', { path: 'ambiguous.json' }, sessionId),
        ),
        /work_binding_required.*clem\.work/i,
      ),
    ));
  } finally {
    _setCodeModeToolsForTests(null);
  }
  assert.equal(executed, 0, 'a bound parent is not wildcard authority for an ambiguous child');
  const childRows = db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
       AND logical_tool_call_id LIKE 'codemode-%'
  `).get(sessionId, source.seq) as { n: number };
  assert.equal(childRows.n, 0, 'the refusal happens before a child logical row is admitted');

  // Close the deliberately held-open fixture parent, then prove this task has no
  // orphaned authority at all.
  attemptSettlement.settleAdmittedLogicalCallPreDispatchRefusal({
    sessionId,
    sourceUserSeq: source.seq,
    logicalToolCallId: parentId,
    toolName: 'read_file',
    args: parentArgs,
    lane: 'code_mode',
    reason: 'fixture parent cleanup',
  });
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).get(sessionId, source.seq) as { n: number };
  assert.equal(open.n, 0, 'after its parent closes, the refused child has left no OPEN authority');
});

test('concurrent children racing for one once requirement execute once and settle the loser pre-dispatch', async () => {
  const sessionId = 'sess-codemode-child-once-race';
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const activated = admissionModule.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: proposal(),
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId,
    sourceUserSeq: source.seq,
    contract: prepared.contract,
  })).immediate();
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
  let executed = 0;
  _setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => {
      executed += 1;
      markFirstEntered();
      await firstGate;
      return { successful: true, data: { records: [{ id: 'lead-001' }] }, complete: true };
    },
  }]]));
  try {
    const first = withHarnessRunContext(
      { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
      () => dispatchBoundCodeModeWork({
        sessionId,
        requirementId: 'read_leads',
        name: 'read_file',
        args: { path: 'leads.json' },
      }),
    );
    await firstEntered;
    try {
      const loser = await withHarnessRunContext(
        { sessionId, sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
        () => dispatchBoundCodeModeWork({
          sessionId,
          requirementId: 'read_leads',
          name: 'read_file',
          args: { path: 'leads.json' },
        }),
      );
      assert.match(JSON.stringify(loser), /work_authority_unavailable|work_already_satisfied|open logical call/);
    } finally {
      releaseFirst();
    }
    await first;
  } finally {
    releaseFirst();
    _setCodeModeToolsForTests(null);
  }

  assert.equal(executed, 1, 'only the requirement winner reaches the tool body');
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'open'
  `).get(sessionId, source.seq) as { n: number };
  assert.equal(open.n, 0, 'the losing pre-admitted child is durably closed, not orphaned OPEN');
  const settlements = db.prepare(`
    SELECT execution_kind, outcome_kind, business_call
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY execution_kind, outcome_kind
  `).all(sessionId, source.seq);
  assert.deepEqual(settlements, [
    { execution_kind: 'local_execution', outcome_kind: 'succeeded', business_call: 1 },
    { execution_kind: 'refused_pre_dispatch', outcome_kind: 'policy_denial', business_call: 1 },
  ], 'the loser is a typed pre-dispatch business refusal; it cannot look like completed work');
});
