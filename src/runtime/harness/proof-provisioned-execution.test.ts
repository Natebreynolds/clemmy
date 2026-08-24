/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/proof-provisioned-execution.test.ts
 *
 * PROVISION FROM PROOF → THE CONSTRUCT EXECUTES (live 2026-08-18
 * session-fixture-proof-provisioning seq 58753): "top five Big Bear Lake restaurants … new Google
 * sheet" compiled route=act fastPath=fanout_action with 14 nodes and ZERO
 * operationIds — the shadow stayed a label and the SDK loop paid for
 * everything. This pins the executable half: the same proof that already made
 * capabilities citable now registers them as catalog entries. The retired
 * end-to-end pin used one atomic constructor carrying the frozen rows, then an
 * exact-ID readback. It did not authorize a generic post-create update; any
 * such operation needs its own separately declared authority.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proof-exec-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-proof-exec\n', 'utf8');

const { appendEvent, createSession, listEvents, openEventLog, closeEventLog } = await import('./eventlog.js');
const { admitAndCompileAcceptedSource } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('../semantic-boundary/typed-source-dispatch.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configureTypedExecutionRuntime } = await import('../semantic-boundary/configure-typed-execution-runtime.js');
configureTypedExecutionRuntime();
const {
  collectConstructWork,
  entailedPlanGroundingJudge,
  fakeSemanticProposal,
} = await import('../semantic-boundary/fake-semantic-model.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { installProductionTransport } = await import('./production-capability-adapters.js');
const { compileProofProviderArgs } = await import('./proof-provisioned-catalog.js');

saveProactivityPolicy({ autoApproveScope: 'yolo' });

const ROWS = [
  { title: 'Peppercorn Grille', rating: '4.5', phone: '909-866-5405' },
  { title: 'The Pines Lakefront', rating: '4.6', phone: '909-866-5551' },
  { title: 'Saucy Mamas', rating: '4.4', phone: '909-866-7667' },
];

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
};
const CREATE_SCHEMA = {
  type: 'object',
  required: ['sheet_json'],
  properties: { sheet_json: { type: 'string' }, title: { type: 'string' } },
};
const READBACK_SCHEMA = {
  type: 'object',
  required: ['spreadsheet_id'],
  properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } },
};

// RETIRED (THE CLEAN LOOP, 2026-08-19): typed execution from a live chat
// admission is not a reachable shape — the ceremony no longer runs. The
// proof-provisioned catalog machinery stays pinned by its unit suites; the
// end-to-end shape returns with the workflow-replay seam (git history has
// the original pin).

test('the arg compiler is schema-grounded for the exact live shapes', () => {
  const envelope = {
    version: 1,
    identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 'task:s#1' },
    goal: { objective: 'top three Big Bear Lake restaurants', revision: 0, criteria: [] },
    node: { id: 'n1', role: 'source' },
    cardinality: { count: 3, fields: ['title', 'rating', 'phone'] },
    predecessors: [],
    expectedOutput: { kind: 'evidence' },
    binding: { capabilityId: 'cap:resolved:firecrawl_search', manifestDigest: 'd', schemaDigest: 'd', effect: 'read' },
  } as never;
  const search = compileProofProviderArgs({
    schema: SEARCH_SCHEMA, role: 'source', effect: 'read', payload: undefined, envelope,
  });
  assert.deepEqual(search, { q: 'top three Big Bear Lake restaurants', limit: 3 });

  const create = compileProofProviderArgs({
    schema: CREATE_SCHEMA, role: 'create', effect: 'external_write', payload: ROWS, envelope,
  });
  assert.ok(create);
  assert.deepEqual(JSON.parse(String(create.sheet_json)), ROWS);

  const twoStrings = compileProofProviderArgs({
    schema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } },
    role: 'source', effect: 'read', payload: undefined, envelope,
  });
  assert.deepEqual(twoStrings, {
    a: 'top three Big Bear Lake restaurants',
    b: 'top three Big Bear Lake restaurants',
  });
});

test.after(() => {
  installProductionTransport(null);
  closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});
