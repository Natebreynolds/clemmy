/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/windows-readiness.test.ts
 *
 * Windows-readiness pins (2026-08-20 sweep). Two properties, both enforceable
 * from macOS CI:
 *   1. The win32 branches EXIST at every must-fix site (source pins — the
 *      same style as removed-program-surface.test.ts), so a refactor cannot
 *      silently drop them before Windows CI exists to catch it.
 *   2. Mac behavior is BYTE-IDENTICAL: the win32-only danger/deny patterns
 *      must not fire on darwin (POSIX `rename` and friends never newly gate).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

test('daemon lease liveness has a real win32 command-line reader (recycled-PID boot brick)', () => {
  const src = read('src/daemon/process.ts');
  assert.match(src, /Get-CimInstance Win32_Process/, 'win32 reads the pid command line via CIM');
  assert.doesNotMatch(
    src,
    /if \(process\.platform === 'win32'\) return null;\s*try \{\s*const out = execFileSync\('ps'/,
    'the old "win32 ⇒ unreadable ⇒ block forever" shape must stay deleted',
  );
});

test('CLI discovery is PATHEXT-aware and never keys on the POSIX execute bit alone', () => {
  const src = read('src/runtime/cli-discovery.ts');
  assert.match(src, /WINDOWS_PATHEXT/, 'PATHEXT set exists');
  assert.match(src, /statLooksExecutable/, 'shared executability predicate exists');
  const predicateUses = src.match(/statLooksExecutable\(/g) ?? [];
  assert.ok(
    predicateUses.length >= 5,
    `all four PATH scanners/resolvers route through statLooksExecutable (found ${predicateUses.length} uses incl. definition)`,
  );
  assert.match(src, /commandCandidatesInDir/, 'whichOnPath expands PATHEXT candidates');
});

test('run_shell_command ships win32 danger/deny patterns, gated so darwin is untouched', async () => {
  const src = read('src/tools/computer-tools.ts');
  assert.match(src, /remove-item\\b/i, 'PowerShell Remove-Item is in the win32 danger set');
  assert.match(src, /vssadmin\\s\+delete\\b/, 'vssadmin delete is hard-denied on win32');
  assert.match(src, /taskkill', \['\/pid'/, 'timeout kills the whole cmd.exe tree on win32');
  assert.match(src, /%USERPROFILE%/, 'USERPROFILE expands like $HOME');
  // Behavior: on darwin the win32 patterns are inert — the exact shapes that
  // would gate on Windows must not newly gate here.
  const tools = await import('../tools/computer-tools.js');
  const needsApproval = (tools as unknown as {
    _commandNeedsApprovalForTest?: (cmd: string) => boolean;
    commandNeedsApproval?: (cmd: string) => boolean;
  });
  const probe = needsApproval._commandNeedsApprovalForTest ?? needsApproval.commandNeedsApproval;
  if (process.platform !== 'win32' && typeof probe === 'function') {
    assert.equal(probe('del /f /s /q build-cache'), false, 'cmd.exe shapes stay inert on darwin');
    assert.equal(probe('taskkill /f /im node.exe'), false);
  }
});

test('setup capability probe and browser-harness resolve commands via `where` on win32', () => {
  assert.match(read('src/setup/capability-status.ts'), /spawnSync\('where', \[command\]/);
  assert.match(read('src/integrations/browser-harness.ts'), /spawnSync\('where', \[command\]/);
});

test('closing the last window keeps the app (and the daemon it owns) alive on win32', () => {
  const src = read('apps/desktop/src/main.ts');
  assert.match(
    src,
    /platform !== 'darwin' && process\.platform !== 'win32'\) quitCleanly\(\)/,
    'window-all-closed quits only on Linux',
  );
});

test('graceful-degradation set: gh.exe resolution, Windows Chrome paths, file URLs, packaged detection', () => {
  assert.match(read('src/integrations/github-cli.ts'), /gh\.exe/);
  const produce = read('src/tools/document-produce-tools.ts');
  assert.match(produce, /chrome\.exe/);
  assert.match(produce, /pathToFileURL\(htmlPath\)\.href/, 'no malformed file://C:\\ URLs');
  assert.match(read('src/runtime/build-info.ts'), /win-unpacked/, 'packaged win32 daemon self-identifies as packaged');
  assert.match(read('src/runtime/managed-cli-jobs.ts'), /ComSpec/, 'managed CLI jobs run through cmd.exe on win32');
});
