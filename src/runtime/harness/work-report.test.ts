/** Run: npx tsx --test src/runtime/harness/work-report.test.ts */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventRow } from './eventlog.js';

// This suite resets the harness event log repeatedly. Resolve all runtime
// modules only after pinning them to a disposable home so a direct invocation
// can never touch the operator's real session history.
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-work-report-test-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
const {
  describeExternalWrite,
  synthesizeTurnReport,
  synthesizeWorkReport,
} = await import('./work-report.js');
const {
  resetEventLog,
  createSession,
  appendEvent,
} = await import('./eventlog.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* disposable test home */ }
});

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

test('synthesizeWorkReport requires the complete evidence window to net failures and surface orphans', () => {
  const failedWrite = writeEvent('AIRTABLE_CREATE_RECORD', ['record:prospect']);
  const failedResolution = {
    ...failedWrite,
    seq: 2,
    type: 'external_write_failed',
  } as EventRow;
  assert.equal(
    synthesizeWorkReport([failedWrite, failedResolution]),
    null,
    'the matching demonstrable failure removes the provisional write',
  );

  const orphanedWrite = writeEvent('OUTLOOK_SEND_EMAIL', ['casey@example.com']);
  const orphanResolution = {
    ...orphanedWrite,
    seq: 2,
    type: 'external_write_orphaned',
  } as EventRow;
  const uncertain = synthesizeWorkReport([orphanedWrite, orphanResolution]);
  assert.ok(uncertain);
  assert.match(uncertain!, /could not confirm|uncertain/i);
  assert.doesNotMatch(uncertain!, /Sent a message|I finished/i);
});

test('synthesizeWorkReport keeps a pre-dispatch reservation uncertain until its exact call succeeds', () => {
  const reserved = {
    ...writeEvent('OUTLOOK_SEND_EMAIL', ['casey@example.com']),
    data: {
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      toolName: 'composio_execute_tool',
      targets: ['casey@example.com'],
      callId: 'write-exact-a',
      canonicalCallId: 'write-exact-a',
      preDispatch: true,
    },
  } as EventRow;
  const pending = synthesizeWorkReport([reserved]);
  assert.match(pending ?? '', /could not confirm|uncertain/i);
  assert.doesNotMatch(pending ?? '', /I finished|Sent a message/i);

  const wrongSuccess = {
    ...reserved,
    seq: 2,
    type: 'external_write_succeeded',
    data: { ...reserved.data, callId: 'write-other', canonicalCallId: 'write-other' },
  } as EventRow;
  const stillPending = synthesizeWorkReport([reserved, wrongSuccess]);
  assert.match(stillPending ?? '', /could not confirm|uncertain/i);
  assert.doesNotMatch(stillPending ?? '', /I finished|Sent a message/i);

  const uncorrelatedReservation = {
    ...reserved,
    data: {
      shapeKey: 'OUTLOOK_SEND_EMAIL',
      toolName: 'composio_execute_tool',
      targets: ['casey@example.com'],
      preDispatch: true,
    },
  } as EventRow;
  const uncorrelatedSuccess = {
    ...uncorrelatedReservation,
    seq: 2,
    type: 'external_write_succeeded',
  } as EventRow;
  assert.match(
    synthesizeWorkReport([uncorrelatedReservation, uncorrelatedSuccess]) ?? '',
    /could not confirm|uncertain/i,
    'shape similarity cannot replace exact call correlation for new reservations',
  );

  const exactSuccess = {
    ...reserved,
    seq: 3,
    type: 'external_write_succeeded',
  } as EventRow;
  const confirmed = synthesizeWorkReport([reserved, wrongSuccess, exactSuccess]);
  assert.match(confirmed ?? '', /I finished/i);
  assert.match(confirmed ?? '', /Sent a message to casey@example\.com/i);
  assert.doesNotMatch(confirmed ?? '', /could not confirm|uncertain/i);

  assert.match(
    synthesizeWorkReport([writeEvent('OUTLOOK_SEND_EMAIL', ['legacy@example.com'])]) ?? '',
    /I finished/,
    'legacy rows without preDispatch retain their historical success meaning',
  );
});

test('truncates a long recipient list', () => {
  const many = Array.from({ length: 8 }, (_, i) => `p${i}@x.com`);
  assert.match(describeExternalWrite('OUTLOOK_SEND_EMAIL', 'composio', many), /\(\+3 more\)/);
});

test('synthesizeTurnReport: only a matched successful tool return earns an activity digest', () => {
  resetEventLog();
  const sid = 'turn-report-session';
  createSession({ id: sid, kind: 'chat', title: 't' });
  // Nothing yet → null (a total non-response → caller shows "send again").
  assert.equal(synthesizeTurnReport(sid, 0), null);
  // A started call is not completion evidence. It may have timed out or thrown.
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'agent',
    type: 'tool_called',
    data: { tool: 'web_search', callId: 'call-search', accounting: 'top_level' },
  });
  assert.equal(synthesizeTurnReport(sid, 0), null);
  // A matched successful return is safe to report as verified activity.
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'web_search', callId: 'call-search', accounting: 'top_level', ok: true, result: '3 results' },
  });
  const toolReport = synthesizeTurnReport(sid, 0);
  assert.ok(toolReport, 'a successful returned tool still reports back');
  assert.match(toolReport!, /1 successful call/i);
  assert.match(toolReport!, /web search/i);
  assert.doesNotMatch(toolReport!, /results are saved|finished the work/i);
  // A write outranks the tool note.
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['a@b.com'], callId: 'turn-write', preDispatch: true } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write_succeeded', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['a@b.com'], callId: 'turn-write' } });
  const writeReport = synthesizeTurnReport(sid, 0);
  assert.match(writeReport!, /Sent a message to a@b\.com/);
});

test('synthesizeTurnReport: a failed returned call is never promoted to completed activity', () => {
  resetEventLog();
  const sid = 'turn-report-failed-tool';
  createSession({ id: sid, kind: 'chat', title: 't' });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'agent',
    type: 'tool_called',
    data: { tool: 'web_search', callId: 'call-failed', accounting: 'top_level' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'web_search', callId: 'call-failed', accounting: 'top_level', ok: false, error: 'timeout' },
  });
  assert.equal(synthesizeTurnReport(sid, 0), null);
});

test('synthesizeTurnReport: failed writes are netted and orphaned writes are explicitly uncertain', () => {
  resetEventLog();
  const failedSid = 'turn-report-failed-write';
  createSession({ id: failedSid, kind: 'chat', title: 't' });
  appendEvent({
    sessionId: failedSid,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'] },
  });
  appendEvent({
    sessionId: failedSid,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'] },
  });
  assert.equal(synthesizeTurnReport(failedSid, 0), null, 'a compensated pre-dispatch write is not success');

  const orphanSid = 'turn-report-orphaned-write';
  createSession({ id: orphanSid, kind: 'chat', title: 't' });
  appendEvent({
    sessionId: orphanSid,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] },
  });
  appendEvent({
    sessionId: orphanSid,
    turn: 1,
    role: 'system',
    type: 'external_write_orphaned',
    data: { slug: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'], reason: 'timeout' },
  });
  const orphanReport = synthesizeTurnReport(orphanSid, 0);
  assert.ok(orphanReport);
  assert.match(orphanReport!, /uncertain|could not confirm/i);
  assert.match(orphanReport!, /casey@example\.com/);
  assert.doesNotMatch(orphanReport!, /I finished|Sent a message|Created a record/i);
});

test('synthesizeTurnReport: a failed first attempt does not hide a later exactly-confirmed retry', () => {
  resetEventLog();
  const sid = 'turn-report-write-retry';
  createSession({ id: sid, kind: 'chat', title: 't' });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'], callId: 'first', preDispatch: true },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'external_write_failed',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'], callId: 'first' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'], callId: 'retry', preDispatch: true },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'external_write_succeeded',
    data: { shapeKey: 'AIRTABLE_CREATE_RECORD', targets: ['record:prospect'], callId: 'retry' },
  });
  const report = synthesizeTurnReport(sid, 0);
  assert.ok(report);
  assert.equal((report!.match(/Created a record/g) ?? []).length, 1);
});

// ── Billable provider jobs are visible (2026-08-07 Arizona scrape) ──
test('the run report names provider jobs it started, and flags the ones with no confirmed result', async () => {
  const { synthesizeWorkReport, summarizeProviderJobs } = await import('./work-report.js');
  const row = (seq: number, type: string, data: Record<string, unknown>) =>
    ({ seq, type, sessionId: 's', turn: 0, role: 'system', data } as never);

  // Live shape: four actor starts, one confirmed, the rest never fetched —
  // the user found the spend only by opening the provider's dashboard.
  const evidence = [
    row(1, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c1', preDispatch: true }),
    row(2, 'external_write_orphaned', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c1' }),
    row(3, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c2', preDispatch: true }),
    row(4, 'external_write_succeeded', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c2' }),
    row(5, 'external_write', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c3', preDispatch: true }),
    row(6, 'external_write_orphaned', { shapeKey: 'APIFY_RUN_ACTOR', callId: 'c3' }),
  ];

  const jobs = summarizeProviderJobs(evidence);
  assert.equal(jobs?.started, 3);
  assert.equal(jobs?.unresolved, 2, 'two paid jobs have no confirmed result');
  assert.deepEqual(jobs?.families, ['apify']);

  const report = synthesizeWorkReport(evidence);
  assert.match(String(report), /Started 3 provider jobs on apify/);
  assert.match(String(report), /2 of them have no confirmed result yet/);
  assert.match(String(report), /billable/);

  // Ordinary writes report exactly as before — no job line invented.
  const plain = synthesizeWorkReport([
    row(1, 'external_write', { shapeKey: 'OUTLOOK_CREATE_DRAFT', callId: 'd1', preDispatch: true }),
    row(2, 'external_write_succeeded', { shapeKey: 'OUTLOOK_CREATE_DRAFT', callId: 'd1', targets: ['a@x.example'] }),
  ]);
  assert.doesNotMatch(String(plain), /provider job/);
  assert.equal(summarizeProviderJobs([
    row(1, 'external_write', { shapeKey: 'AIRTABLE_CREATE_MULTIPLE_RECORDS', callId: 'r1', preDispatch: true }),
  ]), null, 'a plain record write is not a provider job');
});
