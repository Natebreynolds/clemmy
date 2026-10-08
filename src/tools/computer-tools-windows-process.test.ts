import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-windows-shell-receipt-'));
process.env.CLEMENTINE_HOME = fixture;
mkdirSync(path.join(fixture, 'state'), { recursive: true });
const tools = await import('./computer-tools.js');
const { runWithToolAbortSignal } = await import('../runtime/tool-abort-context.js');
const { HostToolInvocationDeadlineError, HostToolInvocationCancelledError, HostToolInvocationAuthorityError } = await import('../runtime/harness/host-tool-invocation.js');

function childProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref: () => {},
  });
}

test('shell deadline waits for cleanup and forbids another dispatch while receipt is pending or incomplete', async () => {
  tools._testOnly_resetShellCleanupState();
  const child = childProcess(); let spawns = 0;
  const spawnProcess = (() => { spawns += 1; return child; }) as unknown as typeof spawn;
  let finishStop!: (receipt: 'complete' | 'incomplete') => void;
  let startedStop!: () => void;
  const stopStarted = new Promise<void>(resolve => { startedStop = resolve; });
  const stopTree = () => { startedStop(); return new Promise<'complete' | 'incomplete'>(resolve => { finishStop = resolve; }); };
  const runtime = { platform: 'win32' as const, spawnProcess, stopTree };
  try {
    const command = tools._testOnly_runShellCommand('echo fixture', fixture, 10, runtime);
    let resolved = false; const failure = command.catch(error => { resolved = true; return error; });
    await stopStarted;
    assert.equal(resolved, false);
    await assert.rejects(tools._testOnly_runShellCommand('echo later', fixture, 10, runtime), error => {
      assert.equal((error as { outcome: { dispatch: string } }).outcome.dispatch, 'not_started');
      return /No command was started.*not been confirmed stopped/.test(String(error));
    });
    child.emit('close', 0);
    assert.equal(resolved, false, 'late parent exit cannot replace the tree receipt');
    finishStop('incomplete');
    const error = await failure;
    assert.equal(error.outcome.timeoutCleanup, 'incomplete');
    assert.match(error.message, /verify any completed effects.*restart Clem/);
    await assert.rejects(tools._testOnly_runShellCommand('echo again', fixture, 10, runtime), /No command was started/);
    assert.equal(spawns, 1);
  } finally { tools._testOnly_resetShellCleanupState(); }
});

test('a confirmed cleanup leaves the next independent shell command usable', async () => {
  tools._testOnly_resetShellCleanupState();
  const first = childProcess();
  await assert.rejects(tools._testOnly_runShellCommand('echo fixture', fixture, 10, {
    platform: 'win32', spawnProcess: (() => first) as unknown as typeof spawn, stopTree: async () => 'complete',
  }), error => (error as { outcome: { timeoutCleanup: string } }).outcome.timeoutCleanup === 'complete');
  const second = childProcess();
  const result = tools._testOnly_runShellCommand('echo next', fixture, 1000, {
    platform: 'win32', spawnProcess: (() => second) as unknown as typeof spawn,
  });
  second.stdout.write('next'); second.emit('close', 0);
  assert.equal((await result).outcome.exitCode, 0);
});

for (const receipt of ['complete', 'incomplete'] as const) {
  test(`owner Stop waits for the Windows process-tree receipt (${receipt}) before allowing another command`, async () => {
    tools._testOnly_resetShellCleanupState();
    const child = childProcess();
    const controller = new AbortController();
    let spawns = 0;
    let finishStop!: (receipt: 'complete' | 'incomplete') => void;
    let startedStop!: () => void;
    const stopStarted = new Promise<void>(resolve => { startedStop = resolve; });
    const runtime = {
      platform: 'win32' as const,
      cancelSignal: controller.signal,
      spawnProcess: (() => { spawns += 1; return child; }) as unknown as typeof spawn,
      stopTree: () => { startedStop(); return new Promise<'complete' | 'incomplete'>(resolve => { finishStop = resolve; }); },
    };
    try {
      let returned = false;
      const failure = tools._testOnly_runShellCommand('echo fixture', fixture, 10_000, runtime)
        .catch(error => { returned = true; return error; });
      controller.abort(new Error('owner Stop'));
      await stopStarted;
      await Promise.resolve();
      assert.equal(returned, false, 'requesting tree cleanup is not its completion');
      await assert.rejects(tools._testOnly_runShellCommand('echo later', fixture, 10_000, runtime), /No command was started/);
      child.emit('close', 0);
      assert.equal(returned, false, 'a late parent exit cannot stand in for the tree receipt');
      finishStop(receipt);
      const error = await failure;
      assert.equal(error.outcome.timeoutCleanup, receipt);
      assert.equal(error.outcome.errorKind, 'owner_stopped');
      if (receipt === 'incomplete') {
        assert.doesNotMatch(error.message, /host ended the command and its child processes/);
        await assert.rejects(tools._testOnly_runShellCommand('echo again', fixture, 10_000, runtime), /No command was started/);
      }
      assert.equal(spawns, 1);
    } finally { tools._testOnly_resetShellCleanupState(); }
  });
}

for (const [reason, expectedKind] of [
  [new HostToolInvocationDeadlineError(125), 'timeout'],
  [new HostToolInvocationCancelledError('kill'), 'owner_stopped'],
  [new HostToolInvocationCancelledError('caller'), 'cancelled'],
  [new HostToolInvocationAuthorityError('fixture revoked'), 'cancelled'],
] as const) {
  test(`an exact invocation abort preserves ${reason.name}/${'reason' in reason ? reason.reason : 'deadline'} without certifying an external effect`, async () => {
    tools._testOnly_resetShellCleanupState();
    const controller = new AbortController();
    const child = childProcess();
    try {
      // No network process is launched: this fixture only verifies the
      // process owner's typed receipt for a potentially dispatched write.
      const failure = runWithToolAbortSignal(controller.signal, () =>
        tools._testOnly_runShellCommand('curl -X POST https://example.invalid/fixture', fixture, 10_000, {
          platform: 'win32', spawnProcess: (() => child) as unknown as typeof spawn,
          stopTree: async () => 'complete',
        })).catch(error => error);
      controller.abort(reason);
      const error = await failure;
      assert.equal(error.outcome.errorKind, expectedKind);
      assert.equal(error.outcome.dispatch, 'unknown');
      assert.equal(error.outcome.effect, 'possible');
      assert.equal(error.outcome.timeoutCleanup, 'complete');
      if (expectedKind === 'timeout') assert.match(error.message, /timed out after 125ms/);
      if (expectedKind === 'cancelled') assert.doesNotMatch(error.message, /owner's request/);
    } finally { tools._testOnly_resetShellCleanupState(); }
  });
}

test('a pre-aborted exact invocation never starts a shell process', async () => {
  const controller = new AbortController();
  controller.abort(new HostToolInvocationCancelledError('kill'));
  let spawns = 0;
  await assert.rejects(runWithToolAbortSignal(controller.signal, () =>
    tools._testOnly_runShellCommand('echo fixture', fixture, 10_000, {
      spawnProcess: (() => { spawns += 1; return childProcess(); }) as unknown as typeof spawn,
    })), error => {
    const outcome = (error as { outcome: { dispatch: string; effect: string } }).outcome;
    assert.equal(outcome.dispatch, 'not_started');
    assert.equal(outcome.effect, 'none');
    return true;
  });
  assert.equal(spawns, 0);
});
