import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOST_MODEL_STALL_BLOCKED_TEXT,
  HOST_RESULT_CHECKPOINT_BLOCKED_TEXT,
  HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT,
  HOST_TOOL_UNCERTAIN_BLOCKED_TEXT,
  hostStopNarrationDirective,
  isNarratableHostStop,
} from './host-turn-runner.js';

const blocked = (finalOutput: string) => ({ finalOutput, terminal: { status: 'blocked' as const, reason: 'x' } }) as never;

test('a host stop the model can explain is narrated by Clem, not shipped as the host sentence', () => {
  assert.equal(isNarratableHostStop(blocked(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT)), true);
  assert.equal(isNarratableHostStop(blocked(`${HOST_STOP_AND_EXPLAIN_BLOCKED_TEXT}\n\nRetained work (durable checkpoint):\n- x`)), true);
});

test('a stop about the model itself, or about bytes that must not reach a model, keeps the host sentence', () => {
  assert.equal(isNarratableHostStop(blocked(HOST_MODEL_STALL_BLOCKED_TEXT)), false);
  assert.equal(isNarratableHostStop(blocked(HOST_RESULT_CHECKPOINT_BLOCKED_TEXT)), false);
});

test('only blocked terminals are narrated', () => {
  assert.equal(isNarratableHostStop({ finalOutput: 'Done.', terminal: { status: 'completed' } } as never), false);
  assert.equal(isNarratableHostStop({ finalOutput: '', terminal: { status: 'blocked' } } as never), false);
});

test('the narration directive carries the host fact and asks for Clem\'s words with no tools and no machine terms', () => {
  const directive = hostStopNarrationDirective(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, 'tool_effect_uncertain');
  assert.ok(directive.startsWith('[turn-facts:v1]'));
  assert.ok(directive.includes(HOST_TOOL_UNCERTAIN_BLOCKED_TEXT));
  assert.match(directive, /Machine detail: tool_effect_uncertain/);
  assert.match(directive, /as yourself/);
  assert.match(directive, /Do not call tools/);
  assert.match(directive, /Do not mention the harness, checkpoints, reconciliation, tool names, ids or handles/);
});

test('narration is on in production and opt-in under the test runner, so exact model-call counts keep their meaning', async () => {
  const runner = await import('./host-turn-runner.js');
  assert.equal(typeof runner._setHostStopNarrationForTests, 'function');
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this file runs under the test runner');
});
