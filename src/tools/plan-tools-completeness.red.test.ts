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
const localPlanning = await import('../runtime/harness/local-planning-capability.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const expectedWork = await import('../runtime/harness/expected-work-contract.js');
const planCoexistence = await import('../runtime/harness/host-planned-resolution-coexistence.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const { hostRunRunner, hostNoProgressRecoveryDirective } = await import('../runtime/harness/host-turn-runner.js');
const { discoveryGovernor } = await import('../runtime/harness/discovery-governor.js');
const { buildScopedLocalToolSearch } = await import('./local-runtime-tools.js');
const { buildPlanTaskTool } = await import('./plan-tools.js');

type Planning = Awaited<ReturnType<typeof semantic.primePrimaryModelPlanningCatalog>> extends infer R
  ? Extract<R, { ok: true }>['planning']
  : never;

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  localPlanning._setConfiguredLocalPlanningToolObserverForTests(null);
  manifestStores.installCapabilityManifestStore(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function discloseLocal(
  planning: Planning,
  name: string,
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
    results: Array<{
      name: string;
      capabilityRef?: string;
      capabilityVariants?: Array<{ capabilityRef?: string }>;
    }>;
  };
  const result = body.results.find((entry) => entry.name === name);
  const capabilityRef = result?.capabilityRef ?? result?.capabilityVariants?.[0]?.capabilityRef;
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
  // The write is deliberately NOT disclosed up front: the missing-write
  // recovery is ask-only (one tool_search for the exact write), and it is that
  // in-turn search that discloses this ref and restores the planning surface.
  const writeRef = 'cap:local:workflow_create:reversible';
  const planTask = brackets.wrapToolForHarness(
    buildPlanTaskTool({ planning: primed.planning }) as never,
  );
  // The agent carries the same scoped local search the setup used so the
  // recovery surface has something real to offer.
  const toolSearch = brackets.wrapToolForHarness(
    buildScopedLocalToolSearch(
      new Set(['user_profile_read', 'workflow_create']),
      'work_call',
      undefined,
      undefined,
      (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
        authority: primed.planning.authority,
        candidates,
      }),
    ) as never,
  );
  const surfaceOf = (request: unknown): string[] => (
    ((request as { tools?: Array<{ name?: string }> }).tools ?? [])
      .map((entry) => entry.name ?? '')
      .filter(Boolean)
  );
  // The orchestrator opens the accepted task's discovery budget before any
  // turn; this fixture drives hostRunRunner directly, so open it here or the
  // recovery search is denied as task_not_initialized.
  discoveryGovernor.initializeTask({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    knownCapability: false,
  });
  const deliveredPreambles: string[] = [];

  // The first plan already binds the write (completeDraft), but writeRef is NOT
  // disclosed until the in-turn search below — an unattested write binding is a
  // broken write, so it refuses missing-write. (A WHOLLY-read plan is now
  // admitted as a gather stage — plan-tools change 2026-09-02 — so the refusal
  // must come from a bound-but-unattested write, not from an absent one.)
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

  // One real body invocation, before the host/model journey: no shape failure
  // may hide either independent static repair or reach compilation/persistence.
  const shapeAndSemantic = JSON.parse(String(await brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(4),
  }, () => (buildPlanTaskTool({ planning: primed.planning }) as unknown as {
    invoke: (context: unknown, args: string) => Promise<unknown>;
  }).invoke(null, JSON.stringify({
    preamble: 'Should I create it?',
    draft: { ...missingLineageDraft, version: 1 },
  })))));
  assert.equal(shapeAndSemantic.code, 'plan_invalid_input');
  assert.match(shapeAndSemantic.detail, /preamble/);
  assert.match(shapeAndSemantic.detail, /version/);
  assert.match(shapeAndSemantic.detail, /dataFrom/);
  assert.match(shapeAndSemantic.detail, /host has not attested/);
  assert.match(shapeAndSemantic.repairKey, /^[a-f0-9]{32}$/);
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
  assert.equal(eventlog.listEvents(session.id, {
    types: ['accepted_task_authority_armed', 'conversation_preamble'],
  }).length, 0);

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
            draft: missingLineageDraft,
          })],
        };
      }
      if (modelCalls === 2) {
        const requestText = JSON.stringify(request);
        const projection = await import('../runtime/harness/host-no-progress-projection.js');
        const projected = projection.projectHostNoProgressAttempt({
          ...identity, historyDelta: (request as { input: unknown[] }).input.slice(1) as never,
        });
        assert.equal(projected.status, 'ok');
        if (projected.status === 'ok') {
          assert.match(projected.consequence?.stage ?? '', /^plan_incomplete:missing_write:[a-f0-9]{16}$/);
          assert.deepEqual(projected.consequence?.recoveryToolNames, ['tool_search']);
          for (const stage of [projected.consequence!.stage, 'plan_incomplete:missing_write']) {
            assert.match(hostNoProgressRecoveryDirective({
              lastConsequence: { ...projected.consequence, stage },
            } as never), /Call tool_search exactly once/, 'keyed and historical stages retain their exact recovery');
          }
        }
        assert.match(
          requestText,
          /plan_incomplete_missing_write/,
          'the typed completeness refusal reaches the model before its retry',
        );
        // Ask, never substitute: the refusal names the exact missing write as
        // a search, carries no card writes to pick from, and the surface
        // offers exactly that search.
        assert.doesNotMatch(requestText, /admissibleCapabilities/);
        assert.match(requestText, /Use tool_search for the exact missing write capability/);
        assert.match(requestText, /dataFrom/,
          'the missing-write refusal also carries the independently known lineage issue on the first attempt');
        // The first executed control now establishes its exact operation:
        // real authority progress keeps ordinary tools available (P2), while
        // the typed refusal still supplies the exact search repair above.
        const decision = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] })
          .find((event) => event.data.kind === 'no_progress_decision');
        assert.equal(decision?.data.reason, 'authority_progress');
        assert.deepEqual(decision?.data.gained, ['operation']);
        assert.ok(surfaceOf(request).includes('tool_search'));
        assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
        assert.equal(eventlog.listEvents(session.id, {
          types: ['accepted_task_authority_armed', 'conversation_preamble'],
        }).length, 0);
        assert.deepEqual(expectedWork.loadExpectedWorkContract(session.id, source.seq), { status: 'missing' });
        assert.deepEqual(deliveredPreambles, []);
        refusalObservedBeforeRetry = true;
        return {
          responseId: 'plan-completeness-response-2',
          output: [toolCall('plan-missing-write-search', 'tool_search', {
            query: 'workflow_create', role_key: null, limit: 8,
          })],
        };
      }
      if (modelCalls === 3) {
        const requestText = JSON.stringify(request);
        assert.match(requestText, new RegExp(writeRef), requestText);
        assert.ok(
          surfaceOf(request).includes('plan_task'),
          'the disclosed write restores the ordinary planning surface',
        );
        assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
        return {
          responseId: 'plan-completeness-response-3',
          output: [toolCall('plan-missing-lineage-retry', 'plan_task', {
            preamble: 'I’ll read the profile and create the workflow now.',
            draft: missingLineageDraft,
          })],
        };
      }
      if (modelCalls === 4) {
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
          responseId: 'plan-completeness-response-4',
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
  const agent = { model, tools: [planTask, toolSearch] };
  const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
    sessionId: session.id,
    universeTools: [planTask, toolSearch],
    activeToolNames: [planTask.name, toolSearch.name],
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
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT logical_tool_call_id, delivery_owner
      FROM ${planCoexistence.PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq), {
    logical_tool_call_id: 'plan-complete-retry',
    delivery_owner: 'carrier_owned',
  }, 'the producer freezes the exact plan/presentation owner before invoking the carrier');
});

test('clarification answer plans the verified parent objective, not answer text', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'plan-continuation-parent-objective', kind: 'chat' });
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read my current profile, then create one workflow from it.' },
  });
  const answer = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use the work account.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: answer.seq, turn: answer.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  const readRef = await discloseLocal(primed.planning, 'user_profile_read');
  const writeRef = await discloseLocal(primed.planning, 'workflow_create');
  const planTask = buildPlanTaskTool({ planning: primed.planning }) as unknown as {
    invoke(context: unknown, input: string, details?: unknown): Promise<unknown>;
  };
  const output = String(await brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(4),
    taskContinuation: {
      packetId: 'continuation-packet:test',
      parentSourceUserSeq: parent.seq,
      consumingSourceUserSeq: answer.seq,
      parentInput: String(parent.data.text),
      question: 'Which connected account should I use?',
      options: ['Use the work account.', 'Use the personal account.'],
      answer: String(answer.data.text),
      disposition: 'selected',
      selectedOption: 'Use the work account.',
      retrievalQuery: `${parent.data.text} ${answer.data.text}`,
      capabilities: [],
    },
  }, () => planTask.invoke(null, JSON.stringify({
    preamble: 'I’ll read the profile and create the workflow now.',
    draft: readOnlyFileDraftForContinuation(readRef),
  }), { toolCall: { callId: 'continuation-parent-plan' } })));
  const refusal = JSON.parse(output) as {
    code?: unknown;
    repair?: unknown;
    recoveryTool?: unknown;
  };
  // The parent objective needs a write, so the read-only draft is incomplete.
  // The refusal asks for the exact missing write — it never offers the card's
  // already-disclosed write (here `writeRef`) as a substitute to pick.
  assert.equal(refusal.code, 'plan_incomplete_missing_write');
  assert.equal(refusal.recoveryTool, 'tool_search');
  assert.equal('admissibleCapabilities' in refusal, false, output);
  assert.doesNotMatch(output, new RegExp(writeRef));
  assert.match(String(refusal.repair), /Use tool_search for the exact missing write capability/);
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, answer.seq), null);
});

test('a wholly-read plan for a read-then-write ask is ADMITTED as a gather stage, writeDeferred, never claiming done', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'plan-completeness-read-gather-stage', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    // The owner's live shape (2026-09-02): read, show, validate, THEN write.
    data: { text: 'Read my current user profile, then create a workflow from it — but show me what you found before you write anything.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  const readRef = await discloseLocal(primed.planning, 'user_profile_read');
  const planTask = buildPlanTaskTool({ planning: primed.planning }) as unknown as {
    invoke(context: unknown, input: string, details?: unknown): Promise<unknown>;
  };
  const readOnlyDraft = {
    criteria: ['Read the current profile and present it to the user for validation before any write.'],
    cardinality: null,
    destination: null,
    topology: {
      version: 1,
      operations: [
        { id: 'read_profile', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      ],
      universes: [],
    },
    bindings: [
      { operationId: 'read_profile', role: 'source', capabilityRef: readRef, evidence: ['tool_result'] },
    ],
    deliverables: [{ id: 'profile_evidence', kind: 'evidence' }],
    evidenceRequirements: ['tool_result'],
  };
  const output = String(await brackets.withHarnessRunContext({
    ...identity,
    counter: new brackets.ToolCallsCounter(4),
  }, () => planTask.invoke(null, JSON.stringify({
    preamble: 'I’ll read your profile and show you what I find before writing anything.',
    draft: readOnlyDraft,
  }), { toolCall: { callId: 'read-gather-plan' } })));
  const result = JSON.parse(output) as { ok?: unknown; code?: unknown; writeDeferred?: unknown; next?: unknown };
  // The regression: a WHOLLY-READ plan for a write ask must NOT be walled as an
  // incomplete write. Before 2026-09-02 this returned plan_incomplete_missing_write
  // and the validate-first turn died 'same wall twice' (live sess-desktop-d146).
  assert.notEqual(result.code, 'plan_incomplete_missing_write',
    'a read/gather stage is admitted, never refused for a deferred write');
  // The gather stage carries the write-deferred contract into the model: run the
  // reads, present, validate before the write, and never claim done. It rides
  // whichever result the admission plumbing produces (a downstream persist step
  // here is exercised by the live chat rerun, not this unit harness).
  if (result.ok === true) {
    assert.equal(result.writeDeferred, true, 'the admitted read stage is flagged write-deferred');
    assert.match(String(result.next), /present what you found and ask the user to validate/i);
    assert.match(String(result.next), /do NOT claim the task is done/i);
  }
});

function readOnlyFileDraftForContinuation(capabilityRef: string) {
  return {
    criteria: ['Read the current profile, then durably create the requested workflow from it.'],
    cardinality: { count: 1, fields: ['preferredName'] },
    destination: { posture: 'create_new', family: 'workflow', handleRequired: true },
    topology: {
      version: 1,
      operations: [
        { id: 'read_profile', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
        // A well-formed write op bound to a capability the host has NOT attested
        // → a BROKEN write, so it still refuses missing-write (a wholly-read
        // plan is now admitted as a gather stage — plan-tools change 2026-09-02).
        { id: 'create_workflow', effect: 'local_write', coverage: null, dependsOn: ['read_profile'], dataFrom: ['read_profile'], cardinality: { kind: 'once' } },
      ],
      universes: [],
    },
    bindings: [
      { operationId: 'read_profile', role: 'source', capabilityRef, evidence: ['tool_result'] },
      { operationId: 'create_workflow', role: 'destination', capabilityRef: 'cap:local:deferred_write:create', evidence: ['local_commit_receipt'] },
    ],
    deliverables: [{ id: 'profile_snapshot_workflow', kind: 'workflow' }],
    evidenceRequirements: ['tool_result', 'local_commit_receipt'],
  };
}

test('real semantic admission refusals carry stable full-issue repair keys without arming work', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());
  const session = eventlog.createSession({ id: 'plan-semantic-repair-key', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Read my current user profile and create a Profile Snapshot workflow from it.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true);
  if (!primed.ok) return;
  const writeRef = await discloseLocal(primed.planning, 'workflow_create');
  const planTask = buildPlanTaskTool({ planning: primed.planning }) as unknown as {
    invoke: (context: unknown, args: string) => Promise<unknown>;
  };
  const draft = readOnlyFileDraftForContinuation('cap:local:missing_one:read');
  draft.bindings[1]!.capabilityRef = writeRef;
  const invoke = async (preamble: string) => JSON.parse(String(await brackets.withHarnessRunContext({
    ...identity, counter: new brackets.ToolCallsCounter(4),
  }, () => planTask.invoke(null, JSON.stringify({ preamble, draft })))));
  const first = await invoke('I will gather the profile and create the workflow.');
  assert.equal(first.code, 'plan_not_admitted', JSON.stringify(first));
  assert.match(first.repairKey, /^[a-f0-9]{32}$/);
  assert.equal((await invoke('I will inspect the profile and create the workflow.')).repairKey, first.repairKey,
    'unrelated valid prose cannot mint a new repair stage');
  draft.bindings[0]!.capabilityRef = 'cap:local:missing_two:read';
  assert.notEqual((await invoke('I will gather the profile and create the workflow.')).repairKey, first.repairKey,
    'a different exact missing capability is reflected by the actual admission issue set');
  assert.equal(eventlog.getTurnGraphEventForSource(session.id, source.seq), null);
  assert.equal(eventlog.listEvents(session.id, {
    types: ['accepted_task_authority_armed', 'conversation_preamble'],
  }).length, 0);
});

test('a selected same-source write omitted from a full eight-slot card reaches admission', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  localPlanning._setConfiguredLocalPlanningToolObserverForTests(async (name) => ({
    name,
    workCallLocalDispatch: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        append: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      },
      additionalProperties: true,
    },
  }));
  try {
    const session = eventlog.createSession({ id: 'plan-completeness-full-card-staged-write', kind: 'chat' });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: {
        text: 'Read my current profile, then create or update the selected workflow, workspace, or local artifact from it.',
      },
    });
    const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
    const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
    assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
    if (!primed.ok) return;

    const readRef = await discloseLocal(primed.planning, 'user_profile_read');
    const writeNames = [
      'artifact_bundle_save',
      'space_edit_runner',
      'space_edit_view',
      'space_save',
      'workflow_create',
      'workflow_edit_step',
      'workflow_run',
      'workflow_update',
      'write_file',
    ];
    const disclosed: Array<{ name: string; ref: string }> = [];
    for (const name of writeNames) {
      disclosed.push({ name, ref: await discloseLocal(primed.planning, name) });
    }
    const current = semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority);
    assert.ok(current);
    assert.equal(current?.capabilities.length, 8, 'fixture must saturate the bounded display card');
    const boundedRefs = new Set(current?.capabilities.map((descriptor) => descriptor.id));
    const omitted = disclosed.find((entry) => !boundedRefs.has(entry.ref));
    assert.ok(omitted, 'at least one exact foreground-search write must remain staged outside the card');
    if (!omitted) return;
    const observed = await localPlanning.observeCurrentLocalPlanningDefinitions({
      name: omitted.name,
      carrier: 'work_call',
    });
    assert.equal(observed.ok, true, observed.ok ? '' : observed.reason);
    if (!observed.ok) return;
    const selected = observed.definitions.find((definition) => definition.capabilityRef === omitted.ref);
    assert.ok(selected);
    if (!selected) return;
    assert.equal(selected.descriptor.effect, 'local_write');

    const draft = {
      criteria: [`Read the current profile, then ${selected.descriptor.purpose}.`],
      cardinality: { count: 1, fields: ['preferredName'] },
      destination: {
        posture: selected.descriptor.destinationPosture,
        family: selected.descriptor.deliverableKind,
        handleRequired: selected.descriptor.handleRequired,
      },
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
            id: 'write_selected',
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
          operationId: 'write_selected',
          role: 'destination',
          capabilityRef: omitted.ref,
          evidence: ['local_commit_receipt'],
        },
      ],
      deliverables: [{ id: 'selected_output', kind: selected.descriptor.deliverableKind }],
      evidenceRequirements: ['tool_result', 'local_commit_receipt'],
    };
    const planTask = brackets.wrapToolForHarness(
      buildPlanTaskTool({ planning: primed.planning }) as never,
    );
    let modelCalls = 0;
    let reachedAdmission = false;
    const model = {
      async getResponse(request: unknown) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            responseId: 'full-card-staged-write-plan',
            output: [toolCall('full-card-staged-write-plan', 'plan_task', {
              preamble: 'I’ll read the profile and create the selected output now.',
              draft,
            })],
          };
        }
        const requestText = JSON.stringify(request);
        assert.doesNotMatch(requestText, /plan_incomplete_missing_write/);
        assert.ok(eventlog.getTurnGraphEventForSource(session.id, source.seq), requestText);
        assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'ok');
        reachedAdmission = true;
        throw new Error('expected stop after selected staged write reached admission');
      },
      getStreamedResponse: testModelStream,
    };
    const agent = { model, tools: [planTask] };
    const sealed = capabilityEnvelopes.sealAgentCapabilityUniverse({
      sessionId: session.id,
      universeTools: [planTask],
      activeToolNames: [planTask.name],
      policyHash: 'plan-completeness-full-card-v1',
      budget: {
        maxUncachedTokens: 2_000,
        maxModelCalls: 4,
        maxToolCalls: 4,
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
        counter: new brackets.ToolCallsCounter(6),
        behaviorScopeId: `${identity.sessionId}::turn:1`,
        onConversationPreamble: async () => ({ status: 'already_delivered' as const }),
      }, () => hostRunRunner(
        throwingRunner() as never,
        agent as never,
        [{ type: 'message', role: 'user', content: source.data.text }] as never,
        {
          maxTurns: 3,
          hostTurnEngine: 'host_v1',
          context: identity,
        } as never,
      ));
    } catch (error) {
      runError = error;
    }
    assert.match(String(runError), /expected stop after selected staged write reached admission/);
    assert.equal(reachedAdmission, true);
    assert.ok(eventlog.getTurnGraphEventForSource(session.id, source.seq));
    assert.equal(expectedWork.loadExpectedWorkContract(session.id, source.seq).status, 'ok');
  } finally {
    localPlanning._setConfiguredLocalPlanningToolObserverForTests(null);
  }
});
