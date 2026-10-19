/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/check-lessons.test.ts
 *
 * What a check caught and Clem fixed becomes a general lesson in memory, said
 * to come from a check, never this request's details; nothing when the model
 * finds no lesson; once per request.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-check-lessons-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.EMBEDDINGS_DISABLED = 'true';
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const { resetMemoryDb } = await import('./db.js');
const { searchFactsByText } = await import('./facts.js');
const { appendEvent, createSession } = await import('../runtime/harness/eventlog.js');
const {
  CHECK_LESSON_PREFIX, checkLessonRequest, learnFromCheck, parseCheckLessons, toolFixesForSource,
  _resetCheckLessonsForTests, _setCheckLessonModelForTests,
} = await import('./check-lessons.js');

beforeEach(() => { resetMemoryDb(); _resetCheckLessonsForTests(); _setCheckLessonModelForTests(null); });

const reviewCase = {
  finding: '"Top five by stars" is not established: higher-star candidates above the cutoff were never assessed.',
  before: 'Here are the five most-starred fixture libraries: A, B, C, D, E.',
  after: 'These five lead the fixture search I ran; two higher-star results were excluded because they are applications.',
};

test('a fixed review finding is kept as a general lesson that says it came from a check', async () => {
  const asked: string[] = [];
  _setCheckLessonModelForTests(async (request) => {
    asked.push(request);
    return '{"lessons": ["When ranking results as a top N, check every candidate above the cutoff or say how the list was limited."]}';
  });
  await learnFromCheck({ sessionId: 'lesson-fixture', sourceUserSeq: 4, request: 'TEST FIXTURE: find the five most popular fixture libraries',
    kind: 'review', cases: [reviewCase] });
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.includes('higher-star candidates'), 'the model reads the check\'s own words');
  const kept = searchFactsByText('ranking top N cutoff', 5);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.kind, 'feedback');
  assert.ok(kept[0]!.content.startsWith(CHECK_LESSON_PREFIX), kept[0]!.content);
  // Once per request and kind of check.
  await learnFromCheck({ sessionId: 'lesson-fixture', sourceUserSeq: 4, request: 'TEST FIXTURE', kind: 'review', cases: [reviewCase] });
  assert.equal(asked.length, 1);
});

test('nothing is kept when the model finds no general lesson, or when nothing was fixed', async () => {
  let asked = 0;
  _setCheckLessonModelForTests(async () => { asked += 1; return '{"lessons": []}'; });
  await learnFromCheck({ sessionId: 'lesson-none', sourceUserSeq: 7, request: 'TEST FIXTURE: total these numbers', kind: 'review', cases: [reviewCase] });
  await learnFromCheck({ sessionId: 'lesson-none', sourceUserSeq: 8, request: 'TEST FIXTURE', kind: 'review',
    cases: [{ ...reviewCase, after: '' }] });
  assert.equal(asked, 1, 'a finding with no fix asks nothing');
  assert.equal(searchFactsByText('ranking cutoff', 5).length, 0);
});

test('the reply is read strictly and bounded', () => {
  assert.deepEqual(parseCheckLessons('```json\n{"lessons": ["When a, b.", "", 3, "When c, d.", "When e, f."]}\n```'), ['When a, b.', 'When c, d.']);
  assert.deepEqual(parseCheckLessons({ lessons: ['x'.repeat(241)] }), []);
  assert.throws(() => parseCheckLessons('{"lesson": "When a, b."}'));
  const request = JSON.parse(checkLessonRequest({ sessionId: 's', sourceUserSeq: 1, request: 'r'.repeat(5_000), kind: 'tool',
    cases: [{ tool: 'workflow_create', finding: 'f', before: 'b'.repeat(9_000), after: 'a' }] }));
  assert.ok(request.request.length <= 1_500);
  assert.ok(request.caught[0].failed.length <= 2_000);
  assert.equal(request.caught[0].tool, 'workflow_create');
});

test('a refused tool call that a later call got right is found from the request\'s own events', () => {
  createSession({ id: 'lesson-tools', kind: 'chat' });
  const source = appendEvent({ sessionId: 'lesson-tools', turn: 1, role: 'user', type: 'user_input_received', data: { text: 'TEST FIXTURE' } });
  const seq = source.seq;
  const event = (type: 'tool_called' | 'tool_returned' | 'tool_attempt_settled', data: Record<string, unknown>) =>
    appendEvent({ sessionId: 'lesson-tools', turn: 1, role: 'system', type, data: { sourceUserSeq: seq, ...data } });
  event('tool_called', { tool: 'cli_inspect', callId: 'c1', args: '{"action":"help","cli":"gh"}' });
  event('tool_attempt_settled', { tool: 'cli_inspect', callId: 'c1', kind: 'invalid_arguments' });
  event('tool_returned', { tool: 'cli_inspect', callId: 'c1', preview: 'action: Invalid option: expected one of "status"|"repairs"' });
  event('tool_called', { tool: 'cli_inspect', callId: 'c2', args: '{"action":"status","name":"gh"}' });
  event('tool_attempt_settled', { tool: 'cli_inspect', callId: 'c2', kind: 'succeeded' });
  event('tool_called', { tool: 'space_save', callId: 'c3', args: '{}' });
  event('tool_attempt_settled', { tool: 'space_save', callId: 'c3', kind: 'invalid_arguments' });
  const fixes = toolFixesForSource('lesson-tools', seq);
  assert.equal(fixes.length, 1, 'a refusal never fixed is not a lesson');
  assert.equal(fixes[0]!.tool, 'cli_inspect');
  assert.match(fixes[0]!.finding, /Invalid option/);
  assert.match(fixes[0]!.before, /"help"/);
  assert.match(fixes[0]!.after, /"status"/);
  assert.deepEqual(toolFixesForSource('lesson-tools', seq + 100), []);
});

test('lessons ride at turn start in their own short section, said to come from a check, never the owner\'s own feedback', async () => {
  const { renderCheckLessonsForContext } = await import('./check-lesson-context.js');
  const { rememberFact } = await import('./facts.js');
  assert.equal(renderCheckLessonsForContext('TEST FIXTURE: compare crawling libraries'), '', 'no lesson, no section');
  rememberFact({ kind: 'feedback', content: 'Owner prefers short replies.' });
  _setCheckLessonModelForTests(async () => '{"lessons": ["When stating a project\'s maintenance status, verify it with the host\'s API rather than asserting an impression."]}');
  await learnFromCheck({ sessionId: 'lesson-context', sourceUserSeq: 9, request: 'TEST FIXTURE: which libraries are maintained',
    kind: 'review', cases: [reviewCase] });
  const section = renderCheckLessonsForContext('TEST FIXTURE: compare crawling libraries and note which are maintained');
  assert.match(section, /^## Lessons From Past Checks\n/);
  assert.match(section, /not said by the owner/);
  assert.match(section, /\n- When stating a project's maintenance status, verify it/);
  assert.doesNotMatch(section, /Owner prefers short replies/);
  assert.doesNotMatch(section, new RegExp(CHECK_LESSON_PREFIX), 'the stored marker is not repeated to the model');
});
