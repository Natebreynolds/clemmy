import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PRIOR_HOME = process.env.CLEMENTINE_HOME;
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-selection-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
// Prevent module-import eager ONNX warmup; the deterministic local provider
// seeded below explicitly overrides this test gate.
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'source-selection-machine\n');

const aliases = await import('../../memory/capability-alias-index.js');
const embeddings = await import('../../memory/embeddings.js');
const eventlog = await import('../harness/eventlog.js');
const graphShadow = await import('../graph/turn-graph-shadow.js');
const dispatchLedger = await import('../harness/dispatch-ledger.js');
const attemptIdentities = await import('../harness/attempt-identity.js');
const attemptOutcomes = await import('../harness/attempt-outcome.js');
const settlementStore = await import('../harness/logical-call-settlement-store.js');
const acceptedAuthority = await import('../harness/accepted-task-authority.js');
const expectedWork = await import('../harness/expected-work-contract.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const contracts = await import('../../tools/tool-contract-store.js');
const candidates = await import('./capability-candidates.js');
const originAuthority = await import('./verified-read-origin-authority.js');

const PISMO = 'find me the top 5 restaurants in Pismo Beach CA based on Google reviews, '
  + 'give me the review count and phone number for each, and create a new Google Sheet';
const PISMO_ROW_ECHO = 'Find the top 5 restaurants in Pismo Beach by Google review count. '
  + 'Include each restaurant name, review count, and phone number, then create one new Google Sheet '
  + 'containing those 5 rows. Do not email or share it.';
const APIFY = 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET';
const APIFY_RUN = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
const FIRECRAWL = 'FIRECRAWL_SEARCH';
const DATAFORSEO_READ = 'DATAFORSEO_GET_SERP_GOOGLE_MAPS_TASK_GET_ADVANCED_BY_ID';
const DATAFORSEO_WRITE = 'DATAFORSEO_CREATE_SERP_GOOGLE_MAPS_TASK';
const SLACK = 'SLACK_FETCH_CONVERSATION_HISTORY';
const SOURCE_TWO = 'PLACECO_SEARCH_PUBLIC_REVIEWS';
const SOURCE_MISSING_PHONE = 'MAPSCO_SEARCH_PUBLIC_REVIEWS';

const READ_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, limit: { type: 'number' } },
  required: ['query', 'limit'],
};
const READ_FINGERPRINT = contracts.fingerprintSchema(READ_SCHEMA);

let fixtureSeq = 0;
function hex(length: number, digit: string): string {
  return digit.repeat(length);
}

function cosineVector(score: number): Float32Array {
  return new Float32Array([score, Math.sqrt(1 - (score * score))]);
}

function restaurantPayload(count: number, missingPhoneIndex?: number): unknown {
  return {
    data: {
      items: Array.from({ length: count }, (_, index) => ({
        title: `Restaurant ${index + 1}`,
        totalScore: 4.5,
        reviewsCount: 100 + index,
        phone: index === missingPhoneIndex
          ? ''
          : `(805) 555-00${String(index).padStart(2, '0')}`,
        searchPageUrl: 'https://www.google.com/maps/search/restaurants',
      })),
    },
  };
}

const GENERIC_WEB_SEARCH_PAYLOAD = {
  data: {
    data: {
      web: [{
        title: 'Restaurant roundup',
        description: 'A prose list of restaurant links and review snippets.',
        url: 'https://example.test/restaurants',
      }],
    },
  },
};

function seedReceipt(input: {
  identifier: string;
  phrase: string;
  settlement: 'succeeded' | 'unknown';
  digit: string;
  payload?: unknown;
  topology?: 'direct_write' | 'read_then_write';
  /** Live-home compatibility fixture: old immutable handles did not persist
   * the later root success-envelope projection. */
  legacyEnvelopeMetadataMissing?: boolean;
}): import('../../memory/verified-read-origin.js').VerifiedReadCapabilityOrigin {
  fixtureSeq += 1;
  const sessionId = `source-selection-${fixtureSeq}`;
  eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: 'source selection fixture' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.phrase, attemptId: `attempt-${fixtureSeq}` },
  });
  let evidenceDigest = hex(24, input.digit);
  if (input.settlement === 'succeeded') {
    assert.ok(graphShadow.recordTurnGraphShadow({
      identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
    }));
    if (input.topology) {
      assert.match(acceptedAuthority.armAcceptedTaskAuthority({
        sessionId,
        sourceUserSeq: source.seq,
      }).status, /^(?:armed|existing)$/);
      const sourceId = `source_${fixtureSeq}`;
      const middleId = `enrich_${fixtureSeq}`;
      const destinationId = `destination_${fixtureSeq}`;
      const frozen = expectedWork.freezeActionExpectedWorkContract({
        sessionId,
        sourceUserSeq: source.seq,
        proposal: {
          version: 1,
          operations: input.topology === 'direct_write'
            ? [
                {
                  id: sourceId, effect: 'read', coverage: 'complete_set',
                  dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
                },
                {
                  id: destinationId, effect: 'external_write',
                  dependsOn: [sourceId], dataFrom: [sourceId], cardinality: { kind: 'once' },
                },
              ]
            : [
                {
                  id: sourceId, effect: 'read', coverage: 'complete_set',
                  dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
                },
                {
                  id: middleId, effect: 'read', coverage: 'complete_set',
                  dependsOn: [sourceId], dataFrom: [sourceId], cardinality: { kind: 'once' },
                },
                {
                  id: destinationId, effect: 'external_write',
                  dependsOn: [middleId], dataFrom: [middleId], cardinality: { kind: 'once' },
                },
              ],
          universes: [],
        },
      });
      assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));
    }
    const acceptedTaskId = attemptIdentities.acceptedTaskIdFor(sessionId, source.seq);
    const logicalToolCallId = `logical:${fixtureSeq}`;
    const physicalDispatchId = `dispatch:${fixtureSeq}`;
    const args = { query: `fixture-${fixtureSeq}` };
    const begun = dispatchLedger.beginPhysicalDispatch({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId,
        ordinal: 0,
      },
      tool: input.identifier,
      args,
    });
    assert.equal(begun.status, 'inserted');
    if (begun.status !== 'inserted') assert.fail(begun.reason);
    assert.equal(dispatchLedger.settlePhysicalDispatch({
      identity: begun.identity,
      tool: input.identifier,
      outcome: 'returned',
    }).status, 'inserted');
    const committed = settlementStore.commitLogicalCallSettlement({
      identity: { sessionId, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
      contract: { toolName: input.identifier, args },
      execution: { kind: 'provider_execution' },
      result: { payload: input.payload ?? { data: { value: 'fixture' } } },
      outcome: attemptOutcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: {
        businessCall: true,
        mutating: false,
        ...(input.topology ? { requirementId: `source_${fixtureSeq}` } : {}),
      },
      observer: { lane: 'composio', turn: 1 },
    });
    assert.equal(committed.status, 'committed');
    if (committed.status !== 'committed') assert.fail(JSON.stringify(committed));
    if (input.legacyEnvelopeMetadataMissing) {
      const db = eventlog.openEventLog();
      db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
      try {
        db.prepare(`UPDATE durable_result_handles
          SET envelope_meta_json = NULL
          WHERE handle_id = ?`).run(committed.settlement.resultHandleId);
      } finally {
        db.exec(`
          CREATE TRIGGER trg_durable_result_identity_immutable
          BEFORE UPDATE ON durable_result_handles
          BEGIN
            SELECT RAISE(ABORT, 'durable result handles are immutable');
          END;
        `);
      }
    }
    const row = eventlog.openEventLog().prepare(
      'SELECT raw_payload_sha256, envelope_meta_json FROM durable_result_handles WHERE handle_id = ?',
    ).get(committed.settlement.resultHandleId) as {
      raw_payload_sha256: string;
      envelope_meta_json: string | null;
    };
    if (input.legacyEnvelopeMetadataMissing) assert.equal(row.envelope_meta_json, null);
    evidenceDigest = row.raw_payload_sha256.slice(0, 24);
  } else {
    eventlog.appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'tool_attempt_settled',
      data: {
        sourceUserSeq: source.seq,
        acceptedTaskId: `task:${sessionId}#${source.seq}`,
        tool: input.identifier,
        kind: input.settlement,
        dispatchState: 'dispatched',
        mutating: false,
        detail: 'provider_envelope_contradiction',
      },
    });
  }
  const receiptId = `rr_${hex(32, input.digit)}`;
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'read_receipt',
    data: {
      record: {
        receiptId,
        at: new Date().toISOString(),
        provider: input.identifier.split('_')[0]!.toLowerCase(),
        operation: input.identifier.toLowerCase(),
        effectClass: 'read',
        identifier: input.identifier,
        schemaFingerprint: READ_FINGERPRINT,
        scope: { tenant: 'source-selection-machine', workspace: TEST_HOME, accountIdentity: '' },
        dispatchOutcome: 'succeeded',
        source: {
          sessionId,
          sourceUserSeq: source.seq,
          attemptId: `attempt-${fixtureSeq}`,
        },
        readEvidenceRef: `evt:${evidenceDigest}`,
      },
    },
  });
  return { version: 1, sessionId, sourceUserSeq: source.seq, receiptId, evidenceDigest };
}

function seedAlias(input: {
  identifier: string;
  phrase: string;
  vector: Float32Array;
  origin?: import('../../memory/verified-read-origin.js').VerifiedReadCapabilityOrigin;
  legacyClaim?: boolean;
}) {
  const written = aliases.recordCapabilityAlias({
    aliasDigest: aliases.acceptedPhraseDigest(input.phrase),
    intent: input.identifier.toLowerCase(),
    kind: 'composio',
    identifier: input.identifier,
    klass: 'capability_only',
    terms: aliases.boundedAliasTerms(input.phrase),
    schemaFingerprint: READ_FINGERPRINT,
    scope: aliases.daemonAliasScope(),
    ...(input.origin ? { verifiedReadOrigin: input.origin } : {}),
  });
  assert.equal(written.stored, true);
  if (!written.stored) assert.fail(written.reason);
  assert.equal(aliases.attachCapabilityAliasEmbedding(
    written.row,
    input.vector,
    embeddings.localEmbeddingSpaceKey(),
  ), true);
  if (input.legacyClaim && input.origin) {
    assert.equal(aliases.claimAcceptedSourceForLearning({
      sessionId: input.origin.sessionId,
      sourceUserSeq: input.origin.sourceUserSeq,
      identifier: input.identifier,
    }), true);
  }
  return written.row;
}

function choice(
  intent: string,
  identifier: string,
  origin?: import('../../memory/verified-read-origin.js').VerifiedReadCapabilityOrigin,
) {
  return {
    intent,
    description: intent,
    choice: {
      kind: 'composio' as const,
      identifier,
      testedAt: '2026-08-20T00:00:00.000Z',
      schemaFingerprint: READ_FINGERPRINT,
      ...(origin ? { verifiedReadOrigin: origin } : {}),
    },
    fallbacks: [],
    aliases: [{
      intent,
      status: 'active' as const,
      source: origin ? 'verified_read' as const : 'composio_search' as const,
      firstSeenAt: '2026-08-20T00:00:00.000Z',
      lastSeenAt: '2026-08-20T00:00:00.000Z',
    }],
    body: '',
    filePath: `/fixture/${identifier}`,
  };
}

embeddings._setLocalProviderForTest({
  name: 'local',
  model: 'source-selection-fixture',
  dim: 2,
  embed: async (inputs: string[]) => inputs.map(() => new Float32Array([1, 0])),
});

const restaurantPrior = 'pull top restaurants in Ventura using Apify API and put name rating '
  + 'Google reviews and phone number in a new Google Sheet';
const apifyOrigin = seedReceipt({
  identifier: APIFY,
  phrase: restaurantPrior,
  settlement: 'succeeded',
  digit: 'a',
  payload: {
    successful: true,
    logId: 'legacy-pismo-source-log',
    ...(restaurantPayload(5) as Record<string, unknown>),
  },
  topology: 'direct_write',
  legacyEnvelopeMetadataMissing: true,
});
const apifyRow = seedAlias({
  identifier: APIFY,
  phrase: restaurantPrior,
  vector: cosineVector(0.6868),
  // Live-home compatibility shape: the row predates origin_json, but its exact
  // accepted-source learning claim still joins to the canonical receipt.
  origin: apifyOrigin,
  legacyClaim: true,
});
// Remove the newly supplied side-table origin while retaining the exact claim:
// re-recording without provenance mirrors the legacy home row safely.
seedAlias({ identifier: APIFY, phrase: restaurantPrior, vector: cosineVector(0.6868) });

const poisonOrigin = seedReceipt({
  identifier: DATAFORSEO_READ,
  phrase: PISMO,
  settlement: 'unknown',
  digit: 'b',
});
seedAlias({
  identifier: DATAFORSEO_READ,
  phrase: PISMO,
  vector: new Float32Array([1, 0]),
  origin: poisonOrigin,
});

const slackOrigin = seedReceipt({
  identifier: SLACK,
  phrase: 'read the latest Slack channel history and summarize the launch discussion',
  settlement: 'succeeded',
  digit: 'c',
});
seedAlias({
  identifier: SLACK,
  phrase: 'read the latest Slack channel history and summarize the launch discussion',
  vector: new Float32Array([0.8, 0.6]),
  origin: slackOrigin,
});

const metadataLoads: string[] = [];
const liveFingerprints = new Map<string, string>();
schemaCache._clearToolSchemaCacheForTest();
schemaCache._setToolSchemaLoaderForTests(async (identifier) => {
  metadataLoads.push(identifier);
  if ([APIFY, APIFY_RUN, FIRECRAWL, SOURCE_TWO, SOURCE_MISSING_PHONE].includes(identifier)) {
    return { inputParameters: READ_SCHEMA, providerObservedAt: Date.now() };
  }
  return null;
});

async function ensureFixtureFingerprint(identifier: string): Promise<string | undefined> {
  metadataLoads.push(identifier);
  if (![APIFY, APIFY_RUN, FIRECRAWL, SOURCE_TWO, SOURCE_MISSING_PHONE].includes(identifier)) return undefined;
  schemaCache.rememberToolSchema(identifier, READ_SCHEMA, Date.now());
  liveFingerprints.set(identifier, READ_FINGERPRINT);
  return READ_FINGERPRINT;
}

test.after(() => {
  embeddings._setLocalProviderForTest(undefined);
  schemaCache._setToolSchemaLoaderForTests(null);
  aliases.closeCapabilityAliasIndexForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

test('cold-cache Pismo source selection restores exact Apify authority and excludes poison without business dispatch', async () => {
  assert.equal(aliases.capabilityAliasVerifiedReadOrigin(apifyRow), null,
    'fixture unexpectedly retained the modern alias-origin side-table row');
  assert.deepEqual(
    originAuthority.recoverCanonicalVerifiedReadOriginForAlias(apifyRow),
    apifyOrigin,
    'legacy recovery did not make the exact accepted-source/receipt join',
  );
  const rawHints = aliases.semanticCapabilityAliasAuthorityHints(new Float32Array([1, 0]), {
    scope: aliases.daemonAliasScope(),
    embeddingSpace: embeddings.localEmbeddingSpaceKey(),
    limit: 25,
    floor: 0.60,
  });
  assert.ok(rawHints.some((hit) => hit.row.identifier === APIFY),
    `Apify row missing from semantic hints: ${JSON.stringify(rawHints.map((hit) => hit.row.identifier))}`);
  const hintedApify = rawHints.find((hit) => hit.row.identifier === APIFY)!;
  assert.deepEqual(originAuthority.recoverCanonicalVerifiedReadOriginForAlias(hintedApify.row), apifyOrigin);
  const beforeBusinessEvents = eventlog.listEvents(apifyOrigin.sessionId)
    .filter((event) => event.type === 'tool_called' || event.type === 'tool_attempt_settled').length;

  const resolved = await candidates.resolveTurnCapabilityCandidates({
    userInput: PISMO,
    liveSchemaFingerprintFor: (identifier) => liveFingerprints.get(identifier),
    ensureLiveSchemaFingerprintFor: ensureFixtureFingerprint,
    choices: [
      choice(restaurantPrior, APIFY, apifyOrigin),
      choice(PISMO, DATAFORSEO_READ, poisonOrigin),
      choice(PISMO, DATAFORSEO_WRITE),
      choice('read latest Slack channel history', SLACK, slackOrigin),
    ] as never,
  });

  assert.equal(
    resolved.sourceStrategyBinding?.primary.capabilityId,
    `capability:composio:${APIFY}`,
    JSON.stringify({
      metadataLoads,
      semanticApplied: resolved.semanticApplied,
      candidates: resolved.candidates.map((candidate) => ({
        identifier: candidate.identifier,
        roleKey: candidate.roleKey,
        score: candidate.score,
        schemaAuthority: candidate.schemaAuthority,
        schemaFingerprint: candidate.schemaFingerprint,
        verifiedReadSchemaFingerprint: candidate.verifiedReadSchemaFingerprint,
        sourceLexicalSupport: candidate.sourceLexicalSupport,
      })),
      requirements: resolved.requirements.map((requirement) => ({
        roleKey: requirement.roleKey,
        effect: requirement.effect,
        resolved: requirement.resolved,
      })),
    }),
  );
  assert.equal(resolved.sourceStrategyBinding?.primary.schemaFingerprint, READ_FINGERPRINT);
  assert.deepEqual(metadataLoads, [APIFY],
    'source resolution performed broad/unrelated provider metadata work');
  const sourceRole = resolved.requirements.find((requirement) => requirement.effect === 'read');
  assert.ok(sourceRole);
  assert.deepEqual(sourceRole.resolvedCapabilities.map((candidate) => candidate.identifier), [APIFY]);
  assert.equal(sourceRole.resolvedCapabilities.some((candidate) =>
    candidate.identifier === DATAFORSEO_READ
    || candidate.identifier === DATAFORSEO_WRITE
    || candidate.identifier === SLACK), false);
  assert.equal(resolved.sourceStrategyBinding?.equivalentFallbacks.some((fallback) =>
    /DATAFORSEO|SLACK/.test(fallback.capabilityId)), false);

  const rowEcho = await candidates.resolveTurnCapabilityCandidates({
    userInput: PISMO_ROW_ECHO,
    liveSchemaFingerprintFor: (identifier) => liveFingerprints.get(identifier),
    ensureLiveSchemaFingerprintFor: ensureFixtureFingerprint,
    choices: [
      choice(restaurantPrior, APIFY, apifyOrigin),
      choice(PISMO, DATAFORSEO_READ, poisonOrigin),
      choice(PISMO, DATAFORSEO_WRITE),
      choice('read latest Slack channel history', SLACK, slackOrigin),
    ] as never,
  });
  assert.equal(
    rowEcho.sourceStrategyBinding?.primary.capabilityId,
    `capability:composio:${APIFY}`,
    'a destination row-count echo reintroduced fanout or hid the proven aggregate source',
  );
  assert.equal(rowEcho.candidates.some((candidate) => candidate.identifier === DATAFORSEO_WRITE), false);
  assert.equal(eventlog.listEvents(apifyOrigin.sessionId)
    .filter((event) => event.type === 'tool_called' || event.type === 'tool_attempt_settled').length,
  beforeBusinessEvents,
  'candidate resolution crossed the business-dispatch boundary');
});

test('live-shaped generic web search loses to the field-complete bounded source and originless write is absent', async () => {
  const firecrawlPrior = 'find the top five Big Bear Lake restaurants based on Google reviews and add the data to a sheet';
  const firecrawlOrigin = seedReceipt({
    identifier: FIRECRAWL,
    phrase: firecrawlPrior,
    settlement: 'succeeded',
    digit: 'e',
    payload: GENERIC_WEB_SEARCH_PAYLOAD,
    topology: 'read_then_write',
  });
  seedAlias({
    identifier: FIRECRAWL,
    phrase: firecrawlPrior,
    vector: cosineVector(0.7081),
    origin: firecrawlOrigin,
  });
  const actorOrigin = seedReceipt({
    identifier: APIFY_RUN,
    phrase: restaurantPrior,
    settlement: 'succeeded',
    digit: 'f',
    // Live sibling evidence returned 25 rows for a five-row request. It is
    // eligible but structurally less exact than the bounded ACT receipt.
    // A provider may return a useful superset. A missing value outside the
    // requested first five must not invalidate those five bounded rows.
    payload: restaurantPayload(25, 24),
    topology: 'direct_write',
  });
  seedAlias({
    identifier: APIFY_RUN,
    phrase: restaurantPrior,
    vector: cosineVector(0.6868),
    origin: actorOrigin,
  });
  const missingPhonePrior = 'find five restaurants from Google reviews with names and review counts and put them in a sheet';
  const missingPhoneOrigin = seedReceipt({
    identifier: SOURCE_MISSING_PHONE,
    phrase: missingPhonePrior,
    settlement: 'succeeded',
    digit: '9',
    payload: restaurantPayload(5, 0),
    topology: 'direct_write',
  });
  seedAlias({
    identifier: SOURCE_MISSING_PHONE,
    phrase: missingPhonePrior,
    vector: cosineVector(0.75),
    origin: missingPhoneOrigin,
  });
  metadataLoads.length = 0;
  liveFingerprints.clear();
  schemaCache._clearToolSchemaCacheForTest();
  const before = [apifyOrigin.sessionId, actorOrigin.sessionId, firecrawlOrigin.sessionId, missingPhoneOrigin.sessionId]
    .flatMap((sessionId) => eventlog.listEvents(sessionId))
    .filter((event) => event.type === 'tool_called' || event.type === 'tool_attempt_settled').length;
  const liveChoices = [
    choice(restaurantPrior, APIFY, apifyOrigin),
    choice(restaurantPrior, APIFY_RUN, actorOrigin),
    choice(missingPhonePrior, SOURCE_MISSING_PHONE, missingPhoneOrigin),
    choice(firecrawlPrior, FIRECRAWL, firecrawlOrigin),
    choice(PISMO, DATAFORSEO_READ, poisonOrigin),
    choice(PISMO, DATAFORSEO_WRITE),
    choice('google_sheets.create_restaurants_list', 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1'),
  ] as never;

  const resolved = await candidates.resolveTurnCapabilityCandidates({
    userInput: PISMO,
    limit: 10,
    liveSchemaFingerprintFor: (identifier) => liveFingerprints.get(identifier),
    ensureLiveSchemaFingerprintFor: ensureFixtureFingerprint,
    choices: liveChoices,
  });
  assert.equal(resolved.sourceStrategyBinding?.primary.capabilityId, `capability:composio:${APIFY}`,
    JSON.stringify(resolved.candidates.map((candidate) => ({
      identifier: candidate.identifier,
      score: candidate.score,
      sourceTaskFit: candidate.sourceTaskFit,
      sourceProjectionCoverage: candidate.sourceProjectionCoverage,
      sourceCardinalityFit: candidate.sourceCardinalityFit,
      sourceRecordCount: candidate.sourceRecordCount,
      sourceStructurallyEligible: candidate.sourceStructurallyEligible,
    }))));
  assert.equal(resolved.candidates.some((candidate) => candidate.identifier === FIRECRAWL), false,
    'an unstructured web envelope entered the structurally eligible source card');
  assert.equal(resolved.candidates.some((candidate) => candidate.identifier === SOURCE_MISSING_PHONE), false,
    'a five-row source missing one requested phone number entered the source card');
  assert.equal(resolved.candidates.some((candidate) => candidate.identifier === DATAFORSEO_WRITE), false,
    'the originless source-shaped write leaked into the CTC card');
  assert.equal(resolved.requirements.some((requirement) =>
    requirement.resolvedCapabilities.some((candidate) => candidate.identifier === DATAFORSEO_WRITE)), false);
  assert.equal(resolved.sourceStrategyBinding?.equivalentFallbacks.some((fallback) =>
    fallback.capabilityId.includes(FIRECRAWL) || fallback.capabilityId.includes(DATAFORSEO_WRITE)), false);
  assert.deepEqual(new Set(metadataLoads), new Set([APIFY, APIFY_RUN]),
    'structurally ineligible hints consumed provider metadata work');

  const explicit = await candidates.resolveTurnCapabilityCandidates({
    userInput: `${PISMO}. Use Apify as the source.`,
    limit: 10,
    liveSchemaFingerprintFor: (identifier) => liveFingerprints.get(identifier),
    ensureLiveSchemaFingerprintFor: ensureFixtureFingerprint,
    choices: liveChoices,
  });
  assert.equal(explicit.sourceStrategyBinding?.primary.capabilityId, `capability:composio:${APIFY}`,
    'fresh explicit source authority did not materialize an exact binding');
  assert.equal([apifyOrigin.sessionId, actorOrigin.sessionId, firecrawlOrigin.sessionId, missingPhoneOrigin.sessionId]
    .flatMap((sessionId) => eventlog.listEvents(sessionId))
    .filter((event) => event.type === 'tool_called' || event.type === 'tool_attempt_settled').length,
  before,
  'source ranking dispatched external business work');
});

test('equally scored canonical restaurant sources remain unbound instead of winning alphabetically', async () => {
  const secondPrior = 'find top restaurants from public Google reviews with phone numbers and put them in a workbook';
  const secondOrigin = seedReceipt({
    identifier: SOURCE_TWO,
    phrase: secondPrior,
    settlement: 'succeeded',
    digit: 'd',
    payload: restaurantPayload(5),
    topology: 'direct_write',
  });
  seedAlias({
    identifier: SOURCE_TWO,
    phrase: secondPrior,
    vector: cosineVector(0.6868),
    origin: secondOrigin,
  });

  const resolved = await candidates.resolveTurnCapabilityCandidates({
    userInput: PISMO,
    liveSchemaFingerprintFor: (identifier) => liveFingerprints.get(identifier),
    ensureLiveSchemaFingerprintFor: ensureFixtureFingerprint,
    choices: [
      choice(restaurantPrior, APIFY, apifyOrigin),
      choice(secondPrior, SOURCE_TWO, secondOrigin),
    ] as never,
  });
  assert.ok(resolved.candidates.some((candidate) => candidate.identifier === APIFY));
  assert.ok(resolved.candidates.some((candidate) => candidate.identifier === SOURCE_TWO));
  assert.equal(resolved.sourceStrategyBinding, undefined,
    'an equal-score source tie was silently decided by identifier ordering');
});
