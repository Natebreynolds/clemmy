/**
 * respond-bridge recovery terminals must ask the shared delivery rule whether
 * completed work is disclosed or held. In particular, rerun suppression after
 * an external write is execution safety; it is not by itself publication
 * authority.
 *
 * Run: npx tsx --test src/runtime/harness/respond-bridge-one-gate-wiring.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-respond-one-gate-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-respond-one-gate\n', 'utf8');

const bridge = await import('./respond-bridge.js');
const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const delivery = await import('./delivery-committer.js');

const FAKE_AGENT = {} as never;
const okConfigure = (async () => ({ ok: true })) as never;
const fakeAgentBuilder = (async () => FAKE_AGENT) as never;

interface CommitProposal {
  status: string;
  kind: string;
  legacyReason?: string;
  deliveryConcern?: string;
  presentationAlreadyDiscloses?: boolean;
}

function recordingCommit(proposals: CommitProposal[]): typeof delivery.commitTurnOutcome {
  return ((
    outcome: Parameters<typeof delivery.commitTurnOutcome>[0],
    options: Parameters<typeof delivery.commitTurnOutcome>[1] = {},
  ) => {
    proposals.push({
      status: outcome.status,
      kind: outcome.presentation.kind,
      ...(options.legacyReason ? { legacyReason: options.legacyReason } : {}),
      ...(options.deliveryConcern?.reason
        ? { deliveryConcern: options.deliveryConcern.reason }
        : {}),
      ...(options.presentationAlreadyDiscloses !== undefined
        ? { presentationAlreadyDiscloses: options.presentationAlreadyDiscloses }
        : {}),
    });
    return delivery.commitTurnOutcome(outcome, options);
  }) as typeof delivery.commitTurnOutcome;
}

function settleSuccessfulBusinessCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  label: string;
}): void {
  const identity = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    acceptedTaskId: `task:${input.sessionId}#${input.sourceUserSeq}`,
    logicalToolCallId: `logical:${input.label}`,
  };
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      ...identity,
      physicalDispatchId: `dispatch:${input.label}`,
      ordinal: 0,
    },
    tool: 'fixture_business_read',
    args: { recordId: 'record-fixture' },
  });
  assert.equal(begun.status, 'inserted', `fixture precondition: ${JSON.stringify(begun)}`);
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'fixture_business_read',
    outcome: 'returned',
  }).status, 'inserted');
  const settled = settlements.commitLogicalCallSettlement({
    identity,
    contract: { toolName: 'fixture_business_read', args: { recordId: 'record-fixture' } },
    execution: { kind: 'provider_execution' },
    result: { payload: { successful: true, data: { id: 'record-fixture' } } },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: false },
    observer: { lane: 'composio', turn: input.turn },
  });
  assert.equal(settled.status, 'committed', `fixture precondition: ${JSON.stringify(settled)}`);
}

function appendConfirmedWrite(input: {
  sessionId: string;
  turn: number;
  label: string;
}): void {
  const callId = `write:${input.label}`;
  const data = {
    callId,
    canonicalCallId: callId,
    toolName: 'fixture_update_record',
    shapeKey: 'FIXTURE_UPDATE_RECORD',
    targets: ['record:fixture'],
    irreversible: false,
  };
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'system',
    type: 'external_write',
    data: { ...data, preDispatch: true },
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'system',
    type: 'external_write_succeeded',
    data,
  });
}

function appendUnresolvedIrreversibleWrite(input: {
  sessionId: string;
  turn: number;
  label: string;
}): void {
  const callId = `write:${input.label}`;
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.turn,
    role: 'system',
    type: 'external_write',
    data: {
      callId,
      canonicalCallId: callId,
      toolName: 'fixture_send_message',
      shapeKey: 'FIXTURE_SEND_MESSAGE',
      targets: ['fixture@example.test'],
      irreversible: true,
      preDispatch: true,
    },
  });
}

function onlyTerminal(sessionId: string): import('./eventlog.js').EventRow {
  const terminals = eventlog.listEvents(sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 1, `expected one terminal: ${JSON.stringify(terminals)}`);
  return terminals[0]!;
}

function terminalStatus(event: import('./eventlog.js').EventRow): string | undefined {
  return (event.data.presentation as { status?: string } | undefined)?.status;
}

beforeEach(() => {
  eventlog.resetEventLog();
  bridge._setBridgeImplsForTests({});
  process.env.AUTH_MODE = 'api_key';
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.MODEL_ROUTING_MODE;
});

after(() => {
  bridge._setBridgeImplsForTests({});
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('completed-work recovery candidate proposes done with a delivery concern; a genuine no-work candidate stays blocked', async () => {
  const proposals: CommitProposal[] = [];
  let run = 0;
  bridge._setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    commitTurnOutcome: recordingCommit(proposals),
    runConversation: (async (opts: { sessionId: string; sourceUserSeq: number }) => {
      run += 1;
      if (run === 1) {
        const source = eventlog.listEvents(opts.sessionId, { types: ['user_input_received'] })[0]!;
        settleSuccessfulBusinessCall({
          sessionId: opts.sessionId,
          sourceUserSeq: opts.sourceUserSeq,
          turn: source.turn,
          label: 'completed-candidate',
        });
        appendConfirmedWrite({ sessionId: opts.sessionId, turn: source.turn, label: 'completed-candidate' });
      }
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 2,
        lastTurn: 2,
        completedReason: 'sub_agent_stalled',
      };
    }) as never,
  });

  const completed = await bridge.respondViaHarness('workflow', {
    message: 'Update the fixture record.',
    sessionId: 'respond-one-gate-completed-candidate',
  });
  const completedTerminal = onlyTerminal(completed.sessionId);
  assert.equal(completed.stoppedReason, 'success', JSON.stringify({ completed, terminal: completedTerminal.data }));
  assert.match(completed.text, /Before the response stopped/);
  assert.deepEqual(proposals[0], {
    status: 'done',
    kind: 'answer',
    legacyReason: 'sub_agent_stalled',
    deliveryConcern: 'sub_agent_stalled',
    presentationAlreadyDiscloses: true,
  });
  assert.equal(terminalStatus(completedTerminal), 'done');

  const noWork = await bridge.respondViaHarness('workflow', {
    message: 'Try the fixture without any completed work.',
    sessionId: 'respond-one-gate-no-work-candidate',
  });
  assert.equal(noWork.stoppedReason, 'error');
  assert.equal(proposals[1]?.status, 'blocked');
  assert.equal(proposals[1]?.deliveryConcern, undefined);
  assert.equal(terminalStatus(onlyTerminal(noWork.sessionId)), 'blocked');
});

test('a recovery candidate with no successful work still proposes done, and the shared rule holds it', async () => {
  const proposals: CommitProposal[] = [];
  bridge._setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    commitTurnOutcome: recordingCommit(proposals),
    runConversation: (async (opts: { sessionId: string }) => {
      const source = eventlog.listEvents(opts.sessionId, { types: ['user_input_received'] })[0]!;
      appendUnresolvedIrreversibleWrite({
        sessionId: opts.sessionId,
        turn: source.turn,
        label: 'no-success',
      });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        completedReason: 'sub_agent_stalled',
      };
    }) as never,
  });

  const response = await bridge.respondViaHarness('workflow', {
    message: 'Send the fixture message.',
    sessionId: 'respond-one-gate-no-success',
  });

  assert.equal(response.stoppedReason, 'error');
  assert.equal(proposals[0]?.status, 'done', 'the carrier proposes completion instead of owning a second veto');
  assert.equal(proposals[0]?.deliveryConcern, 'sub_agent_stalled');
  assert.equal(terminalStatus(onlyTerminal(response.sessionId)), 'blocked');
});

test('parse recovery after a confirmed external write never reruns and lets the shared rule disclose completed work', async () => {
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const proposals: CommitProposal[] = [];
  let calls = 0;
  bridge._setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    commitTurnOutcome: recordingCommit(proposals),
    runConversation: (async (opts: { sessionId: string; sourceUserSeq: number }) => {
      calls += 1;
      const source = eventlog.listEvents(opts.sessionId, { types: ['user_input_received'] })[0]!;
      settleSuccessfulBusinessCall({
        sessionId: opts.sessionId,
        sourceUserSeq: opts.sourceUserSeq,
        turn: source.turn,
        label: 'parse-write',
      });
      appendConfirmedWrite({ sessionId: opts.sessionId, turn: source.turn, label: 'parse-write' });
      return {
        sessionId: opts.sessionId,
        status: 'completed',
        steps: 3,
        lastTurn: 3,
        completedReason: 'no_structured_output',
      };
    }) as never,
  });

  const response = await bridge.respondViaHarness('workflow', {
    message: 'Update the fixture record once.',
    sessionId: 'respond-one-gate-parse-write',
  });

  assert.equal(calls, 1, 'the external-write safety fence still forbids a whole-turn rerun');
  const terminal = onlyTerminal(response.sessionId);
  assert.equal(response.stoppedReason, 'success', JSON.stringify({ response, terminal: terminal.data }));
  assert.match(response.text, /did not rerun/i);
  assert.deepEqual(proposals[0], {
    status: 'done',
    kind: 'answer',
    legacyReason: 'parse_recovery_external_write',
    deliveryConcern: 'parse_recovery_external_write',
    presentationAlreadyDiscloses: true,
  });
  assert.equal(terminalStatus(terminal), 'done');
});

test('whole-turn crash recovery after a confirmed external write discloses once and transport replay cannot re-drive the brain', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'on';
  const proposals: CommitProposal[] = [];
  const sessionId = 'respond-one-gate-claude-write';
  const runId = 'run:respond-one-gate-claude-write';
  let claudeCalls = 0;
  let harnessCalls = 0;
  let sourceUserSeq = 0;
  bridge._setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    commitTurnOutcome: recordingCommit(proposals),
    runConversation: (async () => {
      harnessCalls += 1;
      throw new Error('a post-write crash must not dispatch the fallback brain');
    }) as never,
    claudeAgentBrain: (async (_surface, request) => {
      claudeCalls += 1;
      if (!eventlog.getSession(request.sessionId)) {
        eventlog.createSession({ id: request.sessionId, kind: 'chat' });
      }
      const attempt = eventlog.beginRunAttempt(request.sessionId, { runId: request.runId });
      const source = eventlog.recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: request.message },
      }, { armRunInFlight: true });
      sourceUserSeq = source.seq;
      assert.ok(shadow.recordTurnGraphShadow({
        identity: { sessionId: request.sessionId, sourceUserSeq: source.seq, turn: source.turn },
        surface: 'home',
      }));
      appendConfirmedWrite({ sessionId: request.sessionId, turn: source.turn, label: 'claude-crash' });
      throw new Error('brain crashed after the confirmed write');
    }) as never,
  });

  const request = { message: 'Hello, then record the already completed update.', sessionId, runId };
  const first = await bridge.respondPreferHarness(
    'home',
    request,
    async (req) => ({ text: 'legacy must not run', sessionId: req.sessionId }),
  );
  assert.equal(first.stoppedReason, 'success');
  assert.match(first.text, /did not rerun/i);
  assert.equal(claudeCalls, 1);
  assert.equal(harnessCalls, 0);
  assert.deepEqual(proposals[0], {
    status: 'done',
    kind: 'answer',
    legacyReason: 'claude_recovery_external_write',
    deliveryConcern: 'claude_recovery_external_write',
    presentationAlreadyDiscloses: true,
  });
  assert.equal(terminalStatus(onlyTerminal(sessionId)), 'done');

  const replay = await bridge.respondPreferHarness(
    'home',
    { ...request, sourceUserSeq },
    async (req) => ({ text: 'legacy must not run', sessionId: req.sessionId }),
  );
  assert.equal(replay.text, first.text);
  assert.equal(replay.stoppedReason, 'success');
  assert.equal(claudeCalls, 1, 'transport replay returns the exact terminal without rerunning the brain');
  assert.equal(harnessCalls, 0);
  assert.equal(eventlog.listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('narration give-up after completed work also asks the shared rule instead of pre-converting to blocked', async () => {
  process.env.AUTH_MODE = 'claude_oauth';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  process.env.CLEMMY_BRAIN_FALLOVER = 'off';
  const proposals: CommitProposal[] = [];
  const sessionId = 'respond-one-gate-narration-work';
  let harnessCalls = 0;
  bridge._setBridgeImplsForTests({
    configure: okConfigure,
    buildAgent: fakeAgentBuilder,
    commitTurnOutcome: recordingCommit(proposals),
    runConversation: (async () => {
      harnessCalls += 1;
      throw new Error('narration give-up must not dispatch the harness brain when fallover is off');
    }) as never,
    claudeAgentBrain: (async (_surface, request) => {
      eventlog.createSession({ id: request.sessionId, kind: 'chat' });
      const attempt = eventlog.beginRunAttempt(request.sessionId, { runId: request.runId });
      const source = eventlog.recordRunAttemptUserInput(attempt, {
        turn: 1,
        role: 'user',
        data: { text: request.message },
      }, { armRunInFlight: true });
      assert.ok(shadow.recordTurnGraphShadow({
        identity: { sessionId: request.sessionId, sourceUserSeq: source.seq, turn: source.turn },
        surface: 'home',
      }));
      appendConfirmedWrite({ sessionId: request.sessionId, turn: source.turn, label: 'narration-work' });
      const error = new Error('The update completed, but I could not narrate the final response.') as Error & {
        narrationGiveUp: true;
      };
      error.narrationGiveUp = true;
      throw error;
    }) as never,
  });

  const response = await bridge.respondPreferHarness(
    'home',
    { message: 'Summarize the already-completed fixture update.', sessionId },
    async (req) => ({ text: 'legacy must not run', sessionId: req.sessionId }),
  );

  assert.equal(harnessCalls, 0);
  assert.equal(response.stoppedReason, 'success');
  assert.match(response.text, /Before the response stopped/);
  assert.deepEqual(proposals[0], {
    status: 'done',
    kind: 'answer',
    legacyReason: 'narration_giveup',
    deliveryConcern: 'narration_giveup',
    presentationAlreadyDiscloses: true,
  });
  assert.equal(terminalStatus(onlyTerminal(sessionId)), 'done');
});
