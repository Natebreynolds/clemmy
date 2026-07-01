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

const {
  pullRecentTurnsForSession,
  renderRecentActionsForHarnessHistory,
  renderCrossSessionPrefixesForModel,
  renderSessionHistoryForModel,
  renderTranscriptTurns,
  renderRecentSessionActions,
} = await import('./session-transcript.js');
const { resetEventLog, createSession, appendEvent, openEventLog } = await import('./eventlog.js');
const { SessionStore } = await import('../../memory/session-store.js');

test('renderRecentSessionActions surfaces this session\'s completed sends so the brain knows it already did them', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  for (const t of ['chris@macgilliswiemer.com', 'jhintermeister@okoonlaw.com', 'marvinm@mitchelldickmcnelis.com']) {
    appendEvent({ sessionId: sid, turn: 1, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', targets: [t] } });
  }
  const block = renderRecentSessionActions(openEventLog(), sid);
  assert.match(block, /ALREADY DONE/);
  assert.match(block, /Do NOT repeat/i);
  for (const t of ['chris@macgilliswiemer.com', 'jhintermeister@okoonlaw.com', 'marvinm@mitchelldickmcnelis.com']) {
    assert.ok(block.includes(t), `${t} must be listed as already-sent`);
  }
  // Dedup: a repeated external_write for the same target appears once.
  appendEvent({ sessionId: sid, turn: 1, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', targets: ['chris@macgilliswiemer.com'] } });
  const block2 = renderRecentSessionActions(openEventLog(), sid);
  assert.equal((block2.match(/chris@macgilliswiemer\.com/g) ?? []).length, 1, 'deduped by (shape, target)');
});

test('renderRecentSessionActions does not call compensated failed writes already done', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid, turn: 1, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write_failed', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });

  const block = renderRecentSessionActions(openEventLog(), sid);

  assert.equal(block, '', 'a demonstrably failed dispatch must not be presented to the brain as succeeded');
});

test('renderRecentSessionActions keeps a later successful retry after an earlier compensated failure', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid, turn: 1, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write_failed', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: sid, turn: 2, role: 'tool', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });

  const block = renderRecentSessionActions(openEventLog(), sid);

  assert.match(block, /ALREADY DONE/);
  assert.equal((block.match(/casey@example\.com/g) ?? []).length, 1);
});

test('renderRecentSessionActions is empty when nothing was sent (byte-identical no-op)', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'hi' } });
  assert.equal(renderRecentSessionActions(openEventLog(), sid), '');
});

test('renderSessionHistoryForModel keeps cross-session continuation context with current-session transcript', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat', channel: 'discord', title: 'fresh split' }).id;
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      text: [
        '[CONTINUATION CONTEXT]',
        '  USER: Use the board-approved prospect list only.',
        '  YOU: I queued the first 10 for review.',
      ].join('\n'),
    },
  });
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go ahead with those' } });

  const history = renderSessionHistoryForModel(sid, 10, 12_000);

  assert.match(history, /\[CONTINUATION CONTEXT\]/);
  assert.match(history, /board-approved prospect list only/);
  assert.match(history, /USER: go ahead with those/);
});

test('renderSessionHistoryForModel aggregates sibling workflow-step sessions for cross-model parity', () => {
  resetEventLog();
  const step1 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Parity Flow::step-1',
    metadata: { workflowRunId: 'wf-parity', workflowName: 'Parity Flow', stepId: 'step-1' },
  });
  appendEvent({ sessionId: step1.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Collect source notes for the brief.' } });
  appendEvent({ sessionId: step1.id, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'DOC_UPDATE', targets: ['doc:brief-source'] } });
  appendEvent({ sessionId: step1.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Step one gathered source notes.' } });
  const step2 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Parity Flow::step-2',
    metadata: { workflowRunId: 'wf-parity', workflowName: 'Parity Flow', stepId: 'step-2' },
  });
  appendEvent({ sessionId: step2.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Step two produced the final brief.' } });

  const history = renderSessionHistoryForModel(step2.id, 10, 12_000);

  assert.match(history, /ALREADY DONE in THIS workflow run/);
  assert.match(history, /DOC_UPDATE/);
  assert.match(history, /doc:brief-source/);
  assert.match(history, /workflow run wf-parity/);
  assert.match(history, /USER: Collect source notes/);
  assert.match(history, /YOU: Step one gathered source notes/);
  assert.match(history, /YOU: Step two produced the final brief/);
});

test('renderSessionHistoryForModel aggregates workflow sibling continuation prefixes for model switches', () => {
  resetEventLog();
  const step1 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Prefix Flow::step-1',
    metadata: { workflowRunId: 'wf-prefix-parity', workflowName: 'Prefix Flow', stepId: 'step-1' },
  });
  appendEvent({
    sessionId: step1.id,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      text: [
        '[CONTINUATION CONTEXT]',
        '  USER: Use the approved Mattermost thread only.',
        '  YOU: I confirmed the background run should continue from that thread.',
      ].join('\n'),
    },
  });
  const step2 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Prefix Flow::step-2',
    metadata: { workflowRunId: 'wf-prefix-parity', workflowName: 'Prefix Flow', stepId: 'step-2' },
  });
  appendEvent({ sessionId: step2.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Step two kept working from the approved thread.' } });

  const prefixes = renderCrossSessionPrefixesForModel(openEventLog(), step2.id, 4);
  const history = renderSessionHistoryForModel(step2.id, 10, 12_000);

  assert.match(prefixes, /approved Mattermost thread only/);
  assert.match(history, /\[CONTINUATION CONTEXT\]/);
  assert.match(history, /approved Mattermost thread only/);
  assert.match(history, /YOU: Step two kept working from the approved thread/);
});

test('renderSessionHistoryForModel suppresses pure same-id legacy outcome ghosts for harness sessions', () => {
  resetEventLog();
  const sessionId = 'empty-harness-with-outcome-ghost';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Empty harness row' });
  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task bg-ghost completed] stale synthetic report-back only GHOST-SUCCESS-123',
    createdAt: new Date().toISOString(),
  }, 'user-ghost', 'desktop');

  const history = renderSessionHistoryForModel(sessionId, 10, 12_000);

  assert.equal(history, '');
});

test('renderSessionHistoryForModel still falls back to real legacy text for empty harness rows', () => {
  resetEventLog();
  const sessionId = 'empty-harness-with-real-legacy';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Migration row' });
  new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: 'Please remember REAL-LEGACY-555 for this migrated chat.',
    createdAt: new Date().toISOString(),
  }, 'user-real', 'desktop');

  const history = renderSessionHistoryForModel(sessionId, 10, 12_000);

  assert.match(history, /REAL-LEGACY-555/);
});

test('renderRecentActionsForHarnessHistory aggregates sibling workflow-step action ledgers', () => {
  resetEventLog();
  const step1 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Action Flow::step-1',
    metadata: { workflowRunId: 'wf-action-parity', workflowName: 'Action Flow', stepId: 'step-1' },
  });
  appendEvent({ sessionId: step1.id, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  const step2 = createSession({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Action Flow::step-2',
    metadata: { workflowRunId: 'wf-action-parity', workflowName: 'Action Flow', stepId: 'step-2' },
  });

  const actions = renderRecentActionsForHarnessHistory(openEventLog(), step2.id);

  assert.match(actions, /ALREADY DONE in THIS workflow run/);
  assert.match(actions, /OUTLOOK_SEND_EMAIL/);
  assert.match(actions, /casey@example\.com/);
});

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

test('unpaired awaiting_user_input questions are assistant turns in replay', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  userMsg(sid, 'deploy the site');
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Which environment should I deploy to?' },
  });

  const turns = pullRecentTurnsForSession(openEventLog(), sid, 6);

  assert.deepEqual(turns.map((t) => t.who), ['user', 'assistant']);
  assert.equal(turns[1].text, 'Which environment should I deploy to?');
});

test('paired awaiting_user_input plus conversation_completed is not double-rendered', () => {
  resetEventLog();
  const sid = createSession({ kind: 'chat' }).id;
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: { question: 'Which account should I use?' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', reply: 'Which account should I use?' },
  });

  const turns = pullRecentTurnsForSession(openEventLog(), sid, 6);

  assert.deepEqual(turns.map((t) => t.text), ['Which account should I use?']);
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

test('renderTranscriptTurns NEUTRALIZES a tool-call-shaped ASSISTANT turn (kills the narration-replay loop)', () => {
  // ROOT CAUSE (2026-07-01): a prior narrated reply must NOT replay as a YOU: exemplar the
  // model then mimics. Both the within-session history and the cross-session prefix go through
  // this one function, so this single filter covers every replay path.
  const block = renderTranscriptTurns([
    { who: 'user', text: 'whats on my calendar' },
    { who: 'assistant', text: '{"tool_call":{"name":"composio_search_tools","arguments":{"query":"outlook calendar"}}}' },
    { who: 'user', text: 'and tomorrow?' },
    { who: 'assistant', text: '[Tool: OUTLOOK_OUTLOOK_GET_CALENDAR_VIEW]' },
  ]);
  // The raw tool-call syntax must be gone — replaced with a neutral marker.
  assert.ok(!block.includes('tool_call'), 'the {"tool_call":…} JSON is not replayed');
  assert.ok(!block.includes('[Tool:'), 'the [Tool: …] reference is not replayed');
  assert.match(block, / {2}YOU: \(took a tool action\)/);
  // A USER turn that merely mentions the words is untouched (only assistant turns are sanitized).
  assert.match(block, / {2}USER: whats on my calendar$/m);
  // A normal assistant turn is preserved verbatim.
  assert.match(
    renderTranscriptTurns([{ who: 'assistant', text: 'Your calendar today: 9am standup, 2pm client call.' }]),
    / {2}YOU: Your calendar today: 9am standup, 2pm client call\.$/m,
  );
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
