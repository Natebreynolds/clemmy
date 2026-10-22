/**
 * End-to-end local-planning proof for ordinary Workspace creation.
 *
 * The foreground model authors one semantic space_save requirement through
 * plan_task, then invokes it through the production work_call carrier. A
 * second invocation of that frozen once requirement must reuse/refuse durable
 * state without entering the local body again.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-space-save-work-call.integration.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-save-work-call-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-space-save-work-call\n', 'utf8');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const capabilityEnvelopes = await import('../../agents/capability-envelope.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityManifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const planTools = await import('../../tools/plan-tools.js');
const workCallTools = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const terminalPreparation = await import('./accepted-task-terminal-preparation.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const writeLearning = await import('./verified-write-capability-learning.js');
const writeCapabilityStore = await import('../../memory/verified-write-capability-store.js');
const obligationStore = await import('./obligation-store.js');
const terminalProof = await import('./terminal-publication-proof.js');
const evidenceReceipts = await import('./evidence-receipts.js');
const localWriteCommit = await import('./host-local-write-commit.js');
const store = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');
const dataStore = await import('../../spaces/data-store.js');
const workflowStore = await import('../../memory/workflow-store.js');

after(() => {
  writeCapabilityStore.closeVerifiedWriteCapabilityStoreForTests();
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  capabilityManifestStores.installCapabilityManifestStore(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{
    usage?: Record<string, unknown>;
    output?: unknown[];
    responseId?: string;
  }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = response.output ?? [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId ?? 'space-save-response',
      usage: {
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        totalTokens: Number(response.usage?.totalTokens ?? 0),
      },
      output,
    },
  } as never;
}

function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    calls: () => call,
    async getResponse() {
      const output = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
          inputTokensDetails: [],
          outputTokensDetails: [],
        },
        output,
        responseId: `space-save-response-${call}`,
      };
    },
    getStreamedResponse: testModelStream,
  };
}

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own the turn');
  };
  return runner;
}

function fileDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function indexedFileFacts(workspaceId: string): Array<{
  rel_path: string;
  content_hash: string;
  version: number;
}> {
  return workspaceDb.openWorkspaceDb().prepare(`
    SELECT rel_path, content_hash, version
      FROM workspace_files
     WHERE workspace_id = ?
       AND rel_path IN ('view/index.html', 'notes.jsonl')
     ORDER BY rel_path
  `).all(workspaceId) as Array<{ rel_path: string; content_hash: string; version: number }>;
}

/** One real local planning/dispatch fixture, shared by the authority proof
 * and argument-byte regression. Only model output is scripted. */
async function runInlineSpaceSave(options: {
  sessionId: string;
  slug: string;
  title: string;
  html: string;
  initialData: Record<string, unknown>;
  objectArguments?: boolean;
  objectInitialData?: boolean;
}) {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const session = eventlog.createSession({ id: options.sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Create one simple Workspace called ${options.title}.` },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);

  const search = buildScopedLocalToolSearch(
    new Set(['space_save']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'space_save', role_key: null, limit: 8, account_selection: null }),
  );
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = searchBody.results.find((row) => row.name === 'space_save')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:space_save:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['space_save']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['space_save'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  assert.equal(workCallTools.isHostPlanRequiredWorkCall(workCall), true);

  const { html, initialData, slug, title } = options;
  const reply = `Created the ${title} Workspace.`;
  const planArgs = {
    preamble: 'I’ll create the requested Workspace now.',
    draft: {
      criteria: ['One versioned Workspace renders the requested inline view.'],
      cardinality: null,
      destination: { posture: 'create_new', family: 'workspace', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'author_workspace',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'author_workspace',
        role: 'destination',
        capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workspace_deliverable', kind: 'workspace' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const saveArgs = {
    slug,
    title,
    objective: null,
    success_criteria: null,
    invariants: null,
    view_html: html,
    view_path: null,
    initial_data_json: options.objectInitialData ? initialData : JSON.stringify(initialData),
    data_sources: null,
    actions: null,
    reengage_triggers: null,
    reengage_guidance: null,
    origin_session_id: null,
  };
  const workArgs = {
    requirement_id: 'author_workspace',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'space_save',
    args_json: options.objectArguments ? saveArgs : JSON.stringify(saveArgs),
  };
  const replayArgs = options.objectArguments
    ? { ...workArgs, args_json: JSON.stringify({ ...saveArgs, initial_data_json: JSON.stringify(initialData) }) }
    : workArgs;
  const model = stubModel([
    [toolCall('plan-inline-workspace', 'plan_task', planArgs)],
    [toolCall('save-inline-workspace', 'work_call', workArgs)],
    [toolCall('replay-inline-workspace', 'work_call', replayArgs)],
    [textMessage(reply)],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'space-save-work-call-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) throw new Error(JSON.stringify(sealed));
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const parent = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const outcome = await brackets.withHarnessRunContext(parent, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: `Create one simple Workspace called ${title}.` }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  return { session, source, identity, capabilityRef, model, outcome, saveArgs, workArgs, replayArgs };
}

test('accepted inline space_save reaches its body once and frozen-work replay crosses zero times', async () => {
  const html = '<html><body><h1>Inline Proof</h1><p>One authoritative save.</p></body></html>';
  const initialData = {
    _mobile: {
      records: {
        items: [{
          primary: 'One complete authored artifact',
          body: 'This full body is committed with the view and manifest.',
        }],
      },
    },
  };
  const fixture = await runInlineSpaceSave({
    sessionId: 'space-save-work-call', slug: 'inline-proof', title: 'Inline Proof', html, initialData,
  });
  const { session, source, identity, capabilityRef, model, outcome } = fixture;
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Created the Inline Proof Workspace.');
  assert.equal(model.calls(), 4);
  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY rowid
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  const callResults = outcome.history
    .filter((item) => (item as { type?: string }).type === 'function_call_result')
    .map((item) => ({
      callId: (item as { callId?: unknown }).callId,
      output: (item as { output?: unknown }).output,
    }));
  const resultText = (callId: string): string => {
    const output = callResults.find((entry) => entry.callId === callId)?.output;
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
      return (output as { text: string }).text;
    }
    return '';
  };
  assert.match(resultText('plan-inline-workspace'), /"ok":true/);
  assert.match(resultText('save-inline-workspace'), /Created workspace "Inline Proof"/);
  assert.match(
    resultText('replay-inline-workspace'),
    /"disposition":"refused_pre_dispatch"/,
    'replay must be paired as a pre-dispatch refusal rather than entering space_save again',
  );
  const record = store.spaceStore.get('inline-proof');
  assert.equal(record?.version, 1, JSON.stringify({ callResults, physical }));
  assert.equal(
    readFileSync(store.resolveInSpace('inline-proof', 'view/index.html'), 'utf8'),
    html,
  );
  assert.deepEqual(dataStore.readData('inline-proof'), initialData);

  assert.equal(
    physical.filter((row) => row.tool_name === 'space_save' && row.state === 'returned').length,
    1,
    JSON.stringify(physical),
  );
  const mutationSettlements = db.prepare(`
    SELECT logical_tool_call_id, execution_kind, outcome_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    logical_tool_call_id: string;
    execution_kind: string;
    outcome_kind: string;
    physical_crossing_count: number;
  }>;
  assert.equal(
    mutationSettlements.filter((row) => row.outcome_kind === 'succeeded').length,
    1,
    JSON.stringify(mutationSettlements),
  );
  assert.deepEqual(mutationSettlements.map((row) => row.outcome_kind), [
    'succeeded',
    'policy_denial',
  ], 'the replay settles as a zero-crossing once-only refusal');
  assert.deepEqual(mutationSettlements.map((row) => ({
    id: row.logical_tool_call_id,
    execution: row.execution_kind,
    crossings: row.physical_crossing_count,
  })), [
    { id: 'save-inline-workspace', execution: 'local_execution', crossings: 0 },
    { id: 'replay-inline-workspace', execution: 'refused_pre_dispatch', crossings: 0 },
  ]);

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the Inline Proof Workspace.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const viewFile = store.resolveInSpace('inline-proof', 'view/index.html');
  const notesFile = store.resolveInSpace('inline-proof', 'notes.jsonl');
  const expectedViewDigest = fileDigest(viewFile);
  const commitFile = store.resolveInSpace(
    'inline-proof',
    localWriteCommit.HOST_LOCAL_WORKSPACE_COMMIT_BASENAME,
  );
  const expectedCommitDigest = fileDigest(commitFile);
  const writeReceipts = db.prepare(`
    SELECT receipt_id, kind, obligation, created_id, handle, provider_receipt,
           intended_digest, observed_digest
      FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY obligation
  `).all(session.id, source.seq) as Array<{
    receipt_id: string;
    kind: string;
    obligation: string;
    created_id: string;
    handle: string;
    provider_receipt: string;
    intended_digest: string | null;
    observed_digest: string | null;
  }>;
  assert.deepEqual(writeReceipts.map((row) => ({
    kind: row.kind,
      obligation: row.obligation,
      createdId: row.created_id,
      handle: row.handle,
    intendedDigest: row.intended_digest,
    observedDigest: row.observed_digest,
  })), [
    {
      kind: 'commit',
      obligation: 'commit_effect',
      createdId: 'inline-proof',
      handle: `spaces/inline-proof/${localWriteCommit.HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`,
      intendedDigest: expectedCommitDigest,
      observedDigest: expectedCommitDigest,
    },
    {
      kind: 'readback',
      obligation: 'verify_committed_readback',
      createdId: 'inline-proof',
      handle: `spaces/inline-proof/${localWriteCommit.HOST_LOCAL_WORKSPACE_COMMIT_BASENAME}`,
      intendedDigest: expectedCommitDigest,
      observedDigest: expectedCommitDigest,
    },
  ]);
  assert.ok(writeReceipts.every((row) => (
    row.provider_receipt.startsWith('[clementine:host-local-write-commit:v1] {')
  )));
  assert.deepEqual(indexedFileFacts('inline-proof'), [
    { rel_path: 'notes.jsonl', content_hash: fileDigest(notesFile), version: 1 },
    { rel_path: 'view/index.html', content_hash: expectedViewDigest, version: 1 },
  ], 'the final Space index contains the exact post-write view and note bytes');

  const terminalReplay = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the Inline Proof Workspace.',
  });
  assert.equal(terminalReplay.status, 'ready', JSON.stringify(terminalReplay));
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 2,
  'terminal replay mints zero additional receipts');

  const manifestState = obligationStore.loadManifestState(session.id, source.seq);
  assert.equal(manifestState.status, 'ok');
  if (manifestState.status !== 'ok') return;
  const exactProof = () => terminalProof.verifyAcceptedTaskTerminalProofInTransaction({
    db,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: `task:${session.id}#${source.seq}`,
    manifest: manifestState.manifest,
  });
  assert.deepEqual(exactProof(), { ok: true }, 'fixture owns a complete exact terminal proof');
  db.exec('SAVEPOINT local_write_non_host_counterexample');
  try {
    db.prepare(`
      UPDATE physical_dispatches SET execution_site = NULL
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).run(session.id, source.seq, 'save-inline-workspace');
    assert.equal(exactProof().ok, false,
      'the same marker cannot redeem when its crossing is no longer exact host execution');
  } finally {
    db.exec('ROLLBACK TO local_write_non_host_counterexample');
    db.exec('RELEASE local_write_non_host_counterexample');
  }
  db.exec('SAVEPOINT local_write_receipt_tamper_counterexample');
  try {
    db.prepare(`
      UPDATE host_write_receipts SET provider_receipt = 'tampered'
       WHERE session_id = ? AND source_user_seq = ? AND obligation = 'commit_effect'
    `).run(session.id, source.seq);
    assert.equal(exactProof().ok, false, 'tampered local receipt bytes cannot publish a terminal');
  } finally {
    db.exec('ROLLBACK TO local_write_receipt_tamper_counterexample');
    db.exec('RELEASE local_write_receipt_tamper_counterexample');
  }

  const committed = delivery.commitTurnOutcome({
    version: 2,
    id: turnOutcomes.turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Created the Inline Proof Workspace.' },
  });
  assert.equal(committed.presentation.status, 'done', JSON.stringify(committed.presentation));

  let learnedRecords: ReturnType<typeof writeCapabilityStore.matchVerifiedWriteCapabilities> = [];
  for (let tick = 0; tick < 100 && learnedRecords.length === 0; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    learnedRecords = writeCapabilityStore.matchVerifiedWriteCapabilities(
      'Create one simple Workspace called Inline Proof.',
    );
  }
  assert.equal(learnedRecords.length, 1,
    'the durable done-terminal hook writes one canonical capability-only row');
  const learnedRecord = learnedRecords[0]!;
  assert.equal(learnedRecord.bindingKind, 'local_envelope');
  assert.equal(learnedRecord.capabilityRef, capabilityRef);
  assert.ok(await writeLearning.canonicalVerifiedWriteCapability(learnedRecord));

  writeCapabilityStore.closeVerifiedWriteCapabilityStoreForTests();
  assert.equal(
    writeCapabilityStore.matchVerifiedWriteCapabilities(
      'Create one simple Workspace called Inline Proof.',
    )[0]?.recordId,
    learnedRecord.recordId,
    'the capability-only record survives a store-handle restart',
  );

  const originalResult = resultText('save-inline-workspace');
  assert.equal(localWriteCommit.hostLocalWriteCommitResultIsProven(originalResult), true);
  assert.deepEqual(dataStore.writeData('inline-proof', {
    ...initialData,
    laterLegitimateEdit: true,
  }), { ok: true, bytes: Buffer.byteLength(JSON.stringify({
    ...initialData,
    laterLegitimateEdit: true,
  }), 'utf8') });
  assert.equal(
    localWriteCommit.hostLocalWriteCommitResultIsProven(originalResult),
    false,
    'the compound receipt is a current-byte proof only until its durable issuance boundary',
  );
  assert.deepEqual(
    exactProof(),
    { ok: true },
    'a later legitimate Workspace edit cannot retroactively erase the already-settled terminal proof',
  );
  for (const receipt of writeReceipts) {
    assert.equal(
      evidenceReceipts.redeemEvidenceReceipt(session.id, receipt.receipt_id, {
        sourceUserSeq: source.seq,
      }).ok,
      true,
      'historical redemption compares the immutable issued facts, not the Workspace current generation',
    );
  }

  const approvalsBefore = db.prepare(`
    SELECT approval_id, status, resolution, consumed_at, resend_consumed_at
      FROM pending_approvals ORDER BY approval_id
  `).all();
  const nextSession = eventlog.createSession({ id: 'space-save-learned-next-turn', kind: 'chat' });
  const nextSource = eventlog.appendEvent({
    sessionId: nextSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one simple Workspace called Inline Proof.' },
  });
  const nextPlanning = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: nextSession.id,
    sourceUserSeq: nextSource.seq,
  });
  assert.equal(nextPlanning.ok, true, nextPlanning.ok ? '' : nextPlanning.reason);
  if (!nextPlanning.ok) return;
  assert.ok(nextPlanning.planning.capabilities.some((entry) => entry.id === capabilityRef),
    'a fresh turn can cite the reobserved local identity without tool_search');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(nextSession.id, nextSource.seq) as { n: number }).n, 0,
  'learning replays zero invocation');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(nextSession.id, nextSource.seq) as { n: number }).n, 0,
  'learning copies no prior receipt or destination into the fresh source');
  assert.deepEqual(db.prepare(`
    SELECT approval_id, status, resolution, consumed_at, resend_consumed_at
      FROM pending_approvals ORDER BY approval_id
  `).all(), approvalsBefore, 'planning neither inherits nor consumes an old approval');
});

test('native object space_save preserves large escaped HTML and nested data from its accepted frame, and legacy replay executes nothing', async () => {
  const title = 'Native Argument Proof';
  const slug = 'native-argument-proof';
  const literal = String.raw`"double quotes", 'single quotes', C:\fixtures\one\two, literal \n and \t, braces {"ok":true}, café é 東京 🧭`;
  const rows = Array.from({ length: 96 }, (_, index) =>
    `<tr data-row="${index}"><td>${index}</td><td>${literal}</td><td>€${index}.00 &amp; ready</td></tr>`).join('\n');
  const html = [
    '<!doctype html>', '<html lang="en"><head><meta charset="utf-8">',
    '<style>body{font-family:system-ui}td::after{content:"quoted \\\\ path"}</style></head>',
    `<body><main><h1>${title}</h1><table><tbody>${rows}</tbody></table>`,
    '<pre id="control-characters">An actual newline follows:\nthen a tab:\tend.</pre>',
    `<script type="application/json">${JSON.stringify({ literal, unicode: '\u2028\u2029', quoted: '"kept"' })}</script>`,
    '</main></body></html>',
  ].join('\n');
  // Parse this own key as JSON data, not JavaScript's object-literal
  // prototype setter. Every carrier/parser must retain it unchanged.
  const initialData = JSON.parse('{"__proto__":{"fixture":"opaque JSON data"},' + JSON.stringify({
    metadata: { literal, controls: 'first\nsecond\tthird', composed: 'é', decomposed: 'é', empty: '', present: null },
    records: Array.from({ length: 32 }, (_, index) => ({
      id: `record-${index}`, enabled: index % 2 === 0, count: index, literal,
      detail: { values: [null, false, 0, '', { nested: ['東京', '🧭', { path: String.raw`C:\fixtures\${index}` }] }] },
    })),
    _mobile: { records: { items: [{ primary: title, body: literal, fields: [{ label: 'Stage', value: 'Ready' }] }] } },
  }).slice(1)) as Record<string, unknown>;
  assert.ok(Object.hasOwn(initialData, '__proto__'));
  assert.ok(Buffer.byteLength(html, 'utf8') > 16_000 && Buffer.byteLength(html, 'utf8') <= 24_000,
    'fixture is substantial while respecting the actual Workspace view byte limit');
  const { session, source, model, outcome, saveArgs, workArgs, replayArgs } = await runInlineSpaceSave({
    sessionId: 'space-save-native-argument-proof', slug, title, html, initialData,
    objectArguments: true, objectInitialData: true,
  });
  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, `Created the ${title} Workspace.`);
  assert.equal(model.calls(), 4, 'no argument-repair round is needed for the complete native object payload');
  const record = store.spaceStore.get(slug);
  assert.ok(record, JSON.stringify({ callResults: outcome.history.filter(item =>
    (item as { type?: string }).type === 'function_call_result') }));
  assert.equal(record.version, 1, 'alternate carrier replay creates no second Workspace generation');
  const view = readFileSync(store.resolveInSpace(slug, 'view/index.html'));
  assert.ok(view.equals(Buffer.from(html, 'utf8')), 'quotes, backslashes and Unicode reach the saved view byte for byte');
  const savedData = dataStore.readData(slug);
  assert.deepEqual(savedData, initialData, 'nested native JSON preserves scalar types, controls, Unicode and own __proto__ data');
  assert.ok(Object.hasOwn(savedData, '__proto__'));
  assert.ok(readFileSync(store.resolveInSpace(slug, 'data.json')).equals(Buffer.from(JSON.stringify(initialData), 'utf8')),
    'the saved complete JSON document retains the exact once-serialized authored bytes');

  const db = eventlog.openEventLog();
  const physical = db.prepare(`SELECT tool_name, state FROM physical_dispatches
    WHERE session_id = ? AND source_user_seq = ? ORDER BY rowid`).all(session.id, source.seq) as Array<{
      tool_name: string; state: string;
    }>;
  assert.equal(physical.filter(row => row.tool_name === 'space_save' && row.state === 'returned').length, 1,
    JSON.stringify(physical));
  const settlements = db.prepare(`SELECT logical_tool_call_id, execution_kind, outcome_kind, physical_crossing_count
    FROM logical_call_settlements WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
    ORDER BY settled_at, logical_tool_call_id`).all(session.id, source.seq) as Array<{
      logical_tool_call_id: string; execution_kind: string; outcome_kind: string; physical_crossing_count: number;
    }>;
  assert.deepEqual(settlements.map(row => ({ id: row.logical_tool_call_id, outcome: row.outcome_kind })), [
    { id: 'save-inline-workspace', outcome: 'succeeded' },
    { id: 'replay-inline-workspace', outcome: 'policy_denial' },
  ], 'the same once-only requirement cannot execute again through legacy JSON text');
  assert.equal(settlements[1]!.execution_kind, 'refused_pre_dispatch');
  assert.equal(settlements[1]!.physical_crossing_count, 0);

  // Read the immutable accepted frame, not a later handler reconstruction or
  // the writable Workspace. The readable view verifies compressed histories.
  const admitted = db.prepare(`SELECT frame_history_json FROM accepted_model_batch_admissions_readable_v1
    WHERE session_id = ? AND source_user_seq = ? ORDER BY batch_ordinal`).all(session.id, source.seq) as Array<{
      frame_history_json: string;
    }>;
  const acceptedCalls = admitted.flatMap(row => JSON.parse(row.frame_history_json) as Array<{
    type?: string; callId?: string; name?: string; arguments?: string;
  }>).filter(row => row.type === 'function_call');
  const authored = acceptedCalls.filter(row => row.callId === 'save-inline-workspace');
  const replayed = acceptedCalls.filter(row => row.callId === 'replay-inline-workspace');
  assert.equal(authored.length, 1);
  assert.equal(replayed.length, 1);
  assert.equal(authored[0]!.arguments, JSON.stringify(workArgs), 'admission retains the original object carrier frame');
  assert.equal(replayed[0]!.arguments, JSON.stringify(replayArgs), 'legacy replay retains its original string carrier frame');
  const rawSave = JSON.parse(authored[0]!.arguments!) as { args_json: Record<string, unknown> };
  assert.equal(typeof rawSave.args_json, 'object');
  assert.equal(typeof rawSave.args_json.initial_data_json, 'object');
  assert.deepEqual(rawSave.args_json, saveArgs);
  assert.ok(view.equals(Buffer.from(rawSave.args_json.view_html as string, 'utf8')),
    'physical saved bytes derive from the exact accepted native frame');
  assert.deepEqual(dataStore.readData(slug), rawSave.args_json.initial_data_json,
    'saved data derives from the exact accepted nested object, without stringify drift');
  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id, sourceUserSeq: source.seq, proposedReply: `Created the ${title} Workspace.`,
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
});

test('accepted space_edit_view snapshots V1, commits and indexes V2 once, and terminal replay adds zero', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const v1 = '<html><body><h1>Edit Proof</h1><p>Status: draft</p></body></html>';
  const v2 = '<html><body><h1>Edit Proof</h1><p>Status: ready</p></body></html>';
  const viewFile = store.resolveInSpace('edit-proof', 'view/index.html');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  writeFileSync(viewFile, v1, 'utf8');
  const seeded = store.spaceStore.save({
    id: 'edit-proof',
    title: 'Edit Proof',
    status: 'active',
    viewEntry: 'view/index.html',
    dataSources: [],
    actions: [],
  });
  dataStore.appendNote('edit-proof', { text: 'Initial fixture note.', kind: 'fixture' });
  workspaceDb.indexWorkspaceRecord(seeded, {
    emitOperational: false,
    appendStateEvent: false,
    strict: true,
  });

  const session = eventlog.createSession({ id: 'space-edit-view-work-call', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Change the Edit Proof status from draft to ready.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const search = buildScopedLocalToolSearch(
    new Set(['space_edit_view']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'space_edit_view', role_key: null, limit: 8, account_selection: null }),
  );
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = searchBody.results.find((row) => row.name === 'space_edit_view')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:space_edit_view:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['space_edit_view']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['space_edit_view'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  const planArgs = {
    preamble: 'I’ll apply the requested targeted Workspace edit now.',
    draft: {
      criteria: ['The existing Workspace view reports status ready.'],
      cardinality: null,
      destination: { posture: 'named_existing', family: 'workspace', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'edit_workspace',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'edit_workspace',
        role: 'destination',
        capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workspace_revision', kind: 'workspace' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const editArgs = {
    slug: 'edit-proof',
    edits: [{ find: 'Status: draft', replace: 'Status: ready' }],
  };
  const workArgs = {
    requirement_id: 'edit_workspace',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'space_edit_view',
    args_json: JSON.stringify(editArgs),
  };
  const model = stubModel([
    [toolCall('plan-edit-workspace', 'plan_task', planArgs)],
    [toolCall('edit-workspace', 'work_call', workArgs)],
    [toolCall('replay-edit-workspace', 'work_call', workArgs)],
    [textMessage('Updated the Edit Proof Workspace status to ready.')],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'space-edit-view-work-call-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'Change the Edit Proof status from draft to ready.' }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Updated the Edit Proof Workspace status to ready.');
  assert.equal(readFileSync(viewFile, 'utf8'), v2);
  const edited = store.spaceStore.get('edit-proof');
  assert.equal(edited?.version, 2);
  assert.equal(edited?.revisions.length, 1);
  assert.equal(readFileSync(store.resolveInSpace('edit-proof', edited!.revisions[0]!.file), 'utf8'), v1,
    'V1 is snapshotted before V2 replaces the canonical view');

  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'space_edit_view'
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  assert.deepEqual(physical, [{ tool_name: 'space_edit_view', state: 'returned' }],
    'one accepted edit enters the local mutation body exactly once');
  const mutationSettlements = db.prepare(`
    SELECT outcome_kind, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    outcome_kind: string;
    execution_kind: string;
    physical_crossing_count: number;
  }>;
  assert.deepEqual(mutationSettlements, [
    { outcome_kind: 'succeeded', execution_kind: 'local_execution', physical_crossing_count: 0 },
    { outcome_kind: 'policy_denial', execution_kind: 'refused_pre_dispatch', physical_crossing_count: 0 },
  ]);

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Updated the Edit Proof Workspace status to ready.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const expectedViewDigest = fileDigest(viewFile);
  // The edit commits the view and the manifest it versions, so its receipt is
  // the Workspace bundle descriptor covering both.
  const bundleFile = store.resolveInSpace('edit-proof', '.clementine-workspace-commit.json');
  const expectedBundleDigest = fileDigest(bundleFile);
  const bundle = JSON.parse(readFileSync(bundleFile, 'utf8')) as { components: Array<{ role: string; handle: string; contentDigest: string }> };
  assert.deepEqual(
    bundle.components.map((component) => [component.role, component.handle]),
    [['manifest', 'spaces/edit-proof/space.json'], ['view', 'spaces/edit-proof/view/index.html']],
  );
  assert.equal(bundle.components[1]!.contentDigest, expectedViewDigest, 'the bundle covers the edited view bytes');
  const receipts = db.prepare(`
    SELECT kind, obligation, created_id, handle, provider_receipt,
           intended_digest, observed_digest
      FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY obligation
  `).all(session.id, source.seq) as Array<{
    kind: string;
    obligation: string;
    created_id: string;
    handle: string;
    provider_receipt: string;
    intended_digest: string | null;
    observed_digest: string | null;
  }>;
  assert.deepEqual(receipts.map((row) => ({
    kind: row.kind,
    obligation: row.obligation,
    createdId: row.created_id,
    handle: row.handle,
    intendedDigest: row.intended_digest,
    observedDigest: row.observed_digest,
  })), [
    {
      kind: 'commit',
      obligation: 'commit_effect',
      createdId: 'edit-proof',
      handle: 'spaces/edit-proof/.clementine-workspace-commit.json',
      intendedDigest: expectedBundleDigest,
      observedDigest: expectedBundleDigest,
    },
    {
      kind: 'readback',
      obligation: 'verify_committed_readback',
      createdId: 'edit-proof',
      handle: 'spaces/edit-proof/.clementine-workspace-commit.json',
      intendedDigest: expectedBundleDigest,
      observedDigest: expectedBundleDigest,
    },
  ]);
  assert.ok(receipts.every((row) => (
    row.provider_receipt.startsWith('[clementine:host-local-write-commit:v1] {')
  )));
  const notesFile = store.resolveInSpace('edit-proof', 'notes.jsonl');
  assert.deepEqual(indexedFileFacts('edit-proof'), [
    { rel_path: 'notes.jsonl', content_hash: fileDigest(notesFile), version: 1 },
    { rel_path: 'view/index.html', content_hash: expectedViewDigest, version: 2 },
  ]);
  assert.notEqual(expectedViewDigest, createHash('sha256').update(v1).digest('hex'));
  const indexedRevision = workspaceDb.openWorkspaceDb().prepare(`
    SELECT version, content_hash FROM workspace_revisions
     WHERE workspace_id = ?
  `).get('edit-proof') as { version: number; content_hash: string };
  assert.deepEqual(indexedRevision, {
    version: 1,
    content_hash: createHash('sha256').update(v1).digest('hex'),
  }, 'the revision row owns V1 while the version-2 view row owns only V2');

  const terminalReplay = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Updated the Edit Proof Workspace status to ready.',
  });
  assert.equal(terminalReplay.status, 'ready', JSON.stringify(terminalReplay));
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 2,
  'terminal replay mints zero additional receipts');
});

test('accepted space_edit_runner commits exact runner bytes once and terminal replay adds zero', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const slug = 'runner-edit-proof';
  const runnerV1 = 'process.stdout.write(JSON.stringify({ status: "draft" }));\n';
  const runnerV2 = 'process.stdout.write(JSON.stringify({ status: "ready" }));\n';
  const viewFile = store.resolveInSpace(slug, 'view/index.html');
  const runnerFile = store.resolveInSpace(slug, 'data/update-status.mjs');
  mkdirSync(path.dirname(viewFile), { recursive: true });
  mkdirSync(path.dirname(runnerFile), { recursive: true });
  writeFileSync(viewFile, '<html><body>Runner Edit Proof</body></html>', 'utf8');
  writeFileSync(runnerFile, runnerV1, 'utf8');
  const seeded = store.spaceStore.save({
    id: slug,
    title: 'Runner Edit Proof',
    status: 'active',
    viewEntry: 'view/index.html',
    dataSources: [],
    actions: [{ id: 'update-status', label: 'Update status', runner: 'update-status.mjs' }],
  });
  workspaceDb.indexWorkspaceRecord(seeded, {
    emitOperational: false,
    appendStateEvent: false,
    strict: true,
  });

  const session = eventlog.createSession({ id: 'space-edit-runner-work-call', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Change the Runner Edit Proof status runner from draft to ready.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const search = buildScopedLocalToolSearch(
    new Set(['space_edit_runner']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'space_edit_runner', role_key: null, limit: 8, account_selection: null }),
  );
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = searchBody.results.find((row) => row.name === 'space_edit_runner')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:space_edit_runner:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['space_edit_runner']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['space_edit_runner'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  const planArgs = {
    preamble: 'I’ll apply the exact reversible runner edit now.',
    draft: {
      criteria: ['The existing Workspace runner reports status ready.'],
      cardinality: null,
      destination: { posture: 'named_existing', family: 'workspace', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'edit_workspace_runner',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'edit_workspace_runner',
        role: 'destination',
        capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workspace_runner_revision', kind: 'workspace' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const editArgs = {
    slug,
    runner_path: 'update-status.mjs',
    edits: [{ find: 'status: "draft"', replace: 'status: "ready"' }],
  };
  const workArgs = {
    requirement_id: 'edit_workspace_runner',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'space_edit_runner',
    args_json: JSON.stringify(editArgs),
  };
  const model = stubModel([
    [toolCall('plan-edit-runner', 'plan_task', planArgs)],
    [toolCall('edit-runner', 'work_call', workArgs)],
    [toolCall('replay-edit-runner', 'work_call', workArgs)],
    [textMessage('Updated the Runner Edit Proof Workspace runner to ready.')],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'space-edit-runner-work-call-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'Change the Runner Edit Proof status runner from draft to ready.' }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Updated the Runner Edit Proof Workspace runner to ready.');
  assert.equal(readFileSync(runnerFile, 'utf8'), runnerV2);
  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'space_edit_runner'
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  assert.deepEqual(physical, [{ tool_name: 'space_edit_runner', state: 'returned' }],
    'the accepted runner edit enters its local mutation body exactly once');
  const mutationSettlements = db.prepare(`
    SELECT outcome_kind, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    outcome_kind: string;
    execution_kind: string;
    physical_crossing_count: number;
  }>;
  assert.deepEqual(mutationSettlements, [
    { outcome_kind: 'succeeded', execution_kind: 'local_execution', physical_crossing_count: 0 },
    { outcome_kind: 'policy_denial', execution_kind: 'refused_pre_dispatch', physical_crossing_count: 0 },
  ], 'the frozen once requirement cannot rewrite the runner on replay');

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Updated the Runner Edit Proof Workspace runner to ready.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const expectedRunnerDigest = fileDigest(runnerFile);
  const receipts = db.prepare(`
    SELECT kind, obligation, created_id, handle, provider_receipt,
           intended_digest, observed_digest
      FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY obligation
  `).all(session.id, source.seq) as Array<{
    kind: string;
    obligation: string;
    created_id: string;
    handle: string;
    provider_receipt: string;
    intended_digest: string | null;
    observed_digest: string | null;
  }>;
  assert.deepEqual(receipts.map((row) => ({
    kind: row.kind,
    obligation: row.obligation,
    createdId: row.created_id,
    handle: row.handle,
    intendedDigest: row.intended_digest,
    observedDigest: row.observed_digest,
  })), [
    {
      kind: 'commit',
      obligation: 'commit_effect',
      createdId: slug,
      handle: `spaces/${slug}/data/update-status.mjs`,
      intendedDigest: expectedRunnerDigest,
      observedDigest: expectedRunnerDigest,
    },
    {
      kind: 'readback',
      obligation: 'verify_committed_readback',
      createdId: slug,
      handle: `spaces/${slug}/data/update-status.mjs`,
      intendedDigest: expectedRunnerDigest,
      observedDigest: expectedRunnerDigest,
    },
  ]);
  assert.ok(receipts.every((row) => (
    row.provider_receipt.startsWith('[clementine:host-local-write-commit:v1] {')
  )), 'both obligations bind the exact runner commit marker');

  const terminalReplay = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Updated the Runner Edit Proof Workspace runner to ready.',
  });
  assert.equal(terminalReplay.status, 'ready', JSON.stringify(terminalReplay));
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 2,
  'terminal replay mints zero additional receipts');

  const manifestState = obligationStore.loadManifestState(session.id, source.seq);
  assert.equal(manifestState.status, 'ok');
  if (manifestState.status !== 'ok') return;
  const exactProof = () => terminalProof.verifyAcceptedTaskTerminalProofInTransaction({
    db,
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: `task:${session.id}#${source.seq}`,
    manifest: manifestState.manifest,
  });
  assert.deepEqual(exactProof(), { ok: true });
  db.exec('SAVEPOINT runner_local_write_receipt_tamper');
  try {
    db.prepare(`
      UPDATE host_write_receipts SET provider_receipt = 'tampered'
       WHERE session_id = ? AND source_user_seq = ? AND obligation = 'commit_effect'
    `).run(session.id, source.seq);
    assert.equal(exactProof().ok, false,
      'tampered runner receipt bytes cannot publish a terminal');
  } finally {
    db.exec('ROLLBACK TO runner_local_write_receipt_tamper');
    db.exec('RELEASE runner_local_write_receipt_tamper');
  }
});

test('search -> plan -> work_call reaches workflow_create once with provider-native JSON arguments', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const session = eventlog.createSession({ id: 'workflow-create-mixed-json-work-call', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one disabled manual Outlook inbox read canary.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const search = buildScopedLocalToolSearch(
    new Set(['workflow_create']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'workflow_create', role_key: null, limit: 8, account_selection: null }),
  );
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string; schema?: Record<string, unknown> }>;
  };
  const searchRow = searchBody.results.find((row) => row.name === 'workflow_create');
  assert.equal(searchRow?.capabilityRef, 'cap:local:workflow_create:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['workflow_create']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['workflow_create'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);

  const planArgs = {
    preamble: 'I’ll create the disabled manual read canary now.',
    draft: {
      criteria: ['One disabled manual workflow contains exactly one structured inbox read step.'],
      cardinality: null,
      destination: { posture: 'create_new', family: 'workflow', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'create_workflow',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'create_workflow',
        role: 'destination',
        capabilityRef: searchRow?.capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workflow_deliverable', kind: 'workflow' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const workflowArgs = {
    name: 'Outlook Scorpion Inbox Read Canary',
    description: 'Disabled manual-only canary that reads the newest inbox message without sending.',
    steps: [{
      id: 'read_latest_inbox',
      call: {
        tool: 'OUTLOOK_QUERY_EMAILS',
        args: {
          user_id: 'owner@example.com',
          folder: 'inbox',
          top: 1,
          select: ['subject', 'receivedDateTime'],
          orderby: 'receivedDateTime desc',
        },
      },
      sideEffect: 'read',
      output: {
        type: 'object',
        required_keys: ['successful', 'data'],
        non_empty: ['data', 'data.value', 'data.value.0.receivedDateTime'],
        min_items: { 'data.value': 1 },
        description: 'The newest inbox message with a received timestamp.',
      },
    }],
    allowSends: false,
  };
  const workArgs = {
    requirement_id: 'create_workflow',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'workflow_create',
    args_json: JSON.stringify(workflowArgs),
  };
  const model = stubModel([
    [toolCall('plan-workflow-canary', 'plan_task', planArgs)],
    [toolCall('create-workflow-canary', 'work_call', workArgs)],
    [textMessage('Created the disabled manual workflow canary.')],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'workflow-create-mixed-json-work-call-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 6,
      maxToolCalls: 6,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(6),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'Create one disabled manual Outlook inbox read canary.' }] as never,
    {
      maxTurns: 4,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Created the disabled manual workflow canary.');
  const saved = workflowStore.readWorkflow('outlook-scorpion-inbox-read-canary');
  assert.ok(saved, JSON.stringify(outcome.history));
  assert.equal(saved!.data.enabled, false, 'the read canary remains disabled pending its real creation test');
  assert.deepEqual(saved!.data.trigger, { manual: true });
  assert.equal(saved!.data.steps[0]?.call?.args?.top, 1);
  assert.deepEqual(saved!.data.steps[0]?.call?.args?.select, ['subject', 'receivedDateTime']);
  assert.equal(saved!.data.steps[0]?.output?.min_items?.['data.value'], 1);

  const physical = eventlog.openEventLog().prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'workflow_create'
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  assert.deepEqual(physical, [{ tool_name: 'workflow_create', state: 'returned' }],
    'the canonical deferred parser admits mixed JSON and enters the workflow handler exactly once');

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the disabled manual workflow canary.',
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const expectedContentDigest = createHash('sha256')
    .update(readFileSync(saved!.filePath))
    .digest('hex');
  const writeReceipts = eventlog.openEventLog().prepare(`
    SELECT kind, obligation, created_id, handle, provider_receipt,
           intended_digest, observed_digest
      FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY obligation
  `).all(session.id, source.seq) as Array<{
    kind: string;
    obligation: string;
    created_id: string;
    handle: string;
    provider_receipt: string;
    intended_digest: string | null;
    observed_digest: string | null;
  }>;
  assert.deepEqual(writeReceipts.map((row) => ({
    kind: row.kind,
    obligation: row.obligation,
    createdId: row.created_id,
    handle: row.handle,
    intendedDigest: row.intended_digest,
    observedDigest: row.observed_digest,
  })), [
    {
      kind: 'commit',
      obligation: 'commit_effect',
      createdId: 'outlook-scorpion-inbox-read-canary',
      handle: 'vault/00-System/workflows/outlook-scorpion-inbox-read-canary/SKILL.md',
      intendedDigest: expectedContentDigest,
      observedDigest: expectedContentDigest,
    },
    {
      kind: 'readback',
      obligation: 'verify_committed_readback',
      createdId: 'outlook-scorpion-inbox-read-canary',
      handle: 'vault/00-System/workflows/outlook-scorpion-inbox-read-canary/SKILL.md',
      intendedDigest: expectedContentDigest,
      observedDigest: expectedContentDigest,
    },
  ]);
  assert.ok(writeReceipts.every((row) => (
    row.provider_receipt.startsWith('[clementine:host-local-write-commit:v1] {')
  )), 'both proof obligations redeem against the exact host-stamped local commit identity');

  const replay = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the disabled manual workflow canary.',
  });
  assert.equal(replay.status, 'ready', JSON.stringify(replay));
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 2, 'terminal replay mints no duplicate receipt');
});

test('with a plan active, steps whose every call is refused before it runs stop the turn at the bound, saying why', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );
  const { HOST_NO_DISPATCH_STREAK_LIMIT, HOST_IDENTICAL_REFUSAL_LIMIT } = await import('./dispatch-streak.js');

  const session = eventlog.createSession({ id: 'workflow-create-refusal-streak', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one disabled manual Outlook inbox read canary.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  const search = buildScopedLocalToolSearch(
    new Set(['workflow_create']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchBody = JSON.parse(String(await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'workflow_create', role_key: null, limit: 8, account_selection: null }),
  ))) as { results: Array<{ name: string; capabilityRef?: string }> };
  const capabilityRef = searchBody.results.find((row) => row.name === 'workflow_create')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:workflow_create:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['workflow_create']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['workflow_create'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  const planArgs = {
    preamble: 'I’ll create the disabled manual read canary now.',
    draft: {
      criteria: ['One disabled manual workflow contains exactly one structured inbox read step.'],
      cardinality: null,
      destination: { posture: 'create_new', family: 'workflow', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'create_workflow', effect: 'local_write', coverage: null,
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'create_workflow', role: 'destination', capabilityRef, evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workflow_deliverable', kind: 'workflow' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  // Every attempt is a different call (its own name) whose steps are not a
  // list, so no frame repeats and every one is refused before it runs.
  const refusedAttempt = (index: number) => [toolCall(`create-broken-${index}`, 'work_call', {
    requirement_id: 'create_workflow',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'workflow_create',
    args_json: JSON.stringify({ name: `Broken Canary ${index}`, description: 'Never valid.', steps: 'not a list' }),
  })];
  const attempts = HOST_NO_DISPATCH_STREAK_LIMIT + 3;
  const model = stubModel([
    [toolCall('plan-broken-canary', 'plan_task', planArgs)],
    ...Array.from({ length: attempts }, (_, index) => refusedAttempt(index)),
    [textMessage('Created it.')],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const budget = attempts + 4;
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'workflow-create-refusal-streak-v1',
    budget: { maxUncachedTokens: 20_000, maxModelCalls: budget, maxToolCalls: budget, maxElapsedMs: 120_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(budget),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: 'Create one disabled manual Outlook inbox read canary.' }] as never,
    {
      maxTurns: budget,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  const steps = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'no_dispatch_step');
  // Every attempt is the same fault on the same operation, so the identical
  // refusal bound (d6c7f5a16, 10-20) ends the turn before the streak bound.
  assert.equal(steps.length, HOST_IDENTICAL_REFUSAL_LIMIT, JSON.stringify(outcome.terminal));
  assert.ok(HOST_IDENTICAL_REFUSAL_LIMIT < HOST_NO_DISPATCH_STREAK_LIMIT);
  assert.ok(steps.every((event) => typeof event.data.refusalDetail === 'string' && event.data.refusalDetail.length > 0),
    'each refused step records why it was refused');
  assert.match(JSON.stringify(outcome.terminal), /control_no_progress_exhausted/);
  assert.match(JSON.stringify(outcome), new RegExp(`refused_before_dispatch:repeated:${HOST_IDENTICAL_REFUSAL_LIMIT}`));
  assert.notEqual(outcome.finalOutput, 'Created it.', 'the scripted success after the bound is never reached');
  assert.equal(workflowStore.readWorkflow('broken-canary-0'), null);
});

test('accepted workflow_update commits reopened bytes once and frozen-work replay adds zero', async () => {
  eventlog.resetEventLog();
  capabilityCatalogs.installHostCapabilityCatalogFactory(
    capabilityCatalogs.createHostCapabilityCatalogFactory(),
  );
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore(),
  );

  const slug = 'workflow-update-proof';
  workflowStore.writeWorkflow(slug, {
    name: 'Workflow Update Proof',
    description: 'Before the accepted harness edit.',
    enabled: false,
    trigger: { manual: true },
    steps: [{
      id: 'summarize',
      prompt: 'Summarize the accepted records.',
      sideEffect: 'read',
    }],
  });

  const session = eventlog.createSession({ id: 'workflow-update-work-call', kind: 'chat' });
  const prompt = 'Update the existing Workflow Update Proof description to say that its harness edit was verified.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: prompt },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const search = buildScopedLocalToolSearch(
    new Set(['workflow_update']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const searchOutput = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'workflow_update', role_key: null, limit: 8, account_selection: null }),
  );
  const searchBody = JSON.parse(String(searchOutput)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = searchBody.results.find((row) => row.name === 'workflow_update')?.capabilityRef;
  assert.equal(capabilityRef, 'cap:local:workflow_update:reversible');

  const planTask = brackets.wrapToolForHarness(
    planTools.buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const workCall = brackets.wrapToolForHarness(workCallTools.buildWorkCall({
    requireHostPlan: true,
    reachableBuiltinNames: new Set(['workflow_update']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: ['workflow_update'],
    settlementLane: 'byo',
    hostPlanningReady: () => true,
  }) as never);
  const planArgs = {
    preamble: 'I’ll apply and verify the exact reversible workflow patch now.',
    draft: {
      criteria: ['The existing workflow description records that the harness edit was verified.'],
      cardinality: null,
      destination: { posture: 'named_existing', family: 'workflow', handleRequired: true },
      topology: {
        version: 1,
        operations: [{
          id: 'patch_workflow',
          effect: 'local_write',
          coverage: null,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
      bindings: [{
        operationId: 'patch_workflow',
        role: 'destination',
        capabilityRef,
        evidence: ['local_commit_receipt'],
      }],
      deliverables: [{ id: 'workflow_revision', kind: 'workflow' }],
      evidenceRequirements: ['local_commit_receipt'],
    },
  };
  const updateArgs = {
    name: 'Workflow Update Proof',
    description: 'The accepted harness edit was verified.',
  };
  const workArgs = {
    requirement_id: 'patch_workflow',
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'workflow_update',
    args_json: JSON.stringify(updateArgs),
  };
  const finalText = 'Updated Workflow Update Proof and verified its committed workflow bytes.';
  const model = stubModel([
    [toolCall('plan-workflow-update', 'plan_task', planArgs)],
    [toolCall('apply-workflow-update', 'work_call', workArgs)],
    [toolCall('replay-workflow-update', 'work_call', workArgs)],
    [textMessage(finalText)],
  ]);
  const agent = { model, tools: [planTask, workCall] };
  const tools = [planTask, workCall];
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: tools,
    activeToolNames: tools.map((entry) => entry.name),
    policyHash: 'workflow-update-work-call-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{ type: 'message', role: 'user', content: prompt }] as never,
    {
      maxTurns: 5,
      hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, finalText);
  const saved = workflowStore.readWorkflow(slug);
  assert.ok(saved);
  assert.equal(saved!.data.description, updateArgs.description);
  assert.equal(model.calls(), 4);

  const db = eventlog.openEventLog();
  const physical = db.prepare(`
    SELECT tool_name, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'workflow_update'
  `).all(session.id, source.seq) as Array<{ tool_name: string; state: string }>;
  assert.deepEqual(physical, [{ tool_name: 'workflow_update', state: 'returned' }],
    'the accepted workflow patch enters its local mutation body exactly once');
  const settlements = db.prepare(`
    SELECT outcome_kind, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    outcome_kind: string;
    execution_kind: string;
    physical_crossing_count: number;
  }>;
  assert.deepEqual(settlements, [
    { outcome_kind: 'succeeded', execution_kind: 'local_execution', physical_crossing_count: 0 },
    { outcome_kind: 'policy_denial', execution_kind: 'refused_pre_dispatch', physical_crossing_count: 0 },
  ], 'the frozen once requirement cannot apply the workflow patch twice');

  const prepared = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: finalText,
  });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const expectedDigest = fileDigest(saved!.filePath);
  const receipts = db.prepare(`
    SELECT kind, obligation, created_id, handle, intended_digest, observed_digest
      FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY obligation
  `).all(session.id, source.seq) as Array<{
    kind: string;
    obligation: string;
    created_id: string;
    handle: string;
    intended_digest: string | null;
    observed_digest: string | null;
  }>;
  assert.deepEqual(receipts.map((row) => ({
    kind: row.kind,
    obligation: row.obligation,
    createdId: row.created_id,
    handle: row.handle,
    intendedDigest: row.intended_digest,
    observedDigest: row.observed_digest,
  })), [
    {
      kind: 'commit',
      obligation: 'commit_effect',
      createdId: slug,
      handle: `vault/00-System/workflows/${slug}/SKILL.md`,
      intendedDigest: expectedDigest,
      observedDigest: expectedDigest,
    },
    {
      kind: 'readback',
      obligation: 'verify_committed_readback',
      createdId: slug,
      handle: `vault/00-System/workflows/${slug}/SKILL.md`,
      intendedDigest: expectedDigest,
      observedDigest: expectedDigest,
    },
  ]);
  const replay = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: finalText,
  });
  assert.equal(replay.status, 'ready', JSON.stringify(replay));
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n, 2,
  'terminal replay mints zero additional workflow receipts');
});
