/**
 * Run: npx tsx --test src/runtime/harness/session-transcript.test.ts
 *
 * The conversation-history primitive behind the Claude-brain multi-turn fix
 * (2026-06-22). The brain writes user_input_received + conversation_completed to
 * the event log; this reads them back as chronological prior turns and renders the
 * USER:/YOU: block injected into the brain prompt. Validates: ordering, the
 * reply→summary fallback, the per-turn trim, and that an empty session yields an
 * empty block (so the brain's no-history path is byte-identical).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-transcript-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pullRecentTurnsForSession, renderTranscriptTurns } = await import('./session-transcript.js');
const { resetEventLog, createSession, appendEvent, openEventLog } = await import('./eventlog.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const userMsg = (sid: string, text: string) =>
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
const asstMsg = (sid: string, fields: Record<string, unknown>) =>
  appendEvent({ sessionId: sid, turn: 1, role: 'Clem', type: 'conversation_completed', data: fields });

test('pulls prior turns chronologically (user → assistant → user)', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  userMsg(sid, 'create a one-pager on everything that shipped');
  asstMsg(sid, { summary: 'Built "Off Your Plate" one-pager.' });
  userMsg(sid, 'I meant Clementine app releases');
  const turns = pullRecentTurnsForSession(openEventLog(), sid, 6);
  assert.deepEqual(turns.map((t) => t.who), ['user', 'assistant', 'user']);
  assert.equal(turns[0].text, 'create a one-pager on everything that shipped');
  assert.equal(turns[2].text, 'I meant Clementine app releases');
});

test('assistant text prefers reply, falls back to summary', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  asstMsg(sid, { summary: 'summary-only field' });
  asstMsg(sid, { summary: 'internal summary ignored', reply: 'reply wins' });
  const turns = pullRecentTurnsForSession(openEventLog(), sid, 6);
  assert.equal(turns[0].text, 'summary-only field');
  assert.equal(turns[1].text, 'reply wins');
});

test('renderTranscriptTurns formats USER:/YOU: lines and trims long turns to 800', () => {
  const long = 'x'.repeat(900);
  const block = renderTranscriptTurns([
    { who: 'user', text: 'hello' },
    { who: 'assistant', text: long },
  ]);
  assert.match(block, /^ {2}USER: hello$/m);
  assert.match(block, / {2}YOU: x{800}…$/m);
  assert.ok(!block.includes('x'.repeat(801)), 'trimmed to 800 chars + ellipsis');
});

test('empty session → no turns → empty block (brain no-history path is byte-identical)', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  const turns = pullRecentTurnsForSession(openEventLog(), sid, 6);
  assert.equal(turns.length, 0);
  assert.equal(renderTranscriptTurns(turns), '');
});

test('caps to the most recent 2*maxTurns events', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  for (let i = 0; i < 10; i++) { userMsg(sid, `u${i}`); asstMsg(sid, { summary: `a${i}` }); }
  const turns = pullRecentTurnsForSession(openEventLog(), sid, 3);
  assert.ok(turns.length <= 6, `capped to <=2*maxTurns, got ${turns.length}`);
  assert.equal(turns[turns.length - 1].text, 'a9', 'keeps the NEWEST turns');
});
