/** WORKERS WRITE THEIR ITEM (2026-09-09). Only the child model is scripted:
 * the parent's frozen contract, delegation, the child's derived contract, the
 * real worker surface (work_call carrier), native write_file, settlement, and
 * the parent's credited plan line are all production code. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-delegated-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'worker-delegated-write-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { withLogicalToolCall } = await import('./attempt-identity.js');
const { acceptedTaskMode } = await import('./accepted-task-mode.js');
const plans = await import('./plan-artifacts.js');
const { runPacketWorkerWithHost } = await import('./worker-host-runner.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const admission = await import('./expected-work-admission.js');
const contracts = await import('./expected-work-contract.js');
const { buildWorkerAgent } = await import('../../agents/sub-agents.js');
const { getComputerTools } = await import('../../tools/computer-tools.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}


const PARENT_ASK = 'Write one concise follow-up note file for each of the two accounts in the workspace; one .txt per account.';
function parentProposal() {
  return {
    version: 1 as const,
    operations: [{
      id: 'write_note', effect: 'local_write' as const, coverage: 'accepted_set' as const,
      dependsOn: [], dataFrom: [], cardinality: { kind: 'each' as const, universeId: 'accounts' },
    }],
    universes: [{ id: 'accounts', seal: 'accepted_input' as const, members: ['account-1', 'account-2'] }],
  };
}

for (const parentKind of ['act', 'execute'] as const) test(`a delegated ${parentKind} child writes its planned item through the real carrier and the parent's plan line is credited from the child's proven settlement`, async () => { try { await run(parentKind); } catch (error) { throw new Error(error instanceof Error ? `${error.message}` : String(error)); } });
async function run(parentKind: 'act' | 'execute'): Promise<void> {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `worker-delegated-${parentKind}-parent`, kind: 'chat', userId: 'fixture-owner' });
  const targetPath = path.join(TEST_HOME, `${parentKind}-account-1-note.txt`);
  const nonce = `DELEGATED-WRITE-NONCE-${parentKind}-5531`;
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: PARENT_ASK, ...(parentKind === 'execute' ? { taskMode: { version: 1, kind: 'plan' } } : {}) } });
  if (parentKind === 'execute') {
    const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'fixture-owner', fullText: 'Write one note file per account.', readiness: 'ready', structuredPlan: { steps: [], preparedBindings: [], preparationIssues: [] } });
    const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
    source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: PARENT_ASK, taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
    plans.claimPlanExecution({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'fixture-owner', executeRef: ref });
  }
  const graph = recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } });
  assert.ok(graph);
  assert.equal((graph.data.graph as { classification: { route: string } }).classification.route, 'act', 'the parent ask is an action turn');
  const activated = admission.activateActionExpectedWork({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  const frozen = contracts.freezeActionExpectedWorkContract({ sessionId: session.id, sourceUserSeq: source.seq, proposal: parentProposal() });
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));
  const packet = {
    objective: 'Save one local text file for one account.', item: 'account-1', resolvedTools: 'write_file',
    externalMcpToolNames: null, context: `Account account-1. Save the file at ${targetPath} with content ${nonce}. Do not contact anyone.`,
    instructions: 'Save the local file for this account.', expectedOutput: 'The saved path.', intent: 'writer',
    expectedWork: { requirementId: 'write_note', universeId: 'accounts' },
  };
  let childId = '';
  let childSourceSeq = 0;
  let modelCalls = 0;
  const observedRequests: string[] = [];
  const result = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8) }, () => withLogicalToolCall({
      sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallId: `parent-${parentKind}-worker`, tool: 'run_worker', args: packet,
    }, () => runPacketWorkerWithHost({
      parentSessionId: session.id, sourceUserSeq: source.seq, input: packet, modelId: 'gpt-5.6-terra', maxTurns: 4, mcpToolScope: null,
      buildAgent: async (child) => {
        childId = child.sessionId;
        childSourceSeq = child.sourceUserSeq;
        assert.notEqual(childId, session.id);
        // A delegated child of an execute parent keeps execute authority for
        // its one item — no plan ceiling; the derived contract bounds it.
        assert.equal(acceptedTaskMode(childId, childSourceSeq), undefined, 'a delegated child is not plan-stamped');
        assert.ok(child.delegatedExpectedWork, 'the host proved the delegation from the parent contract');
        const built = await buildWorkerAgent({ sessionId: childId, sourceUserSeq: childSourceSeq, workerInput: packet as never, model: 'gpt-5.6-terra', mcpToolScope: null, delegatedExpectedWork: true, ...(child.hostFreshPlanning ? { hostFreshPlanning: child.hostFreshPlanning } : {}) });
        const names = (built.tools as Array<{ name?: string }>).map((t) => t.name ?? '');
        assert.ok(names.includes('work_call') && names.includes('plan_task') && names.includes('tool_search'), `the delegated child carries the planning surface: ${names.join(',')}`);
        assert.equal(names.includes('write_file'), false, 'business tools stay behind the carrier');
        const model = {
          async getResponse(request: unknown) {
            observedRequests.push(JSON.stringify(request));
            modelCalls += 1;
            const output = modelCalls === 1
              ? [{ type: 'function_call', callId: 'child-discover-write', name: 'tool_search', arguments: JSON.stringify({ query: 'write_file save a local text file', limit: 3, cursor: null, account_selection: null, role_key: null }) }]
              : modelCalls === 2
              ? [{ type: 'function_call', callId: 'child-plan-item', name: 'plan_task', arguments: JSON.stringify({
                  preamble: 'Saving one local note file for account-1; no contact will be made.',
                  draft: {
                    bindings: [{ capabilityRef: 'cap:local:write_file:create', operationId: 'write_note', role: 'note_writer', evidence: ['payload', 'local_commit_receipt'] }],
                    cardinality: { count: 1, fields: ['Id'], locator: null },
                    criteria: ['One local text file for account-1 at the packet path with the packet content'],
                    deliverables: [{ id: 'note', kind: 'text_file' }],
                    destination: { family: 'notes', handleRequired: false, posture: 'create_new' },
                    evidenceRequirements: ['payload', 'local_commit_receipt'],
                    topology: { version: 1, operations: [{ id: 'write_note', effect: 'local_write', coverage: 'accepted_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'each', universeId: 'accounts' } }],
                      universes: [{ id: 'accounts', seal: 'accepted_input', members: ['account-1'] }] },
                  },
                }) }]
              : modelCalls === 3
              ? [{ type: 'function_call', callId: 'child-delegated-write', name: 'work_call', arguments: JSON.stringify({
                  requirement_id: 'write_note', universe_item_id: 'account-1', universe_selector: null,
                  seal_amendment: null, source_call_ids: null, source_record_ids: null,
                  name: 'write_file', args_json: JSON.stringify({ path: targetPath, content: nonce, mode: 'create' }),
                }) }]
              : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Wrote ${targetPath}.` }] }];
            return { responseId: `delegated-child-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
          }, getStreamedResponse: modelStream,
        };
        // The real builder sealed the child's capability universe (business
        // tools reachable only as work_call inner targets); only the model is
        // replaced.
        (built as unknown as { model: unknown }).model = model;
        return built as never;
      },
    })));
  const db = eventlog.openEventLog();
  const childSettlements = db.prepare('SELECT logical_tool_call_id, execution_kind, outcome_kind, outcome_detail FROM logical_call_settlements WHERE session_id = ? ORDER BY logical_tool_call_id').all(childId) as Array<Record<string, unknown>>;
  assert.equal(existsSync(targetPath), true, 'the child wrote its item');
  assert.equal(modelCalls, 4, result);
  assert.ok(childSettlements.some((row) => row.outcome_kind === 'succeeded' && row.execution_kind === 'local_execution'), 'the child settled its write');
  const childSource = eventlog.listEvents(childId, { types: ['user_input_received'] })[0]!;
  assert.equal((childSource.data.delegatedWorker as Record<string, unknown>).authority, 'delegated_item');
  assert.equal(eventlog.listEvents(session.id, { types: ['expected_work_delegated'] }).length, 1, 'delegation recorded on the parent');
  const credited = eventlog.listEvents(session.id, { types: ['expected_work_delegated_discharge'] });
  assert.equal(credited.length, 1, 'the parent line is credited from the child\'s proven settlement');
  const lines = admission.expectedWorkPlanLines({ sessionId: session.id, sourceUserSeq: source.seq });
  const line = lines.find((entry) => entry.requirementId === 'write_note');
  assert.equal(line?.settledInstances, 1, JSON.stringify(lines));
  assert.equal(line?.requiredInstances, 2, JSON.stringify(lines));
  assert.equal(line?.state, 'data_in', 'one of two items is done, the line is not satisfied yet');
  const rows = db.prepare('SELECT universe_item_id, child_session_id FROM expected_work_delegated_discharges WHERE session_id = ?').all(session.id) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.universe_item_id), ['account-1']);
  assert.equal(rows[0]!.child_session_id, childId);
}
