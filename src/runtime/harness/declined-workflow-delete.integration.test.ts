/** The production host must not reopen the same declined delete under equivalent arguments. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-declined-delete-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-declined-delete\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const approvals = await import('./approval-registry.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const workflows = await import('../../memory/workflow-store.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { HostInterruptState, hostRunRunner } = await import('./host-turn-runner.js');
const priorCatalog = catalogs.peekHostCapabilityCatalogFactory();
after(() => {
  catalogs.installHostCapabilityCatalogFactory(priorCatalog);
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

async function* modelStream(this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> }, request: unknown) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: output.some(item => (item as { type?: unknown }).type === 'function_call') ? 'tool_calls' : 'stop' } } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output } } as never;
}

for (const variant of ['null_to_true', 'omitted_to_names'] as const) test(`a declined ${variant} workflow delete gets no second card or body in the same source`, async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const name = `Declined Delete ${variant}`;
  workflows.writeWorkflow(name, { name, description: 'Controlled declined delete.', enabled: false,
    trigger: { manual: true }, steps: [{ id: 'note', prompt: 'Say hello.' }] } as never);
  const session = eventlog.createSession({ id: `declined-delete-${variant}`, kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `Delete the controlled workflow ${name}.` } });
  const firstArgs = variant === 'null_to_true' ? { name, confirm: null } : { name };
  const retryArgs = variant === 'null_to_true' ? { name, confirm: true } : { names: [name], confirm: true };
  const call = (id: string, args: unknown) => ({ type: 'function_call', callId: id,
    name: variant === 'null_to_true' ? 'workflow_delete' : 'call_tool',
    arguments: JSON.stringify(variant === 'null_to_true' ? args : { name: 'workflow_delete', args_json: args }) });
  const script = [[call('first-delete', firstArgs)], [call('retry-delete', retryArgs)],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I left it unchanged.' }] }]];
  let modelCalls = 0;
  const model = {
    async getResponse() { const output = script[Math.min(modelCalls, script.length - 1)]!; modelCalls++;
      return { responseId: `${variant}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output }; },
    getStreamedResponse: modelStream,
  };
  const planning = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1 });
  assert.ok(planning.ok);
  if (!planning.ok) throw new Error(planning.reason);
  const agent = await buildOrchestratorAgent({ userInput: String(source.data.text), sessionId: session.id, sourceUserSeq: source.seq,
    acceptedRoute: 'act', hostFreshPlanning: planning.planning, allowedToolNames: ['call_tool', 'work_call', 'workflow_delete', 'workflow_list'],
    allowToolJit: true, mcpToolScope: { authority: 'none', reason: 'controlled declined delete', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never });
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy runner must not run'); };
  const run = (input: unknown) => brackets.withHarnessRunContext({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::turn:1` },
    () => hostRunRunner(runner as never, agent as never, input as never, { maxTurns: 4, hostTurnEngine: 'host_v1',
      context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } } as never));
  const paused = await run(new HostInterruptState([{ type: 'message', role: 'user', content: String(source.data.text) }] as never, [], undefined, 'host_v1'));
  assert.equal(paused.hasInterruptions, true);
  assert.ok(workflows.readWorkflow(name));
  const interruption = paused.interruptions![0]!;
  assert.ok(interruption.approvalResumeKey);
  const card = approvals.registerResumable({ sessionId: session.id, subject: 'Delete controlled workflow', tool: interruption.toolName,
    args: interruption.args, resumeKey: interruption.approvalResumeKey! }).row;
  assert.equal(approvals.resolve(card.approvalId, 'rejected', 'controlled-owner').ok, true);
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.reject(state.getInterruptions()[0]);
  const resumed = await run(state);
  assert.equal(Boolean(resumed.hasInterruptions), false, 'an equivalent retry must not raise a second approval card');
  assert.equal(resumed.finalOutput, 'I left it unchanged.');
  assert.ok(workflows.readWorkflow(name), 'neither rejected spelling executes the delete body');
  assert.equal(modelCalls, 3, 'one refusal returns to the model for its answer');
  assert.equal(approvals.listPending({ sessionId: session.id, status: 'any' }).length, 1);
  const bodies = eventlog.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ? AND tool_name = ?')
    .get(session.id, source.seq, 'workflow_delete') as { n: number };
  assert.equal(bodies.n, 0, 'the declined operation has no physical dispatch');
});
