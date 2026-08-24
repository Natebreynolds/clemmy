import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInputItem, Model, ModelRequest } from '@openai/agents-core';
import {
  ConversationProtocolBoundaryAssertionError,
  assertConversationProtocolAtProviderBoundary,
  withConversationProtocolBoundaryAssertion,
} from './conversation-protocol-boundary.js';

const BOUNDARIES = [
  'codex.responses',
  'claude.messages',
  'claude.headless',
  'claude.agent_sdk',
  'byo.openai_compatible:glm-5',
  'byo.openai_compatible:kimi-k2.5',
] as const;

function malformedHistory(): AgentInputItem[] {
  return [
    {
      type: 'function_call',
      callId: 'call-open',
      name: 'records_search',
      arguments: '{}',
      status: 'completed',
    },
    { role: 'user', content: 'fresh source must not cross the open frame' },
  ] as AgentInputItem[];
}

function request(input: AgentInputItem[] | string): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as ModelRequest;
}

test('all provider families throw the same internal assertion before dispatch', async () => {
  for (const boundary of BOUNDARIES) {
    let dispatched = 0;
    const inner = {
      async getResponse() {
        dispatched += 1;
        return { output: [], usage: {} };
      },
      async *getStreamedResponse() {
        dispatched += 1;
      },
    } as unknown as Model;
    const wrapped = withConversationProtocolBoundaryAssertion(inner, boundary);

    await assert.rejects(
      () => wrapped.getResponse(request(malformedHistory())),
      (error: unknown) => error instanceof ConversationProtocolBoundaryAssertionError
        && error.boundary === boundary
        && !('userMessage' in error),
    );
    await assert.rejects(async () => {
      for await (const _event of wrapped.getStreamedResponse(request(malformedHistory()))) {
        // no event can cross the assertion
      }
    }, ConversationProtocolBoundaryAssertionError);
    assert.equal(dispatched, 0, `${boundary} must not reach network/subprocess adapter`);
  }
});

test('provider assertion is byte/reference preserving and accepts role-only prompts', () => {
  const history = Object.freeze([
    Object.freeze({ role: 'user', content: 'hello' }) as AgentInputItem,
    Object.freeze({ role: 'assistant', content: 'hi', status: 'completed' }) as AgentInputItem,
  ]);
  const before = JSON.stringify(history);

  for (const boundary of BOUNDARIES) {
    assert.doesNotThrow(() => assertConversationProtocolAtProviderBoundary(history, boundary));
    assert.doesNotThrow(() => assertConversationProtocolAtProviderBoundary('single prompt', boundary));
  }
  assert.equal(JSON.stringify(history), before);
});

test('provider assertion rejects call/result name identity drift', () => {
  const history = [
    {
      type: 'function_call',
      callId: 'call-name',
      name: 'records_search',
      arguments: '{}',
      status: 'completed',
    },
    {
      type: 'function_call_result',
      callId: 'call-name',
      name: 'records_create',
      output: { type: 'text', text: '{}' },
      status: 'completed',
    },
  ] as AgentInputItem[];

  assert.throws(
    () => assertConversationProtocolAtProviderBoundary(history, 'codex.responses'),
    (error: unknown) => error instanceof ConversationProtocolBoundaryAssertionError
      && error.issues.some((issue) => issue.code === 'function_result_identity_mismatch'),
  );
});
