/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/expected-work-bypass-evidence.test.ts
 *
 * Live 2026-08-18 (sess-synthetic-001, "Find me 25 personal injury lawyers…"):
 * every read ran through the read/compute bypass — admission refused the
 * binding, the carrier dispatched anyway, and the settlement recorded no
 * requirement. The dependency oracle joined only expected_work_call_bindings,
 * so the sheet write was refused work_dependency_pending five times against
 * 55 clean settlements, the economy governor clamped, and the turn ended
 * blocked with a question instead of the deliverable.
 *
 * The contract: a clean, redeemable read settlement that NAMES the
 * requirement it served is readiness evidence for a correctable successor,
 * bound or not. Discharge stays strict (bound rows only).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-bypass-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-bypass-evidence\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./expected-work-contract.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const admission = await import('./expected-work-admission.js');
const currentCapabilities = await import('./current-capability-manifest.fixture.js');
const composioSemantics = await import('../../integrations/composio/operation-semantics.js');
// (arming handled through activateActionExpectedWork)
// const authority = await import('./accepted-task-authority.js');

const sheetFromJsonSemantics = composioSemantics.documentedComposioManifestOperationSemantics(
  'GOOGLESHEETS_SHEET_FROM_JSON',
);
const googleDocCreateSemantics = composioSemantics.documentedComposioManifestOperationSemantics(
  'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
);
assert.ok(sheetFromJsonSemantics, 'fixture requires the reviewed atomic Sheet operation');
assert.ok(googleDocCreateSemantics, 'fixture requires the reviewed Google Docs create operation');
const priorCapabilityCatalog = currentCapabilities.installCurrentCapabilityManifestFixtures([
  {
    operationId: 'FIRECRAWL_SEARCH',
    providerKind: 'composio',
    effect: 'read',
  },
  {
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'googlesheets', posture: 'create_new' },
    operationSemantics: sheetFromJsonSemantics,
  },
  {
    operationId: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'google_doc', posture: 'create_new' },
    operationSemantics: googleDocCreateSemantics,
  },
  {
    operationId: 'GMAIL_SEND_EMAIL',
    providerKind: 'composio',
    effect: 'external_write',
    operationSemantics: { version: 1, reversibility: 'irreversible' },
  },
  {
    operationId: 'OUTLOOK_SEND_EMAIL',
    providerKind: 'composio',
    effect: 'external_write',
    operationSemantics: { version: 1, reversibility: 'irreversible' },
  },
]);

test.after(() => {
  currentCapabilities.restoreCurrentCapabilityManifestFixtures(priorCapabilityCatalog);
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
  const session = eventlog.createSession({ id: `bypass-evidence-${++serial}`, kind: 'chat' });
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
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

/** The exact operation chain the live run froze: collect → refine → one
 *  reversible external write of the deliverable. */
function liveChainProposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'n5:retrieve', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'n6:retrieve', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: ['n5:retrieve'], dataFrom: ['n5:retrieve'], cardinality: { kind: 'once' as const },
      },
      {
        id: 'n7:execute', effect: 'external_write' as const, coverage: null,
        dependsOn: ['n6:retrieve'], dataFrom: ['n6:retrieve'], cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
}

/** The live reads crossed as Composio FIRECRAWL_SEARCH — a provable read. */
function readArgs() {
  return { query: 'personal injury law firms Dallas' };
}

/** A provider read that settled cleanly WITHOUT any admission binding —
 *  the exact artifact a bypass dispatch leaves behind. `requirementId`
 *  rides in the settlement recovery record, never in a binding row. */
function settleUnboundRead(input: {
  task: Task;
  id: string;
  tool: string;
  payload: unknown;
  requirementId: string;
}): void {
  const logicalToolCallId = `logical:${input.id}`;
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId,
      physicalDispatchId: `dispatch:${input.id}`,
      ordinal: 0,
    },
    tool: input.tool,
    args: readArgs(),
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun));
  if (begun.status !== 'inserted') return;
  const physSettled = dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: input.tool,
    outcome: 'returned',
  });
  assert.equal(physSettled.status, 'inserted', JSON.stringify(physSettled));
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...input.task, logicalToolCallId },
    contract: { toolName: input.tool, args: readArgs() },
    execution: { kind: 'provider_execution' },
    result: { payload: input.payload },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: {
      businessCall: true,
      mutating: false,
      requirementId: input.requirementId,
    },
    observer: { lane: 'composio', turn: input.task.turn },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
}

const SHEET_WRITE_ARGS = {
  tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
  arguments: JSON.stringify({
    title: 'PI Lawyer Prospects',
    sheet_name: 'Prospects',
    sheet_json: [{ name: 'Firm A', email: 'a@x.com' }],
  }),
};

function hostFreezeLiveChain(task: Task): void {
  const db = eventlog.openEventLog();
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: liveChainProposal(),
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    contract: prepared.contract,
  })).immediate();
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
}

function admitSheetWrite(
  task: Task,
  opts: { proposal?: ReturnType<typeof liveChainProposal> | null; attempt?: string } = {},
) {
  const logicalToolCallId = `logical:write:${serial}:${opts.attempt ?? 'first'}`;
  const opened = dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId },
    tool: 'composio_execute_tool',
    args: SHEET_WRITE_ARGS,
  });
  assert.ok(
    opened.status === 'inserted' || opened.status === 'existing',
    JSON.stringify(opened),
  );
  return admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId,
    proposal: opts.proposal ?? null,
    requirementId: 'n7:execute',
    universeItemId: null,
    universeSelector: null,
    tool: 'composio_execute_tool',
    args: SHEET_WRITE_ARGS,
  });
}

const LIVE_PROMPT =
  'Find me 25 personal injury lawyers. The best decision market contact info '
  + 'including name email and phone number. Scrape the websites give me a rundown '
  + 'of them as a firm and then lastly run a small SEO audit and put it all in a google sheet';

test('an unsatisfied read dependency still refuses the dependent write (control)', () => {
  const task = accept(LIVE_PROMPT);
  hostFreezeLiveChain(task);
  const admitted = admitSheetWrite(task);
  assert.equal(admitted.status, 'refused', JSON.stringify(admitted).slice(0, 300));
  assert.equal(
    admitted.status === 'refused' && admitted.kind,
    'work_dependency_pending',
    JSON.stringify(admitted).slice(0, 300),
  );
});

test('a clean UNBOUND read settlement naming the dependency unblocks the reversible write', () => {
  const task = accept(LIVE_PROMPT);
  // Live shape: the host deterministic planner froze the contract at turn
  // start (planner_source=deterministic); the write was then refused on the
  // pending read dependency.
  hostFreezeLiveChain(task);
  const first = admitSheetWrite(task);
  assert.equal(first.status, 'refused');
  assert.equal(first.status === 'refused' && first.kind, 'work_dependency_pending');
  // The collection then actually happened — clean provider reads with NO
  // binding rows, each naming the requirement it served (the bypass now
  // preserves that name into settlement).
  for (const id of ['n5:retrieve', 'n6:retrieve']) {
    settleUnboundRead({
      task,
      id: `read:${serial}:${id.replace(/[^a-z0-9]/gi, '')}`,
      tool: 'FIRECRAWL_SEARCH',
      payload: {
        successful: true,
        data: {
          web: [
            { title: 'Shane Mullen — Top Rated PI Lawyer McKinney TX', url: 'https://example.com/mullen' },
            { title: 'Dallas Injury Firm', url: 'https://example.com/dallas' },
          ],
        },
      },
      requirementId: id,
    });
  }
  const bindings = eventlog.openEventLog().prepare(
    'SELECT COUNT(*) AS c FROM expected_work_call_bindings WHERE session_id = ?',
  ).get(task.sessionId) as { c: number };
  assert.equal(bindings.c, 0, 'the reads must remain UNBOUND for this pin to bite');
  const retry = admitSheetWrite(task, { attempt: 'retry' });
  assert.equal(retry.status, 'bound', `write still blocked: ${JSON.stringify(retry).slice(0, 400)}`);
  assert.equal(retry.status === 'bound' && retry.binding.requirementId, 'n7:execute');
});

test('the ambient bypass scope carries the named requirement to its consumer', async () => {
  assert.equal(admission.currentUnboundWorkRequirementId(), undefined);
  const seen = admission.withUnboundWorkRequirement('n6:retrieve', () =>
    admission.currentUnboundWorkRequirementId());
  assert.equal(seen, 'n6:retrieve');
  assert.equal(admission.currentUnboundWorkRequirementId(), undefined);
});

test('heartbeat progress projects the plan oracle instead of "Still working."', async () => {
  const { composeRunProgressLine } = await import('./run-progress.js');
  const task = accept(LIVE_PROMPT);
  // No frozen plan yet → the fallback passes through untouched.
  assert.equal(
    composeRunProgressLine({ sessionId: task.sessionId, fallback: 'Still working.' }),
    'Still working.',
  );
  hostFreezeLiveChain(task);
  const first = admitSheetWrite(task);
  assert.equal(first.status, 'refused');
  const before = composeRunProgressLine({ sessionId: task.sessionId, fallback: 'Still working.' });
  assert.match(before, /plan 0\/3 steps done/, before);
  for (const id of ['n5:retrieve', 'n6:retrieve']) {
    settleUnboundRead({
      task,
      id: `hb:${serial}:${id.replace(/[^a-z0-9]/gi, '')}`,
      tool: 'FIRECRAWL_SEARCH',
      payload: {
        successful: true,
        data: { web: [{ title: 'Firm A', url: 'https://example.com/a' }] },
      },
      requirementId: id,
    });
  }
  const after = composeRunProgressLine({ sessionId: task.sessionId, fallback: 'Still working.' });
  assert.match(after, /evidence in/, after);
  assert.match(after, /steps underway/, 'evidence must advance the projected plan');
  assert.match(after, /writing the deliverable|collecting/, after);
});

test('a bounded collection reaches one atomic artifact write; later mutations stay once-only', async () => {
  const task = accept(LIVE_PROMPT);
  hostFreezeLiveChain(task);
  for (const id of ['n5:retrieve', 'n6:retrieve']) {
    settleUnboundRead({
      task,
      id: `comp:${serial}:${id.replace(/[^a-z0-9]/gi, '')}`,
      tool: 'FIRECRAWL_SEARCH',
      payload: { successful: true, data: { web: [{ title: 'Firm A', url: 'https://example.com/a' }] } },
      requirementId: id,
    });
  }
  // Current atomic doctrine: create and populate are one documented reversible
  // operation, so no second mutation needs an inferred target pointer.
  const createCallId = `logical:write:${serial}:atomic`;
  const createTool = 'GOOGLESHEETS_SHEET_FROM_JSON';
  const createInnerArgs = {
    title: 'PI Lawyer Prospects',
    sheet_name: 'Prospects',
    sheet_json: [{ name: 'Firm A', email: 'a@x.com' }],
  };
  const createCarrierArgs = {
    tool_slug: createTool,
    arguments: JSON.stringify(createInnerArgs),
  };
  assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: createCallId },
    tool: 'composio_execute_tool',
    args: createCarrierArgs,
  }).status));
  const create = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: createCallId, proposal: null, requirementId: 'n7:execute',
    universeItemId: null, universeSelector: null,
    tool: 'composio_execute_tool', args: createCarrierArgs,
  });
  assert.equal(create.status, 'bound', JSON.stringify(create).slice(0, 240));
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId: createCallId, physicalDispatchId: `dispatch:create:${serial}`, ordinal: 0 },
    tool: createTool,
    args: createInnerArgs,
  });
  assert.equal(begun.status, 'inserted', 'begin: ' + JSON.stringify(begun));
  const physCreate = dispatch.settlePhysicalDispatch({
    identity: begun.status === 'inserted' ? begun.identity : (null as never),
    tool: createTool,
    outcome: 'returned',
  });
  assert.equal(physCreate.status, 'inserted', 'phys: ' + JSON.stringify(physCreate));
  const RESOURCE_ID = '1KMzIJxLSkbhIYaIcZbmSKqaL56jQi4G47449gUSMDts';
  const settledCreate = settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: createCallId },
    contract: { toolName: createTool, args: createInnerArgs },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { spreadsheetId: RESOURCE_ID, display_url: `https://docs.google.com/spreadsheets/d/${RESOURCE_ID}/edit` } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  });
  assert.equal(settledCreate.status, 'committed', JSON.stringify(settledCreate).slice(0, 200));
  const ledger = await import('./artifact-ledger.js');
  // Bind the retained artifact using production kind/provider/create-shape
  // truth, then prove every unmanifested follow-up class remains closed.
  ledger.listRunArtifacts(task.sessionId);
  eventlog.openEventLog().prepare(`
    INSERT INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, create_shape,
       status, resource_id, source_call_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'bound', ?, ?, ?, ?)
  `).run(
    `artifact:${serial}`, task.sessionId, `scope:${serial}`, 'resource:primary', 'resource',
    'googlesheets', createTool, RESOURCE_ID, createCallId,
    new Date().toISOString(), new Date().toISOString(),
  );

  for (const [label, args] of [
    ['exact-update', {
      tool_slug: 'GOOGLESHEETS_BATCH_UPDATE',
      arguments: JSON.stringify({ spreadsheet_id: RESOURCE_ID, values: [['later']] }),
    }],
    ['same-provider-mention', {
      tool_slug: 'GOOGLESHEETS_BATCH_UPDATE',
      arguments: JSON.stringify({ spreadsheet_id: 'OTHER_SHEET_123456789', values: [[RESOURCE_ID]] }),
    }],
    ['cross-provider-mention', {
      tool_slug: 'AIRTABLE_UPDATE_RECORD',
      arguments: JSON.stringify({ base_id: 'base-1', record_id: 'rec-1', notes: RESOURCE_ID }),
    }],
    ['copy-source', {
      tool_slug: 'GOOGLEDRIVE_COPY_FILE',
      arguments: JSON.stringify({ file_id: RESOURCE_ID, name: 'copy' }),
    }],
    ['delete-target', {
      tool_slug: 'GOOGLESHEETS_DELETE_SPREADSHEET',
      arguments: JSON.stringify({ spreadsheet_id: RESOURCE_ID }),
    }],
  ] as const) {
    const followupId = `logical:write:${serial}:${label}`;
    assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId: followupId },
      tool: 'composio_execute_tool',
      args,
    }).status));
    const followup = admission.admitExpectedWorkInvocation({
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: followupId, proposal: null, requirementId: 'n7:execute',
      universeItemId: null, universeSelector: null,
      tool: 'composio_execute_tool', args,
    });
    assert.equal(
      followup.status,
      'effect_already_executed',
      `${label}: ${JSON.stringify(followup).slice(0, 240)}`,
    );
  }
});

test('seq-57579 correction: create_new posture cannot make an undocumented mutation reversible', () => {
  // Live 2026-08-18 sess-synthetic-002 seqs 57579/57620/57649/57678: the refusal's
  // own repair text said "A data_in predecessor is ready for the next read or
  // reversible write". The graph's create_new posture describes the requested
  // destination, but cannot certify an unknown selected tool's recovery path.
  const task = accept(LIVE_PROMPT);
  hostFreezeLiveChain(task);
  for (const id of ['n5:retrieve', 'n6:retrieve']) {
    settleUnboundRead({
      task,
      id: `pin57579:${serial}:${id.replace(/[^a-z0-9]/gi, '')}`,
      tool: 'FIRECRAWL_SEARCH',
      payload: { successful: true, data: { web: [{ title: 'Firm A', url: 'https://example.com/a' }] } },
      requirementId: id,
    });
  }
  // A slug the operation-semantic registry has never reviewed stays closed.
  const undocumented = {
    tool_slug: 'NOTION_CREATE_PAGE',
    arguments: JSON.stringify({ title: 'PI Lawyer Prospects' }),
  };
  const callId = `logical:write:${serial}:undocumented`;
  assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: callId },
    tool: 'composio_execute_tool', args: undocumented,
  }).status));
  const admitted = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: callId, proposal: null, requirementId: 'n7:execute',
    universeItemId: null, universeSelector: null,
    tool: 'composio_execute_tool', args: undocumented,
  });
  assert.equal(admitted.status, 'refused', JSON.stringify(admitted).slice(0, 300));
  assert.equal(admitted.status === 'refused' && admitted.kind, 'work_dependency_pending');
  // CONTROL: an irreversible send with the same evidence state still refuses.
  const sendId = `logical:write:${serial}:sendctl`;
  const sendArgs = { tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: 'x@y.com', body: 'hi' }) };
  dispatch.admitLogicalCall({ identity: { ...task, logicalToolCallId: sendId }, tool: 'composio_execute_tool', args: sendArgs });
  const send = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sendId, proposal: null, requirementId: 'n7:execute',
    universeItemId: null, universeSelector: null,
    tool: 'composio_execute_tool', args: sendArgs,
  });
  assert.equal(send.status, 'refused', JSON.stringify(send).slice(0, 200));
});

test('productive distinct reads keep flowing; only loops and writes stay capped', () => {
  // Live 2026-08-18 sess-synthetic-004 seq 58345 (work_attempt_budget_exhausted
  // after ONE clean search) → seq 58365 needs_input "my search tool only
  // allows one query per task pass… run a second pass?" — the user doing the
  // harness's budget accounting. Distinct clean reads admit up to a bounded
  // exploration ceiling; a same-args replay still resolves to the retained
  // result; the write budget is untouched.
  const task = accept(LIVE_PROMPT);
  hostFreezeLiveChain(task);
  const admitRead = (n: number, query: string) => {
    const callId = `logical:read:${serial}:explore${n}`;
    const args = { tool_slug: 'FIRECRAWL_SEARCH', arguments: JSON.stringify({ query }) };
    assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
      identity: { ...task, logicalToolCallId: callId },
      tool: 'composio_execute_tool', args,
    }).status));
    const admitted = admission.admitExpectedWorkInvocation({
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: callId, proposal: null, requirementId: 'n5:retrieve',
      universeItemId: null, universeSelector: null,
      tool: 'composio_execute_tool', args,
    });
    if (admitted.status === 'bound') {
      const begun = dispatch.beginPhysicalDispatch({
        identity: { ...task, logicalToolCallId: callId, physicalDispatchId: `dispatch:explore:${serial}:${n}`, ordinal: 0 },
        tool: 'FIRECRAWL_SEARCH',
        args: { query },
      });
      assert.equal(begun.status, 'inserted', JSON.stringify(begun).slice(0, 150));
      assert.equal(dispatch.settlePhysicalDispatch({
        identity: begun.status === 'inserted' ? begun.identity : (null as never),
        tool: 'FIRECRAWL_SEARCH',
        outcome: 'returned',
      }).status, 'inserted');
      const settled = settlements.commitLogicalCallSettlement({
        identity: { ...task, logicalToolCallId: callId },
        contract: { toolName: 'FIRECRAWL_SEARCH', args: { query } },
        execution: { kind: 'provider_execution' },
        result: { payload: { successful: true, data: { web: [{ title: `Firm ${n}`, url: `https://example.com/${n}` }] } } },
        outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
        recovery: { businessCall: true, mutating: false },
        observer: { lane: 'composio', turn: task.turn },
      });
      assert.equal(settled.status, 'committed', JSON.stringify(settled).slice(0, 150));
    }
    return admitted;
  };
  // The north-star property: distinct clean reads NEVER die into a budget
  // refusal the model must relay as a user question. Every attempt either
  // binds (more evidence flows) or resolves 'satisfied' with the stored
  // result (the requirement discharged — the model moves to the next step).
  for (let n = 1; n <= 6; n += 1) {
    const attempt = admitRead(n, `fort worth PI firm ratings variant ${n}`);
    assert.ok(
      attempt.status === 'bound' || attempt.status === 'satisfied',
      `read ${n} must keep the model moving, got: ${JSON.stringify(attempt).slice(0, 220)}`,
    );
    assert.notEqual(
      attempt.status === 'refused' ? (attempt as { kind?: string }).kind : null,
      'work_attempt_budget_exhausted',
      'a productive read must never be budget-refused before the ceiling',
    );
  }
});

test('a second DECLARED effect is its own requirement — the send never dies as already-executed', () => {
  // Live 2026-08-18 sess-synthetic-003 seq 58097: GOOGLEDOCS create succeeded and
  // the declared OUTLOOK send was refused work_effect_already_executed —
  // because the frozen contract held ONE write requirement, so the second
  // effect had nowhere legal to bind (re-proposing hit work_contract_conflict
  // at seq 58103). Two effects = two once-requirements. Sends stay strictly
  // once under their own requirement.
  const task = accept(LIVE_PROMPT);
  const twoEffect = {
    version: 1 as const,
    operations: [
      {
        id: 'n5:retrieve', effect: 'read' as const, coverage: 'complete_set' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'n7:execute', effect: 'external_write' as const, coverage: null,
        dependsOn: ['n5:retrieve'], dataFrom: ['n5:retrieve'], cardinality: { kind: 'once' as const },
      },
      {
        id: 'n8:execute', effect: 'external_write' as const, coverage: null,
        dependsOn: ['n7:execute'], dataFrom: ['n7:execute'], cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const db = eventlog.openEventLog();
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: twoEffect as never,
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared).slice(0, 300));
  if (prepared.status !== 'prepared') return;
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    contract: prepared.contract,
  })).immediate();
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen).slice(0, 200));

  settleUnboundRead({
    task, id: `two:${serial}:read`, tool: 'FIRECRAWL_SEARCH',
    payload: { successful: true, data: { web: [{ title: 'A', url: 'https://example.com/a' }] } },
    requirementId: 'n5:retrieve',
  });
  // Doc create binds and settles under n7.
  const docArgs = { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', arguments: JSON.stringify({ title: 'Attachment summary', markdown: '# hi' }) };
  const docId = `logical:write:${serial}:doc`;
  assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: docId }, tool: 'composio_execute_tool', args: docArgs,
  }).status));
  const doc = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: docId, proposal: null, requirementId: 'n7:execute',
    universeItemId: null, universeSelector: null,
    tool: 'composio_execute_tool', args: docArgs,
  });
  assert.equal(doc.status, 'bound', JSON.stringify(doc).slice(0, 300));
  const begun = dispatch.beginPhysicalDispatch({
    identity: { ...task, logicalToolCallId: docId, physicalDispatchId: `dispatch:two:${serial}:doc`, ordinal: 0 },
    tool: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', args: { title: 'Attachment summary', markdown: '# hi' },
  });
  assert.equal(begun.status, 'inserted', JSON.stringify(begun).slice(0, 150));
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.status === 'inserted' ? begun.identity : (null as never),
    tool: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', outcome: 'returned',
  }).status, 'inserted');
  assert.equal(settlements.commitLogicalCallSettlement({
    identity: { ...task, logicalToolCallId: docId },
    contract: { toolName: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', args: { title: 'Attachment summary', markdown: '# hi' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { documentId: 'doc-123', title: 'Attachment summary' } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: true },
    observer: { lane: 'composio', turn: task.turn },
  }).status, 'committed');

  // The DECLARED send admits under its OWN requirement — never already-executed.
  const sendArgs = { tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to: 'nate@x.com', body: 'doc link' }) };
  const sendId = `logical:write:${serial}:send2`;
  assert.ok(['inserted', 'existing'].includes(dispatch.admitLogicalCall({
    identity: { ...task, logicalToolCallId: sendId }, tool: 'composio_execute_tool', args: sendArgs,
  }).status));
  const send = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: sendId, proposal: null, requirementId: 'n8:execute',
    universeItemId: null, universeSelector: null,
    tool: 'composio_execute_tool', args: sendArgs,
  });
  // With its own requirement the send is no longer LIED to: seq 58097's
  // work_effect_already_executed (a false "you already sent") becomes the
  // truthful kernel sequence — the irreversible send WAITS on the doc's
  // read-back discharge (receipt/read-back before send), then admits. The
  // model's ordinary readback step satisfies that without any user message.
  assert.equal(send.status, 'refused');
  assert.equal(
    send.status === 'refused' && send.kind,
    'work_dependency_pending',
    `send must wait on the unverified doc, not die as already-executed: ${JSON.stringify(send).slice(0, 250)}`,
  );
});
