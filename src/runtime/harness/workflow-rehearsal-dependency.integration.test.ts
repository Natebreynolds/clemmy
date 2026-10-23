/** Real work_call -> workflow_test -> retained exact rehearsal -> dependency proof.
 * All model output and rehearsal completion are deterministic; no live tools run.
 * Run only through scripts/run-tests-isolated.mjs. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-rehearsal-dependency-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'machine-id'), 'machine-rehearsal-dependency\n');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');
const plans = await import('../../tools/plan-tools.js');
const workCalls = await import('../../tools/work-call.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const workflows = await import('../../memory/workflow-store.js');
const definitions = await import('../../execution/workflow-run-definition.js');
const { WORKFLOW_RUNS_DIR } = await import('../../tools/shared.js');
const { registerWorkflowRunDrainKick } = await import('../../tools/workflow-run-queue.js');
const { publishWorkflowRunTerminalForTest } = await import('../../execution/workflow-runner.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const { attachEventLogHooks } = await import('./hooks.js');
const { durableLogicalCallContract } = await import('./logical-call-contract.js');
const { proveWorkflowRehearsal } = await import('./native-revision-commit-proof.js');
const { proveWorkflowRehearsalWithPorts } = await import('./workflow-rehearsal-proof.js');
const { redeemSuccessfulSettlementResultForHost } = await import('./result-handle.js');
const { isDispatchLeaseCurrent } = await import('./dispatch-lease.js');
const { WORKFLOWS_DIR } = await import('../../memory/vault.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});
const toolCall = (callId: string, name: string, args: unknown) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
function stubModel(responses: unknown[][]) {
  let call = 0;
  return {
    async getResponse() { return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
      inputTokensDetails: [], outputTokensDetails: [] }, output: responses[Math.min(call++, responses.length - 1)], responseId: `fixture-${call}` }; },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' };
      yield { type: 'model', event: { type: 'finish', finishReason: response.output!.some((v: any) => v.type === 'function_call') ? 'tool_calls' : 'stop' } };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    },
  };
}

async function fixture() {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const slug = 'framework-test-rehearsal-dependency';
  const scriptPath = path.join(WORKFLOWS_DIR,slug,'scripts','read.mjs');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, 'export default () => ({ synthetic: true });\n');
  workflows.writeWorkflow(slug, { name: slug, description: 'Synthetic read-only rehearsal', enabled: true,
    inputs: { count: { default: ' 2 ' }, colour: { default: 'Amber' } },
    trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read the controlled fixture', sideEffect: 'read',
      deterministic: { runner: 'scripts/read.mjs' } }] });
  const session = eventlog.createSession({ id: 'framework-test-rehearsal-dependency', kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id);
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Test the saved synthetic workflow, then run it and save its summary.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) throw new Error(primed.reason);
  const names = ['workflow_test', 'workflow_run', 'write_file'];
  const search = buildScopedLocalToolSearch(new Set(names), 'work_call', undefined, undefined,
    candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: primed.planning.authority, candidates }));
  const refs = new Map<string,string>();
  for (const name of names) {
    const body = JSON.parse(String(await search.invoke(new RunContext({ sessionId: session.id }),
      JSON.stringify({ query: name, role_key: null, limit: 8, account_selection: null }))));
    const found = body.results.find((row: any) => row.name === name);
    const ref = found?.capabilityRef ?? found?.capabilityVariants?.find((v: any) => v.capabilityRef.endsWith(':create'))?.capabilityRef;
    assert.ok(ref, `${name} has a disclosed capability`);
    refs.set(name, ref);
  }
  const planTask = brackets.wrapToolForHarness(plans.buildPlanTaskTool({ planning: primed.planning }) as never);
  const workCall = brackets.wrapToolForHarness(workCalls.buildWorkCall({ requireHostPlan: true,
    reachableBuiltinNames: new Set(names), firstClassNames: new Set(), catalogIdentifiers: names,
    settlementLane: 'byo', hostPlanningReady: () => true }) as never);
  const topology = [
    { id: 'test_workflow', effect: 'local_write', coverage: null, dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
    { id: 'ordinary_run', effect: 'local_write', coverage: null, dependsOn: ['test_workflow'], dataFrom: [], cardinality: { kind: 'once' } },
    { id: 'summary_write', effect: 'local_write', coverage: null, dependsOn: ['ordinary_run'], dataFrom: [], cardinality: { kind: 'once' } },
  ];
  const plan = { preamble: 'I will test the synthetic workflow before running it.', draft: {
    criteria: ['The exact saved workflow passes its rehearsal before it runs.'], cardinality: null, destination: null,
    topology: { version: 1, operations: topology, universes: [] },
    bindings: [
      { operationId: 'test_workflow', role: 'control', capabilityRef: refs.get('workflow_test'), evidence: ['tool_result'] },
      { operationId: 'ordinary_run', role: 'control', capabilityRef: refs.get('workflow_run'), evidence: ['tool_result'] },
      { operationId: 'summary_write', role: 'destination', capabilityRef: refs.get('write_file'), evidence: ['local_commit_receipt'] },
    ], deliverables: [{ id: 'synthetic_summary', kind: 'file' }], evidenceRequirements: ['tool_result', 'local_commit_receipt'],
  } };
  const callId = 'fixture-exact-rehearsal';
  const model = stubModel([
    [toolCall('fixture-plan', 'plan_task', plan)],
    [toolCall(callId, 'work_call', { requirement_id: 'test_workflow', universe_item_id: null, universe_selector: null,
      seal_amendment: null, name: 'workflow_test', args_json: JSON.stringify({ name: slug, test_inputs: null }) })],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The rehearsal result is retained; execution is not claimed.' }] }],
  ]);
  const tools = [planTask, workCall];
  const agent = { model, tools };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: tools,
    activeToolNames: tools.map(t => t.name), policyHash: 'rehearsal-dependency-fixture-v1',
    budget: { maxUncachedTokens: 2000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 30000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error('Fixture capability universe did not seal');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  let savedRun: Record<string, any> | undefined;
  let producerError: unknown;
  const producer = setInterval(() => {
    if (savedRun || producerError) return;
    try {
      if (!readdirSync(WORKFLOW_RUNS_DIR).length) return;
      for (const name of readdirSync(WORKFLOW_RUNS_DIR)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(WORKFLOW_RUNS_DIR, name), run = JSON.parse(readFileSync(file, 'utf8'));
        if (run.workflow !== slug || run.finishedAt) continue;
        savedRun = publishWorkflowRunTerminalForTest(file, { ...run, finishedAt: new Date().toISOString(),
          rehearsal: { passed: true, definitionKey: definitions.workflowRehearsalKey(workflows.readWorkflow(slug)!.data) } },
        { workflowName: slug, outcome: 'done', detail: 'Controlled read completed; all mutation steps were only previewed.' }) as unknown as Record<string, any>;
      }
    } catch (error) { producerError = error; }
  }, 5);
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const unregister = registerWorkflowRunDrainKick(() => {});
  const runner = new EventEmitter();
  (runner as any).run = () => { throw new Error('No SDK runner or live model'); };
  const detach = attachEventLogHooks(runner, { getSessionId: () => session.id });
  let outcome;
  try {
    outcome = await brackets.withHarnessRunContext({ ...identity, runAttemptId: attempt.attemptId,
      behaviorScopeId: `${session.id}::fixture`, counter: new brackets.ToolCallsCounter(4) },
    () => hostRunRunner(runner as never, agent as never,
      [{ type: 'message', role: 'user', content: source.data.text }] as never,
      { maxTurns: 4, hostTurnEngine: 'host_v1', context: identity } as never));
  } finally { clearInterval(producer); unregister(); detach(); }
  if (producerError) throw producerError;
  assert.ok(savedRun, JSON.stringify(outcome));
  assert.equal(savedRun.terminalOutcome, 'succeeded');
  const loaded = contracts.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') throw new Error('Missing exact contract');
  const settled = eventlog.openEventLog().prepare(`SELECT outcome_kind,execution_kind,continues_requirement,requires_reconciliation FROM logical_call_settlements
    WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`).get(session.id, source.seq, callId);
  assert.deepEqual(settled, { outcome_kind: 'succeeded', execution_kind: 'local_execution', continues_requirement: 0, requires_reconciliation: 0 });
  const returned = eventlog.listEvents(session.id, { types: ['tool_returned'] }).find(e => e.data.callId === callId && e.data.accounting === 'top_level');
  assert.ok(returned?.data.inlineCreationTestDelivery, JSON.stringify({ message: 'actual top-level return seals the exact rehearsal report',
    creationSource: savedRun.creationTestSource, hasIntent: Boolean(savedRun.inlineCreationTestDelivery),
    intentCall: savedRun.inlineCreationTestDelivery?.callId,
    events: eventlog.listEvents(session.id, { types: ['tool_returned'] }).map(e => ({ seq: e.seq, call: e.data.callId,
      tool: e.data.tool, accounting: e.data.accounting, source: e.data.sourceUserSeq, hasInline: Boolean(e.data.inlineCreationTestDelivery) })) }));
  return { identity, contract: loaded.contract, callId, slug, savedRun, returned, scriptPath };
}

test('a real retained passing rehearsal discharges only its exact test dependency before ordinary-run admission', async t => {
  const f = await fixture();
  const db = eventlog.openEventLog();
  const proofInput = { ...f.identity, acceptedTaskId: f.contract.acceptedTaskId, contractId: f.contract.contractId,
    requirementId: 'test_workflow', logicalToolCallId: f.callId };
  const proof = () => proveWorkflowRehearsal(proofInput);
  assert.equal(proof().status, 'verified', JSON.stringify(proof()));
  assert.deepEqual(f.savedRun.inputs, { count: '2', colour: 'Amber' }, 'real handler applies and normalizes declared defaults');
  const runPath = path.join(WORKFLOW_RUNS_DIR,`${f.savedRun.id}.json`);
  const runBytes = readFileSync(runPath,'utf8');
  const runDamage: Array<[string,(run: any) => void]> = [
    ['unfinished', run => { delete run.finishedAt; }],
    ['failed', run => { run.terminalOutcome = 'failed'; }],
    ['cancelled', run => { run.status = 'cancelled'; run.terminalOutcome = 'cancelled'; }],
    ['failed verdict', run => { run.rehearsal.passed = false; }],
    ['wrong run identity', run => { run.id = 'other-run'; }],
    ['cross source', run => { run.creationTestSource.sourceUserSeq++; }],
    ['cross session', run => { run.creationTestSource.sessionId += '-other'; }],
    ['wrong call', run => { run.creationTestSource.logicalToolCallId += '-other'; }],
    ['changed normalized inputs', run => { run.inputs.count = '3'; }],
    ['missing defaulted inputs', run => { delete run.inputs.colour; }],
    ['wrong rehearsal source mode', run => { run.source = 'workflow_create'; }],
    ['activation requested', run => { run.activateAfterCreationTest = true; }],
    ['legacy missing call fence', run => { delete run.inlineCreationTestDelivery.callId; delete run.inlineCreationTestDelivery.logicalToolCallId; }],
    ['changed report', run => { run.reportBack.detail += ' changed'; }],
    ['non-success report', run => { run.reportBack.outcome = 'blocked'; }],
    ['wrong verdict definition', run => { run.rehearsal.definitionKey = 'a'.repeat(64); }],
    ['changed frozen definition', run => { run.workflowDefinitionSnapshot.definition.steps[0].prompt += ' changed'; }],
    ['legacy snapshot', run => { delete run.workflowDefinitionSnapshot.codeRevision; delete run.workflowDefinitionSnapshot.admissionHash; }],
    ['invalid finish time', run => { run.finishedAt = 'invalid'; }],
    ['finish precedes creation', run => { run.finishedAt = '2000-01-01T00:00:00.000Z'; }],
  ];
  for (const [label, damage] of runDamage) await t.test(label, () => {
    const changed = JSON.parse(runBytes); damage(changed); writeFileSync(runPath,JSON.stringify(changed));
    try { assert.equal(proof().status,'unverified');
      assert.equal(admission.dischargedRequirementSettlements(db,f.contract,'test_workflow').length,0); }
    finally { writeFileSync(runPath,runBytes); }
    assert.equal(proof().status,'verified','restored evidence is re-read, not cached');
  });
  const returned = f.returned!;
  const originalEvent = db.prepare('SELECT data_json,created_at FROM events WHERE id=?').get(returned.id) as {data_json:string;created_at:string};
  for (const [label, damage] of [
    ['wrong issuing parent lease', (data: any) => { data.inlineCreationTestDelivery.ownerLeaseId += '-other'; }],
    ['changed return hash', (data: any) => { data.inlineCreationTestDelivery.outputSha256 = 'a'.repeat(64); }],
    ['wrong returned run', (data: any) => { data.inlineCreationTestDelivery.receipts[0].runId = 'other-run'; }],
    ['wrong returned nonce', (data: any) => { data.inlineCreationTestDelivery.invocationNonce += '-other'; }],
  ] as Array<[string,(data:any)=>void]>) await t.test(label, () => {
    const data = JSON.parse(originalEvent.data_json); damage(data);
    db.prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(data),returned.id);
    try { assert.equal(proof().status,'unverified'); } finally {
      db.prepare('UPDATE events SET data_json=? WHERE id=?').run(originalEvent.data_json,returned.id);
    }
    assert.equal(proof().status,'verified');
  });
  for (const [label, eventId] of [['invalid returned time',returned.id],['invalid called time',returned.parentEventId!]]) await t.test(label!, () => {
    const original = db.prepare('SELECT created_at FROM events WHERE id=?').get(eventId) as {created_at:string};
    db.prepare('UPDATE events SET created_at=? WHERE id=?').run('invalid',eventId);
    try { assert.equal(proof().status,'unverified'); } finally { db.prepare('UPDATE events SET created_at=? WHERE id=?').run(original.created_at,eventId); }
  });
  await t.test('invalid settlement time', () => {
    // Settlements are immutable. Alter only this read port's returned timestamp;
    // keep the real host binding, retained result and all other evidence intact.
    const badTimeDb = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql.includes('SELECT b.tool_name,b.argument_digest,s.settled_at')) return {
          get(...args: unknown[]) { return { ...statement.get(...args) as object, settled_at: 'invalid' }; },
        };
        return statement;
      };
      return Reflect.get(target, key);
    } });
    const result = proveWorkflowRehearsalWithPorts(proofInput, { db: badTimeDb,
      loadContract: () => f.contract,
      loadSelection: identity => catalogs.loadSealedNodeBinding(identity.sessionId, identity.sourceUserSeq, identity.requirementId),
      redeem: identity => {
        const result = redeemSuccessfulSettlementResultForHost(identity);
        return result.status === 'ok' ? result : { status: 'unavailable', reason: result.reason };
      },
    });
    assert.deepEqual(result, { status: 'unverified', reason: 'rehearsal lifecycle chronology is invalid' });
    assert.equal(proof().status, 'verified');
  });
  await t.test('changed exact retained invocation', () => {
    const meta = returned.data.inlineCreationTestDelivery as {invocationNonce:string};
    const parked = eventlog.getToolOutputForInvocation(f.identity.sessionId,f.callId,meta.invocationNonce)!;
    const replace = (output:string) => eventlog.writeToolOutput({sessionId:f.identity.sessionId,callId:f.callId,tool:parked.tool,
      invocationNonce:meta.invocationNonce,output});
    replace(`${parked.output}\nchanged`);
    try { assert.equal(proof().status,'unverified'); } finally { replace(parked.output); }
    assert.equal(proof().status,'verified');
  });
  const definitionPath = workflows.readWorkflow(f.slug)!.filePath;
  const definitionBytes = readFileSync(definitionPath,'utf8');
  await t.test('changed current surface and missing current definition', () => {
    workflows.writeWorkflow(f.slug,{...workflows.readWorkflow(f.slug)!.data,description:'changed execution surface'});
    try { assert.equal(proof().status,'unverified'); } finally { writeFileSync(definitionPath,definitionBytes); }
    rmSync(definitionPath);
    try { assert.equal(proof().status,'unverified'); } finally { writeFileSync(definitionPath,definitionBytes); }
  });
  await t.test('changed external script bytes', () => {
    const bytes = readFileSync(f.scriptPath);
    writeFileSync(f.scriptPath,'export default () => ({ synthetic: false });\n');
    try { assert.equal(proof().status,'unverified'); } finally { writeFileSync(f.scriptPath,bytes); }
    assert.equal(proof().status,'verified');
  });
  await t.test('only enabled changes preserve the same execution surface', () => {
    workflows.writeWorkflow(f.slug,{...workflows.readWorkflow(f.slug)!.data,enabled:false});
    try { assert.equal(proof().status,'verified'); } finally { writeFileSync(definitionPath,definitionBytes); }
  });
  await t.test('timely child-parent return survives expiry and lease retirement', () => {
    const current = JSON.parse(runBytes), meta = returned.data.inlineCreationTestDelivery as {ownerLeaseId:string};
    assert.equal(current.inlineCreationTestDelivery.lease.parentLeaseId,meta.ownerLeaseId);
    assert.notEqual(current.inlineCreationTestDelivery.lease.leaseId,meta.ownerLeaseId);
    assert.equal(isDispatchLeaseCurrent(current.inlineCreationTestDelivery.lease), false);
    const oldNow = Date.now;
    Date.now = () => Date.parse(current.inlineCreationTestDelivery.expiresAt) + 1;
    try { assert.equal(proof().status,'verified'); } finally { Date.now = oldNow; }
  });
  await t.test('a foreign task requirement or call cannot borrow this rehearsal', () => {
    for (const change of [{sourceUserSeq:f.identity.sourceUserSeq+1},{acceptedTaskId:'other-task'},
      {contractId:'other-contract'},{requirementId:'ordinary_run'},{requirementId:'summary_write'},
      {logicalToolCallId:'other-call'}]) assert.equal(proveWorkflowRehearsal({...proofInput,...change}).status,'unverified');
  });
  const args = { name: f.slug };
  const logicalToolCallId = 'fixture-dependent-run-admission';
  // Exercise only expected-work dependency admission. No host call authority,
  // physical lease or workflow_run body is opened for this dependent node.
  const material = durableLogicalCallContract(f.contract.acceptedTaskId, 'workflow_run', args)!;
  eventlog.openEventLog().prepare(`INSERT INTO logical_tool_calls
    (session_id,source_user_seq,accepted_task_id,logical_tool_call_id,tool_name,argument_digest,raw_argument_digest,state,opened_at)
    VALUES (?,?,?,?,?,?,?,'open',?)`).run(f.identity.sessionId,f.identity.sourceUserSeq,f.contract.acceptedTaskId,
      logicalToolCallId,material.toolName,material.argumentDigest,material.argumentDigest,new Date().toISOString());
  const result = admission.admitExpectedWorkInvocation({ ...f.identity, logicalToolCallId,
    requirementId: 'ordinary_run', tool: 'workflow_run', args });
  assert.equal(result.status, 'bound', JSON.stringify(result));
  assert.equal(admission.dischargedRequirementSettlements(eventlog.openEventLog(), f.contract, 'test_workflow').length, 1);
  assert.equal(admission.dischargedRequirementSettlements(eventlog.openEventLog(), f.contract, 'ordinary_run').length, 0);
  assert.equal(admission.dischargedRequirementSettlements(eventlog.openEventLog(), f.contract, 'summary_write').length, 0);
  const dependentSettlements = eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`)
    .get(f.identity.sessionId, f.identity.sourceUserSeq, logicalToolCallId) as { n: number };
  assert.equal(dependentSettlements.n, 0, 'dependent execution body is never dispatched or settled');
});
