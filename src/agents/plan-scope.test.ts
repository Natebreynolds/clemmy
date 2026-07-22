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
  grantSendTrust,
  revokeSendTrust,
  listSendTrustGrants,
  matchesSendTrust,
  extractSendTargets,
  SEND_TRUST_MAX_RECIPIENTS,
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

test('evaluateAutoApprove: the load-bearing invariant — an IRREVERSIBLE SEND is never auto-approved even under Autonomous, but a reversible draft is', () => {
  // This is the property the whole trust model rests on: Autonomous (yolo) is
  // the DEFAULT, so an irreversible external send MUST still be held for a
  // human at the gate, while a reversible draft/write flows freely.
  const send = evaluateAutoApprove({ sessionId: 'sess-inv-send', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL' }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(send.autoApproved, false, 'an irreversible send is HELD under Autonomous — the core guarantee');

  const draft = evaluateAutoApprove({ sessionId: 'sess-inv-draft', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_CREATE_DRAFT' }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(draft.autoApproved, true, 'a reversible draft auto-approves — it is not an irreversible send');

  // The meeting-invite hole fixed in the 2026-07-21 write-path sweep: a
  // meeting CREATE dispatches invites, so it must be held too.
  const meeting = evaluateAutoApprove({ sessionId: 'sess-inv-mtg', toolName: 'composio_execute_tool', args: { tool_slug: 'ZOOM_CREATE_MEETING' }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(meeting.autoApproved, false, 'a meeting-invite create is held under Autonomous');

  // And the cx_ dynamic-tool lane resolves to the same gate.
  const cxSend = evaluateAutoApprove({ sessionId: 'sess-inv-cx', toolName: 'cx_gmail_send_email', scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(cxSend.autoApproved, false, 'a cx_ send is held identically to the broker send');
});

// ─── Scoped send-trust (2026-07-21) ──────────────────────────────────────────

test('send-trust: the invariant HOLDS with zero grants — an irreversible send is still held under Autonomous', () => {
  // The whole safety story: with no grants the behaviour is byte-identical to
  // the always-ask default. matchesSendTrust must be false, the send held.
  assert.equal(listSendTrustGrants().length, 0);
  const send = evaluateAutoApprove({ sessionId: 's-zero', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@client.com' } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(send.autoApproved, false, 'no grants → held');
});

test('send-trust: refuses an UNSCOPED grant (no domain, no recipient)', () => {
  assert.equal(grantSendTrust({ note: 'trust everything' }), null, 'an unscoped send-trust is refused by design');
  assert.equal(grantSendTrust({ domains: [], recipients: [] }), null);
  assert.equal(listSendTrustGrants().length, 0);
});

test('send-trust: a domain-scoped grant auto-approves a send where EVERY recipient is in-domain', () => {
  grantSendTrust({ domains: ['breakthroughcoaching.ai'], note: 'my team' });
  const d = evaluateAutoApprove({
    sessionId: 's-dom', toolName: 'composio_execute_tool',
    args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'nathan@breakthroughcoaching.ai', cc: 'sam@breakthroughcoaching.ai' } },
    scope: 'yolo', insideWorkspace: false, kindHint: 'send',
  });
  assert.equal(d.autoApproved, true, 'all recipients in the trusted domain → auto');
  assert.equal(d.reason, 'send-trust', 'audit trail records send-trust as the reason');
});

test('send-trust: a MIXED send (one recipient OUT of scope) is still held', () => {
  grantSendTrust({ domains: ['breakthroughcoaching.ai'] });
  const d = evaluateAutoApprove({
    sessionId: 's-mix', toolName: 'composio_execute_tool',
    args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'nathan@breakthroughcoaching.ai', cc: 'outsider@rival.com' } },
    scope: 'yolo', insideWorkspace: false, kindHint: 'send',
  });
  assert.equal(d.autoApproved, false, 'one out-of-scope recipient → the whole send is held');
});

test('send-trust: an exact-recipient grant matches only that address', () => {
  grantSendTrust({ recipients: ['ceo@partner.com'] });
  const hit = evaluateAutoApprove({ sessionId: 's-r1', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'ceo@partner.com' } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(hit.autoApproved, true);
  const miss = evaluateAutoApprove({ sessionId: 's-r2', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'intern@partner.com' } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(miss.autoApproved, false, 'a different address at the same host is NOT covered by an exact-recipient grant');
});

test('send-trust: the mass-send floor overrides any grant', () => {
  grantSendTrust({ domains: ['breakthroughcoaching.ai'] });
  const many = Array.from({ length: SEND_TRUST_MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@breakthroughcoaching.ai`).join(',');
  const d = evaluateAutoApprove({ sessionId: 's-mass', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: many } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(d.autoApproved, false, `a send over ${SEND_TRUST_MAX_RECIPIENTS} recipients always asks, even all-in-domain`);
});

test('send-trust: fail-closed when no recipient can be extracted', () => {
  grantSendTrust({ domains: ['breakthroughcoaching.ai'] });
  // A send-shaped call with no parseable recipient (e.g. a call with only a
  // phone number in an unrecognised field) must NOT match — hold it.
  assert.equal(matchesSendTrust('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { subject: 'hi' } }), false);
});

test('send-trust: a revoked grant no longer matches', () => {
  const g = grantSendTrust({ domains: ['breakthroughcoaching.ai'] })!;
  assert.equal(matchesSendTrust('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@breakthroughcoaching.ai' } }), true);
  assert.equal(revokeSendTrust(g.id), true);
  assert.equal(matchesSendTrust('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@breakthroughcoaching.ai' } }), false, 'revoked → held again');
});

test('send-trust: a toolkit-scoped grant only matches its toolkit', () => {
  grantSendTrust({ domains: ['breakthroughcoaching.ai'], toolkits: ['googlecalendar'] });
  const cal = evaluateAutoApprove({ sessionId: 's-tk1', toolName: 'composio_execute_tool', args: { tool_slug: 'GOOGLECALENDAR_CREATE_EVENT', arguments: { attendees: [{ email: 'x@breakthroughcoaching.ai' }] } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(cal.autoApproved, true, 'calendar send matches the googlecalendar-scoped grant');
  const mail = evaluateAutoApprove({ sessionId: 's-tk2', toolName: 'composio_execute_tool', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@breakthroughcoaching.ai' } }, scope: 'yolo', insideWorkspace: false, kindHint: 'send' });
  assert.equal(mail.autoApproved, false, 'a gmail send does NOT match a googlecalendar-only grant');
});

test('send-trust: kill-switch off disables all matching', () => {
  const prev = process.env.CLEMMY_SEND_TRUST;
  grantSendTrust({ domains: ['breakthroughcoaching.ai'] });
  process.env.CLEMMY_SEND_TRUST = 'off';
  try {
    assert.equal(matchesSendTrust('composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@breakthroughcoaching.ai' } }), false, 'kill-switch off → nothing matches');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_SEND_TRUST; else process.env.CLEMMY_SEND_TRUST = prev;
  }
});

test('send-trust: extractSendTargets finds emails anywhere and handles under recipient keys', () => {
  const t = extractSendTargets({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'A@Foo.com', body: 'cc bob@bar.io in the notes' } });
  assert.deepEqual(t.emails.sort(), ['a@foo.com', 'bob@bar.io'], 'lowercased, deduped, found even inside a body string (over-extraction is fail-safe)');
  const s = extractSendTargets({ tool_slug: 'SLACK_SEND_MESSAGE', arguments: { channel: '#general' } });
  assert.deepEqual(s.handles, ['#general']);
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

test('a send EXPLICITLY named in allowedTools auto-approves; a wildcard scope does NOT (send lock, 2026-07-09)', () => {
  // A send named in allowedTools is explicit human review → auto-approves.
  openPlanScope({
    sessionId: 'sess-tb', planProposalId: 'plan-tb', approvedPlanObjective: 'time-boxed',
    allowedTools: ['GMAIL_SEND_EMAIL'],
  });
  assert.equal(isAutoApprovedByScope('sess-tb', 'GMAIL_SEND_EMAIL', undefined, 'send'), true, 'explicit send tool auto-approves');
  // A WILDCARD scope must NOT auto-approve an un-enumerated send (the
  // workflow/background bypass, Hole 2).
  openPlanScope({
    sessionId: 'sess-wild', planProposalId: 'plan-wild', approvedPlanObjective: 'wildcard',
    allowedTools: ['*'],
  });
  assert.equal(isAutoApprovedByScope('sess-wild', 'GMAIL_SEND_EMAIL', undefined, 'send'), false, 'wildcard scope never waves an un-enumerated send');
  // A wildcard scope still auto-approves a reversible WRITE (unchanged).
  assert.equal(isAutoApprovedByScope('sess-wild', 'GOOGLESHEETS_VALUES_UPDATE', undefined, 'other'), true, 'wildcard still covers reversible writes');
});

// ─── B2: standing grants ─────────────────────────────────────────────────────

test('a standing grant auto-approves a write tool with no session scope, and revoke ends it', () => {
  assert.equal(isAutoApprovedByScope(undefined, 'write_file'), false, 'no grant yet');
  const grant = grantStandingApproval('write_file', { kind: 'write', note: 'trusted' });
  assert.ok(grant);
  assert.equal(isStandingGranted('write_file'), true);
  // Session-independent: auto-approves even with no plan scope on the session.
  assert.equal(isAutoApprovedByScope('sess-none', 'write_file'), true);
  assert.equal(listStandingGrants().length, 1);

  assert.equal(revokeStandingApproval('write_file'), true);
  assert.equal(isStandingGranted('write_file'), false);
  assert.equal(isAutoApprovedByScope('sess-none', 'write_file'), false, 'revoked grant no longer auto-approves');
  assert.equal(listStandingGrants().length, 0);
});

test('send and admin kinds can NEVER be granted (side-effect law at write time)', () => {
  assert.equal(grantStandingApproval('GMAIL_SEND_EMAIL', { kind: 'send' }), null, 'send refused');
  assert.equal(grantStandingApproval('delete_account', { kind: 'admin' }), null, 'admin refused');
  assert.equal(isStandingGranted('GMAIL_SEND_EMAIL'), false);
  // Even if a send tool were somehow granted, the kindHint guard blocks it.
  grantStandingApproval('write_file', { kind: 'write' });
  assert.equal(isAutoApprovedByScope('s', 'write_file', undefined, 'send'), false, 'a send call never rides a grant');
  revokeStandingApproval('write_file');
});

test('arbitrary-capability MULTIPLEXERS can NEVER be granted (granting them grants all they reach)', () => {
  // These classify as `execute`/`write` (not send/admin) so the kind refusal
  // alone let them through — granting `run_shell_command` once would standing-
  // auto-approve EVERY shell command (curl POST, sendmail, rm) forever.
  for (const tool of [
    'run_shell_command', 'composio_execute_tool', 'local_cli_run',
    'mcp__kernel__exec_command', 'mcp__plugin_playwright_playwright__browser_run_code_unsafe',
  ]) {
    assert.equal(grantStandingApproval(tool, { kind: 'execute' }), null, `${tool} must be refused`);
    assert.equal(isStandingGranted(tool), false, `${tool} not granted`);
  }
  // A specific, non-multiplexer write tool is STILL grantable (the legit case).
  assert.ok(grantStandingApproval('write_file', { kind: 'write' }), 'write_file still grantable');
  revokeStandingApproval('write_file');
});

test('CLEMMY_STANDING_GRANTS=off makes grants inert', () => {
  grantStandingApproval('write_file', { kind: 'write' });
  process.env.CLEMMY_STANDING_GRANTS = 'off';
  try {
    assert.equal(isStandingGranted('write_file'), false);
    assert.equal(isAutoApprovedByScope('s', 'write_file'), false);
  } finally {
    delete process.env.CLEMMY_STANDING_GRANTS;
    revokeStandingApproval('write_file');
  }
});
