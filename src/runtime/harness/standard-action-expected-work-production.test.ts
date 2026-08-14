import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { Agent, Runner, Tool } from '@openai/agents';
import type { TerminalDeliveryJudgePort } from './terminal-delivery-judge.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-standard-action-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-standard-action-work\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runConversation } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const expectedWork = await import('./expected-work-contract.js');
const actionAdmission = await import('./expected-work-admission.js');
const guardrail = await import('./tool-guardrail.js');
const settlement = await import('./attempt-settlement.js');
const terminalRepair = await import('./terminal-presentation-repair.js');
const { _setCodeModeToolsForTests } = await import('../../tools/code-mode-tool.js');

type Invokable = Tool<unknown> & {
  invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function namesOf(agent: Agent<any, any>): string[] {
  return (agent.tools ?? []).map((toolRef) => toolRef.name).filter(Boolean).sort();
}

function invokable(agent: Agent<any, any>, name: string): Invokable {
  const found = (agent.tools ?? []).find((toolRef) => toolRef.name === name) as Invokable | undefined;
  assert.ok(found, `missing ${name} on production agent surface`);
  return found;
}

function done(items: unknown[], text = 'Done from the model.') {
  return {
    history: items,
    lastResponseId: undefined,
    finalOutput: {
      summary: text,
      reply: text,
      done: true,
      nextAction: 'completed',
      reason: null,
    },
  } as never;
}

function unavailableTerminalDeliveryJudge(): TerminalDeliveryJudgePort {
  return {
    async resolveRoute() { return null; },
    async run() { throw new Error('an unavailable terminal judge must not run'); },
  };
}

function actionProposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read-profile', effect: 'read' as const, coverage: 'single' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'read-roots', effect: 'read' as const, coverage: 'single' as const,
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' as const },
      },
      {
        id: 'write-report', effect: 'local_write' as const, coverage: null,
        dependsOn: ['read-profile', 'read-roots'], dataFrom: ['read-profile', 'read-roots'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
}

function workInput(input: {
  proposal: ReturnType<typeof actionProposal> | null;
  requirementId: string;
  name: string;
  args?: Record<string, unknown>;
}) {
  return JSON.stringify({
    proposal: input.proposal,
    requirement_id: input.requirementId,
    universe_item_id: null,
    universe_selector: null,
    name: input.name,
    args_json: JSON.stringify(input.args ?? {}),
  });
}

beforeEach(() => {
  eventlog.resetEventLog();
  guardrail._resetAllTrackersForTests();
  guardrail._resetGuardrailScopeSignals();
  settlement._resetAttemptSettlementStateForTests();
  _setCodeModeToolsForTests(null);
});

after(() => {
  _setCodeModeToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('standard spine activates exact action authority before building its sole business carrier', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'action activation' });
  let buildCount = 0;
  let capturedNames: string[] = [];
  let codeModeDescription = '';
  const result = await runConversation({
    sessionId: session.id,
    input: 'Read my profile and workspace roots, then write a local report.',
    maxSteps: 1,
    judgeCompletion: false,
    buildAgent: async (identity) => {
      buildCount += 1;
      assert.equal(identity.route, 'act');
      assert.equal(actionAdmission.actionExpectedWorkState(identity).status, 'required');
      const agent = await buildOrchestratorAgent({
        userInput: 'Read my profile and workspace roots, then write a local report.',
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedRoute: identity.route,
        allowedToolNames: ['tool_search', 'run_tool_program', 'user_profile_read', 'workspace_roots', 'write_file'],
        allowToolJit: true,
      });
      capturedNames = namesOf(agent);
      codeModeDescription = String(invokable(agent, 'run_tool_program').description ?? '');
      return agent;
    },
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, _agent, items) => done(items),
    terminalDeliveryJudgePort: unavailableTerminalDeliveryJudge(),
  });

  assert.equal(buildCount, 1);
  assert.ok(capturedNames.includes('work_call'));
  assert.equal(capturedNames.includes('call_tool'), false, 'action exposes no competing generic carrier');
  assert.equal(capturedNames.includes('user_profile_read'), false, 'business tools stay behind work_call');
  assert.equal(capturedNames.includes('workspace_roots'), false, 'business tools stay behind work_call');
  assert.ok(capturedNames.includes('tool_search'), 'control discovery remains directly callable');
  assert.match(codeModeDescription, /clem\.work/);
  assert.match(codeModeDescription, /proposal must be null/);
  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.kind, 'blocked', 'a zero-call action done claim must fail closed');
  const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })[0]!;
  assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'missing');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?`)
    .get(session.id, source.seq) as { n: number }).n, 0);
});

test('standard direct and retrieve routes retain the legacy carrier surface', async () => {
  let repairCalls = 0;
  for (const [input, expectedRoute] of [
    ['Hello', 'direct_reply'],
    ['Summarize the notes about project alpha.', 'retrieve'],
  ] as const) {
    const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: expectedRoute });
    let builtRoute = '';
    let surface: string[] = [];
    let codeModeDescription = '';
    const result = await runConversation({
      sessionId: session.id,
      input,
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        builtRoute = identity.route;
        const agent = await buildOrchestratorAgent({
          userInput: input,
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedRoute: identity.route,
          allowToolJit: true,
        });
        surface = namesOf(agent);
        const codeMode = (agent.tools ?? []).find((toolRef) => toolRef.name === 'run_tool_program');
        codeModeDescription = String(codeMode?.description ?? '');
        return agent;
      },
      makeRunner: makeRunnerStub,
      runRunner: async (_runner, _agent, items) => done(items, `Legacy ${expectedRoute} answer.`),
      terminalPresentationRepairPort: {
        async render() {
          repairCalls += 1;
          return 'This must not run for a conversational or retrieval turn.';
        },
      },
    });
    assert.equal(builtRoute, expectedRoute);
    assert.equal(surface.includes('work_call'), false, `${expectedRoute} must not pay the action schema cost`);
    assert.ok(surface.includes('call_tool'), `${expectedRoute} keeps its pre-existing deferred dispatcher`);
    assert.doesNotMatch(codeModeDescription, /ACTION WORK.*clem\.work/);
    if (expectedRoute === 'direct_reply') {
      assert.equal(result.publicPresentation?.text, 'Legacy direct_reply answer.');
    }
  }
  assert.equal(repairCalls, 0, 'direct/retrieve presentation is byte-preserved without a repair model call');
});

test('shared Codex/BYO action run_tool_program carries scoped work_call through the real sandbox', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'action code work' });
  let sourceUserSeq = 0;
  let innerExecutions = 0;
  _setCodeModeToolsForTests(new Map([['user_profile_read', {
    name: 'user_profile_read',
    invoke: async () => {
      innerExecutions += 1;
      return { successful: true, data: { name: 'Clem' } };
    },
  }]]));
  try {
    await runConversation({
      sessionId: session.id,
      input: 'Read my profile and workspace roots, then write a local report.',
      maxSteps: 1,
      judgeCompletion: false,
      buildAgent: async (identity) => {
        sourceUserSeq = identity.sourceUserSeq;
        return buildOrchestratorAgent({
          userInput: 'Read my profile and workspace roots, then write a local report.',
          sessionId: identity.sessionId,
          sourceUserSeq: identity.sourceUserSeq,
          acceptedRoute: identity.route,
          allowedToolNames: ['run_tool_program', 'user_profile_read', 'workspace_roots', 'write_file'],
          allowToolJit: true,
        });
      },
      makeRunner: makeRunnerStub,
      runRunner: async (_runner, agent, items) => {
        const program = invokable(agent, 'run_tool_program');
        const firstWork = workInput({
          proposal: actionProposal(),
          requirementId: 'read-profile',
          name: 'user_profile_read',
        });
        const output = await program.invoke(
          { context: { sessionId: session.id, sourceUserSeq, turn: 1 } },
          JSON.stringify({ program: `return await clem.work(${firstWork});` }),
          { toolCall: { callId: 'outer-action-code-program' } },
        );
        assert.match(String(output), /successful/);
        return done(items, 'The profile read is complete; the remaining accepted work is still open.');
      },
      terminalDeliveryJudgePort: unavailableTerminalDeliveryJudge(),
    });
  } finally {
    _setCodeModeToolsForTests(null);
  }

  assert.equal(innerExecutions, 1);
  const db = eventlog.openEventLog();
  const binding = db.prepare(`
    SELECT requirement_id, tool_name FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, sourceUserSeq) as { requirement_id: string; tool_name: string } | undefined;
  assert.deepEqual(binding, { requirement_id: 'read-profile', tool_name: 'user_profile_read' });
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'OPEN'
  `).get(session.id, sourceUserSeq) as { n: number }).n, 0);
});

test('standard action keeps control discovery before freeze, fuses proposal with call one, and binds later calls', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'fused work calls' });
  const calls: string[] = [];
  _setCodeModeToolsForTests(new Map([
    ['user_profile_read', {
      name: 'user_profile_read',
      invoke: async () => { calls.push('user_profile_read'); return { successful: true, data: { name: 'Clem' } }; },
    }],
    ['workspace_roots', {
      name: 'workspace_roots',
      invoke: async () => { calls.push('workspace_roots'); return { successful: true, data: ['/workspace'] }; },
    }],
    ['write_file', {
      name: 'write_file',
      invoke: async () => { calls.push('write_file'); return { successful: true }; },
    }],
  ]));

  let sourceUserSeq = 0;
  let repairPacket: terminalRepair.TerminalPresentationRepairPacketV1 | undefined;
  let repairCalls = 0;
  const runRunner: RunRunnerFn = async (_runner, agent, items) => {
    const search = invokable(agent, 'tool_search');
    const workCall = invokable(agent, 'work_call');
    const runContext = { context: { sessionId: session.id, sourceUserSeq, turn: 1 } };

    const searchResult = await search.invoke(
      runContext,
      // A strict tool schema advertises every property as required, so a
      // hand-written call must carry them all. This task registered no
      // requirement roles, and null is how the schema spells "no role".
      JSON.stringify({ query: 'read the user profile', limit: 1, role_key: null }),
      { toolCall: { callId: 'control-search' } },
    );
    assert.match(String(searchResult), /work_call/);
    assert.equal(expectedWork.loadExpectedWorkContract(session.id, sourceUserSeq).status, 'missing');

    const first = await workCall.invoke(
      runContext,
      workInput({ proposal: actionProposal(), requirementId: 'read-profile', name: 'user_profile_read' }),
      { toolCall: { callId: 'fused-first-call' } },
    );
    assert.match(JSON.stringify(first), /successful/);
    assert.equal(expectedWork.loadExpectedWorkContract(session.id, sourceUserSeq).status, 'ok');

    const dependencyRefusal = await workCall.invoke(
      runContext,
      workInput({
        proposal: null,
        requirementId: 'write-report',
        name: 'write_file',
        args: { path: 'report.txt', content: 'must not be written yet' },
      }),
      { toolCall: { callId: 'dependency-pending-call' } },
    );
    assert.match(String(dependencyRefusal), /work_dependency_pending/);

    const second = await workCall.invoke(
      runContext,
      workInput({ proposal: null, requirementId: 'read-roots', name: 'workspace_roots' }),
      { toolCall: { callId: 'subsequent-bound-call' } },
    );
    assert.match(JSON.stringify(second), /successful/);

    // Satisfied-replay + steering card (live 2026-08-11: an already-settled
    // requirement returned a bare error and restarted the guess-loop; a
    // refusal without the frozen plan sent the model into blind retries).
    const satisfied = await workCall.invoke(
      runContext,
      workInput({ proposal: null, requirementId: 'read-profile', name: 'user_profile_read' }),
      { toolCall: { callId: 'already-satisfied-replay' } },
    );
    const satisfiedText = JSON.stringify(satisfied);
    assert.match(satisfiedText, /work_already_satisfied/);
    assert.match(satisfiedText, /result/, 'the stored prior result rides the response');
    assert.match(satisfiedText, /do NOT re-run/i, 'the repair prescribes using the result, not retrying');
    assert.match(satisfiedText, /plan/, 'the remaining-plan card rides the response');
    assert.match(satisfiedText, /read-roots/, 'the plan names the sibling requirements');
    assert.doesNotMatch(satisfiedText, /\\\\"error\\\\"/, 'the envelope is never double-wrapped');

    return done(items, 'The two source reads are complete; the report write still needs verification.');
  };

  const result = await runConversation({
    sessionId: session.id,
    input: 'Read my profile and workspace roots, then write a local report.',
    maxSteps: 1,
    judgeCompletion: false,
    buildAgent: async (identity) => {
      sourceUserSeq = identity.sourceUserSeq;
      assert.equal(identity.route, 'act');
      return buildOrchestratorAgent({
        userInput: 'Read my profile and workspace roots, then write a local report.',
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedRoute: identity.route,
        allowedToolNames: ['tool_search', 'user_profile_read', 'workspace_roots', 'write_file'],
        allowToolJit: true,
      });
    },
    makeRunner: makeRunnerStub,
    runRunner,
    terminalPresentationRepairPort: {
      async render(packet) {
        repairCalls += 1;
        repairPacket = packet;
        return 'I finished the two reads, but I haven\'t written or verified the report yet. I can resume from that step.';
      },
    },
    terminalDeliveryJudgePort: unavailableTerminalDeliveryJudge(),
  });

  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.kind, 'blocked', 'unfinished write obligation cannot publish done');
  assert.equal(
    result.publicPresentation?.text,
    'I finished the two reads, but I haven\'t written or verified the report yet. I can resume from that step.',
  );
  assert.equal(repairCalls, 1, 'one exact staged verification gap earns one sealed repair call');
  assert.equal(repairPacket?.acceptedRequest, 'Read my profile and workspace roots, then write a local report.');
  assert.ok(repairPacket?.gaps.some((gap) => gap.kind === 'work_contract_incomplete'));
  assert.equal(
    eventlog.listEvents(session.id, { types: ['terminal_authority_repair_granted'] }).length,
    1,
  );
  assert.equal(
    eventlog.listEvents(session.id, { types: ['terminal_authority_repair_consumed'] }).length,
    1,
  );
  assert.deepEqual(calls, ['user_profile_read', 'workspace_roots'], 'dependency refusal crosses no tool boundary');
  const db = eventlog.openEventLog();
  const bindings = db.prepare(`
    SELECT logical_tool_call_id, requirement_id FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? ORDER BY bound_at, logical_tool_call_id
  `).all(session.id, sourceUserSeq) as Array<{ logical_tool_call_id: string; requirement_id: string }>;
  assert.deepEqual(bindings, [
    { logical_tool_call_id: 'fused-first-call', requirement_id: 'read-profile' },
    { logical_tool_call_id: 'subsequent-bound-call', requirement_id: 'read-roots' },
  ]);
  const refused = db.prepare(`
    SELECT outcome_kind, execution_kind, retry_same_candidate,
           eliminates_candidate, discovery_epoch_requested
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, sourceUserSeq, 'dependency-pending-call') as Record<string, unknown>;
  assert.deepEqual(refused, {
    outcome_kind: 'policy_denial',
    execution_kind: 'refused_pre_dispatch',
    retry_same_candidate: 0,
    eliminates_candidate: 0,
    discovery_epoch_requested: 0,
  });
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(session.id, sourceUserSeq, 'dependency-pending-call') as { n: number }).n, 0);
});

test('malformed standard work_call settles one corrective refusal and makes zero inner dispatches', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'malformed work call' });
  let sourceUserSeq = 0;
  const result = await runConversation({
    sessionId: session.id,
    input: 'Read my profile and workspace roots, then write a local report.',
    maxSteps: 1,
    judgeCompletion: false,
    buildAgent: async (identity) => {
      sourceUserSeq = identity.sourceUserSeq;
      return buildOrchestratorAgent({
        userInput: 'Read my profile and workspace roots, then write a local report.',
        sessionId: identity.sessionId,
        sourceUserSeq: identity.sourceUserSeq,
        acceptedRoute: identity.route,
        allowedToolNames: ['tool_search', 'user_profile_read'],
        allowToolJit: true,
      });
    },
    makeRunner: makeRunnerStub,
    runRunner: async (_runner, agent, items) => {
      const workCall = invokable(agent, 'work_call');
      const output = await workCall.invoke(
        { context: { sessionId: session.id, sourceUserSeq, turn: 1 } },
        JSON.stringify({ proposal: null, name: 'user_profile_read', args_json: '{}' }),
        { toolCall: { callId: 'malformed-standard-work-call' } },
      );
      assert.match(String(output), /work_contract_invalid|Invalid/);
      return done(items);
    },
    terminalDeliveryJudgePort: unavailableTerminalDeliveryJudge(),
  });

  assert.equal(result.publicPresentation?.status, 'blocked');
  assert.equal(result.publicPresentation?.kind, 'blocked');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?`)
    .get(session.id, sourceUserSeq) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?`)
    .get(session.id, sourceUserSeq) as { n: number }).n, 1);
  assert.deepEqual(db.prepare(`
    SELECT outcome_kind, execution_kind, logical_tool_call_id FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
  `).all(session.id, sourceUserSeq), [{
    outcome_kind: 'invalid_arguments',
    execution_kind: 'refused_pre_dispatch',
    logical_tool_call_id: 'malformed-standard-work-call',
  }]);
});
