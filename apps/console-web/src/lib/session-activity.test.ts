import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SESSION_ACTIVITY, foldSessionActivity, sessionActivityLive } from './session-activity.js';
import type { HarnessEvent } from './types.js';

const ev = (seq: number, type: string, data: Record<string, unknown>, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ seq, turn: 1, role: 'agent', type, data, ...extra });

test('a session stream folds into the same rows the chat reply shows', () => {
  let s = foldSessionActivity(EMPTY_SESSION_ACTIVITY, ev(1, 'tool_called', { tool: 'web_search', callId: 'c1', args: { query: 'x' } }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].status, 'running');
  assert.equal(s.seq, 1);
  assert.ok(sessionActivityLive(s, false), 'a running row keeps the card live');
  s = foldSessionActivity(s, ev(2, 'tool_returned', { tool: 'web_search', callId: 'c1', ok: true }));
  assert.equal(s.items[0].status, 'done');
  assert.equal(s.count, 2);
  assert.equal(sessionActivityLive(s, false), false);
  assert.ok(sessionActivityLive(s, true), 'a running session keeps the card live even between rows');
});

test('bridged step-session frames fold too, and the progress line follows the newest frame that had one', () => {
  let s = foldSessionActivity(EMPTY_SESSION_ACTIVITY, ev(5, 'step_started', { step: 'collect', stepId: 'collect', title: 'Collect prospects' }, { sessionId: 'workflow:run-1:collect' }));
  assert.ok(s.progress, 'step_started carries a human line');
  const before = s.progress;
  s = foldSessionActivity(s, ev(6, 'capability_resolution', { tools: [] }, { sessionId: 'workflow:run-1:collect' }));
  assert.equal(s.progress, before, 'a frame with no line leaves the last one standing');
  assert.equal(s.seq, 6);
});

test('a malformed frame is ignored, never folded', () => {
  const s = foldSessionActivity(EMPTY_SESSION_ACTIVITY, { seq: 1 } as unknown as HarnessEvent);
  assert.equal(s.count, 0);
});
