/** Run: node scripts/run-tests-isolated.mjs src/runtime/graph/host-bind-mszlpidc.test.ts
 *
 * THE sess-synthetic-006 REPLAY (live 2026-08-19, Discord, grok-4.6): "top 5 big
 * bear lake restaurants based on Google reviews … add them to a Google sheet
 * with the data". Semantics ADMITTED collect_then_construct (N=5, create_new
 * spreadsheet) with operations: []. The harness then swung between two
 * illegal answers on consecutive turns:
 *   seq 59097 — BLOCKED "Connect the missing provider" (Sheets and Firecrawl
 *     were connected);
 *   seq 59117–59121 — legacy fallthrough, ask_user_question about column
 *     layout the user already answered, then run_failed.
 *
 * These pins replay the turn against a CONNECTED-shaped registry fixture —
 * the same port production fills from live Composio connections × the durable
 * tool-contract store — never a planted resolver:
 *   - the admission-time enumeration proves search+row-create+readback from
 *     CONNECTED reality and records it for THIS source;
 *   - host-bind fills operations; dispatch is typed; the search crossing
 *     carries the frozen `q`; exactly ONE spreadsheet create (title AND
 *     sheet_name filled from the goal); readback of THIS seq's resource;
 *     run_artifacts holds the id; ZERO awaiting_user_input; ZERO
 *     "Connect the missing provider";
 *   - Slack, ADD_SHEET (tab write), and DataForSEO keywords-for-site are
 *     structurally rejected — recency is not a goal catalog;
 *   - tool-memory previously_failed does NOT hide a connected create;
 *   - with the goal families genuinely absent from the CONNECTED registry,
 *     the turn blocks naming the missing FAMILY — still no ask_user_question
 *     and no legacy tool_search theater.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-bind-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-host-bind\n', 'utf8');

const { appendEvent, createSession, listEvents, openEventLog, closeEventLog } = await import('../harness/eventlog.js');
const { admitAndCompileAcceptedSource } = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('../semantic-boundary/typed-source-dispatch.js');
const { installTurnSemanticModelPort } = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { configureTypedExecutionRuntime } = await import('../semantic-boundary/configure-typed-execution-runtime.js');
configureTypedExecutionRuntime();
const { entailedPlanGroundingJudge, fakeSemanticProposal } = await import('../semantic-boundary/fake-semantic-model.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
const { installProductionTransport } = await import('../harness/production-capability-adapters.js');
const { installConnectedRegistryPort } = await import('../harness/connected-goal-catalog.js');
const { turnGraphFromShadowEvent } = await import('./turn-graph-shadow.js');
const { getTurnGraphEventForSource } = await import('../harness/eventlog.js');

saveProactivityPolicy({ autoApproveScope: 'yolo' });

const LIVE_TEXT = 'Find me the top 5 big bear lake restaurants based on Google reviews add them to a Google sheet with the data';

const SEARCH_SCHEMA = { type: 'object', required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'integer' } } };
// The REAL live contract shape: title AND sheet_name AND sheet_json required.
const SHEET_FROM_JSON_SCHEMA = { type: 'object', required: ['title', 'sheet_name', 'sheet_json'], properties: { title: { type: 'string' }, sheet_name: { type: 'string' }, sheet_json: { type: 'string' } } };
const BATCH_GET_SCHEMA = { type: 'object', required: ['spreadsheet_id'], properties: { spreadsheet_id: { type: 'string' }, ranges: { type: 'array' } } };
const ADD_SHEET_SCHEMA = { type: 'object', required: ['spreadsheet_id', 'title'], properties: { spreadsheet_id: { type: 'string' }, title: { type: 'string' } } };
const SLACK_SCHEMA = { type: 'object', required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' } } };
// keywords-for-site: its required field needs a TARGET the objective does not
// carry as a query — structurally not a goal search.
const DATAFORSEO_SCHEMA = { type: 'object', required: ['target', 'location_code'], properties: { target: { type: 'string' }, location_code: { type: 'integer' } } };
const CREATE1_SCHEMA = { type: 'object', required: ['title', 'values'], properties: { title: { type: 'string' }, values: { type: 'array' } } };

const ROWS = [
  { title: 'Peppercorn Grille', rating: '4.5', phone: '909-866-5405' },
  { title: 'The Pines Lakefront', rating: '4.6', phone: '909-866-5551' },
  { title: 'Saucy Mamas', rating: '4.4', phone: '909-866-7667' },
  { title: 'Nottinghams', rating: '4.3', phone: '909-866-4644' },
  { title: 'Azteca Grill', rating: '4.4', phone: '909-866-7551' },
];

const CONNECTED_REGISTRY = {
  connectedToolkits: ['firecrawl', 'googlesheets', 'slack', 'dataforseo'],
  tools: [
    { slug: 'FIRECRAWL_SEARCH', schema: SEARCH_SCHEMA },
    { slug: 'GOOGLESHEETS_SHEET_FROM_JSON', schema: SHEET_FROM_JSON_SCHEMA },
    { slug: 'GOOGLESHEETS_BATCH_GET', schema: BATCH_GET_SCHEMA },
    { slug: 'GOOGLESHEETS_ADD_SHEET', schema: ADD_SHEET_SCHEMA },
    { slug: 'SLACK_SEND_MESSAGE', schema: SLACK_SCHEMA },
    { slug: 'DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE', schema: DATAFORSEO_SCHEMA },
  ],
};

function seedSchemas(): void {
  for (const tool of CONNECTED_REGISTRY.tools) rememberToolSchema(tool.slug, tool.schema);
  rememberToolSchema('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', CREATE1_SCHEMA);
}

/** The live admitted payload: full construct, EMPTY operations. */
function installEmptyOpsPort(): void {
  installTurnSemanticModelPort({
    async interpret(call) {
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: 'Top 5 Big Bear Lake restaurants by Google reviews, with the data, in one new Google sheet.',
            criteria: [
              { id: 'c-set', statement: 'Five restaurants ranked by reviews are present.' },
              { id: 'c-dest', statement: 'A new Google sheet holds them with the data.' },
            ],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'collect_then_construct',
            cardinality: { count: 5, fields: ['title', 'rating', 'phone'] },
            destination: { posture: 'create_new', family: 'spreadsheet', handleRequired: true },
            requestedEffect: 'external_write',
            operations: [],
            deliverables: [{ id: 'artifact', kind: 'spreadsheet' }],
            evidenceRequirements: ['collection', 'create-receipt', 'readback'],
          } as never,
        }, call.host),
        modelIdentity: 'mt05r35h-replay',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'mt05r35h-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'mt05r35h-grounding');
    },
  });
}

function freshTurn(id: string): { sessionId: string; seq: number } {
  const session = createSession({ id, kind: 'chat', userId: 'user-mt05r35h' });
  const source = appendEvent({
    sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: LIVE_TEXT },
  });
  return { sessionId: session.id, seq: source.seq };
}




test.after(() => {
  installConnectedRegistryPort(null);
  installProductionTransport(null);
  closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});
// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19, Nathan's directive):
// "No routers. Everything goes through the model with tools attached."
// The tests removed below pinned the CHAT ceremony doctrine (model proposal +
// judges routing live turns into the typed executor). That doctrine is
// retired: live turns are always unparticipated -> untyped shadow graph ->
// ONE model turn WITH tools; writes gate at the carrier. The typed executor
// and its authority machinery survive as the WORKFLOW-REPLAY engine (see
// fast-lane-collect-construct.test.ts REPLAY MACHINERY + TAMPER pins,
// physical-authority / physical-dispatch-grounding / plan-grounding /
// interpret-accepted-source suites, all green). When the replay entry seam
// lands, its golden pins are re-derived from the removed tests via git
// history of this file.
// ============================================================================
