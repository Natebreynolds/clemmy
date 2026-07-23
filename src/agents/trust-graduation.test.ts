/**
 * Run: npx tsx --test src/agents/trust-graduation.test.ts
 *
 * Two layers:
 *   - Pure scope derivation (deriveTrustCandidates over synthetic clean sends):
 *     threshold, distinct-day, exact-vs-domain, public-domain denylist.
 *   - Integration over a tmp CLEMENTINE_HOME eventlog: the clean-send predicate
 *     (executed/failed/rejected/settle) and the proposal lifecycle
 *     (dedupe/cooldown/cap/approve/decline/coverage/kill-switch).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-trustgrad-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const tg = await import('./trust-graduation.js');
const planScope = await import('./plan-scope.js');
const reg = await import('../runtime/harness/approval-registry.js');
const pending = await import('../runtime/harness/pending-actions.js');
const { createSession, openEventLog } = await import('../runtime/harness/eventlog.js');
const { listTrustProposals, approveTrustProposal, declineTrustProposal, tickTrustGraduation,
  collectCleanSends, deriveTrustCandidates } = tg;

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SCOPES_FILE = path.join(TMP_HOME, 'state', 'plan-scopes.json');
const STORE_FILE = path.join(TMP_HOME, 'state', 'trust-graduation-proposals.json');

beforeEach(() => {
  openEventLog().prepare('DELETE FROM pending_approvals').run();
  rmSync(path.join(TMP_HOME, 'pending-actions'), { recursive: true, force: true });
  rmSync(SCOPES_FILE, { force: true });
  rmSync(STORE_FILE, { force: true });
  delete process.env.CLEMMY_TRUST_GRADUATION;
  delete process.env.CLEMMY_SEND_TRUST;
});

// ── Seed helpers ─────────────────────────────────────────────────────

function ob(approvalId: string, toolkit: string, recipients: string[], resolvedAtMs: number) {
  return { approvalId, toolkit, recipients, resolvedAt: new Date(resolvedAtMs).toISOString() };
}

/** Seed one resolved approval (default: a clean, executed Gmail send). Returns
 *  the approvalId. Backdates the resolution so the settle window can pass. */
function seedSend(opts: {
  slug?: string;
  recipients: string[];
  resolvedAtMs: number;
  resolution?: 'approved' | 'rejected';
  resolver?: string;
  action?: 'executed' | 'failed' | 'none';
}): string {
  const slug = opts.slug ?? 'GMAIL_SEND_EMAIL';
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: `send to ${opts.recipients.join(', ')}`,
    tool: 'composio_execute_tool',
    args: { tool_slug: slug, arguments: { recipient_email: opts.recipients } },
  });
  reg.resolve(row.approvalId, opts.resolution ?? 'approved', opts.resolver ?? 'desktop');
  openEventLog()
    .prepare('UPDATE pending_approvals SET resolved_at = ?, requested_at = ? WHERE approval_id = ?')
    .run(new Date(opts.resolvedAtMs).toISOString(), new Date(opts.resolvedAtMs).toISOString(), row.approvalId);
  const action = opts.action ?? 'executed';
  if (action !== 'none') {
    const pa = pending.queuePendingAction({
      title: 'send', summary: 'send', kind: 'external_send',
      toolName: 'composio_execute_tool', payload: { tool_slug: slug },
    });
    pending.linkPendingActionApproval(pa.id, row.approvalId);
    pending.recordPendingActionResult(pa.id, action, action === 'executed' ? 'sent' : 'bounced');
  }
  return row.approvalId;
}

/** Five clean sends to one recipient across two days — the canonical "graduated"
 *  pattern (3 on day A, 2 on day B). */
function seedGraduatedRecipient(recipient: string, slug = 'GMAIL_SEND_EMAIL'): void {
  for (let i = 0; i < 3; i++) seedSend({ slug, recipients: [recipient], resolvedAtMs: NOW - 4 * DAY - i * 1000 });
  for (let i = 0; i < 2; i++) seedSend({ slug, recipients: [recipient], resolvedAtMs: NOW - 3 * DAY - i * 1000 });
}

// ── Pure scope derivation ────────────────────────────────────────────

test('derive: 5 clean sends to one recipient over 2 days ⇒ exact-recipient candidate', () => {
  const obs = [
    ...[0, 1, 2].map((i) => ob(`a${i}`, 'gmail_send_email', ['x@acme.com'], NOW - 4 * DAY - i)),
    ...[0, 1].map((i) => ob(`b${i}`, 'gmail_send_email', ['x@acme.com'], NOW - 3 * DAY - i)),
  ];
  const [c] = deriveTrustCandidates(obs, new Date(NOW));
  assert.ok(c, 'expected a candidate');
  assert.deepEqual(c.recipients, ['x@acme.com']);
  assert.deepEqual(c.domains, []);
  assert.equal(c.evidence.cleanSendCount, 5);
  assert.equal(c.evidence.distinctDays, 2);
});

test('derive: 4 clean sends ⇒ below threshold, no candidate', () => {
  const obs = [0, 1, 2, 3].map((i) => ob(`a${i}`, 'gmail_send_email', ['x@acme.com'], NOW - (4 - (i % 2)) * DAY - i));
  assert.equal(deriveTrustCandidates(obs, new Date(NOW)).length, 0);
});

test('derive: 5 sends in a single burst-day ⇒ no candidate (needs 2 distinct days)', () => {
  const obs = [0, 1, 2, 3, 4].map((i) => ob(`a${i}`, 'gmail_send_email', ['x@acme.com'], NOW - 3 * DAY - i));
  assert.equal(deriveTrustCandidates(obs, new Date(NOW)).length, 0);
});

test('derive: recipient seen only twice is not stable ⇒ no candidate', () => {
  const obs = [
    ob('a', 'gmail_send_email', ['x@acme.com'], NOW - 4 * DAY),
    ob('b', 'gmail_send_email', ['x@acme.com'], NOW - 3 * DAY),
    ob('c', 'gmail_send_email', ['y@acme.com'], NOW - 4 * DAY),
    ob('d', 'gmail_send_email', ['z@acme.com'], NOW - 3 * DAY),
    ob('e', 'gmail_send_email', ['w@acme.com'], NOW - 2 * DAY),
  ];
  assert.equal(deriveTrustCandidates(obs, new Date(NOW)).length, 0);
});

test('derive: ≥4 distinct stable recipients on a private domain ⇒ domain escalation', () => {
  const people = ['a@acme.com', 'b@acme.com', 'c@acme.com', 'd@acme.com'];
  const obs: ReturnType<typeof ob>[] = [];
  people.forEach((p, pi) => {
    for (let i = 0; i < 3; i++) obs.push(ob(`${pi}-${i}`, 'gmail_send_email', [p], NOW - (4 - (i % 2)) * DAY - i));
  });
  const [c] = deriveTrustCandidates(obs, new Date(NOW));
  assert.ok(c);
  assert.deepEqual(c.domains, ['acme.com']);
  assert.deepEqual(c.recipients, [], 'domain-covered recipients drop from the exact list');
});

test('derive: public mail domain never escalates even with 4 distinct recipients', () => {
  const people = ['a@gmail.com', 'b@gmail.com', 'c@gmail.com', 'd@gmail.com'];
  const obs: ReturnType<typeof ob>[] = [];
  people.forEach((p, pi) => {
    for (let i = 0; i < 3; i++) obs.push(ob(`${pi}-${i}`, 'gmail_send_email', [p], NOW - (4 - (i % 2)) * DAY - i));
  });
  const [c] = deriveTrustCandidates(obs, new Date(NOW));
  assert.ok(c);
  assert.deepEqual(c.domains, []);
  assert.deepEqual(c.recipients.sort(), people.sort());
});

// ── Clean-send predicate (integration) ───────────────────────────────

test('collectCleanSends: approved + executed + settled ⇒ clean', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 3 * DAY });
  const clean = collectCleanSends(new Date(NOW));
  assert.equal(clean.length, 1);
  assert.equal(clean[0].toolkit, 'gmail_send_email');
  assert.deepEqual(clean[0].recipients, ['x@acme.com']);
});

test('collectCleanSends: unsettled (within 24h) ⇒ not yet clean', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 1000 });
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

test('collectCleanSends: linked action failed ⇒ not clean', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 3 * DAY, action: 'failed' });
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

test('collectCleanSends: rejected approval ⇒ not counted', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 3 * DAY, resolution: 'rejected', action: 'none' });
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

test('collectCleanSends: reaper-resolved ⇒ not counted (not a human decision)', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 3 * DAY, resolver: 'reaper' });
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

test('collectCleanSends: later intersecting rejection disqualifies the earlier clean send', () => {
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 4 * DAY });
  seedSend({ recipients: ['x@acme.com'], resolvedAtMs: NOW - 2 * DAY, resolution: 'rejected', action: 'none' });
  // The approved one predates the rejection to the same recipient → disqualified.
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

test('collectCleanSends: non-send (reversible) approval ⇒ not counted', () => {
  seedSend({ slug: 'GOOGLESHEETS_VALUES_UPDATE', recipients: ['x@acme.com'], resolvedAtMs: NOW - 3 * DAY });
  assert.equal(collectCleanSends(new Date(NOW)).length, 0);
});

// ── Proposal lifecycle ───────────────────────────────────────────────

test('tick: graduated recipient ⇒ one pending proposal with exact scope', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const pendingProps = listTrustProposals('pending');
  assert.equal(pendingProps.length, 1);
  assert.deepEqual(pendingProps[0].recipients, ['x@acme.com']);
  assert.deepEqual(pendingProps[0].toolkits, ['gmail_send_email']);
});

test('tick: dedupes — a second tick does not add a duplicate pending', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 1);
});

test('tick: global cap of 2 pending is respected', () => {
  seedGraduatedRecipient('x@acme.com', 'GMAIL_SEND_EMAIL');
  seedGraduatedRecipient('y@acme.com', 'OUTLOOK_SEND_EMAIL');
  seedGraduatedRecipient('z@acme.com', 'SLACK_SEND_MESSAGE');
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 2);
});

test('tick: skips when an existing grant already covers the scope', () => {
  planScope.grantSendTrust({ recipients: ['x@acme.com'], toolkits: ['gmail_send_email'] });
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 0);
});

test('tick: kill-switch off ⇒ no proposals', () => {
  process.env.CLEMMY_TRUST_GRADUATION = 'off';
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 0);
});

test('tick: send-trust off ⇒ no proposals (nothing to grant)', () => {
  process.env.CLEMMY_SEND_TRUST = 'off';
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 0);
});

test('approve: grants exactly the proposed scope and marks approved', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const p = listTrustProposals('pending')[0];
  const result = approveTrustProposal(p.id, 'test');
  assert.equal(result.reason, 'approved');
  assert.ok(result.grantId);
  const grants = planScope.listSendTrustGrants();
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].recipients, ['x@acme.com']);
  assert.deepEqual(grants[0].toolkits, ['gmail_send_email']);
  assert.equal(listTrustProposals('approved').length, 1);
});

test('decline: grants nothing and blocks a subset re-proposal during cooldown', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const p = listTrustProposals('pending')[0];
  const result = declineTrustProposal(p.id, 'test');
  assert.equal(result.reason, 'declined');
  assert.equal(planScope.listSendTrustGrants().length, 0);
  // A re-tick must not re-propose the same (declined) scope within cooldown.
  tickTrustGraduation(new Date(NOW));
  assert.equal(listTrustProposals('pending').length, 0);
});

test('approve after coverage appeared ⇒ superseded, no double grant', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const p = listTrustProposals('pending')[0];
  // A covering grant lands before the user clicks approve.
  planScope.grantSendTrust({ recipients: ['x@acme.com'], toolkits: ['gmail_send_email'] });
  const result = approveTrustProposal(p.id, 'test');
  assert.equal(result.reason, 'superseded');
  assert.equal(planScope.listSendTrustGrants().length, 1, 'no second grant created');
});

test('pending older than 14 days expires on the next tick', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const p = listTrustProposals('pending')[0];
  assert.ok(p);
  // 40 days later the evidence has aged out of the 30-day window AND the pending
  // crosses the 14-day expiry — so it expires and is not re-proposed.
  tickTrustGraduation(new Date(NOW + 40 * DAY));
  assert.equal(listTrustProposals('pending').length, 0);
  assert.equal(listTrustProposals('expired').length, 1);
});
