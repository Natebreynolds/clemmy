/**
 * Run: npx tsx --test src/spaces/space-action-gate.test.ts
 *
 * E1 — the workspace action gate: classification (what needs one approval) +
 * execute-on-approve. Temp CLEMENTINE_HOME; no network (composio classification
 * is by slug only; the execute path uses a local echo runner).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-action-gate-'));

const gate = await import('./space-action-gate.js');
const store = await import('./store.js');
const dataStore = await import('./data-store.js');
const registry = await import('../runtime/harness/approval-registry.js');

test('spaceActionNeedsApproval: composio writes/sends gate, reads do not', () => {
  assert.equal(gate.spaceActionNeedsApproval({ id: 'a', composioSlug: 'OUTLOOK_SEND_EMAIL' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'b', composioSlug: 'SALESFORCE_CREATE_RECORD' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'c', composioSlug: 'GOOGLECALENDAR_LIST_EVENTS' }), false);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'd', composioSlug: 'SALESFORCE_GET_CONTACTS' }), false);
});

test('spaceActionNeedsApproval: runner gates only when it looks like a send (or confirm:true)', () => {
  assert.equal(gate.spaceActionNeedsApproval({ id: 'send', label: 'Send email', runner: 'r.mjs' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'refresh', label: 'Refresh rows', runner: 'r.mjs' }), false);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'wipe', label: 'Wipe', runner: 'r.mjs', confirm: true }), true);
});

test('executeApprovedSpaceAction runs the action and records an "Approved and ran" note', async () => {
  const slug = 'gate-exec';
  store.spaceStore.save({
    id: slug, title: 'Exec',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs', argsTemplate: { from: 'me@co' } }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'),
    'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({sent:p.args}))})',
    'utf-8');

  await gate.executeApprovedSpaceAction({
    approvalId: 'apr-test', sessionId: `space-${slug}`, channel: null, channelId: null,
    requestedAt: '', expiresAt: '', subject: '', tool: gate.SPACE_ACTION_TOOL,
    args: { spaceSlug: slug, actionId: 'send', callerArgs: { to: 'lead@acme' } },
    status: 'resolved', resolution: 'approved', resolver: 'test', resolvedAt: '',
  });
  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /Approved and ran/.test(n.text) && n.meta?.ok === true));
});

test('enqueueSpaceActionApproval registers an approval + a pending note', () => {
  const slug = 'gate-enq';
  const rec = store.spaceStore.save({
    id: slug, title: 'Enq',
    actions: [{ id: 'email', label: 'Email', composioSlug: 'OUTLOOK_SEND_EMAIL' }],
  });
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'x@y' });
  assert.match(approvalId, /^apr-/);
  assert.ok(registry.listPending({ status: 'pending' }).some((r) => r.approvalId === approvalId));
  assert.ok(dataStore.listNotes(slug).some((n) => n.meta?.status === 'pending'));
});

test('resolving a gated approval as approved triggers execution via the listener', async () => {
  gate.initSpaceActionApprovals();
  const slug = 'gate-resolve';
  const rec = store.spaceStore.save({
    id: slug, title: 'Resolve',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:1}))', 'utf-8');

  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'x@y' });
  registry.resolve(approvalId, 'approved', 'test');
  // execution is fire-and-forget on resolve; give the echo runner a beat.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(dataStore.listNotes(slug).some((n) => /Approved and ran/.test(n.text)));
});
