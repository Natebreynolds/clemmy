/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/fast-lane-collect-construct.test.ts
 *
 * THE FAST LANE (plan: "The 3-Minute Graph"). Live 2026-08-19 sess-mt0c3kkc
 * paid 97s and six model calls at admission for a plan the host could prove.
 * These pins run the same live ask through the host deterministic compile:
 *
 *   - GOLDEN: zero model calls — the semantic port is a TRIPWIRE that throws
 *     on any invocation. Admission is host-authored under the reserved
 *     authority identity; the typed executor runs the whole chain (search
 *     with frozen `q`, ONE create, readback, artifact row) and every
 *     physical dispatch re-proves the host authority by RECOMPUTE (the
 *     verifier installed by configureTypedExecutionRuntime re-derives the
 *     plan from the durable user text and demands byte-identical digests).
 *   - HONESTY: an ask the classifier cannot prove (no stated count) pays the
 *     model ceremony exactly as before — the port IS called.
 *   - TAMPER: a doctored host record refuses closed at the dispatch guard.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fast-lane-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-fast-lane\n', 'utf8');

const { appendEvent, createSession, listEvents, openEventLog } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const { readClaimLinkedSemanticInterpretation } = await import('./interpret-accepted-source.js');
const { fakeSemanticProposal, entailedPlanGroundingJudge } = await import('./fake-semantic-model.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { installProductionTransport } = await import('../harness/production-capability-adapters.js');
const { installConnectedRegistryPort } = await import('../harness/connected-goal-catalog.js');
const { HOST_BIND_IDENTITY } = await import('./host-authority.js');
const { verifyHostCompiledRecord } = await import('./host-deterministic-compile.js');
configureTypedExecutionRuntime();

saveProactivityPolicy({ autoApproveScope: 'yolo' });

const LIVE_TEXT = 'Find me the top 5 big bear lake restaurants based on Google reviews add them to a Google sheet with the data';

const SEARCH_SCHEMA = { type: 'object', required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'integer' } } };
const SHEET_FROM_JSON_SCHEMA = { type: 'object', required: ['title', 'sheet_name', 'sheet_json'], properties: { title: { type: 'string' }, sheet_name: { type: 'string' }, sheet_json: { type: 'string' } } };
const BATCH_GET_SCHEMA = { type: 'object', required: ['spreadsheet_id'], properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } } };

const CONNECTED_REGISTRY = {
  connectedToolkits: ['firecrawl', 'googlesheets'],
  tools: [
    { slug: 'FIRECRAWL_SEARCH', schema: SEARCH_SCHEMA },
    { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: SHEET_FROM_JSON_SCHEMA },
    { slug: 'GOOGLESHEETS_BATCH_GET', schema: BATCH_GET_SCHEMA },
  ],
};

const ROWS = [
  { title: 'Peppercorn Grille', rating: '4.5' },
  { title: 'The Pines Lakefront', rating: '4.6' },
  { title: 'Saucy Mamas', rating: '4.4' },
  { title: 'Nottinghams', rating: '4.3' },
  { title: 'Azteca Grill', rating: '4.4' },
];

function seedSchemas(): void {
  for (const tool of CONNECTED_REGISTRY.tools) rememberToolSchema(tool.slug, tool.schema);
}

function freshTurn(id: string, text = LIVE_TEXT): { sessionId: string; seq: number } {
  const session = createSession({ id, kind: 'chat', userId: 'user-fast-lane' });
  const source = appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text },
  });
  return { sessionId: session.id, seq: source.seq };
}

// THE CLEAN LOOP (2026-08-19, Nathan): chat never routes — the fast-lane
// CHAT hook retired the same day it shipped. The machinery below (host
// deterministic compile + host-minted authority + dispatch-time recompute)
// is RETAINED as the workflow-replay engine: a user-designated graph replays
// deterministically through the typed executor. These pins keep that
// machinery provably alive at the interpret seam until the replay entry
// point lands.
test('REPLAY MACHINERY: the host compile core stays deterministic and byte-stable', async () => {
  const { buildHostProposal, extractCollectCount, deriveDestinationFamily } = await import('./host-deterministic-compile.js');
  const { canonicalProposalPayloadHash } = await import('./turn-semantic-proposal.js');
  const { hostCompileDigest } = await import('./host-authority.js');
  assert.equal(extractCollectCount(LIVE_TEXT), 5);
  assert.equal(deriveDestinationFamily('put the records in a workbook', ['workbook']), 'workbook');
  assert.equal(deriveDestinationFamily(LIVE_TEXT, ['workbook']), null);
  const proposal = buildHostProposal({ acceptedText: LIVE_TEXT, count: 5, family: 'workbook' });
  const digestA = canonicalProposalPayloadHash(proposal);
  const digestB = canonicalProposalPayloadHash(buildHostProposal({ acceptedText: LIVE_TEXT, count: 5, family: 'workbook' }));
  assert.equal(digestA, digestB, 'the proposal is a pure function of its inputs — recompute depends on it');
  const compile = hostCompileDigest({
    compilerVersion: 'v1', inputHash: 'a'.repeat(64), audienceHash: 'b'.repeat(64),
    policyRevision: 'rev', catalogSnapshotDigest: 'c'.repeat(64), proposalDigest: digestA,
  });
  assert.match(compile, /^[a-f0-9]{64}$/);
});

// RETIRED (THE CLEAN LOOP): the chat ceremony fallthrough no longer exists —
// an unprovable ask lands the model turn with tools, same as every turn.

test('TAMPER: a doctored host record fails the recompute and refuses closed', async () => {
  const turn = freshTurn('fast-lane-tamper');
  const loadRealText = (identity: { sessionId: string; sourceUserSeq: number }): string | null => {
    const event = listEvents(identity.sessionId, { types: ['user_input_received'] })
      .find((entry) => entry.seq === identity.sourceUserSeq);
    return typeof event?.data.text === 'string' ? event.data.text : null;
  };
  const base = {
    groundingIdentity: HOST_BIND_IDENTITY,
    groundingProposalDigest: 'a'.repeat(64),
    groundingCatalogDigest: 'b'.repeat(64),
    hostCompileDigest: 'c'.repeat(64),
    hostCompilerVersion: 'v1',
    inputHash: 'd'.repeat(64),
    audienceHash: 'e'.repeat(64),
    policyRevision: 'rev-1',
  };
  // Wrong inputHash: the durable text does not hash to the record's claim.
  const sourceMismatch = verifyHostCompiledRecord({
    record: base,
    identity: { sessionId: turn.sessionId, sourceUserSeq: turn.seq },
    loadAcceptedText: loadRealText,
  });
  assert.deepEqual(sourceMismatch, { ok: false, reason: 'host_compile_source_mismatch' });
  // Unknown compiler version is an explicit invalidation, never a pass.
  const versionMismatch = verifyHostCompiledRecord({
    record: { ...base, hostCompilerVersion: 'v999' },
    identity: { sessionId: turn.sessionId, sourceUserSeq: turn.seq },
    loadAcceptedText: loadRealText,
  });
  assert.deepEqual(versionMismatch, { ok: false, reason: 'host_compile_recompute_mismatch' });
  // Missing identity can never verify.
  const noIdentity = verifyHostCompiledRecord({ record: base, loadAcceptedText: loadRealText });
  assert.deepEqual(noIdentity, { ok: false, reason: 'host_authority_unproven' });
});
