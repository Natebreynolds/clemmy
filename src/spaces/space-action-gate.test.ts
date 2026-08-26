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
const eventlog = await import('../runtime/harness/eventlog.js');
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

test('spaceActionNeedsApproval: every opaque runner action gates regardless of its label', () => {
  assert.equal(gate.spaceActionNeedsApproval({ id: 'send', label: 'Send email', runner: 'r.mjs' }), true);
  assert.equal(gate.spaceActionNeedsApproval({ id: 'refresh', label: 'Refresh rows', runner: 'r.mjs' }), true);
  assert.equal(gate.spaceActionNeedsApproval({
    id: 'approve_post',
    label: 'Approve locally',
    runner: 'approve-post.mjs',
    argsTemplate: { external: false },
  }), true, 'runner-controlled metadata cannot waive execution approval');
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
      true,
      `${id} is still opaque executable code`,
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

test('executeApprovedSpaceAction records a zero-body failure without shared durable authority', async () => {
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
  assert.ok(notes.some((n) => /was not run after approval.*no shared durable call authority/i.test(n.text) && n.meta?.ok === false));
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
  const inlineCard = eventlog.listEvents(`space-${slug}`, { types: ['approval_requested'] })
    .find((event) => (event.data as { approvalId?: string }).approvalId === approvalId);
  assert.ok(inlineCard, 'the exact action card is visible inside Workspace chat');
});

test('runner action approval discloses pinned-entrypoint scope but remains zero-process', async () => {
  const slug = 'gate-runner-entrypoint-snapshot';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Runner Entrypoint Snapshot',
    actions: [{ id: 'sync', label: 'Sync record', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);
  const callerArgs = { recordId: 'row-pinned' };
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], callerArgs);
  const pending = approvalRow(approvalId);
  assert.match(String(pending.args?.reason ?? ''), /pinned entrypoint/i);
  assert.match(String(pending.args?.reason ?? ''), /helpers.*packages.*CLIs.*local files.*auth.*network/i);
  assert.match(String(pending.args?.reason ?? ''), /not.*read-only sandbox/i);
  const result = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId: resolveApproval(approvalId).approvalId },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.provenNoDispatch, true);
  assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
  assert.equal(dispatchCount(slug), 0);
  assert.equal(
    existsSync(store.resolveInSpace(slug, 'data/unapproved-action.txt')),
    false,
    'no bytes cross the process boundary',
  );
});

test('identical pending Workspace action retries converge on one approval, note, and audit projection', async () => {
  const slug = 'gate-pending-dedupe';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Pending Dedupe',
    actions: [
      { id: 'send', label: 'Send email', composioSlug: 'OUTLOOK_SEND_EMAIL' },
      { id: 'archive', label: 'Archive email', composioSlug: 'OUTLOOK_ARCHIVE_EMAIL' },
    ],
  });
  const exactArgs = {
    to: 'lead@example.test',
    payload: { subject: 'Exact subject', body: 'Exact body' },
  };

  // Model two route requests admitted in the same event-loop turn, followed by
  // an ordinary client retry. All three name the same still-pending mutation.
  const [first, concurrentRetry] = await Promise.all([
    Promise.resolve().then(() => gate.enqueueSpaceActionApproval(rec, rec.actions[0], exactArgs)),
    Promise.resolve().then(() => gate.enqueueSpaceActionApproval(rec, rec.actions[0], {
      payload: { body: 'Exact body', subject: 'Exact subject' },
      to: 'lead@example.test',
    })),
  ]);
  const sequentialRetry = gate.enqueueSpaceActionApproval(rec, rec.actions[0], exactArgs);

  assert.equal(concurrentRetry.approvalId, first.approvalId);
  assert.equal(sequentialRetry.approvalId, first.approvalId);
  assert.equal(
    registry.listPending({ status: 'pending' }).filter((row) => (
      row.tool === gate.SPACE_ACTION_TOOL
      && row.args?.spaceSlug === slug
      && row.args?.actionId === 'send'
    )).length,
    1,
    'only one durable pending card owns the exact payload',
  );
  assert.equal(
    dataStore.listNotes(slug).filter((note) => (
      note.meta?.approvalId === first.approvalId && note.meta?.status === 'pending'
    )).length,
    1,
    'the shared card is projected once into Workspace notes',
  );
  assert.equal(
    dataStore.listAudit(slug).filter((entry) => (
      entry.method === 'ACTION_PENDING'
      && entry.path === '/action/send'
      && entry.note === first.approvalId
    )).length,
    1,
    'the shared card is projected once into the Workspace audit',
  );

  const differentArgs = gate.enqueueSpaceActionApproval(
    rec,
    rec.actions[0],
    { ...exactArgs, to: 'other@example.test' },
  );
  const differentAction = gate.enqueueSpaceActionApproval(rec, rec.actions[1], exactArgs);
  assert.notEqual(differentArgs.approvalId, first.approvalId, 'a different recipient keeps distinct authority');
  assert.notEqual(differentAction.approvalId, first.approvalId, 'a different action keeps distinct authority');
  assert.notEqual(differentAction.approvalId, differentArgs.approvalId);
});

test('duplicate Workspace clicks converge on one approval while contained reruns stay zero-process', async () => {
  const slug = 'gate-dispatch-dedupe';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Dispatch Dedupe',
    actions: [{ id: 'sync', label: 'Sync record', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);
  const exactArgs = { recordId: 'row-exact', payload: { value: 7 } };

  const first = gate.enqueueSpaceActionApproval(rec, rec.actions[0], exactArgs);
  const duplicate = gate.enqueueSpaceActionApproval(rec, rec.actions[0], exactArgs);
  const pendingIds = [...new Set([first.approvalId, duplicate.approvalId])];
  for (const approvalId of pendingIds) {
    await gate.executeApprovedSpaceAction(resolveApproval(approvalId));
  }

  assert.deepEqual(pendingIds, [first.approvalId], 'double-click exposes only one approvable mutation slot');
  assert.equal(dispatchCount(slug), 0);
  assert.deepEqual(mutationPhaseCounts(first.approvalId), { receipts: 0, commits: 0 });

  const deliberateRerun = gate.enqueueSpaceActionApproval(rec, rec.actions[0], exactArgs);
  assert.notEqual(
    deliberateRerun.approvalId,
    first.approvalId,
    'after the first card is terminal, a deliberate rerun gets a fresh decision record',
  );
  await gate.executeApprovedSpaceAction(resolveApproval(deliberateRerun.approvalId));
  assert.equal(dispatchCount(slug), 0);
  assert.deepEqual(mutationPhaseCounts(deliberateRerun.approvalId), { receipts: 0, commits: 0 });
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

test('runSpaceAction rejects fabricated, pending, wrong-action, and wrong-args approval ids', async () => {
  const slug = 'gate-exact-runtime-authority';
  const callerArgs = { recordId: 'row-1', payload: { value: 7 } };
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Exact Runtime Authority',
    actions: [{ id: 'sync', label: 'Sync', runner: 'act.mjs', confirm: true }],
  });
  writeCountingRunner(slug);

  const fabricated = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId: 'apr-fabricated' },
  );
  assert.equal(fabricated.ok, false);
  assert.equal(dispatchCount(slug), 0);

  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], callerArgs);
  const copiedArgs = approvalRow(approvalId).args;
  const stillPending = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId },
  );
  assert.equal(stillPending.ok, false);
  assert.equal(dispatchCount(slug), 0);

  resolveApproval(approvalId);
  eventlog.createSession({ id: 'foreign-space-authority', kind: 'chat', title: 'Foreign' });
  const foreign = registry.register({
    sessionId: 'foreign-space-authority',
    subject: 'Copied Workspace approval',
    tool: gate.SPACE_ACTION_TOOL,
    args: copiedArgs,
  });
  resolveApproval(foreign.approvalId);
  const wrongArgs = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    { ...callerArgs, recordId: 'row-2' },
    { approvalId },
  );
  const wrongAction = await runner.runSpaceAction(
    slug,
    { ...rec.actions[0], id: 'other-action' },
    callerArgs,
    { approvalId },
  );
  const wrongSession = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId: foreign.approvalId },
  );
  assert.equal(wrongArgs.ok, false);
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongSession.ok, false);
  assert.equal(dispatchCount(slug), 0, 'mismatched durable authority stays zero-dispatch');

  const exact = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId },
  );
  assert.equal(exact.ok, false);
  assert.equal(exact.ok ? undefined : exact.provenNoDispatch, true);
  assert.match(exact.ok ? '' : exact.error, /no shared durable call authority/i);
  assert.equal(dispatchCount(slug), 0, 'an exact legacy approval still cannot dispatch');
});

test('approved Space action recovery never treats the legacy wrapper as authority', async () => {
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

  // The exact approval is still missing shared-kernel logical/physical
  // authority, so it cannot create a legacy mutation receipt.
  const first = await runner.runSpaceAction(
    slug,
    rec.actions[0],
    callerArgs,
    { approvalId },
  );
  assert.equal(first.ok, false);
  assert.equal(first.ok ? undefined : first.provenNoDispatch, true);
  assert.equal(dispatchCount(slug), 0);
  assert.equal(
    dataStore.listNotes(slug).filter((note) => note.meta?.approvalId === approvalId && note.meta?.status === 'executed').length,
    0,
    'crash seam has no local completion note yet',
  );

  store.spaceStore.update(slug, { actions: [] });
  store.spaceStore.archive(slug);
  await gate.recoverApprovedSpaceActions();
  await gate.recoverApprovedSpaceActions();

  assert.equal(dispatchCount(slug), 0);
  assert.deepEqual(mutationPhaseCounts(approvalId), { receipts: 0, commits: 0 });
  assert.equal(
    dataStore.listNotes(slug).filter((note) => note.meta?.approvalId === approvalId && note.meta?.status === 'failed').length,
    1,
    'zero-body failure is projected once even when recovery is invoked repeatedly',
  );
});

test('approved Composio Space action remains zero-body without shared durable call authority', async () => {
  const slug = 'gate-composio-receipt';
  const action = {
    id: 'publish',
    label: 'Publish approved post',
    composioSlug: 'PROOF_SOCIAL_PUBLISH',
    argsTemplate: { destination: 'proof-only' },
    confirm: true,
  };
  const callerArgs = { draftMarker: 'DRAFT_MARKER:exact' };
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Composio Receipt',
    actions: [action],
  });
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], callerArgs);
  resolveApproval(approvalId);
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
      callerArgs,
      { approvalId },
    );
    const replay = await runner.runSpaceAction(
      slug,
      action,
      callerArgs,
      { approvalId },
    );

    assert.equal(first.ok, false);
    assert.match(first.ok ? '' : first.error, /no shared durable call authority/i);
    assert.deepEqual(replay, first);
    assert.equal(providerDispatches, 0, 'legacy approval never becomes provider authority');
    assert.deepEqual(
      mutationPhaseCounts(approvalId),
      { receipts: 0, commits: 0 },
      'the retired workflow mutation wrapper cannot manufacture Space Composio authority',
    );
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('runner-controlled ambiguity wording is unreachable at the zero-process boundary', async () => {
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
  assert.equal(retry.ok ? undefined : retry.provenNoDispatch, true);
  assert.match(retry.ok ? '' : retry.error, /no shared durable call authority/i);
  assert.equal(dispatchCount(slug), 0);
  assert.deepEqual(mutationPhaseCounts(approvalId), { receipts: 0, commits: 0 });
  const failed = dataStore.listNotes(slug).filter((note) => (
    note.meta?.approvalId === approvalId && note.meta?.status === 'failed'
  ));
  assert.equal(failed.length, 1, 'containment projects one deterministic not-run outcome');
  assert.doesNotMatch(failed[0]?.text ?? '', /runner failed to launch after provider dispatch/i);
});

test('resolving a gated approval triggers a prompt zero-body failure via the listener', async () => {
  gate.initSpaceActionApprovals();
  const captured: Array<Record<string, unknown>> = [];
  gate._setWorkspaceActionMemoryCaptureForTests(async (signal) => {
    captured.push(signal as unknown as Record<string, unknown>);
    return { status: 'recorded', reason: null, episodeId: 'episode-proof', wake: true };
  });
  const slug = 'gate-resolve';
  const rec = store.spaceStore.save({
    id: slug, title: 'Resolve',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:1}))', 'utf-8');

  try {
    const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'x@y' });
    registry.resolve(approvalId, 'approved', 'test');
    // Resolution is fire-and-forget; poll for its deterministic not-run note.
    let contained = false;
    let lastNotes = dataStore.listNotes(slug);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !contained) {
      await new Promise((r) => setTimeout(r, 20));
      lastNotes = dataStore.listNotes(slug);
      contained = lastNotes.some((n) => (
        n.meta?.approvalId === approvalId
        && n.meta?.status === 'failed'
        && /no shared durable call authority/i.test(n.text)
      ));
    }
    assert.ok(
      contained,
      `expected the approved action to record a zero-body failure; notes=${JSON.stringify(lastNotes)}`,
    );
    const matching = captured.filter((signal) => signal.observationId === approvalId);
    assert.equal(matching.length, 0, 'a not-run effect is not learned as a completed approved effect');
  } finally {
    gate._setWorkspaceActionMemoryCaptureForTests(null);
  }
});

test('an explicit Workspace action rejection becomes a memory outcome without dispatch', async () => {
  gate.initSpaceActionApprovals();
  const captured: Array<Record<string, unknown>> = [];
  gate._setWorkspaceActionMemoryCaptureForTests(async (signal) => {
    captured.push(signal as unknown as Record<string, unknown>);
    return { status: 'recorded', reason: null, episodeId: 'episode-rejected', wake: true };
  });
  const slug = 'gate-rejected-memory';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Rejected Memory',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);
  try {
    const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'x@y' });
    registry.resolve(approvalId, 'rejected', 'test');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dispatchCount(slug), 0);
    const matching = captured.filter((signal) => signal.observationId === approvalId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.kind, 'effect_outcome');
    assert.equal(matching[0]?.decision, 'rejected');
  } finally {
    gate._setWorkspaceActionMemoryCaptureForTests(null);
  }
});

test('boot recovery re-projects an authoritative rejection when the first memory write was interrupted', async () => {
  gate.initSpaceActionApprovals();
  const slug = 'gate-rejected-memory-recovery';
  const rec = store.spaceStore.save({
    id: slug,
    title: 'Rejected Memory Recovery',
    actions: [{ id: 'send', label: 'Send email', runner: 'act.mjs' }],
  });
  writeCountingRunner(slug);

  gate._setWorkspaceActionMemoryCaptureForTests(async () => {
    throw new Error('simulated crash before memory projection');
  });
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, rec.actions[0], { to: 'x@y' });
  registry.resolve(approvalId, 'rejected', 'test');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const recovered: Array<Record<string, unknown>> = [];
  gate._setWorkspaceActionMemoryCaptureForTests(async (signal) => {
    recovered.push(signal as unknown as Record<string, unknown>);
    return { status: 'recorded', reason: null, episodeId: 'episode-recovered', wake: true };
  });
  try {
    await gate.recoverApprovedSpaceActions();
    assert.equal(dispatchCount(slug), 0);
    const matching = recovered.filter((signal) => signal.observationId === approvalId);
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.decision, 'rejected');
    assert.equal(
      dataStore.listNotes(slug).filter((note) => note.meta?.approvalId === approvalId).length,
      2,
      'one pending note and one terminal note remain; recovery adds no duplicate',
    );
  } finally {
    gate._setWorkspaceActionMemoryCaptureForTests(null);
  }
});

test('standing trust can cover a decision but cannot mint local process authority', async () => {
  // Live complaint 2026-07-30: "I was simply updating the Salesforce data" —
  // a hash-pinned read runner re-asked on every refresh click.
  const slug = 'gate-standing';
  store.spaceStore.save({
    id: slug, title: 'Standing',
    actions: [{ id: 'refresh_sf', label: 'Refresh from Salesforce', runner: 'act.mjs', confirm: true }],
  });
  writeCountingRunner(slug);
  const rec = store.spaceStore.get(slug)!;
  const action = rec.actions[0];

  // Eligibility boundary: local non-outbound runner yes; sends and Composio never.
  assert.equal(gate.standingActionTrustEligible(action), true);
  assert.equal(gate.standingActionTrustEligible({ id: 'send_email', label: 'Send email', runner: 's.mjs' }), false, 'outbound stays per-invocation');
  assert.equal(gate.standingActionTrustEligible({ id: 'u', composioSlug: 'GMAIL_SEND_EMAIL' }), false, 'composio mutations stay per-invocation');

  // No coverage before any approval.
  assert.equal(gate.standingSpaceActionAuthority(rec, action, {}), null);

  // First click: one card, approved by the human; the approved row carries the
  // 90-day grant window.
  const { approvalId } = gate.enqueueSpaceActionApproval(rec, action, {});
  const row = approvalRow(approvalId);
  assert.match(String(row.args?.reason ?? ''), /STANDING trust/i, 'the card DISCLOSES that approval grants standing trust');
  assert.ok(Date.parse(row.expiresAt) - Date.now() > 80 * 24 * 60 * 60 * 1000, 'grant window ≈ 90 days, not the 24h decision default');
  await gate.executeApprovedSpaceAction(resolveApproval(approvalId));
  assert.equal(dispatchCount(slug), 0);

  // Second click is decision-covered under the same approval, but still has no
  // shared-kernel activation/plan and therefore remains zero-process.
  const standing = gate.standingSpaceActionAuthority(rec, action, {});
  assert.ok(standing?.ok, 'the prior approval covers an identical invocation');
  assert.equal(standing!.approvalId, approvalId);
  const second = await runner.runSpaceAction(slug, action, {}, {
    approvalId: standing!.approvalId,
    executionNonce: 'nonce-2',
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok ? undefined : second.provenNoDispatch, true);
  assert.match(second.ok ? '' : second.error, /no shared durable call authority/i);
  assert.equal(dispatchCount(slug), 0);

  // Different caller args = a different question — not covered.
  assert.equal(gate.standingSpaceActionAuthority(rec, action, { window: '180d' }), null);

  // Editing the runner voids the grant before any spawn.
  writeFileSync(path.join(store.resolveInSpace(slug, 'data'), 'act.mjs'),
    'process.stdout.write(JSON.stringify({ changed: true }))', 'utf-8');
  assert.equal(gate.standingSpaceActionAuthority(store.spaceStore.get(slug)!, action, {}), null, 'byte drift re-asks');
});
