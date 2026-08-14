/**
 * RED pins — shell authorization-state protection is narrowed to the exact
 * Clementine authority locations, resolved against the command's cwd.
 *
 * Invariant under pin (live class 2026-08-11):
 *   - A mutation target is resolved relative to the command's cwd; only the
 *     exact Clementine state/audit/receipt locations are protected.
 *   - An arbitrary path is NEVER rejected merely because one of its segments
 *     is named 'state' or 'audit' — a user project's own ./state directory is
 *     ordinary writable workspace.
 *   - The protection still holds from every direction: destroying
 *     BASE_DIR/state (absolute, or relative from BASE_DIR), mutating inside
 *     the authority cwd, and the interpreter/DB write shapes stay denied.
 *
 * Run: npx tsx --test src/tools/shell-state-protection.red.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-state-protection-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

let getComputerTools: typeof import('./computer-tools.js').getComputerTools;
let shellMutatesAuthorizationState: typeof import('./computer-tools.js').shellMutatesAuthorizationState;
let writeTargetsAuthorizationState: typeof import('./computer-tools.js').writeTargetsAuthorizationState;
let BASE_DIR: string;

before(async () => {
  ({
    getComputerTools,
    shellMutatesAuthorizationState,
    writeTargetsAuthorizationState,
  } = await import('./computer-tools.js'));
  ({ BASE_DIR } = await import('../config.js'));
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function invokeShell(input: { command: string; cwd?: string | null; timeout_ms?: number | null }): Promise<string> {
  const shell = getComputerTools().find((tool) => tool.name === 'run_shell_command') as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  return shell.invoke(
    { context: { sessionId: 'sess-state-protection-test', turn: 0 } },
    JSON.stringify({ cwd: null, timeout_ms: 10_000, ...input }),
    { toolCall: { callId: `call_${Date.now()}_${Math.random().toString(36).slice(2)}` } },
  );
}

// ─── RED: a project's own 'state' directory is not Clementine authority ───

test("a project-local './state' mutation outside Clementine's home is allowed", () => {
  assert.equal(
    shellMutatesAuthorizationState('mkdir -p ./state/cache', '/tmp/some-project'),
    false,
    "a path is never protected merely because a segment is named 'state'",
  );
});

test("a write into a user project's state/ file (cwd-resolved, outside BASE_DIR) is allowed", () => {
  assert.equal(
    shellMutatesAuthorizationState('echo done > /Users/me/app/state/notes.md', '/Users/me/app'),
    false,
    "an absolute target outside Clementine's home is ordinary workspace, whatever its segments are named",
  );
});

test("a relative mutation that RESOLVES into BASE_DIR/state is denied (cwd resolution, not text matching)", () => {
  // Today the text-only segment clause misses this shape entirely while
  // rejecting harmless lookalikes — the predicate must resolve against cwd.
  assert.equal(
    shellMutatesAuthorizationState('mkdir state/tmp', BASE_DIR),
    true,
    'from BASE_DIR, `mkdir state/tmp` targets the real protected state dir',
  );
});

test('RED end-to-end: run_shell_command allows a project-local ./state write and the directory actually lands', async () => {
  const project = path.join(BASE_DIR, 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  const output = await invokeShell({ command: 'mkdir -p ./state/cache', cwd: project });
  assert.equal(
    existsSync(path.join(project, 'state', 'cache')),
    true,
    `a benign project-local state dir must be creatable; the command was refused instead: ${output.slice(0, 200)}`,
  );
});

// ─── GUARDS: the exact authority locations stay protected (green today, green after) ───

test('GUARD: destroying the exact BASE_DIR/state stays denied', () => {
  assert.equal(
    shellMutatesAuthorizationState(`rm -rf ${path.join(BASE_DIR, 'state')}`, BASE_DIR),
    true,
    'the real state dir is protected by resolved path',
  );
});

test('GUARD: a mutation whose cwd is inside the authority stays denied', () => {
  assert.equal(
    shellMutatesAuthorizationState('touch scratch.txt', path.join(BASE_DIR, 'state')),
    true,
    'working inside the authority dir is mutation of the authority',
  );
});

test('GUARD: interpreter and database writes against authority stores stay denied; reads stay legal', () => {
  const pendingFile = path.join(BASE_DIR, 'pending-actions', 'pa-proof.json');
  const harnessDb = path.join(BASE_DIR, 'state', 'harness.db');
  assert.equal(
    shellMutatesAuthorizationState(
      `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pendingFile)}, '{}')`)}`,
      BASE_DIR,
    ),
    true,
    'an interpreter write into pending-action authority is denied',
  );
  assert.equal(
    shellMutatesAuthorizationState(
      `sqlite3 ${JSON.stringify(harnessDb)} "UPDATE pending_approvals SET status='resolved'"`,
      BASE_DIR,
    ),
    true,
    'SQL mutation of the approval/event store is denied',
  );
  assert.equal(
    shellMutatesAuthorizationState(`cat ${JSON.stringify(pendingFile)}`, BASE_DIR),
    false,
    'read-only inspection is not blocked',
  );
  assert.equal(
    shellMutatesAuthorizationState(`sqlite3 ${JSON.stringify(harnessDb)} "SELECT status FROM pending_approvals"`, BASE_DIR),
    false,
    'read-only database inspection is not blocked',
  );
});

test('GUARD: the resolved-path twin allows foreign state paths and denies the exact authority targets', () => {
  // Allowed: a state-named path that is not Clementine authority.
  assert.equal(writeTargetsAuthorizationState('/Users/me/app/state/notes.md'), false);
  assert.equal(
    writeTargetsAuthorizationState(path.join(tmpHome, 'projects', 'site', 'state', 'cache.json')),
    false,
    'a workspace state dir outside BASE_DIR is ordinary writable space',
  );
  // Denied: the exact authority locations.
  assert.equal(writeTargetsAuthorizationState(path.join(BASE_DIR, 'pending-actions', 'pa-1.json')), true);
  assert.equal(writeTargetsAuthorizationState(path.join(BASE_DIR, 'state', 'harness.db')), true);
  assert.equal(writeTargetsAuthorizationState(path.join(BASE_DIR, 'audit', 'audit.jsonl')), true);
  assert.equal(
    writeTargetsAuthorizationState(path.join(
      BASE_DIR, 'Vault', '00-System', 'workflows', 'proof', 'runs', 'run-1',
      'call-mutations', 'fingerprint', 'receipt.json',
    )),
    true,
    'exact-once mutation receipts stay protected wherever they live under BASE_DIR',
  );
});

test('GUARD end-to-end: an interpreter write into pending-action authority is denied before spawn', async () => {
  const target = path.join(BASE_DIR, 'pending-actions', 'pa-shell-state-protection.json');
  mkdirSync(path.dirname(target), { recursive: true });
  const program = `require('node:fs').writeFileSync(${JSON.stringify(target)}, '{}')`;
  await invokeShell({ command: `node -e ${JSON.stringify(program)}` });
  assert.equal(existsSync(target), false, 'the protected file must never be created');
});
