import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow, EventType } from './eventlog.js';
import {
  projectHarnessEventForPublic,
  projectHarnessEventsForPublic,
  publicCompletionText,
  publicReplyText,
} from './public-presentation.js';

function event(type: EventType, data: Record<string, unknown> = {}): EventRow {
  return {
    seq: 1,
    id: `event-${type}`,
    sessionId: 'public-projection-test',
    turn: 1,
    role: 'system',
    type,
    parentEventId: 'private-parent',
    data,
    createdAt: '2026-07-31T00:00:00.000Z',
  };
}

function typedTerminalEvent(input: {
  seq: number;
  sourceUserSeq: number;
  text: string;
  legacyAttemptId?: string;
}): EventRow {
  const canonicalId = `turn:${input.sourceUserSeq}`;
  const outcomeId = input.legacyAttemptId ? `brain:${input.legacyAttemptId}` : canonicalId;
  const identity = {
    sessionId: 'public-projection-test',
    turn: 1,
    sourceUserSeq: input.sourceUserSeq,
    ...(input.legacyAttemptId ? { attemptId: input.legacyAttemptId } : {}),
  };
  return {
    ...event('conversation_completed', {
      terminalKey: outcomeId,
      sourceUserSeq: input.sourceUserSeq,
      ...(input.legacyAttemptId ? { attemptId: input.legacyAttemptId } : { logicalTerminalVersion: 1 }),
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
    }),
    seq: input.seq,
    id: `terminal-${input.seq}`,
  };
}

const NARRATED = [
  'Which connected account should I use?',
  'summary: account discovery finished',
  'reply: Two accounts are connected, so I need you to choose.',
  'done: inspected internal capability state',
  'nextAction: wait for the account choice',
  'reason: selecting on your behalf could use the wrong tenant',
].join('\n');

test('public reply projection extracts the answer and question, never decision bookkeeping', () => {
  const shown = publicReplyText(NARRATED);
  assert.equal(
    shown,
    'Two accounts are connected, so I need you to choose.\n\nWhich connected account should I use?',
  );
  assert.doesNotMatch(shown, /summary:|done:|nextAction:|reason:/);
});

test('raw model/control events and untrusted stream deltas have no public event', () => {
  assert.equal(projectHarnessEventForPublic(event('turn_ended', { output: NARRATED })), null);
  assert.equal(projectHarnessEventForPublic(event('guardrail_tripped', { prompt: 'private corrective text' })), null);
  assert.equal(projectHarnessEventForPublic(event('stream_token', { delta: 'private draft' })), null);
  assert.equal(
    projectHarnessEventForPublic(event('run_failed', {
      error: 'HTTP 500 provider-secret-response-body',
      reason: 'provider_failure',
    })),
    null,
    'raw failure evidence stays private; the typed failed terminal is the sole public error',
  );
  assert.equal(
    projectHarnessEventForPublic(event('memory_compaction_completed' as EventType, { summary: 'private future payload' })),
    null,
    'new event types fail closed until explicitly projected',
  );
});

test('accepted user turns project the human display text, not model-facing directives', () => {
  const projected = projectHarnessEventForPublic(event('user_input_received', {
    text: 'Continue the prior graph.\n[INTERNAL CONTINUATION DIRECTIVE]\nFull attachment contents…',
    displayText: 'continue',
  }));
  assert.ok(projected);
  assert.deepEqual(projected.data, { text: 'continue' });
});

test('conversation completion projects one safe terminal reply', () => {
  const projected = projectHarnessEventForPublic(event('conversation_completed', {
    reply: NARRATED,
    summary: 'internal fallback summary',
    internalSummary: 'secret judge notes',
    reason: 'awaiting_user_input',
    awaitingUser: true,
  }));
  assert.ok(projected);
  assert.equal(projected.parentEventId, null);
  assert.equal(
    projected.data.reply,
    'Two accounts are connected, so I need you to choose.\n\nWhich connected account should I use?',
  );
  assert.deepEqual(projected.data.presentation, {
    version: 1,
    audience: 'user',
    phase: 'final',
    status: 'needs_input',
    kind: 'question',
    text: projected.data.reply,
    resumable: true,
  });
  assert.equal('internalSummary' in projected.data, false);
});

test('a valid typed terminal stays self-validating after crossing the public event boundary', () => {
  const identity = { sessionId: 'public-projection-test', turn: 1, sourceUserSeq: 7 };
  const projected = projectHarnessEventForPublic(event('conversation_completed', {
    terminalKey: 'turn:7',
    sourceUserSeq: 7,
    presentation: {
      version: 1,
      id: 'turn:7:presentation',
      outcomeId: 'turn:7',
      audience: 'user',
      phase: 'final',
      identity,
      status: 'done',
      kind: 'answer',
      text: 'Done — 10 firms are in the sheet.',
      resumable: false,
    },
    turnOutcome: {
      version: 2,
      id: 'turn:7',
      status: 'done',
      resumable: false,
    },
    reply: 'Done — 10 firms are in the sheet.',
    summary: 'private reducer summary',
    internalSummary: 'private judge notes',
  }));

  assert.ok(projected);
  assert.deepEqual(projected.data.turnOutcome, {
    version: 2,
    id: 'turn:7',
    status: 'done',
    resumable: false,
  });
  assert.equal(publicCompletionText(projected.data), 'Done — 10 firms are in the sheet.');
  assert.equal(projected.data.summary, 'Done — 10 firms are in the sheet.');
  assert.equal('internalSummary' in projected.data, false);
});

test('a malformed typed presentation cannot launder its duplicate legacy reply into publication', () => {
  const projected = projectHarnessEventForPublic(event('conversation_completed', {
    presentation: {
      version: 1,
      audience: 'user',
      phase: 'final',
      text: 'Tool call: composio_execute_tool',
    },
    reply: 'Safe committed fallback.',
  }));
  assert.ok(projected);
  assert.match(String(projected.data.reply), /final reply was not safe to display/i);
  assert.notEqual(projected.data.reply, 'Safe committed fallback.');
  assert.equal((projected.data.presentation as { status?: string }).status, 'failed');
});

test('a typed presentation with contradictory status and kind fails closed', () => {
  const projected = projectHarnessEventForPublic(event('conversation_completed', {
    presentation: {
      version: 1,
      id: 'bad:presentation',
      outcomeId: 'bad',
      audience: 'user',
      phase: 'final',
      identity: { sessionId: 's1', turn: 1, sourceUserSeq: 1 },
      status: 'done',
      kind: 'error',
      text: 'Contradictory typed text.',
      resumable: false,
    },
    reply: 'Safe committed fallback.',
  }));
  assert.ok(projected);
  assert.match(String(projected.data.reply), /final reply was not safe to display/i);
  assert.notEqual(projected.data.reply, 'Safe committed fallback.');
  assert.equal((projected.data.presentation as { kind?: string }).kind, 'error');
});

test('nested reply payloads are revalidated and plain summaries never gain publication authority', () => {
  const nested = projectHarnessEventForPublic(event('conversation_completed', {
    reply: '{"reply":"<invoke name=\\"run_shell_command\\">"}',
    summary: 'This internal summary sounds perfectly conversational.',
  }));
  assert.ok(nested);
  assert.match(String(nested.data.reply), /final reply was not safe to display/i);
  assert.doesNotMatch(String(nested.data.reply), /invoke|perfectly conversational/i);

  const summaryOnly = projectHarnessEventForPublic(event('conversation_completed', {
    summary: 'Asked the model to inspect the account and wait.',
  }));
  assert.ok(summaryOnly);
  assert.match(String(summaryOnly.data.reply), /final reply was not safe to display/i);
});

test('public event batches preserve durable sequence cursors while dropping private rows', () => {
  const projected = projectHarnessEventsForPublic([
    { ...event('turn_ended', { output: 'private' }), seq: 3 },
    { ...event('tool_called', { tool: 'search', arguments: '{"secret":true}' }), seq: 4 },
    { ...event('conversation_completed', { reply: 'Done.' }), seq: 5 },
  ]);
  assert.deepEqual(projected.map((row) => row.seq), [4, 5]);
  assert.deepEqual(projected[0].data, { tool: 'search' });
});

test('public replay elects the earliest valid terminal across rolling-upgrade keys', () => {
  const oldWriter = typedTerminalEvent({
    seq: 8,
    sourceUserSeq: 4,
    text: 'The 3.5 writer finished first.',
    legacyAttemptId: 'rolling-old',
  });
  const newWriter = typedTerminalEvent({
    seq: 12,
    sourceUserSeq: 4,
    text: 'The retry must stay private.',
  });

  const projected = projectHarnessEventsForPublic([newWriter, oldWriter]);

  assert.deepEqual(projected.map((row) => row.seq), [8]);
  assert.equal(projected[0].data.reply, 'The 3.5 writer finished first.');
  assert.equal(
    ((projected[0].data.presentation as { identity: { sourceUserSeq: number } }).identity.sourceUserSeq),
    4,
  );
});

test('public replay collapses source-owned legacy completions from one accepted turn', () => {
  const first = {
    ...event('conversation_completed', {
      sourceUserSeq: 4,
      attemptId: 'legacy-attempt',
      runId: 'legacy-run',
      reply: 'The first committed answer.',
    }),
    seq: 8,
    id: 'legacy-terminal-8',
  };
  const narratedRetry = {
    ...event('conversation_completed', {
      sourceUserSeq: 4,
      attemptId: 'legacy-attempt',
      runId: 'legacy-run',
      reply: 'A later retry must stay private on reconnect.',
    }),
    seq: 12,
    id: 'legacy-terminal-12',
  };

  const projected = projectHarnessEventsForPublic([narratedRetry, first]);

  assert.deepEqual(projected.map((row) => row.seq), [8]);
  assert.equal(projected[0].data.reply, 'The first committed answer.');
});

test('public replay recognizes the closed turn terminal key on older legacy rows', () => {
  const first = {
    ...event('conversation_completed', { terminalKey: 'turn:19', reply: 'Owned answer.' }),
    seq: 20,
    id: 'legacy-key-terminal-20',
  };
  const duplicate = {
    ...event('conversation_completed', { terminalKey: 'turn:19', reply: 'Duplicate answer.' }),
    seq: 21,
    id: 'legacy-key-terminal-21',
  };

  const projected = projectHarnessEventsForPublic([duplicate, first]);

  assert.deepEqual(projected.map((row) => row.seq), [20]);
  assert.equal(projected[0].data.reply, 'Owned answer.');
});

test('public replay drops corrupt typed claims without suppressing a later valid owner', () => {
  const corrupt = {
    ...typedTerminalEvent({ seq: 6, sourceUserSeq: 3, text: 'untrusted duplicate' }),
    data: {
      presentation: { version: 1, identity: { sessionId: 'public-projection-test', sourceUserSeq: 3 } },
      reply: 'This copied reply has no typed authority.',
    },
  };
  const valid = typedTerminalEvent({ seq: 9, sourceUserSeq: 3, text: 'Validated answer.' });

  const projected = projectHarnessEventsForPublic([corrupt, valid]);

  assert.deepEqual(projected.map((row) => row.seq), [9]);
  assert.equal(projected[0].data.reply, 'Validated answer.');
});
