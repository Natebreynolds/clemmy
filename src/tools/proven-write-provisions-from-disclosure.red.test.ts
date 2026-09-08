/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/tools/proven-write-provisions-from-disclosure.red.test.ts
 *
 * LIVE MISS, 2026-09-05 18:36 UTC, owner's phone, real accounts.
 * "Put these three drafts in my Outlook drafts folder."
 *   tool_search disclosed OUTLOOK_CREATE_DRAFT and rendered a copyable
 *     work_call example for it
 *   work_call OUTLOOK_CREATE_DRAFT (effect external_write) x2
 *   refused catalog_entry_or_manifest_missing:candidates=0:proven=none
 *   18 further tool_search calls, then the no-progress floor
 *
 * The host held the complete definition for that operation the whole time —
 * input schema, output schema, operation version, a live provider observation.
 * What it did not hold was a CALLABLE catalog entry, because
 * stageDisclosedPlanningProviderCandidates registered only the proven READS
 * and left every proven WRITE staged-but-unusable until a plan_task ran.
 *
 * Owner's decision the same day: a proven write provisions itself exactly like
 * a proven read. Consent does not move — the effect gate still runs at the
 * write boundary, the crossing still reopens the live definition against the
 * current manifest, account, schema and port, and an irreversible send still
 * asks. What changes is that "I disclosed it and then called it absent" stops
 * being a reachable state.
 *
 * Re-break: filter the provisioning set back to reads at that call site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./tool-search-provider-sources.ts', import.meta.url)),
  'utf8',
);

test('disclosure provisions a proven write, not only a proven read', () => {
  const staging = SOURCE.slice(
    SOURCE.indexOf('export async function stageDisclosedPlanningProviderCandidates'),
    SOURCE.indexOf('/** Nominations are bounded hard'),
  );
  assert.ok(staging.length > 0, 'the staging function must be locatable');

  assert.ok(
    !/allowedIdentifiers: provenReads/.test(staging),
    'the provisioning set is no longer narrowed to reads',
  );
  assert.match(
    staging,
    /effectClass === 'read' \|\| proof\?\.effectClass === 'write'/,
    'both proven effect classes reach registerProofProvisionedCapabilities',
  );
  assert.ok(
    !/Writes remain staging-only until plan_task/.test(SOURCE),
    'the retired rule must not survive in the contract docstring',
  );

  // The narrowing that must stay: only candidates the visible result actually
  // returned, and only ones this turn PROVED. A disclosure is not a proof.
  assert.match(staging, /const proof = entries\.get\(`composio:\$\{candidate\.name\.trim\(\)\.toLowerCase\(\)\}`\)/);
  assert.match(staging, /publicationGuard: \(\) => discoveryStillActive\(publicationGuard\)/);
  assert.match(staging, /deadlineAt: input\.deadlineAt === undefined \? undefined : input\.deadlineAt - 500/,
    'publication keeps its bounded deadline reserve rather than outliving the visible result');
});
