/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/tools/plan-tools-completeness.red.test.ts
 *
 * A mixed read-then-write request must never freeze a read-only subset. The
 * refusal is recoverable: disclose the exact missing write, include it in the
 * retry, and the same accepted source can still admit normally.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-completeness-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-plan-completeness\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const brackets = await import('../runtime/harness/brackets.js');
const capabilityEnvelopes = await import('../agents/capability-envelope.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const expectedWork = await import('../runtime/harness/expected-work-contract.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const { hostRunRunner } = await import('../runtime/harness/host-turn-runner.js');
const { buildScopedLocalToolSearch } = await import('./local-runtime-tools.js');
const { buildPlanTaskTool } = await import('./plan-tools.js');

type Planning = Awaited<ReturnType<typeof semantic.primePrimaryModelPlanningCatalog>> extends infer R
  ? Extract<R, { ok: true }>['planning']
  : never;

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function discloseLocal(
  planning: Planning,
  name: 'user_profile_read' | 'workflow_create',
): Promise<string> {
  const search = buildScopedLocalToolSearch(
    new Set([name]),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: planning.authority,
      candidates,
    }),
  );
  const raw = await search.invoke(
    new RunContext({ sessionId: planning.identity.sessionId }),
    JSON.stringify({ query: name, role_key: null, limit: 8 }),
  );
  const body = JSON.parse(String(raw)) as {
    results: Array<{ name: string; capabilityRef?: string }>;
  };
  const capabilityRef = body.results.find((result) => result.name === name)?.capabilityRef;
  assert.equal(typeof capabilityRef, 'string', String(raw));
  return capabilityRef!;
}

const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

async function* testModelStream(
  this: { getResponse: (request: unknown) => Promise<{ output: unknown[]; responseId: string }> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: {
      type: 'finish',
      finishReason: response.output.some((item) => (item as { type?: string }).type === 'function_call')
        ? 'tool_calls'
        : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        requests: 1,
        inputTokensDetails: [],
        outputTokensDetails: [],
      },
      output: response.output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('Runner.run must not own this host-v1 turn');
  };
  return runner;
}

test('mixed-source read-only plan refuses before persistence, then exact write retry admits', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());

  const session = eventlog.createSession({ id: 'plan-completeness-mixed-source', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Read my current user profile, then create a new workflow named Profile Snapshot based on it.',
    },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const readRef = await discloseLocal(primed.planning, 'user_profile_read');
  assert.equal(readRef, 'cap:local:user_profile_read:read');
  const writeRef = await discloseLocal(primed.planning, 'workflow_create');
  assert.equal(writeRef, 'cap:local:workflow_create:reversible');
  const planTask = brackets.wrapToolForHarness(
    buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  const deliveredPreambles: string[] = [];

  const readOnlyDraft = {
    criteria: ['Read the current local profile before creating the requested workflow.'],
    cardinality: null,
    destination: null,
    topology: {
      version: 1,
      operations: [{
        id: 'read_profile',
        effect: 'read',
        coverage: 'single',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    bindings: [{
      operationId: 'read_profile',
      role: 'source',
      capabilityRef: readRef,
      evidence: ['tool_result'],
    }],
    deliverables: [{ id: 'profile_evidence', kind: 'evidence' }],
    evidenceRequirements: ['tool_result'],
  };
  const completeDraft = {
    criteria: ['Read the current profile and durably create one Profile Snapshot workflow from it.'],
    cardinality: { count: 1, fields: ['preferredName'] },
    destination: { posture: 'create_new', family: 'workflow', handleRequired: true },
    topology: {
      version: 1,
      operations: [
        {
          id: 'read_profile',
          effect: 'read',
          coverage: 'single',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          id: 'create_workflow',
          effect: 'local_write',
          coverage: null,
          dependsOn: ['read_profile'],
          dataFrom: ['read_profile'],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
    bindings: [
      {
        operationId: 'read_profile',
        role: 'source',
        capabilityRef: readRef,
        evidence: ['tool_result'],
      },
      {
        operationId: 'create_workflow',
        role: 'destination',
        capabilityRef: writeRef,
        evidence: ['local_commit_receipt'],
      },
    ],
    deliverables: [{ id: 'profile_snapshot_workflow', kind: 'workflow' }],
    evidenceRequirements: ['tool_result', 'local_commit_receipt'],
  };
  const missingLineageDraft = structuredClone(completeDraft);
  missingLineageDraft.topology.operations[1]!.dataFrom = [];

  let modelCalls = 0;
  let refusalObservedBeforeRetry = false;
  let lineageRepairObservedBeforeRetry = false;
  let admissionObservedAfterRetry = false;
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          responseId: 'plan-completeness-response-1',
          output: [toolCall('plan-read-only-subset', 'plan_task', {
            preamble: 'I’ll read the profile and create the workflow now.',
            draft: readOnlyDraft,
          })],
        };
      }
      if (modelCalls === 2) {
        assert.match(
          JSON.stringify(request),
          /plan_incomplete_missing_write/,
          'the typed completeness refusal reaches the model before its retry',
        );
        assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
        assert.equal(eventlog.listEvents(session.id, {
          types: ['accepted_task_authority_armed', 'conversation_preamble'],
        }).length, 0);
        assert.deepEqual(expectedWork.loadExpectedWorkContract(session.id, source.seq), { status: 'missing' });
        assert.deepEqual(deliveredPreambles, []);
        refusalObservedBeforeRetry = true;
        return {
          responseId: 'plan-completeness-response-2',
          output: [toolCall('plan-missing-lineage-retry', 'plan_task', {
            preamble: 'I’ll read the profile and create the workflow now.',
            draft: missingLineageDraft,
          })],
        };
      }
      if (modelCalls === 3) {
        assert.match(
          JSON.stringify(request),
          /plan_incomplete_data_lineage/,
          'the typed payload-lineage repair reaches the model without becoming a user question',
        );
        assert.match(JSON.stringify(request), /dependsOn does not authorize or retain payload consumption/);
        assert.doesNotMatch(JSON.stringify(request), /ask_user_question/);
        assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
        assert.equal(eventlog.listEvents(session.id, {
          types: ['accepted_task_authority_armed', 'conversation_preamble', 'awaiting_user_input'],
        }).length, 0);
        assert.deepEqual(expectedWork.loadExpectedWorkContract(session.id, source.seq), { status: 'missing' });
        assert.deepEqual(deliveredPreambles, []);
        lineageRepairObservedBeforeRetry = true;
        return {
          responseId: 'plan-completeness-response-3',
          output: [toolCall('plan-complete-retry', 'plan_task', {
            preamble: 'I’ll read the profile and create the workflow now.',
            draft: completeDraft,
          })],
        };
      }
      assert.ok(eventlog.getTurnGraphEventForSource(session.id, source.seq));
      const contract = expectedWork.loadExpectedWorkContract(session.id, source.seq);
      assert.equal(contract.status, 'ok', JSON.stringify(contract));
      if (contract.status === 'ok') {
        assert.deepEqual(
          contract.contract.operations.map((operation) => [operation.id, operation.effect]),
          [['create_workflow', 'local_write'], ['read_profile', 'read']],
        );
      }
      assert.deepEqual(deliveredPreambles, ['I’ll read the profile and create the workflow now.']);
      admissionObservedAfterRetry = true;
      return {
        responseId: `plan-completeness-response-${modelCalls}`,
        output: [{
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The complete plan is admitted.' }],
        }],
      };
    },
    getStreamedResponse: testModelStream,
  };
  const agent = { model, tools: [planTask] };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: [planTask],
    activeToolNames: [planTask.name],
    policyHash: 'plan-completeness-test-v1',
    budget: {
      maxUncachedTokens: 2_000,
      maxModelCalls: 8,
      maxToolCalls: 8,
      maxElapsedMs: 60_000,
    },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  if (!sealed.ok) return;
  capabilityEnvelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
  capabilityEnvelopes.bindAgentCapabilityRevision(agent, sealed.revision);

  let runError: unknown;
  try {
    await brackets.withHarnessRunContext({
      ...identity,
      counter: new brackets.ToolCallsCounter(10),
      behaviorScopeId: `${identity.sessionId}::turn:1`,
      onConversationPreamble: async (request) => {
        deliveredPreambles.push(request.text);
        return { status: 'already_delivered' as const };
      },
    }, () => hostRunRunner(
      throwingRunner() as never,
      agent as never,
      [{ type: 'message', role: 'user', content: source.data.text }] as never,
      {
        maxTurns: 5,
        hostTurnEngine: 'host_v1',
        context: identity,
      } as never,
    ));
  } catch (error) {
    runError = error;
  }
  if (runError) assert.match(String(runError), /max.*turn/i);
  assert.equal(refusalObservedBeforeRetry, true);
  assert.equal(lineageRepairObservedBeforeRetry, true);
  assert.equal(admissionObservedAfterRetry, true);
  assert.ok(eventlog.getTurnGraphEventForSource(session.id, source.seq));
  assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'ok');
  assert.deepEqual(deliveredPreambles, ['I’ll read the profile and create the workflow now.']);
});
