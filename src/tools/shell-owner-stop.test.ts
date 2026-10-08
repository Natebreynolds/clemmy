import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as tools from './computer-tools.js';
import { attemptSignalsFromShellExecutionOutcome } from '../runtime/harness/attempt-settlement.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the owner\'s stop ends a running shell command and the call returns as stopped, never as an unknown effect', { skip: process.platform === 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-owner-stop-'));
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  const runtime = {
    cancelSignal: controller.signal,
    spawnProcess: ((command: string, options: never) => { child = spawn(command, options); return child; }) as typeof spawn,
  };
  try {
    const running = tools._testOnly_runShellCommand('for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo $i; sleep 1; done; echo finished', fixture, 60_000, runtime);
    await pause(150);
    assert.ok(child?.pid, 'the command started');
    controller.abort(new Error('owner stop'));
    await assert.rejects(running, (error: unknown) => {
      const outcome = (error as { outcome?: { errorKind?: string; effect?: string; externalMutation?: boolean } }).outcome;
      assert.equal(outcome?.errorKind, 'owner_stopped');
      assert.equal(outcome?.effect, 'none', 'a local command that was ended has no effect to reconcile');
      assert.match(String((error as Error).message), /Stopped at the owner's request/);
      return true;
    });
    await pause(200);
    assert.ok(child!.exitCode !== null || child!.signalCode !== null, 'the process group was ended');
    const signals = attemptSignalsFromShellExecutionOutcome({ phase: 'provider_execution', dispatch: 'not_applicable', effect: 'none', externalMutation: false, errorKind: 'owner_stopped' });
    assert.deepEqual(signals, { errorName: 'OwnerStoppedError', executionFailed: true, mutating: false });
    const external = attemptSignalsFromShellExecutionOutcome({ phase: 'provider_execution', dispatch: 'unknown', effect: 'possible', externalMutation: true, errorKind: 'owner_stopped' });
    assert.equal(external.acknowledged, false, 'an outside write that may have begun stays unacknowledged');
  } finally {
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('a command that finishes releases the stop listener and resolves normally', { skip: process.platform === 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-owner-stop-'));
  const controller = new AbortController();
  try {
    const result = await tools._testOnly_runShellCommand('echo fixture-ok', fixture, 10_000, { cancelSignal: controller.signal });
    assert.match(result.text, /fixture-ok/);
    controller.abort();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the durable Stop latch ends a running command after the model step that called it is gone', { skip: process.platform === 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-owner-stop-'));
  let latched = false;
  let child: ChildProcess | undefined;
  const runtime = {
    isStopRequested: () => latched,
    spawnProcess: ((command: string, options: never) => { child = spawn(command, options); return child; }) as typeof spawn,
  };
  try {
    const running = tools._testOnly_runShellCommand('for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo $i; sleep 1; done', fixture, 60_000, runtime);
    await pause(400);
    assert.ok(child?.pid, 'the command started');
    latched = true;
    await assert.rejects(running, (error: unknown) => {
      assert.equal((error as { outcome?: { errorKind?: string } }).outcome?.errorKind, 'owner_stopped');
      return true;
    });
    await pause(300);
    assert.ok(child!.exitCode !== null || child!.signalCode !== null, 'the latch ended the process group');
  } finally {
    try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(fixture, { recursive: true, force: true });
  }
});
