import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-question-inventory-'));
process.env.CLEMENTINE_HOME = home;
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const questions = await import('./workflow-awaiting-input.js');
const records = await import('./workflow-run-record.js');
after(() => rmSync(home, { recursive: true, force: true }));

function pending(id: string, originSessionId: string) {
  return { id, workflow: 'inventory-fixture', status: 'awaiting_input', originSessionId,
    awaitingInput: { questionId: `${id}-question`, question: 'Which date?', stepId: 'read',
      sessionId: `workflow-${id}`, sessionIdSuffix: 'read', askedAt: new Date().toISOString() } };
}
function save(record: ReturnType<typeof pending>) {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${record.id}.json`);
  records.withWorkflowRunRecordLock(file, () => records.writeWorkflowRunRecordDurablyUnlocked(file, record));
  return file;
}

test('continuity inventory reads atomic snapshots without waiting on or changing a live writer lock', () => {
  const row = pending('busy-inventory', 'origin-busy');
  const file = save(row);
  const lock = `${file}.record-lock`;
  mkdirSync(lock);
  const owner = path.join(lock, `owner-${process.pid}-00000000-0000-4000-8000-000000000000.json`);
  writeFileSync(owner, '');
  try {
    const started = performance.now();
    const found = questions.findSoleAwaitingInputWorkflowRunForOrigin(row.originSessionId);
    assert.equal(found?.runId, row.id, 'a published pending question remains visible during a writer lock');
    assert.ok(performance.now() - started < 500, 'inventory must not wait for write authority');
    assert.equal(readFileSync(owner, 'utf8'), '', 'inventory never reclaims or rewrites the writer lock');
  } finally { rmSync(lock, { recursive: true, force: true }); }
});

test('a stale snapshot never authorizes answering a replaced question', () => {
  const row = pending('stale-inventory', 'origin-stale');
  const file = save(row);
  const found = questions.findSoleAwaitingInputWorkflowRunForOrigin(row.originSessionId)!;
  assert.equal(found.runId, row.id);
  save({ ...row, awaitingInput: { ...row.awaitingInput, questionId: 'replacement-question' } });
  const result = questions.queueWorkflowRunInputResolution({ runId: found.runId,
    questionId: found.awaitingInput.questionId, stepId: found.awaitingInput.stepId,
    originSessionId: row.originSessionId, answer: 'Tomorrow' });
  assert.equal(result.status, 'stale');
  const current = records.readWorkflowRunRecordSnapshot<ReturnType<typeof pending>>(file)!;
  assert.equal(current.status, 'awaiting_input');
  assert.equal(current.awaitingInput.questionId, 'replacement-question');
  assert.equal(Object.hasOwn(current.awaitingInput, 'answer'), false);
});

test('multiple pending questions stay ambiguous and another conversation cannot claim them', () => {
  save(pending('ambiguous-one', 'origin-two'));
  save(pending('ambiguous-two', 'origin-two'));
  assert.equal(questions.findSoleAwaitingInputWorkflowRunForOrigin('origin-two'), null);
  assert.equal(questions.findSoleAwaitingInputWorkflowRunForOrigin('unrelated-origin'), null);
});
