import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-approval-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.CLEMMY_APPROVAL_POLL_MS = '15'; // fast poll for the test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, listEvents } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { buildGatedToolPermission, workflowApprovalResumeKey } = await import('./claude-agent-approval.js');
const { closePlanScope, destructivePlanActionKey, openPlanScope } = await import('../../agents/plan-scope.js');

// These tests exercise the approval-GATE MACHINERY (register → await →
// allow/deny, park mode, replay safety). Their precondition is "this action
// requires approval." The default posture is now 'yolo' (Autonomous, 2026-07-20)
// which auto-approves reversible/local + CRM writes, so pin the Supervised
// posture ('strict') to keep a destructive shell / CRM write held for approval.
// (This reproduces the pre-2026-07-20 default, when 'balanced' == strict on the
// execution gate.) Irreversible sends are held regardless of posture.
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
saveProactivityPolicy({ autoApproveScope: 'strict' });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const opts = (): unknown => ({ signal: new AbortController().signal, toolUseID: 't' });
type Perm = (name: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string; updatedInput?: Record<string, unknown>; interrupt?: boolean }>;

async function waitForPending(sessionId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const rows = approvalRegistry.listPending({ sessionId });
    if (rows.length > 0) return rows[0].approvalId;
    await sleep(10);
  }
  throw new Error('approval was never registered');
}

test('gated permission: read/local tools fast-allow, no approval registered', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const res = await perm('mcp__clementine-local__memory_read', { query: 'x' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.updatedInput, { query: 'x' }, 'the CLI control protocol requires updatedInput on EVERY allow');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'a read never registers an approval');
});

test('gated permission does not claim a tool executed before the SDK stream reports tool_use', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  await perm('mcp__clementine-local__memory_read', { query: 'x' }, { signal: new AbortController().signal, toolUseID: 'toolu_visible_1' });

  const events = listEvents(sess.id, { types: ['tool_called'] });
  assert.equal(events.length, 0);
});

test('gated permission: auto-approved mutating tool (no human needed) also carries updatedInput', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read', 'task_hygiene']) as unknown as Perm;
  // task_hygiene is in the fast-allow list here; the regression this pins is the
  // ALLOW SHAPE — a bare {behavior:'allow'} fails the CLI's Zod parse
  // ("updatedInput expected record, received undefined" — 2026-07-02 end-of-day).
  const res = await perm('mcp__clementine-local__task_hygiene', { mode: 'ledger' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.updatedInput, { mode: 'ledger' });
});

test('workflow resume keys retain native provider/tool namespace boundaries', () => {
  const args = { item_id: 'same-item' };
  assert.notEqual(
    workflowApprovalResumeKey('same-session', 'alpha__bc', args),
    workflowApprovalResumeKey('same-session', 'alph__abc', args),
    'distinct delimiter-bearing authorities must not collapse before hashing',
  );
});

test('gated permission: malformed native carrier cannot inherit a local fast-allow tail', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(
      sess.id,
      ['memory_read'],
      { approvalMode: 'park' },
    ) as unknown as Perm;
    const result = await perm('mcp__memory_read', { query: 'looks local' }, opts());
    assert.equal(result.behavior, 'deny');
    assert.equal(result.interrupt, true);
    assert.equal(
      approvalRegistry.listPending({ sessionId: sess.id })[0]?.tool,
      'mcp__memory_read',
      'the raw malformed carrier remains the exact approval authority',
    );
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: a namespaced native delete cannot ride a bare-name fast allow under yolo', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const args = { item_id: 'sharepoint-item-1' };
    // This deliberately reproduces the sharpest bypass: a profile mistakenly
    // lists the display-friendly tail as fast-safe. The original MCP identity
    // still proves DELETE and must win before the shortcut.
    const build = (): Perm => buildGatedToolPermission(
      sess.id,
      ['memory_read', 'sharepoint_delete_item'],
      { approvalMode: 'park' },
    ) as unknown as Perm;

    const first = await build()(
      'mcp__m365__sharepoint_delete_item',
      args,
      opts(),
    );
    assert.equal(first.behavior, 'deny');
    assert.equal(first.interrupt, true, 'the delete parks before provider dispatch');
    assert.match(first.message ?? '', /Approval .* pending/i);
    const [card] = approvalRegistry.listPending({ sessionId: sess.id });
    assert.ok(card, 'one exact-payload approval card is created');
    assert.equal(card.tool, 'm365__sharepoint_delete_item', 'the card retains provider authority');

    approvalRegistry.resolve(card.approvalId, 'approved', 'unit-test-human');
    const approved = await build()(
      'mcp__m365__sharepoint_delete_item',
      args,
      opts(),
    );
    assert.equal(approved.behavior, 'allow', 'the existing exact human grant still authorizes one retry');
    assert.deepEqual(approved.updatedInput, args);
    assert.ok(approvalRegistry.get(card.approvalId)?.consumedAt, 'the prior approval is consumed exactly once');

    const replay = await build()(
      'mcp__m365__sharepoint_delete_item',
      args,
      opts(),
    );
    assert.equal(replay.behavior, 'deny', 'the consumed delete grant cannot be replayed');
    assert.equal(replay.interrupt, false);
    assert.match(replay.message ?? '', /already .*(approved|executed)/i);
    assert.equal(
      approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length,
      1,
      'approval/replay uses one durable card',
    );
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: one provider cannot consume another provider\'s same-tail delete approval', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const args = { item_id: 'same-item-id' };
    const build = (): Perm => buildGatedToolPermission(
      sess.id,
      ['memory_read', 'delete_item'],
      { approvalMode: 'park' },
    ) as unknown as Perm;

    const alphaHeld = await build()('mcp__alpha__delete_item', args, opts());
    assert.equal(alphaHeld.behavior, 'deny');
    const [alphaCard] = approvalRegistry.listPending({ sessionId: sess.id });
    assert.ok(alphaCard);
    assert.equal(alphaCard.tool, 'alpha__delete_item');
    approvalRegistry.resolve(alphaCard.approvalId, 'approved', 'unit-test-human');

    const betaAttempt = await build()('mcp__beta__delete_item', args, opts());
    assert.equal(betaAttempt.behavior, 'deny', 'beta cannot ride alpha\'s approval');
    assert.equal(betaAttempt.interrupt, true);
    const [betaCard] = approvalRegistry.listPending({ sessionId: sess.id });
    assert.ok(betaCard);
    assert.equal(betaCard.tool, 'beta__delete_item');
    assert.notEqual(betaCard.approvalId, alphaCard.approvalId);

    const alphaResume = await build()('mcp__alpha__delete_item', args, opts());
    assert.equal(alphaResume.behavior, 'allow', 'the original provider still owns its exact grant');
    assert.ok(approvalRegistry.get(alphaCard.approvalId)?.consumedAt);
    assert.equal(approvalRegistry.get(betaCard.approvalId)?.status, 'pending');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: destructive native plan scope matches exact server-qualified authority', async () => {
  const sess = createSession({ kind: 'workflow' });
  const args = { item_id: 'duplicate-1' };
  const exactDelete = destructivePlanActionKey('m365__sharepoint_delete_item', args);
  assert.ok(exactDelete);
  openPlanScope({
    sessionId: sess.id,
    planProposalId: 'approved-native-cleanup',
    approvedPlanObjective: 'Delete one SharePoint duplicate',
    allowedTools: ['m365__sharepoint_delete_item'],
    allowedDestructiveActions: [exactDelete!],
  });
  try {
    const perm = buildGatedToolPermission(
      sess.id,
      ['memory_read'],
      { approvalMode: 'park' },
    ) as unknown as Perm;
    const covered = await perm('mcp__m365__sharepoint_delete_item', args, opts());
    assert.equal(covered.behavior, 'allow', 'the explicitly named native action is already consented');
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0);

    const otherProvider = await perm('mcp__other__sharepoint_delete_item', args, opts());
    assert.equal(otherProvider.behavior, 'deny', 'same tail from another provider is outside scope');
    const [card] = approvalRegistry.listPending({ sessionId: sess.id });
    assert.equal(card?.tool, 'other__sharepoint_delete_item');
  } finally {
    closePlanScope(sess.id, 'test-done');
  }
});

test('gated permission: hyphen, dot, and camelCase native deletes all gate', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    for (const tool of ['delete-item', 'delete.item', 'deleteItem']) {
      const sess = createSession({ kind: 'chat' });
      const perm = buildGatedToolPermission(
        sess.id,
        ['memory_read', tool],
        { approvalMode: 'park' },
      ) as unknown as Perm;
      const result = await perm(`mcp__m365__${tool}`, { item_id: `item-${tool}` }, opts());
      assert.equal(result.behavior, 'deny', `${tool} must not ride YOLO/fast-allow`);
      assert.equal(result.interrupt, true);
      assert.equal(
        approvalRegistry.listPending({ sessionId: sess.id })[0]?.tool,
        `m365__${tool}`,
      );
    }
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: external call_tool classifies its exact nested name/args_json action', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const destructiveSession = createSession({ kind: 'chat' });
    const destructivePerm = buildGatedToolPermission(
      destructiveSession.id,
      ['memory_read', 'call_tool'],
      { approvalMode: 'park' },
    ) as unknown as Perm;
    const destructive = await destructivePerm(
      'mcp__m365__call_tool',
      { name: 'deleteItem', args_json: JSON.stringify({ item_id: 'nested-1' }) },
      opts(),
    );
    assert.equal(destructive.behavior, 'deny');
    assert.equal(approvalRegistry.listPending({ sessionId: destructiveSession.id })[0]?.tool, 'm365__call_tool');

    const missingTargetSession = createSession({ kind: 'chat' });
    const missingTargetPerm = buildGatedToolPermission(
      missingTargetSession.id,
      ['memory_read', 'call_tool'],
      { approvalMode: 'park' },
    ) as unknown as Perm;
    const missingTarget = await missingTargetPerm(
      'mcp__m365__call_tool',
      { args_json: '{}' },
      opts(),
    );
    assert.equal(missingTarget.behavior, 'deny', 'an external broker without a concrete target fails closed');

    const controlSession = createSession({ kind: 'chat' });
    const controlPerm = buildGatedToolPermission(controlSession.id, ['memory_read', 'call_tool']) as unknown as Perm;
    const control = await controlPerm(
      'mcp__m365__call_tool',
      { name: 'removeLabel', args_json: JSON.stringify({ item_id: 'nested-1' }) },
      opts(),
    );
    assert.equal(control.behavior, 'allow', 'nested REMOVE remains outside the destructive set');
    assert.equal(approvalRegistry.listPending({ sessionId: controlSession.id }).length, 0);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: every external broker spelling gates nested deletes and sends with outer authority intact', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    for (const [index, variant] of ['call_tool', 'call-tool', 'call.tool', 'callTool'].entries()) {
      for (const [kind, name, nestedArgs] of [
        ['delete', 'deleteItem', { item_id: `item-${index}` }],
        ['send', 'sendEmail', { to: `person-${index}@example.com`, subject: 'Hello' }],
      ] as const) {
        const sess = createSession({ kind: 'chat' });
        const perm = buildGatedToolPermission(
          sess.id,
          ['memory_read', variant],
          { approvalMode: 'park' },
        ) as unknown as Perm;
        const result = await perm(
          `mcp__m365__${variant}`,
          { name, args_json: JSON.stringify(nestedArgs) },
          opts(),
        );
        assert.equal(result.behavior, 'deny', `${variant}: nested ${kind} must park`);
        assert.equal(result.interrupt, true);
        const [card] = approvalRegistry.listPending({ sessionId: sess.id });
        assert.equal(card?.tool, `m365__${variant}`, 'outer provider/broker is durable authority');
      }
    }
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: strict destructive scope binds the exact payload-backed target', async () => {
  saveProactivityPolicy({ autoApproveScope: 'strict' });
  const sess = createSession({ kind: 'chat' });
  const tool = 'm365__callTool';
  const approvedArgs = { name: 'deleteItem', payload: { item_id: 'one' } };
  const changedArgs = { name: 'deleteItem', payload: { item_id: 'two' } };
  const approvedKey = destructivePlanActionKey(tool, approvedArgs);
  assert.ok(approvedKey);
  openPlanScope({
    sessionId: sess.id,
    planProposalId: 'payload-delete-one',
    approvedPlanObjective: 'delete item one only',
    allowedTools: [tool],
    allowedDestructiveActions: [approvedKey!],
  });
  try {
    const perm = buildGatedToolPermission(
      sess.id,
      ['memory_read', 'callTool'],
      { approvalMode: 'park' },
    ) as unknown as Perm;
    const approved = await perm('mcp__m365__callTool', approvedArgs, opts());
    assert.equal(approved.behavior, 'allow', 'the exact scoped payload may proceed');
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0);

    const changed = await perm('mcp__m365__callTool', changedArgs, opts());
    assert.equal(changed.behavior, 'deny', 'a changed target still requires a card');
    assert.equal(changed.interrupt, true);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1);
  } finally {
    closePlanScope(sess.id, 'test complete');
  }
});

test('gated permission: safe nested reads stay conversational and do not create cards', async () => {
  saveProactivityPolicy({ autoApproveScope: 'strict' });
  for (const variant of ['call_tool', 'call-tool', 'call.tool', 'callTool']) {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['memory_read', variant], { approvalMode: 'park' }) as unknown as Perm;
    const result = await perm(
      `mcp__m365__${variant}`,
      { name: 'listItems', args_json: JSON.stringify({ site_id: 'site-a' }) },
      opts(),
    );
    assert.equal(result.behavior, 'allow', variant);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, variant);
  }
});

test('gated permission: foreign shell/Composio gateways and local namespace spoofs fail closed under yolo', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['mcp__foreign__run_shell_command', { command: 'pwd' }],
      ['mcp__foreign__composio_execute_tool', { tool_slug: 'GOOGLESHEETS_GET_VALUES', arguments: {} }],
      ['mcp__Clementine-local__memory_read', { query: 'spoofed local read' }],
      ['mcp__clementine-local__memory_read__extra', { query: 'malformed local tail' }],
    ];
    for (const [tool, args] of cases) {
      const sess = createSession({ kind: 'chat' });
      const perm = buildGatedToolPermission(sess.id, ['memory_read', 'run_shell_command'], { approvalMode: 'park' }) as unknown as Perm;
      const result = await perm(tool, args, opts());
      assert.equal(result.behavior, 'deny', tool);
      assert.equal(result.interrupt, true, tool);
      assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1, tool);
    }
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: broker card names the nested action and bounded target without secrets', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['callTool'], { approvalMode: 'park' }) as unknown as Perm;
    const secret = 'super-secret-access-token-value';
    const result = await perm('mcp__m365__callTool', {
      name: 'deleteItem',
      args_json: JSON.stringify({ item_id: 'item-visible-42', access_token: secret, body: 'private body' }),
    }, opts());
    assert.equal(result.behavior, 'deny');
    const [card] = approvalRegistry.listPending({ sessionId: sess.id });
    assert.ok(card);
    assert.match(card.subject, /m365__deleteItem/);
    assert.match(card.subject, /item-visible-42/);
    assert.doesNotMatch(card.subject, new RegExp(secret));
    assert.doesNotMatch(card.subject, /private body/);
    assert.ok(card.subject.length <= 220);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: native update and remove-label controls remain frictionless under yolo', async () => {
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
    const update = await perm(
      'mcp__m365__sharepoint_update_item',
      { item_id: 'sharepoint-item-1', title: 'Updated title' },
      opts(),
    );
    const removeLabel = await perm(
      'mcp__gmail__remove_label',
      { message_id: 'mail-1', label_id: 'label-1' },
      opts(),
    );
    const camelUpdate = await perm(
      'mcp__m365__updateItem',
      { item_id: 'sharepoint-item-1', title: 'Updated title again' },
      opts(),
    );
    const hyphenRemove = await perm(
      'mcp__gmail__remove-label',
      { message_id: 'mail-1', label_id: 'label-1' },
      opts(),
    );

    assert.equal(update.behavior, 'allow', 'ordinary reversible updates retain yolo behavior');
    assert.equal(removeLabel.behavior, 'allow', 'REMOVE remains outside the deliberately narrow destructive set');
    assert.equal(camelUpdate.behavior, 'allow');
    assert.equal(hyphenRemove.behavior, 'allow');
    assert.equal(
      approvalRegistry.listPending({ sessionId: sess.id }).length,
      0,
      'negative controls create no approval noise',
    );
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'strict' });
  }
});

test('gated permission: a DESTRUCTIVE shell command registers + AWAITS + ALLOWS on approve', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, opts());
  const approvalId = await waitForPending(sess.id);
  // The permission promise is still pending (awaiting the human) until we resolve.
  approvalRegistry.resolve(approvalId, 'approved', 'test');
  const res = await p;
  assert.equal(res.behavior, 'allow', 'approve → allow');
  assert.deepEqual(res.updatedInput, { command: 'git push origin main' }, 'human-approved allow must echo updatedInput too');
});

test('WAIT approval is consumed before the live destructive call can execute', async () => {
  process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '0';
  try {
    const sess = createSession({ kind: 'chat' });
    const args = { item_id: 'wait-delete-1' };
    const perm = buildGatedToolPermission(sess.id, ['memory_read', 'delete_item']) as unknown as Perm;
    const firstPromise = perm('mcp__m365__delete_item', args, opts());
    const approvalId = await waitForPending(sess.id);
    approvalRegistry.resolve(approvalId, 'approved', 'unit-test-human');

    const first = await firstPromise;
    assert.equal(first.behavior, 'allow');
    assert.ok(
      approvalRegistry.get(approvalId)?.consumedAt,
      'the grant is atomically spent before the approved call proceeds',
    );

    process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '60';
    const duplicate = await perm('mcp__m365__delete_item', args, opts());
    assert.equal(duplicate.behavior, 'deny', 'one human decision cannot execute a second delete');
    assert.match(duplicate.message ?? '', /PARKED/);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1, 'a second action needs a new card');
  } finally {
    delete process.env.CLEMMY_APPROVAL_WAIT_PARK_MS;
  }
});

test('gated permission: DENIES on reject', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, opts());
  const approvalId = await waitForPending(sess.id);
  approvalRegistry.resolve(approvalId, 'rejected', 'test');
  const res = await p;
  assert.equal(res.behavior, 'deny', 'reject → deny');
});

test('gated permission: "Bash is bash" — a read-shaped shell command auto-allows with NO approval', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const res = await perm('mcp__clementine-local__run_shell_command', { command: 'ls -la && sf data query --query "SELECT Id FROM Opportunity"' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'reads never park for approval');
});

test('gated permission: sf data create record is a CRM write → requires approval even though run_shell_command is in the profile allowlist', async () => {
  const sess = createSession({ kind: 'chat' });
  // run_shell_command deliberately in the fastAllow list — the execution trio
  // must run the smart per-command gate FIRST (the 2026-07-02 silent-CRM-write
  // class: profile advertise list reused as blanket fast-allow).
  const perm = buildGatedToolPermission(sess.id, ['memory_read', 'run_shell_command']) as unknown as Perm;
  const p = perm(
    'mcp__clementine-local__run_shell_command',
    { command: "sf data create record --sobject Task --values \"Subject='x'\" --target-org me@org.example" },
    opts(),
  );
  const approvalId = await waitForPending(sess.id);
  approvalRegistry.resolve(approvalId, 'rejected', 'test');
  const res = await p;
  assert.equal(res.behavior, 'deny', 'unapproved CRM write must not run');
});

test('workflow park mode interrupts promptly, reuses one exact approval after restart, and consumes it once', async () => {
  const sess = createSession({ kind: 'workflow' });
  const command = { command: 'git push origin main' };
  const boundaries: Array<{ approvalId: string; state: string }> = [];
  const build = (): Perm => buildGatedToolPermission(sess.id, ['memory_read'], {
    approvalMode: 'park',
    onApprovalBoundary: (boundary) => boundaries.push({ approvalId: boundary.approvalId, state: boundary.state }),
  }) as unknown as Perm;

  const first = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(first.behavior, 'deny');
  assert.equal(first.interrupt, true, 'the SDK query is interrupted instead of awaiting the human');
  const pending = approvalRegistry.listPending({ sessionId: sess.id });
  assert.equal(pending.length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 1, 'one concrete card/event');

  // Re-entering before resolution must find the same durable row, not mint a
  // duplicate card (covers drain retry / daemon restart while still pending).
  const stillPending = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(stillPending.interrupt, true);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 1);

  approvalRegistry.resolve(pending[0].approvalId, 'approved', 'unit-test-human');
  const resumed = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(resumed.behavior, 'allow');
  assert.deepEqual(resumed.updatedInput, command, 'the approved payload is reused byte-for-byte');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'resume minted no second card');
  assert.ok(approvalRegistry.get(pending[0].approvalId)?.consumedAt);

  // The one-shot grant is spent AND the action already executed under it. A
  // later identical call must NOT re-surface a card — that would ask the human to
  // re-approve an already-sent action (a duplicate irreversible send), or livelock
  // if they decline. It is terminal-done: deny without parking and mint no
  // replacement card, so a from-scratch replay skips the done send and proceeds to
  // its next still-ungranted action.
  const replay = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(replay.behavior, 'deny');
  assert.equal(replay.interrupt, false, 'a consumed grant is done, not parked — the run continues past it');
  assert.match(String((replay as { message?: string }).message ?? ''), /already .*(approved|executed)/i, 'message marks it already-done, not a fresh request');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'no duplicate card minted for the already-executed send');
  assert.equal(boundaries.filter((boundary) => boundary.state === 'pending').length, 2, 'the consumed replay fires no new pending boundary');
});

test('workflow park mode treats rejected and expired exact decisions as terminal, without a replacement card', async () => {
  for (const resolution of ['rejected', 'expired'] as const) {
    const sess = createSession({ kind: 'workflow' });
    const command = { command: `git push origin ${resolution}` };
    let lastState = '';
    const build = (): Perm => buildGatedToolPermission(sess.id, ['memory_read'], {
      approvalMode: 'park',
      onApprovalBoundary: (boundary) => { lastState = boundary.state; },
    }) as unknown as Perm;

    await build()('mcp__clementine-local__run_shell_command', command, opts());
    const row = approvalRegistry.listPending({ sessionId: sess.id })[0];
    assert.ok(row);
    approvalRegistry.resolve(row.approvalId, resolution, 'unit-test-human');

    const denied = await build()('mcp__clementine-local__run_shell_command', command, opts());
    assert.equal(denied.behavior, 'deny');
    assert.equal(denied.interrupt, true);
    assert.match(denied.message ?? '', new RegExp(resolution));
    assert.equal(lastState, resolution);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'no replacement approval after terminal decision');
  }
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fail-closed approval park (2026-07-20): the WAIT gate stops pinning a live
// turn on an unanswered card — it parks honestly and resumes on approval.
// ---------------------------------------------------------------------------

test('WAIT gate parks after the hold ceiling: honest deny, card stays pending + durable marker', async () => {
  process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '60';
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
    const started = Date.now();
    const res = await perm('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, opts());
    assert.equal(res.behavior, 'deny');
    assert.match(res.message ?? '', /PARKED/, 'the model is told to wrap up and report, not retry');
    assert.equal(res.interrupt, undefined ?? res.interrupt, 'no interrupt — the model finishes the turn honestly');
    assert.ok(Date.now() - started < 5_000, 'parks at the ceiling, not the 24h TTL');
    const pending = approvalRegistry.listPending({ sessionId: sess.id });
    assert.equal(pending.length, 1, 'the card SURVIVES the park — still actionable');
    const parkedEvents = listEvents(sess.id, { types: ['approval_parked'] });
    assert.equal(parkedEvents.length, 1, 'durable approval_parked marker for the resume listener');
    assert.equal((parkedEvents[0].data as { approvalId?: string }).approvalId, pending[0].approvalId);
  } finally {
    delete process.env.CLEMMY_APPROVAL_WAIT_PARK_MS;
  }
});

test('approve-after-park: the SAME payload re-runs on the existing grant without re-asking', async () => {
  process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '60';
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
    const args = { command: 'git push origin main' };
    const parked = await perm('mcp__clementine-local__run_shell_command', args, opts());
    assert.match(parked.message ?? '', /PARKED/);
    const [card] = approvalRegistry.listPending({ sessionId: sess.id });
    approvalRegistry.resolve(card.approvalId, 'approved', 'test-late-approve');
    // The resume turn re-issues the identical call: one-shot claim → allow, no new card.
    const resumed = await perm('mcp__clementine-local__run_shell_command', args, opts());
    assert.equal(resumed.behavior, 'allow', 'the human already approved this exact payload');
    assert.deepEqual(resumed.updatedInput, args);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'no second card minted');
    // The grant is ONE-shot: a third identical call must re-ask, not silently re-send.
    process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '60';
    const third = await perm('mcp__clementine-local__run_shell_command', args, opts());
    assert.equal(third.behavior, 'deny', 'consumed grant never auto-fires a duplicate');
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1, 'a fresh card re-asks the human');
  } finally {
    delete process.env.CLEMMY_APPROVAL_WAIT_PARK_MS;
  }
});

test('re-park on the SAME still-pending card: no duplicate cards across turns', async () => {
  process.env.CLEMMY_APPROVAL_WAIT_PARK_MS = '60';
  try {
    const sess = createSession({ kind: 'chat' });
    const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
    const args = { command: 'git push origin main' };
    await perm('mcp__clementine-local__run_shell_command', args, opts());
    await perm('mcp__clementine-local__run_shell_command', args, opts()); // next turn retries
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1, 'one card, reused');
  } finally {
    delete process.env.CLEMMY_APPROVAL_WAIT_PARK_MS;
  }
});
