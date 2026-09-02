/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-step-effect.test.ts
 *
 * ONE structured-call side-effect classifier (2026-09-01 census, D3): the
 * validator's exported copy and workflow-enforce's private copy disagreed on
 * a read-evidence slug the author declared write — consent and a receipt on
 * one path, "safe to re-run on crash" and loop-eligible on the other, for the
 * same step. Both paths now answer through one function.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { structuredCallSideEffectClass } = await import('./workflow-step-effect.js');
const validator = await import('./workflow-validator.js');
const enforce = await import('./workflow-enforce.js');

test('a read-evidence slug declared write is a write on every path', () => {
  const step = { id: 's', prompt: '', call: { tool: 'SLACK_FETCH_CONVERSATION_HISTORY' }, sideEffect: 'write' };
  assert.equal(structuredCallSideEffectClass(step), 'write');
  assert.equal(validator.structuredCallSideEffectClass(step), 'write');
  assert.equal(enforce.classifyStepSideEffect(step), 'write');
});

test('send is a property of the operation: a label never fabricates one and never hides one', () => {
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'OUTLOOK_CREATE_DRAFT' }, sideEffect: 'send' }), 'send');
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'SLACK_FETCH_CONVERSATION_HISTORY' }, sideEffect: 'send' }), 'send');
  // A read verb is never a send, whatever the slug's nouns say.
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'TWITTER_GET_POST' } }), 'read');
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'TWITTER_GET_POST' }, sideEffect: 'read' }), 'read');
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'OUTLOOK_SEND_EMAIL' }, sideEffect: 'read' }), 'send');
  assert.equal(enforce.classifyStepSideEffect({ id: 's', prompt: '', call: { tool: 'OUTLOOK_SEND_EMAIL' }, sideEffect: 'read' }), 'send');
});

test('no verb evidence honours a declared read; undeclared stays a conservative write', () => {
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'SLACK_CONVERSATIONS_HISTORY' }, sideEffect: 'read' }), 'read');
  assert.equal(structuredCallSideEffectClass({ call: { tool: 'SLACK_CONVERSATIONS_HISTORY' } }), 'write');
  assert.equal(validator.structuredCallSideEffectClass({ id: 's', prompt: '', call: { tool: 'SLACK_CONVERSATIONS_HISTORY' }, sideEffect: 'read' }), 'read');
});
