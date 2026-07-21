/** Run: npx tsx --test src/runtime/harness/work-report.test.ts */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeExternalWrite, synthesizeWorkReport } from './work-report.js';
import type { EventRow } from './eventlog.js';

function writeEvent(shapeKey: string, targets: string[] = [], toolName = 'composio_execute_tool'): EventRow {
  return { seq: 1, id: 'e', session_id: 's', turn: 1, role: 'system', type: 'external_write', data: { shapeKey, toolName, targets }, created_at: '' } as unknown as EventRow;
}

test('describeExternalWrite is effect-anchored (slug), not tool-named — covers send/draft/create/update/delete', () => {
  assert.match(describeExternalWrite('OUTLOOK_SEND_EMAIL', 'composio', ['a@b.com']), /Sent a message to a@b\.com/);
  assert.match(describeExternalWrite('GMAIL_SEND_EMAIL', 'composio', ['x@y.com', 'z@w.com']), /Sent a message to x@y\.com, z@w\.com/);
  assert.match(describeExternalWrite('OUTLOOK_CREATE_DRAFT', 'composio', []), /Created a draft/);
  assert.match(describeExternalWrite('SLACK_SEND_MESSAGE', 'composio', ['#sales']), /Sent a message to #sales/);
  assert.match(describeExternalWrite('AIRTABLE_CREATE_RECORD', 'composio', []), /Created a record/);
  assert.match(describeExternalWrite('HUBSPOT_UPDATE_CONTACT', 'composio', []), /Updated a record/);
  assert.match(describeExternalWrite('TWITTER_CREATE_POST', 'composio', []), /Published a post/);
  // No tool name / slug leaks into the human copy.
  assert.doesNotMatch(describeExternalWrite('OUTLOOK_SEND_EMAIL', 'composio', ['a@b.com']), /OUTLOOK|composio/i);
});

test('synthesizeWorkReport lists deduped writes; empty list → null (no fabricated report for a pure ack)', () => {
  const report = synthesizeWorkReport([
    writeEvent('OUTLOOK_SEND_EMAIL', ['casey@example.com']),
    writeEvent('OUTLOOK_SEND_EMAIL', ['casey@example.com']), // duplicate → collapsed
    writeEvent('AIRTABLE_CREATE_RECORD', []),
  ]);
  assert.ok(report);
  assert.match(report!, /here's what I did/i);
  assert.equal((report!.match(/Sent a message/g) ?? []).length, 1, 'duplicate lines collapse');
  assert.match(report!, /Created a record/);
  assert.equal(synthesizeWorkReport([]), null, 'no writes → no report');
});

test('truncates a long recipient list', () => {
  const many = Array.from({ length: 8 }, (_, i) => `p${i}@x.com`);
  assert.match(describeExternalWrite('OUTLOOK_SEND_EMAIL', 'composio', many), /\(\+3 more\)/);
});

import { synthesizeTurnReport } from './work-report.js';
import { resetEventLog, createSession, appendEvent } from './eventlog.js';

test('synthesizeTurnReport: writes → write report; tools-only → honest tool note; nothing → null', () => {
  resetEventLog();
  const sid = 'turn-report-session';
  createSession({ id: sid, kind: 'chat', title: 't' });
  // Nothing yet → null (a total non-response → caller shows "send again").
  assert.equal(synthesizeTurnReport(sid, 0), null);
  // Meaningful tool call, no writes → honest "I ran a tool but didn't summarize".
  appendEvent({ sessionId: sid, turn: 1, role: 'agent', type: 'tool_called', data: { tool: 'web_search', accounting: 'top_level' } });
  const toolReport = synthesizeTurnReport(sid, 0);
  assert.ok(toolReport, 'a tools-only turn still reports back');
  assert.match(toolReport!, /ran 1 tool/i);
  assert.match(toolReport!, /didn't compose a written summary/i);
  // A write outranks the tool note.
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['a@b.com'] } });
  const writeReport = synthesizeTurnReport(sid, 0);
  assert.match(writeReport!, /Sent a message to a@b\.com/);
});
