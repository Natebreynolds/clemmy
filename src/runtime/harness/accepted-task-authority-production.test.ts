import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { Runner } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authority-production-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
process.env.CLEMMY_CLAUDE_SDK_SESSION_HISTORY = 'off';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
process.env.AUTH_MODE = 'claude_oauth';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-authority-production\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { BoundaryError } = await import('../boundary-error.js');
const { runConversation } = await import('./loop.js');
type RunRunnerFn = import('./loop.js').RunRunnerFn;
const brain = await import('./claude-agent-brain.js');
const authority = await import('./accepted-task-authority.js');
const expectedWork = await import('./expected-work-contract.js');
const shadow = await import('../graph/turn-graph-shadow.js');

function makeRunnerStub(): Runner {
  return new EventEmitter() as unknown as Runner;
}

function makeAgentStub(): import('@openai/agents').Agent<any, any> {
  return {} as import('@openai/agents').Agent<any, any>;
}

function standardAnswerRunner(onCall: () => void, text: string): RunRunnerFn {
  return async (_runner, _agent, items) => {
    onCall();
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
  };
}

beforeEach(() => {
  eventlog.resetEventLog();
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(() => {});
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));
});

after(() => {
  brain.setClaudeAgentSdkBrainRunForTest(null);
  brain.setClaudeAgentSdkBrainPostTurnHooksForTest(null);
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('standard conversational hello remains natural, calls the model once, and arms its exact source first', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'hello' });
  let modelCalls = 0;
  const text = 'Hey! What would you like to work on?';
  const result = await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: 'Hello',
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: standardAnswerRunner(() => { modelCalls += 1; }, text),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.publicPresentation?.text, text);
  assert.equal(modelCalls, 1);
  const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })[0];
  assert.ok(source);
  const loaded = authority.loadAcceptedTaskAuthority(session.id, source.seq);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.status === 'ok' && loaded.authority.acceptedTaskId, `task:${session.id}#${source.seq}`);
  const contract = expectedWork.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(contract.status, 'ok');
  assert.equal(contract.status === 'ok' && contract.contract.operations.length, 0);
  assert.equal(
    loaded.status === 'ok' && contract.status === 'ok' && loaded.authority.workContractId,
    contract.status === 'ok' ? contract.contract.contractId : false,
  );
  assert.equal(eventlog.listEvents(session.id, { types: ['accepted_task_authority_armed'] }).length, 1);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'terminal');
  const publication = eventlog.readAcceptedTaskTerminalPublication(session.id, source.seq);
  assert.equal(publication.status, 'published');
  assert.equal(publication.status === 'published' && publication.event.data.reply, text);
});

test('Claude conversational hello uses the same one-call terminal authority without changing its voice', async () => {
  const sessionId = `claude-direct-terminal-${process.pid}`;
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'hello' });
  const text = 'Hey — what would you like to work through?';
  let providerCalls = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async () => {
    providerCalls += 1;
    return { text, sessionId: 'sdk', model: 'm', toolUses: [] };
  });

  await brain.respondViaClaudeAgentSdkBrain('home', { message: 'Hello', sessionId });

  assert.equal(providerCalls, 1);
  const source = eventlog.listEvents(sessionId, { types: ['user_input_received'] })[0];
  assert.ok(source);
  const loaded = authority.loadAcceptedTaskAuthority(sessionId, source.seq);
  assert.equal(loaded.status === 'ok' && loaded.authority.state, 'terminal');
  const contract = expectedWork.loadExpectedWorkContract(sessionId, source.seq);
  assert.equal(contract.status === 'ok' && contract.contract.operations.length, 0);
  const publication = eventlog.readAcceptedTaskTerminalPublication(sessionId, source.seq);
  assert.equal(publication.status, 'published');
  assert.equal(publication.status === 'published' && publication.event.data.reply, text);
});

test('a deterministic work-contract storage failure reaches zero standard-lane provider calls', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'contract fail' });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_expected_work_storage_failure
    BEFORE INSERT ON accepted_task_work_contracts
    BEGIN
      SELECT RAISE(ABORT, 'forced expected-work storage failure');
    END;
  `);
  let modelCalls = 0;
  try {
    await assert.rejects(
      runConversation({
        agent: makeAgentStub(),
        sessionId: session.id,
        input: 'Hello',
        judgeCompletion: false,
        makeRunner: makeRunnerStub,
        runRunner: standardAnswerRunner(() => { modelCalls += 1; }, 'must not run'),
      }),
      (error: unknown) => error instanceof BoundaryError
        && error.kind === 'state.write_failed'
        && error.context.expectedWorkStatus === 'storage_error',
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_expected_work_storage_failure');
  }
  assert.equal(modelCalls, 0);
  const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })[0];
  assert.ok(source);
  assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'missing');
});

test('a standard-lane graph persistence failure reaches zero provider calls', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'graph fail' });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_turn_graph_storage_failure
    BEFORE INSERT ON events
    WHEN NEW.type = 'turn_graph_compiled'
    BEGIN
      SELECT RAISE(ABORT, 'forced turn graph storage failure');
    END;
  `);
  let modelCalls = 0;
  try {
    const result = await runConversation({
      agent: makeAgentStub(),
      sessionId: session.id,
      input: 'Hello',
      judgeCompletion: false,
      makeRunner: makeRunnerStub,
      runRunner: standardAnswerRunner(() => { modelCalls += 1; }, 'must not run'),
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.steps, 0);
    assert.match(result.error ?? '', /stopped before using any tools/i);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_turn_graph_storage_failure');
  }
  assert.equal(modelCalls, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_compiled'] }).length, 0);
  assert.equal(eventlog.listEvents(session.id, { types: ['accepted_task_authority_armed'] }).length, 0);
  const source = eventlog.listEvents(session.id, { types: ['user_input_received'] })[0];
  assert.ok(source);
  const terminal = eventlog.listEvents(session.id, { types: ['conversation_completed'] })[0];
  const outcome = terminal?.data.turnOutcome as { status?: string; resumable?: boolean } | undefined;
  assert.equal(outcome?.status, 'blocked');
  assert.equal(outcome?.resumable, true);
  const bodies = eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_dispatches
  `).get(session.id, source.seq, session.id, source.seq) as {
    logical_calls: number;
    physical_dispatches: number;
  };
  assert.deepEqual(bodies, { logical_calls: 0, physical_dispatches: 0 });
});

test('a Claude-lane authority storage failure reaches zero provider calls', async () => {
  const sessionId = 'claude-authority-storage-failure';
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'authority fail' });
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER force_authority_storage_failure
    BEFORE INSERT ON accepted_task_authority
    BEGIN
      SELECT RAISE(ABORT, 'forced accepted authority storage failure');
    END;
  `);
  let providerCalls = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async () => {
    providerCalls += 1;
    return { text: 'must not run', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  try {
    await assert.rejects(
      brain.respondViaClaudeAgentSdkBrain('home', { message: 'Hello', sessionId }),
      (error: unknown) => error instanceof BoundaryError
        && error.kind === 'state.write_failed'
        && error.context.authorityStatus === 'storage_error',
    );
  } finally {
    db.exec('DROP TRIGGER IF EXISTS force_authority_storage_failure');
  }
  assert.equal(providerCalls, 0);
  assert.equal(eventlog.listEvents(sessionId, { types: ['turn_graph_compiled'] }).length, 1);
  assert.equal(eventlog.listEvents(sessionId, { types: ['accepted_task_authority_armed'] }).length, 0,
    'the mirror rolls back with the failed authority row');
});

test('standard and Claude seams reuse one graph and one authority for the same accepted source', async () => {
  const session = HarnessSession.create({ kind: 'chat', channel: 'desktop', title: 'same source' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Hello' },
  });
  const graph = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.ok(graph);

  let standardCalls = 0;
  await runConversation({
    agent: makeAgentStub(),
    sessionId: session.id,
    input: 'Hello',
    sourceUserSeq: source.seq,
    reuseRecordedUserInput: true,
    judgeCompletion: false,
    makeRunner: makeRunnerStub,
    runRunner: standardAnswerRunner(() => { standardCalls += 1; }, 'Hello from the standard lane.'),
  });

  let claudeCalls = 0;
  brain.setClaudeAgentSdkBrainRunForTest(async () => {
    claudeCalls += 1;
    return { text: 'Hello from the Claude lane.', sessionId: 'sdk', model: 'm', toolUses: [] };
  });
  await brain.respondViaClaudeAgentSdkBrain('home', {
    message: 'Hello',
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });

  assert.equal(standardCalls, 1);
  assert.equal(claudeCalls, 1);
  assert.equal(eventlog.listEvents(session.id, { types: ['user_input_received'] }).length, 1);
  assert.equal(eventlog.listEvents(session.id, { types: ['turn_graph_compiled'] }).length, 1);
  const armed = eventlog.listEvents(session.id, { types: ['accepted_task_authority_armed'] });
  assert.equal(armed.length, 1);
  assert.equal(armed[0].data.sourceUserSeq, source.seq);
  assert.equal(armed[0].data.graphEventId, graph.id);
  assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'ok');
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n,
    1,
    'both provider lanes replay one frozen deterministic contract',
  );
});
