/**
 * A large record list is summarized from all of its records: count, fields,
 * value counts for few-valued fields, spans (and sums) for dates and numbers.
 * The summary rides only where the bounded view cannot answer for the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactStructuredJsonToolOutput, digestToolOutput, recordListSummary, renderRecordListSummary } from './tool-output-digest.js';

const tasks = Array.from({ length: 84 }, (_, i) => ({
  attributes: { type: 'Task', url: `/services/data/v68.0/sobjects/Task/00T${String(i).padStart(15, '0')}` },
  Id: `00T${String(i).padStart(15, '0')}`,
  Subject: `Email: follow-up ${i}`,
  Status: i === 0 ? 'Not Started' : 'Completed',
  Type: i < 4 ? 'Call' : 'Email',
  ActivityDate: `2026-10-${String(19 + (i % 5)).padStart(2, '0')}`,
  Amount: i % 2 === 0 ? 100 : null,
  Owner: { attributes: { type: 'Name' }, Name: 'Fixture Owner' },
}));

test('a record list summary counts few-valued fields and spans dates and numbers across every record', () => {
  const summary = recordListSummary({ status: 0, result: { records: tasks, totalSize: 84, done: true } });
  assert.ok(summary);
  assert.equal(summary!.path, 'result.records');
  assert.equal(summary!.total, 84);
  assert.deepEqual(summary!.counts?.Type, { Email: 80, Call: 4 });
  assert.deepEqual(summary!.counts?.Status, { Completed: 83, 'Not Started': 1 });
  assert.deepEqual(summary!.counts?.['Owner.Name'], { 'Fixture Owner': 84 }, 'a constant field still says who it is');
  assert.deepEqual(summary!.counts?.ActivityDate, { '2026-10-19': 17, '2026-10-20': 17, '2026-10-21': 17, '2026-10-22': 17, '2026-10-23': 16 },
    'a few-valued date is counted per day');
  assert.equal(summary!.counts?.['attributes.url'], undefined, 'distinct long values are never merged by a shortened label');
  assert.deepEqual(summary!.ranges?.Amount, { min: 100, max: 100, sum: 4200, present: 42 });
  assert.equal(summary!.counts?.Subject, undefined, 'a field whose every value differs is not counted');
  assert.equal(recordListSummary({ records: tasks.slice(0, 3) }), null, 'a short list needs no summary');
  const line = renderRecordListSummary(summary!);
  assert.match(line, /^Summary of all records: 84 records at result\.records;/);
  assert.match(line, /Type: Email 80, Call 4/);
  assert.match(line, /Amount: 100…100 \(sum 4200\) in 42/);
});

test('a CLI run whose records sit in one JSON string gets the summary in its view', () => {
  const stdout = JSON.stringify({ status: 0, result: { records: tasks, totalSize: 84, done: true }, warnings: [] }, null, 2);
  const envelope = { result: { version: 1, status: 'exited', operationId: 'fixture_cli_query', executableRealpath: '/usr/local/bin/fixture',
    argv: ['data', 'query', '--json'], exitCode: 0, signal: null, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false }, complete: true };
  const shown = compactStructuredJsonToolOutput(JSON.stringify(envelope), { callId: 'call_cli', maxChars: 4000, exactOutputReceipt: '[receipt]' });
  assert.ok(shown && shown.length <= 4000);
  const meta = JSON.parse(shown!).__clementine;
  assert.equal(meta.summary.total, 84);
  assert.equal(meta.summary.path, 'result.records', 'the record query\'s path for the same records');
  assert.deepEqual(meta.summary.counts.Type, { Email: 80, Call: 4 });
});

test('a list cut to slivers gets the summary; a list shown with its fields does not', () => {
  const subjects = ['Morning Huddle', 'Weekly Recruiting Meeting', 'Client review', 'Pipeline sync', 'Team meet up'];
  const week = Array.from({ length: 35 }, (_, i) => ({
    subject: subjects[i % subjects.length],
    start: { dateTime: `2026-10-${26 + (i % 5)}T${String(8 + (i % 9)).padStart(2, '0')}:00:00`, timeZone: 'Pacific Standard Time' },
    end: { dateTime: `2026-10-${26 + (i % 5)}T${String(9 + (i % 9)).padStart(2, '0')}:00:00`, timeZone: 'Pacific Standard Time' },
    organizer: { emailAddress: { name: `Organizer ${i}`, address: `organizer${i}@example.test` } },
    bodyPreview: 'Agenda and notes for the meeting. '.repeat(8),
  }));
  const shown = compactStructuredJsonToolOutput(JSON.stringify({ data: { value: week } }), { callId: 'call_week', maxChars: 3800, exactOutputReceipt: '[receipt]' });
  assert.ok(shown && shown.length <= 3800);
  const meta = JSON.parse(shown!).__clementine;
  assert.equal(meta.summary.total, 35);
  assert.deepEqual(Object.keys(meta.summary.counts.subject).sort(), [...subjects].sort());
  const small = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `row ${i}`, kind: i % 2 ? 'a' : 'b' }));
  const whole = compactStructuredJsonToolOutput(JSON.stringify({ data: { items: small }, filler: 'x'.repeat(5000) }), { callId: 'call_small', maxChars: 2000, exactOutputReceipt: '[receipt]' });
  assert.ok(whole);
  assert.equal(JSON.parse(whole!).__clementine.summary, undefined, 'rows that already answer for the list carry no summary');
});

test('a shell command that printed a JSON record list carries the summary line in its digest; a cut capture does not', () => {
  const stdout = JSON.stringify({ status: 0, result: { records: tasks, totalSize: 84, done: true } }, null, 2);
  const digest = digestToolOutput(`exit_code: 0\n\nstdout:\n${stdout}\n\nstderr:\n`, { toolName: 'run_shell_command', callId: 'call_shell', maxChars: 4000 });
  assert.match(digest, /Summary of all records: 84 records at result\.records;/);
  assert.match(digest, /Type: Email 80, Call 4/);
  const cut = digestToolOutput(`exit_code: 0\n\nstdout:\n${stdout.slice(0, 20000)}\n...[capture stopped after 200000 chars]\n\nstderr:\n`, { toolName: 'run_shell_command', callId: 'call_cut', maxChars: 4000 });
  assert.doesNotMatch(cut, /Summary of all records/);
});
