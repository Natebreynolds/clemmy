/** Only the model is scripted: delegated source creation, child host admission,
 * native file tools, result retention, and pre-dispatch refusal are real. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-plan-mode-'));
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
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'worker-plan-mode-fixture\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { withLogicalToolCall } = await import('./attempt-identity.js');
const { acceptedTaskMode } = await import('./accepted-task-mode.js');
const plans = await import('./plan-artifacts.js');
const { runPacketWorkerWithHost } = await import('./worker-host-runner.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
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

for (const parentKind of ['plan', 'execute'] as const) test(`a real delegated ${parentKind} child reads but refuses an unreviewed native write, including after reopen`, async () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const session = eventlog.createSession({ id: `worker-${parentKind}-parent`, kind: 'chat', userId: 'fixture-owner' });
  const sourcePath = path.join(TEST_HOME, `${parentKind}-investigation.txt`);
  const targetPath = path.join(TEST_HOME, `${parentKind}-must-not-be-created.txt`);
  const nonce = 'PLAN-CHILD-READ-NONCE-91827';
  writeFileSync(sourcePath, nonce);
  let source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Investigate the file and prepare a plan for a new local artifact; do not execute it.', taskMode: { version: 1, kind: 'plan' } } });
  if (parentKind === 'execute') {
    const artifact = plans.publishPlanRevision({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'fixture-owner', fullText: 'Read the source. Business writes remain on the reviewed parent path.', readiness: 'ready', structuredPlan: { steps: [], preparedBindings: [], preparationIssues: [] } });
    const ref = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
    source = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Execute the reviewed investigation.', taskMode: { version: 1, kind: 'execute', executeRef: ref } } });
    plans.claimPlanExecution({ sessionId: session.id, sourceUserSeq: source.seq, principalId: 'fixture-owner', executeRef: ref });
  }
  const packet = {
    objective: 'Investigate the proposed local artifact.', item: 'local-artifact', resolvedTools: 'read_file, write_file',
    externalMcpToolNames: null, context: `Read ${sourcePath}. Proposed destination ${targetPath}.`,
    instructions: 'Investigate in Plan mode.', expectedOutput: 'Report the source and proposed action.', intent: 'research',
  };
  assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
  let childId = '';
  let childSourceSeq = 0;
  let modelCalls = 0;
  const observedRequests: string[] = [];
  const result = await brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq,
    counter: new brackets.ToolCallsCounter(8) }, () => withLogicalToolCall({
      sessionId: session.id, sourceUserSeq: source.seq, logicalToolCallId: 'parent-plan-worker', tool: 'run_worker', args: packet,
    }, () => runPacketWorkerWithHost({
      parentSessionId: session.id, sourceUserSeq: source.seq, input: packet, modelId: 'gpt-5.6-terra', maxTurns: 4, mcpToolScope: null,
      buildAgent: async (child) => {
        childId = child.sessionId;
        childSourceSeq = child.sourceUserSeq;
        assert.notEqual(childId, session.id);
        assert.deepEqual(acceptedTaskMode(childId, childSourceSeq), { version: 1, kind: 'plan' });
        // A worker child owns a discovery task from the moment it is accepted
        // (2026-09-08: without it, tool_search was denied task_not_initialized).
        assert.equal(discoveryGovernor.initializeTask({
          claimKeyVersion: 'exact_request_v1', sessionId: childId, sourceUserSeq: childSourceSeq, knownCapability: false,
        }).status, 'existing', 'the worker child already owns its discovery task');
        const tools = getComputerTools().filter((entry) => 'name' in entry && ['read_file', 'write_file'].includes(entry.name))
          .map((entry) => brackets.wrapToolForHarness(entry as never));
        assert.equal(tools.length, 2);
        const model = {
          async getResponse(request: unknown) {
            observedRequests.push(JSON.stringify(request));
            modelCalls += 1;
            const output = modelCalls === 1
              ? [{ type: 'function_call', callId: 'child-plan-read', name: 'read_file', arguments: JSON.stringify({ path: sourcePath, max_chars: null }) }]
              : modelCalls === 2
                ? [{ type: 'function_call', callId: 'child-plan-write', name: 'write_file', arguments: JSON.stringify({ path: targetPath, content: nonce, mode: 'create', append: null }) }]
                : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The source was read. The proposed write remains unexecuted in Plan mode.' }] }];
            return { responseId: `plan-child-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
          }, getStreamedResponse: modelStream,
        };
        const agent = { model, tools };
        const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: childId, universeTools: tools, activeToolNames: ['read_file', 'write_file'],
          policyHash: 'worker-plan-mode-fixture', budget: { maxUncachedTokens: 20_000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 60_000 } });
        assert.ok(sealed.ok);
        if (!sealed.ok) throw new Error('fixture envelope refused');
        envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
        envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
        return agent as never;
      },
    })));
  assert.equal(modelCalls, 3, result);
  assert.match(observedRequests[1]!, new RegExp(nonce), 'the real read result reaches the child model');
  assert.match(observedRequests[2]!, /PLAN_MODE_READ_ONLY/, 'the exact Plan refusal reaches the next model step');
  assert.equal(existsSync(targetPath), false);
  const db = eventlog.openEventLog();
  const settlements = db.prepare('SELECT logical_tool_call_id, outcome_kind, physical_crossing_count, host_crossing_count FROM logical_call_settlements WHERE session_id = ? ORDER BY logical_tool_call_id').all(childId) as Array<Record<string, unknown>>;
  assert.equal(settlements.length, 1, 'the host refuses the write before logical admission; only the successful read settles');
  assert.equal(settlements.find(row => row.logical_tool_call_id === 'child-plan-read')?.outcome_kind, 'succeeded');
  assert.equal(settlements.find(row => row.logical_tool_call_id === 'child-plan-write'), undefined);
  const writeCrossings = db.prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND logical_tool_call_id = ?')
    .get(childId, 'child-plan-write') as { n: number };
  assert.equal(writeCrossings.n, 0);
  assert.equal(eventlog.listEvents(childId, { types: ['approval_requested'] }).length, 0);
  eventlog.closeEventLog();
  assert.deepEqual(acceptedTaskMode(childId, childSourceSeq), { version: 1, kind: 'plan' }, 'restart reopens the exact inherited ceiling');
  const childSource = eventlog.listEvents(childId, { types: ['user_input_received'] })[0]!;
  assert.equal(childSource.parentEventId, source.id);
  assert.equal((childSource.data.delegatedWorker as Record<string, unknown>).parentSourceUserSeq, source.seq);
  assert.deepEqual((childSource.data.delegatedWorker as Record<string, unknown>).parentTaskMode, source.data.taskMode);
  assert.equal((childSource.data.delegatedWorker as Record<string, unknown>).authority, 'investigation_only');
  assert.equal(existsSync(targetPath), false);
});
