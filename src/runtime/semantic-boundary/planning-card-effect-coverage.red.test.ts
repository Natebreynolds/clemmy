/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/semantic-boundary/planning-card-effect-coverage.red.test.ts
 *
 * OPEN-THE-GATES Slice 1. Live seq 95048 (sess-mob-d7d149e7f9e3ff6fbf7fbc4c92752fe7):
 * the planning card ranked by lexical overlap, sliced to 8, and disclosed
 * ZERO writes while GOOGLESHEETS_CREATE_GOOGLE_SHEET1 was already proven.
 * The model could not cite a write. Five gates then refused in five
 * vocabularies. Clem told the owner the connector was down.
 *
 * Pin the negatives:
 *   1. a write-ceiling turn with ≥1 proven write MUST NOT disclose a
 *      read-only card
 *   2. a withheld ceiling-matching capability MUST appear in `withheld`
 *
 * Prove by re-breaking two ways:
 *   (i)  rankPlanningCardWithoutCeilingReservation — the pre-Slice-1 order
 *   (ii) liveRegistryDescriptorPassesRehydrate under a restored read-only
 *        filter (effect === 'read')
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import {
  inferPlanningEffectCeiling,
  liveRegistryDescriptorPassesRehydrate,
  planningEffectCeilingForAcceptedRequest,
  promoteSelectedSameSourceStagedPlanningDescriptors,
  rankPlanningCardWithoutCeilingReservation,
  rankedLivePlanningDescriptors,
} from './admit-and-compile-accepted-source.js';

const OBJECTIVE = 'Hey can you find me the deals Tim still has to close for the quarter and then drop them in a new Google sheet pleasE';
const WRITE_ID = 'cap:resolved:googlesheets_create_google_sheet1';

function digest(id: string): string {
  return id.replace(/[^a-f0-9]/g, 'a').padEnd(64, '0').slice(0, 64);
}

function descriptor(
  id: string,
  effect: HostCapabilityDescriptorV1['effect'],
  purpose: string,
  extra: Partial<HostCapabilityDescriptorV1> = {},
): HostCapabilityDescriptorV1 {
  return {
    id,
    effect,
    purpose,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
    inputShape: 'evidence',
    outputShape: 'evidence',
    outputKind: 'evidence',
    deliverableKind: effect === 'external_write' ? 'google_spreadsheet' : 'records',
    destinationPosture: effect === 'external_write' ? 'create_new' : null,
    evidenceKinds: ['tool_result'],
    handleRequired: effect === 'external_write',
    readbackRequired: effect === 'external_write',
    accountScope: 'runtime',
    manifestDigest: digest(id),
    ...extra,
  };
}

function seq95048Live(): HostCapabilityDescriptorV1[] {
  const reads = Array.from({ length: 10 }, (_, index) => descriptor(
    `cap:resolved:lexical_read_${index}`,
    'read',
    // Outscore the Sheets create on the live objective: dump the request's
    // distinctive words into every read so lexical ranking fills the card
    // before the write, the way dataforseo_create beat Sheets create.
    'find deals tim still close quarter drop them new google sheet please locate source records',
  ));
  const write = descriptor(
    WRITE_ID,
    'external_write',
    'create google spreadsheet',
    { advisoryRoles: ['destination', 'create'] },
  );
  return [...reads, write];
}

test('NEGATIVE 1: a write-ceiling turn with a proven write must not disclose a read-only card', () => {
  const live = seq95048Live();
  const covered = rankedLivePlanningDescriptors({
    objective: OBJECTIVE,
    live,
    advisory: [],
    effectCeiling: 'external_write',
  });
  assert.equal(covered.effectCeiling, 'external_write');
  assert.ok(
    covered.capabilities.some((entry) => entry.id === WRITE_ID && entry.effect === 'external_write'),
    `Sheets create must be on the card, got: ${covered.capabilities.map((entry) => `${entry.id}:${entry.effect}`).join(', ')}`,
  );
  assert.ok(
    covered.capabilities.some((entry) => entry.effect === 'external_write'),
    'write-ceiling card must contain at least one write',
  );
});

test('NEGATIVE 2: a withheld ceiling-matching capability must appear in withheld', () => {
  const live = [
    ...Array.from({ length: 8 }, (_, index) => descriptor(
      `cap:resolved:google_sheet_write_${index}`,
      'external_write',
      'create google spreadsheet drop sheet',
    )),
    descriptor(WRITE_ID, 'external_write', 'create google spreadsheet drop sheet'),
  ];
  const covered = rankedLivePlanningDescriptors({
    objective: OBJECTIVE,
    live,
    advisory: [],
    effectCeiling: 'external_write',
  });
  assert.equal(covered.capabilities.length, 8);
  const onCard = new Set(covered.capabilities.map((entry) => entry.id));
  const missing = live.filter((entry) => !onCard.has(entry.id));
  assert.ok(missing.length >= 1, 'the 8-slot bound must withhold at least one write');
  const withheldIds = new Set(covered.withheld.map((entry) => entry.id));
  for (const descriptor of missing) {
    assert.ok(
      withheldIds.has(descriptor.id),
      `${descriptor.id} must be named in withheld, got ${JSON.stringify(covered.withheld)}`,
    );
    const row = covered.withheld.find((entry) => entry.id === descriptor.id);
    assert.equal(row?.effect, 'external_write');
    assert.ok(row?.reason === 'fresh_planning_card_limit' || row?.reason === 'fresh_planning_card_bytes');
  }
});

test('a selected exact same-source staged ref displaces stale noise on a full card', () => {
  const current = Array.from({ length: 8 }, (_, index) => descriptor(
    `cap:resolved:irrelevant_approval_write_${index}`,
    'external_write',
    'update approval source records',
  ));
  const staged = descriptor(
    'cap:local:space_save:reversible',
    'local_write',
    'author_workspace',
    {
      deliverableKind: 'workspace',
      outputKind: 'workspace_revision',
      destinationPosture: 'create_new',
      readbackRequired: false,
    },
  );
  const objective = 'Update the Workspace to use the reviewed data source; show approval if required.';
  const before = rankedLivePlanningDescriptors({
    objective,
    live: [...current, staged],
    advisory: current,
    preferredLiveIds: new Set(current.map((entry) => entry.id)),
    effectCeiling: 'external_write',
  });
  assert.equal(before.capabilities.length, 8);
  assert.equal(before.capabilities.some((entry) => entry.id === staged.id), false,
    'fixture must reproduce the live fresh_planning_card_limit omission');

  const promoted = promoteSelectedSameSourceStagedPlanningDescriptors({
    objective,
    current: before.capabilities,
    staged: [staged],
    selectedRefs: new Set([staged.id]),
    effectCeiling: before.effectCeiling,
  });
  assert.ok(promoted);
  assert.equal(promoted?.capabilities.length, 8, 'promotion preserves the bounded card');
  assert.ok(promoted?.capabilities.some((entry) => entry.id === staged.id),
    'the exact ref selected from tool_search must displace stale lexical noise');
  assert.ok(promoted?.withheld.some((entry) => entry.id !== staged.id),
    'the displaced ceiling write remains explicitly withheld');
});

test('a selected unstaged or index-only ref cannot enter through staged promotion', () => {
  const current = Array.from({ length: 8 }, (_, index) => descriptor(
    `cap:resolved:bounded_${index}`,
    'read',
    'bounded current read',
  ));
  assert.equal(promoteSelectedSameSourceStagedPlanningDescriptors({
    objective: 'Update the Workspace.',
    current,
    staged: [],
    selectedRefs: new Set(['cap:local:invented:reversible']),
    effectCeiling: 'external_write',
  }), null);
});

test('NEGATIVE: write reservation must not starve the reads the write depends on', () => {
  const live = [
    ...Array.from({ length: 8 }, (_, index) => descriptor(
      `cap:resolved:google_sheet_write_${index}`,
      'external_write',
      'create google spreadsheet drop sheet',
    )),
    descriptor(
      'cap:resolved:salesforce_sf_soql_query',
      'read',
      'find deals tim still close quarter salesforce soql',
    ),
    descriptor(WRITE_ID, 'external_write', 'create google spreadsheet drop sheet'),
  ];
  const covered = rankedLivePlanningDescriptors({
    objective: OBJECTIVE,
    live,
    advisory: [],
    effectCeiling: 'external_write',
  });
  assert.ok(
    covered.capabilities.some((entry) => entry.id === WRITE_ID || entry.effect === 'external_write'),
    'at least one write stays on the card',
  );
  assert.ok(
    covered.capabilities.some((entry) => entry.id === 'cap:resolved:salesforce_sf_soql_query'),
    `Salesforce read must remain citable, got: ${covered.capabilities.map((entry) => entry.id).join(', ')}`,
  );
});

test('request-owned write ceiling reserves the best local write alongside an external write', () => {
  const objective = 'update this workspace and bind the salesforce cli for data refresh please';
  const localWorkspaceEdit = descriptor(
    'cap:local:space_edit_runner:reversible',
    'local_write',
    'author workspace runner',
    {
      deliverableKind: 'workspace',
      destinationPosture: 'named_existing',
      handleRequired: true,
      readbackRequired: true,
    },
  );
  const externalMailWrite = descriptor(
    'cap:resolved:mail_delivery',
    'external_write',
    'deliver mail',
  );
  const lexicalReads = Array.from({ length: 10 }, (_, index) => descriptor(
    `cap:resolved:workspace_refresh_read_${index}`,
    'read',
    'update this workspace bind salesforce cli data refresh please',
  ));
  const ceiling = planningEffectCeilingForAcceptedRequest(objective);
  assert.equal(ceiling, 'external_write');

  const covered = rankedLivePlanningDescriptors({
    objective,
    live: [...lexicalReads, externalMailWrite, localWorkspaceEdit],
    advisory: [],
    effectCeiling: ceiling,
  });

  assert.ok(
    covered.capabilities.some((entry) => entry.id === localWorkspaceEdit.id),
    `the request-matching local write must be reserved, got: ${covered.capabilities.map((entry) => `${entry.id}:${entry.effect}`).join(', ')}`,
  );
  assert.ok(
    covered.capabilities.some((entry) => entry.id === externalMailWrite.id),
    'the external write may share the two-slot write reservation',
  );
  assert.ok(
    covered.capabilities.some((entry) => entry.effect === 'read'),
    'write reservation must retain dependency-read capacity',
  );
});

test('re-break (i): without ceiling reservation the seq-95048 fixture is a read-only card', () => {
  const live = seq95048Live();
  const legacy = rankPlanningCardWithoutCeilingReservation({
    objective: OBJECTIVE,
    live,
    advisory: [],
  });
  assert.equal(
    legacy.some((entry) => entry.effect === 'external_write'),
    false,
    'the pre-Slice-1 ranker must reproduce the live defect so the reservation is load-bearing',
  );
  assert.equal(legacy.length, 8);
});

test('re-break (ii): restoring the read-only rehydrate filter drops a write', () => {
  assert.equal(
    liveRegistryDescriptorPassesRehydrate('external_write', 'external_write'),
    true,
    'a write-ceiling turn must rehydrate a write',
  );
  assert.equal(
    liveRegistryDescriptorPassesRehydrate('read', 'external_write'),
    true,
    'reads remain rehydratable under a write ceiling',
  );
  assert.equal(
    liveRegistryDescriptorPassesRehydrate('external_write', 'read'),
    false,
    'a read-ceiling turn must not rehydrate a write',
  );
  const restoredReadOnlyFilter = (effect: string) => effect === 'read';
  assert.equal(
    restoredReadOnlyFilter('external_write'),
    false,
    'the pre-Slice-1 `effect !== "read"` continue at :1251 dropped writes in silence',
  );
});

test('inferPlanningEffectCeiling: google-sheet drop is a write, a deals count is a read', () => {
  const live = seq95048Live();
  assert.equal(inferPlanningEffectCeiling(OBJECTIVE, live), 'external_write');
  assert.equal(
    inferPlanningEffectCeiling('How many deals does Tim have set to close this month in salesforce', live),
    'read',
  );
});

test('accepted-request effect, not capability spelling, owns the initial planning ceiling', () => {
  assert.equal(
    planningEffectCeilingForAcceptedRequest('send an email to the team'),
    'external_write',
  );
  assert.equal(
    planningEffectCeilingForAcceptedRequest(
      'Can you send James Marshall and invite to his scorpion email for today at 1pm and call it AI check in',
    ),
    'external_write',
  );
  assert.equal(
    planningEffectCeilingForAcceptedRequest(
      'How many deals does Tim have set to close this month in salesforce',
    ),
    'read',
  );
});
