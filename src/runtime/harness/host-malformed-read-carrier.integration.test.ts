import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-host-malformed-read-carrier-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'malformed-read-carrier\n');

const events = await import('./eventlog.js');
const host = await import('./host-turn-runner.js');
const brackets = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const { getLocalRuntimeTools } = await import('../../tools/local-runtime-tools.js');
const settlements = await import('./logical-call-settlement-store.js');
const { acceptedTaskIdFor } = await import('./attempt-identity.js');
const { acceptedTurnCallAuthorityFor } = await import('./accepted-turn-call-authority.js');

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

async function runScenario(options: { id: string; replaceInvoke?: boolean }) {
  const prompt = 'Find the search tool, then list my tasks.';
  const session = events.createSession({ id: options.id, kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  host.captureEffectiveCompletionPolicyOnce({ ...identity, enabled: false });
  const configured = buildCallTool({ reachableBuiltinNames: new Set(['composio_search_tools', 'task_list']) });
  let replacedBodyCalls = 0;
  // Copying the schema/name cannot copy the opaque parser guarantee. The new
  // invoke could run arbitrary code without validating, so it must stay out.
  const candidate = options.replaceInvoke
    ? { ...configured, invoke: async () => { replacedBodyCalls += 1; return 'unvalidated code ran'; } }
    : configured;
  const carrier = brackets.wrapToolForHarness(candidate as never);
  const taskList = getLocalRuntimeTools().find((tool) => tool.name === 'task_list');
  assert.ok(taskList);
  let calls = 0;
  const observed: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      calls += 1;
      observed.push(request);
      const output = calls === 1
        ? [{ type: 'function_call', callId: 'malformed-search', name: 'call_tool', arguments: JSON.stringify({ name: 'composio_search_tools', args_json: { query: 'Find the search tool' } }) }]
        : calls === 2
          ? [{ type: 'function_call', callId: 'recovered-task-list', name: 'call_tool', arguments: JSON.stringify({ name: 'task_list', args_json: JSON.stringify({ status: null, priority: null, project: null, since: null, limit: 10 }) }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The task list is empty.' }] }];
      assert.ok(calls <= 3, 'a schema corrective must not enter checkpoint recovery or a retry loop');
      return { responseId: `carrier-response-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = { model, tools: [carrier, taskList] };
  const prior = catalogs.peekHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  try {
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: agent.tools as never, activeToolNames: ['call_tool', 'task_list'], policyHash: 'carrier-input-recovery', budget: { maxUncachedTokens: 10_000, maxModelCalls: 4, maxToolCalls: 20, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true);
    if (!sealed.ok) throw new Error('fixture envelope did not seal');
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = Object.assign(new EventEmitter(), { run() { throw new Error('Legacy runner must not execute'); } });
    const result = await brackets.withHarnessRunContext({ ...identity, counter: new brackets.ToolCallsCounter(20) }, () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never, { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: identity } as never));
    return { identity, result, calls, observed, replacedBodyCalls };
  } finally {
    catalogs.installHostCapabilityCatalogFactory(prior);
  }
}

test('the actual host returns the malformed read carrier schema, then completes a subsequent native read without conflicting its root', async () => {
    const { identity, result, calls, observed } = await runScenario({ id: 'malformed-read-carrier' });
    assert.equal(calls, 3, JSON.stringify(result));
    assert.match(JSON.stringify(observed[1]), /args_json.*string|args_json.*schema/i, 'the next model step receives specific carrier schema repair');
    const db = events.openEventLog();
    const logical = db.prepare('SELECT logical_tool_call_id, tool_name, state, conflict_reason FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ? ORDER BY opened_at').all(identity.sessionId, identity.sourceUserSeq);
    assert.deepEqual(logical, [
      { logical_tool_call_id: 'malformed-search', tool_name: 'composio_search_tools', state: 'settled', conflict_reason: null },
      { logical_tool_call_id: 'recovered-task-list', tool_name: 'task_list', state: 'settled', conflict_reason: null },
    ]);
    // Reopen SQLite before redeeming: the result/projection is durable, not an
    // in-memory error marker that disappears at the next host checkpoint.
    events.closeEventLog();
    for (const callId of ['malformed-search', 'recovered-task-list']) {
      const redeemed = settlements.redeemDurableLogicalCallSettlementForHost({ ...identity, acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq), logicalToolCallId: callId });
      assert.equal(redeemed.status, 'ok', JSON.stringify(redeemed));
      if (redeemed.status !== 'ok') throw new Error(redeemed.reason);
      assert.equal(redeemed.settlement.outcome.kind, callId === 'malformed-search' ? 'invalid_arguments' : 'succeeded');
      assert.equal(redeemed.settlement.physicalCrossingCount, 0);
    }
    assert.equal((events.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND logical_tool_call_id = ?').get(identity.sessionId, 'malformed-search') as { n: number }).n, 0);
    const root = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
    assert.equal(root.status, 'ok', JSON.stringify(root));
    if (root.status === 'ok') assert.notEqual(root.authority.state, 'conflict');
    assert.equal((result as { hold?: unknown }).hold, undefined, 'the host completes without parking an unreopenable checkpoint');
});

test('a copied carrier with a replaced invoke cannot borrow the parser proof or reopen a conflicted root', async () => {
  const { identity, result, calls, replacedBodyCalls } = await runScenario({ id: 'untrusted-carrier-copy', replaceInvoke: true });
  assert.equal(replacedBodyCalls, 0, 'the replacement could skip schema validation, so it cannot enter');
  assert.equal(calls, 1, 'an actual authority conflict is not repaired by the read schema path');
  assert.ok((result as { hold?: unknown }).hold);
  const root = acceptedTurnCallAuthorityFor(identity.sessionId, identity.sourceUserSeq);
  assert.equal(root.status, 'conflict', JSON.stringify(root));
  if (root.status === 'conflict') assert.match(root.reason, /effect violation: unknown/);
});
