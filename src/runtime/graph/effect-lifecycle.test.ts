/**
 * Run: npx tsx --test src/runtime/graph/effect-lifecycle.test.ts
 *
 * The Stage 6 crash-window matrix, decided from the ledger alone. Each test
 * plants the ledger a crash at one lifecycle phase would leave behind and
 * pins the ONLY lawful resume decision — with blind redispatch structurally
 * absent from the ambiguous state's exits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvalAuthorizes,
  computeEffectIdentity,
  decideEffectResume,
  validateEffectTransition,
  type EffectIdentityInput,
  type EffectLedgerRow,
} from './effect-lifecycle.js';

const IDENTITY: EffectIdentityInput = {
  admissionDigest: 'adm-1',
  provider: 'googlesheets',
  operation: 'append_row',
  effectClass: 'write',
  accountIdentity: 'user@example.com',
  recipientKey: 'spreadsheet:abc123',
  argumentsDigest: 'args-digest-1',
};

function row(phase: EffectLedgerRow['phase'], ref?: string): EffectLedgerRow {
  return { effectId: 'ef_x', phase, at: '2026-08-04T00:00:00Z', ...(ref ? { ref } : {}) };
}

// ── identity ─────────────────────────────────────────────────────────────────

test('one effect, one key; any material difference diverges', () => {
  const base = computeEffectIdentity(IDENTITY);
  assert.equal(computeEffectIdentity({ ...IDENTITY }), base);
  for (const [field, value] of [
    ['accountIdentity', 'other@example.com'],
    ['recipientKey', 'spreadsheet:def456'],
    ['argumentsDigest', 'args-digest-2'],
    ['admissionDigest', 'adm-2'],
    ['operation', 'update_row'],
  ] as const) {
    assert.notEqual(computeEffectIdentity({ ...IDENTITY, [field]: value }), base,
      `changing ${field} did not change the effect identity`);
  }
  assert.throws(() => computeEffectIdentity({ ...IDENTITY, accountIdentity: 'ca_rotating' }),
    /rotating connection id/);
});

// ── lifecycle lawfulness ─────────────────────────────────────────────────────

test('the lifecycle advances one phase at a time and terminals are terminal', () => {
  assert.equal(validateEffectTransition(null, 'reserved').ok, true);
  assert.equal(validateEffectTransition(null, 'committed').ok, false, 'an effect began mid-life');
  assert.equal(validateEffectTransition('reserved', 'dispatch_started').ok, true);
  assert.equal(validateEffectTransition('dispatch_started', 'committed').ok, false,
    'a commit appeared without a receipt');
  assert.equal(validateEffectTransition('provider_receipt', 'checkpointed').ok, false,
    'a checkpoint appeared before commit — the charter rule');
  assert.equal(validateEffectTransition('reserved', 'released').ok, true);
  assert.equal(validateEffectTransition('dispatch_started', 'released').ok, false,
    'a started dispatch was released as though it never ran');
  assert.equal(validateEffectTransition('checkpointed', 'dispatch_started').ok, false);
  assert.equal(validateEffectTransition('refused', 'reserved').ok, false);
});

// ── the crash-window matrix ──────────────────────────────────────────────────

test('crash after reservation: the reservation is this attempt to use', () => {
  assert.deepEqual(decideEffectResume([row('reserved')]), { action: 'dispatch' });
});

test('crash after dispatch, before receipt: OBSERVE — never redispatch', () => {
  const decision = decideEffectResume([row('reserved'), row('dispatch_started')]);
  assert.equal(decision.action, 'observe', 'the ambiguous window did not demand observation');
  // The structural claim: the decision type for this state has no dispatch arm.
  assert.notEqual(decision.action, 'dispatch' as never,
    'a started write with no receipt was offered for redispatch');
});

test('crash after receipt, before commit: finish the local half, no redispatch', () => {
  const decision = decideEffectResume([
    row('reserved'), row('dispatch_started'), row('provider_receipt', 'rcpt-9'),
  ]);
  assert.deepEqual(decision, { action: 'complete_commit', receiptRef: 'rcpt-9' });
});

test('a receipt row without a reference cannot prove the write: stop', () => {
  const decision = decideEffectResume([
    row('reserved'), row('dispatch_started'), row('provider_receipt'),
  ]);
  assert.equal(decision.action, 'stop');
});

test('settled effects replay free; refused and released may dispatch anew', () => {
  const fullChain = [
    row('reserved'), row('dispatch_started'), row('provider_receipt', 'r'),
    row('observed'), row('committed'), row('checkpointed'),
  ];
  for (const terminal of ['observed', 'committed', 'checkpointed'] as const) {
    const upTo = fullChain.slice(0, fullChain.findIndex((r) => r.phase === terminal) + 1);
    assert.deepEqual(decideEffectResume(upTo), { action: 'settled', phase: terminal });
  }
  assert.deepEqual(decideEffectResume([row('refused')]), { action: 'dispatch' });
  assert.deepEqual(decideEffectResume([row('reserved'), row('released')]), { action: 'dispatch' });
  assert.deepEqual(decideEffectResume([]), { action: 'dispatch' });
});

test('an unlawful ledger is a stop, never a guess', () => {
  const decision = decideEffectResume([row('reserved'), row('committed')]);
  assert.equal(decision.action, 'stop');
  assert.match((decision as Extract<typeof decision, { action: 'stop' }>).reason, /not lawful/);
});

// ── approvals ────────────────────────────────────────────────────────────────

test('an approval authorizes exactly one effect identity, once', () => {
  const effectId = computeEffectIdentity(IDENTITY);
  const approval = { approvalId: 'apr-1', effectId };

  assert.equal(approvalAuthorizes(approval, effectId, 'attempt-1').ok, true);

  // The content changed after approval — different digest, no authority.
  const changed = computeEffectIdentity({ ...IDENTITY, recipientKey: 'spreadsheet:OTHER' });
  const wrongTarget = approvalAuthorizes(approval, changed, 'attempt-1');
  assert.equal(wrongTarget.ok, false);
  assert.match((wrongTarget as Extract<typeof wrongTarget, { ok: false }>).reason, /content changed/);

  const consumed = approvalAuthorizes(
    { ...approval, consumedByAttemptId: 'attempt-1' }, effectId, 'attempt-2',
  );
  assert.equal(consumed.ok, false, 'a consumed approval authorized a second attempt');
  // The consuming attempt itself may re-verify (idempotent within the attempt).
  assert.equal(approvalAuthorizes(
    { ...approval, consumedByAttemptId: 'attempt-1' }, effectId, 'attempt-1',
  ).ok, true);
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the contract reaches nothing but crypto', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'effect-lifecycle.ts'), 'utf-8');
  assert.deepEqual([...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]), ['node:crypto']);
  for (const forbidden of ['Date.now', 'new Date', 'process.env', 'Math.random', 'readFileSync', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `contract references ${forbidden}`);
  }
});
