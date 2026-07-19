/**
 * Run: npx tsx --test src/runtime/harness/auto-focus.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-auto-focus-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetEventLog, createSession, appendEvent, closeEventLog } = await import('./eventlog.js');
const { resetMemoryDb } = await import('../../memory/db.js');
const { getActiveFocus, createFocus } = await import('../../memory/focus.js');
const { maybeAutoFocusSession } = await import('./auto-focus.js');

function resetAll(): void {
  closeEventLog();
  resetEventLog();
  resetMemoryDb();
}

test.after(() => {
  try {
    closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('maybeAutoFocusSession does not pin one-off chat turns', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'quick status' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: { text: 'show me the last email' },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', arguments: '{"tool_slug":"OUTLOOK_LIST_EMAILS","arguments":"{}"}' },
  });

  assert.equal(maybeAutoFocusSession({ sessionId: sess.id }), null);
  assert.equal(getActiveFocus(), null);
});

test('maybeAutoFocusSession ignores gateway mirror inflation for thread and resource thresholds', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'single logical sheet lookup' });
  const spreadsheetId = 'fixture_google_sheet_0000000003';
  for (let turn = 1; turn <= 2; turn += 1) {
    appendEvent({
      sessionId: sess.id,
      turn,
      role: 'system',
      type: 'user_input_received',
      data: { text: turn === 1 ? 'check this sheet once' : 'what did it say?' },
    });
  }
  appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'sheet-1',
      canonicalCallId: 'sheet-1',
      accounting: 'top_level',
      arguments: JSON.stringify({ spreadsheet_id: spreadsheetId }),
    },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'sheet-1',
      accounting: 'transport_mirror',
      args: { spreadsheet_id: spreadsheetId },
    },
  });
  appendEvent({
    sessionId: sess.id,
    turn: 0,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      callId: 'sheet-1',
      accounting: 'transport_mirror',
      preview: JSON.stringify({ spreadsheet_id: spreadsheetId }),
    },
  });

  assert.equal(maybeAutoFocusSession({ sessionId: sess.id }), null);
  assert.equal(getActiveFocus(), null);
});

test('maybeAutoFocusSession pins repeated Google Sheet work to the concrete resource', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'priority account sheet' });
  const spreadsheetId = 'fixture_google_sheet_0000000003';
  for (let turn = 1; turn <= 2; turn += 1) {
    appendEvent({
      sessionId: sess.id,
      turn,
      role: 'system',
      type: 'user_input_received',
      data: { text: turn === 1 ? 'update the priority account sheet' : 'continue the sheet work' },
    });
    appendEvent({
      sessionId: sess.id,
      turn,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        arguments: JSON.stringify({
          tool_slug: 'GOOGLESHEETS_UPDATE_VALUES',
          arguments: JSON.stringify({ spreadsheet_id: spreadsheetId, range: 'A1:B2' }),
        }),
      },
    });
  }

  const result = maybeAutoFocusSession({
    sessionId: sess.id,
    summaryHint: { summary: 'Updating the priority account sheet with enriched prospect rows.' },
  });

  assert.ok(result);
  const active = getActiveFocus();
  assert.equal(active?.resource_kind, 'sheet');
  assert.equal(active?.resource_ref, `https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  assert.equal(active?.related_session_id, sess.id);
});

test('maybeAutoFocusSession pins a thread focus for substantive multi-turn work without one resource', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'draft outreach emails' });
  for (let turn = 1; turn <= 2; turn += 1) {
    appendEvent({
      sessionId: sess.id,
      turn,
      role: 'system',
      type: 'user_input_received',
      data: { text: turn === 1 ? 'build the draft batch' : 'draft them please' },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 2,
      role: 'Clem',
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        arguments: JSON.stringify({
          tool_slug: 'OUTLOOK_CREATE_DRAFT',
          arguments: JSON.stringify({ subject: `Draft ${i + 1}` }),
        }),
      },
    });
  }

  const result = maybeAutoFocusSession({
    sessionId: sess.id,
    summaryHint: { summary: 'Drafting AI visibility outreach emails for the current prospect batch.' },
  });

  assert.ok(result);
  const active = getActiveFocus();
  assert.equal(active?.resource_kind, 'thread');
  assert.equal(active?.resource_ref, `session:${sess.id}`);
  assert.match(active?.title ?? '', /AI visibility outreach/);
});

test('maybeAutoFocusSession pins a thread focus for one-turn high-tool work', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'research and draft a proposal' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: { text: 'research this company and build the proposal' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: { tool: 'run_shell_command', arguments: JSON.stringify({ command: `step-${i}` }) },
    });
  }

  const result = maybeAutoFocusSession({
    sessionId: sess.id,
    summaryHint: { summary: 'Researching the company and building a proposal artifact.' },
  });

  assert.ok(result);
  assert.equal(getActiveFocus()?.resource_ref, `session:${sess.id}`);
});

test('maybeAutoFocusSession prefers reply over internal summary for focus text', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'greeting thread' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: { text: 'hey hey' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: { tool: 'run_shell_command', arguments: JSON.stringify({ command: `step-${i}` }) },
    });
  }

  const result = maybeAutoFocusSession({
    sessionId: sess.id,
    summaryHint: {
      summary: 'Greeted user; awaiting their request.',
      reply: 'Hey - what would you like to work on?',
    },
  });

  assert.ok(result);
  const active = getActiveFocus();
  assert.equal(active?.summary, 'Hey - what would you like to work on?');
  assert.doesNotMatch(active?.title ?? '', /Greeted user/);
});

test('maybeAutoFocusSession leaves an existing active focus alone', () => {
  resetAll();
  const existing = createFocus({
    resourceRef: 'session:already-active',
    title: 'Existing focus',
    summary: 'Keep this active.',
    resourceKind: 'thread',
  });
  const sess = createSession({ kind: 'chat', title: 'new work' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'system',
    type: 'user_input_received',
    data: { text: 'do a substantial thing' },
  });
  for (let i = 0; i < 5; i += 1) {
    appendEvent({
      sessionId: sess.id,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: { tool: 'run_shell_command', arguments: JSON.stringify({ command: `echo ${i}` }) },
    });
  }

  assert.equal(maybeAutoFocusSession({ sessionId: sess.id }), null);
  assert.equal(getActiveFocus()?.id, existing.id);
});

test('harness boilerplate (unparsed-decision apology, synthetic retries) NEVER becomes the focus', () => {
  resetAll();
  const sess = createSession({ kind: 'chat', title: 'research the five firms' });
  // The real ask, followed by a synthetic parse-retry recorded like an input.
  appendEvent({ sessionId: sess.id, turn: 1, role: 'system', type: 'user_input_received', data: { text: 'research the five law firms and rank them' } });
  appendEvent({
    sessionId: sess.id, turn: 2, role: 'system', type: 'user_input_received',
    data: { text: 'Your previous response could not be parsed into the required structured decision. Re-issue it now as the exact decision object.' },
  });
  for (let i = 0; i < 8; i += 1) {
    appendEvent({ sessionId: sess.id, turn: 2, role: 'Clem', type: 'tool_called', data: { tool: 'memory_search' } });
  }
  // The turn dead-ends with the apology summary (the 2026-07-03 pollution shape).
  appendEvent({
    sessionId: sess.id, turn: 2, role: 'system', type: 'conversation_completed',
    data: { reason: 'no_structured_output', summary: "Clementine produced a response that couldn't be structured. Please ask again." },
  });

  const result = maybeAutoFocusSession({ sessionId: sess.id });
  const active = getActiveFocus();
  if (result || active) {
    assert.ok(!/couldn't be structured|could not be parsed/i.test(active?.title ?? ''), `boilerplate title leaked: ${active?.title}`);
    assert.ok(!/couldn't be structured|could not be parsed/i.test(active?.summary ?? ''), `boilerplate summary leaked: ${active?.summary}`);
    assert.match(active?.title ?? '', /law firms|research/i, 'the focus reflects the REAL ask');
  }
});
