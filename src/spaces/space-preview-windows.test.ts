import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'clem preview windows 猫-'));
const previewTemp = path.join(fixtureRoot, 'rendering'); mkdirSync(previewTemp);
// Other preview suites enumerate their own temporary directories. Keep this
// file's Windows simulation under a private temp root to avoid cross-suite races.
process.env.TMPDIR = previewTemp; process.env.TEMP = previewTemp; process.env.TMP = previewTemp;
process.env.CLEMENTINE_HOME = fixtureRoot;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { createSpacePreviewProcessGuard, renderWorkspacePreview } = await import('./space-preview.js');
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function browser(outcome: 'natural' | 'active' | 'timeout') {
  const invocations: Array<{ executable: string; args: string[]; options: unknown }> = [];
  const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null as number | null, signalCode: null, kill() { return true; } }) as unknown as ChildProcess;
  const spawnBrowser = ((executable: string, args: string[], options: unknown) => {
    invocations.push({ executable, args, options });
    if (outcome !== 'timeout') writeFileSync(args.find(arg => arg.startsWith('--screenshot='))!.slice('--screenshot='.length), png);
    if (outcome === 'natural') queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); });
    return child;
  }) as typeof spawn;
  return { child, invocations, spawnBrowser };
}
const input = { slug: 'controlled-preview', servedViewHtml: '<html><body>controlled page</body></html>', dataset: {}, width: 390 };

test('Windows preview accepts a stable exact screenshot after natural exit0 and launches a canonical file URL', async () => {
  const fixture = browser('natural'); let stopCalls = 0;
  const result = await renderWorkspacePreview(input, { browser: 'C:\\Chrome\\chrome.exe', platform: 'win32', processGuard: createSpacePreviewProcessGuard(), spawnBrowser: fixture.spawnBrowser,
    stopWindowsTree: async () => { stopCalls++; return 'complete'; } });
  assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) assert.ok(result.png.equals(png));
  assert.equal(stopCalls, 0, 'natural exit is not mislabeled as taskkill evidence');
  const invocation = fixture.invocations[0]!; const profile = invocation.args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
  assert.equal(invocation.args.at(-1), pathToFileURL(path.join(path.dirname(profile), 'index.html')).href);
  assert.deepEqual(invocation.options, { stdio: 'ignore', detached: false, windowsHide: true });
  assert.ok(profile.includes('clem-space-preview-'), 'the browser keeps its unique isolated preview profile');
});

test('active Windows preview excludes concurrent previews and awaits tree cleanup; forced stop cannot establish render success', async () => {
  const fixture = browser('active'); const guard = createSpacePreviewProcessGuard(); let stopped: Pick<ChildProcess, 'pid' | 'kill'> | undefined;
  const options = { browser: 'C:\\Chrome\\chrome.exe', platform: 'win32' as const, processGuard: guard, spawnBrowser: fixture.spawnBrowser,
    stopWindowsTree: async (child: Pick<ChildProcess, 'pid' | 'kill'>) => { stopped = child; return 'complete' as const; } };
  const pending = renderWorkspacePreview(input, options);
  const overlap = await renderWorkspacePreview(input, options);
  assert.equal(overlap.ok, false); if (!overlap.ok) assert.match(overlap.reason, /still running or stopping/);
  const result = await pending; assert.equal(result.ok, false); if (!result.ok) assert.match(result.reason, /did not exit normally.*not qualified/);
  assert.equal(stopped, fixture.child); assert.equal(fixture.invocations.length, 1);
  assert.equal(guard.acquire(), null, 'a confirmed stopped tree permits a later attempt, without claiming render completion');
});

test('unconfirmed Windows cleanup rejects the screenshot and retains a blocked preview slot without another browser launch', async () => {
  const fixture = browser('active'); const guard = createSpacePreviewProcessGuard();
  const options = { browser: 'C:\\Chrome\\chrome.exe', platform: 'win32' as const, processGuard: guard, spawnBrowser: fixture.spawnBrowser, stopWindowsTree: async () => 'incomplete' as const };
  const first = await renderWorkspacePreview(input, options);
  assert.equal(first.ok, false); if (!first.ok) assert.match(first.reason, /could not be confirmed stopped/);
  const second = await renderWorkspacePreview(input, options);
  assert.equal(second.ok, false); if (!second.ok) assert.match(second.reason, /previous Windows preview.*restart Clementine/);
  assert.equal(fixture.invocations.length, 1, 'cleanup failure must not release overlapping work');
});

test('Windows preview timeout remains a failed render even after a complete tree-stop receipt', async () => {
  const fixture = browser('timeout'); let stopCalls = 0;
  const result = await renderWorkspacePreview(input, { browser: 'C:\\Chrome\\chrome.exe', platform: 'win32', processGuard: createSpacePreviewProcessGuard(), spawnBrowser: fixture.spawnBrowser, timeoutMs: 30,
    stopWindowsTree: async child => { assert.equal(child, fixture.child); stopCalls++; return 'complete'; } });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.reason, /did not produce a preview in time/);
  assert.equal(stopCalls, 1);
});
