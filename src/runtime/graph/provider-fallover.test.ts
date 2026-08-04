/**
 * Run: npx tsx --test src/runtime/graph/provider-fallover.test.ts
 *
 * The Stage 8 invariant as pins: brain fallover never duplicates an external
 * write, and work identity across brains is digests, never target text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { EffectLedgerRow } from './effect-lifecycle.js';
import {
  decideOutputReuse,
  decideProviderFallover,
  workIdentityMatches,
  type WorkIdentity,
} from './provider-fallover.js';

function row(phase: EffectLedgerRow['phase'], ref?: string): EffectLedgerRow {
  return { effectId: 'ef', phase, at: '2026-08-04T00:00:00Z', ...(ref ? { ref } : {}) };
}

const SETTLED = [row('reserved'), row('dispatch_started'), row('provider_receipt', 'r'), row('observed'), row('committed')];
const AMBIGUOUS = [row('reserved'), row('dispatch_started')];

// ── fallover ─────────────────────────────────────────────────────────────────

test('a turn with settled and never-dispatched effects may fall over', () => {
  assert.deepEqual(decideProviderFallover({}), { action: 'fallover_allowed' });
  assert.deepEqual(decideProviderFallover({
    'ef-a': SETTLED,
    'ef-b': [row('reserved')],
    'ef-c': [row('refused')],
  }), { action: 'fallover_allowed' });
});

test('one ambiguous write holds fallover for observation — the duplicate-send gate', () => {
  const decision = decideProviderFallover({
    'ef-settled': SETTLED,
    'ef-ambiguous': AMBIGUOUS,
  });
  assert.equal(decision.action, 'observe_first');
  assert.deepEqual(
    (decision as Extract<typeof decision, { action: 'observe_first' }>).effectIds,
    ['ef-ambiguous'],
    'the ambiguous effect was not the one named',
  );
});

test('a receipt without local commit also holds fallover until reconciled', () => {
  const decision = decideProviderFallover({
    'ef-half': [row('reserved'), row('dispatch_started'), row('provider_receipt', 'rcpt')],
  });
  assert.equal(decision.action, 'observe_first',
    'a provider-committed, locally-uncommitted write was treated as a free pass');
});

test('an unlawful ledger blocks fallover entirely — no brain may guess', () => {
  const decision = decideProviderFallover({
    'ef-good': SETTLED,
    'ef-corrupt': [row('reserved'), row('committed')],
  });
  assert.equal(decision.action, 'blocked');
  assert.match(
    (decision as Extract<typeof decision, { action: 'blocked' }>).reasons[0]!,
    /ef-corrupt/,
  );
});

// ── work identity ────────────────────────────────────────────────────────────

const WORK: WorkIdentity = { admissionDigest: 'adm', nodeDigest: 'node', inputDigest: 'input' };

test('work identity is three digests, and the producing brain is not one of them', () => {
  assert.equal(workIdentityMatches(WORK, { ...WORK }), true);
  for (const key of ['admissionDigest', 'nodeDigest', 'inputDigest'] as const) {
    assert.equal(workIdentityMatches(WORK, { ...WORK, [key]: 'changed' }), false,
      `a ${key} change did not break work identity`);
  }
});

test('reuse requires identity AND an artifact; mismatch names what diverged', () => {
  assert.deepEqual(
    decideOutputReuse({ prior: { ...WORK, outputRef: 'art-1' }, current: WORK }),
    { action: 'reuse', outputRef: 'art-1' },
  );

  const noArtifact = decideOutputReuse({ prior: { ...WORK }, current: WORK });
  assert.equal(noArtifact.action, 'rerun', 'an identity match with no artifact was reused');

  const diverged = decideOutputReuse({
    prior: { ...WORK, inputDigest: 'old-input', outputRef: 'art-1' },
    current: WORK,
  });
  assert.equal(diverged.action, 'rerun');
  assert.match((diverged as Extract<typeof diverged, { action: 'rerun' }>).reason, /inputDigest/);
});

test('target text is structurally absent from reuse — the false-green class', () => {
  // The contract's input type has no field for target/topic text at all, so
  // "same target" reuse is unrepresentable rather than discouraged. This pin
  // guards the SHAPE: if someone adds a text field to WorkIdentity, this
  // enumeration breaks and the review conversation happens here.
  assert.deepEqual(Object.keys(WORK).sort(), ['admissionDigest', 'inputDigest', 'nodeDigest']);
});

// ── purity ───────────────────────────────────────────────────────────────────

test('the contract imports only its effect sibling', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'provider-fallover.ts'), 'utf-8');
  assert.deepEqual(
    [...source.matchAll(/^import (?!type ).*?from '([^']+)';$/gms)].map((m) => m[1]),
    ['./effect-lifecycle.js'],
  );
  // Provider names may appear in comments EXPLAINING the defect class they
  // prevent; they may never appear in control flow. Strip comments, then
  // check the code that remains.
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['Date.now', 'new Date', 'process.env', 'Math.random', 'fetch(', 'claude', 'codex', 'anthropic', 'openai', 'byo']) {
    assert.equal(codeOnly.toLowerCase().includes(forbidden.toLowerCase()), false,
      `provider-neutral contract CODE references ${forbidden}`);
  }
});
