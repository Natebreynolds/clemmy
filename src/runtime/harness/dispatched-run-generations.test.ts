/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/dispatched-run-generations.test.ts
 *
 * A file this request wrote, then rewritten by a workflow run this request
 * started, is that run's final generation, not drift. Live 2026-10-17: a Space
 * feed published the rows Clem had also saved by hand, two completion reviews
 * were told the dataset was UNVERIFIED, and the turn ended blocked after the
 * third review passed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dispatched-generations-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'dispatched-generations\n', 'utf8');

const runner = await import('./host-turn-runner.js');
const eventlog = await import('./eventlog.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const GROUP = `workflow-origin-group-v1:${'a'.repeat(64)}`;
const GROUP_DIGEST = 'b'.repeat(64);
const DATA = 'spaces/fixture-books/data.json';

function receipt(handle: string, content: string): string {
  return `[clementine:host-local-write-commit:v1] ${JSON.stringify({ version: 1, createdId: 'fixture-books', handle, contentDigest: sha(content) })}\nSaved.`;
}

function dispatchedSource(runId: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'dispatch' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'build it' },
  });
  eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'system', type: 'async_work_dispatched',
    data: {
      version: 2, kind: 'workflow_run_group', status: 'dispatched', sourceUserSeq: source.seq,
      sourceGroupId: GROUP, sourceGroupDigest: GROUP_DIGEST, runIds: [runId],
      dispatchKey: `workflow_source_group:${GROUP}:${GROUP_DIGEST}`, replyTargetDigest: 'c'.repeat(64),
    },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function runRecord(runId: string, group: string, publish: string): void {
  mkdirSync(path.join(HOME, 'workflows', 'runs'), { recursive: true });
  writeFileSync(path.join(HOME, 'workflows', 'runs', `${runId}.json`), JSON.stringify({
    id: runId, status: 'completed', chatDispatchSourceGroupId: group,
    stepOutputs: { read: '[{"title":"x"}]', publish: JSON.stringify({ rows: 2, hostFileCommit: publish }) },
  }));
}

function current(content: string): void {
  mkdirSync(path.join(HOME, 'spaces', 'fixture-books'), { recursive: true });
  writeFileSync(path.join(HOME, DATA), content, 'utf8');
}

const own = (handle: string, content: string) => [{ handle, contentDigest: sha(content), facts: {} }];

test("the run's write is the file's final generation when the current bytes are that write", () => {
  const identity = dispatchedSource('1792000000001-aaaaaa');
  runRecord('1792000000001-aaaaaa', GROUP, receipt(DATA, '{"books":[2]}'));
  current('{"books":[2]}');
  const generations = runner.dispatchedRunGenerations(identity, own(DATA, '{"books":[1]}'));
  assert.equal(generations.length, 1);
  assert.equal(generations[0]?.runId, '1792000000001-aaaaaa');
  assert.equal(generations[0]?.facts.contentDigest, sha('{"books":[2]}'));
});

test("a saved Space's data counts as written by this request", () => {
  const identity = dispatchedSource('1792000000002-bbbbbb');
  runRecord('1792000000002-bbbbbb', GROUP, receipt(DATA, '{"books":[3]}'));
  current('{"books":[3]}');
  const generations = runner.dispatchedRunGenerations(identity, own('spaces/fixture-books/.clementine-workspace-commit.json', 'bundle'));
  assert.deepEqual(generations.map((entry) => entry.facts.handle), [DATA]);
});

test('nothing is credited without the exact dispatch, a matching current file, or a file this request wrote', () => {
  const wrongGroup = dispatchedSource('1792000000003-cccccc');
  runRecord('1792000000003-cccccc', `workflow-origin-group-v1:${'d'.repeat(64)}`, receipt(DATA, '{"books":[4]}'));
  current('{"books":[4]}');
  assert.deepEqual(runner.dispatchedRunGenerations(wrongGroup, own(DATA, '{"books":[1]}')), [], 'a run of another dispatch group');

  const changedSince = dispatchedSource('1792000000004-dddddd');
  runRecord('1792000000004-dddddd', GROUP, receipt(DATA, '{"books":[5]}'));
  current('{"books":[6]}');
  assert.deepEqual(runner.dispatchedRunGenerations(changedSince, own(DATA, '{"books":[1]}')), [], 'the current bytes are not the run\'s write');

  const otherFile = dispatchedSource('1792000000005-eeeeee');
  runRecord('1792000000005-eeeeee', GROUP, receipt(DATA, '{"books":[7]}'));
  current('{"books":[7]}');
  assert.deepEqual(runner.dispatchedRunGenerations(otherFile, own('notes/other.md', 'x')), [], 'a file this request never wrote');
});
