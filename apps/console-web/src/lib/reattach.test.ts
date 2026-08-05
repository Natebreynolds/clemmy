/**
 * Run: npx tsx --test apps/console-web/src/lib/reattach.test.ts
 *
 * Pins the live-run reattach predicate (2026-08-04 static window): a thread
 * reopened while its turn runs server-side must detect the in-flight turn
 * (real user input, no terminal after) and resume from it; report-back
 * synthetic turns and finished turns must not trigger reattach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inFlightTurnSince } from './useChat';

test('a user turn with no terminal after it is in flight', () => {
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'go' } },
    { seq: 2, type: 'turn_started' },
    { seq: 3, type: 'tool_called' },
  ]), 1);
});

test('a completed turn does not reattach', () => {
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'go' } },
    { seq: 2, type: 'conversation_completed' },
  ]), null);
});

test('awaiting input and approvals count as settled (the card owns the beat)', () => {
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'go' } },
    { seq: 2, type: 'awaiting_user_input' },
  ]), null);
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'go' } },
    { seq: 2, type: 'approval_requested' },
  ]), null);
});

test('synthetic report-back turns are not user turns', () => {
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'go' } },
    { seq: 2, type: 'conversation_completed' },
    { seq: 3, type: 'user_input_received', data: { synthetic: true, source: 'outcome' } },
    { seq: 4, type: 'turn_started' },
  ]), null, 'an in-flight OUTCOME processing turn belongs to the daemon, not the reopened composer');
});

test('a newer user turn supersedes an older finished one', () => {
  assert.equal(inFlightTurnSince([
    { seq: 1, type: 'user_input_received', data: { text: 'first' } },
    { seq: 2, type: 'conversation_completed' },
    { seq: 5, type: 'user_input_received', data: { text: 'second' } },
    { seq: 6, type: 'tool_called' },
  ]), 5);
});
