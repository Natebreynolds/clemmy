/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-scope npx tsx --test src/agents/plan-scope.test.ts
 *
 * Verifies:
 *   - openPlanScope clamps TTL into [60s, 1h]
 *   - isAutoApprovedByScope returns false when no scope, when expired,
 *     when closed, when toolName not in allowedTools
 *   - recordAutoApproval appends to the audit list
 *   - closePlanScope makes the scope refuse further approvals
 *   - listActiveScopes filters expired + closed
 *   - summarizeToolArgs picks meaningful fields per tool
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const TEST_HOME = '/tmp/clemmy-test-scope';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  DEFAULT_SCOPE_ALLOWED_TOOLS,
  closePlanScope,
  getPlanScope,
  isAutoApprovedByScope,
  listActiveScopes,
  listAllScopes,
  openPlanScope,
  recordAutoApproval,
  summarizeToolArgs,
} = await import('./plan-scope.js');

const SCOPES_FILE = path.join(TEST_HOME, 'state', 'plan-scopes.json');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME + '/state', { recursive: true });
});

beforeEach(() => {
  rmSync(SCOPES_FILE, { force: true });
});

function backdate(sessionId: string, openedDeltaMs: number, expiresDeltaMs: number): void {
  const raw = JSON.parse(readFileSync(SCOPES_FILE, 'utf-8'));
  const now = Date.now();
  raw.scopes[sessionId].openedAt = new Date(now + openedDeltaMs).toISOString();
  raw.scopes[sessionId].expiresAt = new Date(now + expiresDeltaMs).toISOString();
  writeFileSync(SCOPES_FILE, JSON.stringify(raw, null, 2), 'utf-8');
}

// ─── open / get ────────────────────────────────────────────────

test('openPlanScope: writes a scope with default TTL and default tools', () => {
  const scope = openPlanScope({
    sessionId: 'sess-1',
    planProposalId: 'plan-abc',
    approvedPlanObjective: 'Pull stale Salesforce accounts.',
  });
  assert.equal(scope.sessionId, 'sess-1');
  assert.deepEqual(scope.allowedTools, DEFAULT_SCOPE_ALLOWED_TOOLS);
  assert.ok(Date.parse(scope.expiresAt) > Date.now());
  assert.equal(scope.closedAt, undefined);
});

test('openPlanScope: clamps TTL to floor (60s) and ceiling (1h)', () => {
  const tiny = openPlanScope({
    sessionId: 'sess-tiny',
    planProposalId: 'plan-x',
    approvedPlanObjective: 'tiny',
    ttlMs: 1000,
  });
  const tinyTtl = Date.parse(tiny.expiresAt) - Date.parse(tiny.openedAt);
  assert.ok(tinyTtl >= 60_000 - 1000, 'TTL should be floored to 60s');

  const huge = openPlanScope({
    sessionId: 'sess-huge',
    planProposalId: 'plan-y',
    approvedPlanObjective: 'huge',
    ttlMs: 24 * 60 * 60 * 1000,
  });
  const hugeTtl = Date.parse(huge.expiresAt) - Date.parse(huge.openedAt);
  assert.ok(hugeTtl <= 60 * 60 * 1000 + 1000, 'TTL should be ceilinged to 1h');
});

test('openPlanScope: custom allowedTools applied when non-empty', () => {
  const scope = openPlanScope({
    sessionId: 'sess-custom',
    planProposalId: 'plan-z',
    approvedPlanObjective: 'custom tool set',
    allowedTools: ['run_shell_command'],
  });
  assert.deepEqual(scope.allowedTools, ['run_shell_command']);
});

test('getPlanScope: returns null for unknown session', () => {
  assert.equal(getPlanScope('does-not-exist'), null);
});

// ─── isAutoApprovedByScope ────────────────────────────────────

test('isAutoApprovedByScope: true inside active scope for allowed tool', () => {
  openPlanScope({ sessionId: 'sess-1', planProposalId: 'plan-1', approvedPlanObjective: 'objective' });
  assert.equal(isAutoApprovedByScope('sess-1', 'run_shell_command'), true);
  assert.equal(isAutoApprovedByScope('sess-1', 'write_file'), true);
});

test('isAutoApprovedByScope: false for tool NOT in allowedTools', () => {
  openPlanScope({
    sessionId: 'sess-narrow',
    planProposalId: 'plan-1',
    approvedPlanObjective: 'narrow',
    allowedTools: ['run_shell_command'],
  });
  assert.equal(isAutoApprovedByScope('sess-narrow', 'write_file'), false);
});

test('isAutoApprovedByScope: false when scope expired', () => {
  openPlanScope({ sessionId: 'sess-exp', planProposalId: 'plan-1', approvedPlanObjective: 'exp' });
  backdate('sess-exp', -7200_000, -1000); // opened 2h ago, expired 1s ago
  assert.equal(isAutoApprovedByScope('sess-exp', 'run_shell_command'), false);
});

test('isAutoApprovedByScope: false when scope closed', () => {
  openPlanScope({ sessionId: 'sess-closed', planProposalId: 'plan-1', approvedPlanObjective: 'closed' });
  closePlanScope('sess-closed', 'user revoked');
  assert.equal(isAutoApprovedByScope('sess-closed', 'run_shell_command'), false);
});

test('isAutoApprovedByScope: false with no sessionId', () => {
  assert.equal(isAutoApprovedByScope(undefined, 'run_shell_command'), false);
  assert.equal(isAutoApprovedByScope('', 'run_shell_command'), false);
});

// ─── audit log ─────────────────────────────────────────────────

test('recordAutoApproval: appends entries to the scope audit list', () => {
  openPlanScope({ sessionId: 'sess-audit', planProposalId: 'plan-1', approvedPlanObjective: 'audit me' });
  recordAutoApproval('sess-audit', 'run_shell_command', 'which sf');
  recordAutoApproval('sess-audit', 'run_shell_command', 'sf data query …');
  const scope = getPlanScope('sess-audit');
  assert.ok(scope);
  assert.equal(scope.autoApprovals.length, 2);
  assert.equal(scope.autoApprovals[0].toolName, 'run_shell_command');
  assert.match(scope.autoApprovals[0].summary, /which sf/);
});

test('recordAutoApproval: no-op when scope does not exist', () => {
  recordAutoApproval('sess-ghost', 'run_shell_command', 'echo hi');
  assert.equal(getPlanScope('sess-ghost'), null);
});

// ─── close / list ──────────────────────────────────────────────

test('closePlanScope: marks scope with reason and timestamp', () => {
  openPlanScope({ sessionId: 'sess-close', planProposalId: 'plan-1', approvedPlanObjective: 'close it' });
  const closed = closePlanScope('sess-close', 'work complete');
  assert.ok(closed);
  assert.equal(closed.closedReason, 'work complete');
  assert.ok(closed.closedAt);
});

test('listActiveScopes: returns only unexpired + unclosed', () => {
  openPlanScope({ sessionId: 'sess-A', planProposalId: 'plan-A', approvedPlanObjective: 'A' });
  openPlanScope({ sessionId: 'sess-B', planProposalId: 'plan-B', approvedPlanObjective: 'B' });
  openPlanScope({ sessionId: 'sess-C', planProposalId: 'plan-C', approvedPlanObjective: 'C' });
  closePlanScope('sess-B');
  backdate('sess-C', -7200_000, -1000);
  const active = listActiveScopes();
  const ids = active.map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['sess-A']);
});

test('listAllScopes: returns everything, newest first', () => {
  openPlanScope({ sessionId: 'sess-old', planProposalId: 'plan-1', approvedPlanObjective: 'old' });
  // Force temporal order
  // eslint-disable-next-line no-empty
  for (let i = 0; i < 5_000_000; i++) {}
  openPlanScope({ sessionId: 'sess-new', planProposalId: 'plan-2', approvedPlanObjective: 'new' });
  const all = listAllScopes();
  assert.equal(all.length, 2);
  assert.equal(all[0].sessionId, 'sess-new');
});

// ─── arg summary ───────────────────────────────────────────────

test('summarizeToolArgs: extracts shell command + cwd', () => {
  const s = summarizeToolArgs('run_shell_command', { command: 'ls -la', cwd: '/tmp', timeout_ms: 5000 });
  assert.match(s, /ls -la/);
  assert.match(s, /\/tmp/);
});

test('summarizeToolArgs: extracts file path + length for write_file', () => {
  const s = summarizeToolArgs('write_file', { path: '/x/y.ts', content: 'a'.repeat(420) });
  assert.match(s, /\/x\/y\.ts/);
  assert.match(s, /420 chars/);
});

test('summarizeToolArgs: generic fallback for unknown tools', () => {
  const s = summarizeToolArgs('something_else', { foo: 'bar', count: 3 });
  assert.match(s, /foo=bar/);
  assert.match(s, /count=3/);
});
