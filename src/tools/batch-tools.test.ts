/**
 * Run: npx tsx --test src/tools/batch-tools.test.ts
 *
 * J1 — the run_batch CONSUMPTION site: when the certifier cannot obtain a verdict
 * (judge chain exhausted), an irreversible SEND batch must PARK as a human
 * approval card, never terminal-block. Asserts a pending approval row exists, the
 * batch was NOT executed, and the response carries no terminal "refused/blocked".
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation FIRST (test-hygiene rule): this suite writes pending-action records.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-batch-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { registerBatchTools, _setBatchPlanRunnerForTests } = await import('./batch-tools.js');
const { _setCertifyJudgeForTests } = await import('../execution/batch-runner.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const { appendEvent, createSession, getSession, listEvents } = await import('../runtime/harness/eventlog.js');
const {
  getPendingAction,
  listPendingActions,
  queuePendingAction,
} = await import('../runtime/harness/pending-actions.js');
const {
  grantComposioCliDefaultAccountAuthority,
  revokeComposioCliDefaultAccountAuthority,
} = await import('../integrations/composio/cli-default-account-authority.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type Handler = (input: Record<string, unknown>) => Promise<ToolResult>;

function batchHandler(): Handler {
  const handlers = new Map<string, Handler>();
  registerBatchTools({
    tool(name: string, ...args: unknown[]) {
      handlers.set(name, args.at(-1) as Handler);
    },
  } as never);
  const h = handlers.get('run_batch');
  if (!h) throw new Error('run_batch not registered');
  return h;
}

function approveExactPendingAction(
  record: ReturnType<typeof queuePendingAction>,
  subject: string,
): string {
  if (!getSession(record.sessionId!)) createSession({ id: record.sessionId!, kind: 'chat' });
  const row = approvalRegistry.register({
    sessionId: record.sessionId!,
    subject,
    tool: 'request_approval',
    args: {
      pendingActionId: record.id,
      pendingAction: pendingActionApprovalView(record),
    },
  });
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  assert.equal(resolved.ok, true);
  return row.approvalId;
}

after(() => {
  _setCertifyJudgeForTests(null);
  _setBatchPlanRunnerForTests(null);
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('run_batch propose: exhausted judge chain + SEND batch → parks as one approval card, not executed, no terminal block', async () => {
  // Every judge attempt throws a transient provider shape → the chain exhausts
  // with no verdict (the live incident: a certifier that only knew one Codex lane
  // hit `Codex 429 usage_limit_reached` and terminal-blocked the payloads).
  _setCertifyJudgeForTests(async () => { throw Object.assign(new Error('Codex 429 usage_limit_reached'), { statusCode: 429 }); });

  const handler = batchHandler();
  const sessionId = 'sess-batch-park';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the three prepared notices.' },
  });
  const invoke = () => withToolOutputContext(
    { sessionId, runScopeId: 'batch-proof-run', callId: 'batch-proof-call' },
    () => withHarnessRunContext(
      {
        sessionId,
        behaviorScopeId: 'batch-proof-run',
        sourceUserSeq: source.seq,
        counter: new ToolCallsCounter(100),
      },
      () => handler({
        action: 'propose',
        plan: {
          tool: 'testmcp__send_message',
          sideEffect: 'send',
          objective: 'send three prepared notices to the saved recipients',
          items: [
            { id: 'a@example.com', args: JSON.stringify({ to: 'a@example.com', text: 'hi a' }) },
            { id: 'b@example.com', args: JSON.stringify({ to: 'b@example.com', text: 'hi b' }) },
            { id: 'c@example.com', args: JSON.stringify({ to: 'c@example.com', text: 'hi c' }) },
          ],
        },
      }),
    ),
  ) as Promise<ToolResult>;
  const res = await invoke();

  const text = res.content[0].text;
  // NOT a terminal block — the payloads are not stranded.
  assert.doesNotMatch(text, /REFUSED|fail-closed|\bblocked\b/i, 'a judge-unavailable send must not terminal-block');
  // Parked for human review (the human is the fallback judge).
  assert.match(text, /couldn't independently verify|review/i);
  assert.match(text, /pending action pa-/, 'names the pending approval card to approve');
  assert.doesNotMatch(text, /Executed/i, 'the batch was NOT executed at propose time');

  // A single OPEN approval row exists, kind external_send, still queued (not executed).
  const pending = listPendingActions({ sessionId, status: 'all' });
  assert.equal(pending.length, 1, 'exactly one pending approval card was minted');
  assert.equal(pending[0].kind, 'external_send');
  assert.equal(pending[0].status, 'queued', 'queued for approval — never auto-executed');
  assert.equal(pending[0].toolName, 'run_batch');
  assert.equal((pending[0].payload as { items: unknown[] }).items.length, 3, 'the exact prepared payloads are pinned in the card');
  const [edge] = listEvents(sessionId, { types: ['autonomy_note'] }).filter(
    (event) => event.data.kind === 'pending_action_queued',
  );
  assert.ok(edge, 'the direct batch queue emits the graph edge the approval transition consumes');
  assert.equal(edge.data.sourceUserSeq, source.seq);
  assert.equal(edge.data.approvalRequired, true, 'reversible and irreversible batch writes use the same one-card edge');
  assert.equal(edge.data.autoMaterialize, true, 'run_batch proposals do not depend on a model restating an approval question');

  const retry = await invoke();
  assert.match(retry.content[0].text, /Reused the request-owned pending action/);
  assert.equal(listPendingActions({ sessionId, status: 'all' }).length, 1, 'same-request retry cannot mint a second batch');
  assert.equal(
    listEvents(sessionId, { types: ['autonomy_note'] }).filter(
      (event) => event.data.kind === 'pending_action_queued',
    ).length,
    1,
    'same-request retry cannot mint a second graph edge',
  );
});

test('run_batch propose: a reversible Sheets write still emits an automatic formal approval edge', async () => {
  _setCertifyJudgeForTests(async () => ({
    allow: true,
    reason: 'payloads are exact',
    concerns: [],
    judgeUnavailable: false,
  }));
  const sessionId = 'sess-batch-reversible-write';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Update these three reviewed Sheet rows.' },
  });
  const handler = batchHandler();
  const res = await withToolOutputContext(
    { sessionId, runScopeId: 'batch-sheets-run' },
    () => withHarnessRunContext(
      {
        sessionId,
        behaviorScopeId: 'batch-sheets-run',
        sourceUserSeq: source.seq,
        counter: new ToolCallsCounter(100),
      },
      () => handler({
        action: 'propose',
        plan: {
          tool: 'composio_execute_tool',
          composioSlug: 'GOOGLESHEETS_BATCH_UPDATE',
          sideEffect: 'write',
          objective: 'update three reviewed rows in the pinned spreadsheet',
          items: [
            { id: 'row-1', args: JSON.stringify({ spreadsheet_id: 'sheet-proof', range: 'A1:B1', values: [['a', 1]] }) },
            { id: 'row-2', args: JSON.stringify({ spreadsheet_id: 'sheet-proof', range: 'A2:B2', values: [['b', 2]] }) },
            { id: 'row-3', args: JSON.stringify({ spreadsheet_id: 'sheet-proof', range: 'A3:B3', values: [['c', 3]] }) },
          ],
        },
      }),
    ),
  ) as ToolResult;

  // CONTRACT CHANGE (2026-08-07, the babysitting fix): in autonomous mode a
  // certified reversible write batch auto-approves — the formal approval EDGE
  // is still durably recorded (audit + retry identity), but no card parks and
  // the record is approved by policy.
  assert.match(res.content[0].text, /Covered by your autonomy policy/);
  const [record] = listPendingActions({ sessionId, status: 'all' });
  assert.equal(record.kind, 'external_write');
  assert.equal(record.status, 'approved');
  assert.equal(record.approvedBy, 'policy');
  const [edge] = listEvents(sessionId, { types: ['autonomy_note'] }).filter(
    (event) => event.data.kind === 'pending_action_queued',
  );
  assert.ok(edge);
  assert.equal(edge.data.approvalRequired, true);
  assert.equal(edge.data.autoMaterialize, true);
});

test('run_batch Composio admission refuses an unbound SDK social publish and a CLI account selector before minting a card', async () => {
  _setCertifyJudgeForTests(async () => ({
    allow: true,
    reason: 'payloads are exact',
    concerns: [],
    judged: true,
  }));
  const handler = batchHandler();
  const propose = async (
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    createSession({ id: sessionId, kind: 'chat' });
    const source = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Publish this reviewed social post.' },
    });
    return withToolOutputContext(
      { sessionId },
      () => withHarnessRunContext(
        {
          sessionId,
          sourceUserSeq: source.seq,
          counter: new ToolCallsCounter(100),
        },
        () => handler({
          action: 'propose',
          plan: {
            tool: 'composio_execute_tool',
            composioSlug: 'INSTAGRAM_CREATE_POST',
            sideEffect: 'send',
            objective: 'publish the reviewed launch post to Instagram',
            items: [{ id: 'launch-post', args: JSON.stringify(args) }],
          },
        }),
      ),
    ) as Promise<ToolResult>;
  };

  const sdkUnbound = await propose('sess-batch-sdk-unbound-social', {
    caption: 'Launch day',
    image_url: 'https://assets.example/launch.png',
  });
  assert.match(sdkUnbound.content[0].text, /connected_account_id|immutable account destination|exact destination/i);
  assert.equal(listPendingActions({ sessionId: 'sess-batch-sdk-unbound-social', status: 'all' }).length, 0);

  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  try {
    const cliTargeted = await propose('sess-batch-cli-targeted-social', {
      tool_slug: 'INSTAGRAM_CREATE_POST',
      arguments: JSON.stringify({
        caption: 'Launch day',
        image_url: 'https://assets.example/launch.png',
      }),
      connected_account_id: 'ca_instagram_brand',
    });
    assert.match(cliTargeted.content[0].text, /CLI cannot honor account-targeted selectors|connected_account_id/i);
    assert.equal(listPendingActions({ sessionId: 'sess-batch-cli-targeted-social', status: 'all' }).length, 0);
  } finally {
    process.env.COMPOSIO_BACKEND = previousBackend ?? 'sdk';
  }
});

test('run_batch snapshots one named CLI-default authority; rotation and revocation invalidate approved batches before dispatch', async () => {
  const previousBackend = process.env.COMPOSIO_BACKEND;
  process.env.COMPOSIO_BACKEND = 'cli';
  _setCertifyJudgeForTests(async () => ({
    allow: true,
    reason: 'payloads are exact',
    concerns: [],
    judged: true,
  }));
  const handler = batchHandler();
  const firstAuthority = await grantComposioCliDefaultAccountAuthority({
    toolkit: 'instagram',
    label: 'Brand Instagram A',
    grantedBy: 'test',
  });

  const propose = async (sessionId: string, caption: string) => {
    createSession({ id: sessionId, kind: 'chat' });
    const source = appendEvent({
      sessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: `Publish the reviewed post: ${caption}` },
    });
    const result = await withToolOutputContext(
      { sessionId },
      () => withHarnessRunContext(
        {
          sessionId,
          sourceUserSeq: source.seq,
          counter: new ToolCallsCounter(100),
        },
        () => handler({
          action: 'propose',
          plan: {
            tool: 'composio_execute_tool',
            composioSlug: 'INSTAGRAM_CREATE_POST',
            sideEffect: 'send',
            objective: 'publish the reviewed launch post to Instagram',
            items: [{
              id: caption,
              args: JSON.stringify({
                caption,
                image_url: `https://assets.example/${caption}.png`,
              }),
            }],
          },
        }),
      ),
    ) as ToolResult;
    const [record] = listPendingActions({ sessionId, status: 'all' });
    assert.ok(record, result.content[0].text);
    return record;
  };

  let runCount = 0;
  _setBatchPlanRunnerForTests(async (plan, sessionId) => {
    runCount += 1;
    return {
      batchId: `batch-cli-default-${runCount}`,
      sessionId,
      tool: plan.tool,
      composioSlug: plan.composioSlug,
      sideEffect: plan.sideEffect,
      objective: plan.objective,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: plan.items.length,
      succeeded: plan.items.length,
      failed: 0,
      halted: false,
      outcomes: plan.items.map((item) => ({ id: item.id, ok: true, attempts: 1, ms: 1 })),
    };
  });

  try {
    const executable = await propose('sess-batch-cli-authorized', 'launch-a');
    assert.deepEqual(executable.executionAuthority, firstAuthority);
    assert.match(executable.targetSummary, /Brand Instagram A/);
    approveExactPendingAction(executable, 'approve named CLI-default batch');
    const executed = await withToolOutputContext(
      { sessionId: executable.sessionId! },
      () => handler({ action: 'execute', pending_action_id: executable.id }),
    ) as ToolResult;
    assert.match(executed.content[0].text, /batch-cli-default-1/);
    assert.equal(runCount, 1);

    const staleByRotation = await propose('sess-batch-cli-rotated', 'launch-b');
    approveExactPendingAction(staleByRotation, 'approve batch before account-authority change');
    const changedAuthority = await grantComposioCliDefaultAccountAuthority({
      toolkit: 'instagram',
      label: 'Brand Instagram B',
      grantedBy: 'test',
    });
    const rotated = await withToolOutputContext(
      { sessionId: staleByRotation.sessionId! },
      () => handler({ action: 'execute', pending_action_id: staleByRotation.id }),
    ) as ToolResult;
    assert.match(rotated.content[0].text, /operator changed|execution-authority|approval-authority/i);
    assert.equal(runCount, 1, 'authority rotation blocks before the batch runner');
    assert.equal(getPendingAction(staleByRotation.id)?.status, 'failed');

    const staleByRevocation = await propose('sess-batch-cli-revoked', 'launch-c');
    assert.deepEqual(staleByRevocation.executionAuthority, changedAuthority);
    approveExactPendingAction(staleByRevocation, 'approve batch before authority revocation');
    await revokeComposioCliDefaultAccountAuthority('instagram');
    const revoked = await withToolOutputContext(
      { sessionId: staleByRevocation.sessionId! },
      () => handler({ action: 'execute', pending_action_id: staleByRevocation.id }),
    ) as ToolResult;
    assert.match(revoked.content[0].text, /revoked|execution-authority|approval-authority/i);
    assert.equal(runCount, 1, 'authority revocation blocks before the batch runner');
    assert.equal(getPendingAction(staleByRevocation.id)?.status, 'failed');
  } finally {
    await revokeComposioCliDefaultAccountAuthority('instagram');
    _setBatchPlanRunnerForTests(null);
    process.env.COMPOSIO_BACKEND = previousBackend ?? 'sdk';
  }
});

test('run_batch execute atomically consumes approval: concurrent calls start one batch and retries stay inert', async () => {
  createSession({ id: 'sess-batch-concurrent', kind: 'chat' });
  const pending = queuePendingAction({
    title: 'Concurrent approved batch',
    summary: 'prove one approved plan is consumed exactly once',
    kind: 'external_write',
    toolName: 'run_batch',
    payload: {
      tool: 'proof__write_record',
      sideEffect: 'write',
      objective: 'write one deterministic proof record',
      items: [{ id: 'proof-1', args: { value: 'once' } }],
    },
    sessionId: 'sess-batch-concurrent',
    createdBy: 'test',
  });
  approveExactPendingAction(pending, 'approve concurrent batch');

  let runCount = 0;
  _setBatchPlanRunnerForTests(async (plan, sessionId) => {
    runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      batchId: 'batch-proof-once',
      sessionId,
      tool: plan.tool,
      sideEffect: plan.sideEffect,
      objective: plan.objective,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      succeeded: 1,
      failed: 0,
      halted: false,
      outcomes: [{ id: 'proof-1', ok: true, attempts: 1, ms: 1 }],
    };
  });

  const handler = batchHandler();
  const invoke = () => withToolOutputContext(
    { sessionId: 'sess-batch-concurrent' },
    () => handler({ action: 'execute', pending_action_id: pending.id }),
  ) as Promise<ToolResult>;
  const results = await Promise.all(Array.from({ length: 5 }, invoke));
  const texts = results.map((result) => result.content[0].text);

  assert.equal(runCount, 1, 'exactly one batch runner crossed the dispatch boundary');
  assert.equal(texts.filter((text) => /batch-proof-once/.test(text)).length, 1, 'one caller receives the ledger');
  const losers = texts.filter((text) => !/batch-proof-once/.test(text));
  assert.equal(losers.length, 4);
  for (const text of losers) {
    assert.match(text, /execution claim|in progress|uncertain/i);
    assert.match(text, /no second batch|not be retried automatically/i);
  }
  assert.equal(getPendingAction(pending.id)?.status, 'executed');

  const retry = await invoke();
  assert.equal(runCount, 1, 'executed retry never starts the runner again');
  assert.match(retry.content[0].text, /already executed|no second batch/i);
  _setBatchPlanRunnerForTests(null);
});

test('run_batch refuses a stored plan changed after approval before starting the runner', async () => {
  const sessionId = 'sess-batch-tamper';
  createSession({ id: sessionId, kind: 'chat' });
  const pending = queuePendingAction({
    title: 'Approved exact batch',
    summary: 'Only the reviewed record may be written.',
    kind: 'external_write',
    toolName: 'run_batch',
    payload: {
      tool: 'proof__write_record',
      sideEffect: 'write',
      objective: 'write one reviewed record',
      items: [{ id: 'reviewed', args: { value: 'approved' } }],
    },
    sessionId,
    createdBy: 'test',
  });
  approveExactPendingAction(pending, 'approve tamper-proof batch');
  const file = path.join(TMP_HOME, 'pending-actions', `${pending.id}.json`);
  const tampered = JSON.parse(readFileSync(file, 'utf8')) as { payload: Record<string, unknown> };
  tampered.payload = {
    ...(tampered.payload as Record<string, unknown>),
    items: [{ id: 'swapped', args: { value: 'changed-after-approval' } }],
  };
  writeFileSync(file, JSON.stringify(tampered), 'utf8');

  let runCount = 0;
  _setBatchPlanRunnerForTests(async () => {
    runCount += 1;
    throw new Error('must never run');
  });
  const result = await withToolOutputContext(
    { sessionId },
    () => batchHandler()({ action: 'execute', pending_action_id: pending.id }),
  ) as ToolResult;

  assert.equal(runCount, 0, 'tampered approved batch never reaches the runner');
  assert.match(result.content[0].text, /integrity|payload hash|changed after approval|failed or uncertain|already failed/i);
  assert.equal(getPendingAction(pending.id)?.status, 'failed');
  _setBatchPlanRunnerForTests(null);
});

test('run_batch execute refuses a foreign session without claiming or dispatching the approved batch', async () => {
  const ownerSessionId = 'sess-batch-owner';
  const foreignSessionId = 'sess-batch-foreign';
  createSession({ id: ownerSessionId, kind: 'chat' });
  createSession({ id: foreignSessionId, kind: 'chat' });
  const pending = queuePendingAction({
    title: 'Owner-bound approved batch',
    summary: 'prove another chat cannot consume this approved plan',
    kind: 'external_write',
    toolName: 'run_batch',
    payload: {
      tool: 'proof__write_record',
      sideEffect: 'write',
      objective: 'write one owner-bound proof record',
      items: [{ id: 'owner-proof-1', args: { value: 'once' } }],
    },
    sessionId: ownerSessionId,
    createdBy: 'test',
  });
  approveExactPendingAction(pending, 'approve owner-bound batch');

  let runCount = 0;
  const dispatchedSessionIds: string[] = [];
  _setBatchPlanRunnerForTests(async (plan, sessionId) => {
    runCount += 1;
    dispatchedSessionIds.push(sessionId);
    return {
      batchId: 'batch-proof-owner',
      sessionId,
      tool: plan.tool,
      sideEffect: plan.sideEffect,
      objective: plan.objective,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      succeeded: 1,
      failed: 0,
      halted: false,
      outcomes: [{ id: 'owner-proof-1', ok: true, attempts: 1, ms: 1 }],
    };
  });

  const handler = batchHandler();
  const foreign = await withToolOutputContext(
    { sessionId: foreignSessionId },
    () => handler({ action: 'execute', pending_action_id: pending.id }),
  ) as ToolResult;

  assert.match(foreign.content[0].text, /different session|was not executed/i);
  assert.equal(runCount, 0, 'a foreign session must not cross the batch dispatch boundary');
  assert.equal(getPendingAction(pending.id)?.status, 'approved', 'foreign execution must not consume the owner approval');

  const owner = await withToolOutputContext(
    { sessionId: ownerSessionId },
    () => handler({ action: 'execute', pending_action_id: pending.id }),
  ) as ToolResult;

  assert.match(owner.content[0].text, /batch-proof-owner/);
  assert.equal(runCount, 1, 'the owning session can still consume the approved batch once');
  assert.deepEqual(dispatchedSessionIds, [ownerSessionId], 'the ledger and dispatch retain the owner session');
  assert.equal(getPendingAction(pending.id)?.status, 'executed');
  _setBatchPlanRunnerForTests(null);
});

// ── Consent-scope wave (2026-08-07): the beat's approval carries into the batch lane ──
test('run_batch propose: in autonomous mode a certified write plan auto-approves — zero extra cards', async () => {
  _setCertifyJudgeForTests(async () => ({
    allow: true,
    reason: 'payloads are exact',
    concerns: [],
    judgeUnavailable: false,
  }));
  const sessionId = 'sess-batch-scope-covered';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'go' },
  });
  const handler = batchHandler();
  const propose = (plan: Record<string, unknown>) => withToolOutputContext(
    { sessionId, runScopeId: 'batch-scope-run' },
    () => withHarnessRunContext(
      { sessionId, behaviorScopeId: 'batch-scope-run', sourceUserSeq: source.seq, counter: new ToolCallsCounter(100) },
      () => handler({ action: 'propose', plan }),
    ),
  ) as Promise<ToolResult>;

  const res = await propose({
    tool: 'composio_execute_tool',
    composioSlug: 'OUTLOOK_CREATE_DRAFT',
    sideEffect: 'write',
    objective: 'draft intro emails to the remaining contacts',
    items: [
      { id: 'c-1', args: JSON.stringify({ subject: 'Hi A', body: 'a', to_email: 'a@x.example' }) },
      { id: 'c-2', args: JSON.stringify({ subject: 'Hi B', body: 'b', to_email: 'b@x.example' }) },
      { id: 'c-3', args: JSON.stringify({ subject: 'Hi C', body: 'c', to_email: 'c@x.example' }) },
    ],
  });
  const text = res.content[0].text;
  assert.match(text, /Covered by your autonomy policy/, 'writes flow in autonomous mode');
  assert.match(text, /run_batch action=execute/, 'model is told to execute now');
  assert.doesNotMatch(text, /exactly one approval card/, 'no card language');
  const record = listPendingActions({ sessionId, status: 'all' })[0];
  assert.equal(record.status, 'approved', 'record approved before materialization → no card minted');
  assert.equal(record.approvedBy, 'policy');

  // The SAME scope does not cover a delete-slug plan — that still cards.
  const delRes = await propose({
    tool: 'composio_execute_tool',
    composioSlug: 'OUTLOOK_BATCH_DELETE_MESSAGES',
    sideEffect: 'write',
    objective: 'delete the old duplicates',
    items: [{ id: 'd-1', args: JSON.stringify({ message_ids: ['m1'] }) }],
  });
  assert.match(delRes.content[0].text, /exactly one approval card/, 'out-of-contract delete keeps its card');

  // And a SEND plan never rides the scope (kind=external_send is excluded).
  const sendRes = await propose({
    tool: 'composio_execute_tool',
    composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    sideEffect: 'send',
    objective: 'send the drafts',
    items: [{ id: 's-1', args: JSON.stringify({ subject: 'Hi', body: 'x', to_email: 'a@x.example' }) }],
  });
  assert.match(sendRes.content[0].text, /exactly one approval card/, 'sends always card');
});
