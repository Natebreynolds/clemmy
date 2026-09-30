/** Actual host → connection pause → retained construction scope. No network. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-connection-pause-entry-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state/machine-id'), 'fixture-connection-pause-entry\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is forbidden in connection pause fixtures.'); };

const log = await import('./eventlog.js');
const plans = await import('./plan-artifacts.js');
const { runConversation } = await import('./loop.js');
const { wrapToolForHarness } = await import('./brackets.js');
const envelopes = await import('../../agents/capability-envelope.js');
const { bindAgentRebuildContext } = await import('../../agents/agent-rebuild-context.js');
const { bindAgentMcpToolScope } = await import('../mcp-tool-authority.js');
const { readSourceConnectionCheckpoint } = await import('./source-connection-checkpoints.js');
const { currentConnectionDependency } = await import('./dependency-request.js');
const { closeMemoryDb } = await import('../../memory/db.js');

after(() => {
  log.closeEventLog();
  closeMemoryDb();
  globalThis.fetch = originalFetch;
  rmSync(fixtureHome, { recursive: true, force: true });
});

for (const answerShape of ['ask', 'decision'] as const) test(`real ${answerShape} pause retains original agent construction context`, async () => {
  const session = log.createSession({ id: `connection-pause-${answerShape}`, kind: 'chat' });
  const prep = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Plan the controlled account inspection.', taskMode: { version: 1, kind: 'plan' } } });
  const artifact = plans.publishPlanRevision({ sessionId: session.id, principalId: session.id,
    sourceUserSeq: prep.seq, readiness: 'ready', fullText: 'Inspect the controlled account when its connection is available.',
    structuredPlan: { executionDraft: null, steps: [], preparedBindings: [], preparationIssues: [],
      successCriteria: ['Inspect the requested account.'], subagents: [] } });
  const executeRef = { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
  const source = log.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Execute this reviewed account inspection.', taskMode: { version: 1, kind: 'execute', executeRef } } });
  plans.claimPlanExecution({ sessionId: session.id, principalId: session.id, sourceUserSeq: source.seq, executeRef });
  let searches = 0;
  const search = wrapToolForHarness({ type: 'function', name: 'tool_search',
    description: 'Read controlled connection metadata.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    needsApproval: async () => false,
    invoke: async () => {
      searches += 1;
      return JSON.stringify({ query: 'controlled CRM read', role_key: 'source', results: [],
        brokerCoverage: 'authorized_external_v1', unavailable: [{ source: 'authorized_composio', code: 'no_connections',
          reason: 'Controlled fixture connection is unavailable.', dependencySubject: {
            version: 1, kind: 'exact_capability_connection', source: 'authorized_composio',
            query: 'controlled CRM read', roleKey: 'source', toolkit: 'fixturecrm',
            capability: 'FIXTURECRM_READ', capabilityRef: 'cap:resolved:fixturecrm_read',
          } }] });
    } });
  let calls = 0;
  const model = {
    async getResponse() {
      calls += 1;
      assert.ok(calls <= 2, 'setup must not spend another brain turn on a known missing connection');
      const text = answerShape === 'ask' ? 'ASK: Connect the fixture CRM to continue.'
        : JSON.stringify({ summary: 'Connect the fixture CRM to continue.', reply: 'Connect the fixture CRM to continue.',
          done: false, nextAction: 'awaiting_user_input', reason: null });
      return { responseId: `fixture-${answerShape}-${calls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: calls === 1
          ? [{ type: 'function_call', callId: `search-${answerShape}`, name: 'tool_search', arguments: '{}' }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
    },
    async *getStreamedResponse() {
      const response = await this.getResponse();
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: calls === 1 ? 'tool_calls' : 'stop' } } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  const agent = { model, instructions: 'Inspect the controlled fixture connection. Ask if it is missing.', tools: [search] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: session.id, universeTools: [search], activeToolNames: ['tool_search'],
    policyHash: 'fixture-connection-pause', budget: { maxUncachedTokens: 1000, maxModelCalls: 4, maxToolCalls: 4, maxElapsedMs: 20000 } });
  assert.ok(sealed.ok);
  if (!sealed.ok) throw new Error(sealed.errors.join('; '));
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const scope = { reason: 'original inspected task scope', authority: 'catalog' as const, deniedServerSlugs: ['fixture-private'], maxTools: 1 };
  bindAgentMcpToolScope(agent, scope);
  bindAgentRebuildContext(agent, { allowToolJit: true, excludeToolNames: ['run_shell_command'] });

  const result = await runConversation({ sessionId: session.id, sourceUserSeq: source.seq, input: String(source.data.text),
    reuseRecordedUserInput: true, agent: agent as never, turnEngine: 'host_v1', judgeCompletion: false,
    suppressMemoryCapture: true, maxTurns: 3, maxSteps: 2,
    makeRunner: () => new EventEmitter() as never });
  assert.equal(result.status, 'awaiting_user_input', JSON.stringify(result));
  assert.equal(calls, 2);
  assert.equal(searches, 1);
  const dependency = currentConnectionDependency(session.id);
  assert.ok(dependency, 'the actual public pause must park the typed connection');
  const retained = readSourceConnectionCheckpoint({ sessionId: session.id, requestId: dependency.requestId });
  assert.ok(retained?.agent, 'the loop must pass its actual agent to checkpoint capture');
  assert.deepEqual(retained.agent.mcpToolScope, scope);
  assert.deepEqual(retained.agent.rebuildContext, { allowToolJit: true, excludeToolNames: ['run_shell_command'] });
  assert.equal(retained.agent.envelope.envelopeDigest, sealed.envelope.envelopeDigest);
  assert.equal(retained.agent.modelId, undefined, 'an opaque recording model must not become a fabricated model id');
  assert.equal(log.listEvents(session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(log.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
  log.closeEventLog();
  assert.deepEqual(readSourceConnectionCheckpoint({ sessionId: session.id, requestId: dependency.requestId }), retained);
});
