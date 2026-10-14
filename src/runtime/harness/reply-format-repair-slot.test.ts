import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-format-slot-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('./eventlog.js');
const { withRecoveryActivation } = await import('./recovery-activation.js');
const approvals = await import('./approval-registry.js');
const { claimReplyFormatRepairSlot } = await import('./reply-format-repair-slot.js');
const { default: Database } = await import('better-sqlite3');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let serial = 0;
function fixture() {
  const id = `format-slot-${++serial}`;
  events.createSession({ id, kind: 'chat' });
  const claim = events.claimRunAttemptLease({ sessionId: id, runId: `desktop:${id}`, ownerId: 'fixture', leaseMs: 60_000 });
  assert.ok(claim.claimed && claim.attempt);
  const attempt = claim.attempt;
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Briefly report controlled retained results.' } });
  const input = { sessionId: id, sourceUserSeq: source.seq, attemptId: attempt.attemptId,
    objectiveDigest: hash('objective'), ownerInstructionsDigest: hash('instructions'), candidateDigest: hash('candidate'),
    original: { modelCallId: `model-${serial}`, physicalAttempt: 1, providerResponseIdDigest: hash('provider-response') },
    author: { modelId: 'controlled-model', provider: 'controlled-provider' } };
  return { id, attempt, source, input };
}
function slots(id: string) {
  return events.listEvents(id, { types: ['guardrail_tripped'] }).filter(e => e.data.kind === 'source_reply_format_repair_spent');
}
function unavailable(input: Parameters<typeof claimReplyFormatRepairSlot>[0], sessionId = input.sessionId) {
  assert.equal(claimReplyFormatRepairSlot(input).status, 'unavailable');
  assert.equal(slots(sessionId).length, 0);
}

test('format slot persists one digest-only claim and survives DB reopen, changed candidate and replacement attempt', () => {
  const f = fixture();
  const result = claimReplyFormatRepairSlot(f.input);
  assert.equal(result.status, 'claimed');
  const stored = slots(f.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, result.status === 'claimed' ? result.eventId : 'missing');
  assert.deepEqual(stored[0].data, { kind: 'source_reply_format_repair_spent', version: 1, ...f.input });
  assert.equal(stored[0].role, 'system');
  assert.equal(stored[0].parentEventId, f.source.id);
  assert.equal(JSON.stringify(stored).includes('Briefly report'), false);
  events.closeEventLog();
  assert.deepEqual(claimReplyFormatRepairSlot({ ...f.input, candidateDigest: hash('another draft') }), { status: 'spent' });
  events.finishRunAttempt(f.attempt, 'interrupted');
  const next = events.claimRunAttemptLease({ sessionId: f.id, runId: `desktop:${f.id}:restart`, ownerId: 'restart', leaseMs: 60_000 }).attempt!;
  events.bindRunAttemptSourceUserEvent(next, f.source.seq);
  assert.deepEqual(claimReplyFormatRepairSlot({ ...f.input, attemptId: next.attemptId }), { status: 'spent' },
    'loss of the private author capsule on restart cannot remint a source allowance');
  assert.equal(slots(f.id).length, 1);
  assert.equal(claimReplyFormatRepairSlot(fixture().input).status, 'claimed', 'independent accepted source has its own slot');
});

test('format slot competing real processes on separate DB connections claim exactly once', async () => {
  const f = fixture();
  const script = `import { claimReplyFormatRepairSlot } from './src/runtime/harness/reply-format-repair-slot.ts';
    console.log('SLOT_RESULT:'+JSON.stringify(claimReplyFormatRepairSlot(JSON.parse(process.env.SLOT_INPUT))));`;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, CLEMENTINE_HOME: home, SLOT_INPUT: JSON.stringify(f.input) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`controlled slot child exit ${code}; diagnostic bytes=${stderr.length}`));
      const row = stdout.split('\n').find(line => line.startsWith('SLOT_RESULT:'));
      if (!row) return reject(new Error('controlled slot child missing fixed result'));
      resolve(JSON.parse(row.slice('SLOT_RESULT:'.length)).status);
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(results.filter(status => status === 'claimed').length, 1);
  assert.ok(results.every(status => ['claimed', 'spent', 'unavailable'].includes(status)),
    'a competing writer may decline immediately rather than wait or retry');
  assert.equal(slots(f.id).length, 1);
  assert.deepEqual(claimReplyFormatRepairSlot(f.input), { status: 'spent' });
});

test('format slot rolls back insertion failure and decline inside an enclosing transaction', () => {
  const f = fixture(); const db = events.openEventLog();
  db.exec(`CREATE TEMP TRIGGER refuse_format_slot BEFORE INSERT ON main.events
    WHEN NEW.type = 'guardrail_tripped' BEGIN SELECT RAISE(ABORT, 'controlled insertion refusal'); END`);
  unavailable(f.input);
  db.exec('DROP TRIGGER refuse_format_slot');
  db.transaction(() => { unavailable(f.input); })();
  assert.equal(claimReplyFormatRepairSlot(f.input).status, 'claimed');
});

test('format slot checks recovery ownership inside the transaction and again after commit', () => {
  const f = fixture(); let checks = 0;
  withRecoveryActivation(f.id, { sourceUserSeq: f.source.seq, attemptId: f.attempt.attemptId }, () => unavailable(f.input),
    () => { if (++checks === 3) throw new Error('controlled owner lost before commit'); });
  assert.equal(checks, 3);
  assert.equal(claimReplyFormatRepairSlot(f.input).status, 'claimed');
  const g = fixture(); checks = 0;
  const result = withRecoveryActivation(g.id, { sourceUserSeq: g.source.seq, attemptId: g.attempt.attemptId },
    () => claimReplyFormatRepairSlot(g.input), () => { if (++checks === 4) throw new Error('controlled owner lost after commit'); });
  assert.equal(result.status, 'unavailable');
  assert.equal(slots(g.id).length, 1, 'a committed debit stays spent despite unavailable publication/late owner loss');
  assert.deepEqual(claimReplyFormatRepairSlot(g.input), { status: 'spent' });
});

for (const defect of ['stopped', 'expired', 'finished', 'missing-source', 'foreign-source', 'foreign-attempt', 'synthetic-source', 'malformed-source', 'published'] as const) {
  test(`format slot declines ${defect} without metering or granting work`, () => {
    const f = fixture(); const db = events.openEventLog();
    if (defect === 'stopped') events.requestKill(f.id, 'controlled stop', { attemptId: f.attempt.attemptId });
    if (defect === 'expired') db.prepare('UPDATE run_attempts SET lease_expires_at = ? WHERE attempt_id = ?').run('2000-01-01T00:00:00.000Z', f.attempt.attemptId);
    if (defect === 'finished') events.finishRunAttempt(f.attempt, 'completed');
    if (defect === 'missing-source') f.input.sourceUserSeq = 99999999;
    if (defect === 'foreign-source') f.input.sourceUserSeq = fixture().source.seq;
    if (defect === 'foreign-attempt') f.input.attemptId = fixture().attempt.attemptId;
    if (defect === 'synthetic-source') db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{"synthetic":true}', f.source.seq);
    if (defect === 'malformed-source') db.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{bad', f.source.seq);
    if (defect === 'published') events.appendEvent({ sessionId: f.id, turn: 1, role: 'system', type: 'conversation_completed', data: {
      sourceUserSeq: f.source.seq, attemptId: f.attempt.attemptId, status: 'completed', reply: 'Controlled final.' } });
    unavailable(f.input);
    assert.equal(events.listEvents(f.id, { types: ['tool_called', 'tool_returned'] }).length, 0);
  });
}

test('format slot validates exact durable approval delivery mapping, not an ambient parent claim', () => {
  const f = fixture();
  const card = approvals.register({ sessionId: f.id, subject: 'Controlled pending work', tool: 'fixture_write', args: { controlled: true } });
  events.finishRunAttempt(f.attempt, 'interrupted');
  const next = events.claimRunAttemptLease({ sessionId: f.id, runId: `desktop:${f.id}:approve`, ownerId: 'approval', leaseMs: 60_000 }).attempt!;
  const control = events.recordRunAttemptUserInput(next, { turn: 2, role: 'user', parentEventId: f.source.id,
    data: { text: 'Approve the controlled card.', approvalId: card.approvalId, decision: 'approve', synthetic: true } });
  approvals.resolve(card.approvalId, 'approved', 'fixture');
  const input = { ...f.input, attemptId: next.attemptId };
  withRecoveryActivation(f.id, { sourceUserSeq: control.seq, attemptId: next.attemptId,
    approvalContinuation: { requestSourceUserSeq: f.source.seq, approvalId: card.approvalId, decision: 'approve' } }, () => unavailable(input));
  events.appendEvent({ sessionId: f.id, turn: 2, role: 'system', type: 'run_resumed', data: { reviewContinuationVersion: 1,
    executionSourceUserSeq: f.source.seq, deliverySourceUserSeq: control.seq, approvalId: card.approvalId, decision: 'approve' } });
  assert.equal(claimReplyFormatRepairSlot(input).status, 'claimed');
  assert.equal(slots(f.id)[0].data.sourceUserSeq, f.source.seq, 'meter follows execution source, not approval control');
});

test('format slot DB lock is unavailable without retry and later source claim remains possible', () => {
  const f = fixture(); const db = events.openEventLog();
  const other = new Database(path.join(home, 'state', 'harness.db'));
  db.pragma('busy_timeout = 1');
  try {
    other.exec('BEGIN IMMEDIATE');
    unavailable(f.input);
    other.exec('ROLLBACK');
    assert.equal(claimReplyFormatRepairSlot(f.input).status, 'claimed');
  } finally { if (other.inTransaction) other.exec('ROLLBACK'); other.close(); }
});

test('format slot inert input rejects accessors, proxies, missing proof and malformed digests before hooks', () => {
  const f = fixture(); let hooks = 0;
  const accessor = { ...f.input, author: Object.defineProperty({}, 'modelId', { enumerable: true, get() { hooks++; return 'controlled-model'; } }) };
  const proxy = new Proxy(f.input, { get() { hooks++; throw new Error('no hook'); }, ownKeys() { hooks++; throw new Error('no hook'); } });
  for (const input of [accessor, proxy, { ...f.input, original: null }, { ...f.input, candidateDigest: 'bad' },
    { ...f.input, original: { ...f.input.original, physicalAttempt: 0 } }]) {
    unavailable(input as typeof f.input, f.id);
  }
  assert.equal(hooks, 0);
  assert.equal(claimReplyFormatRepairSlot(f.input).status, 'claimed');
});
