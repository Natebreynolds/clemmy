/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/semantic-boundary/frozen-catalog-selected-advisory.red.test.ts
 *
 * OPEN-THE-GATES Slice 3. G14 refused a selected capability the live factory
 * no longer held — live seq 95141, "selected capability … is absent from the
 * current host catalog". That gap is host-internal (readiness recompute,
 * collateral eviction, definition-successor id). The write seam re-proves.
 *
 * Unselected mismatches stay dropped. Selected mismatches annotate and admit.
 *
 * Re-break two ways:
 *   (i)  treat selected-absent as a plan refusal (old G14)
 *   (ii) treat selected shape-change as a plan refusal (old G14)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import { selectedFrozenCatalogDispositionFor } from './admit-and-compile-accepted-source.js';

const ADMIT = new URL('./admit-and-compile-accepted-source.ts', import.meta.url);

function descriptor(
  id: string,
  purpose = 'fixture',
): HostCapabilityDescriptorV1 {
  return {
    id,
    effect: 'external_write',
    purpose,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
    inputShape: 'evidence',
    outputShape: 'evidence',
    outputKind: 'evidence',
    deliverableKind: 'google_spreadsheet',
    destinationPosture: 'create_new',
    evidenceKinds: ['tool_result'],
    handleRequired: true,
    readbackRequired: true,
    accountScope: 'runtime',
    manifestDigest: id.replace(/[^a-f0-9]/g, 'a').padEnd(64, '0').slice(0, 64),
  };
}

test('NEGATIVE: a selected capability missing from the frozen catalog is kept, not refused', () => {
  const disclosed = descriptor('cap:resolved:googlesheets_create_google_sheet1');
  assert.equal(
    selectedFrozenCatalogDispositionFor(true, undefined, disclosed),
    'keep_disclosed',
  );
  assert.equal(
    selectedFrozenCatalogDispositionFor(false, undefined, disclosed),
    'drop_unselected',
  );
});

test('NEGATIVE: a selected capability whose shape drifted is kept with an advisory', () => {
  const disclosed = descriptor('cap:resolved:googlesheets_create_google_sheet1', 'create');
  const current = descriptor('cap:resolved:googlesheets_create_google_sheet1', 'create google spreadsheet');
  assert.equal(
    selectedFrozenCatalogDispositionFor(true, current, disclosed),
    'keep_current_advisory',
  );
  assert.equal(
    selectedFrozenCatalogDispositionFor(false, current, disclosed),
    'drop_unselected',
  );
  assert.equal(
    selectedFrozenCatalogDispositionFor(true, disclosed, disclosed),
    'keep_current',
  );
});

test('re-break (i): the old G14 selected-absent branch was a plan refusal', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /reason: 'primary model planning catalog no longer matches the frozen host catalog'\s*\+\s*` \(selected capability "\$\{descriptor\.id\}" is absent from the current host catalog/,
    'selected-absent must not refuse the plan',
  );
  assert.match(
    src,
    /absent_from_current_host_catalog/,
    'the host must name the selected-absent advisory',
  );
});

test('re-break (ii): the old G14 selected-shape-change branch was a plan refusal', () => {
  const src = readFileSync(ADMIT, 'utf8');
  assert.doesNotMatch(
    src,
    /reason: 'primary model planning catalog no longer matches the frozen host catalog'\s*\+\s*` \(selected capability "\$\{descriptor\.id\}" changed shape between disclosure and/,
    'selected shape-change must not refuse the plan',
  );
  assert.match(
    src,
    /changed_shape_between_disclosure_and_admission/,
    'the host must name the selected-shape advisory',
  );
});
