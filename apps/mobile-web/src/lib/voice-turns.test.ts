/**
 * The phone's copy of voice mode's reading rules. A notice terminal is the
 * app's status for a turn no model spoke for: it is never read aloud.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceReadableText, voiceTurnNoticeFacts, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage } from './voice-turns.js';

const clem = (id: string, text: string, status: string, extra: Partial<VoiceChatMessage> = {}): VoiceChatMessage =>
  ({ id, role: 'assistant', text, status, ...extra });

test('phone: Clem’s answer is read, a notice terminal never is', () => {
  const answer = clem('a1', 'Added milk.', 'complete');
  const notice = clem('n1', 'The model account is out of credit.', 'failed', { terminal: { notice: { code: 'provider_out_of_credit' } } });
  assert.deepEqual(voiceUtterances([answer, notice], new Map(), new Set()).map((u) => u.text), ['Added milk.']);
  assert.equal(voiceReadableText(notice), '');
  const [queued] = voiceUtterances([answer], new Map(), new Set());
  assert.equal(voiceUtteranceCurrent(queued!, [{ ...answer, terminal: { notice: { code: 'model_stalled' } } }]), false);
});

test('phone: a draft held for its format is read, and a notice turn gives the voice its typed fact', () => {
  const draft = 'Here is the summary as one object, though one office may be missing.';
  const held = clem('f1', draft, 'failed', { terminal: { status: 'blocked', notice: { code: 'response_format_unmet' } } });
  assert.equal(voiceReadableText(held), draft);
  const [utterance] = voiceUtterances([held], new Map(), new Set());
  assert.equal(utterance?.text, draft);
  assert.equal(voiceUtteranceCurrent(utterance!, [held]), true);

  const stalled = clem('n1', '', 'failed', { terminal: { status: 'failed', notice: { code: 'model_stalled', model: 'Vendor V4' } } });
  const [fact] = voiceTurnNoticeFacts([{ id: 'u1', role: 'user', text: 'go' }, stalled], 1);
  assert.match(fact!, /model_stalled \(model: Vendor V4\)/);
  assert.match(fact!, /Try again/);
  assert.deepEqual(voiceTurnNoticeFacts([clem('n2', '', 'stopped', { terminal: { notice: { code: 'stopped' } } })], 0), []);
});

test('phone: a lost continuation is neither spoken nor sent to a live voice narrator', () => {
  const held = clem('held', 'Clem can’t resume this request from where it stopped.', 'failed',
    { terminal: { status: 'blocked', resumable: true, notice: { code: 'continuation_unavailable' } } });
  assert.equal(voiceReadableText(held), '');
  assert.deepEqual(voiceUtterances([held], new Map(), new Set()), []);
  assert.deepEqual(voiceTurnNoticeFacts([held], 0), []);
  const [queued] = voiceUtterances([clem('held', 'Working on the draft.', 'complete')], new Map(), new Set());
  assert.ok(queued);
  assert.equal(voiceUtteranceCurrent(queued!, [held]), false);
});
