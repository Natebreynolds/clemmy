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

function approvalRow(approvalId: string): registry.PendingApprovalRow {
  const row = registry.listPending({ status: 'pending' }).find((r) => r.approvalId === approvalId);
  assert.ok(row, `pending approval ${approvalId} exists`);
  return row!;
}

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

  const rec = store.spaceStore.get(slug)!;
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'lead@acme' });
  await gate.executeApprovedSpaceAction(approvalRow(approvalId));
  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /Approved and ran/.test(n.text) && n.meta?.ok === true));
});

test('executeApprovedSpaceAction refuses malformed hand-written action JSON after approval', async () => {
  const slug = 'gate-bad-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:true}))', 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Manifest',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const rec = store.spaceStore.get(slug)!;
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'lead@acme' });
  await gate.executeApprovedSpaceAction(approvalRow(approvalId));
  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /was not run after approval/.test(n.text) && n.meta?.ok === false));
  assert.ok(dataStore.listAudit(slug).some((a) => a.outcome === 'error' && /manifest is invalid/.test(a.note ?? '')));
});

test('executeApprovedSpaceAction refuses action manifest drift after approval', async () => {
  const slug = 'gate-drift-manifest';
  const rec = store.spaceStore.save({
    id: slug, title: 'Drift Manifest',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs', argsTemplate: { from: 'me@co' } }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:"original"}))', 'utf-8');
  writeFileSync(path.join(dir, 'other.mjs'), 'process.stdout.write(JSON.stringify({ok:"changed"}))', 'utf-8');

  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'lead@acme' });
  store.spaceStore.update(slug, {
    actions: [{ id: 'send', label: 'Send email', runner: 'other.mjs', argsTemplate: { from: 'other@co' } }],
  });
  await gate.executeApprovedSpaceAction(approvalRow(approvalId));

  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /action changed after approval/.test(n.text) && n.meta?.ok === false));
  assert.equal(notes.some((n) => /Approved and ran/.test(n.text)), false);
});

test('executeApprovedSpaceAction refuses runner file drift after approval', async () => {
  const slug = 'gate-drift-runner';
  const rec = store.spaceStore.save({
    id: slug, title: 'Drift Runner',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:"approved-version"}))', 'utf-8');

  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'lead@acme' });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:"mutated-version"}))', 'utf-8');
  await gate.executeApprovedSpaceAction(approvalRow(approvalId));

  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /action changed after approval/.test(n.text) && n.meta?.ok === false));
  assert.equal(notes.some((n) => /Approved and ran/.test(n.text)), false);
});

test('executeApprovedSpaceAction refuses approval after workspace is archived', async () => {
  const slug = 'gate-archived-before-approval';
  const rec = store.spaceStore.save({
    id: slug, title: 'Archived Before Approval',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({sent:true}))', 'utf-8');

  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'lead@acme' });
  store.spaceStore.archive(slug);
  await gate.executeApprovedSpaceAction(approvalRow(approvalId));

  const notes = dataStore.listNotes(slug);
  assert.ok(notes.some((n) => /was not run after approval: workspace is archived/.test(n.text) && n.meta?.ok === false));
  assert.equal(notes.some((n) => /Approved and ran/.test(n.text)), false);
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
  // Execution is fire-and-forget on resolve and spawns a runner subprocess —
  // POLL for the note rather than sleeping a fixed delay (a fixed wait flaked
  // under full-suite load when the subprocess was delayed by other test files).
  let ran = false;
  let lastNotes = dataStore.listNotes(slug);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !ran) {
    await new Promise((r) => setTimeout(r, 50));
    lastNotes = dataStore.listNotes(slug);
    ran = lastNotes.some((n) => /Approved and ran/.test(n.text));
  }
  assert.ok(
    ran,
    `expected the approved action to run and record an "Approved and ran" note; notes=${JSON.stringify(lastNotes)}`,
  );
});
