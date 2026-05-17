/**
 * Run: npx tsx --test src/channels/discord-harness.test.ts
 *
 * applyEventToState is the pure heart of the Discord live-edit loop:
 * harness events come in, the display state mutates, the renderer
 * paints. Driving real Discord.js or actionBus from a unit test is
 * not worth it — but the state machine is.
 *
 * These tests anchor the contract so the surface we ship doesn't
 * silently regress: which events advance the summary, which events
 * change just the status line, which events mark the reply done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from '../runtime/harness/eventlog.js';
import { applyEventToState } from './discord-harness.js';

function freshState() {
  return { summary: '', status: 'starting', done: false };
}

function event(type: EventRow['type'], data: Record<string, unknown> = {}): EventRow {
  return {
    seq: 1,
    id: 'ev-test',
    sessionId: 'sess-test',
    turn: 1,
    role: 'system',
    type,
    parentEventId: null,
    idemKey: null,
    data,
    createdAt: '2026-05-17T12:00:00.000Z',
  };
}

test('turn_started → "thinking…" status only', () => {
  const s = freshState();
  applyEventToState(event('turn_started'), s);
  assert.equal(s.status, 'thinking…');
  assert.equal(s.summary, '');
  assert.equal(s.done, false);
});

test('tool_called → "using <name>"', () => {
  const s = freshState();
  applyEventToState(event('tool_called', { tool: 'read_file' }), s);
  assert.equal(s.status, 'using read_file');
  assert.equal(s.done, false);
});

test('handoff → "→ <target>"', () => {
  const s = freshState();
  applyEventToState(event('handoff', { to: 'Executor' }), s);
  assert.equal(s.status, '→ Executor');
});

test('conversation_step updates the summary and step counter', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_step', {
      step: 2,
      decision: { summary: 'handed off to Executor for the scrape', done: false, nextAction: 'awaiting_handoff_result' },
    }),
    s,
  );
  assert.equal(s.summary, 'handed off to Executor for the scrape');
  assert.equal(s.status, 'step 2');
  assert.equal(s.done, false);
});

test('approval_requested surfaces the subject without marking done', () => {
  const s = freshState();
  applyEventToState(event('approval_requested', { subject: 'deploy to prod', tool: 'request_approval' }), s);
  assert.equal(s.status, 'approval required: deploy to prod');
  assert.equal(s.done, false);
});

test('approval_requested falls back to tool name when no subject', () => {
  const s = freshState();
  applyEventToState(event('approval_requested', { tool: 'cx_zendesk_create_ticket' }), s);
  assert.equal(s.status, 'approval required: cx_zendesk_create_ticket');
});

test('awaiting_user_input promotes the question to the summary and marks done', () => {
  const s = freshState();
  applyEventToState(event('awaiting_user_input', { question: 'which environment?' }), s);
  assert.equal(s.summary, 'which environment?');
  assert.equal(s.status, 'awaiting reply');
  assert.equal(s.done, true);
});

test('conversation_completed promotes summary, marks done, "complete" status', () => {
  const s = { summary: 'older summary', status: 'step 3', done: false };
  applyEventToState(
    event('conversation_completed', { summary: 'all 20 emails scheduled for 2pm daily', steps: 4 }),
    s,
  );
  assert.equal(s.summary, 'all 20 emails scheduled for 2pm daily');
  assert.equal(s.status, 'complete');
  assert.equal(s.done, true);
});

test('conversation_completed with abandoned reason marks "abandoned" status', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_completed', {
      summary: 'cannot proceed without admin role',
      reason: 'abandoned_by_orchestrator',
    }),
    s,
  );
  assert.equal(s.status, 'abandoned');
  assert.equal(s.done, true);
});

test('run_failed shows the error and marks done', () => {
  const s = freshState();
  applyEventToState(event('run_failed', { error: 'composio catalog timeout' }), s);
  assert.match(s.summary, /composio catalog timeout/);
  assert.equal(s.status, 'failed');
  assert.equal(s.done, true);
});

test('conversation_limit_exceeded surfaces the reason and marks done', () => {
  const s = freshState();
  applyEventToState(event('conversation_limit_exceeded', { reason: 'wall_clock', steps: 12 }), s);
  assert.equal(s.status, 'stopped: wall_clock');
  assert.equal(s.done, true);
});

test('unknown event types are no-ops (state untouched)', () => {
  const s = { summary: 'still here', status: 'mid-flight', done: false };
  applyEventToState(event('heartbeat'), s);
  applyEventToState(event('plan_drafted'), s);
  assert.deepEqual(s, { summary: 'still here', status: 'mid-flight', done: false });
});

test('summary persists across steps when a later event lacks one', () => {
  const s = freshState();
  applyEventToState(
    event('conversation_step', {
      step: 1,
      decision: { summary: 'researched accounts', done: false, nextAction: 'awaiting_handoff_result' },
    }),
    s,
  );
  // Next event has no summary — it should leave the previous one intact.
  applyEventToState(event('tool_called', { tool: 'write_file' }), s);
  assert.equal(s.summary, 'researched accounts');
  assert.equal(s.status, 'using write_file');
});
