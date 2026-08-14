/**
 * RED PIN — low-confidence tool intent keeps conservative unknown authority
 * while affirmative reads and conversation-shaped controls stay narrow.
 *
 * Terse mobile/chat asks often omit an interrogative verb ("Inbox status",
 * "Weather in Seattle"). The intent classifier deliberately falls back to
 * `tool_intent` when unsure so Clementine can discover what she needs. Unknown
 * wording cannot safely freeze as read-only: the agent must be able to propose
 * the actual topology, while runtime tool admission retains effect authority.
 * Affirmative lookup questions remain retrieve/read, and a prohibition or
 * conversational ping requests no work at all.
 *
 * Run: npx tsx --test src/runtime/graph/tool-intent-route-authority.red.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMessageIntent } from '../../assistant/message-intent.js';
import { compileTurnGraph } from './turn-graph-compiler.js';
import type { TurnGraphPolicySnapshot } from './turn-graph-ir.js';

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

function compile(input: string) {
  return compileTurnGraph({
    identity: { sessionId: 'tool-intent-route-red', turn: 1, sourceUserSeq: 41 },
    input,
    sessionKind: 'chat',
    surface: 'mobile',
    policy: POLICY,
  });
}

test('terse unknown tool asks preserve an action route with an unknown effect ceiling', () => {
  for (const input of [
    'Weather in Seattle',
    'My schedule today',
    'Traffic to the office',
    'Inbox status',
    'Any updates from Acme',
  ]) {
    const intent = classifyMessageIntent(input);
    assert.equal(intent.intent, 'tool_intent', `fixture must exercise conservative fallback: ${input}`);
    const result = compile(input);
    assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
    assert.equal(result.graph.classification.route, 'act', input);
    assert.equal(result.graph.effectCeiling, 'unknown', input);
    assert.equal(result.graph.fastPath, 'single_action', input);
    assert.ok(result.graph.nodes.some((node) => node.kind === 'capability_resolve'), input);
    assert.ok(result.graph.nodes.some((node) => node.kind === 'execute'), input);
    assert.equal(result.graph.nodes.some((node) => node.kind === 'retrieve'), false, input);
  }
});

test('an explicitly supplied tool_intent signal cannot be collapsed to a read', () => {
  const result = compileTurnGraph({
    identity: { sessionId: 'tool-intent-signal-red', turn: 1, sourceUserSeq: 42 },
    input: 'opaque request text',
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
    signals: {
      intent: { intent: 'tool_intent', confidence: 0.45, reasons: ['upstream tool need'] },
    },
  });
  assert.equal(result.graph.classification.route, 'act');
  assert.equal(result.graph.effectCeiling, 'unknown');
});

test('conversation, prohibitions, and non-request action mentions stay direct and effect-free', () => {
  for (const input of [
    'hello',
    'ping',
    'hmm interesting',
    'No, do not send it.',
    'The plan is to deploy this later.',
    "We're considering deleting the old draft.",
  ]) {
    const result = compile(input);
    assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
    assert.equal(result.graph.classification.route, 'direct_reply', input);
    assert.equal(result.graph.effectCeiling, 'none', input);
    assert.equal(result.graph.fastPath, 'direct_reply', input);
    assert.equal(result.graph.nodes.some((node) => node.kind === 'retrieve'), false, input);
    assert.equal(result.graph.nodes.some((node) => node.kind === 'execute'), false, input);
  }
});
