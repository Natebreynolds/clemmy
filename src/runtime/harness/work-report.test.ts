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
