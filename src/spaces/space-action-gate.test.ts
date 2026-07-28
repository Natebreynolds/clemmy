/**
 * Run: npx tsx --test src/spaces/space-action-gate.test.ts
 *
 * E1 — the workspace action gate: classification (what needs one approval) +
 * execute-on-approve. Temp CLEMENTINE_HOME; no network (composio classification
 * is by slug only; the execute path uses a local echo runner).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-action-gate-'));

const gate = await import('./space-action-gate.js');
const store = await import('./store.js');
const dataStore = await import('./data-store.js');
const runner = await import('./runner.js');
const registry = await import('../runtime/harness/approval-registry.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

function approvalRow(approvalId: string): registry.PendingApprovalRow {
  const row = registry.listPending({ status: 'pending' }).find((r) => r.approvalId === approvalId);
  assert.ok(row, `pending approval ${approvalId} exists`);
  return row!;
}

function resolveApproval(
  approvalId: string,
  resolution: registry.ApprovalResolution = 'approved',
): registry.PendingApprovalRow {
  const result = registry.resolve(approvalId, resolution, 'space-action-gate-test');
  assert.equal(result.ok, true, `approval ${approvalId} should resolve ${resolution}`);
  assert.ok(result.row);
  return result.row!;
}

function writeCountingRunner(
  slug: string,
  file = 'act.mjs',
  exitCode = 0,
  failureText = 'provider outcome unknown',
): string {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  writeFileSync(target, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const file = new URL('./dispatch-count.txt', import.meta.url);",
    "const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;",
    "writeFileSync(file, String(count + 1));",
    exitCode === 0
      ? "process.stdout.write(JSON.stringify({ dispatched: count + 1 }));"
      : `process.stderr.write(${JSON.stringify(failureText)}); process.exit(${exitCode});`,
  ].join('\n'), 'utf-8');
  return target;
}

function dispatchCount(slug: string): number {
  const file = store.resolveInSpace(slug, path.join('data', 'dispatch-count.txt'));
  return existsSync(file) ? Number(readFileSync(file, 'utf-8')) : 0;
}

function mutationPhaseCounts(approvalId: string): { receipts: number; commits: number } {
  const root = path.join(
    WORKFLOWS_DIR,
    gate.SPACE_ACTION_MUTATION_WORKFLOW_SLUG,
    'runs',
    approvalId,
    'call-mutations',
  );
  if (!existsSync(root)) return { receipts: 0, commits: 0 };
  const operationDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
  return {
    receipts: operationDirs.filter((dir) => existsSync(path.join(dir, 'receipt.json'))).length,
    commits: operationDirs.filter((dir) => existsSync(path.join(dir, 'commit.json'))).length,
  };
}

test('spaceActionNeedsApproval: composio writes/sends gate, reads do not', () => {
  assert.equal(gate.spaceActionNeedsApproval({ id: 'a', composioSlug: 'OUTLOOK_SEND_EMAIL' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'b', composioSlug: 'SALESFORCE_CREATE_RECORD' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'upload', composioSlug: 'ONE_DRIVE_UPLOAD_FILE' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'mark', composioSlug: 'GMAIL_MARK_AS_READ' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'unknown', composioSlug: 'ACME_DO_THING' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'c', composioSlug: 'GOOGLECALENDAR_LIST_EVENTS' }), false);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'd', composioSlug: 'SALESFORCE_GET_CONTACTS' }), false);
});

test('spaceActionNeedsApproval: local runner actions stay instant while outbound semantics gate', () => {
  assert.equal(gate.spaceActionNeedsApproval({ id: 'send', label: 'Send email', runner: 'r.mjs' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'refresh', label: 'Refresh rows', runner: 'r.mjs' }), false);
  assert.equal(gate.spaceActionNeedsApproval({
    id: 'approve_post',
    label: 'Approve locally',
    runner: 'approve-post.mjs',
    argsTemplate: { external: false },
  }), false, 'an explicitly local state change must not create a redundant second approval');
  assert.equal(gate.spaceActionNeedsApproval({
    id: 'send_email',
    label: 'Send email',
    runner: 'send.mjs',
    argsTemplate: { external: false },
  }), true, 'outbound semantics cannot waive approval with an external:false claim');
  assert.equal(gate.spaceActionNeedsApproval({
    id: 'post_to_linkedin',
    label: 'Post to LinkedIn',
    runner: 'publish.mjs',
  }), true);
  for (const id of ['review_post', 'post_draft', 'email_draft', 'message_preview']) {
    assert.equal(
      gate.spaceActionNeedsApproval({ id, runner: `${id}.mjs` }),
      false,
      `${id} is a local artifact/review action`,
    );
  }
  for (const id of ['send_email', 'publish_post']) {
    assert.equal(
      gate.spaceActionNeedsApproval({ id, runner: `${id}.mjs` }),
      true,
      `${id} is explicit outbound delivery`,
    );
  }
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
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));
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
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));
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
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));

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
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));

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
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));

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

test('a pending or rejected Space approval is zero-write even if the executor is called directly or recovery runs', async () => {
  const slug = 'gate-zero-write';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Zero Write',
    actions: [{ id: 'sync', label: 'Sync', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);

  const first = gate.enqueueSpaceActionApproval(rec, rec.actions[0], {});
  await gate.executeApprovedSpaceAction(approvalRow(first.approvalId));
  assert.equal(dispatchCount(slug), 0, 'a still-pending card has no execution authority');

  resolveApproval(first.approvalId, 'rejected');
  await gate.recoverApprovedSpaceActions();
  assert.equal(dispatchCount(slug), 0, 'rejection remains zero-write during recovery');
});

test('approved Space action recovers after restart and replays one durable receipt/commit without duplicate dispatch', async () => {
  const slug = 'gate-restart-recovery';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Restart Recovery',
    actions: [{ id: 'sync', label: 'Sync', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);
  const callerArgs = { recordId: 'row-1' };
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], callerArgs);
  resolveApproval(approvalId);

  // Simulate the process reaching the durable provider boundary and committing,
  // then dying before executeApprovedSpaceAction could append its UI outcome.
  const first = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId },
  );
  assert.equal(first.ok, true);
  assert.equal(dispatchCount(slug), 1);
  assert.equal(
    dataStore.listNotes(slug).filter((note) => note.meta?.approvalId === approvalId && note.meta?.status === 'executed').length,
    0,
    'crash seam has no local completion note yet',
  );

  store.spaceStore.update(slug, { actions: [] });
  store.spaceStore.archive(slug);
  await gate.recoverApprovedSpaceActions();
  await gate.recoverApprovedSpaceActions();

  assert.equal(dispatchCount(slug), 1, 'boot recovery replays the committed receipt before mutable archive/action checks');
  assert.deepEqual(mutationPhaseCounts(approvalId), { receipts: 1, commits: 1 });
  assert.equal(
    dataStore.listNotes(slug).filter((note) => note.meta?.approvalId === approvalId && note.meta?.status === 'executed').length,
    1,
    'completion is projected once even when recovery is invoked repeatedly',
  );
});

test('approved Composio Space action crosses one durable gateway boundary and replays its exact receipt', async () => {
  const slug = 'gate-composio-receipt';
  const approvalId = 'apr-space-composio-receipt';
  const action = {
    id: 'publish',
    label: 'Publish approved post',
    composioSlug: 'PROOF_SOCIAL_PUBLISH',
    argsTemplate: { destination: 'proof-only' },
    confirm: true,
  };
  let providerDispatches = 0;
  runner._setSpaceComposioDispatchForTests(async (toolSlug, args, opts) => {
    assert.equal(toolSlug, 'PROOF_SOCIAL_PUBLISH');
    const dispatch = async () => {
      providerDispatches += 1;
      return { successful: true, data: { receipt: 'space-proof-1', args } };
    };
    const result = opts.dispatchBoundary
      ? await opts.dispatchBoundary({
          toolSlug,
          args,
          connectionId: 'ca-proof',
          identity: 'proof@example.test',
        }, dispatch)
      : await dispatch();
    return {
      ok: true as const,
      result,
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    const first = await runner.runSpaceAction(
      slug,
      action,
      { draftMarker: 'DRAFT_MARKER:exact' },
      { approvalId },
    );
    const replay = await runner.runSpaceAction(
      slug,
      action,
      { draftMarker: 'DRAFT_MARKER:exact' },
      { approvalId },
    );

    assert.equal(first.ok, true);
    assert.deepEqual(replay, first);
    assert.equal(providerDispatches, 1, 'committed Space action never re-enters the provider gateway');
    assert.deepEqual(mutationPhaseCounts(approvalId), { receipts: 1, commits: 1 });
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('runner-controlled no-dispatch wording cannot make an ambiguous action replayable', async () => {
  const slug = 'gate-ambiguous';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Ambiguous',
    actions: [{ id: 'sync', label: 'Sync', runner: 'act.mjs' }],
  });
  writeCountingRunner(
    slug,
    'act.mjs',
    23,
    'runner failed to launch after provider dispatch',
  );
  const callerArgs = { recordId: 'row-ambiguous' };
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], callerArgs);
  const row = resolveApproval(approvalId);

  await gate.executeApprovedSpaceAction(row);
  const retry = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId },
  );
  await gate.recoverApprovedSpaceActions();

  assert.equal(retry.ok, false);
  assert.match(retry.ok ? '' : retry.error, /may already have committed|outcome.*uncertain|NOT dispatched again/i);
  assert.equal(dispatchCount(slug), 1, 'neither direct retry nor restart recovery re-dispatches ambiguity');
  assert.deepEqual(mutationPhaseCounts(approvalId), { receipts: 0, commits: 0 });
  const uncertain = dataStore.listNotes(slug).filter((note) => (
    note.meta?.approvalId === approvalId && note.meta?.status === 'uncertain'
  ));
  assert.equal(uncertain.length, 1, 'ambiguous execution projects one durable uncertain outcome');
  assert.match(uncertain[0]?.text ?? '', /may already have run|outcome is uncertain|verify the destination/i);
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
