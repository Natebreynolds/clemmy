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
const { PUBLIC_RUN_FAILURE_TEXT } = await import('./public-presentation.js');
const { createSession, appendEvent, openEventLog, listEvents } = await import('./eventlog.js');

function typedTerminalData(input: {
  sessionId: string;
  sourceUserSeq: number;
  text: string;
  attemptId?: string;
}): Record<string, unknown> {
  const outcomeId = input.attemptId ? `brain:${input.attemptId}` : `turn:${input.sourceUserSeq}`;
  const identity = {
    sessionId: input.sessionId,
    turn: 1,
    sourceUserSeq: input.sourceUserSeq,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
  };
  return {
    terminalKey: outcomeId,
    sourceUserSeq: input.sourceUserSeq,
    ...(input.attemptId ? { attemptId: input.attemptId } : { logicalTerminalVersion: 1 }),
    presentation: {
      version: 1,
      id: `${outcomeId}:presentation`,
      outcomeId,
      audience: 'user',
      phase: 'final',
      identity,
      status: 'done',
      kind: 'answer',
      text: input.text,
      resumable: false,
    },
    turnOutcome: { version: 2, id: outcomeId, status: 'done', resumable: false },
    reply: input.text,
  };
}

function appendTypedTerminal(
  sessionId: string,
  sourceUserSeq: number,
  text: string,
  attemptId?: string,
) {
  return appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: typedTerminalData({ sessionId, sourceUserSeq, text, ...(attemptId ? { attemptId } : {}) }),
  });
}

test('a reopened question or approval reads as it did live, without the retained-work checkpoint', () => {
  const session = createSession({ kind: 'chat', title: 'waiting replies' });
  const ask = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Set up the assistant.' } });
  const question = typedTerminalData({
    sessionId: session.id,
    sourceUserSeq: ask.seq,
    text: 'Which platform should I build it on?\n\nRetained work (durable checkpoint):\n- Source/tool list_numbers: 3 records (unknown) retained as rh_0123456789abcdef0123456789abcdef. External write state: no settled external-write attempt is recorded.',
  });
  const presentation = question.presentation as Record<string, unknown>;
  presentation.status = 'needs_input';
  presentation.kind = 'question';
  presentation.resumable = true;
  presentation.needs = { kind: 'input' };
  question.turnOutcome = { version: 2, id: presentation.outcomeId, status: 'needs_input', resumable: true, needs: { kind: 'input' } };
  question.awaitingUser = true;
  question.reason = 'awaiting_user_input';
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: question });
  const done = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Vapi.' } });
  appendTypedTerminal(session.id, done.seq, 'Built it.\n\nRetained work (durable checkpoint):\n- kept for a finished reply');
  const turns = reconstructHarnessTranscript(session.id);
  const reopened = turns.find((turn) => turn.role === 'assistant' && turn.text.startsWith('Which platform'));
  assert.equal(reopened?.text, 'Which platform should I build it on?');
  const finished = turns.find((turn) => turn.role === 'assistant' && turn.text.startsWith('Built it.'));
  assert.match(finished?.text ?? '', /Retained work/, 'a finished or failed reply still discloses it');
});

test('a reopened approval reads as the question the card asked, and the owner\'s tap as their answer', () => {
  const session = createSession({ kind: 'chat', title: 'reopened approval' });
  const ask = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Wire up the API.' } });
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested', data: {
    tool: 'work_call', subject: 'cli_setup: install', approvalId: 'apr-abcd',
    preview: { operation: 'cli_setup', fields: [{ name: 'command', value: 'npm install -g @vapi-ai/cli' }],
      ask: 'Can I install Vapi\'s command-line tool on your Mac?' },
  } });
  const filler = 'Approval required for cli_setup: install. Review apr-abcd to continue.';
  const card = typedTerminalData({ sessionId: session.id, sourceUserSeq: ask.seq,
    text: `${filler}\n\nRetained work (durable checkpoint):\n- Source/tool cli_inspect: completed result retained as rh_0123456789abcdef0123456789abcdef.` });
  const presentation = card.presentation as Record<string, unknown>;
  Object.assign(presentation, { status: 'needs_input', kind: 'approval', resumable: true, needs: { kind: 'approval' }, approvalId: 'apr-abcd' });
  card.turnOutcome = { version: 2, id: presentation.outcomeId, status: 'needs_input', resumable: true, needs: { kind: 'approval' } };
  card.awaitingUser = true;
  card.reason = 'awaiting_approval';
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: card });
  appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'approve apr-abcd', displayText: 'approve apr-abcd', approvalId: 'apr-abcd', decision: 'approve', source: 'desktop_approval' } });
  const turns = reconstructHarnessTranscript(session.id);
  assert.ok(turns.some((turn) => turn.role === 'assistant' && turn.text === 'Can I install Vapi\'s command-line tool on your Mac?'),
    JSON.stringify(turns.map((turn) => turn.text)));
  assert.ok(!turns.some((turn) => /apr-abcd|Retained work|cli_setup/.test(turn.text)), JSON.stringify(turns.map((turn) => turn.text)));
  assert.ok(turns.some((turn) => turn.role === 'user' && turn.text === 'Yes, go ahead.'));
});

test('humanHarnessText unwraps strings, JSON strings, and objects', () => {
  assert.equal(humanHarnessText('plain text'), 'plain text');
  assert.equal(humanHarnessText({ reply: 'hi there' }), 'hi there');
  assert.equal(humanHarnessText({ summary: 'an internal summary' }, 'fallback'), 'fallback');
  assert.equal(humanHarnessText({ reply: 'r', summary: 's' }), 'r'); // reply preferred
  assert.equal(humanHarnessText('{"reply":"json reply"}'), 'json reply');
  assert.equal(humanHarnessText(null, 'fallback'), 'fallback');
  assert.equal(humanHarnessText('', 'fallback'), 'fallback');
});

test('humanHarnessText projects legacy narrated decisions instead of replaying control fields', () => {
  const narrated = [
    'Which account should I use?',
    'summary: account discovery complete',
    'reply: I found two connected accounts.',
    'done: false',
    'nextAction: awaiting_user_input',
    'reason: the user must select the tenant',
  ].join('\n');
  assert.equal(
    humanHarnessText({ reply: narrated, internalSummary: 'private judge notes' }),
    'I found two connected accounts.\n\nWhich account should I use?',
  );
  assert.equal(
    humanHarnessText('Tool call: composio_execute_tool\n{"args":{"secret":true}}', 'safe fallback'),
    'safe fallback',
  );
});

test('reconstructHarnessTranscript applies the public projection on reopen', () => {
  const session = createSession({ kind: 'chat', title: 'legacy narration' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Which connection is active?' } });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reply: 'summary: checked connections\nreply: Two are active.\ndone: true\nnextAction: completed\nreason: lookup succeeded',
      internalSummary: 'secret execution trace',
    },
  });
  assert.deepEqual(
    reconstructHarnessTranscript(session.id).map((turn) => `${turn.role}:${turn.text}`),
    ['user:Which connection is active?', 'assistant:Two are active.'],
  );
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

test('reconstructHarnessTranscript drops a superseded parse-exhaustion apology, keeps the recovered reply', () => {
  const session = createSession({ kind: 'chat', title: 'test' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'what is the plan?' } });
  // Parse-exhausted dead turn: the internal "couldn't be structured" apology.
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'no_structured_output', summary: "Clementine produced a response that couldn't be structured. Please ask again." },
  });
  // Recovery marker appended before the re-run on the next brain.
  appendEvent({
    sessionId: session.id,
    turn: 0,
    role: 'system',
    type: 'conversation_superseded',
    data: { reason: 'no_structured_output', recoveryModel: 'claude-fable-5' },
  });
  // The recovered reply from the next brain.
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: "Here's the plan: ship it." } });

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.text}`),
    ['user:what is the plan?', "assistant:Here's the plan: ship it."],
    'the internal apology is suppressed; only the recovered reply renders',
  );
});

test('reconstructHarnessTranscript still renders a parse-exhaustion apology with no superseding marker', () => {
  const session = createSession({ kind: 'chat', title: 'test' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'still there?' } });
  // Genuine dead end: recovery disabled/unavailable, so no conversation_superseded follows.
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'no_structured_output',
      summary: "Clementine produced a response that couldn't be structured. Please ask again.",
      reply: "Clementine produced a response that couldn't be structured. Please ask again.",
    },
  });

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.text}`),
    ['user:still there?', "assistant:Clementine produced a response that couldn't be structured. Please ask again."],
    'the sole reply is never silently dropped',
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

test('reconstructHarnessTranscript prefers displayText over model-facing accepted input', () => {
  const session = createSession({ kind: 'chat', title: 'transformed input' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Continue the prior execution graph.\n[PRIVATE RESUME DIRECTIVE]\nAttachment body…',
      displayText: 'continue',
    },
  });
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Continuing now.' } });
  assert.deepEqual(
    reconstructHarnessTranscript(session.id).map((turn) => turn.text),
    ['continue', 'Continuing now.'],
  );
});

test('reconstructHarnessTranscript renders overlapping typed turns in accepted-source order', () => {
  const session = createSession({ kind: 'chat', title: 'overlap' });
  const sourceA = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'request A' } });
  const sourceB = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'request B' } });
  appendTypedTerminal(session.id, sourceB.seq, 'answer B');
  appendTypedTerminal(session.id, sourceA.seq, 'answer A');

  assert.deepEqual(
    reconstructHarnessTranscript(session.id).map((turn) => `${turn.role}:${turn.text}`),
    ['user:request A', 'assistant:answer A', 'user:request B', 'assistant:answer B'],
  );
});

test('reconstructHarnessTranscript keeps active input last after an overlapping completion', () => {
  const session = createSession({ kind: 'chat', title: 'active overlap' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'active A' } });
  const sourceB = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'request B' } });
  appendTypedTerminal(session.id, sourceB.seq, 'answer B');

  assert.deepEqual(
    reconstructHarnessTranscript(session.id).map((turn) => `${turn.role}:${turn.text}`),
    ['user:request B', 'assistant:answer B', 'user:active A'],
  );
});

test('reconstructHarnessTranscript suppresses a historical rolling-upgrade duplicate without deleting it', () => {
  const session = createSession({ kind: 'chat', title: 'rolling duplicate' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'ship it' } });
  appendTypedTerminal(session.id, source.seq, 'first answer', 'legacy-attempt');
  const duplicate = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: { reply: 'temporary legacy row' },
  });
  openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(
    JSON.stringify(typedTerminalData({ sessionId: session.id, sourceUserSeq: source.seq, text: 'late answer' })),
    duplicate.seq,
  );

  assert.deepEqual(
    reconstructHarnessTranscript(session.id).map((turn) => turn.text),
    ['ship it', 'first answer'],
  );
  assert.equal(
    listEvents(session.id, { types: ['conversation_completed'] }).length,
    2,
    'the private ledger keeps both historical rows',
  );
});

test('a FAILED daemon-driven relay turn renders no error bubble; a successful relay still speaks', () => {
  const sid = 'console:relay-failure-render';
  createSession({ id: sid, kind: 'chat' });
  // Real user turn + its reply.
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'run it in the background' } });
  appendEvent({ sessionId: sid, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reply: 'On it — running in the background.', sourceUserSeq: 1 } });
  // Synthetic outcome relay whose processing turn FAILED under a rate limit —
  // its generic failure text must NOT paint the transcript (live 2026-08-04).
  appendEvent({ sessionId: sid, turn: 2, role: 'user', type: 'user_input_received', data: { text: '[background task bg-1] Relay the outcome…', synthetic: true, source: 'outcome', deliveryPhase: 'directive' } });
  const failSeq = listEvents(sid, { types: ['user_input_received'], desc: true, limit: 1 })[0]!.seq;
  appendEvent({ sessionId: sid, turn: 2, role: 'Clem', type: 'conversation_completed', data: { reply: PUBLIC_RUN_FAILURE_TEXT, sourceUserSeq: failSeq } });
  // A later SUCCESSFUL relay renders its spoken outcome normally.
  appendEvent({ sessionId: sid, turn: 3, role: 'user', type: 'user_input_received', data: { text: '[background task bg-1] Relay the outcome…', synthetic: true, source: 'outcome', deliveryPhase: 'directive' } });
  const okSeq = listEvents(sid, { types: ['user_input_received'], desc: true, limit: 1 })[0]!.seq;
  appendEvent({ sessionId: sid, turn: 3, role: 'Clem', type: 'conversation_completed', data: { reply: 'Your demo-firm profiles are ready — 5 files in demo-firms/.', sourceUserSeq: okSeq } });

  const turns = reconstructHarnessTranscript(sid);
  const texts = turns.map((t) => t.text);
  assert.ok(!texts.includes(PUBLIC_RUN_FAILURE_TEXT), 'no generic error bubble for a turn the user never sent');
  assert.ok(texts.some((t) => t.includes('profiles are ready')), 'the successful relay reply still renders');
  assert.ok(texts.some((t) => t.includes('running in the background')), 'the real turn pair is untouched');
});

test('reconstructHarnessTranscript names who answered each exchange from its route marker', () => {
  const session = createSession({ kind: 'chat', title: 'switching agents' });
  const ask = (text: string) => appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const routed = (sourceUserSeq: number, agentName?: string) => appendEvent({
    sessionId: session.id, turn: 0, role: 'system', type: 'turn_model_routed',
    data: { model: 'test-model', provider: 'test', sourceUserSeq, ...(agentName ? { agentName } : {}) },
  });
  const first = ask('plain question');
  routed(first.seq);
  appendTypedTerminal(session.id, first.seq, 'plain answer');
  const second = ask('draft the posts');
  routed(second.seq, 'Instagram Manager');
  // A fallover's second marker for the same source never re-attributes it.
  routed(second.seq);
  appendTypedTerminal(session.id, second.seq, 'three drafts');
  const third = ask('back to the calendar');
  routed(third.seq);
  appendTypedTerminal(session.id, third.seq, 'calendar answer');
  // A turn without a route marker says nothing about who answered.
  const fourth = ask('still running');

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(
    turns.map((turn) => [turn.role, turn.text, turn.agentName]),
    [
      ['user', 'plain question', null],
      ['assistant', 'plain answer', null],
      ['user', 'draft the posts', 'Instagram Manager'],
      ['assistant', 'three drafts', 'Instagram Manager'],
      ['user', 'back to the calendar', null],
      ['assistant', 'calendar answer', null],
      ['user', 'still running', undefined],
    ],
  );
  assert.equal(Object.prototype.hasOwnProperty.call(turns[6], 'agentName'), false);
  void fourth;
});

test('a workflow the reply saved rides on that reply, newest save per workflow, and on no other turn', () => {
  const session = createSession({ kind: 'chat', title: 'workflow cards' });
  const ask = (text: string) => appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const saved = (sourceUserSeq: number | undefined, slug: string, changedStepIds: string[]) => appendEvent({
    sessionId: session.id, turn: 0, role: 'system', type: 'workflow_saved',
    data: {
      name: slug, slug, op: 'updated', enabled: false,
      steps: [{ id: 'a', label: 'A', effect: 'read', approval: false, forEach: false, dependsOn: [] }],
      changedStepIds, addedStepIds: [], removedStepIds: [],
      ...(sourceUserSeq ? { sourceUserSeq } : {}),
    },
  });
  const first = ask('change step a');
  saved(first.seq, 'weekly-posts', ['a']);
  saved(first.seq, 'weekly-posts', []); // a second save in the same turn wins
  saved(first.seq, 'other-flow', ['a']);
  appendTypedTerminal(session.id, first.seq, 'done');
  const second = ask('unrelated');
  saved(undefined, 'weekly-posts', ['a']); // no source: attaches to nothing
  appendTypedTerminal(session.id, second.seq, 'sure');

  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.workflows?.map((w) => `${w.slug}:${w.changedStepIds.join(',')}`)]), [
    ['user', undefined],
    ['assistant', ['weekly-posts:', 'other-flow:a']],
    ['user', undefined],
    ['assistant', undefined],
  ]);
});

test('the owner\'s card answers read the same on the daemon and in the shared chat engine', async () => {
  const daemon = await import('./public-presentation.js');
  const engine = await import('../../../packages/chat-engine/src/types.js');
  assert.deepEqual(daemon.APPROVAL_ANSWER_WORDS, engine.APPROVAL_ANSWER_WORDS);
});

test('recorded files reopen on their exact reply, retain distinct folders, and coexist with workflow cards', () => {
  const session = createSession({ kind: 'chat', title: 'saved file cards' });
  const first = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Make the drafts.' } });
  const save = (sourceUserSeq: number, name: string, dir: string) => appendEvent({
    sessionId: session.id, turn: 0, role: 'system', type: 'deliverable_saved', data: { sourceUserSeq, name, dir },
  });
  save(first.seq, 'email.html', 'out');
  save(first.seq, 'brief.pdf', 'out');
  save(first.seq, 'email.html', 'other');
  save(first.seq, 'email.html', 'out');
  appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'workflow_saved', data: {
    sourceUserSeq: first.seq, slug: 'draft-reports', name: 'Draft reports', op: 'created', enabled: false,
    steps: [], changedStepIds: [], addedStepIds: [], removedStepIds: [],
  } });
  appendTypedTerminal(session.id, first.seq, 'The draft files are ready.');
  const second = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Explain the plan.' } });
  save(first.seq, 'late.txt', 'out'); // The asynchronous write tee still belongs to the first source.
  save(999999, 'unbound.txt', 'out');
  save(second.seq, '../private.txt', 'out');
  save(second.seq, 'private.txt', '/private');
  appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'deliverable_saved', data: { sourceUserSeq: second.seq, name: 'invented.txt', dir: 'out' } });
  appendTypedTerminal(session.id, second.seq, 'I mentioned plan.md, but did not save it.');
  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(turns[1]?.files, [
    { name: 'brief.pdf', dir: 'out' }, { name: 'email.html', dir: 'other' },
    { name: 'email.html', dir: 'out' }, { name: 'late.txt', dir: 'out' },
  ]);
  assert.equal(turns[1]?.workflows?.[0]?.slug, 'draft-reports');
  assert.equal(turns[0]?.files, undefined);
  assert.equal(turns[2]?.files, undefined);
  assert.equal(turns[3]?.files, undefined, 'prose, unsafe paths, unbound and user-authored facts do not create receipts');
});

test('legacy file facts attach only inside one completed sequence window, never overlapping or unbound turns', () => {
  const session = createSession({ kind: 'chat', title: 'legacy saved files' });
  const ask = (text: string) => appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const save = (name: string, data = {}) => appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'deliverable_saved', data: { name, dir: 'out', ...data } });
  save('before-source.pdf');
  const first = ask('First output');
  save('first.pdf');
  appendTypedTerminal(session.id, first.seq, 'First is ready.');
  save('between-turns.pdf');
  const second = ask('Second output');
  const third = ask('Overlapping output');
  save('ambiguous.pdf');
  save('invalid-source.pdf', { sourceUserSeq: -1 });
  appendTypedTerminal(session.id, second.seq, 'Second is ready.');
  appendTypedTerminal(session.id, third.seq, 'Third is ready.');
  ask('Still running');
  save('unfinished.pdf');
  const turns = reconstructHarnessTranscript(session.id);
  assert.deepEqual(turns.filter(turn => turn.files?.length).map(turn => turn.files), [[{ name: 'first.pdf', dir: 'out' }]]);
});
