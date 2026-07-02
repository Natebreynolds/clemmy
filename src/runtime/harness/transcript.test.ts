/**
 * Run: npx tsx --test src/runtime/harness/transcript.test.ts
 *
 * Contracts for reading a harness session back into a clean transcript:
 *   - humanHarnessText unwraps string / JSON-string / object payloads
 *   - reconstructHarnessTranscript orders user/assistant turns and skips empties
 *
 * Isolated via per-test CLEMENTINE_HOME.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-transcript-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { humanHarnessText, reconstructHarnessTranscript } = await import('./transcript.js');
const { createSession, appendEvent } = await import('./eventlog.js');

test('humanHarnessText unwraps strings, JSON strings, and objects', () => {
  assert.equal(humanHarnessText('plain text'), 'plain text');
  assert.equal(humanHarnessText({ reply: 'hi there' }), 'hi there');
  assert.equal(humanHarnessText({ summary: 'a summary' }), 'a summary');
  assert.equal(humanHarnessText({ reply: 'r', summary: 's' }), 'r'); // reply preferred
  assert.equal(humanHarnessText('{"reply":"json reply"}'), 'json reply');
  assert.equal(humanHarnessText(null, 'fallback'), 'fallback');
  assert.equal(humanHarnessText('', 'fallback'), 'fallback');
});

test('reconstructHarnessTranscript orders turns and skips empty assistant turns', () => {
  const session = createSession({ kind: 'chat', title: 'test' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'first question' } });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'first answer' } });
  appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'second question' } });
  // A reason-only completion with no reply/summary → skipped.
  appendEvent({ sessionId: session.id, turn: 2, role: 'system', type: 'conversation_completed', data: {} });
  // Empty user input → skipped.
  appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received', data: { text: '   ' } });

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.text}`),
    ['user:first question', 'assistant:first answer', 'user:second question'],
  );
});

test('reconstructHarnessTranscript skips synthetic outcome/directive user turns', () => {
  const session = createSession({ kind: 'chat', title: 'test' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'run the SEO check' } });
  // Synthetic report-back turn injected by runtime/outcome.ts — machine input.
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: '[background task bg-7 completed] SEO check\n\nRanked #3.', synthetic: true, source: 'outcome' },
  });
  // Synthetic proactive directive — also machine input.
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'A background task you started from this conversation just finished. Relay the outcome to the user NOW…', synthetic: true, source: 'outcome' },
  });
  appendEvent({ sessionId: session.id, turn: 2, role: 'system', type: 'conversation_completed', data: { reply: 'You rank #3 — nice.' } });

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.text}`),
    ['user:run the SEO check', 'assistant:You rank #3 — nice.'],
    'the real user turn + assistant reply render; both synthetic turns are hidden',
  );
});
