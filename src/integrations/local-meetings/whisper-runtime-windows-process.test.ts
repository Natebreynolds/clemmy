import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { stopWindowsProcessTree, type ProcessTreeStopResult } from '../../runtime/windows-process-tree.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-whisper-process-test-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
test.after(() => rmSync(home, { recursive: true, force: true }));
let sequence = 0;
async function freshRuntime(): Promise<typeof import('./whisper-runtime.js')> {
  // Unknown-cleanup admission is permanent for one host instance. Each fixture
  // gets an isolated module instance rather than weakening that production latch.
  return import(new URL(`./whisper-runtime.ts?process-fixture=${++sequence}`, import.meta.url).href);
}

function simulatedChild() {
  let kills = 0; let unrefs = 0; let launches = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 51, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { kills += 1; return true; }, unref() { unrefs += 1; },
  }) as unknown as ChildProcess;
  const spawnProcess = ((..._args: unknown[]) => { launches += 1; return child; }) as typeof spawn;
  return { child, spawnProcess, kills: () => kills, unrefs: () => unrefs, launches: () => launches };
}

test('Windows abort coalesces with shutdown and cannot settle on close before the exact tree-stop receipt', async () => {
  const runtime = await freshRuntime(); const fixture = simulatedChild(); const controller = new AbortController(); let stops = 0;
  let accept!: (result: ProcessTreeStopResult) => void;
  const receipt = new Promise<ProcessTreeStopResult>(resolve => { accept = resolve; });
  const pending = runtime.__testing.runWhisperProcess('controlled.exe', [], { signal: controller.signal, timeoutMs: 10_000 }, {
    platform: 'win32', spawnProcess: fixture.spawnProcess,
    stopWindowsTree: async child => { assert.equal(child, fixture.child); stops += 1; return receipt; },
  });
  let settled = false; const observed = pending.then(() => { settled = true; }, error => { settled = true; return error; });
  controller.abort();
  assert.equal(runtime.__testing.pendingWindowsStopCount(), 1);
  await assert.rejects(() => runtime.__testing.runWhisperProcess('next.exe', [], { timeoutMs: 10_000 }, { platform: 'win32', spawnProcess: fixture.spawnProcess }), { code: 'TRANSCRIPTION_CLEANUP_PENDING' });
  await assert.rejects(() => runtime.transcribeLocalMeetingAudio({ audioPath: 'must-not-be-read.wav' }), { code: 'TRANSCRIPTION_CLEANUP_PENDING' });
  assert.equal(fixture.launches(), 1);
  const shutdown = runtime.shutdownLocalTranscriptionRuntime({ graceMs: 0 });
  fixture.child.emit('close', null, 'SIGTERM');
  await Promise.resolve(); assert.equal(settled, false); assert.equal(stops, 1); assert.equal(fixture.kills(), 0, 'no direct parent kill precedes the tree utility');
  accept('complete'); const error = await observed; await shutdown;
  assert.equal(error.code, 'TRANSCRIPTION_CANCELLED'); assert.equal(error.stopReason, 'cancelled', 'shutdown never replaces the original abort reason');
  assert.equal(stops, 1); assert.equal(runtime.__testing.activeWhisperProcessCount(), 0); assert.equal(runtime.__testing.windowsCleanupUnknown(), false);
  assert.equal(runtime.__testing.pendingWindowsStopCount(), 0);
});

test('successful bounded Windows cleanup settles timeout even when inherited pipes never emit close', async () => {
  const runtime = await freshRuntime(); const fixture = simulatedChild(); let stops = 0;
  // The real ChildProcess holds the event loop; this in-memory fixture does not.
  const keepalive = setInterval(() => {}, 20);
  let error;
  try {
    error = await runtime.__testing.runWhisperProcess('controlled.exe', [], { timeoutMs: 5 }, {
      platform: 'win32', spawnProcess: fixture.spawnProcess,
      stopWindowsTree: async () => { stops += 1; return 'complete'; },
    }).then(() => assert.fail('timeout must fail'), error => error);
  } finally { clearInterval(keepalive); }
  assert.equal(error.code, 'TRANSCRIPTION_TIMEOUT'); assert.equal(error.stopReason, 'timeout'); assert.equal(stops, 1);
  assert.equal(fixture.child.stdout?.destroyed, true); assert.equal(fixture.child.stderr?.destroyed, true);
  assert.equal(fixture.unrefs(), 1); assert.equal(runtime.__testing.activeWhisperProcessCount(), 0);
});

for (const utilityOutcome of ['incomplete', 'throw'] as const) test(`Windows ${utilityOutcome} cleanup releases held pipes, refuses later launch and fails shutdown clearly`, async () => {
  const runtime = await freshRuntime(); const fixture = simulatedChild(); const controller = new AbortController(); let stops = 0;
  const pending = runtime.__testing.runWhisperProcess('controlled.exe', [], { signal: controller.signal, timeoutMs: 10_000 }, {
    platform: 'win32', spawnProcess: fixture.spawnProcess,
    stopWindowsTree: async () => { stops += 1; if (utilityOutcome === 'throw') throw new Error('untrusted synthetic utility detail'); return 'incomplete'; },
  });
  const captured = pending.catch(error => error); controller.abort(); const error = await captured;
  assert.equal(error.code, 'TRANSCRIPTION_CLEANUP_UNKNOWN'); assert.equal(error.stopReason, 'cancelled');
  assert.match(error.message, /blocked.*restart Clementine/); assert.equal(error.message.includes('untrusted synthetic utility detail'), false);
  assert.equal(runtime.__testing.windowsCleanupUnknown(), true); assert.equal(fixture.child.stdout?.destroyed, true);
  await assert.rejects(() => runtime.__testing.runWhisperProcess('next.exe', [], { timeoutMs: 10_000 }, { platform: 'win32', spawnProcess: fixture.spawnProcess }), { code: 'TRANSCRIPTION_CLEANUP_UNKNOWN' });
  await assert.rejects(() => runtime.shutdownLocalTranscriptionRuntime({ graceMs: 0 }), { code: 'TRANSCRIPTION_CLEANUP_UNKNOWN' });
  // Admission fails before audio validation/model provisioning, so no native
  // inference, model download or overlapping output directory can start.
  await assert.rejects(() => runtime.transcribeLocalMeetingAudio({ audioPath: 'must-not-be-read.wav' }), { code: 'TRANSCRIPTION_CLEANUP_UNKNOWN' });
  assert.equal(fixture.launches(), 1); assert.equal(stops, 1);
});

test('ordinary Windows success does not issue tree-stop or latch admission', async () => {
  const runtime = await freshRuntime(); const fixture = simulatedChild(); let stops = 0;
  const pending = runtime.__testing.runWhisperProcess('controlled.exe', ['literal & argument'], { timeoutMs: 10_000 }, {
    platform: 'win32', spawnProcess: fixture.spawnProcess,
    stopWindowsTree: async () => { stops += 1; return 'incomplete'; },
  });
  (fixture.child.stdout as PassThrough).write('synthetic stdout'); fixture.child.emit('close', 0, null);
  assert.deepEqual(await pending, { stdout: 'synthetic stdout', stderr: '' });
  assert.equal(stops, 0); assert.equal(runtime.__testing.windowsCleanupUnknown(), false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('controlled process fixture did not become ready'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }

async function ownedWindowsFixture(kind: 'abort' | 'timeout' | 'shutdown' | 'missing-utility'): Promise<void> {
  const runtime = await freshRuntime(); const root = mkdtempSync(path.join(home, 'owned-node-tree-'));
  const program = path.join(root, 'parent.mjs'), trace = path.join(root, 'pids.json'), ready = path.join(root, 'ready');
  writeFileSync(program, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",process.argv[3]],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
    writeFileSync(process.argv[2],JSON.stringify({parent:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`);
  const controller = new AbortController(); let stops = 0; let parentPid = 0; let descendantPid = 0; let ownedParentPid = 0;
  const started = performance.now();
  const pending = runtime.__testing.runWhisperProcess(process.execPath, [program, trace, ready], {
    signal: controller.signal, timeoutMs: kind === 'timeout' ? 5_000 : 20_000,
  }, { stopWindowsTree: async child => {
    stops += 1; ownedParentPid = child.pid ?? 0;
    return stopWindowsProcessTree(child, kind === 'missing-utility'
      ? { env: { SystemRoot: path.join(root, 'missing operating system') }, timeoutMs: 100 } : {});
  } });
  const outcome = pending.catch(error => error);
  try {
    await waitFor(() => existsSync(trace) && existsSync(ready));
    const pids = JSON.parse(readFileSync(trace, 'utf8')); parentPid = pids.parent; descendantPid = pids.descendant;
    assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0 && Number.isSafeInteger(descendantPid) && descendantPid > 0);
    if (kind === 'shutdown') await runtime.shutdownLocalTranscriptionRuntime({ graceMs: 0 });
    else if (kind !== 'timeout') controller.abort();
    const error = await outcome;
    assert.equal(parentPid, ownedParentPid, 'trace cleanup identity is the exact parent created by the runtime');
    assert.equal(stops, 1, 'each owned attempt dispatches exactly one tree-stop utility');
    assert.ok(performance.now() - started < 15_000, 'deadline/abort/shutdown cannot await pipe EOF indefinitely');
    if (kind === 'missing-utility') {
      assert.equal(error.code, 'TRANSCRIPTION_CLEANUP_UNKNOWN'); assert.equal(runtime.__testing.windowsCleanupUnknown(), true);
      // The claim under test is the runtime's: a failed tree utility reports
      // uncertainty. Whether the descendant outlives its killed parent is the
      // OS's: Windows' job object usually leaves it (nine runs), once took it
      // with the parent (run 37673016670). Either way the runtime never claims it stopped.
      if (!alive(descendantPid)) process.stdout.write('# windows job object took the descendant with its parent\n');
      await assert.rejects(() => runtime.shutdownLocalTranscriptionRuntime({ graceMs: 0 }), { code: 'TRANSCRIPTION_CLEANUP_UNKNOWN' });
      await assert.rejects(() => runtime.__testing.runWhisperProcess(process.execPath, [], { timeoutMs: 50 }), { code: 'TRANSCRIPTION_CLEANUP_UNKNOWN' });
    } else {
      assert.equal(error.code, kind === 'timeout' ? 'TRANSCRIPTION_TIMEOUT' : 'TRANSCRIPTION_CANCELLED');
      assert.equal(error.stopReason, kind === 'shutdown' ? 'shutdown' : kind === 'timeout' ? 'timeout' : 'cancelled');
      assert.equal(alive(parentPid), false); assert.equal(alive(descendantPid), false, 'owned descendant must be gone before return');
      assert.equal(runtime.__testing.windowsCleanupUnknown(), false);
    }
  } finally {
    controller.abort();
    await outcome;
    // The attempt's bounded stop outcome settles first. Stop/wait the exact
    // parent before reading its trace so no later write can race cleanup.
    if (ownedParentPid > 0 && alive(ownedParentPid)) { try { process.kill(ownedParentPid, 'SIGKILL'); } catch { /* already gone */ } }
    await waitFor(() => !ownedParentPid || !alive(ownedParentPid));
    // If readiness failed after the parent wrote its owned trace, recover only
    // the PID pair matching the exact ChildProcess handed to tree cleanup.
    if ((!parentPid || !descendantPid) && existsSync(trace)) {
      const pids = JSON.parse(readFileSync(trace, 'utf8'));
      if (pids.parent === ownedParentPid && Number.isSafeInteger(pids.descendant) && pids.descendant > 0) {
        parentPid = ownedParentPid; descendantPid = pids.descendant;
      }
    }
    for (const pid of [descendantPid, parentPid]) if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* owned fixture already gone */ } }
    await waitFor(() => (!parentPid || !alive(parentPid)) && (!descendantPid || !alive(descendantPid)));
    rmSync(root, { recursive: true, force: true });
  }
}

for (const kind of ['abort', 'timeout', 'shutdown', 'missing-utility'] as const) test(`actual Windows node.exe ${kind} with owned descendant holding stdout/stderr`, { skip: process.platform !== 'win32' }, async () => {
  await ownedWindowsFixture(kind);
});
