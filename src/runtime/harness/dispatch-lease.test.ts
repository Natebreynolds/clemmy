import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-dispatch-lease-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  beginRunAttempt,
  createSession,
  finishRunAttempt,
  listEvents,
  appendEvent,
  openEventLog,
  recordRunAttemptUserInput,
} = await import('./eventlog.js');
const {
  activateDispatchLease,
  assertDispatchLeaseCurrent,
  checkDispatchRecoveryLedger,
  captureDispatchRecoveryLedgerBaseline,
  isDispatchLeaseCurrent,
  parseDispatchLease,
  revokeDispatchLease,
  revokeDispatchLeaseBeforeRecovery,
  StaleDispatchLeaseError,
} = await import('./dispatch-lease.js');
const contracts = await import('./logical-call-contract.js');
const callAuthority = await import('./accepted-turn-call-authority.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

function delegatedWorkerLeaseFixture(marker = true) {
  const parent = createSession({ kind: 'chat' });
  const parentAttempt = beginRunAttempt(parent.id);
  const source = recordRunAttemptUserInput(parentAttempt, { turn: 1, role: 'user', data: { text: 'Read each local item in parallel.' } });
  const root = callAuthority.armHostCallAuthority({ sessionId: parent.id, sourceUserSeq: source.seq,
    catalogRevisionDigest: 'a'.repeat(64), bindingRevisionDigest: 'b'.repeat(64), maxLogicalCalls: 10, maxParallelCalls: 2 });
  assert.equal(root.status, 'armed');
  const packet = { item: 'one', objective: 'Read this local item.' };
  const lineage = { parentSessionId: parent.id, parentSourceUserSeq: source.seq,
    parentAcceptedTaskId: `task:${parent.id}#${source.seq}`, parentLogicalCallId: 'worker-call',
    packetKey: 'packet-one', packetDigest: createHash('sha256').update(JSON.stringify(packet)).digest('hex'), item: packet.item };
  const parentArgs = { item: 'one' };
  const material = contracts.durableLogicalCallRecoveryMaterial(lineage.parentAcceptedTaskId, 'run_worker', parentArgs)!;
  openEventLog().prepare(`INSERT INTO logical_tool_calls
    (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, ?, 'run_worker', ?, ?, 'open', ?)`)
    .run(parent.id, source.seq, lineage.parentAcceptedTaskId, lineage.parentLogicalCallId, material.argumentDigest, material.argumentDigest, new Date().toISOString());
  const parentLease = activateDispatchLease({ sessionId: parent.id, scopeId: `${parent.id}::call`, runAttemptId: parentAttempt.attemptId,
    sourceUserSeq: source.seq, acceptedTaskId: lineage.parentAcceptedTaskId, logicalToolCallId: lineage.parentLogicalCallId,
    recovery: { material, effect: 'local_write', businessCall: false } });
  const child = createSession({ kind: 'agent', metadata: { source: 'delegated_worker', workerScope: true, ...lineage } });
  const attempt = beginRunAttempt(child.id);
  const childSource = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', parentEventId: source.id,
    data: { text: JSON.stringify(packet), delegatedWorker: { ...lineage, composeOnly: true, packet } } });
  if (marker) appendEvent({ sessionId: parent.id, turn: 0, role: 'system', type: 'worker_started',
    data: { ...lineage, childSessionId: child.id, childSourceUserSeq: childSource.seq, childAttemptId: attempt.attemptId } });
  const activate = (lease = parentLease) => activateDispatchLease({ sessionId: child.id,
    scopeId: `${child.id}::host`, runAttemptId: attempt.attemptId, parentLease: lease });
  return { parent, child, childSource, attempt, parentLease, activate };
}

test('delegated worker leases use durable lineage and parent cancellation without owning the parent', () => {
  const fixture = delegatedWorkerLeaseFixture();
  const child = fixture.activate();
  assert.equal(isDispatchLeaseCurrent(child), true);
  revokeDispatchLease(child);
  assert.equal(isDispatchLeaseCurrent(fixture.parentLease), true);
  const next = fixture.activate();
  revokeDispatchLease(fixture.parentLease);
  assert.equal(isDispatchLeaseCurrent(next), false);
  assert.throws(() => assertDispatchLeaseCurrent(next), StaleDispatchLeaseError);
});

for (const change of ['foreign-parent', 'wrong-call-lease', 'forged-metadata', 'changed-packet', 'missing-marker'] as const) {
  test(`delegated worker lease refuses ${change} before any child dispatch`, () => {
    const fixture = delegatedWorkerLeaseFixture(change !== 'missing-marker');
    if (change === 'foreign-parent' || change === 'wrong-call-lease') {
      const foreign = change === 'foreign-parent' ? createSession({ kind: 'chat' }) : fixture.parent;
      const lease = activateDispatchLease({ sessionId: foreign.id, scopeId: `${foreign.id}::parent` });
      assert.throws(() => fixture.activate(lease), /parent must belong/);
    } else {
      if (change === 'forged-metadata') openEventLog().prepare(`UPDATE sessions SET metadata_json = json_set(metadata_json, '$.parentLogicalCallId', 'another-call') WHERE id = ?`).run(fixture.child.id);
      if (change === 'changed-packet') openEventLog().prepare(`UPDATE events SET data_json = json_set(data_json, '$.delegatedWorker.packet.objective', 'Changed scope') WHERE seq = ?`).run(fixture.childSource.seq);
      assert.throws(() => fixture.activate(), /parent must belong/);
    }
    assert.equal(isDispatchLeaseCurrent(fixture.parentLease), true);
  });
}

async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 0, stderr);
}

test('rotating one dispatch scope immediately fences the prior generation', () => {
  const session = createSession({ kind: 'chat' });
  const scopeId = `${session.id}::provider`;
  const first = activateDispatchLease({ sessionId: session.id, scopeId });
  assert.doesNotThrow(() => assertDispatchLeaseCurrent(first));

  const second = activateDispatchLease({ sessionId: session.id, scopeId });
  assert.equal(isDispatchLeaseCurrent(first), false);
  assert.throws(
    () => assertDispatchLeaseCurrent(first),
    (err: unknown) => err instanceof StaleDispatchLeaseError,
  );
  assert.equal(isDispatchLeaseCurrent(second), true);

  // Late cleanup from the first generation cannot revoke its replacement.
  revokeDispatchLease(first);
  assert.equal(isDispatchLeaseCurrent(second), true);
  revokeDispatchLease(second);
  assert.equal(isDispatchLeaseCurrent(second), false);
});

test('finishing the durable outer run invalidates a child-process lease', () => {
  const session = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(session.id, { runId: 'lease-run' });
  const lease = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::child`,
    runAttemptId: attempt.attemptId,
  });
  assert.equal(isDispatchLeaseCurrent(lease), true);

  finishRunAttempt(attempt, 'completed');
  assert.equal(isDispatchLeaseCurrent(lease), false);
  assert.throws(
    () => assertDispatchLeaseCurrent(lease),
    (err: unknown) => err instanceof StaleDispatchLeaseError,
  );
});

test('a query child is subordinate to its parent without owning parent cleanup', () => {
  const session = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(session.id, { runId: 'lease-parent-child' });
  const parent = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::parent`,
    runAttemptId: attempt.attemptId,
  });
  const child = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::query-child`,
    runAttemptId: attempt.attemptId,
    parentLease: parent,
  });

  revokeDispatchLease(child);
  assert.equal(isDispatchLeaseCurrent(child), false);
  assert.equal(isDispatchLeaseCurrent(parent), true, 'healthy child cleanup never revokes its shared parent');

  const nextChild = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::query-child`,
    runAttemptId: attempt.attemptId,
    parentLease: parent,
  });
  const grandchild = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::query-grandchild`,
    runAttemptId: attempt.attemptId,
    parentLease: nextChild,
  });
  revokeDispatchLease(parent);
  assert.equal(isDispatchLeaseCurrent(parent), false);
  assert.equal(isDispatchLeaseCurrent(nextChild), false, 'parent revoke invalidates a still-open query child');
  assert.equal(isDispatchLeaseCurrent(grandchild), false, 'ancestor revoke invalidates nested worker query descendants');
  finishRunAttempt(attempt, 'failed');
});

test('a present invalid serialized lease fails closed', () => {
  assert.throws(
    () => parseDispatchLease('{not-json'),
    /present but invalid|refusing to start an unfenced MCP/i,
  );
});

test('cross-process write admission and recovery revocation have one deterministic order', async () => {
  const session = createSession({ kind: 'chat' });
  const attempt = beginRunAttempt(session.id, { runId: 'lease-admission-race' });
  const lease = activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::cross-process`,
    runAttemptId: attempt.attemptId,
  });
  const baseline = captureDispatchRecoveryLedgerBaseline(session.id);
  const enteredFile = path.join(TMP_HOME, 'lease-child-entered');
  const releaseFile = path.join(TMP_HOME, 'lease-child-release');
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    const admission = await import(process.env.CLEM_ADMISSION_MODULE_URL);
    const dispatch = await import(process.env.CLEM_DISPATCH_MODULE_URL);
    const eventlog = await import(process.env.CLEM_EVENTLOG_MODULE_URL);
    const lease = JSON.parse(process.env.CLEM_DISPATCH_LEASE_JSON);
    await admission.withExternalWriteAdmissionLock(
      admission.externalWriteAdmissionKey(lease.sessionId),
      async () => {
        dispatch.assertDispatchLeaseCurrent(lease);
        writeFileSync(process.env.CLEM_ENTERED_FILE, 'entered');
        const deadline = Date.now() + 30000;
        while (!existsSync(process.env.CLEM_RELEASE_FILE)) {
          if (Date.now() >= deadline) process.exit(3);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        eventlog.appendEvent({
          sessionId: lease.sessionId,
          turn: 0,
          role: 'system',
          type: 'external_write',
          data: {
            callId: 'cross-process-write',
            canonicalCallId: 'cross-process-write',
            actionKey: 'test:write',
            preDispatch: true,
          },
        });
      },
    );
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_ADMISSION_MODULE_URL: pathToFileURL(path.resolve('src/runtime/harness/external-write-admission.ts')).href,
      CLEM_DISPATCH_MODULE_URL: pathToFileURL(path.resolve('src/runtime/harness/dispatch-lease.ts')).href,
      CLEM_EVENTLOG_MODULE_URL: pathToFileURL(path.resolve('src/runtime/harness/eventlog.ts')).href,
      CLEM_DISPATCH_LEASE_JSON: JSON.stringify(lease),
      CLEM_ENTERED_FILE: enteredFile,
      CLEM_RELEASE_FILE: releaseFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForFile(enteredFile);
    let revokeSettled = false;
    const revoke = revokeDispatchLeaseBeforeRecovery(lease).then(() => {
      revokeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      revokeSettled,
      false,
      'recovery cannot pass a child that already owns write admission',
    );

    writeFileSync(releaseFile, 'release');
    await waitForChild(child);
    await revoke;

    assert.equal(isDispatchLeaseCurrent(lease), false);
    const check = checkDispatchRecoveryLedger(session.id, baseline);
    assert.equal(check.safeToReplay, false);
    assert.equal(
      listEvents(session.id, { types: ['external_write'] }).length,
      1,
      'the admitted write reservation is durable before recovery proceeds',
    );
  } finally {
    if (!existsSync(releaseFile)) writeFileSync(releaseFile, 'release');
    if (child.exitCode === null) child.kill();
    finishRunAttempt(attempt, 'failed');
  }
});
