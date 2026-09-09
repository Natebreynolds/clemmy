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
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { createSession, appendEvent, getToolOutputForInvocation } = await import('../runtime/harness/eventlog.js');

type ToolResult = { content?: Array<{ text?: string }> };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredToolHandlers(requesterSessionId?: string, sourceUserSeq?: number): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, requesterSessionId
        ? input => withToolOutputContext({ sessionId: requesterSessionId, sourceUserSeq, toolName: name },
          () => (handler as Handler)(input)) as Promise<ToolResult>
        : handler as Handler);
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

  const history = registeredToolHandlers(sessionId).get('session_history');
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

  const history = registeredToolHandlers(sessionId).get('session_history');
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

test('session_history treats a transport-serialized null through_seq as omitted', async () => {
  const sessionId = 'sess-session-history-null-through-seq';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Null boundary' });
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'NULL-BOUNDARY-IS-UNBOUNDED' } });

  const history = registeredToolHandlers(sessionId).get('session_history');
  assert.ok(history);
  const text = resultText(await history!({
    session_id: sessionId,
    max_turns: 10,
    through_seq: null,
  }));

  assert.match(text, /NULL-BOUNDARY-IS-UNBOUNDED/);
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

test('session_pause producer preserves a full handoff for session_resume and its retained output', async () => {
  const sessionId = 'sess-full-explicit-handoff';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Website handoff' });
  const handlers = registeredToolHandlers();
  const completed = ['The first prototype is saved. Preserve its approved copy exactly.'];
  const remaining = Array.from({ length: 15 }, (_, i) => `Deliverable ${i + 1}: ${'original requirement '.repeat(30)}REQUIREMENT_END_${i + 1}`);
  const decisions = ['Use the dark design selected by the owner.', 'No deployment until requested.'];
  const context = 'Exact design brief:\n' + 'Design context\n'.repeat(160) + 'FINAL_CONTEXT_MARKER';
  await handlers.get('session_pause')!({ session_id: sessionId, completed, remaining, decisions, context });
  assert.deepEqual(loadSessionBrief(sessionId)?.manual?.remaining, remaining);
  const callId = 'full-handoff-resume';
  const settlementNonce = 'full-handoff-resume-nonce';
  await withToolOutputContext({ sessionId, callId, toolName: 'session_resume', settlementNonce },
    () => registeredToolHandlers().get('session_resume')!({ session_id: sessionId }));
  const retained = getToolOutputForInvocation(sessionId, callId, settlementNonce);
  assert.ok(retained, 'the shared formatter retains the complete tool output');
  for (const value of [...completed, ...remaining, ...decisions, context]) {
    assert.ok(retained.output.includes(value), 'every authored requirement can be recovered from the actual resume output');
  }
});

test('session_history still falls back to legacy SessionStore sessions', async () => {
  const sessionId = 'sess-session-history-legacy';
  const store = new SessionStore();
  store.appendTurn(sessionId, { role: 'user', text: 'Legacy question', createdAt: new Date().toISOString() });
  store.appendTurn(sessionId, { role: 'assistant', text: 'Legacy answer', createdAt: new Date().toISOString() });

  const history = registeredToolHandlers(sessionId).get('session_history');
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


test('exact retained-history request reads only authorized session windows and losslessly pages long completed drafts', async () => {
  const principal = 'history-owner';
  const first = createSession({ id: 'sess-history-retained-first', kind: 'chat', userId: principal });
  const second = createSession({ id: 'sess-history-retained-second', kind: 'chat', userId: principal });
  const foreign = createSession({ id: 'sess-history-other-principal', kind: 'chat', userId: 'different-owner' });
  const unnamed = createSession({ id: 'sess-history-not-requested', kind: 'chat', userId: principal });
  const requester = createSession({ id: 'sess-history-reader', kind: 'chat', userId: principal });
  appendEvent({ sessionId: first.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Unrelated synthetic conversation.' } });
  const firstEnd = appendEvent({ sessionId: first.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Unrelated synthetic reply.' } });
  const authored = appendEvent({ sessionId: second.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Compose three drafts preserving exact bytes.' } });
  const drafts = [
    { subject: 'CLEMMY-LIVE-0905-C6-2245-A', body: `Redwood appointment follow-up.\n${'Exact retained words. '.repeat(1300)}Second line stays here.` },
    { subject: 'CLEMMY-LIVE-0905-C6-2245-B', body: 'Juniper proposal follow-up: ready for review?' },
    { subject: 'CLEMMY-LIVE-0905-C6-2245-C', body: 'Willow formatting check. Keep this exact punctuation!' },
  ];
  const reply = JSON.stringify(drafts, null, 2);
  const boundary = appendEvent({ sessionId: second.id, turn: 1, role: 'system', type: 'conversation_completed', data: { sourceUserSeq: authored.seq, reply } });
  appendEvent({ sessionId: second.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'AFTER-BOUNDARY-MUST-NOT-APPEAR' } });
  appendEvent({ sessionId: foreign.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'FOREIGN-PRIVATE-TEXT' } });
  const prompt = `This is a read-only conversation-history test. Do not consult durable memory, use connectors, run shell commands, or change anything. Inspect only these two synthetic conversation windows using session_history: session_id ${first.id} through_seq ${firstEnd.seq}; session_id ${second.id} through_seq ${boundary.seq}. Find the conversation containing subject marker CLEMMY-LIVE-0905-C6-2245. Return its session ID and the exact three composed subjects and bodies as JSON, preserving the body newline and punctuation. Do not include provider IDs or any other conversations.`;
  const source = appendEvent({ sessionId: requester.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: prompt } });
  const history = registeredToolHandlers(requester.id, source.seq).get('session_history')!;
  let offset = 0;
  let snapshot: string | undefined;
  let assembled = '';
  let pages = 0;
  do {
    const result = resultText(await history({ session_id: second.id, through_seq: boundary.seq, offset_chars: offset, snapshot_sha256: snapshot }));
    assert.ok(result.length < 20_000, 'the lossless page fits the actual tool transport without a second clipping pass');
    const separator = result.indexOf('\n\n');
    const header = JSON.parse(result.slice(0, separator));
    const body = result.slice(separator + 2);
    assert.equal(body.length, header.returned_chars);
    assert.equal(header.through_seq, boundary.seq);
    if (snapshot) assert.equal(header.snapshot_sha256, snapshot);
    snapshot = header.snapshot_sha256;
    assembled += body;
    pages += 1;
    offset = header.next_offset_chars;
    assert.ok(pages < 10, 'test fixture must converge through its explicit pages');
  } while (offset !== null);
  assert.ok(pages > 1, 'the long draft actually crosses a page boundary');
  assert.ok(assembled.includes(reply), 'all three exact complete draft objects survive, including the long first body and final punctuation');
  assert.match(assembled, new RegExp(`source_seq=${authored.seq} event_seq=${boundary.seq}`));
  assert.doesNotMatch(assembled, /AFTER-BOUNDARY-MUST-NOT-APPEAR/);
  assert.match(resultText(await history({ session_id: first.id, through_seq: firstEnd.seq })), /Unrelated synthetic reply/);
  assert.match(resultText(await history({ session_id: unnamed.id })), /session_history denied/);
  const prefixSource = appendEvent({ sessionId: requester.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: `Read session_id ${unnamed.id}-different` } });
  assert.match(resultText(await registeredToolHandlers(requester.id, prefixSource.seq).get('session_history')!({ session_id: unnamed.id })), /session_history denied/,
    'a longer named session locator cannot authorize a matching prefix');
  assert.match(resultText(await history({ session_id: second.id, through_seq: boundary.seq, offset_chars: 1, snapshot_sha256: '0'.repeat(64) })), /snapshot digest/);
  assert.match(resultText(await registeredToolHandlers().get('session_history')!({ session_id: second.id })), /session_history denied/);
  const foreignSource = appendEvent({ sessionId: requester.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: `Read session_id ${foreign.id}` } });
  const denied = resultText(await registeredToolHandlers(requester.id, foreignSource.seq).get('session_history')!({ session_id: foreign.id }));
  assert.match(denied, /session_history denied/);
  assert.doesNotMatch(denied, /FOREIGN-PRIVATE-TEXT/);
});
