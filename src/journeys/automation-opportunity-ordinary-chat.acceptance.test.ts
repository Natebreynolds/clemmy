/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/journeys/automation-opportunity-ordinary-chat.acceptance.test.ts
 *
 * NEXT-TAG matrix row 8. A structurally durable request enters through the
 * exported Discord channel, shared bridge, primary model, tool_search, and
 * call_tool carrier. The only durable effect is one inert review proposal.
 * A bounded ordinary request through the same entrypoint creates none.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-automation-opportunity-chat-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';

mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-automation-opportunity-chat\n');
writeFileSync(path.join(HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}));

const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const runtimeConfig = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const opportunities = await import('../execution/automation-opportunity.js');
const opportunityStore = await import('../execution/automation-opportunity-store.js');
const memoryDb = await import('../memory/db.js');

const DURABLE_PROMPT = [
  'Every two hours, collect one record for each of 120 generated regions.',
  'Each region must retry independently, resume after restart, and preserve its canonical identity.',
  'Create only a reviewable automation opportunity for me; do not execute, schedule, create a workflow, or create a Space.',
].join(' ');
const BOUNDED_PROMPT = 'Summarize these three labels now in one sentence: alpha, beta, gamma.';
const PROPOSAL_KEY = 'generated_region_collection';

const OPPORTUNITY = opportunities.parseAutomationOpportunity({
  version: 1,
  title: 'Generated region collection',
  objective: 'Collect one canonical record for each declared generated region.',
  rationale: 'The work is recurring, partitioned, retryable, and must survive process restart.',
  lifetime: { kind: 'ongoing' },
  recurrence: {
    mode: 'proposed',
    cadence: { kind: 'interval', every: 2, unit: 'hour' },
    overlapPolicy: 'skip',
    catchUpPolicy: 'run_once',
    activation: 'requires_pilot_success_and_recurrence_consent',
  },
  trigger: { kind: 'recurrence' },
  partition: {
    mode: 'finite',
    keyFields: ['region_key'],
    dimensions: ['region'],
    checkpointEvery: 8,
    completion: { kind: 'exact_count', expected: 120 },
  },
  capabilityRequirements: [{
    id: 'region_read',
    description: 'Read the exact record for one declared region.',
    minimumEffect: 'read',
    constraints: ['The selected source must expose a current read-only contract.'],
  }],
  phases: [{
    id: 'collect_regions',
    objective: 'Collect one current record for every declared region.',
    dependsOn: [],
    capabilityRequirementIds: ['region_read'],
    effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 120 },
    partitioned: true,
    outputEvidence: ['Every completed partition retains one settled result reference.'],
  }],
  effectCeiling: { class: 'read', maxOperationsPerRun: 120 },
  dataset: {
    schema: {
      fields: [
        { name: 'region_key', type: 'string', required: true, sensitivity: 'public' },
        { name: 'record_value', type: 'string', required: true, sensitivity: 'public' },
      ],
      additionalFields: 'reject',
    },
    identity: {
      rules: [{ id: 'region_identity', fields: ['region_key'], match: 'exact', normalizers: ['trim'] }],
      ambiguousMatch: 'review_required',
    },
    merge: {
      mode: 'review_required',
      defaultConflict: 'review_required',
      fieldPolicies: [],
      preserveSourceRecords: true,
    },
    provenance: {
      required: true,
      retainSourceSnapshots: true,
      requiredReferences: ['source_ref', 'run_ref', 'observed_at'],
    },
  },
  deliverables: [{
    id: 'region_dataset',
    description: 'One reviewable canonical dataset snapshot.',
    kind: 'dataset_snapshot',
    required: true,
    successCriterionIds: ['all_regions'],
    evidence: ['The finite partition denominator is exactly 120.'],
  }],
  missingInputs: [],
  successCriteria: [{
    id: 'all_regions',
    description: 'All 120 declared region partitions settle with retained evidence.',
    evidence: ['The partition ledger reports 120 settled unique keys.'],
  }],
  pilot: {
    required: true,
    maxPartitions: 3,
    maxRecords: 3,
    effectCeiling: { class: 'read', maxOperationsPerRun: 3 },
    successCriterionIds: ['all_regions'],
    haltOnFailure: true,
  },
  budgets: {
    maxWallClockMinutesPerRun: 30,
    maxConcurrentPartitions: 8,
    maxAttemptsPerPartition: 3,
    maxPartitionsPerRun: 120,
    maxRecordsPerRun: 120,
    maxOperationsPerRun: 120,
    reserveOperations: 8,
  },
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function finalMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{
      type: 'output_text',
      text: JSON.stringify({
        summary: text,
        reply: text,
        done: true,
        nextAction: 'completed',
        reason: null,
      }),
    }],
  };
}

async function* streamResponse(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: typeof response.responseId === 'string' ? response.responseId : 'automation-opportunity-response',
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

interface Delivery {
  edits: string[];
  errors: string[];
  transport: {
    sendInitial(content: string): Promise<{ edit(content: string): Promise<void> }>;
    sendError(content: string): Promise<void>;
    sendFollowup(content: string): Promise<void>;
  };
}

function delivery(): Delivery {
  const edits: string[] = [];
  const errors: string[] = [];
  return {
    edits,
    errors,
    transport: {
      async sendInitial(content) {
        edits.push(content);
        return { async edit(next) { edits.push(next); } };
      },
      async sendError(content) { errors.push(content); },
      async sendFollowup(content) { edits.push(content); },
    },
  };
}

after(() => {
  bridge._setBridgeImplsForTests({});
  runtimeConfig.resetHarnessRuntimeConfig();
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  rmSync(HOME, { recursive: true, force: true });
});

test('ordinary structural request creates one inert review proposal while bounded chat creates none', {
  timeout: 60_000,
}, async () => {
  eventlog.resetEventLog();
  runtimeConfig.resetHarnessRuntimeConfig();
  const configured = await runtimeConfig.configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  let active: 'durable' | 'bounded' = 'durable';
  let durableStep = 0;
  let boundedStep = 0;
  const model = {
    async getResponse(rawRequest: unknown) {
      const serialized = JSON.stringify(rawRequest ?? {});
      const tools = (((rawRequest ?? {}) as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((entry) => entry.name ?? '')
        .filter(Boolean);
      if (active === 'bounded') {
        boundedStep += 1;
        assert.equal(boundedStep, 1);
        assert.equal(tools.length, 0, 'bounded answer-in-text does not advertise an action surface');
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [finalMessage('Alpha, beta, and gamma are the three requested labels.')],
          responseId: 'bounded-response-1',
        };
      }

      durableStep += 1;
      if (durableStep === 1) {
        assert.match(serialized, /Every two hours/);
        assert.ok(tools.includes('tool_search'));
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [functionCall('find-opportunity-tool', 'tool_search', {
            query: 'persist a reviewable automation opportunity for recurring partitioned restart-safe work',
            role_key: 'clause-0:write',
            limit: 8,
            cursor: null,
          })],
          responseId: 'durable-response-1',
        };
      }
      if (durableStep === 2) {
        assert.match(serialized, /automation_opportunity_propose/);
        assert.match(serialized, /call_tool/);
        assert.ok(tools.includes('call_tool'));
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [functionCall('persist-opportunity', 'call_tool', {
            name: 'automation_opportunity_propose',
            args_json: JSON.stringify({
              proposal_key: PROPOSAL_KEY,
              opportunity: OPPORTUNITY,
              note: 'Generated ordinary-channel structural evidence.',
            }),
          })],
          responseId: 'durable-response-2',
        };
      }
      assert.match(serialized, /executionAuthority/);
      assert.match(serialized, /user_review/);
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [finalMessage('I saved one inert automation opportunity for your review; nothing was run or scheduled.')],
        responseId: 'durable-response-3',
      };
    },
    getStreamedResponse: streamResponse,
  };

  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({
      ...options,
      model: model as never,
    }),
  });

  eventlog.createSession({
    id: 'automation-opportunity-durable-session',
    kind: 'chat',
    userId: 'automation-opportunity-user',
  });
  let durableSource: { seq: number; turn: number } | null = null;
  const durableDelivery = delivery();
  await discord.runDiscordHarnessConversation({
    prompt: DURABLE_PROMPT,
    rawPrompt: DURABLE_PROMPT,
    channelId: 'automation-opportunity-channel',
    userId: 'automation-opportunity-user',
    guildId: 'automation-opportunity-guild',
    transport: durableDelivery.transport,
    durableRequest: {
      sessionId: 'automation-opportunity-durable-session',
      runId: 'automation-opportunity-durable-run',
      onSourceAccepted(source: { seq: number; turn: number }) {
        durableSource = { seq: source.seq, turn: source.turn };
      },
    },
  });

  assert.ok(durableSource);
  assert.equal(durableStep, 3);
  assert.deepEqual(durableDelivery.errors, []);
  assert.match(durableDelivery.edits.at(-1) ?? '', /saved one inert automation opportunity/i);
  const proposals = opportunityStore.listAutomationOpportunityProposals({ limit: 10 });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.status, 'proposed');
  assert.equal(proposals[0]?.revision, 1);
  assert.deepEqual(proposals[0]?.opportunity, OPPORTUNITY);
  const revisions = opportunityStore.listAutomationOpportunityProposalRevisions(
    proposals[0]!.proposalId,
  );
  assert.equal(revisions.length, 1);
  assert.equal(
    revisions[0]?.actorRef,
    `accepted-source:automation-opportunity-durable-session#${durableSource!.seq}`,
  );

  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM pending_approvals`).get() as { n: number }).n, 0);
  assert.equal(eventlog.listEvents('automation-opportunity-durable-session', {
    types: ['turn_graph_shadow', 'turn_graph_compiled'],
  }).length, 0);
  assert.equal(eventlog.listEvents('automation-opportunity-durable-session', {
    types: ['conversation_completed'],
  }).length, 1);

  active = 'bounded';
  eventlog.createSession({
    id: 'automation-opportunity-bounded-session',
    kind: 'chat',
    userId: 'automation-opportunity-user',
  });
  const boundedDelivery = delivery();
  await discord.runDiscordHarnessConversation({
    prompt: BOUNDED_PROMPT,
    rawPrompt: BOUNDED_PROMPT,
    channelId: 'automation-opportunity-bounded-channel',
    userId: 'automation-opportunity-user',
    guildId: 'automation-opportunity-guild',
    transport: boundedDelivery.transport,
    durableRequest: {
      sessionId: 'automation-opportunity-bounded-session',
      runId: 'automation-opportunity-bounded-run',
    },
  });
  assert.equal(boundedStep, 1);
  assert.deepEqual(boundedDelivery.errors, []);
  assert.equal(opportunityStore.listAutomationOpportunityProposals({ limit: 10 }).length, 1,
    'bounded ordinary chat creates no automation proposal');
});
