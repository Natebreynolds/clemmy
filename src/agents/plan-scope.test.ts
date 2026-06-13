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
  evaluateAutoApprove,
  getPlanScope,
  isAutoApprovedByScope,
  listActiveScopes,
  listAllScopes,
  openPlanScope,
  recordAutoApproval,
  summarizeToolArgs,
  grantStandingApproval,
  revokeStandingApproval,
  isStandingGranted,
  listStandingGrants,
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

test('isAutoApprovedByScope: allowedComposioSlugs narrows generic broker approvals', () => {
  openPlanScope({
    sessionId: 'sess-composio-slug',
    planProposalId: 'plan-slug',
    approvedPlanObjective: 'create outlook drafts',
    allowedTools: ['composio_execute_tool'],
    allowedComposioSlugs: ['OUTLOOK_CREATE_DRAFT'],
  });
  assert.equal(
    isAutoApprovedByScope('sess-composio-slug', 'composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT' }),
    true,
  );
  assert.equal(
    isAutoApprovedByScope('sess-composio-slug', 'composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_EMAIL' }),
    false,
  );
});

test('isAutoApprovedByScope: wildcard and prefix wildcards cover matching tools', () => {
  openPlanScope({
    sessionId: 'sess-wide',
    planProposalId: 'plan-wide',
    approvedPlanObjective: 'approved workflow',
    allowedTools: ['*'],
  });
  assert.equal(isAutoApprovedByScope('sess-wide', 'composio_execute_tool'), true);
  assert.equal(isAutoApprovedByScope('sess-wide', 'write_file'), true);

  openPlanScope({
    sessionId: 'sess-prefix',
    planProposalId: 'plan-prefix',
    approvedPlanObjective: 'approved connector family',
    allowedTools: ['composio_*'],
  });
  assert.equal(isAutoApprovedByScope('sess-prefix', 'composio_execute_tool'), true);
  assert.equal(isAutoApprovedByScope('sess-prefix', 'run_shell_command'), false);
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

// ─── evaluateAutoApprove (policy + scope layering) ─────────────

test('evaluateAutoApprove: strict + no plan scope = denied', () => {
  const d = evaluateAutoApprove({ sessionId: 'sess-x', toolName: 'run_shell_command', scope: 'strict', insideWorkspace: true });
  assert.equal(d.autoApproved, false);
  assert.equal(d.reason, 'denied');
});

test('evaluateAutoApprove: strict + active plan scope = auto via plan-scope', () => {
  openPlanScope({ sessionId: 'sess-plan', planProposalId: 'plan-1', approvedPlanObjective: 'objective' });
  const d = evaluateAutoApprove({ sessionId: 'sess-plan', toolName: 'run_shell_command', scope: 'strict', insideWorkspace: false });
  assert.equal(d.autoApproved, true);
  assert.equal(d.reason, 'plan-scope');
});

test('evaluateAutoApprove: workspace + inside workspace = auto', () => {
  const d = evaluateAutoApprove({ sessionId: 'sess-w', toolName: 'run_shell_command', scope: 'workspace', insideWorkspace: true });
  assert.equal(d.autoApproved, true);
  assert.equal(d.reason, 'workspace-policy');
});

test('evaluateAutoApprove: workspace + outside workspace = denied', () => {
  const d = evaluateAutoApprove({ sessionId: 'sess-out', toolName: 'run_shell_command', scope: 'workspace', insideWorkspace: false });
  assert.equal(d.autoApproved, false);
});

test('evaluateAutoApprove: yolo = auto regardless of workspace', () => {
  const d1 = evaluateAutoApprove({ sessionId: 'sess-y1', toolName: 'run_shell_command', scope: 'yolo', insideWorkspace: false });
  const d2 = evaluateAutoApprove({ sessionId: 'sess-y2', toolName: 'write_file', scope: 'yolo', insideWorkspace: true });
  assert.equal(d1.autoApproved, true);
  assert.equal(d1.reason, 'yolo-policy');
  assert.equal(d2.autoApproved, true);
  assert.equal(d2.reason, 'yolo-policy');
});

test('evaluateAutoApprove: plan-scope wins over policy reason when both fire', () => {
  openPlanScope({ sessionId: 'sess-both', planProposalId: 'plan-2', approvedPlanObjective: 'both' });
  const d = evaluateAutoApprove({ sessionId: 'sess-both', toolName: 'run_shell_command', scope: 'yolo', insideWorkspace: true });
  assert.equal(d.autoApproved, true);
  // plan-scope takes precedence so the audit log reflects the user's
  // explicit approval rather than the catch-all yolo policy.
  assert.equal(d.reason, 'plan-scope');
});

// ─── B1: goal-scoped autonomy ────────────────────────────────────────────────

test('a goal-scoped scope never time-expires (only its goal closes it)', () => {
  openPlanScope({
    sessionId: 'sess-gs1', planProposalId: 'goal-1', approvedPlanObjective: 'auto',
    allowedTools: ['*'], goalScoped: { goalId: 'goal-1' },
  });
  // Backdate the expiry far into the past — a TIME-boxed scope would be dead.
  backdate('sess-gs1', -2 * 60 * 60 * 1000, -60 * 60 * 1000);
  const scope = getPlanScope('sess-gs1');
  assert.ok(scope && !scope.closedAt, 'goal scope ignores the elapsed TTL');
  assert.equal(isAutoApprovedByScope('sess-gs1', 'run_shell_command'), true);
  // Closing it (the goal-terminal hook does this) refuses further approvals.
  closePlanScope('sess-gs1', 'goal satisfied');
  assert.equal(isAutoApprovedByScope('sess-gs1', 'run_shell_command'), false);
});

test('goal-scoped send lock: a send auto-approves ONLY if enumerated in allowedSends', () => {
  openPlanScope({
    sessionId: 'sess-gs2', planProposalId: 'goal-2', approvedPlanObjective: 'auto',
    allowedTools: ['*'], goalScoped: { goalId: 'goal-2' },
    allowedSends: ['composio_execute_tool', 'GMAIL_SEND_EMAIL'],
  });
  // A non-send tool flows under '*'.
  assert.equal(isAutoApprovedByScope('sess-gs2', 'write_file', undefined, 'other'), true);
  // An enumerated send tool name auto-approves.
  assert.equal(isAutoApprovedByScope('sess-gs2', 'composio_execute_tool', '{"tool_slug":"GMAIL_SEND_EMAIL"}', 'send'), true);
  // An enumerated composio slug (via the broker) auto-approves.
  assert.equal(isAutoApprovedByScope('sess-gs2', 'GMAIL_SEND_EMAIL', undefined, 'send'), true);
  // A send NOT enumerated falls through to approval even though '*' covers tools.
  assert.equal(isAutoApprovedByScope('sess-gs2', 'SLACK_POST_MESSAGE', undefined, 'send'), false);
});

test('goal-scoped scope with NO allowedSends gates every send', () => {
  openPlanScope({
    sessionId: 'sess-gs3', planProposalId: 'goal-3', approvedPlanObjective: 'auto',
    allowedTools: ['*'], goalScoped: { goalId: 'goal-3' },
  });
  assert.equal(isAutoApprovedByScope('sess-gs3', 'GMAIL_SEND_EMAIL', undefined, 'send'), false, 'no blessed sends ⇒ all sends gate');
  assert.equal(isAutoApprovedByScope('sess-gs3', 'write_file', undefined, 'other'), true, 'non-sends still flow');
});

test('a TIME-boxed scope keeps its prior send behavior (send lock is goal-scoped only)', () => {
  // Without goalScoped, a send listed in allowedTools auto-approves as before —
  // the 15-min TTL is what bounds it. The send lock must not regress this.
  openPlanScope({
    sessionId: 'sess-tb', planProposalId: 'plan-tb', approvedPlanObjective: 'time-boxed',
    allowedTools: ['GMAIL_SEND_EMAIL'],
  });
  assert.equal(isAutoApprovedByScope('sess-tb', 'GMAIL_SEND_EMAIL', undefined, 'send'), true);
});

// ─── B2: standing grants ─────────────────────────────────────────────────────

test('a standing grant auto-approves a write tool with no session scope, and revoke ends it', () => {
  assert.equal(isAutoApprovedByScope(undefined, 'run_shell_command'), false, 'no grant yet');
  const grant = grantStandingApproval('run_shell_command', { kind: 'execute', note: 'trusted' });
  assert.ok(grant);
  assert.equal(isStandingGranted('run_shell_command'), true);
  // Session-independent: auto-approves even with no plan scope on the session.
  assert.equal(isAutoApprovedByScope('sess-none', 'run_shell_command'), true);
  assert.equal(listStandingGrants().length, 1);

  assert.equal(revokeStandingApproval('run_shell_command'), true);
  assert.equal(isStandingGranted('run_shell_command'), false);
  assert.equal(isAutoApprovedByScope('sess-none', 'run_shell_command'), false, 'revoked grant no longer auto-approves');
  assert.equal(listStandingGrants().length, 0);
});

test('send and admin kinds can NEVER be granted (side-effect law at write time)', () => {
  assert.equal(grantStandingApproval('GMAIL_SEND_EMAIL', { kind: 'send' }), null, 'send refused');
  assert.equal(grantStandingApproval('delete_account', { kind: 'admin' }), null, 'admin refused');
  assert.equal(isStandingGranted('GMAIL_SEND_EMAIL'), false);
  // Even if a send tool were somehow granted, the kindHint guard blocks it.
  grantStandingApproval('write_file', { kind: 'write' });
  assert.equal(isAutoApprovedByScope('s', 'write_file', undefined, 'send'), false, 'a send call never rides a grant');
});

test('CLEMMY_STANDING_GRANTS=off makes grants inert', () => {
  grantStandingApproval('run_shell_command', { kind: 'execute' });
  process.env.CLEMMY_STANDING_GRANTS = 'off';
  try {
    assert.equal(isStandingGranted('run_shell_command'), false);
    assert.equal(isAutoApprovedByScope('s', 'run_shell_command'), false);
  } finally {
    delete process.env.CLEMMY_STANDING_GRANTS;
  }
});
