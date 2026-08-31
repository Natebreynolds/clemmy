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
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const notifications = await import('../runtime/notifications.js');
const { createSession, openEventLog } = await import('../runtime/harness/eventlog.js');
const { listTrustProposals, approveTrustProposal, declineTrustProposal, tickTrustGraduation,
  collectCleanSends, deriveTrustCandidates } = tg;

const NOW = Date.parse('2026-07-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SCOPES_FILE = path.join(TMP_HOME, 'state', 'plan-scopes.json');
const STORE_FILE = path.join(TMP_HOME, 'state', 'trust-graduation-proposals.json');
const TRUST_GRADUATION_MODULE_URL = new URL('./trust-graduation.ts', import.meta.url).href;

type ResolutionAction = 'approve' | 'decline';
interface ChildResolutionResult {
  reason?: string;
  proposalStatus?: string;
  grantId?: string;
  error?: string;
}

const RESOLUTION_CHILD_CODE = String.raw`
  import { existsSync, writeFileSync } from 'node:fs';
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const mod = await import(process.env.CLEM_TRUST_GRADUATION_MODULE_URL);
  writeFileSync(process.env.CLEM_TRUST_RESOLUTION_READY, 'ready', 'utf-8');
  while (!existsSync(process.env.CLEM_TRUST_RESOLUTION_START)) Atomics.wait(wait, 0, 0, 10);
  try {
    const proposal = mod.getTrustProposal(process.env.CLEM_TRUST_PROPOSAL_ID);
    const expectedScope = proposal ? {
      scopeRevision: proposal.scopeRevision,
      scopeDigest: proposal.scopeDigest,
    } : undefined;
    const result = process.env.CLEM_TRUST_RESOLUTION_ACTION === 'approve'
      ? mod.approveTrustProposal(
          process.env.CLEM_TRUST_PROPOSAL_ID,
          process.env.CLEM_TRUST_RESOLVED_BY,
          expectedScope,
          new Date(process.env.CLEM_TRUST_RESOLUTION_NOW),
        )
      : mod.declineTrustProposal(
          process.env.CLEM_TRUST_PROPOSAL_ID,
          process.env.CLEM_TRUST_RESOLVED_BY,
          expectedScope,
          new Date(process.env.CLEM_TRUST_RESOLUTION_NOW),
        );
    writeFileSync(process.env.CLEM_TRUST_RESOLUTION_RESULT, JSON.stringify({
      reason: result.reason,
      proposalStatus: result.proposal?.status,
      grantId: result.grantId,
    }), 'utf-8');
  } catch (error) {
    writeFileSync(process.env.CLEM_TRUST_RESOLUTION_RESULT, JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }), 'utf-8');
  }
`;

const MIGRATION_READ_CHILD_CODE = String.raw`
  import { writeFileSync } from 'node:fs';
  const mod = await import(process.env.CLEM_TRUST_GRADUATION_MODULE_URL);
  writeFileSync(
    process.env.CLEM_TRUST_MIGRATION_RESULT,
    JSON.stringify(mod.listTrustProposals()),
    'utf-8',
  );
`;

function launchResolutionChild(input: {
  action: ResolutionAction;
  proposalId: string;
  resolvedBy: string;
  readyFile: string;
  startFile: string;
  resultFile: string;
}): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', RESOLUTION_CHILD_CODE], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEMENTINE_TEST_TRUST_RESOLUTION_PAUSE_MS: '200',
      CLEM_TRUST_GRADUATION_MODULE_URL: TRUST_GRADUATION_MODULE_URL,
      CLEM_TRUST_PROPOSAL_ID: input.proposalId,
      CLEM_TRUST_RESOLUTION_ACTION: input.action,
      CLEM_TRUST_RESOLVED_BY: input.resolvedBy,
      CLEM_TRUST_RESOLUTION_NOW: new Date(NOW).toISOString(),
      CLEM_TRUST_RESOLUTION_READY: input.readyFile,
      CLEM_TRUST_RESOLUTION_START: input.startFile,
      CLEM_TRUST_RESOLUTION_RESULT: input.resultFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function collectResolutionChild(
  child: ChildProcess,
  resultFile: string,
): Promise<ChildResolutionResult> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null];
  assert.equal(code, 0, `child failed\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.equal(existsSync(resultFile), true, `child wrote no result\nstdout: ${stdout}\nstderr: ${stderr}`);
  return JSON.parse(readFileSync(resultFile, 'utf-8')) as ChildResolutionResult;
}

async function raceTrustResolutions(
  proposalId: string,
  firstAction: ResolutionAction,
  secondAction: ResolutionAction,
): Promise<ChildResolutionResult[]> {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startFile = path.join(TMP_HOME, `trust-resolution-${nonce}.start`);
  const childInputs = [firstAction, secondAction].map((action, index) => ({
    action,
    proposalId,
    resolvedBy: `race-${action}-${index}`,
    readyFile: path.join(TMP_HOME, `trust-resolution-${nonce}-${index}.ready`),
    startFile,
    resultFile: path.join(TMP_HOME, `trust-resolution-${nonce}-${index}.json`),
  }));
  const children = childInputs.map(launchResolutionChild);
  try {
    await Promise.all(childInputs.map((input) => waitForFile(input.readyFile)));
    writeFileSync(startFile, 'go', 'utf-8');
    return await Promise.all(children.map((child, index) => (
      collectResolutionChild(child, childInputs[index].resultFile)
    )));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

function readTrustProposalsInFreshProcess(resultFile: string): Array<Record<string, unknown>> {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', MIGRATION_READ_CHILD_CODE],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        CLEMMY_TEST_ISOLATED_HOME: '1',
        CLEM_TRUST_GRADUATION_MODULE_URL: TRUST_GRADUATION_MODULE_URL,
        CLEM_TRUST_MIGRATION_RESULT: resultFile,
      },
      encoding: 'utf-8',
    },
  );
  assert.equal(
    child.status,
    0,
    `migration child failed\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
  );
  assert.equal(existsSync(resultFile), true, 'migration child wrote no result');
  return JSON.parse(readFileSync(resultFile, 'utf-8')) as Array<Record<string, unknown>>;
}

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

function scopeExpectation(proposal: { scopeRevision: number; scopeDigest: string }) {
  return {
    scopeRevision: proposal.scopeRevision,
    scopeDigest: proposal.scopeDigest,
  };
}

function rewritePendingProposal(
  proposalId: string,
  rewrite: (proposal: Record<string, unknown>) => void = () => {},
): Record<string, unknown> {
  return rewriteStoredProposal(proposalId, (proposal) => {
    delete proposal.scopeRevision;
    delete proposal.scopeDigest;
    rewrite(proposal);
  });
}

function rewriteStoredProposal(
  proposalId: string,
  rewrite: (proposal: Record<string, unknown>) => void,
): Record<string, unknown> {
  const store = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as {
    proposals: Array<Record<string, unknown>>;
  };
  const proposal = store.proposals.find((row) => row.id === proposalId);
  assert.ok(proposal);
  rewrite(proposal);
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  return proposal;
}

function assertReceiptQuarantined(proposalId: string, reason: RegExp): void {
  assert.equal(
    listTrustProposals('pending').some((proposal) => proposal.id === proposalId),
    false,
    'pending projections must not expose the malformed receipt',
  );
  const terminal = tg.getTrustProposal(proposalId);
  assert.ok(terminal);
  assert.equal(terminal.status, 'superseded');
  assert.match(terminal.resolvedReason ?? '', reason);
  assert.equal(planScope.listSendTrustGrants().length, 0, 'quarantine must never mint authority');
  assert.equal(
    notifications.getNotification(`trust-proposal-${proposalId}`)?.read,
    true,
    'the terminal migration path must retire the stable Needs You carrier',
  );
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
    pending.markPendingActionApprovalResolved(pa.id, 'approved', row.approvalId);
    const claim = pending.claimPendingActionExecution(pa.id, 'trust-graduation-fixture');
    assert.equal(claim.claimed, true);
    assert.ok(claim.claimToken);
    pending.recordPendingActionResult(
      pa.id,
      action,
      action === 'executed' ? 'sent' : 'bounced',
      'trust-graduation-fixture',
      claim.claimToken,
    );
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
  const result = approveTrustProposal(p.id, 'test', scopeExpectation(p), new Date(NOW));
  assert.equal(result.reason, 'approved');
  assert.ok(result.grantId);
  const grants = planScope.listSendTrustGrants();
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].recipients, ['x@acme.com']);
  assert.deepEqual(grants[0].toolkits, ['gmail_send_email']);
  assert.equal(listTrustProposals('approved').length, 1);
  assert.equal(result.scopeReceipt?.scopeRevision, 1);
  assert.equal(result.scopeReceipt?.scopeDigest, p.scopeDigest);
  assert.deepEqual(result.scopeReceipt?.recipients, ['x@acme.com']);
  assert.equal(
    notifications.getNotification(`trust-proposal-${p.id}`)?.read,
    true,
    'the central terminal authority should clear the stable needs-you carrier',
  );
});

test('proposal scope receipt binds every authority-bearing field shown for review', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  assert.equal(proposal.scopeRevision, 1);
  assert.match(proposal.scopeDigest, /^sha256:[0-9a-f]{64}$/);
  const receipt = tg.trustProposalScopeReceipt(proposal);
  assert.equal(receipt.scopeDigest, proposal.scopeDigest);
  assert.deepEqual(receipt, {
    scopeRevision: 1,
    scopeDigest: proposal.scopeDigest,
    toolkits: ['gmail_send_email'],
    recipients: ['x@acme.com'],
    domains: [],
    maxRecipients: 1,
  });
});

test('legacy pending scope is canonically sealed once and stays byte-stable across restarts', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const preserved = {
    id: proposal.id,
    status: proposal.status,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    createdAt: proposal.createdAt,
    resolvedAt: proposal.resolvedAt,
  };
  rewritePendingProposal(proposal.id, (row) => {
    row.toolkits = [' GMAIL_SEND_EMAIL ', 'gmail_send_email'];
    row.recipients = [' X@ACME.COM ', 'x@acme.com'];
    row.domains = [];
  });

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstRows = readTrustProposalsInFreshProcess(
    path.join(TMP_HOME, `trust-migration-${nonce}-first.json`),
  );
  const migrated = firstRows.find((row) => row.id === proposal.id);
  assert.ok(migrated);
  assert.deepEqual({
    id: migrated.id,
    status: migrated.status,
    evidence: migrated.evidence,
    rationale: migrated.rationale,
    createdAt: migrated.createdAt,
    resolvedAt: migrated.resolvedAt,
  }, preserved);
  assert.deepEqual(migrated.toolkits, ['gmail_send_email']);
  assert.deepEqual(migrated.recipients, ['x@acme.com']);
  assert.equal(migrated.domains, undefined);
  assert.equal(migrated.scopeRevision, 1);
  assert.match(String(migrated.scopeDigest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(planScope.listSendTrustGrants().length, 0, 'migration must never create authority');

  const firstGeneration = readFileSync(STORE_FILE, 'utf-8');
  const secondRows = readTrustProposalsInFreshProcess(
    path.join(TMP_HOME, `trust-migration-${nonce}-second.json`),
  );
  assert.deepEqual(secondRows, firstRows);
  assert.equal(readFileSync(STORE_FILE, 'utf-8'), firstGeneration, 'second boot must be a fixed point');
});

test('approve accepts the exact receipt surfaced from a migrated legacy pending proposal', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const original = listTrustProposals('pending')[0];
  rewritePendingProposal(original.id);

  const migrated = tg.getTrustProposal(original.id);
  assert.ok(migrated);
  assert.equal(migrated.status, 'pending');
  assert.equal(migrated.scopeRevision, 1);
  assert.match(migrated.scopeDigest, /^sha256:[0-9a-f]{64}$/);
  const result = approveTrustProposal(
    migrated.id,
    'legacy-upgrade-approver',
    scopeExpectation(migrated),
    new Date(NOW),
  );
  assert.equal(result.reason, 'approved');
  assert.equal(result.scopeReceipt?.scopeDigest, migrated.scopeDigest);
  assert.equal(planScope.listSendTrustGrants().length, 1);
  assert.deepEqual(planScope.listSendTrustGrants()[0].recipients, ['x@acme.com']);
});

test('decline accepts the exact receipt surfaced from a migrated legacy pending proposal', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const original = listTrustProposals('pending')[0];
  rewritePendingProposal(original.id);

  const migrated = tg.getTrustProposal(original.id);
  assert.ok(migrated);
  const result = declineTrustProposal(
    migrated.id,
    'legacy-upgrade-decliner',
    scopeExpectation(migrated),
    new Date(NOW),
  );
  assert.equal(result.reason, 'declined');
  assert.equal(result.scopeReceipt?.scopeDigest, migrated.scopeDigest);
  assert.equal(planScope.listSendTrustGrants().length, 0);
  assert.equal(tg.getTrustProposal(original.id)?.status, 'declined');
});

test('tampered or malformed legacy pending scopes are quarantined without authority', () => {
  seedGraduatedRecipient('x@acme.com', 'GMAIL_SEND_EMAIL');
  seedGraduatedRecipient('y@acme.com', 'OUTLOOK_SEND_EMAIL');
  tickTrustGraduation(new Date(NOW));
  const proposals = listTrustProposals('pending');
  assert.equal(proposals.length, 2);
  const evidenceById = new Map(proposals.map((proposal) => [proposal.id, proposal.evidence]));
  rewritePendingProposal(proposals[0].id, (row) => {
    row.recipients = ['attacker@example.com'];
  });
  rewritePendingProposal(proposals[1].id, (row) => {
    row.maxRecipients = planScope.SEND_TRUST_MAX_RECIPIENTS + 1;
  });

  const rows = listTrustProposals();
  assert.equal(rows.filter((row) => row.status === 'pending').length, 0);
  assert.equal(rows.filter((row) => row.status === 'superseded').length, 2);
  assert.equal(planScope.listSendTrustGrants().length, 0);
  for (const row of rows) {
    assert.deepEqual(row.evidence, evidenceById.get(row.id));
    assert.match(row.resolvedReason ?? '', /legacy proposal quarantined/);
    assert.equal(row.scopeRevision, 1);
    assert.match(row.scopeDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(tg.trustProposalScopeReceipt(row).scopeDigest, row.scopeDigest);
    assert.equal(notifications.getNotification(`trust-proposal-${row.id}`)?.read, true);
  }
});

test('receipt-bearing pending scope with revision 2 is terminally quarantined before projection', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  rewriteStoredProposal(proposal.id, (row) => {
    row.scopeRevision = 2;
  });

  assertReceiptQuarantined(proposal.id, /unsupported scope revision 2/);
});

test('receipt-bearing pending scope with a malformed digest is terminally quarantined', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  rewriteStoredProposal(proposal.id, (row) => {
    row.scopeDigest = 'sha256:not-a-digest';
  });

  assertReceiptQuarantined(proposal.id, /scope digest is malformed/);
});

test('receipt-bearing pending scope whose stored fields are not canonical is terminally quarantined', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  rewriteStoredProposal(proposal.id, (row) => {
    // These values normalize to the original digest. They must still fail: a
    // receipt-bearing generation is immutable, not an invitation to normalize
    // rewritten authority in place.
    row.recipients = [' X@ACME.COM ', 'x@acme.com'];
  });

  assertReceiptQuarantined(proposal.id, /scope fields are not in canonical form/);
});

test('receipt-bearing pending scope whose valid digest disagrees with its scope is terminally quarantined', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  rewriteStoredProposal(proposal.id, (row) => {
    row.scopeDigest = `sha256:${'0'.repeat(64)}`;
  });

  assertReceiptQuarantined(proposal.id, /scope digest does not match the canonical scope/);
});

test('malformed receipt quarantine is byte-stable in a second process', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  rewriteStoredProposal(proposal.id, (row) => {
    row.scopeRevision = 2;
  });

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstRows = readTrustProposalsInFreshProcess(
    path.join(TMP_HOME, `trust-malformed-receipt-${nonce}-first.json`),
  );
  const first = firstRows.find((row) => row.id === proposal.id);
  assert.ok(first);
  assert.equal(first.status, 'superseded');
  assert.match(String(first.resolvedReason), /unsupported scope revision 2/);
  assert.equal(planScope.listSendTrustGrants().length, 0);
  assert.equal(notifications.getNotification(`trust-proposal-${proposal.id}`)?.read, true);

  const firstGeneration = readFileSync(STORE_FILE, 'utf-8');
  const secondRows = readTrustProposalsInFreshProcess(
    path.join(TMP_HOME, `trust-malformed-receipt-${nonce}-second.json`),
  );
  assert.deepEqual(secondRows, firstRows);
  assert.equal(
    readFileSync(STORE_FILE, 'utf-8'),
    firstGeneration,
    'a second process must observe the terminal fixed point without rewriting it',
  );
  assert.equal(planScope.listSendTrustGrants().length, 0);
});

test('stale presented scope digest is refused without resolving or granting', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const result = approveTrustProposal(proposal.id, 'stale-client', {
    scopeRevision: proposal.scopeRevision,
    scopeDigest: `sha256:${'0'.repeat(64)}`,
  }, new Date(NOW));
  assert.equal(result.reason, 'scope-mismatch');
  assert.equal(result.ok, false);
  assert.equal(tg.getTrustProposal(proposal.id)?.status, 'pending');
  assert.equal(planScope.listSendTrustGrants().length, 0);
  assert.equal(result.scopeReceipt?.scopeDigest, proposal.scopeDigest);
});

test('ID-only resolution fails closed once a proposal has a scope receipt', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const result = approveTrustProposal(proposal.id, 'id-only-client', new Date(NOW));
  assert.equal(result.reason, 'scope-mismatch');
  assert.equal(tg.getTrustProposal(proposal.id)?.status, 'pending');
  assert.equal(planScope.listSendTrustGrants().length, 0);
});

test('in-place proposal scope rewrite is terminally refused even without a client expectation', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const store = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as { proposals: Array<Record<string, unknown>> };
  const stored = store.proposals.find((row) => row.id === proposal.id);
  assert.ok(stored);
  stored.recipients = ['attacker@example.com'];
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');

  const result = approveTrustProposal(proposal.id, 'tamper-test', scopeExpectation(proposal), new Date(NOW));
  assert.equal(result.reason, 'scope-mismatch');
  assert.equal(result.proposal?.status, 'superseded');
  assert.equal(planScope.listSendTrustGrants().length, 0);
});

test('approve-time expiry refuses a stale pending proposal without creating authority', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const result = approveTrustProposal(
    proposal.id,
    'late-click',
    scopeExpectation(proposal),
    new Date(NOW + 15 * DAY),
  );
  assert.equal(result.reason, 'expired');
  assert.equal(result.proposal?.status, 'expired');
  assert.equal(planScope.listSendTrustGrants().length, 0);
});

test('decline-time expiry records expiry, not a misleading fresh decline', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const result = declineTrustProposal(
    proposal.id,
    'late-click',
    scopeExpectation(proposal),
    new Date(NOW + 15 * DAY),
  );
  assert.equal(result.reason, 'expired');
  assert.equal(result.proposal?.status, 'expired');
  assert.equal(planScope.listSendTrustGrants().length, 0);
});

test('decline: grants nothing and blocks a subset re-proposal during cooldown', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const p = listTrustProposals('pending')[0];
  const result = declineTrustProposal(p.id, 'test', scopeExpectation(p), new Date(NOW));
  assert.equal(result.reason, 'declined');
  assert.equal(planScope.listSendTrustGrants().length, 0);
  assert.equal(notifications.getNotification(`trust-proposal-${p.id}`)?.read, true);
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
  const result = approveTrustProposal(p.id, 'test', scopeExpectation(p), new Date(NOW));
  assert.equal(result.reason, 'superseded');
  assert.equal(planScope.listSendTrustGrants().length, 1, 'no second grant created');
});

test('approve recovers a proposal-correlated grant committed before the proposal terminal write', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const firstHalf = planScope.grantSendTrustForProposal(proposal.id, {
    recipients: proposal.recipients,
    domains: proposal.domains,
    toolkits: proposal.toolkits,
    maxRecipients: proposal.maxRecipients,
    note: `simulated first half for ${proposal.id}`,
  });
  assert.equal(firstHalf.status, 'granted');
  if (firstHalf.status !== 'granted') return;

  const result = approveTrustProposal(
    proposal.id,
    'recovery-test',
    scopeExpectation(proposal),
    new Date(NOW),
  );
  assert.equal(result.reason, 'approved');
  assert.equal(result.grantId, firstHalf.grant.id);
  assert.match(result.proposal?.resolvedReason ?? '', /recovered committed grant/);
  assert.equal(planScope.listSendTrustGrants().length, 1, 'recovery must reuse, never duplicate, the grant');
});

test('decline cannot overwrite an approval whose exact grant already committed', () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const approvedAt = new Date(NOW + 1_000).toISOString();
  const firstHalf = planScope.grantSendTrustForProposal(proposal.id, {
    recipients: proposal.recipients,
    domains: proposal.domains,
    toolkits: proposal.toolkits,
    maxRecipients: proposal.maxRecipients,
  }, {
    resolvedBy: 'original-approver',
    resolvedAt: approvedAt,
  });
  assert.equal(firstHalf.status, 'granted');

  const result = declineTrustProposal(proposal.id, 'late-decliner');
  assert.equal(result.reason, 'not-pending');
  assert.equal(result.proposal?.status, 'approved');
  assert.equal(result.proposal?.resolvedBy, 'original-approver');
  assert.equal(result.proposal?.resolvedAt, approvedAt);
  assert.equal(planScope.listSendTrustGrants().length, 1);
});

test('cross-process approve-v-approve has one grant and one truthful terminal winner', async () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const results = await raceTrustResolutions(proposal.id, 'approve', 'approve');
  assert.equal(results.every((result) => result.error === undefined), true);
  assert.deepEqual(results.map((result) => result.reason).sort(), ['approved', 'not-pending']);
  assert.equal(results.find((result) => result.reason === 'not-pending')?.proposalStatus, 'approved');
  const grants = planScope.listSendTrustGrants();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].sourceProposalId, proposal.id);
  assert.equal(listTrustProposals('approved').length, 1);
  assert.equal(notifications.getNotification(`trust-proposal-${proposal.id}`)?.read, true);
});

test('cross-process approve-v-decline commits exactly the first terminal decision', async () => {
  seedGraduatedRecipient('x@acme.com');
  tickTrustGraduation(new Date(NOW));
  const proposal = listTrustProposals('pending')[0];
  const [approveResult, declineResult] = await raceTrustResolutions(proposal.id, 'approve', 'decline');
  assert.equal(approveResult.error, undefined);
  assert.equal(declineResult.error, undefined);
  assert.equal(
    [approveResult.reason, declineResult.reason].filter((reason) => reason === 'not-pending').length,
    1,
  );

  const final = listTrustProposals().find((row) => row.id === proposal.id);
  assert.ok(final);
  if (approveResult.reason === 'approved') {
    assert.equal(declineResult.reason, 'not-pending');
    assert.equal(declineResult.proposalStatus, 'approved');
    assert.equal(final.status, 'approved');
    assert.equal(planScope.listSendTrustGrants().length, 1);
  } else {
    assert.equal(approveResult.reason, 'not-pending');
    assert.equal(approveResult.proposalStatus, 'declined');
    assert.equal(declineResult.reason, 'declined');
    assert.equal(final.status, 'declined');
    assert.equal(planScope.listSendTrustGrants().length, 0);
  }
  assert.equal(notifications.getNotification(`trust-proposal-${proposal.id}`)?.read, true);
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
  assert.equal(notifications.getNotification(`trust-proposal-${p.id}`)?.read, true);
});
