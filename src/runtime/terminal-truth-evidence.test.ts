/**
 * Terminal truth must read EVIDENCE, not booleans.
 *
 * The first adjudicator synthesised what it was auditing: it turned a satisfied
 * flag into `writeReceipt: {satisfied: true}`, an empty `sourceIdentities: []`
 * that trivially passes accounting, and a `readBackMatches` derived from the
 * same flag that claimed verification. That is circular — the audited layer
 * sets a boolean and the auditor believes it — and it can return `done` with no
 * evidence of anything.
 *
 * Every test here is written to FAIL against that adjudicator.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-terminal-evidence-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-evidence\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const terminal = await import('./harness/terminal-truth.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `terminal-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `${label} task` },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

// ── T1. A claimed read-back with no comparison is not verification ───────────

test('T1: readBackPerformed:true with readBackMatches:undefined cannot yield done', () => {
  const verdict = terminal.adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['r1'],
    committedIdentities: ['r1'],
    writeReceipt: { successful: true },
    readBackPerformed: true,
    // Never compared. "I looked" is not "it matched".
    readBackMatches: undefined,
    staleRowsFound: 0,
    staleRowsReconciled: true,
    activeExecutions: 0,
  });
  assert.notEqual(verdict.status, 'done', 'an uncompared read-back is not verification');
  assert.ok(verdict.missing.includes('exact_read_back'));
});

// ── T2. Applicable obligations cannot be skipped by omission ─────────────────

test('T2: omitted stale-target inspection cannot yield done when that obligation applies', () => {
  const verdict = terminal.adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['r1'],
    committedIdentities: ['r1'],
    writeReceipt: { successful: true },
    readBackPerformed: true,
    readBackMatches: true,
    // Never inspected — not "inspected and found none".
    staleRowsFound: undefined,
    staleRowsReconciled: undefined,
    activeExecutions: 0,
    applicableObligations: ['stale_destination_reconciled'],
  } as never);
  assert.notEqual(verdict.status, 'done', 'never looking is not the same as finding nothing');
  assert.ok(verdict.missing.includes('stale_destination_reconciled'));
});

test('T3: omitted derivation provenance cannot yield done', () => {
  const verdict = terminal.adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['r1'],
    committedIdentities: ['r1'],
    writeReceipt: { successful: true },
    readBackPerformed: true,
    readBackMatches: true,
    staleRowsFound: 0,
    staleRowsReconciled: true,
    activeExecutions: 0,
    applicableObligations: ['derivation_from_current_source'],
    derivationProvenance: undefined,
  } as never);
  assert.notEqual(
    verdict.status,
    'done',
    'output that cannot be traced to this run may have come from a previous artifact',
  );
  assert.ok(verdict.missing.includes('derivation_from_current_source'));
});

// ── T4. A satisfied flag without redeemable evidence is not evidence ─────────

test('T4: a satisfied requirement without a redeemable evidence reference cannot yield done', async () => {
  const key = acceptedTask('unredeemable');
  const requirements = await import('./harness/requirement-graph.js') as Record<string, unknown>;
  const satisfyWithEvidence = requirements.satisfyRequirementWithEvidence as
    ((input: Record<string, unknown>) => boolean) | undefined;
  assert.ok(
    satisfyWithEvidence,
    'satisfaction must carry an evidence reference; a bare boolean is the thing being audited',
  );

  const verdict = await terminal.adjudicateTerminalForTask({
    sessionId: key.sessionId,
    sourceUserSeq: key.sourceUserSeq,
  });
  assert.notEqual(
    verdict.status,
    'done',
    'a satisfaction whose evidence cannot be redeemed proves nothing',
  );
});

// ── T5. Executions belong to exactly one accepted source ─────────────────────

test('T5: another turn\'s execution neither blocks nor satisfies this turn', async () => {
  const mine = acceptedTask('exec-mine');
  const theirs = eventlog.appendEvent({
    sessionId: mine.sessionId, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'a different accepted request in the same conversation' },
  });

  const { ExecutionStore } = await import('../execution/store.js');
  const store = new ExecutionStore();
  store.create({
    sessionId: mine.sessionId,
    sourceUserSeq: theirs.seq,
    title: 'belongs to the other turn',
    objective: 'unrelated',
    reason: 'test',
    startedFromMessage: 'the other request',
    confidence: 1,
    reasons: ['test fixture'],
  });

  const verdict = await terminal.adjudicateTerminalForTask({
    sessionId: mine.sessionId,
    sourceUserSeq: mine.sourceUserSeq,
  });
  assert.ok(
    !verdict.missing.includes('execution_terminal'),
    'an execution owned by a DIFFERENT accepted source must not block this one — '
    + 'getActiveForSession cannot tell them apart',
  );
});

// ── T6. Unreadable stores fail closed ────────────────────────────────────────

test('T6: unreadable evidence stores cannot yield done', async () => {
  const verdict = await terminal.adjudicateTerminalForTask({
    sessionId: 'session-that-does-not-exist',
    sourceUserSeq: 999_999,
  });
  assert.notEqual(
    verdict.status,
    'done',
    'absent evidence is not satisfied evidence',
  );
});

// ── T7. Irreversible sends owe receipt evidence, not cell read-back ──────────

test('T7: an irreversible send is verified by receipt, never by spreadsheet-style read-back', () => {
  const verdict = terminal.adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['msg-1'],
    committedIdentities: ['msg-1'],
    writeReceipt: { successful: true, receiptId: 'rcpt-1' },
    // No read-back: you cannot re-read a sent message.
    readBackPerformed: undefined,
    readBackMatches: undefined,
    activeExecutions: 0,
    applicableObligations: ['commit_effect', 'verify_committed_receipt'],
    effectReversibility: 'irreversible',
    durableReceiptRef: 'receipt:rcpt-1',
  } as never);
  assert.equal(
    verdict.status,
    'done',
    `an irreversible send with a durable receipt is verified; demanding a read-back would block it forever `
    + `(missing: ${verdict.missing.join(', ')})`,
  );

  const noReceipt = terminal.adjudicateTerminal({
    sourceCompleteness: 'complete',
    sourceIdentities: ['msg-1'],
    committedIdentities: ['msg-1'],
    writeReceipt: { successful: true },
    activeExecutions: 0,
    applicableObligations: ['commit_effect', 'verify_committed_receipt'],
    effectReversibility: 'irreversible',
    durableReceiptRef: undefined,
  } as never);
  assert.notEqual(noReceipt.status, 'done', 'and without a durable receipt it is unverified');
});
