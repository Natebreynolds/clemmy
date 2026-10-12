/**
 * The phone's copy of voice mode's reading rules. A notice terminal is the
 * app's status for a turn no model spoke for: it is never read aloud.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceReadableText, voiceUtterances, voiceUtteranceCurrent, type VoiceChatMessage } from './voice-turns.js';

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
