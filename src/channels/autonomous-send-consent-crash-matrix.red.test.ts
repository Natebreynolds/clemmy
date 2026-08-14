/**
 * Focused crash/race pins for Autonomous ordinary-question send consent.
 *
 * These tests intentionally drive production boundaries with a fake provider:
 * permission parking, durable channel ingress, registry CAS, PendingAction
 * execution, and MCP dispatch. No model or network is used.
 *
 * Run serially at low load:
 *   npx tsx --test --test-concurrency=1 src/channels/autonomous-send-consent-crash-matrix.red.test.ts
 */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-send-consent-crash-matrix-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_AUTONOMOUS_CONVERSATIONAL_CONSENT = 'on';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  beginRunAttempt,
  createSession,
  listEvents,
  openEventLog,
  recordRunAttemptUserInput,
} = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const {
  PENDING_ACTIONS_DIR,
  getPendingAction,
  getOrCreatePendingActionByPayloadAndSource,
  listPendingActions,
  claimPendingActionExecution,
  pendingActionSourceFreezeLockIdentityForTest,
  pendingActionTransitionLockIdentityForTest,
  recordPendingActionResult,
} = await import('../runtime/harness/pending-actions.js');
const {
  buildGatedToolPermission,
  reprojectUndeliveredConversationalApproval,
  surfaceDeferredConversationalApproval,
} = await import('../runtime/harness/claude-agent-approval.js');
type ClaudeAgentApprovalBoundary = import('../runtime/harness/claude-agent-approval.js').ClaudeAgentApprovalBoundary;
const { exactOriginDeliveryTargetDigest } = await import('../runtime/exact-origin-delivery.js');
const { saveProactivityPolicy } = await import('../agents/proactivity-policy.js');
const { createMcpNamespaceShim } = await import('../runtime/mcp-namespace-shim.js');
const { _setCodeModeMcpResolverForTests } = await import('../tools/code-mode-tool.js');
const {
  bindDiscordHarnessSession,
  tryHandleHarnessApprovalReply,
} = await import('./discord-harness.js');
const { buildSlackHarnessTransport } = await import('./slack-harness.js');
const {
  settleConversationalApprovalDecision,
  _deliverUndeliveredConversationalPromptForTest,
  _resetChatApprovalResumeForTest,
  startChatApprovalResume,
} = await import('../runtime/harness/chat-approval-resume.js');

const THREE_ENTRYPOINT_TEST_NAME = 'literal ingress, registry listener, and boot drain overlap one execution flight';
const THREE_ENTRYPOINT_CHILD = process.env.CLEMMY_THREE_ENTRYPOINT_PIN_CHILD === '1';
const PROVABLY_DEAD_PID = 2_147_483_647;

type Permission = (
  name: string,
  input: Record<string, unknown>,
  options: unknown,
) => Promise<{ behavior: string; interrupt?: boolean }>;

function permissionOptions(toolUseID: string): unknown {
  return { signal: new AbortController().signal, toolUseID };
}

function recordingTransport() {
  const messages: string[] = [];
  return {
    messages,
    transport: {
      async sendInitial(content: string) {
        messages.push(content);
        return { async edit() {} };
      },
      async sendError(content: string) { messages.push(content); },
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

async function installFakeOutlookProvider(
  proof: string,
  calls: Array<{ tool: string; args: unknown }>,
): Promise<void> {
  const provider: MCPServer = {
    name: 'outlook',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{
        name: 'OUTLOOK_SEND_EMAIL',
        description: 'Send one email.',
        inputSchema: { type: 'object' },
      }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(tool, args) {
      calls.push({ tool, args });
      return [{
        type: 'text',
        text: JSON.stringify({ successful: true, data: { message_id: proof } }),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as MCPServer;
  const shim = createMcpNamespaceShim({ servers: [provider], cacheToolsList: false });
  await shim.listTools();
  _setCodeModeMcpResolverForTests(() => shim);
}

function legacyExecutionLockPath(pendingActionId: string): string {
  return path.join(PENDING_ACTIONS_DIR, `${pendingActionId}.execution.lock`);
}

function writeLegacyExecutionLock(pendingActionId: string, pid: number): string {
  const lockPath = legacyExecutionLockPath(pendingActionId);
  writeFileSync(lockPath, `${JSON.stringify({
    id: pendingActionId,
    pid,
    claimedAt: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return lockPath;
}

type TransitionLockIdentity = ReturnType<typeof pendingActionTransitionLockIdentityForTest>;

function seedTransitionLock(
  pendingActionId: string,
  input: { pid: number; ownerToken: string; operation: string },
): TransitionLockIdentity {
  const identity = pendingActionTransitionLockIdentityForTest(pendingActionId);
  seedLockIdentity(identity, input);
  return identity;
}

function seedLockIdentity(
  identity: TransitionLockIdentity,
  input: { pid: number; ownerToken: string; operation: string },
): void {
  const db = new Database(identity.dbPath);
  try {
    db.prepare(`
      INSERT INTO ${identity.table}
        (lock_key, owner_pid, owner_token, operation, acquired_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(identity.lockKey, input.pid, input.ownerToken, input.operation, Date.now());
  } finally {
    db.close();
  }
}

function readTransitionLock(identity: TransitionLockIdentity): {
  owner_pid: number;
  owner_token: string;
  operation: string;
} | null {
  const db = new Database(identity.dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT owner_pid, owner_token, operation
        FROM ${identity.table}
       WHERE lock_key = ?
    `).get(identity.lockKey) as {
      owner_pid: number;
      owner_token: string;
      operation: string;
    } | undefined ?? null;
  } finally {
    db.close();
  }
}

function deleteTransitionLock(identity: TransitionLockIdentity, ownerToken: string): void {
  const db = new Database(identity.dbPath);
  try {
    db.prepare(`DELETE FROM ${identity.table} WHERE lock_key = ? AND owner_token = ?`)
      .run(identity.lockKey, ownerToken);
  } finally {
    db.close();
  }
}

function runTransitionReconcilerProcess(
  approvalId: string,
  startAt: number,
): Promise<{ stdout: string; stderr: string }> {
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const registryUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'runtime', 'harness', 'approval-registry.ts'),
  ).href;
  const script = `
    (async () => {
      const registry = await import(${JSON.stringify(registryUrl)});
      const delay = Number(process.env.CLEMMY_TRANSITION_PIN_START_AT) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const row = registry.get(process.env.CLEMMY_TRANSITION_PIN_APPROVAL_ID || '');
      if (!row) throw new Error('approval row unavailable in recovery child');
      const ok = registry.reconcileLinkedPendingActionResolution(row);
      process.stdout.write(JSON.stringify({ ok, pid: process.pid }) + '\\n');
    })().catch((error) => {
      process.stderr.write(String(error?.stack || error) + '\\n');
      process.exitCode = 1;
    });
  `;
  const childEnv = {
    ...process.env,
    CLEMENTINE_HOME: TMP_HOME,
    CLEMMY_TRANSITION_PIN_APPROVAL_ID: approvalId,
    CLEMMY_TRANSITION_PIN_START_AT: String(startAt),
  };
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ['-e', script], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`transition recovery child timed out\n${stdout}\n${stderr}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`transition recovery child exited ${String(code ?? signal)}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runSourceFreezePermissionProcess(input: {
  sessionId: string;
  sourceUserSeq: number;
  payload: Record<string, unknown>;
  startAt: number;
  toolUseId: string;
}): Promise<{ stdout: string; stderr: string }> {
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const approvalUrl = pathToFileURL(
    path.join(process.cwd(), 'src', 'runtime', 'harness', 'claude-agent-approval.ts'),
  ).href;
  const script = `
    (async () => {
      const approval = await import(${JSON.stringify(approvalUrl)});
      const delay = Number(process.env.CLEMMY_SOURCE_FREEZE_PIN_START_AT) - Date.now();
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      const boundaries = [];
      const permission = approval.buildGatedToolPermission(
        process.env.CLEMMY_SOURCE_FREEZE_PIN_SESSION_ID || '',
        ['memory_read'],
        {
          approvalMode: 'park',
          sourceUserSeq: Number(process.env.CLEMMY_SOURCE_FREEZE_PIN_SOURCE_SEQ),
          onApprovalBoundary: (boundary) => boundaries.push(boundary),
        },
      );
      const result = await permission(
        'mcp__outlook__OUTLOOK_SEND_EMAIL',
        JSON.parse(process.env.CLEMMY_SOURCE_FREEZE_PIN_PAYLOAD || '{}'),
        {
          signal: new AbortController().signal,
          toolUseID: process.env.CLEMMY_SOURCE_FREEZE_PIN_TOOL_USE_ID,
        },
      );
      for (const boundary of boundaries) approval.surfaceDeferredConversationalApproval(boundary);
      process.stdout.write(JSON.stringify({
        behavior: result.behavior,
        approvalIds: boundaries.map((boundary) => boundary.approvalId),
      }) + '\\n');
    })().catch((error) => {
      process.stderr.write(String(error?.stack || error) + '\\n');
      process.exitCode = 1;
    });
  `;
  const childEnv = {
    ...process.env,
    CLEMENTINE_HOME: TMP_HOME,
    CLEMMY_SOURCE_FREEZE_PIN_SESSION_ID: input.sessionId,
    CLEMMY_SOURCE_FREEZE_PIN_SOURCE_SEQ: String(input.sourceUserSeq),
    CLEMMY_SOURCE_FREEZE_PIN_PAYLOAD: JSON.stringify(input.payload),
    CLEMMY_SOURCE_FREEZE_PIN_START_AT: String(input.startAt),
    CLEMMY_SOURCE_FREEZE_PIN_TOOL_USE_ID: input.toolUseId,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ['-e', script], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`source-freeze child timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`source-freeze child exited ${String(code ?? signal)}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function jsonLineWithKey<T>(stdout: string, key: string): T {
  for (const line of stdout.trim().split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parsed, key)) return parsed as T;
    } catch { /* provider logs and TAP diagnostics are not the child receipt */ }
  }
  throw new Error(`child emitted no JSON receipt containing ${key}: ${stdout}`);
}

function newFixture(label: string, carrier: 'discord' | 'slack' = 'discord') {
  const channelId = carrier === 'slack'
    ? `C${label.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`
    : `send-consent-${label}`;
  const userId = carrier === 'slack'
    ? `U${label.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`
    : `human-${label}`;
  const threadTs = carrier === 'slack' ? '1786670000.000001' : undefined;
  const conversationKey = carrier === 'slack'
    ? `slack:${channelId}:${threadTs}`
    : `discord:${channelId}`;
  const originReplyTarget = carrier === 'slack'
    ? { type: 'slack_channel' as const, channelId, threadTs }
    : { type: 'discord_channel' as const, channelId };
  const session = createSession({
    kind: 'chat',
    channel: carrier,
    metadata: { source: carrier, channelId, userId, ...(threadTs ? { threadTs } : {}) },
  });
  if (carrier === 'discord') {
    assert.equal(bindDiscordHarnessSession({ channelId, sessionId: session.id, userId }), true);
  }
  const attempt = beginRunAttempt(session.id, { runId: `request-A-${label}` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: {
      text: 'Prepare the result, then email me its link.',
      displayText: 'Prepare the result, then email me its link.',
      source: `channel:${carrier}`,
      userId,
      conversationKey,
      originReplyTarget,
      originReplyTargetDigest: exactOriginDeliveryTargetDigest(originReplyTarget),
    },
  }, { armRunInFlight: true });
  const payload = {
    to: `${label}@example.com`,
    subject: `Proof ${label}`,
    body: `The result is ready: https://docs.google.com/spreadsheets/d/${label}/edit`,
  };
  const boundaries: ClaudeAgentApprovalBoundary[] = [];
  const permission = buildGatedToolPermission(session.id, ['memory_read'], {
    approvalMode: 'park',
    sourceUserSeq: source.seq,
    onApprovalBoundary: (boundary) => boundaries.push(boundary),
  }) as unknown as Permission;
  return {
    session,
    source,
    channelId,
    threadTs,
    userId,
    conversationKey,
    payload,
    boundaries,
    permission,
  };
}

function sourceFreezeIdentity(fixture: ReturnType<typeof newFixture>): TransitionLockIdentity {
  return pendingActionSourceFreezeLockIdentityForTest({
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    toolName: 'outlook__OUTLOOK_SEND_EMAIL',
    payload: fixture.payload,
  });
}

function sourceFreezeActionInput(fixture: ReturnType<typeof newFixture>) {
  return {
    title: 'Prepared source-freeze email',
    summary: 'Exact source-owned email payload.',
    kind: 'external_send' as const,
    toolName: 'outlook__OUTLOOK_SEND_EMAIL',
    payload: fixture.payload,
    targetSummary: fixture.payload.to,
    sessionId: fixture.session.id,
    sourceUserSeq: fixture.source.seq,
    createdBy: 'source-freeze-crash-pin',
  };
}

async function parkAndPresent(label: string) {
  const fixture = newFixture(label);
  const parked = await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions(`${label}-A`),
  );
  assert.equal(parked.behavior, 'deny');
  assert.equal(fixture.boundaries.length, 1);
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const row = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  assert.ok(row?.presentation?.promptEventId && row.presentation.promptEventSeq);
  approvalRegistry.markConversationalApprovalPresented({
    approvalId: row.approvalId,
    promptEventId: row.presentation.promptEventId,
    promptEventSeq: row.presentation.promptEventSeq,
  });
  return {
    ...fixture,
    row: approvalRegistry.get(row.approvalId)!,
    pendingActionId: String(row.args?.pendingActionId ?? ''),
  };
}

function persistDecisionReply(
  fixture: Awaited<ReturnType<typeof parkAndPresent>>,
  decision: 'approve' | 'reject',
  suffix: string,
) {
  const attempt = beginRunAttempt(fixture.session.id, { runId: `${suffix}-${decision}` });
  const source = recordRunAttemptUserInput(attempt, {
    turn: 0,
    role: 'user',
    data: {
      text: decision === 'approve' ? 'Yes' : 'No',
      displayText: decision === 'approve' ? 'Yes' : 'No',
      source: 'channel_send_consent',
      approvalId: fixture.row.approvalId,
      decision,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      runId: `${suffix}-${decision}`,
    },
  }, { armRunInFlight: true });
  return { attempt, source };
}

function commitCanonicalApprovalWithoutPaPromotion(
  fixture: Awaited<ReturnType<typeof parkAndPresent>>,
  answer: ReturnType<typeof persistDecisionReply>,
  resolver: string,
) {
  const current = approvalRegistry.get(fixture.row.approvalId)!;
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET presentation_json = ?, status = 'resolved', resolution = 'approved',
           resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run(JSON.stringify({
    ...current.presentation!,
    responseSourceUserSeq: answer.source.seq,
    responseUserId: fixture.userId,
  }), resolver, new Date().toISOString(), current.approvalId);
  return approvalRegistry.get(current.approvalId)!;
}

test.before(() => {
  saveProactivityPolicy({ autoApproveScope: 'yolo', batchConfirmThreshold: 5 });
});

test.after(() => {
  _setCodeModeMcpResolverForTests(null);
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('same accepted A racing twice creates one PA, one row, and one ordinary question event', async () => {
  const fixture = newFixture('same-a-race');
  const results = await Promise.all([
    fixture.permission('mcp__outlook__OUTLOOK_SEND_EMAIL', fixture.payload, permissionOptions('same-a-1')),
    fixture.permission('mcp__outlook__OUTLOOK_SEND_EMAIL', fixture.payload, permissionOptions('same-a-2')),
  ]);
  assert.deepEqual(results.map((result) => result.behavior), ['deny', 'deny']);

  const actions = listPendingActions({ sessionId: fixture.session.id, status: 'all', limit: 100 });
  const rows = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'any' });
  assert.equal(actions.length, 1, 'same A/payload must have one frozen PendingAction identity');
  assert.equal(rows.length, 1, 'same A/payload must have one approval decision identity');
  assert.equal(fixture.boundaries.length, 2, 'both permission callbacks observe the same parked boundary');
  assert.equal(new Set(fixture.boundaries.map((boundary) => boundary.approvalId)).size, 1);

  for (const boundary of fixture.boundaries) {
    surfaceDeferredConversationalApproval(boundary);
  }
  const questions = listEvents(fixture.session.id, { types: ['approval_requested'] })
    .filter((event) => event.data.approvalPresentation === 'conversation');
  assert.equal(questions.length, 1, 'concurrent SDK shutdown callbacks publish one answer slot, not two');
  assert.equal(questions[0]?.data.approvalId, rows[0]?.approvalId);
});

test('two recoverers replace one dead source-freeze owner and create one PA, row, and question', async () => {
  const fixture = newFixture('dead-source-freeze-before-pa-write');
  const identity = sourceFreezeIdentity(fixture);
  seedLockIdentity(identity, {
    pid: PROVABLY_DEAD_PID,
    ownerToken: 'dead-source-freeze-no-pa-owner',
    operation: 'source_freeze',
  });
  const startAt = Date.now() + 3_000;
  const children = await Promise.all([
    runSourceFreezePermissionProcess({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      payload: fixture.payload,
      startAt,
      toolUseId: 'source-freeze-recoverer-one',
    }),
    runSourceFreezePermissionProcess({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      payload: fixture.payload,
      startAt,
      toolUseId: 'source-freeze-recoverer-two',
    }),
  ]);
  const results = children.map((child) => jsonLineWithKey<{
    behavior: string;
    approvalIds: string[];
  }>(child.stdout, 'behavior'));
  assert.deepEqual(results.map((result) => result.behavior), ['deny', 'deny']);
  assert.equal(new Set(results.flatMap((result) => result.approvalIds)).size, 1);
  assert.equal(readTransitionLock(identity), null);
  assert.equal(listPendingActions({ sessionId: fixture.session.id, status: 'all', limit: 100 }).length, 1);
  const rows = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'any' });
  assert.equal(rows.length, 1);
  const questions = listEvents(fixture.session.id, { types: ['approval_requested'] })
    .filter((event) => event.data.approvalPresentation === 'conversation');
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.data.approvalId, rows[0]?.approvalId);
});

test('a dead source-freeze owner after the PA write reuses it with created false', async () => {
  const fixture = newFixture('dead-source-freeze-after-pa-write');
  const first = getOrCreatePendingActionByPayloadAndSource(sourceFreezeActionInput(fixture));
  assert.equal(first.created, true);
  const identity = sourceFreezeIdentity(fixture);
  seedLockIdentity(identity, {
    pid: PROVABLY_DEAD_PID,
    ownerToken: 'dead-source-freeze-written-pa-owner',
    operation: 'source_freeze',
  });

  const recovered = getOrCreatePendingActionByPayloadAndSource(sourceFreezeActionInput(fixture));
  assert.equal(recovered.created, false);
  assert.equal(recovered.record.id, first.record.id);
  assert.equal(readTransitionLock(identity), null);
  assert.equal(listPendingActions({ sessionId: fixture.session.id, status: 'all', limit: 100 }).length, 1);

  await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('dead-source-freeze-after-pa-write-A'),
  );
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const rows = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'any' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.args?.pendingActionId, first.record.id);
  assert.equal(
    listEvents(fixture.session.id, { types: ['approval_requested'] })
      .filter((event) => event.data.approvalPresentation === 'conversation').length,
    1,
  );
});

test('a live source-freeze owner is never stolen and cannot mint a PA', () => {
  const fixture = newFixture('live-source-freeze-owner');
  const identity = sourceFreezeIdentity(fixture);
  const ownerToken = 'live-source-freeze-owner-token';
  seedLockIdentity(identity, {
    pid: process.pid,
    ownerToken,
    operation: 'source_freeze',
  });
  try {
    assert.throws(
      () => getOrCreatePendingActionByPayloadAndSource(sourceFreezeActionInput(fixture)),
      /source freeze is active or uncertain/i,
    );
    assert.deepEqual(readTransitionLock(identity), {
      owner_pid: process.pid,
      owner_token: ownerToken,
      operation: 'source_freeze',
    });
    assert.equal(listPendingActions({ sessionId: fixture.session.id, status: 'all', limit: 100 }).length, 0);
    assert.equal(approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'any' }).length, 0);
  } finally {
    deleteTransitionLock(identity, ownerToken);
  }
});

test('distinct accepted sources with identical provider bytes remain distinct decisions', async () => {
  const first = newFixture('distinct-source-first');
  await first.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    first.payload,
    permissionOptions('distinct-source-first-A'),
  );
  const secondAttempt = beginRunAttempt(first.session.id, { runId: 'distinct-source-second-A' });
  const secondSource = recordRunAttemptUserInput(secondAttempt, {
    turn: 2,
    role: 'user',
    data: {
      ...first.source.data,
      text: 'Prepare the same exact send as a new request.',
      displayText: 'Prepare the same exact send as a new request.',
    },
  }, { armRunInFlight: true });
  const secondBoundaries: ClaudeAgentApprovalBoundary[] = [];
  const secondPermission = buildGatedToolPermission(first.session.id, ['memory_read'], {
    approvalMode: 'park',
    sourceUserSeq: secondSource.seq,
    onApprovalBoundary: (boundary) => secondBoundaries.push(boundary),
  }) as unknown as Permission;
  await secondPermission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    first.payload,
    permissionOptions('distinct-source-second-A'),
  );
  const actions = listPendingActions({ sessionId: first.session.id, status: 'all', limit: 100 });
  const rows = approvalRegistry.listPending({ sessionId: first.session.id, status: 'any' });
  assert.equal(actions.length, 2, 'a new accepted source is new user authority even for byte-identical payload');
  assert.deepEqual(new Set(actions.map((action) => action.sourceUserSeq)), new Set([first.source.seq, secondSource.seq]));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.approvalId, rows[1]?.approvalId);
  assert.equal(secondBoundaries.length, 1);
});

test('inbox redelivery adopts B persisted before registry CAS and dispatches the frozen send once', async () => {
  const fixture = newFixture('orphan-b');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  const provider: MCPServer = {
    name: 'outlook',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{
        name: 'OUTLOOK_SEND_EMAIL',
        description: 'Send one email.',
        inputSchema: { type: 'object' },
      }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(tool, args) {
      providerCalls.push({ tool, args });
      return [{
        type: 'text',
        text: JSON.stringify({ successful: true, data: { message_id: 'orphan-b-proof' } }),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as MCPServer;
  const shim = createMcpNamespaceShim({ servers: [provider], cacheToolsList: false });
  await shim.listTools();
  _setCodeModeMcpResolverForTests(() => shim);

  const parked = await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('orphan-b-A'),
  );
  assert.equal(parked.behavior, 'deny');
  assert.equal(fixture.boundaries.length, 1);
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const row = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  assert.ok(row?.presentation?.promptEventId && row.presentation.promptEventSeq);
  approvalRegistry.markConversationalApprovalPresented({
    approvalId: row.approvalId,
    promptEventId: row.presentation.promptEventId,
    promptEventSeq: row.presentation.promptEventSeq,
  });
  const pendingActionId = String(row.args?.pendingActionId ?? '');
  assert.ok(pendingActionId);

  const answerRunId = 'orphan-b-provider-inbox-id';
  await assert.rejects(
    tryHandleHarnessApprovalReply({
      channelId: fixture.channelId,
      prompt: 'Yes',
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      channel: 'discord',
      transport: recordingTransport().transport,
      durableRequest: {
        runId: answerRunId,
        sessionId: fixture.session.id,
        onSourceAccepted: () => { throw new Error('hard crash after B append, before registry CAS'); },
      },
    }),
    /hard crash after B append/,
  );
  const acceptedB = listEvents(fixture.session.id, { types: ['user_input_received'] })
    .filter((event) => event.data.source === 'channel_send_consent');
  assert.equal(acceptedB.length, 1, 'the inbox answer is durable before the simulated crash');
  assert.equal(approvalRegistry.get(row.approvalId)?.status, 'pending');
  assert.equal(getPendingAction(pendingActionId)?.status, 'approval_requested');
  assert.equal(providerCalls.length, 0);

  const replay = recordingTransport();
  assert.equal(await tryHandleHarnessApprovalReply({
    channelId: fixture.channelId,
    prompt: 'Yes',
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    channel: 'discord',
    transport: replay.transport,
    durableRequest: { runId: answerRunId, sessionId: fixture.session.id },
  }), true);
  assert.equal(
    listEvents(fixture.session.id, { types: ['user_input_received'] })
      .filter((event) => event.data.source === 'channel_send_consent').length,
    1,
    'redelivery reuses B instead of appending another accepted answer',
  );
  assert.equal(approvalRegistry.get(row.approvalId)?.resolution, 'approved');
  assert.equal(getPendingAction(pendingActionId)?.status, 'executed');
  assert.equal(providerCalls.length, 1, 'the recovered B dispatches the frozen provider call exactly once');
  assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });

  await tryHandleHarnessApprovalReply({
    channelId: fixture.channelId,
    prompt: 'Yes',
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    channel: 'discord',
    transport: replay.transport,
    durableRequest: { runId: answerRunId, sessionId: fixture.session.id },
  });
  assert.equal(providerCalls.length, 1, 'another inbox replay cannot dispatch again');
});

test('the first of concurrent Yes/No durable replies is the sole registry winner', async () => {
  const fixture = await parkAndPresent('yes-no-cas');
  const yes = persistDecisionReply(fixture, 'approve', 'yes-no-first');
  const no = persistDecisionReply(fixture, 'reject', 'yes-no-second');
  const [yesResult, noResult] = await Promise.all([
    Promise.resolve().then(() => approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: yes.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'approve',
      resolver: 'concurrent-yes',
    })),
    Promise.resolve().then(() => approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: no.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'reject',
      resolver: 'concurrent-no',
    })),
  ]);
  assert.deepEqual([yesResult.ok, noResult.ok], [true, false]);
  const resolved = approvalRegistry.get(fixture.row.approvalId)!;
  assert.equal(resolved.resolution, 'approved');
  assert.equal(resolved.presentation?.responseSourceUserSeq, yes.source.seq);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');
});

test('the first of concurrent Yes/Yes durable replies is the sole registry winner', async () => {
  const fixture = await parkAndPresent('yes-yes-cas');
  const first = persistDecisionReply(fixture, 'approve', 'yes-yes-first');
  const second = persistDecisionReply(fixture, 'approve', 'yes-yes-second');
  const [firstResult, secondResult] = await Promise.all([
    Promise.resolve().then(() => approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: first.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'approve',
      resolver: 'concurrent-first-yes',
    })),
    Promise.resolve().then(() => approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: second.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'approve',
      resolver: 'concurrent-second-yes',
    })),
  ]);
  assert.deepEqual([firstResult.ok, secondResult.ok], [true, false]);
  const resolved = approvalRegistry.get(fixture.row.approvalId)!;
  assert.equal(resolved.resolution, 'approved');
  assert.equal(resolved.presentation?.responseSourceUserSeq, first.source.seq,
    'duplicate affirmative replies cannot replace the accepted B identity');
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');
});

for (const state of ['executing', 'executed', 'failed'] as const) {
  test(`restart projects ${state} without another provider dispatch`, async () => {
    const fixture = await parkAndPresent(`restart-${state}`);
    const answer = persistDecisionReply(fixture, 'approve', `restart-${state}-B`);
    const resolved = approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: answer.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'approve',
      resolver: 'restart-matrix',
    });
    assert.ok(resolved.ok && resolved.row);
    const claim = claimPendingActionExecution(fixture.pendingActionId, 'crash-matrix', {
      expectedSessionId: fixture.session.id,
      requireResolvedHumanCard: true,
    });
    assert.equal(claim.claimed, true, claim.record?.resultSummary ?? claim.reason);
    assert.ok(claim.claimToken);
    if (state === 'executed') {
      recordPendingActionResult(
        fixture.pendingActionId,
        'executed',
        'Provider returned success before the daemon stopped.',
        'crash-matrix',
        claim.claimToken,
      );
    } else if (state === 'failed') {
      recordPendingActionResult(
        fixture.pendingActionId,
        'failed',
        'Provider returned a terminal failure before the daemon stopped.',
        'crash-matrix',
        claim.claimToken,
      );
    }
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, state);
    const settled = await Promise.all([
      settleConversationalApprovalDecision(resolved.row!),
      settleConversationalApprovalDecision(resolved.row!),
    ]);
    assert.deepEqual(settled, [true, true], 'overlapping handler/boot callers join one settlement flight');
    assert.equal(
      listEvents(fixture.session.id, { types: ['provider_dispatch_started'] }).length,
      0,
      `${state} is durable no-retry truth`,
    );
    const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
      .filter((event) => event.data.sourceUserSeq === answer.source.seq);
    assert.equal(terminals.length, 1, 'B receives exactly one terminal across overlapping recovery callers');
    const presentation = terminals[0]?.data.presentation as { status?: string; text?: string } | undefined;
    if (state === 'executed') {
      assert.equal(presentation?.status, 'done');
      assert.match(presentation?.text ?? '', /Provider returned success/);
    } else {
      assert.equal(presentation?.status, 'failed');
      assert.match(presentation?.text ?? '', state === 'executing' ? /pending or uncertain|not retry/i : /terminal failure/i);
    }
  });
}

test('a durable rejection terminalizes B unsent and never dispatches', async () => {
  const fixture = await parkAndPresent('rejected-unsent');
  const answer = persistDecisionReply(fixture, 'reject', 'rejected-unsent-B');
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: fixture.row.approvalId,
    sourceUserSeq: answer.source.seq,
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    decision: 'reject',
    resolver: 'restart-matrix',
  });
  assert.ok(resolved.ok && resolved.row);
  assert.equal(await settleConversationalApprovalDecision(resolved.row!), true);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'rejected');
  assert.equal(listEvents(fixture.session.id, { types: ['provider_dispatch_started'] }).length, 0);
  const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === answer.source.seq);
  assert.equal(terminals.length, 1);
  const presentation = terminals[0]?.data.presentation as { status?: string; text?: string } | undefined;
  assert.equal(presentation?.status, 'done');
  assert.match(presentation?.text ?? '', /unsent/i);
});

test('boot registration reconciliation repairs a DB row whose PA link write was lost', async () => {
  const fixture = newFixture('registration-reconcile');
  await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('registration-reconcile-A'),
  );
  const row = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  const pendingActionId = String(row.args?.pendingActionId ?? '');
  assert.ok(pendingActionId);
  const actionPath = path.join(TMP_HOME, 'pending-actions', `${pendingActionId}.json`);
  const preLink = JSON.parse(readFileSync(actionPath, 'utf8')) as Record<string, unknown>;
  preLink.status = 'queued';
  preLink.approvalId = null;
  writeFileSync(actionPath, `${JSON.stringify(preLink, null, 2)}\n`, { mode: 0o600 });
  assert.equal(getPendingAction(pendingActionId)?.status, 'queued');
  assert.equal(getPendingAction(pendingActionId)?.approvalId, null);

  assert.equal(approvalRegistry.reconcileLinkedPendingActionRegistration(row)?.approvalId, row.approvalId);
  assert.equal(getPendingAction(pendingActionId)?.status, 'approval_requested');
  assert.equal(getPendingAction(pendingActionId)?.approvalId, row.approvalId);
});

test('boot resolution reconciliation promotes a canonical SQLite approval to the PA', async () => {
  const fixture = await parkAndPresent('resolution-reconcile');
  const answer = persistDecisionReply(fixture, 'approve', 'resolution-reconcile-B');
  const current = approvalRegistry.get(fixture.row.approvalId)!;
  const nextPresentation = {
    ...current.presentation!,
    responseSourceUserSeq: answer.source.seq,
    responseUserId: fixture.userId,
  };
  openEventLog().prepare(`
    UPDATE pending_approvals
       SET presentation_json = ?, status = 'resolved', resolution = 'approved',
           resolver = 'crash-injection', resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run(JSON.stringify(nextPresentation), new Date().toISOString(), current.approvalId);
  const canonical = approvalRegistry.get(current.approvalId)!;
  assert.equal(canonical.resolution, 'approved');
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approval_requested',
    'simulated crash left the file-backed action one store behind SQLite');

  assert.equal(approvalRegistry.reconcileLinkedPendingActionResolution(canonical), true);
  const reconciled = getPendingAction(fixture.pendingActionId);
  assert.equal(reconciled?.status, 'approved');
  assert.equal(reconciled?.approvedBy, 'human');
  assert.equal(reconciled?.approvalEvidence?.kind, 'conversation');
});

test('two boot recoverers CAS one dead transition owner before the PA approval rename, then dispatch once', async () => {
  const fixture = await parkAndPresent('dead-transition-before-approval-rename');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('dead-transition-before-rename-proof', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'dead-transition-before-approval-rename-B');
  const canonical = commitCanonicalApprovalWithoutPaPromotion(
    fixture,
    answer,
    'dead-transition-before-approval-rename',
  );
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approval_requested');
  const deadToken = 'dead-before-rename-owner-token';
  const identity = seedTransitionLock(fixture.pendingActionId, {
    pid: PROVABLY_DEAD_PID,
    ownerToken: deadToken,
    operation: 'status:approved',
  });

  const startAt = Date.now() + 1_000;
  const recoverers = await Promise.all([
    runTransitionReconcilerProcess(canonical.approvalId, startAt),
    runTransitionReconcilerProcess(canonical.approvalId, startAt),
  ]);
  assert.equal(recoverers.length, 2);
  assert.ok(recoverers.every((result) => /"ok":true/.test(result.stdout)),
    JSON.stringify(recoverers));
  assert.equal(readTransitionLock(identity), null,
    'only the exact CAS winner can delete its replacement ownership row');
  const promoted = getPendingAction(fixture.pendingActionId);
  assert.equal(promoted?.status, 'approved');
  assert.equal(promoted?.approvedBy, 'human');
  assert.equal(promoted?.approvalEvidence?.kind, 'conversation');
  assert.equal(
    promoted?.history.filter((item) => item.status === 'approved' && item.actor === 'approval-registry').length,
    1,
    'two production recoverers produce one durable human promotion entry',
  );

  assert.equal(await settleConversationalApprovalDecision(canonical), true);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executed');
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
  assert.equal(await settleConversationalApprovalDecision(canonical), true);
  assert.equal(providerCalls.length, 1, 'boot replay cannot dispatch the recovered promotion twice');
});

test('boot recovers a dead transition owner after the PA approval rename and dispatches once', async () => {
  const fixture = await parkAndPresent('dead-transition-after-approval-rename');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('dead-transition-after-rename-proof', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'dead-transition-after-approval-rename-B');
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: fixture.row.approvalId,
    sourceUserSeq: answer.source.seq,
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    decision: 'approve',
    resolver: 'dead-transition-after-approval-rename',
  });
  assert.ok(resolved.ok && resolved.row);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');
  const identity = seedTransitionLock(fixture.pendingActionId, {
    pid: PROVABLY_DEAD_PID,
    ownerToken: 'dead-after-rename-owner-token',
    operation: 'status:approved',
  });

  assert.equal(await settleConversationalApprovalDecision(resolved.row!), true);
  assert.equal(readTransitionLock(identity), null);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executed');
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
  assert.equal(await settleConversationalApprovalDecision(resolved.row!), true);
  assert.equal(providerCalls.length, 1);
});

test('boot never steals a live transition owner before or after the PA approval rename', async () => {
  for (const cut of ['before', 'after'] as const) {
    const fixture = await parkAndPresent(`live-transition-${cut}-approval-rename`);
    const providerCalls: Array<{ tool: string; args: unknown }> = [];
    await installFakeOutlookProvider(`must-not-send-live-transition-${cut}`, providerCalls);
    const answer = persistDecisionReply(fixture, 'approve', `live-transition-${cut}-approval-rename-B`);
    const resolved = cut === 'before'
      ? commitCanonicalApprovalWithoutPaPromotion(
          fixture,
          answer,
          `live-transition-${cut}-approval-rename`,
        )
      : approvalRegistry.resolveConversationalApprovalReply({
          approvalId: fixture.row.approvalId,
          sourceUserSeq: answer.source.seq,
          userId: fixture.userId,
          conversationKey: fixture.conversationKey,
          decision: 'approve',
          resolver: `live-transition-${cut}-approval-rename`,
        }).row!;
    assert.ok(resolved);
    const ownerToken = `live-${cut}-rename-owner-token`;
    const identity = seedTransitionLock(fixture.pendingActionId, {
      pid: process.pid,
      ownerToken,
      operation: cut === 'before' ? 'status:approved' : 'approved_to_executing',
    });
    try {
      await settleConversationalApprovalDecision(resolved);
      assert.deepEqual(readTransitionLock(identity), {
        owner_pid: process.pid,
        owner_token: ownerToken,
        operation: cut === 'before' ? 'status:approved' : 'approved_to_executing',
      });
      assert.equal(providerCalls.length, 0);
      assert.equal(
        getPendingAction(fixture.pendingActionId)?.status,
        cut === 'before' ? 'approval_requested' : 'approved',
      );
      const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
        .filter((event) => event.data.sourceUserSeq === answer.source.seq);
      assert.equal(terminals.length, 0, 'bounded transition contention keeps B open for retry');
    } finally {
      deleteTransitionLock(identity, ownerToken);
      _resetChatApprovalResumeForTest();
    }
  }
});

test('keyed retry heals after a live transition owner dies without new ingress or boot', async () => {
  const fixture = await parkAndPresent('transition-owner-dies-after-bounded-retry');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('timer-only-transition-recovery-proof', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'transition-owner-dies-after-bounded-retry-B');
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: fixture.row.approvalId,
    sourceUserSeq: answer.source.seq,
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    decision: 'approve',
    resolver: 'transition-owner-dies-after-bounded-retry',
  });
  assert.ok(resolved.ok && resolved.row);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');

  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    owner.once('spawn', () => resolve());
    owner.once('error', reject);
  });
  assert.ok(owner.pid);
  assert.doesNotThrow(() => process.kill(owner.pid!, 0));
  const ownerToken = `live-child-transition-owner-${owner.pid}`;
  const identity = seedTransitionLock(fixture.pendingActionId, {
    pid: owner.pid!,
    ownerToken,
    operation: 'approved_to_executing',
  });

  try {
    assert.equal(await settleConversationalApprovalDecision(resolved.row!), false,
      'bounded immediate retries exhaust while the transition owner is alive');
    assert.equal(providerCalls.length, 0);
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');
    assert.equal(
      listEvents(fixture.session.id, { types: ['conversation_completed'] })
        .filter((event) => event.data.sourceUserSeq === answer.source.seq).length,
      0,
      'B stays open while the pre-provider transition is retryable',
    );
    assert.equal(readTransitionLock(identity)?.owner_token, ownerToken);

    const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    owner.kill('SIGTERM');
    await exited;

    assert.equal(await waitFor(() => (
      getPendingAction(fixture.pendingActionId)?.status === 'executed'
      && providerCalls.length === 1
    ), 6_000), true,
    'the keyed timer alone must reload the row, recover the dead owner, and execute');
    assert.equal(readTransitionLock(identity), null);
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
    const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
      .filter((event) => event.data.sourceUserSeq === answer.source.seq);
    assert.equal(terminals.length, 1);
    const presentation = terminals[0]?.data.presentation as { status?: string; text?: string } | undefined;
    assert.equal(presentation?.status, 'done');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(providerCalls.length, 1, 'later keyed retries are cancelled by the durable terminal');
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    deleteTransitionLock(identity, ownerToken);
    _resetChatApprovalResumeForTest();
  }
});

test('keyed retry heals a transition database outage without new ingress or boot', async () => {
  const fixture = await parkAndPresent('transition-db-outage-timer-recovery');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('transition-db-outage-recovery-proof', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'transition-db-outage-timer-recovery-B');
  const canonical = commitCanonicalApprovalWithoutPaPromotion(
    fixture,
    answer,
    'transition-db-outage-timer-recovery',
  );
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approval_requested');

  const identity = pendingActionTransitionLockIdentityForTest(fixture.pendingActionId);
  const backupPath = `${identity.dbPath}.db-outage-pin-${process.pid}`;
  const checkpoint = new Database(identity.dbPath);
  try {
    checkpoint.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }
  renameSync(identity.dbPath, backupPath);
  mkdirSync(identity.dbPath);

  try {
    assert.equal(await settleConversationalApprovalDecision(canonical), false,
      'an unavailable transition DB is retryable and cannot consume accepted B');
    assert.equal(providerCalls.length, 0);
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approval_requested');
    assert.equal(
      listEvents(fixture.session.id, { types: ['conversation_completed'] })
        .filter((event) => event.data.sourceUserSeq === answer.source.seq).length,
      0,
      'the accepted reply remains open while durable PA promotion is unavailable',
    );
  } finally {
    rmSync(identity.dbPath, { recursive: true, force: true });
    renameSync(backupPath, identity.dbPath);
  }

  try {
    assert.equal(await waitFor(() => (
      getPendingAction(fixture.pendingActionId)?.status === 'executed'
      && providerCalls.length === 1
    ), 6_000), true,
    'the keyed timer alone must retry after the DB returns and execute once');
    assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
    const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
      .filter((event) => event.data.sourceUserSeq === answer.source.seq);
    assert.equal(terminals.length, 1);
    const presentation = terminals[0]?.data.presentation as { status?: string } | undefined;
    assert.equal(presentation?.status, 'done');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(providerCalls.length, 1, 'the durable terminal cancels later DB-fault retries');
  } finally {
    _resetChatApprovalResumeForTest();
  }
});

test('a post-commit transition lock release failure self-cleans by exact owner token', async () => {
  const fixture = await parkAndPresent('transition-release-cleanup');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('transition-release-cleanup-proof', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'transition-release-cleanup-B');
  const identity = pendingActionTransitionLockIdentityForTest(fixture.pendingActionId);
  const triggerName = `pin_fail_release_${process.pid}_${Date.now()}`;
  const faultDb = new Database(identity.dbPath);
  try {
    faultDb.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE DELETE ON ${identity.table}
      WHEN OLD.lock_key = ${JSON.stringify(identity.lockKey)}
      BEGIN
        SELECT RAISE(ABORT, 'injected transition release failure');
      END
    `);
  } finally {
    faultDb.close();
  }

  let resolved: ReturnType<typeof approvalRegistry.resolveConversationalApprovalReply>;
  try {
    resolved = approvalRegistry.resolveConversationalApprovalReply({
      approvalId: fixture.row.approvalId,
      sourceUserSeq: answer.source.seq,
      userId: fixture.userId,
      conversationKey: fixture.conversationKey,
      decision: 'approve',
      resolver: 'transition-release-cleanup',
    });
    assert.ok(resolved.ok && resolved.row,
      'release failure cannot mask the already-committed registry and PA mutation');
    const approved = getPendingAction(fixture.pendingActionId);
    assert.equal(approved?.status, 'approved');
    assert.equal(approved?.approvedBy, 'human');
    assert.equal(approved?.approvalEvidence?.kind, 'conversation');
    assert.equal(providerCalls.length, 0, 'release cleanup itself never crosses the provider');
    const orphan = readTransitionLock(identity);
    assert.equal(orphan?.owner_pid, process.pid);
    assert.ok(orphan?.owner_token,
      'the failed release leaves the exact acquired owner token for safe cleanup');
  } finally {
    const repairDb = new Database(identity.dbPath);
    try {
      repairDb.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    } finally {
      repairDb.close();
    }
  }

  try {
    assert.equal(await waitFor(() => readTransitionLock(identity) === null, 3_000), true,
      'the unref cleanup timer deletes only the orphaned owner-token row');
    assert.equal(await settleConversationalApprovalDecision(resolved!.row!), true);
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executed');
    assert.equal(providerCalls.length, 1);
    assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
    assert.equal(await settleConversationalApprovalDecision(resolved!.row!), true);
    assert.equal(providerCalls.length, 1, 'replaying after release cleanup cannot dispatch twice');
  } finally {
    _resetChatApprovalResumeForTest();
  }
});

test('a dead execution lock with an approved PA remains never-stale and dispatches nothing', async () => {
  const fixture = await parkAndPresent('dead-execution-lock-before-claim-rename');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('must-not-dispatch-dead-approved-lock', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'dead-execution-lock-before-claim-rename-B');
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: fixture.row.approvalId,
    sourceUserSeq: answer.source.seq,
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    decision: 'approve',
    resolver: 'dead-execution-owner-before-claim-rename',
  });
  assert.ok(resolved.ok && resolved.row);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved',
    'an execution claimant may crash after locking but before its executing rename');
  const lockPath = writeLegacyExecutionLock(fixture.pendingActionId, PROVABLY_DEAD_PID);
  try {
    await settleConversationalApprovalDecision(resolved.row!);
    assert.equal(providerCalls.length, 0,
      'a dead execution claimant is still uncertain before the executing rename');
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'approved');
    assert.equal(existsSync(lockPath), true, 'execution locks are never stolen based on PID liveness');
  } finally {
    try { unlinkSync(lockPath); } catch { /* test cleanup */ }
  }
});

test('boot never steals a dead lock once the PA is executing and never redispatches', async () => {
  const fixture = await parkAndPresent('dead-lock-executing-uncertain');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  await installFakeOutlookProvider('must-not-dispatch-dead-executing', providerCalls);
  const answer = persistDecisionReply(fixture, 'approve', 'dead-lock-executing-uncertain-B');
  const resolved = approvalRegistry.resolveConversationalApprovalReply({
    approvalId: fixture.row.approvalId,
    sourceUserSeq: answer.source.seq,
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    decision: 'approve',
    resolver: 'dead-executing-owner',
  });
  assert.ok(resolved.ok && resolved.row);
  const claim = claimPendingActionExecution(fixture.pendingActionId, 'crashed-execution-owner', {
    expectedSessionId: fixture.session.id,
    requireResolvedHumanCard: true,
  });
  assert.equal(claim.claimed, true);
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executing');
  const lockPath = writeLegacyExecutionLock(fixture.pendingActionId, PROVABLY_DEAD_PID);
  try {
    assert.equal(await settleConversationalApprovalDecision(resolved.row!), true);
    assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executing');
    assert.equal(providerCalls.length, 0, 'executing is uncertain and permanently non-retryable');
    assert.equal(existsSync(lockPath), true, 'even a dead execution owner remains non-stealable');
    const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
      .filter((event) => event.data.sourceUserSeq === answer.source.seq);
    assert.equal(terminals.length, 1);
    const presentation = terminals[0]?.data.presentation as { status?: string; text?: string } | undefined;
    assert.equal(presentation?.status, 'failed');
    assert.match(presentation?.text ?? '', /uncertain|not retry/i);
  } finally {
    try { unlinkSync(lockPath); } catch { /* test cleanup */ }
  }
});

test('restart reprojection replaces an undelivered prompt and stale Q cannot become the receipt', async () => {
  const fixture = newFixture('prompt-reprojection');
  await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('prompt-reprojection-A'),
  );
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const before = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  const oldPromptId = before.presentation?.promptEventId;
  const oldPromptSeq = before.presentation?.promptEventSeq;
  assert.ok(oldPromptId && oldPromptSeq && !before.presentation?.presentedAt);

  assert.equal(reprojectUndeliveredConversationalApproval(before), before.presentation!.question);
  const after = approvalRegistry.get(before.approvalId)!;
  assert.ok(after.presentation?.promptEventId && after.presentation.promptEventSeq);
  assert.notEqual(after.presentation?.promptEventId, oldPromptId);
  assert.ok(after.presentation!.promptEventSeq! > oldPromptSeq!);
  assert.throws(() => approvalRegistry.markConversationalApprovalPresented({
    approvalId: before.approvalId,
    promptEventId: oldPromptId!,
    promptEventSeq: oldPromptSeq!,
  }), /conflicts with its durable prompt/);
  const presented = approvalRegistry.markConversationalApprovalPresented({
    approvalId: before.approvalId,
    promptEventId: after.presentation!.promptEventId!,
    promptEventSeq: after.presentation!.promptEventSeq!,
  });
  assert.ok(presented?.presentation?.presentedAt);
  assert.equal(reprojectUndeliveredConversationalApproval(presented!), null,
    'a delivered exact prompt is never projected again');
});

test('Discord crash after live provider edit reuses the same visible message on boot', async () => {
  const fixture = newFixture('discord-provider-receipt-crash');
  await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('discord-provider-receipt-crash-A'),
  );
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const before = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  assert.ok(before.presentation?.promptEventId && before.presentation.promptEventSeq);

  const requests: Array<{ method: string; pathname: string; body: Record<string, unknown> | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    requests.push({ method, pathname: url.pathname, body });
    const response = method === 'POST'
      ? { id: 'discord-placeholder-1' }
      : {};
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const { __test__: discordTest } = await import('./discord.js');
    const transport = discordTest.buildDiscordRestTransport(fixture.channelId);
    await transport.sendInitial('Working…');
    await transport.deliverConversationalApproval({
      approvalId: before.approvalId,
      deliveryKey: approvalRegistry.conversationalApprovalDeliveryKey(before.approvalId),
      content: before.presentation.question,
    });

    const afterLiveProviderIo = approvalRegistry.get(before.approvalId)!;
    assert.equal(afterLiveProviderIo.presentation?.presentedAt, null,
      'simulate a hard crash before the live path persists its delivery receipt');
    assert.deepEqual(afterLiveProviderIo.presentation?.transportTarget, {
      provider: 'discord',
      channelId: fixture.channelId,
      messageId: 'discord-placeholder-1',
    });

    assert.equal(reprojectUndeliveredConversationalApproval(afterLiveProviderIo), afterLiveProviderIo.presentation!.question);
    const reprojected = approvalRegistry.get(before.approvalId)!;
    assert.notEqual(reprojected.presentation?.promptEventId, before.presentation.promptEventId,
      'boot may replace internal Q1 with Q2 while preserving provider-visible identity');
    await _deliverUndeliveredConversationalPromptForTest(before.approvalId);

    const posts = requests.filter((request) => request.method === 'POST');
    const edits = requests.filter((request) => request.method === 'PATCH');
    assert.equal(posts.length, 1, 'boot must not post a second visible Discord question');
    assert.equal(edits.length, 2, 'live delivery and boot retry both edit the placeholder');
    assert.deepEqual(new Set(edits.map((request) => request.pathname)), new Set([
      `/api/v10/channels/${fixture.channelId}/messages/discord-placeholder-1`,
    ]));
    assert.ok(approvalRegistry.get(before.approvalId)?.presentation?.presentedAt,
      'boot persists the receipt only after the exact-message edit succeeds');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Slack crash after live provider edit reuses the same visible message on boot', async () => {
  const fixture = newFixture('slack-provider-receipt-crash', 'slack');
  await fixture.permission(
    'mcp__outlook__OUTLOOK_SEND_EMAIL',
    fixture.payload,
    permissionOptions('slack-provider-receipt-crash-A'),
  );
  surfaceDeferredConversationalApproval(fixture.boundaries[0]);
  const before = approvalRegistry.listPending({ sessionId: fixture.session.id, status: 'pending' })[0];
  assert.ok(before.presentation?.promptEventId && before.presentation.promptEventSeq);

  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const fakeClient = {
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: '1786670001.000002' };
      },
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      },
    },
  };
  const transport = buildSlackHarnessTransport({
    client: fakeClient as never,
    channel: fixture.channelId,
    threadTs: fixture.threadTs,
  });
  const { _setSlackOutboundClientForTests } = await import('./slack.js');
  _setSlackOutboundClientForTests(fakeClient as never);
  try {
    await transport.sendInitial('Working…');
    await transport.deliverConversationalApproval!({
      approvalId: before.approvalId,
      deliveryKey: approvalRegistry.conversationalApprovalDeliveryKey(before.approvalId),
      content: before.presentation.question,
    });

    const afterLiveProviderIo = approvalRegistry.get(before.approvalId)!;
    assert.equal(afterLiveProviderIo.presentation?.presentedAt, null,
      'simulate a hard crash before the live path persists its delivery receipt');
    assert.deepEqual(afterLiveProviderIo.presentation?.transportTarget, {
      provider: 'slack',
      channelId: fixture.channelId,
      messageTs: '1786670001.000002',
      threadTs: fixture.threadTs,
    });

    assert.equal(reprojectUndeliveredConversationalApproval(afterLiveProviderIo), afterLiveProviderIo.presentation!.question);
    const reprojected = approvalRegistry.get(before.approvalId)!;
    assert.notEqual(reprojected.presentation?.promptEventId, before.presentation.promptEventId,
      'boot may replace internal Q1 with Q2 while preserving provider-visible identity');
    await _deliverUndeliveredConversationalPromptForTest(before.approvalId);

    assert.equal(posts.length, 1, 'boot must not post a second visible Slack question');
    assert.equal(updates.length, 2, 'live delivery and boot retry both update the placeholder');
    assert.deepEqual(updates.map((update) => ({ channel: update.channel, ts: update.ts })), [
      { channel: fixture.channelId, ts: '1786670001.000002' },
      { channel: fixture.channelId, ts: '1786670001.000002' },
    ]);
    assert.ok(approvalRegistry.get(before.approvalId)?.presentation?.presentedAt,
      'boot persists the receipt only after the exact-message update succeeds');
  } finally {
    _setSlackOutboundClientForTests();
  }
});

test(THREE_ENTRYPOINT_TEST_NAME, async () => {
  // startChatApprovalResume installs process-global listener state by design.
  // Run this literal three-wrapper race in a fresh process so it cannot make
  // the other matrix cases stronger merely by leaving that listener active.
  if (!THREE_ENTRYPOINT_CHILD) {
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const childEnv = { ...process.env, CLEMMY_THREE_ENTRYPOINT_PIN_CHILD: '1' };
    // Node's parent test worker sets this recursion sentinel. The isolated
    // verifier is a new process with a new temp home, so it must start its own
    // runner instead of inheriting the parent's "already inside run()" state.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(tsx, [
      '--test',
      '--test-concurrency=1',
      `--test-name-pattern=^${THREE_ENTRYPOINT_TEST_NAME}$`,
      fileURLToPath(import.meta.url),
    ], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, [
      `isolated three-entrypoint pin exited ${String(child.status)}`,
      child.stdout,
      child.stderr,
    ].filter(Boolean).join('\n'));
    assert.ok(child.stdout.includes(`# Subtest: ${THREE_ENTRYPOINT_TEST_NAME}`),
      `isolated child did not execute the literal race:\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /# pass 1(?:\r?\n|$)/);
    assert.match(child.stdout, /# fail 0(?:\r?\n|$)/);
    return;
  }

  _resetChatApprovalResumeForTest();
  let legacyResumeDispatches = 0;
  const registeredDispatch = async () => { legacyResumeDispatches += 1; };

  // Install the real production resolution listener while the registry is
  // empty, then reset only its boot-start latch. The listener intentionally
  // remains registered, matching a process whose wiring survived until this
  // resolution tick; the second start below is the literal boot drain.
  startChatApprovalResume(registeredDispatch);
  _resetChatApprovalResumeForTest();

  const fixture = await parkAndPresent('literal-three-entrypoint');
  const providerCalls: Array<{ tool: string; args: unknown }> = [];
  const provider: MCPServer = {
    name: 'outlook',
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async invalidateToolsCache() {},
    async listTools() {
      return [{
        name: 'OUTLOOK_SEND_EMAIL',
        description: 'Send one email.',
        inputSchema: { type: 'object' },
      }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool(tool, args) {
      providerCalls.push({ tool, args });
      return [{
        type: 'text',
        text: JSON.stringify({ successful: true, data: { message_id: 'three-entrypoint-proof' } }),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as MCPServer;
  const shim = createMcpNamespaceShim({ servers: [provider], cacheToolsList: false });
  await shim.listTools();
  _setCodeModeMcpResolverForTests(() => shim);

  let bootDrains = 0;
  approvalRegistry.onApprovalResolved((row) => {
    if (row.approvalId !== fixture.row.approvalId || row.resolution !== 'approved') return;
    bootDrains += 1;
    // emitResolved invokes the production listener first. This start therefore
    // scans the now-resolved row while its listener flight is live; after the
    // registry returns, the ingress handler awaits the same production flight.
    startChatApprovalResume(registeredDispatch);
  });

  const delivery = recordingTransport();
  const handled = await tryHandleHarnessApprovalReply({
    channelId: fixture.channelId,
    prompt: 'Yes',
    userId: fixture.userId,
    conversationKey: fixture.conversationKey,
    channel: 'discord',
    transport: delivery.transport,
    durableRequest: {
      runId: 'literal-three-entrypoint-B',
      sessionId: fixture.session.id,
    },
  });
  assert.equal(handled, true);
  assert.equal(bootDrains, 1, 'the accepted registry transition synchronously starts one boot drain');
  assert.equal(legacyResumeDispatches, 0,
    'the production registry listener stays on the conversational host flight');
  assert.equal(providerCalls.length, 1,
    'ingress, registry listener, and boot drain converge on one provider crossing');
  assert.deepEqual(providerCalls[0], { tool: 'OUTLOOK_SEND_EMAIL', args: fixture.payload });
  assert.equal(getPendingAction(fixture.pendingActionId)?.status, 'executed');

  const acceptedB = listEvents(fixture.session.id, { types: ['user_input_received'] })
    .filter((event) => event.data.source === 'channel_send_consent');
  assert.equal(acceptedB.length, 1, 'the three wrappers share one accepted answer B');
  const terminals = listEvents(fixture.session.id, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === acceptedB[0]?.seq);
  assert.equal(terminals.length, 1, 'the three wrappers commit one B terminal');
  const presentation = terminals[0]?.data.presentation as { status?: string; text?: string } | undefined;
  assert.equal(presentation?.status, 'done');
  assert.match(presentation?.text ?? '', /three-entrypoint-proof|executed|success/i);

  _resetChatApprovalResumeForTest();
});
