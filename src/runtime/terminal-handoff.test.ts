/**
 * Run: npx tsx --test src/runtime/terminal-handoff.test.ts
 *
 * Pins for the interactive-login Terminal hand-off. The osascript
 * executor is always injected — a real Terminal window opening during a
 * test run is exactly the kind of surprise these pins exist to prevent.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-terminal-handoff-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  openTerminalAuthSession,
  escapeAppleScriptString,
  _testOnly_setOsaExec,
  _testOnly_stopSignInWatchers,
} = await import('./terminal-handoff.js');
const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');

afterEach(() => {
  _testOnly_setOsaExec();
  _testOnly_stopSignInWatchers();
});

// The hand-off is macOS-only BY DESIGN (terminal-handoff.ts: "the product ships
// mac-only") — off darwin it returns the "run it yourself" fallback instead of
// driving Terminal. The tests below assert the macOS path, so they must not run
// on the Linux release-preflight runner.
const macOnly = {
  skip: process.platform !== 'darwin' ? 'Terminal hand-off drives Terminal.app; macOS-only by design' : false,
} as const;

test('the command comes ONLY from the catalog — callers pass an id, and the spawned script carries the exact authCommand', macOnly, async () => {
  const interactive = CLI_CATALOG.find((entry) => entry.authCommand && !entry.authHeadless)!;
  const calls: string[][] = [];
  _testOnly_setOsaExec(async (args) => { calls.push(args); return { ok: true, stderr: '' }; });

  const result = await openTerminalAuthSession(interactive.id);
  assert.equal(result.ok, true);
  assert.equal(result.command, interactive.authCommand);
  assert.equal(calls.length, 1);
  const script = calls[0].join(' ');
  assert.ok(script.includes(`do script "${interactive.authCommand}"`), 'the Terminal runs the catalog command verbatim');
  assert.ok(script.includes('tell application "Terminal" to activate'), 'the window is brought to front');
});

test('an unknown id opens nothing', async () => {
  let spawned = 0;
  _testOnly_setOsaExec(async () => { spawned += 1; return { ok: true, stderr: '' }; });
  const result = await openTerminalAuthSession('not-a-cli');
  assert.equal(result.ok, false);
  assert.equal(spawned, 0, 'no osascript call for an unknown catalog id');
});

test('AppleScript escaping neutralizes quotes and backslashes', () => {
  assert.equal(escapeAppleScriptString('plain login'), 'plain login');
  assert.equal(
    escapeAppleScriptString('say "hi" \\ there'),
    'say \\"hi\\" \\\\ there',
    'backslashes double first, quotes escape second — order matters',
  );
});

test('a TCC automation denial names the System Settings fix instead of a bare error', macOnly, async () => {
  const interactive = CLI_CATALOG.find((entry) => entry.authCommand && !entry.authHeadless)!;
  _testOnly_setOsaExec(async () => ({ ok: false, stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' }));
  const result = await openTerminalAuthSession(interactive.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /Privacy & Security → Automation/);
  assert.ok(result.message.includes(interactive.authCommand!), 'the manual command remains the fallback');
});

test('a generic osascript failure falls back to the manual command', macOnly, async () => {
  const interactive = CLI_CATALOG.find((entry) => entry.authCommand && !entry.authHeadless)!;
  _testOnly_setOsaExec(async () => ({ ok: false, stderr: 'osascript: command failed' }));
  const result = await openTerminalAuthSession(interactive.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /Run `.+` in your own terminal/);
});

test('an unanswered permission dialog (-1712 AppleEvent timeout, observed live) points at the waiting prompt', macOnly, async () => {
  const interactive = CLI_CATALOG.find((entry) => entry.authCommand && !entry.authHeadless)!;
  _testOnly_setOsaExec(async () => ({ ok: false, stderr: '71:120: execution error: Terminal got an error: AppleEvent timed out. (-1712)' }));
  const result = await openTerminalAuthSession(interactive.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /waiting for permission|click Allow/i);
  assert.ok(result.message.includes(interactive.authCommand!), 'the manual command remains the fallback');
});
