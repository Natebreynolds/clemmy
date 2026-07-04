/**
 * RSH-5 — fix-memory store: signature, pending→confirm→recall, discard.
 * Per-test temp home via CLEMENTINE_HOME (BINDING) — set BEFORE any src import.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fix-memory-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  fixSignature, recordPendingFix, confirmPendingFix, discardPendingFix, recallConfirmedFix,
} = await import('./workflow-fix-memory-store.js');

test('fixSignature: same failure class → same signature; different class → different', () => {
  // differ only in numbers / dates / quoted hex ids — all normalized away
  const a = fixSignature('The query returned 0 rows at 2026-07-04, id "a1b2c3d4".');
  const b = fixSignature('The query returned 42 rows at 2026-07-05, id "f9e8d7c6".');
  assert.equal(a, b, 'numbers/dates/quotes/hex-ids normalized away → same class matches');
  assert.notEqual(a, fixSignature('The Salesforce connection is expired.'));
});

test('lifecycle: pending → confirm → recall; a different signature does not match', () => {
  const entry = {
    workflowSlug: 'daily', stepId: 'gather', signature: fixSignature('query returned nothing'),
    fixKind: 'edit_step', fixDescription: 'name the sf CLI', fix: { newStepPrompt: 'use sf' },
  };
  recordPendingFix('run-1', entry);
  // not recallable until confirmed
  assert.equal(recallConfirmedFix('daily', 'gather', entry.signature), null);

  const promoted = confirmPendingFix('run-1', '2026-07-04T00:00:00Z');
  assert.ok(promoted);
  const recalled = recallConfirmedFix('daily', 'gather', entry.signature);
  assert.ok(recalled);
  assert.equal(recalled!.fixKind, 'edit_step');
  assert.deepEqual(recalled!.fix, { newStepPrompt: 'use sf' });

  // wrong step / wrong signature → no match
  assert.equal(recallConfirmedFix('daily', 'other', entry.signature), null);
  assert.equal(recallConfirmedFix('daily', 'gather', fixSignature('different failure')), null);
});

test('discard: a fix that did not stick is forgotten, never recallable', () => {
  const sig = fixSignature('flaky binding');
  recordPendingFix('run-bad', { workflowSlug: 'w', stepId: 's', signature: sig, fixKind: 'edit_binding', fixDescription: 'x', fix: {} });
  discardPendingFix('run-bad');
  assert.equal(confirmPendingFix('run-bad', '2026-07-04T00:00:00Z'), null, 'nothing left to confirm');
  assert.equal(recallConfirmedFix('w', 's', sig), null);
});

test('confirmPendingFix on an unknown run is a no-op', () => {
  assert.equal(confirmPendingFix('nope', '2026-07-04T00:00:00Z'), null);
});
