/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/harness-memory-efficiency.acceptance.test.ts
 *
 * Follow-on acceptance for the natural restaurant -> Sheet journey. These
 * checks deliberately stop before execution authority: verified memory may
 * remove discovery/schema/context work, while logical calls, leases and
 * physical crossings remain owned by the current accepted task.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-efficiency-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_AUTO_COMPACT = 'layer1_only';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-memory-efficiency\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const graphShadow = await import('../runtime/graph/turn-graph-shadow.js');
const brackets = await import('../runtime/harness/brackets.js');
const composio = await import('../tools/composio-tools.js');
const schemaCache = await import('../tools/composio-schema-cache.js');
const learningWorker = await import('../memory/learning-worker.js');
const capabilityCandidates = await import('../runtime/read-path/capability-candidates.js');
const discovery = await import('../runtime/harness/discovery-governor.js');
const toolSearch = await import('../tools/tool-search-tool.js');
const dispatch = await import('../runtime/harness/dispatch-ledger.js');
const resultHandles = await import('../runtime/harness/result-handle.js');
const outputFormat = await import('../runtime/harness/tool-output-format.js');
const outputContext = await import('../runtime/harness/tool-output-context.js');
const compaction = await import('../runtime/harness/compaction.js');
const tokenEstimator = await import('../runtime/harness/token-estimator.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const reflection = await import('../memory/reflection.js');

let hiddenLearningModelCalls = 0;
reflection._testOnly_setReflectionExtractor(async () => {
  hiddenLearningModelCalls += 1;
  return { facts: [], entities: [], pointers: [] };
});

after(() => {
  reflection._testOnly_setReflectionExtractor(null);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

// Keep the warm-memory proof on the source clause. The compound restaurant ->
// Sheet journey has its own plan-task acceptance; this test isolates memory's
// advisory cost effect from execution planning and destination authority.
const PROMPT = 'Find me 10 restaurants in Santa Clarita';
const RESTAURANT_OPERATION = 'RESTAURANTS_SEARCH';
const SEARCH_ARGS = Object.freeze({
  location: 'Santa Clarita, CA',
  category: 'restaurant',
  limit: 10,
});
const ROWS = Object.freeze(Array.from({ length: 10 }, (_, index) => ({
  name: `Restaurant ${index + 1}`,
  category: index % 2 === 0 ? 'American' : 'Mexican',
  rating: 4.9 - index / 20,
  address: `${100 + index} Main St, Santa Clarita, CA`,
})));

// A realistic provider contract has far more optional shape than the three
// keys this request needs. Warm memory renders only the exact required keys;
// cold schema discovery pays for the full definition.
const RESTAURANT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['location', 'category', 'limit'],
  properties: {
    location: { type: 'string', description: 'City, region, or exact geographic search area.' },
    category: { type: 'string', description: 'Business or cuisine category to match.' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
    ...Object.fromEntries(Array.from({ length: 90 }, (_, index) => [
      `optional_provider_filter_${index}`,
      {
        type: 'string',
        description: `Optional provider filter ${index}; omitted for this request. ${'metadata '.repeat(7)}`,
      },
    ])),
  },
});

function acceptedSource(label: string, text: string, withGraph = false) {
  const session = eventlog.createSession({
    id: `${label}-${randomUUID()}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  if (withGraph) {
    assert.ok(graphShadow.recordTurnGraphShadow({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    }));
  }
  return { session, source };
}

function acceptedLearningSource(label: string, text: string) {
  const session = eventlog.createSession({
    id: `${label}-${randomUUID()}`,
    kind: 'chat',
  });
  const attempt = eventlog.beginRunAttempt(session.id, {});
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text, attemptId: attempt.attemptId, source: 'test' },
  }, { armRunInFlight: true });
  assert.ok(graphShadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return { session, source, attempt };
}

function authorityCounts(sessionId: string, sourceUserSeq: number) {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls
        WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM run_dispatch_leases
        WHERE session_id = ? AND source_user_seq = ?) AS call_leases,
      (SELECT COUNT(*) FROM physical_dispatches
        WHERE session_id = ? AND source_user_seq = ?) AS physical_dispatches,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND source_user_seq = ?) AS settlements,
      (SELECT COUNT(*) FROM accepted_turn_call_authorities
        WHERE session_id = ? AND source_user_seq = ?) AS call_authorities,
      (SELECT COUNT(*) FROM accepted_task_resolutions
        WHERE session_id = ? AND source_user_seq = ?) AS accepted_task_resolutions
  `).get(
    sessionId, sourceUserSeq,
    sessionId, sourceUserSeq,
    sessionId, sourceUserSeq,
    sessionId, sourceUserSeq,
    sessionId, sourceUserSeq,
    sessionId, sourceUserSeq,
  ) as Record<string, number>;
}

function globalAuthorityCounts() {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls) AS logical_calls,
      (SELECT COUNT(*) FROM run_dispatch_leases) AS call_leases,
      (SELECT COUNT(*) FROM physical_dispatches) AS physical_dispatches,
      (SELECT COUNT(*) FROM logical_call_settlements) AS settlements,
      (SELECT COUNT(*) FROM accepted_turn_call_authorities) AS call_authorities,
      (SELECT COUNT(*) FROM accepted_task_resolutions) AS accepted_task_resolutions
  `).get() as Record<string, number>;
}

function unresolvedCount(value: capabilityCandidates.TurnCapabilityCandidates): number {
  return value.requirements.filter((requirement) => !requirement.resolved).length;
}

test('verified warm memory removes one discovery/schema round while minting zero current-task authority', async () => {
  const cold = await capabilityCandidates.resolveTurnCapabilityCandidates({
    userInput: PROMPT,
    choices: [],
    semantic: false,
    liveSchemaFingerprintFor: () => null,
  });
  assert.equal(cold.candidates.length, 0);
  assert.ok(unresolvedCount(cold) >= 1, JSON.stringify(cold.requirements));

  const learning = acceptedLearningSource('memory-learning', PROMPT);
  schemaCache.rememberToolSchema(RESTAURANT_OPERATION, RESTAURANT_SCHEMA, Date.now());
  const readOutput = await brackets.withHarnessRunContext({
    sessionId: learning.session.id,
    sourceUserSeq: learning.source.seq,
    turn: 1,
    runAttemptId: learning.attempt.attemptId,
    counter: new brackets.ToolCallsCounter(20),
  }, () => composio.runComposioExecuteForTestInSession(
    RESTAURANT_OPERATION,
    SEARCH_ARGS,
    (async () => ({
      successful: true,
      data: {
        items: ROWS,
        total: ROWS.length,
        has_more: false,
      },
    })) as never,
    learning.session.id,
  ));
  assert.ok(String(readOutput).length > 0);
  await learningWorker.drainPendingLearning();
  assert.equal(
    eventlog.listEvents(learning.session.id, { types: ['read_receipt'] }).length,
    1,
    `only a settled verified read may teach the later turn; output=${String(readOutput)} events=${JSON.stringify(eventlog.listEvents(learning.session.id).map((event) => ({ type: event.type, data: event.data })))}`,
  );

  const liveFingerprint = schemaCache.liveComposioSchemaFingerprint(RESTAURANT_OPERATION);
  assert.ok(liveFingerprint);
  let schemaRefreshCalls = 0;
  const warmSource = acceptedSource('memory-warm', PROMPT, false);
  const globalBeforeMemoryResolve = globalAuthorityCounts();
  const warm = await capabilityCandidates.resolveTurnCapabilityCandidates({
    userInput: PROMPT,
    semantic: false,
    liveSchemaFingerprintFor: (identifier) => (
      identifier === RESTAURANT_OPERATION ? liveFingerprint : null
    ),
    ensureLiveSchemaFingerprintFor: async () => {
      schemaRefreshCalls += 1;
      return liveFingerprint;
    },
  });
  const warmCard = capabilityCandidates.renderCapabilityCandidateCard(warm);
  assert.deepEqual(
    globalAuthorityCounts(),
    globalBeforeMemoryResolve,
    'candidate retrieval/card rendering must not mint authority for any task',
  );

  const remembered = warm.candidates.find((candidate) => (
    candidate.identifier === RESTAURANT_OPERATION
  ));
  assert.ok(remembered, JSON.stringify(warm));
  assert.equal(remembered.via, 'exact');
  assert.equal(remembered.schemaAuthority, 'live');
  assert.deepEqual(remembered.requiredFields, ['location', 'category', 'limit']);
  assert.ok(remembered.verifiedReadOrigin, 'the exact candidate retains its durable receipt provenance');
  assert.equal(schemaRefreshCalls, 0, 'the current cached contract avoids a provider schema refresh');
  assert.ok(
    unresolvedCount(warm) < unresolvedCount(cold),
    `warm memory must remove at least one discovery role: cold=${JSON.stringify(cold.requirements)} warm=${JSON.stringify(warm.requirements)}`,
  );

  // Resolve/render is advisory-only. Before a current call is admitted it has
  // created no graph, host authority, logical call, lease, crossing or result.
  assert.deepEqual(authorityCounts(warmSource.session.id, warmSource.source.seq), {
    logical_calls: 0,
    call_leases: 0,
    physical_dispatches: 0,
    settlements: 0,
    call_authorities: 0,
    accepted_task_resolutions: 0,
  });

  const sourceRole = cold.requirements.find((requirement) => requirement.effect === 'read')?.roleKey;
  assert.ok(sourceRole);
  const coldGovernor = new discovery.DiscoveryGovernor();
  coldGovernor.initializeTask({
    sessionId: warmSource.session.id,
    sourceUserSeq: warmSource.source.seq,
    knownCapability: false,
  });
  const coldPolicy = coldGovernor.initializeRoles({
    sessionId: warmSource.session.id,
    sourceUserSeq: warmSource.source.seq,
    requirements: cold.requirements,
    brokerCoverage: 'authorized_external_v1',
  });
  assert.ok(coldPolicy.policy.broadDiscoveryAllowance > 0);

  const warmPolicySession = acceptedSource('memory-warm-policy', PROMPT, false);
  const warmGovernor = new discovery.DiscoveryGovernor();
  warmGovernor.initializeTask({
    sessionId: warmPolicySession.session.id,
    sourceUserSeq: warmPolicySession.source.seq,
    knownCapability: true,
  });
  const warmPolicy = warmGovernor.initializeRoles({
    sessionId: warmPolicySession.session.id,
    sourceUserSeq: warmPolicySession.source.seq,
    requirements: warm.requirements,
    brokerCoverage: 'authorized_external_v1',
  });
  assert.ok(
    warmPolicy.policy.broadDiscoveryAllowance < coldPolicy.policy.broadDiscoveryAllowance,
    'receipt-backed resolution narrows the task discovery allowance',
  );
  const warmSourceRole = warm.requirements.find((requirement) => requirement.roleKey === sourceRole);
  assert.equal(warmSourceRole?.resolved, true);
  const warmSourceSearch = warmGovernor.admit({
    sessionId: warmPolicySession.session.id,
    sourceUserSeq: warmPolicySession.source.seq,
    category: 'broad_discovery',
    subject: sourceRole!,
    callId: 'redundant-warm-source-search',
  });
  assert.equal(warmSourceSearch.admitted, true);
  if (warmSourceSearch.admitted) {
    assert.equal(warmSourceSearch.reason, 'role_coerced');
    assert.equal(warmSourceSearch.subject, discovery.HOST_UNSCOPED_DISCOVERY_SUBJECT);
    assert.match(String(warmSourceSearch.advisory ?? ''), /already resolved/i);
  }
  const repeatedWarmSourceSearch = warmGovernor.admit({
    sessionId: warmPolicySession.session.id,
    sourceUserSeq: warmPolicySession.source.seq,
    category: 'broad_discovery',
    subject: sourceRole!,
    callId: 'redundant-warm-source-search-2',
  });
  assert.equal(repeatedWarmSourceSearch.admitted, false);
  if (!repeatedWarmSourceSearch.admitted) {
    assert.equal(repeatedWarmSourceSearch.reason, 'new_call_requires_retry_epoch');
  }

  // Quantify the bytes excluded from the next model step. This drives the real
  // broker renderer with the same full provider contract; the warm card keeps
  // only exact identity, provenance and required argument names.
  let providerListings = 0;
  let advertisedToolSearchShape: unknown;
  let handler: ((input: { query: string; role_key?: string; limit?: number }) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>) | undefined;
  toolSearch.registerToolSearchTool({
    tool(_name: string, _description: string, schema: unknown, execute: typeof handler) {
      advertisedToolSearchShape = schema;
      handler = execute;
    },
  } as unknown as McpServer, {
    dispatchCarrier: 'work_call',
    candidateSources: [{
      kind: 'authorized_composio',
      async search() {
        providerListings += 1;
        return [{
          name: RESTAURANT_OPERATION,
          summary: 'Search restaurant listings by location and category.',
          schema: RESTAURANT_SCHEMA,
          carrier: 'work_call' as const,
        }];
      },
    }],
  });
  assert.ok(handler);
  const coldDiscovery = await handler!({
    query: 'find restaurants by location and category',
    role_key: sourceRole!,
    limit: 8,
  });
  const coldCard = capabilityCandidates.renderCapabilityCandidateCard(cold);
  const discoveryBytes = Buffer.byteLength(coldDiscovery.content[0]!.text, 'utf8');
  assert.ok(advertisedToolSearchShape && typeof advertisedToolSearchShape === 'object');
  const firstModelToolSchemaBytes = Buffer.byteLength(JSON.stringify(
    z.toJSONSchema(z.object(advertisedToolSearchShape as z.ZodRawShape)),
  ), 'utf8');
  const coldCost = {
    primaryModelCalls: 1 + Number(unresolvedCount(cold) > 0),
    hiddenLearningModelCalls,
    toolSearchCalls: providerListings,
    firstModelToolSchemaBytes,
    modelVisibleRoutingBytes: firstModelToolSchemaBytes
      + discoveryBytes
      + Buffer.byteLength(coldCard, 'utf8'),
  };
  const warmCost = {
    primaryModelCalls: 1 + Number(unresolvedCount(warm) > 0),
    hiddenLearningModelCalls,
    toolSearchCalls: 0,
    firstModelToolSchemaBytes,
    modelVisibleRoutingBytes: firstModelToolSchemaBytes
      + Buffer.byteLength(warmCard, 'utf8'),
  };
  assert.equal(providerListings, 1);
  assert.deepEqual(
    { cold: coldCost.primaryModelCalls, warm: warmCost.primaryModelCalls },
    { cold: 2, warm: 1 },
    'one unresolved source pays one model/search/result round; exact warm routing does not',
  );
  assert.equal(coldCost.hiddenLearningModelCalls, 0);
  assert.equal(warmCost.hiddenLearningModelCalls, 0);
  assert.deepEqual(
    { cold: coldCost.toolSearchCalls, warm: warmCost.toolSearchCalls },
    { cold: 1, warm: 0 },
  );
  assert.ok(firstModelToolSchemaBytes <= 4_096,
    `the generic first-model discovery schema exceeded its competitive ceiling: ${firstModelToolSchemaBytes}`);
  assert.ok(warmCost.modelVisibleRoutingBytes < coldCost.modelVisibleRoutingBytes,
    `warm routing was not strictly cheaper: ${JSON.stringify({ coldCost, warmCost })}`);
  assert.ok(discoveryBytes > 1_500, `fixture must represent a material schema cost, got ${discoveryBytes}`);
  assert.ok(Buffer.byteLength(warmCard, 'utf8') < 3_500, 'warm context is a compact capability hint');
  assert.ok(
    Buffer.byteLength(warmCard, 'utf8')
      < Buffer.byteLength(coldCard, 'utf8') + discoveryBytes,
    'the next model input omits the cold schema-result payload and discovery round',
  );
  assert.doesNotMatch(warmCard, /optional_provider_filter_89/,
    'optional provider schema bulk never enters warm model context');
});

function toolCall(callId: string): AgentInputItem {
  return {
    type: 'function_call',
    callId,
    name: 'restaurant_page_read',
    arguments: JSON.stringify({ page: callId }),
    status: 'completed',
  } as unknown as AgentInputItem;
}

function toolResult(callId: string, text: string): AgentInputItem {
  return {
    type: 'function_call_result',
    callId,
    name: 'restaurant_page_read',
    output: { type: 'text', text },
    status: 'completed',
  } as unknown as AgentInputItem;
}

test('large results stay lossless behind handles while model-visible growth is capped', () => {
  const task = acceptedSource('large-result', 'Collect the complete restaurant catalog.', true);
  const args = { query: 'restaurants', limit: 3_000 };
  const logicalToolCallId = 'large-result-call';
  const physicalDispatchId = 'large-result-dispatch';
  const acceptedTaskId = identities.acceptedTaskIdFor(task.session.id, task.source.seq);
  const begun = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: task.session.id,
      sourceUserSeq: task.source.seq,
      acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId,
      ordinal: 1,
    },
    tool: 'restaurant_catalog_read',
    args,
  });
  assert.equal(begun.status, 'inserted');
  if (begun.status !== 'inserted') return;
  assert.equal(dispatch.settlePhysicalDispatch({
    identity: begun.identity,
    tool: 'restaurant_catalog_read',
    outcome: 'returned',
  }).status, 'inserted');

  const raw = {
    successful: true,
    records: Array.from({ length: 3_000 }, (_, index) => ({
      id: `restaurant-${index}`,
      name: `Restaurant ${index}`,
      description: `${createHash('sha256').update(String(index)).digest('hex')}-${'detail'.repeat(100)}`,
    })),
    total: 3_000,
    has_more: false,
  };
  const authority: resultHandles.ResultHandleAuthority = {
    sessionId: task.session.id,
    sourceUserSeq: task.source.seq,
    acceptedTaskId,
    logicalToolCallId,
    physicalDispatchId,
    toolName: 'restaurant_catalog_read',
    args,
  };
  const handle = resultHandles.toResultHandle(raw, { authority });
  assert.ok(handle.rawLocation);
  assert.equal(handle.recordCount, 3_000);
  assert.ok(
    Buffer.byteLength(JSON.stringify(handle.projectedRecords), 'utf8')
      <= resultHandles.RESULT_PROJECTION_MAX_BYTES,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(handle), 'utf8') < 20_000,
    'the model-facing result handle stays bounded independently of raw size');
  const redeemed = resultHandles.redeemRawResult(handle.rawLocation!, authority);
  assert.equal(redeemed.status, 'ok');
  if (redeemed.status === 'ok') assert.deepEqual(redeemed.value, raw);

  const rawText = JSON.stringify(raw);
  const compact = outputContext.withToolOutputContext({
    sessionId: task.session.id,
    sourceUserSeq: task.source.seq,
    callId: logicalToolCallId,
    toolName: 'restaurant_catalog_read',
    settlementNonce: randomUUID(),
  }, () => outputFormat.formatRecallableToolText(rawText)) as string;
  assert.ok(
    compact.length <= outputFormat.DEFAULT_TOOL_RESULT_MAX_CHARS + 2_000,
    `one model-facing result exceeded the spill budget: ${compact.length}`,
  );
  assert.match(compact, /recall_tool_result|tool_output_query|exact-output-receipt/i);
  assert.equal(eventlog.getToolOutput(task.session.id, logicalToolCallId)?.output, rawText,
    'the compact model view does not replace the lossless side-store bytes');

  // Worst case: every tool returns the full 20K model-visible ceiling. Same-
  // turn compaction retains a small recent working set and a bounded recall
  // ledger, so 80 complex steps do not resend 80 results on step 81.
  const items: AgentInputItem[] = [{ role: 'user', content: 'Research every restaurant.' } as AgentInputItem];
  for (let index = 0; index < 80; index += 1) {
    const callId = `bounded-call-${index}`;
    const output = `result ${index} ${createHash('sha256').update(callId).digest('hex')} ${'x'.repeat(19_900)}`;
    eventlog.writeToolOutput({
      sessionId: task.session.id,
      callId,
      tool: 'restaurant_page_read',
      output,
    });
    items.push(toolCall(callId), toolResult(callId, output));
  }
  const beforeTokens = tokenEstimator.estimateInputTokens(items);
  const bounded = compaction.compactInFlightToolContext(items, task.session.id);
  assert.equal(bounded.applied, true);
  assert.ok(bounded.collapsed >= 70, JSON.stringify(bounded));
  assert.ok(bounded.afterTokens < 32_000, JSON.stringify(bounded));
  assert.ok(bounded.afterTokens * 5 < beforeTokens,
    `context did not converge to a bounded working set: before=${beforeTokens} after=${bounded.afterTokens}`);
  assert.ok(bounded.retainedPairs >= 3 && bounded.retainedPairs <= 8);
  assert.deepEqual(
    eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM tool_outputs
       WHERE session_id = ? AND call_id LIKE 'bounded-call-%'
    `).get(task.session.id) as { n: number },
    { n: 80 },
    'every collapsed output remains exactly recallable',
  );
});
