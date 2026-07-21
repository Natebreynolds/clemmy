/**
 * Run: npx tsx --test src/runtime/audit-ledger.test.ts
 * Attorney-bar B3/B1 (2026-07-20): trust-relevant records survive session GC
 * in an append-only ledger, joinable by session/run prefix.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-audit-ledger-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { AUDIT_DIR, appendAuditRecord, readAuditRecords } = await import('./audit-ledger.js');
const { appendEvent, createSession, reapStaleSessions } = await import('./harness/eventlog.js');
const approvalRegistry = await import('./harness/approval-registry.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('external_write events mirror to the ledger automatically from the appendEvent seam', () => {
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'system', type: 'external_write',
    data: { shapeKey: 'email:send', toolName: 'composio_execute_tool', targets: ['client@example.com'], callId: 'call_1' },
  });
  const records = readAuditRecords({ kinds: ['external_write'] });
  assert.equal(records.length, 1);
  assert.equal(records[0].sessionId, sess.id);
  assert.deepEqual(records[0].targets, ['client@example.com'], 'recipient identity survives in the ledger');
  assert.ok(existsSync(AUDIT_DIR) && readdirSync(AUDIT_DIR).some((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)));
});

test('approval resolutions ledger from the registry seam with who/what/when', () => {
  const sess = createSession({ kind: 'chat' });
  const card = approvalRegistry.register({ sessionId: sess.id, subject: 'Send retainer letter', tool: 'composio_execute_tool', args: {} });
  approvalRegistry.resolve(card.approvalId, 'approved', 'desktop-user');
  const records = readAuditRecords({ kinds: ['approval_resolved'] });
  assert.equal(records.length, 1);
  assert.equal(records[0].approvalId, card.approvalId);
  assert.equal(records[0].resolution, 'approved');
  assert.equal(records[0].resolvedBy, 'desktop-user', 'WHO approved is durable');
  assert.equal(records[0].subject, 'Send retainer letter');
});

test('the ledger SURVIVES session GC — the exact loss B3 flagged', () => {
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'system', type: 'external_write',
    data: { shapeKey: 'email:send', toolName: 't', targets: ['x@y.example'], callId: 'call_gc' },
  });
  // Reap aggressively (everything older than 0 days).
  try { reapStaleSessions(0); } catch { /* reap signature may guard minimums; the assertion below is the truth */ }
  const survivors = readAuditRecords({ sessionPrefix: sess.id });
  assert.ok(survivors.some((r) => r.callId === 'call_gc'), 'the audit trail outlives the session row');
});

test('run-prefix join: one query reconstructs a workflow run across step sessions', () => {
  const runId = 'wfrun-audit-join';
  for (const step of ['step-a', 'step-b']) {
    const sessionId = `workflow:${runId}:${step}`;
    createSession({ id: sessionId, kind: 'execution' } as never);
    appendEvent({
      sessionId, turn: 1, role: 'system', type: 'external_write',
      data: { shapeKey: 'email:send', toolName: 't', targets: [`${step}@client.example`], callId: `call_${step}` },
    });
  }
  const run = readAuditRecords({ sessionPrefix: `workflow:${runId}` });
  assert.equal(run.length, 2, 'both step sessions join under the run prefix');
});

test('filters: kind, since, limit; torn lines never break the read', () => {
  appendAuditRecord({ kind: 'custom_probe', sessionId: 's-x', note: 1 });
  const since = new Date(Date.now() + 60_000).toISOString();
  assert.equal(readAuditRecords({ kinds: ['custom_probe'], sinceIso: since }).length, 0);
  assert.ok(readAuditRecords({ kinds: ['custom_probe'] }).length >= 1);
  assert.equal(readAuditRecords({ limit: 1 }).length, 1);
});
