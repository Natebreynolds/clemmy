/**
 * Run: npx tsx --test src/runtime/graph/admission-envelope.test.ts
 *
 * The no-ambient-policy contract, pinned. An envelope is sealed at admission
 * and immutable; capability growth is a monotonic, narrowing-only revision
 * within the admitted universe; and needing more than the envelope admits is
 * a typed pause-and-readmit, never an in-place widening.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendBindings,
  initialBindingRevision,
  sealAdmissionEnvelope,
  validateRevisionChain,
  type AdmissionEnvelopeInput,
  type CapabilityBindingRevision,
} from './admission-envelope.js';

const INPUT: AdmissionEnvelopeInput = {
  attemptId: 'attempt-1',
  tenant: 'local',
  workspace: 'sales',
  policyHash: 'policy-a',
  effectCeiling: 'write',
  capabilities: [
    { name: 'GOOGLESHEETS_BATCH_UPDATE', schemaFingerprint: 'sha-1', effectClass: 'write', accountIdentity: 'user@example.com' },
    { name: 'GOOGLESHEETS_VALUES_GET', schemaFingerprint: 'sha-2', effectClass: 'read', accountIdentity: 'user@example.com' },
    { name: 'tool_search', schemaFingerprint: 'sha-3', effectClass: 'read', accountIdentity: '' },
  ],
  budget: { maxUncachedTokens: 100_000, maxModelCalls: 20, maxToolCalls: 40, maxElapsedMs: 300_000 },
};

function sealed(over: Partial<AdmissionEnvelopeInput> = {}) {
  const result = sealAdmissionEnvelope({ ...INPUT, ...over });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).envelope;
}

// ── sealing ──────────────────────────────────────────────────────────────────

test('an envelope cannot contain its own violation', () => {
  const overCeiling = sealAdmissionEnvelope({
    ...INPUT,
    effectCeiling: 'read',
  });
  assert.equal(overCeiling.ok, false, 'a write capability was admitted under a read ceiling');

  const schemaless = sealAdmissionEnvelope({
    ...INPUT,
    capabilities: [{ name: 'x', schemaFingerprint: '', effectClass: 'read', accountIdentity: '' }],
  });
  assert.equal(schemaless.ok, false, 'a capability without a co-travelling schema was admitted');

  const rotating = sealAdmissionEnvelope({
    ...INPUT,
    capabilities: [{ name: 'x', schemaFingerprint: 's', effectClass: 'read', accountIdentity: 'ca_rotates' }],
  });
  assert.equal(rotating.ok, false, 'a rotating connection id was admitted as account identity');

  const infinite = sealAdmissionEnvelope({
    ...INPUT,
    budget: { ...INPUT.budget, maxModelCalls: Number.POSITIVE_INFINITY },
  });
  assert.equal(infinite.ok, false, 'an infinite budget was sealed');
});

test('the digest is content identity — construction order is not', () => {
  const forward = sealed();
  const reversed = sealed({ capabilities: [...INPUT.capabilities].reverse() });
  assert.equal(forward.envelopeDigest, reversed.envelopeDigest,
    'capability construction order changed the authority identity');
  const different = sealed({ policyHash: 'policy-b' });
  assert.notEqual(forward.envelopeDigest, different.envelopeDigest);
  assert.ok(Object.isFrozen(forward), 'the sealed envelope is mutable');
});

// ── monotonic revisions ──────────────────────────────────────────────────────

test('revisions are append-only and every earlier binding survives', () => {
  const envelope = sealed();
  const first = initialBindingRevision(envelope, ['tool_search']);
  assert.equal(first.ok, true);
  const r1 = (first as Extract<typeof first, { ok: true }>).revision;
  assert.equal(r1.revision, 1);

  const second = appendBindings(envelope, r1, ['GOOGLESHEETS_VALUES_GET', 'tool_search']);
  assert.equal(second.ok, true);
  const r2 = (second as Extract<typeof second, { ok: true }>).revision;
  assert.equal(r2.revision, 2);
  assert.deepEqual([...r2.bound], ['tool_search', 'GOOGLESHEETS_VALUES_GET'],
    'monotonicity broke: earlier bindings must remain a strict prefix');

  const chain = validateRevisionChain(envelope, [r1, r2]);
  assert.equal(chain.ok, true, JSON.stringify(chain));
});

test('naming a capability outside the universe is a typed re-admission, not a widening', () => {
  const envelope = sealed();
  const result = appendBindings(envelope, null, ['SALESFORCE_SOQL_QUERY', 'tool_search']);
  assert.equal(result.ok, false);
  const refusal = result as Extract<typeof result, { ok: false }>;
  assert.equal(refusal.kind, 'requires_readmission');
  assert.deepEqual((refusal as Extract<typeof refusal, { kind: 'requires_readmission' }>).outside,
    ['SALESFORCE_SOQL_QUERY'], 'the pause is not actionable without the exact outsiders named');
});

test('a revision from another envelope is refused', () => {
  const envelope = sealed();
  const other = sealed({ attemptId: 'attempt-2' });
  const first = initialBindingRevision(other, ['tool_search']);
  const foreign = (first as Extract<typeof first, { ok: true }>).revision;
  const result = appendBindings(envelope, foreign, ['GOOGLESHEETS_VALUES_GET']);
  assert.equal(result.ok, false);
  assert.equal((result as Extract<typeof result, { ok: false }>).kind, 'invalid');
});

// ── chain validation for replay ──────────────────────────────────────────────

test('a tampered chain refuses: reorders, renumbering, and forged digests', () => {
  const envelope = sealed();
  const r1 = (initialBindingRevision(envelope, ['tool_search']) as { ok: true; revision: CapabilityBindingRevision }).revision;
  const r2 = (appendBindings(envelope, r1, ['GOOGLESHEETS_VALUES_GET']) as { ok: true; revision: CapabilityBindingRevision }).revision;

  const reordered: CapabilityBindingRevision = {
    ...r2,
    bound: [...r2.bound].reverse(),
  };
  const dropped = validateRevisionChain(envelope, [r1, reordered]);
  assert.equal(dropped.ok, false, 'a reordered chain validated');

  const renumbered = validateRevisionChain(envelope, [r1, { ...r2, revision: 5 }]);
  assert.equal(renumbered.ok, false, 'a gap in revision numbering validated');

  const forged = validateRevisionChain(envelope, [r1, { ...r2, revisionDigest: 'f'.repeat(64) }]);
  assert.equal(forged.ok, false, 'a forged revision digest validated');

  assert.equal(validateRevisionChain(envelope, [r1, r2]).ok, true);
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the envelope module reaches nothing but crypto', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'admission-envelope.ts'), 'utf-8');
  const imports = [...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:crypto']);
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'new Date', 'Math.random', 'BASE_DIR']) {
    assert.equal(source.includes(forbidden), false, `envelope module references ${forbidden}`);
  }
});
