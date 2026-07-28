/**
 * Run: npx tsx --test src/execution/workflow-goal-evidence.test.ts
 *
 * The evidence projector must rank keys by SHAPE (proof / identity / metric
 * classes), never by one workflow's field names — it serves every user's
 * domain (CRM, invoicing, logistics, research) equally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactWorkflowGoalEvidence, countNonEmptyLines, workflowGoalEvidenceProjection } from './workflow-goal-evidence.js';

test('proof-shaped keys survive key pressure in any domain vocabulary', () => {
  const filler = Object.fromEntries(
    Array.from({ length: 35 }, (_, index) => [`providerField${index + 1}`, `value-${index + 1}`]),
  );
  // An invoicing workflow — vocabulary that appears in no enumerated list.
  const invoicing = workflowGoalEvidenceProjection({
    ...filler,
    reconciliationError: null,
    paymentVerified: true,
    ledgerUnchanged: true,
  }) as Record<string, unknown>;
  assert.equal(invoicing.paymentVerified, true, 'verification proof must outrank filler regardless of domain');
  assert.equal(invoicing.ledgerUnchanged, true, 'read-back/protection proof must outrank filler');
  assert.ok('reconciliationError' in invoicing, 'error fields are proof in every domain');

  // A logistics workflow: identity-shaped keys (ids, numbers, rows) rank
  // above filler so items stay traceable.
  const logistics = workflowGoalEvidenceProjection({
    ...filler,
    shipmentId: 'shp-1',
    trackingNumber: 'TRK-9',
    manifestRowNumbers: [3, 4],
  }) as Record<string, unknown>;
  assert.equal(logistics.shipmentId, 'shp-1');
  assert.equal(logistics.trackingNumber, 'TRK-9');
  assert.ok('manifestRowNumbers' in logistics);
});

test('camelCase and snake_case shapes rank identically', () => {
  const filler = Object.fromEntries(
    Array.from({ length: 35 }, (_, index) => [`extra${index + 1}`, index]),
  );
  const camel = workflowGoalEvidenceProjection({ ...filler, verifiedCount: 2 }) as Record<string, unknown>;
  const snake = workflowGoalEvidenceProjection({ ...filler, verified_count: 2 }) as Record<string, unknown>;
  assert.equal(camel.verifiedCount, 2);
  assert.equal(snake.verified_count, 2);
});

test('arrays project to count + bounded sample; long strings keep head and tail', () => {
  const projected = workflowGoalEvidenceProjection({
    rows: Array.from({ length: 40 }, (_, index) => ({ rowNumber: index + 1 })),
    tags: ['a', 'b', 'c', 'd', 'e'],
    providerDetail: `head ${'x'.repeat(400)} tail-marker`,
  }) as Record<string, unknown>;
  assert.deepEqual((projected.rows as Record<string, unknown>).count, 40);
  assert.equal(((projected.rows as { sample: unknown[] }).sample).length, 1);
  assert.deepEqual((projected.tags as { count: number; first: string[] }).first, ['a', 'b', 'c']);
  const detail = String(projected.providerDetail);
  assert.ok(detail.startsWith('head '), 'long string keeps its head');
  assert.ok(detail.endsWith('tail-marker'), 'long string keeps its tail');
});

test('compactWorkflowGoalEvidence bounds output while preserving both ends', () => {
  const text = compactWorkflowGoalEvidence(
    {
      first: 'alpha-start',
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`mid${index + 1}`, 'y'.repeat(100)])),
      last: 'omega-end',
    },
    600,
  );
  assert.ok(text.length <= 600);
  assert.match(text, /alpha-start/);
  assert.match(text, /omega-end/);
  assert.match(text, /\[bounded evidence\]/);
});

test('countNonEmptyLines ignores blank lines', () => {
  assert.equal(countNonEmptyLines('a\n\n  \nb\r\nc'), 3);
});
