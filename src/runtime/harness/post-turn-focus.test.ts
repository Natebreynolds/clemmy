/**
 * Run: npx tsx --test src/runtime/harness/post-turn-focus.test.ts
 *
 * Behavioral half of the all-brain parity guard: every model lane calls
 * runPostTurnHooks, so a collaborative thread must become resumable through
 * this seam without depending on a particular provider's loop.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-post-turn-focus-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  appendEvent,
  closeEventLog,
  createSession,
  resetEventLog,
} = await import('./eventlog.js');
const { resetMemoryDb } = await import('../../memory/db.js');
const { getActiveFocus, getFocusWorkstate } = await import('../../memory/focus.js');
const { runPostTurnHooks } = await import('./post-turn.js');

beforeEach(() => {
  closeEventLog();
  resetEventLog();
  resetMemoryDb();
});

after(() => {
  closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the shared post-turn seam auto-focuses sustained collaboration on any chat provider', () => {
  const session = createSession({
    id: 'sess-provider-neutral-meals',
    kind: 'chat',
    channel: 'discord',
    title: 'Weeknight meal planning',
  });
  const turns = [
    ['Help me compare easy vegetarian dinners for next week.', 'Let’s compare a few recipes before choosing.'],
    ['What about black bean tacos on Monday?', 'Black bean tacos are a strong Monday option.'],
    ['I like that, and I also want a mild curry.', 'We’re narrowing this to tacos and a mild curry.'],
  ] as const;

  turns.forEach(([message, reply], index) => {
    appendEvent({
      sessionId: session.id,
      turn: index + 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: message },
    });
    runPostTurnHooks({
      sessionId: session.id,
      turn: index + 1,
      userInput: message,
      recallIds: [],
      replyText: reply,
    });
    if (index < 2) assert.equal(getActiveFocus(), null, 'one or two turns stay conversational');
  });

  const focus = getActiveFocus();
  assert.ok(focus, 'the third connected turn becomes resumable');
  assert.equal(focus?.resource_ref, `session:${session.id}`);
  assert.equal(focus?.related_session_id, session.id);
  assert.equal(getFocusWorkstate(focus), null, 'the safety net never invents a plan or decisions');
});

test('the shared post-turn seam never auto-focuses worker/execution chatter', () => {
  const session = createSession({
    id: 'execution-not-a-conversation',
    kind: 'execution',
    channel: 'background',
    title: 'Worker run',
  });
  for (let index = 0; index < 4; index += 1) {
    const message = `Continue processing batch item ${index + 1}.`;
    appendEvent({
      sessionId: session.id,
      turn: index + 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: message },
    });
    runPostTurnHooks({
      sessionId: session.id,
      turn: index + 1,
      userInput: message,
      recallIds: [],
      replyText: `Processed batch item ${index + 1}.`,
    });
  }
  assert.equal(getActiveFocus(), null);
});
