/**
 * Run: npx tsx --test src/tools/session-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerSessionTools } = await import('./session-tools.js');
const { SessionStore } = await import('../memory/session-store.js');
const { loadSessionBrief } = await import('../memory/session-briefs.js');
const { createSession, appendEvent } = await import('../runtime/harness/eventlog.js');

type ToolResult = { content?: Array<{ text?: string }> };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredToolHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as Handler);
    },
  };
  registerSessionTools(server as never);
  return handlers;
}

function resultText(result: ToolResult): string {
  return result.content?.[0]?.text ?? '';
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('session_history prefers harness transcript and action ledger over same-id legacy ghost', async () => {
  const sessionId = 'sess-session-history-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Harness chat' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use the board-approved prospect list only.' } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'email_send', targets: ['casey@example.com'] } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Drafted the outreach and sent the Casey email.' } });

  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task bg-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  });

  const history = registeredToolHandlers().get('session_history');
  assert.ok(history);
  const text = resultText(await history!({ session_id: sessionId, max_turns: 10 }));

  assert.match(text, /ALREADY DONE/);
  assert.match(text, /email_send/);
  assert.match(text, /casey@example\.com/);
  assert.match(text, /USER: Use the board-approved prospect list only/);
  assert.match(text, /YOU: Drafted the outreach and sent the Casey email/);
  assert.doesNotMatch(text, /bg-ghost/);
});

test('session_history through_seq excludes later turns while retaining pre-bound actions', async () => {
  const sessionId = 'sess-session-history-through-seq';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Bounded history' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'HANDOFF-TURN-A-111' } });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'SHEET_UPDATE', targets: ['sheet:before-handoff-222'] },
  });
  const boundary = appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'HANDOFF-PROGRESS-333' },
  });
  appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'UNRELATED-TURN-B-444' } });
  appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'CRM_UPDATE', targets: ['record:after-handoff-555'] },
  });

  const history = registeredToolHandlers().get('session_history');
  assert.ok(history);
  const text = resultText(await history!({
    session_id: sessionId,
    max_turns: 10,
    through_seq: boundary.seq,
  }));

  assert.match(text, /HANDOFF-TURN-A-111/);
  assert.match(text, /SHEET_UPDATE/);
  assert.match(text, /sheet:before-handoff-222/);
  assert.match(text, /HANDOFF-PROGRESS-333/);
  assert.doesNotMatch(text, /UNRELATED-TURN-B-444/);
  assert.doesNotMatch(text, /CRM_UPDATE/);
  assert.doesNotMatch(text, /record:after-handoff-555/);
});

test('session_resume and session_pause prefer harness continuity over same-id legacy ghost', async () => {
  const sessionId = 'sess-session-continuity-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Harness continuity' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Resume from the canonical harness transcript only.' } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Canonical harness answer with the accepted next step.' } });

  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task bg-continuity-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  });

  const handlers = registeredToolHandlers();
  const resume = handlers.get('session_resume');
  assert.ok(resume);
  const resumeText = resultText(await resume!({ session_id: sessionId }));
  assert.match(resumeText, /Harness session resume/);
  assert.match(resumeText, /USER: Resume from the canonical harness transcript only/);
  assert.match(resumeText, /YOU: Canonical harness answer/);
  assert.doesNotMatch(resumeText, /bg-continuity-ghost/);

  const pause = handlers.get('session_pause');
  assert.ok(pause);
  await pause!({
    session_id: sessionId,
    completed: ['Recorded canonical transcript'],
    remaining: ['Continue accepted next step'],
  });

  const brief = loadSessionBrief(sessionId);
  assert.ok(brief);
  assert.match(brief!.auto.summary, /canonical harness transcript/i);
  assert.match(brief!.auto.summary, /canonical harness answer/i);
  assert.doesNotMatch(brief!.auto.summary, /bg-continuity-ghost/);
});

test('session_history still falls back to legacy SessionStore sessions', async () => {
  const sessionId = 'sess-session-history-legacy';
  const store = new SessionStore();
  store.appendTurn(sessionId, { role: 'user', text: 'Legacy question', createdAt: new Date().toISOString() });
  store.appendTurn(sessionId, { role: 'assistant', text: 'Legacy answer', createdAt: new Date().toISOString() });

  const history = registeredToolHandlers().get('session_history');
  assert.ok(history);
  const text = resultText(await history!({ session_id: sessionId, max_turns: 10 }));

  assert.match(text, /Recent transcript for sess-session-history-legacy/);
  assert.match(text, /User: Legacy question/);
  assert.match(text, /Assistant: Legacy answer/);
});

test('session_resume falls back to canonical harness history when legacy SessionStore is empty', async () => {
  const sessionId = 'sess-session-resume-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'discord', title: 'Harness resume' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Remember the approved scope: first 10 accounts only.' } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Confirmed, I will keep it to the first 10 accounts.' } });

  const resume = registeredToolHandlers().get('session_resume');
  assert.ok(resume);
  const text = resultText(await resume!({ session_id: sessionId }));

  assert.match(text, /Harness session resume/);
  assert.match(text, /USER: Remember the approved scope/);
  assert.match(text, /YOU: Confirmed/);
  assert.doesNotMatch(text, /No prior activity/);
});

test('session_pause builds harness handoff briefs from canonical harness history', async () => {
  const sessionId = 'sess-session-pause-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'discord', title: 'Harness pause' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Prepare the client risk review from the approved workspace.' } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'I gathered the source notes and flagged two review items.' } });

  const handlers = registeredToolHandlers();
  const pause = handlers.get('session_pause');
  assert.ok(pause);
  const pauseText = resultText(await pause!({
    session_id: sessionId,
    completed: ['Gathered source notes'],
    remaining: ['Confirm the two risk items'],
    decisions: ['Use the approved workspace only'],
    context: 'Resume by checking the two flagged items before drafting.',
  }));

  assert.match(pauseText, /Handoff saved/);
  const brief = loadSessionBrief(sessionId);
  assert.ok(brief);
  assert.match(brief!.auto.summary, /Prepare the client risk review/);
  assert.match(brief!.auto.summary, /gathered the source notes/i);
  assert.notEqual(brief!.auto.summary, 'No prior activity.');
  assert.equal(brief!.auto.nextStep, 'Confirm the two risk items');

  const resume = handlers.get('session_resume');
  assert.ok(resume);
  const resumeText = resultText(await resume!({ session_id: sessionId }));
  assert.match(resumeText, /Manual Context/);
  assert.match(resumeText, /Resume by checking the two flagged items/);
  assert.match(resumeText, /Canonical harness history/);
  assert.match(resumeText, /USER: Prepare the client risk review/);
  assert.match(resumeText, /YOU: I gathered the source notes/);
});
