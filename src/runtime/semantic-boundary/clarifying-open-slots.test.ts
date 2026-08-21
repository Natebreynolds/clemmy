/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/clarifying-open-slots.test.ts
 *
 * Live converse-first (2026-08-21): Claude proposed new_goal + openSlots +
 * work:null. Admission treated that as illegal work and blocked with
 * "could not admit this turn's interpretation". Clarifying open-slots are
 * conversation, not an act plan.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-open-slots-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-open-slots\n', 'utf8');

const { appendEvent, createSession, closeEventLog, listEvents } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { readSemanticDisposition } = await import('./semantic-disposition.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { entailedPlanGroundingJudge } = await import('./fake-semantic-model.js');
import type { TurnSemanticModelPort } from './turn-semantic-model-port.js';
import type { TurnSemanticProposalV1 } from './turn-semantic-proposal.js';

test.after(() => {
  installTurnSemanticModelPort(null);
  closeEventLog();
});

const ASK = 'Clean up the Zephyr deal tracker and send the crew an update about it.';

const CLARIFYING: TurnSemanticProposalV1 = {
  version: 1,
  relation: 'new_goal',
  targetGoal: null,
  goal: {
    objective: ASK,
    criteria: [
      { id: 'tracker_cleaned', statement: 'The Zephyr deal tracker is reviewed and cleaned up.' },
      { id: 'crew_updated', statement: 'The crew receives a clear update.' },
    ],
    openSlots: [
      {
        slotKey: 'crew_definition',
        question: 'Who exactly is the crew that should receive the update?',
        options: [],
        allowFreeText: true,
      },
      {
        slotKey: 'update_channel',
        question: 'How should the update be sent?',
        options: [],
        allowFreeText: true,
      },
    ],
    candidates: [],
  },
  work: null,
  slotAnswers: [],
  rationale: 'Need alignment before any work.',
};

function clarifyingPort(): TurnSemanticModelPort {
  return {
    async interpret() {
      return {
        raw: CLARIFYING,
        modelIdentity: 'fake-semantic/open-slots',
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

installTurnSemanticModelPort(clarifyingPort());

test('clarifying open-slots admit as conversation and never fall through to an untyped act loop', async () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'open-slots-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  assert.equal(readSemanticDisposition(session.id, source.seq)?.outcome, 'admitted');
  if (compiled.ok) {
    assert.equal(compiled.compiled.graph.classification.route, 'direct_reply');
  }
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'needs_input', JSON.stringify(dispatched).slice(0, 240));
  if (dispatched.kind !== 'needs_input') return;
  assert.match(dispatched.text, /\?/);
  assert.match(dispatched.text, /crew/i);
  assert.match(dispatched.text, /zephyr deal tracker/i);
  assert.match(dispatched.text, /which system, workspace, sheet, or channel/i);
  const awaiting = listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0]?.data.question, dispatched.text);
});

const UNDERSPECIFIED_WRITE: TurnSemanticProposalV1 = {
  version: 1,
  relation: 'new_goal',
  targetGoal: null,
  goal: {
    objective: ASK,
    criteria: [
      { id: 'c1', statement: 'The tracker is cleaned.' },
      { id: 'c2', statement: 'The crew is updated.' },
    ],
    openSlots: [],
    candidates: [],
  },
  work: {
    construct: 'collect_then_construct',
    cardinality: null,
    destinations: [
      { posture: 'named_existing', family: 'deal_tracker', handleRequired: true },
      { posture: 'named_existing', family: 'crew_update_channel', handleRequired: true },
    ],
    destination: null,
    requestedEffect: 'external_write',
    operations: [],
    deliverables: [],
    evidenceRequirements: [],
  },
  slotAnswers: [],
  rationale: 'Named existing destinations with no handles are not executable work.',
};

const OPEN_SLOTS_WITH_EMPTY_WORK: TurnSemanticProposalV1 = {
  version: 1,
  relation: 'new_goal',
  targetGoal: null,
  goal: {
    objective: ASK,
    criteria: [
      { id: 'c1', statement: 'The tracker is cleaned.' },
      { id: 'c2', statement: 'The crew is updated.' },
    ],
    openSlots: [
      {
        slotKey: 'tracker_location',
        question: 'Which Zephyr deal tracker should be cleaned up?',
        options: [],
        allowFreeText: true,
      },
      {
        slotKey: 'crew_recipients',
        question: 'Who should receive the update?',
        options: [],
        allowFreeText: true,
      },
    ],
    candidates: [],
  },
  work: {
    construct: 'collect_then_construct',
    cardinality: null,
    destinations: null,
    destination: null,
    requestedEffect: 'unknown',
    operations: [],
    deliverables: [],
    evidenceRequirements: [],
  },
  slotAnswers: [],
  rationale: 'Open slots mean converse first even if a work sketch is present.',
};

const UNKNOWN_EFFECT_EMPTY_WORK: TurnSemanticProposalV1 = {
  ...OPEN_SLOTS_WITH_EMPTY_WORK,
  goal: {
    ...OPEN_SLOTS_WITH_EMPTY_WORK.goal!,
    openSlots: [],
  },
  rationale: 'Unknown effect with no operations is not executable work.',
};

const WRITE_WITHOUT_DESTINATION: TurnSemanticProposalV1 = {
  ...UNDERSPECIFIED_WRITE,
  work: {
    construct: 'collect_then_construct',
    cardinality: null,
    destinations: null,
    destination: null,
    requestedEffect: 'external_write',
    operations: [],
    deliverables: [],
    evidenceRequirements: [],
  },
  rationale: 'A write with no destination is not aligned executable work.',
};

test('a host-only structured-result sketch dispatches conversation, not a connected-app bind', async () => {
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'new_goal',
          targetGoal: null,
          goal: {
            objective: 'Return the exact structured result.',
            criteria: [
              { id: 'c1', statement: 'The marker is returned.' },
              { id: 'c2', statement: 'No other tool is called.' },
            ],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'single_act',
            cardinality: null,
            destinations: null,
            destination: null,
            requestedEffect: 'host_only',
            operations: [{
              id: 'op1',
              role: 'submit_workflow_step_result',
              requestedEffect: 'host_only',
              capabilityRef: 'workflow_step_result',
              dependsOn: [],
              evidence: [],
            }],
            deliverables: [{ id: 'd1', kind: 'structured_result' }],
            evidenceRequirements: [],
          },
          slotAnswers: [],
          rationale: 'Host-only structured output is not a connected-app bind.',
        } satisfies TurnSemanticProposalV1,
        modelIdentity: 'fake-semantic/host-only-step',
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
  });
  const session = createSession({ kind: 'workflow', channel: 'workflow', userId: 'wf-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Return the exact structured result {"marker":"CAPABILITY_PREPARED"}.' },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 300));
});

test('unknown-effect empty work parks a clarifying question, not a connection gap', async () => {
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: UNKNOWN_EFFECT_EMPTY_WORK,
        modelIdentity: 'fake-semantic/unknown-empty',
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
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'unknown-empty-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'needs_input', JSON.stringify(dispatched).slice(0, 300));
  if (dispatched.kind !== 'needs_input') return;
  assert.doesNotMatch(dispatched.text, /none of your connected apps/i);
  assert.match(dispatched.text, /zephyr deal tracker/i);
});

test('open-slots win over an empty work sketch and park a question, not a connection gap', async () => {
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: OPEN_SLOTS_WITH_EMPTY_WORK,
        modelIdentity: 'fake-semantic/slots-with-work',
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
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'slots-with-work-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  const dispatched = await dispatchAdmittedSource(identity);
  assert.equal(dispatched.kind, 'needs_input', JSON.stringify(dispatched).slice(0, 300));
  if (dispatched.kind !== 'needs_input') return;
  assert.doesNotMatch(dispatched.text, /none of your connected apps/i);
  assert.match(dispatched.text, /zephyr deal tracker/i);
  assert.match(dispatched.text, /who should receive the update/i);
});

test('a write with no destination is refused, not a conversation loop', async () => {
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: WRITE_WITHOUT_DESTINATION,
        modelIdentity: 'fake-semantic/write-no-dest',
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
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'write-no-dest-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, false, compiled.ok ? 'write with no destination must not admit' : compiled.reason);
  const dispatched = await dispatchAdmittedSource(identity);
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 300));
  assert.ok(
    dispatched.kind === 'blocked' || dispatched.kind === 'needs_input',
    JSON.stringify(dispatched).slice(0, 300),
  );
});

test('underspecified named-existing writes park a question, not a conversation loop', async () => {
  installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: UNDERSPECIFIED_WRITE,
        modelIdentity: 'fake-semantic/underspecified-write',
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
  });
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'underspecified-user' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const compiled = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  assert.equal(readSemanticDisposition(session.id, source.seq)?.outcome, 'admitted');
  const dispatched = await dispatchAdmittedSource(identity);
  assert.notEqual(dispatched.kind, 'conversation', JSON.stringify(dispatched).slice(0, 300));
  assert.equal(dispatched.kind, 'needs_input', JSON.stringify(dispatched).slice(0, 300));
  if (dispatched.kind !== 'needs_input') return;
  assert.doesNotMatch(dispatched.text, /none of your connected apps/i);
  assert.match(dispatched.text, /zephyr deal tracker/i);
  assert.match(dispatched.text, /crew/i);
  assert.match(dispatched.text, /which system, workspace, sheet, or channel/i);
  const awaiting = listEvents(session.id, { types: ['awaiting_user_input'] });
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0]?.data.question, dispatched.text);
});
