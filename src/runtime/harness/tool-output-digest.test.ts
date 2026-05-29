/**
 * Run: npx tsx --test src/runtime/harness/tool-output-digest.test.ts
 *
 * The structure-aware digest must never sever a JSON array mid-record,
 * must report the true total + fields, and must point at the recovery
 * path (tool_output_query / recall_tool_result).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestToolOutput } from './tool-output-digest.js';

const accounts = Array.from({ length: 47 }, (_, i) => ({
  Id: `001${i}`,
  Name: `Account ${i} with a reasonably long name to take up bytes`,
  Website: `https://example${i}.com`,
  LastActivityDate: i % 3 === 0 ? null : `2026-0${(i % 9) + 1}-10`,
}));

test('JSON array: shows COMPLETE records (valid JSON), never mid-record', () => {
  const text = JSON.stringify(accounts);
  const digest = digestToolOutput(text, { maxChars: 2000, toolName: 'run_shell_command', callId: 'call_x1' });
  // The body up to the footer must parse as a JSON array (complete records).
  const body = digest.slice(0, digest.indexOf('\n[digest:'));
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 1 && parsed.length < accounts.length, `showed ${parsed.length}`);
  // Each shown record is whole (has all the keys).
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['Id', 'LastActivityDate', 'Name', 'Website']);
});

test('JSON array digest reports the true total, field list, and recovery path', () => {
  const digest = digestToolOutput(JSON.stringify(accounts), { maxChars: 2000, toolName: 'sf', callId: 'call_x1' });
  assert.match(digest, /array of 47 records/);
  assert.match(digest, /Fields: .*Website/);
  assert.match(digest, /tool_output_query\("call_x1"/);
  assert.match(digest, /recall_tool_result\("call_x1"/);
});

test('JSON object: digests top-level shape, not raw truncation', () => {
  const obj = { status: 'ok', count: 100, rows: accounts, nested: { a: 1, b: 2 } };
  const digest = digestToolOutput(JSON.stringify(obj), { maxChars: 1500, toolName: 't', callId: 'call_o1' });
  assert.match(digest, /top-level key/);
  assert.match(digest, /rows: array\(47\)/);
  assert.match(digest, /tool_output_query\("call_o1"/);
});

test('plain text: head+tail + line/char count, points to recall', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const digest = digestToolOutput(text, { maxChars: 1200, toolName: 'run_shell_command', callId: 'call_t1' });
  assert.match(digest, /chars \/ 500 lines/);
  assert.match(digest, /middle omitted/);
  assert.match(digest, /recall_tool_result\("call_t1"/);
});

test('no callId: still a digest, but recovery hint is the re-run advice', () => {
  const digest = digestToolOutput(JSON.stringify(accounts), { maxChars: 1500, toolName: 'sf' });
  assert.match(digest, /array of 47 records/);
  assert.match(digest, /narrower scope/);
  assert.doesNotMatch(digest, /tool_output_query/);
});
