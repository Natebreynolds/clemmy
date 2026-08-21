/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/conversation-short-circuit.test.ts
 *
 * Conversation stops paying admission (live 2026-08-18: "hey hows it going"
 * paid ~5.4k tokens / 3.2s of brain-model semantic proposal whose only
 * admissible answer was relation:'conversation' with no goal and no work).
 *
 * The short-circuit is a ceremony deferral, never route authority: every doubt
 * pays full admission. Closed-world greetings dispatch as conversation (model
 * reply, no action tools). Action/retrieve never fall through to an untyped
 * tool loop. These pins are cost assertions on the world (port.interpret call
 * count), not the model's self-report.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-convo-short-circuit-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-convo-short-circuit\n', 'utf8');

const { appendEvent, createSession, closeEventLog } = await import('../harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const {
  admitAndCompileAcceptedSource,
  CONVERSATION_SHORT_CIRCUIT_REASON,
} = await import('./admit-and-compile-accepted-source.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { readSemanticDisposition } = await import('./semantic-disposition.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { entailedPlanGroundingJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');
const { createTaskContinuityPacket } = await import('../../memory/task-continuity.js');
import type { TurnSemanticModelPort } from './turn-semantic-model-port.js';

test.after(() => {
  installTurnSemanticModelPort(null);
  closeEventLog();
});

const interpretCalls: string[] = [];

function countingPort(): TurnSemanticModelPort {
  return {
    async interpret(call) {
      interpretCalls.push(call.host.source.acceptedText);
      return {
        raw: fakeSemanticProposal('newConstruct', call.host),
        modelIdentity: 'fake-semantic/short-circuit',
        inputTokens: 12,
        outputTokens: 34,
        latencyMs: 5,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'fake-semantic/judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/grounding');
    },
  };
}

installTurnSemanticModelPort(countingPort());

function acceptedTurn(text: string): { sessionId: string; sourceUserSeq: number; turn: number } {
  const sess = createSession({ kind: 'chat', channel: 'desktop', userId: 'short-circuit-user' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text },
  });
  return { sessionId: sess.id, sourceUserSeq: source.seq, turn: 1 };
}

test('a greeting never reaches the semantic port and dispatches as conversation', async () => {
  interpretCalls.length = 0;
  const identity = acceptedTurn('hey hows it going');
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'dashboard' });
  assert.equal(interpretCalls.length, 0, 'the proposal is the 5.4k-token cost — a greeting must not pay it');
  assert.ok(compiled.ok, `the short-circuit lands on the untyped compile: ${JSON.stringify(compiled)}`);
  if (compiled.ok) {
    assert.ok(compiled.compiled.graph.nodes.length > 0, 'a durable graph still persists');
  }
  const disposition = readSemanticDisposition(identity.sessionId, identity.sourceUserSeq);
  assert.equal(disposition?.participation, 'unparticipated', 'truthful disposition: the port did not participate');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'conversation',
    'closed-world talk is the cheap mode of the one kernel, not an untyped action loop');
});

test('a hosted-world ask pays admission and never falls through to an untyped loop', async () => {
  interpretCalls.length = 0;
  const identity = acceptedTurn('whats on my calendar for tomrrow');
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'dashboard' });
  assert.ok(compiled.ok || interpretCalls.length > 0, 'action/retrieve participates instead of skipping');
  const disposition = readSemanticDisposition(identity.sessionId, identity.sourceUserSeq);
  assert.equal(disposition?.participation, 'participated');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.notEqual(dispatched.kind, 'conversation', 'a calendar read is not a greeting');
  assert.ok(dispatched.kind === 'typed' || dispatched.kind === 'blocked', JSON.stringify(dispatched).slice(0, 200));
});

test('a discourse referent after a prior act turn pays admission', async () => {
  interpretCalls.length = 0;
  const sess = createSession({ kind: 'chat', channel: 'desktop', userId: 'short-circuit-user' });
  const prior = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'whats on my calendar for tomrrow' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: prior.seq, turn: 1 },
  }), 'prior act graph persisted');
  const followUp = appendEvent({
    sessionId: sess.id, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'what are those?' },
  });
  await admitAndCompileAcceptedSource({
    identity: { sessionId: sess.id, sourceUserSeq: followUp.seq, turn: 2 },
    surface: 'dashboard',
  });
  const disposition = readSemanticDisposition(sess.id, followUp.seq);
  assert.equal(disposition?.participation, 'participated');
});

test('a pending continuity packet pays admission so the slot can settle', async () => {
  interpretCalls.length = 0;
  const sess = createSession({ kind: 'chat', channel: 'desktop', userId: 'short-circuit-user' });
  const origin = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'check my mail' },
  });
  createTaskContinuityPacket({
    sessionId: sess.id,
    originatingSourceUserSeq: origin.seq,
    pause: {
      kind: 'clarification',
      question: 'Which account should I use?',
      options: [],
    },
  });
  const greeting = appendEvent({
    sessionId: sess.id, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'hey hows it going' },
  });
  await admitAndCompileAcceptedSource({
    identity: { sessionId: sess.id, sourceUserSeq: greeting.seq, turn: 2 },
    surface: 'dashboard',
  });
  const disposition = readSemanticDisposition(sess.id, greeting.seq);
  assert.equal(disposition?.participation, 'participated',
    'an open slot is not a greeting skip — admission must see the packet');
});

test('both brain entry points ride the shared choke points (two-teeth parity pin)', async () => {
  // The short-circuit lives in prepareDurableAcceptedTurnCompile; it reaches
  // production only through recordAcceptedSourceGraph → dispatchAdmittedSource.
  // Both lanes must keep entering through those exact seams — a lane that
  // compiles or dispatches its own way silently forks the routing behavior.
  const { readFileSync } = await import('node:fs');
  for (const lane of ['../harness/loop.ts', '../harness/claude-agent-brain.ts']) {
    const source = readFileSync(new URL(lane, import.meta.url), 'utf-8');
    assert.match(source, /recordAcceptedSourceGraph\(/, `${lane} must admit through the shared compile seam`);
    assert.match(source, /dispatchAdmittedSource\(/, `${lane} must dispatch through the shared typed dispatcher`);
  }
});
