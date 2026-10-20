import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { projectApprovalProjectionPhysicalAttempts, readAcceptedTaskApprovalProjectionParticipants } from './accepted-task-approval-projection-participants.js';

/** These are deliberately untrusted/empty-store reader negatives. Positive
 * authority comes from the real approved-action producer integration fixture,
 * not rows fabricated here to resemble its canonical proof. */
function store(t: TestContext, jobs = false) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-projection-accounting-'));
  mkdirSync(path.join(home, 'state'));
  const file = path.join(home, 'state', 'harness.db');
  const db = new Database(file);
  if (jobs) db.exec(`CREATE TABLE approved_action_result_projection_jobs_v1 (
    projection_id TEXT,session_id TEXT,source_user_seq INTEGER,original_source_user_seq INTEGER,
    terminal_event_id TEXT,evidence_digest TEXT,binding_digest TEXT,status TEXT,claim_id TEXT,
    usage_job_id TEXT,created_at TEXT,started_at TEXT,finished_at TEXT,binding_json TEXT);`);
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, db, file };
}
const source = { sessionId: 'controlled', sourceUserSeq: 17 };

test('older stores without the optional protocol stay unchanged and make no zero-usage assertion', t => {
  const f = store(t);
  const before = readFileSync(f.file);
  const result = readAcceptedTaskApprovalProjectionParticipants(f.home, [source]);
  assert.deepEqual(result, { jobs: [], claimedJobIds: [], issues: [] });
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(existsSync(path.join(f.home, 'state', 'operational-telemetry.db')), false);
});

test('missing and malformed explicit homes cannot initialize storage', t => {
  const f = store(t);
  const absent = path.join(f.home, 'missing');
  assert.ok(readAcceptedTaskApprovalProjectionParticipants(absent, [source]).issues.includes('approval_projection_store_unavailable'));
  assert.equal(existsSync(absent), false);
  assert.ok(readAcceptedTaskApprovalProjectionParticipants('.', [source]).issues.includes('approval_projection_source_inventory_invalid'));
  assert.ok(readAcceptedTaskApprovalProjectionParticipants(f.home, Array.from({ length: 257 }, () => source)).issues
    .includes('approval_projection_source_inventory_invalid'));
});

test('a source-column or copied namespace claim without immutable binding cannot adopt foreign cost', t => {
  const f = store(t, true);
  f.db.prepare('INSERT INTO approved_action_result_projection_jobs_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'approved-result:v1:' + 'a'.repeat(64), source.sessionId, 22, source.sourceUserSeq,
    'controlled-terminal', 'a'.repeat(64), 'a'.repeat(64), 'published', 'copied-claim',
    'approval-projection-job:11111111-1111-4111-8111-111111111111', '2026-10-19T00:00:00Z', null, null, '{}');
  const before = readFileSync(f.file);
  const result = readAcceptedTaskApprovalProjectionParticipants(f.home, [source]);
  assert.deepEqual(result.jobs, []); assert.deepEqual(result.claimedJobIds, []);
  assert.ok(result.issues.includes('approval_projection_origin_unproved'));
  assert.deepEqual(readFileSync(f.file), before);
  f.db.prepare('UPDATE approved_action_result_projection_jobs_v1 SET projection_id=?').run('invalid identity');
  const malformed = readAcceptedTaskApprovalProjectionParticipants(f.home, [source]);
  assert.deepEqual(malformed.jobs, []); assert.deepEqual(malformed.claimedJobIds, []);
  assert.ok(malformed.issues.includes('approval_projection_origin_unproved'), 'a malformed retained identity cannot vanish as an empty inventory');
});

test('oversized bindings and inventory caps fail unqualified without parsing/adopting their claims', t => {
  const f = store(t, true);
  const insert = f.db.prepare('INSERT INTO approved_action_result_projection_jobs_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('approved-result:v1:' + 'a'.repeat(64), source.sessionId, 22, source.sourceUserSeq,
    'controlled-terminal', 'a'.repeat(64), 'a'.repeat(64), 'started', 'claim', null,
    '2026-10-19T00:00:00Z', null, null, JSON.stringify({ value: 'x'.repeat(20_000) }));
  assert.ok(readAcceptedTaskApprovalProjectionParticipants(f.home, [source]).issues.includes('approval_projection_origin_unproved'));
  for (let index = 0; index < 256; index++) insert.run(`controlled-${index}`, source.sessionId, index + 23, source.sourceUserSeq,
    'terminal', 'b'.repeat(64), 'b'.repeat(64), 'queued', null, null, '2026-10-19T00:00:00Z', null, null, '{}');
  const result = readAcceptedTaskApprovalProjectionParticipants(f.home, [source]);
  assert.ok(result.issues.includes('approval_projection_job_inventory_limit'));
  assert.deepEqual(result.jobs, []); assert.deepEqual(result.claimedJobIds, []);
});

test('unreadable optional schema is unavailable, never permission to fall back to source/time matching', t => {
  const f = store(t);
  f.db.exec('CREATE TABLE approved_action_result_projection_jobs_v1 (projection_id TEXT)');
  const result = readAcceptedTaskApprovalProjectionParticipants(f.home, [source]);
  assert.ok(result.issues.includes('approval_projection_schema_unavailable'));
  assert.deepEqual(result.jobs, []); assert.deepEqual(result.claimedJobIds, []);
});

test('physical inventory compares exact host clocks only to the display job closure, with missing timing unavailable', () => {
  // Pure clock/classification inputs, not a fabricated authority store. The
  // actual approved-action producer separately qualifies job and response use.
  const phases = [
    { phase: 'adapter_attempt_created', at: 10 },
    { phase: 'dispatch_started', at: 11, dispatchId: 'controlled-dispatch' },
    { phase: 'model_result_completed', at: 30, dispatchIds: ['controlled-dispatch'], resultScope: 'original_sdk_response',
      hostResultReceiptId: 'controlled-receipt', providerResponseIdDigest: 'a'.repeat(64) },
    { phase: 'adapter_attempt_finished', at: 31, outcome: 'returned', resultScope: 'original_sdk_response', providerResponseIdDigest: 'a'.repeat(64) },
  ];
  const rows = phases.map((phase, index) => ({ row: { journalIndex: index + 1, actor: 'model-transport-observation',
    model_call_id: 'controlled-call', session_id: null, workflow_run_id: null, workflow_node_run_id: null, tool_call_id: null },
  data: { modelCallId: 'controlled-call', physicalAttempt: 1, purpose: 'writer', journalFailed: false, clock: 'host_epoch_ms', ...phase } }));
  const issues: string[] = [];
  const afterUnknownClosure = projectApprovalProjectionPhysicalAttempts(rows, 20, issue => issues.push(issue));
  assert.equal(afterUnknownClosure[0]?.outcome, 'returned');
  assert.equal(afterUnknownClosure[0]?.late, true, 'a response after unknown/cancelled job closure remains inventoried as late');
  assert.equal(projectApprovalProjectionPhysicalAttempts(rows, 40, () => {})[0]?.late, false);
  assert.equal(projectApprovalProjectionPhysicalAttempts(rows, null, () => {})[0]?.late, null, 'no job closure is not measured false');
  for (const clock of [undefined, 'foreign_clock']) {
    const unknown = rows.map((entry, index) => index === 3 ? { ...entry, data: { ...entry.data, clock } } : entry);
    const missingIssues: string[] = [];
    assert.equal(projectApprovalProjectionPhysicalAttempts(unknown, 40, issue => missingIssues.push(issue))[0]?.late, null);
    assert.ok(missingIssues.includes('approval_projection_late_window_unavailable'));
  }
  assert.deepEqual(issues, []);
  const conflicting = rows.flatMap(entry => entry.data.phase === 'dispatch_started' ? [entry, structuredClone(entry)]
    : entry.data.phase === 'model_result_completed'
      ? [{ ...entry, data: { ...entry.data, dispatchIds: ['controlled-dispatch', 'missing-dispatch'] } }]
      : [entry]);
  const conflictingIssues: string[] = [];
  const unqualified = projectApprovalProjectionPhysicalAttempts(conflicting, 40, issue => conflictingIssues.push(issue));
  assert.equal(unqualified[0]?.outcome, 'unknown', 'duplicate observations cannot hide a missing declared dispatch');
  assert.equal(unqualified[0]?.originalResponse, undefined);
  assert.ok(conflictingIssues.includes('approval_projection_original_response_unproved'));
  const afterResult = rows.map(entry => entry.data.phase === 'dispatch_started'
    ? { ...entry, row: { ...entry.row, journalIndex: 999 } } : entry);
  assert.equal(projectApprovalProjectionPhysicalAttempts(afterResult, 40, () => {})[0]?.originalResponse, undefined,
    'a dispatch observed after the response cannot certify its physical inventory');
});
