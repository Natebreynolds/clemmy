/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approved-carried-local-write.integration.test.ts
 *
 * An approved card runs the call it was raised for. Before admission the host
 * prepares a local write's exact requirement (and carries call_tool{X} onto
 * its carrier); the card's consent is decided on that prepared call. The
 * approval resume must rebuild the same call, or the owner's yes ends as a
 * changed-scope refusal and nothing is deleted.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-carried-write-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
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
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-approved-carried-write\n', 'utf8');

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
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: unknown }).type === 'function_call') ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: { id: response.responseId, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must remain unreachable');
  };
  return runner;
}

for (const authored of ['call_tool', 'direct'] as const) test(`an approved ${authored} workflow delete runs on resume`, async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const workflowName = `Carried Delete ${authored}`;
  workflows.writeWorkflow(workflowName, {
    name: workflowName,
    description: 'A workflow the owner asks to delete.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'note', prompt: 'Say hello.' }],
  } as never);
  assert.ok(workflows.readWorkflow(workflowName), 'the fixture workflow exists before the request');

  const session = eventlog.createSession({ id: `approved-carried-${authored}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Delete the workflow ${workflowName}, it is done.` },
  });
  const deleteArgs = { name: workflowName };
  const call = authored === 'call_tool'
    ? { type: 'function_call', callId: 'delete-carried', name: 'call_tool',
        arguments: JSON.stringify({ name: 'workflow_delete', args_json: deleteArgs }) }
    : { type: 'function_call', callId: 'delete-carried', name: 'workflow_delete',
        arguments: JSON.stringify(deleteArgs) };
  const script = [
    [call],
    [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Deleted it.' }] }],
  ];
  let modelCalls = 0;
  const model = {
    async getResponse() {
      const output = script[Math.min(modelCalls, script.length - 1)]!;
      modelCalls += 1;
      return { responseId: `approved-carried-${authored}-${modelCalls}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    getStreamedResponse: modelStream,
  };
  const primed = await semantic.primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1 });
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  const agent = await buildOrchestratorAgent({
    userInput: String(source.data.text),
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedRoute: 'act',
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['call_tool', 'work_call', 'workflow_delete', 'workflow_list'],
    allowToolJit: true,
    mcpToolScope: { authority: 'none', reason: 'approved carried write regression', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 },
    model: model as never,
  });
  const run = (input: unknown, extra: Record<string, unknown> = {}) => brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  }, () => hostRunRunner(throwingRunner() as never, agent as never, input as never, {
    maxTurns: 4,
    hostTurnEngine: 'host_v1',
    context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    ...extra,
  } as never));

  const paused = await run(new HostInterruptState(
    [{ type: 'message', role: 'user', content: String(source.data.text) }] as never,
    [],
    undefined,
    'host_v1',
  ));
  assert.equal(paused.hasInterruptions, true, JSON.stringify((paused as { history?: unknown }).history));
  assert.ok(workflows.readWorkflow(workflowName), 'nothing is deleted before the owner answers');
  const interruption = paused.interruptions![0]!;
  assert.ok(interruption.approvalResumeKey);
  const approval = approvals.registerResumable({
    sessionId: session.id,
    subject: `Delete ${workflowName}.`,
    tool: interruption.toolName,
    args: interruption.args,
    resumeKey: interruption.approvalResumeKey!,
  }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'carried-write-fixture').ok, true);
  const state = HostInterruptState.fromString(paused.serializedState!);
  state.approve(state.getInterruptions()[0]);
  const resumed = await run(state, { hostApprovalIds: [approval.approvalId] });

  assert.equal(Boolean(resumed.hasInterruptions), false, JSON.stringify((resumed as { history?: unknown }).history));
  const repairs = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => (event.data as { kind?: unknown }).kind === 'resume_frame_repair');
  assert.deepEqual(repairs.map((event) => event.data), [], 'the approved call is rebuilt as admitted, never sent back');
  const settled = eventlog.listEvents(session.id, { types: ['tool_attempt_settled'] })
    .map((event) => event.data as { logicalToolCallId?: string; kind?: string; detail?: string })
    .filter((row) => row.logicalToolCallId === 'delete-carried');
  assert.ok(settled.some((row) => row.kind === 'succeeded'), JSON.stringify(settled));
  assert.equal(settled.some((row) => /approval_scope_changed/.test(row.detail ?? '')), false, JSON.stringify(settled));
  assert.equal(workflows.readWorkflow(workflowName), null, 'the approved delete ran');
});
