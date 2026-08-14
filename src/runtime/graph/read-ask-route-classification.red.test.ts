/**
 * RED: one shared typed effect decision — routing tier.
 *
 * "What's on my plate today?" is read/retrieve work: the user asks for the
 * current state of their world, tools are needed only to READ it, and a
 * model-composed summary IS the response. Classifying it as an ACTION turn
 * (via the tool_intent fallback) drags a plain read ask through the action
 * machinery: expected-work activation, the work_call-only carrier surface,
 * and a contract freezer that then demands non-read work that was never
 * asked for (live 2026-08-11). A bare "ping" is not action work either.
 *
 * These pins target the compiled classification, the durable authority every
 * downstream seam (admission, carrier surface, contract freezer, terminal
 * preparation) reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileTurnGraph,
  type CompileTurnGraphInput,
} from './turn-graph-compiler.js';
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

function compile(
  input: string,
  overrides: Partial<CompileTurnGraphInput> = {},
) {
  return compileTurnGraph({
    identity: { sessionId: 'read-ask-route-red', turn: 1, sourceUserSeq: 41 },
    input,
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
    ...overrides,
  });
}

test("\"what's on my plate today?\" classifies as read/retrieve work, never as an action", () => {
  const result = compile("What's on my plate today?");
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(
    result.graph.classification.route,
    'retrieve',
    `a today/plate read ask must take the read/retrieve route, not `
    + `'${result.graph.classification.route}' `
    + `(intent '${String(result.graph.classification.messageIntent)}')`,
  );
  assert.equal(
    result.graph.effectCeiling,
    'read',
    'reading today\'s state carries a read effect ceiling, not an action ceiling',
  );
});

test('"anything new in my inbox today?" classifies as read/retrieve work, never as an action', () => {
  const result = compile('anything new in my inbox today?');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(
    result.graph.classification.route,
    'retrieve',
    `an inbox-check read ask must take the read/retrieve route, not `
    + `'${result.graph.classification.route}' `
    + `(intent '${String(result.graph.classification.messageIntent)}')`,
  );
  assert.equal(
    result.graph.effectCeiling,
    'read',
    'checking for new mail is a read, not an unknown-effect action',
  );
});

test('"ping" never classifies as action work', () => {
  const result = compile('ping');
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.notEqual(
    result.graph.classification.route,
    'act',
    'a bare conversational ping must not enter the action machinery '
    + `(got route '${result.graph.classification.route}', `
    + `effectCeiling '${result.graph.effectCeiling}')`,
  );
});
