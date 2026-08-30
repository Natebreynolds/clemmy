/**
 * RED acceptance contract for the host-owned single-action Auto lane.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/harness/host-single-action-auto-plan.acceptance.red.test.ts
 *
 * Northstar: after one exact foreground tool_search, the model may emit one
 * proposal-free work_call and keep doing the useful work. For an exact,
 * dependency-free, cardinality-once mutation, the host compiles the existing
 * plan_task/graph/work contract itself. The model must not author plan prose.
 *
 * This suite deliberately does not invent a second execution authority. The
 * hidden compilation must retain the existing consent, once-only reservation,
 * receipt, reconciliation, and settled-replay kernels. Reads stay graphless;
 * ambiguous, multi-action, unknown, administrative, destructive, or mismatched
 * calls remain ineligible for this narrow lane and cross no body.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type {
  CapabilityRiskAttestationV1,
  ExactUserGrantV1,
  ExactWorkCoverageV1,
} from './interactive-consent-policy.js';
import type { HostModelFrameCall } from './host-model-frame-policy.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-single-action-auto-plan-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-host-single-action-auto-plan\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifestStores = await import('./capability-manifest-store.js');
const semantic = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const expectedWork = await import('./expected-work-contract.js');
const { classifyHostModelFrame } = await import('./host-model-frame-policy.js');
const { evaluateInteractiveConsentV1 } = await import('./interactive-consent-policy.js');
const { hostRunRunner } = await import('./host-turn-runner.js');
const terminalPreparation = await import('./accepted-task-terminal-preparation.js');
const spaces = await import('../../spaces/store.js');
const workspaceDb = await import('../../spaces/workspace-db.js');

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

const ACME_ACCOUNT = 'ca_outlook_acme_owner';
const PERSONAL_ACCOUNT = 'ca_outlook_personal_owner';
const OUTLOOK_CREATE_EVENT = 'OUTLOOK_CALENDAR_CREATE_EVENT';
const OUTLOOK_CAPABILITY_REF = 'cap:resolved:outlook_calendar_create_event:acme';
const ALEX_EMAIL = 'alex.rivera@acme.example';
const OUTLOOK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'subject', 'start', 'end', 'attendees'],
  properties: {
    calendar_id: { type: 'string' },
    subject: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    attendees: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['email'],
        properties: { email: { type: 'string' } },
      },
    },
  },
});
const OUTLOOK_ARGUMENTS = Object.freeze({
  calendar_id: 'acme-primary',
  subject: 'Discuss the new AI project',
  start: '2026-08-30T21:00:00-07:00',
  end: '2026-08-30T21:30:00-07:00',
  attendees: [{ email: ALEX_EMAIL }],
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workCall(input: {
  callId: string;
  capabilityRef: string;
  effectiveName: string;
  effect: HostModelFrameCall['effect'];
  carrierName: string;
  carrierArgs: Record<string, unknown>;
}): HostModelFrameCall {
  return {
    callId: input.callId,
    name: 'work_call',
    argumentsJson: JSON.stringify({
      requirement_id: input.capabilityRef,
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      name: input.carrierName,
      args_json: JSON.stringify(input.carrierArgs),
    }),
    argumentsValue: {
      requirement_id: input.capabilityRef,
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      name: input.carrierName,
      args_json: JSON.stringify(input.carrierArgs),
    },
    effectiveName: input.effectiveName,
    effect: input.effect,
    proposalFreeWorkCarrier: true,
  };
}

const EXACT_SINGLE_ACTIONS = [
  {
    label: 'Composio Outlook uses the exact Acme account and calendar schema',
    call: workCall({
      callId: 'calendar-create-acme',
      capabilityRef: OUTLOOK_CAPABILITY_REF,
      effectiveName: OUTLOOK_CREATE_EVENT,
      effect: 'external_write',
      carrierName: 'composio_execute_tool',
      carrierArgs: {
        tool_slug: OUTLOOK_CREATE_EVENT,
        arguments: JSON.stringify(OUTLOOK_ARGUMENTS),
        connected_account_id: ACME_ACCOUNT,
      },
    }),
  },
  {
    label: 'local file create uses its exact create-only local capability',
    call: workCall({
      callId: 'local-file-create',
      capabilityRef: 'cap:local:write_file:create',
      effectiveName: 'write_file',
      effect: 'local_write',
      carrierName: 'write_file',
      carrierArgs: {
        path: '/workspace/notes/auto-lane.txt',
        content: 'one exact local file',
        mode: 'create',
        append: null,
      },
    }),
  },
  {
    label: 'Clem-owned workflow authoring uses the same generic lane',
    call: workCall({
      callId: 'clem-workflow-create',
      capabilityRef: 'cap:local:workflow_create:reversible',
      effectiveName: 'workflow_create',
      effect: 'local_write',
      carrierName: 'workflow_create',
      carrierArgs: { name: 'daily-brief', description: 'Create the daily brief.' },
    }),
  },
  {
    label: 'Clem Workspace creation uses the same generic lane',
    call: workCall({
      callId: 'clem-workspace-create',
      capabilityRef: 'cap:local:space_save:reversible',
      effectiveName: 'space_save',
      effect: 'local_write',
      carrierName: 'space_save',
      carrierArgs: {
        slug: 'auto-lane-workspace',
        title: 'Auto Lane Workspace',
        view_html: '<h1>Auto Lane</h1>',
      },
    }),
  },
  {
    label: 'native MCP mutation uses the same generic lane',
    call: workCall({
      callId: 'native-mcp-calendar-create',
      capabilityRef: 'cap:mcp:calendar:create_event:acme',
      effectiveName: 'mcp__calendar__create_event',
      effect: 'external_write',
      carrierName: 'mcp__calendar__create_event',
      carrierArgs: {
        calendar_id: 'acme-primary',
        subject: 'Discuss the new AI project',
        attendee: ALEX_EMAIL,
      },
    }),
  },
] as const;

test('RED: one exact sole work_call selects host-owned compilation across provider families', () => {
  for (const fixture of EXACT_SINGLE_ACTIONS) {
    assert.deepEqual(classifyHostModelFrame({
      calls: [fixture.call],
      planActivated: false,
      allowFreshPlanReadFusion: true,
    }), {
      kind: 'host_owned_single_action_plan',
      call: fixture.call,
      requirementId: fixture.call.argumentsValue!.requirement_id,
      effect: fixture.call.effect,
    }, fixture.label);
  }
});

test('graphless reads remain ordinary and never acquire a hidden mutation plan', () => {
  const localFileSearch = workCall({
    callId: 'local-file-query',
    capabilityRef: 'cap:local:file_query:read',
    effectiveName: 'file_query',
    effect: 'read',
    carrierName: 'file_query',
    carrierArgs: { query: 'Alex Rivera', source: '/workspace/notes' },
  });
  assert.deepEqual(classifyHostModelFrame({
    calls: [localFileSearch],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), { kind: 'ordinary' });
});

test('hard negatives cannot enter the host-owned one-action lane', () => {
  const exact = EXACT_SINGLE_ACTIONS[0]!.call;
  const invalid: Array<{ label: string; calls: HostModelFrameCall[] }> = [
    {
      label: 'two business calls are not a one-action task',
      calls: [exact, { ...exact, callId: 'calendar-create-second' }],
    },
    {
      label: 'unknown effect remains explicit-plan work',
      calls: [{ ...exact, effect: 'unknown' }],
    },
    {
      label: 'administrative work remains explicit-plan work',
      calls: [{ ...exact, effect: 'admin' }],
    },
    {
      label: 'a lookalike carrier has no opaque host authority',
      calls: [{ ...exact, proposalFreeWorkCarrier: false }],
    },
    {
      label: 'the model cannot smuggle a proposal back into work_call',
      calls: [{
        ...exact,
        argumentsValue: { ...exact.argumentsValue!, proposal: { operations: [] } },
      }],
    },
    {
      label: 'an empty exact capability reference is not a target',
      calls: [{
        ...exact,
        argumentsValue: { ...exact.argumentsValue!, requirement_id: '' },
      }],
    },
    {
      label: 'a model-authored operation label is not a disclosed capability ref',
      calls: [{
        ...exact,
        argumentsValue: { ...exact.argumentsValue!, requirement_id: 'create_calendar_event' },
      }],
    },
    {
      label: 'each-member selection is not cardinality-once compilation',
      calls: [{
        ...exact,
        argumentsValue: { ...exact.argumentsValue!, universe_item_id: 'member-1' },
      }],
    },
  ];

  for (const fixture of invalid) {
    assert.equal(
      classifyHostModelFrame({
        calls: fixture.calls,
        planActivated: false,
        allowFreshPlanReadFusion: true,
      }).kind,
      'refused',
      fixture.label,
    );
  }
});

function calendarCall(overrides: Partial<CapabilityRiskAttestationV1> = {}): CapabilityRiskAttestationV1 {
  const argumentDigest = sha256(JSON.stringify({
    tool_slug: OUTLOOK_CREATE_EVENT,
    arguments: OUTLOOK_ARGUMENTS,
    connected_account_id: ACME_ACCOUNT,
  }));
  const schemaFingerprint = sha256(JSON.stringify(OUTLOOK_SCHEMA));
  return {
    version: 1,
    source: {
      kind: 'accepted_turn',
      id: 'source:calendar-auto-lane',
      digest: sha256('source:calendar-auto-lane'),
    },
    acceptedTaskId: 'task:calendar-auto-lane',
    bindingDigest: sha256(`binding:${argumentDigest}:${ACME_ACCOUNT}`),
    logicalToolCallId: 'calendar-create-acme',
    operationId: OUTLOOK_CREATE_EVENT,
    argumentDigest,
    schemaFingerprint,
    effect: 'external_write',
    accountId: ACME_ACCOUNT,
    destination: {
      digest: sha256(`calendar:acme-primary:${ALEX_EMAIL}`),
      posture: 'named_existing',
    },
    cardinality: { kind: 'once' },
    risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
    semanticBasis: {
      kind: 'current_external_definition',
      digest: sha256(`definition:${OUTLOOK_CREATE_EVENT}:${schemaFingerprint}`),
    },
    safety: 'admissible',
    ...overrides,
  };
}

function calendarCoverage(call: CapabilityRiskAttestationV1): ExactWorkCoverageV1 {
  return {
    version: 1,
    source: { ...call.source },
    acceptedTaskId: call.acceptedTaskId,
    contractId: 'hidden-plan:calendar-auto-lane',
    requirementId: OUTLOOK_CAPABILITY_REF,
    requirementDigest: sha256(`requirement:${OUTLOOK_CAPABILITY_REF}`),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      semanticBasis: { ...call.semanticBasis },
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: `once:${call.bindingDigest}`,
  };
}

function calendarGrant(call: CapabilityRiskAttestationV1): ExactUserGrantV1 {
  return {
    version: 1,
    source: 'approval_resolution',
    grantDigest: sha256(`approval:${call.bindingDigest}`),
    scope: {
      source: { ...call.source },
      acceptedTaskId: call.acceptedTaskId,
      logicalToolCallId: call.logicalToolCallId,
      bindingDigest: call.bindingDigest,
      operationId: call.operationId,
      argumentDigest: call.argumentDigest,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      risk: { ...call.risk },
      semanticBasis: { ...call.semanticBasis },
    },
  };
}

test('the hidden calendar plan preserves exact consent, account, schema, once, and reconciliation', () => {
  const call = calendarCall();
  const coverage = calendarCoverage(call);
  const grant = calendarGrant(call);
  const decide = (overrides: Partial<Parameters<typeof evaluateInteractiveConsentV1>[0]> = {}) => (
    evaluateInteractiveConsentV1({
      call,
      coverage,
      userGrant: null,
      readiness: { kind: 'ready' },
      crossing: 'not_started',
      reservationAlreadyClaimed: false,
      ...overrides,
    })
  );

  const held = decide();
  assert.equal(held.kind, 'needs_user');
  if (held.kind === 'needs_user') {
    assert.equal(held.need, 'approval');
    assert.equal(held.subjectDigest, call.bindingDigest);
  }
  assert.deepEqual(decide({ userGrant: grant }), {
    kind: 'proceed',
    basis: 'exact_user_grant',
    authorityDigest: grant.grantDigest,
    reservationKey: coverage.reservationKey,
  });
  assert.deepEqual(decide({ userGrant: grant, reservationAlreadyClaimed: true }), {
    kind: 'repair',
    reason: 'cardinality_spent',
  });
  assert.deepEqual(decide({ crossing: 'possibly_started' }), {
    kind: 'reconcile',
    reason: 'possible_effect',
    retry: 'never_blind',
  });
  assert.deepEqual(decide({ crossing: 'settled' }), {
    kind: 'proceed',
    basis: 'settled_replay',
    authorityDigest: call.bindingDigest,
  });

  const wrongAccount = calendarCall({ accountId: PERSONAL_ACCOUNT });
  assert.deepEqual(decide({ call: wrongAccount, userGrant: grant }), {
    kind: 'repair',
    reason: 'scope_mismatch',
  }, 'Acme approval cannot authorize a personal-account calendar call');
  const staleSchema = calendarCall({ schemaFingerprint: sha256('drifted-calendar-schema') });
  assert.deepEqual(decide({ call: staleSchema, userGrant: grant }), {
    kind: 'repair',
    reason: 'scope_mismatch',
  }, 'approval and hidden coverage cannot survive provider schema drift');
});

async function* modelStream(
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
      finishReason: output.some((item) => (
        (item as { type?: unknown }).type === 'function_call'
      )) ? 'tool_calls' : 'stop',
    },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

const functionCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: 'function_call',
  callId,
  name,
  arguments: JSON.stringify(args),
});

const assistantText = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('legacy Runner.run must stay unreachable');
  };
  return runner;
}

test('RED: tool_search -> sole Workspace work_call executes once with a hidden plan and durable replay', async () => {
  eventlog.resetEventLog();
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifestStores.installCapabilityManifestStore(manifestStores.createCapabilityManifestStore());

  const session = eventlog.createSession({ id: 'single-action-auto-workspace', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one simple Workspace called Auto Lane Proof.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;

  const capabilityRef = 'cap:local:space_save:reversible';
  assert.equal(
    primed.planning.capabilities.some((entry) => entry.id === capabilityRef),
    false,
    'the foreground search, not an initial broad card, must disclose the local capability',
  );
  const slug = 'auto-lane-proof';
  const html = '<html><body><h1>Auto Lane Proof</h1><p>One exact save.</p></body></html>';
  const saveArgs = {
    slug,
    title: 'Auto Lane Proof',
    objective: null,
    success_criteria: null,
    invariants: null,
    view_html: html,
    view_path: null,
    data_sources: null,
    actions: null,
    reengage_triggers: null,
    reengage_guidance: null,
    origin_session_id: null,
  };
  const workArgs = {
    requirement_id: capabilityRef,
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'space_save',
    args_json: JSON.stringify(saveArgs),
  };

  let modelCalls = 0;
  const emittedToolNames: string[] = [];
  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      let output: unknown[];
      if (modelCalls === 1) {
        output = [functionCall('search-space-save', 'tool_search', {
          query: 'space_save',
          role_key: 'clause-0:write',
          limit: 8,
        })];
      } else if (modelCalls === 2) {
        assert.match(
          JSON.stringify(request),
          new RegExp(capabilityRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
          'the model must receive the exact disclosed ref before its work call',
        );
        output = [functionCall('save-auto-lane-workspace', 'work_call', workArgs)];
      } else if (modelCalls === 3) {
        output = [functionCall('replay-auto-lane-workspace', 'work_call', workArgs)];
      } else {
        output = [assistantText('Created the Auto Lane Proof Workspace.')];
      }
      for (const item of output) {
        if ((item as { type?: unknown }).type === 'function_call') {
          emittedToolNames.push(String((item as { name?: unknown }).name ?? ''));
        }
      }
      return {
        responseId: `single-action-auto-response-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output,
      };
    },
    getStreamedResponse: modelStream,
  };

  // The production assembler keeps plan_task as the existing host compilation
  // kernel, but no model response is allowed to author or invoke it. After the
  // exact search, the desired surface exposes work_call directly.
  const agent = await buildOrchestratorAgent({
    userInput: 'Create one simple Workspace called Auto Lane Proof.',
    sessionId: session.id,
    sourceUserSeq: source.seq,
    hostFreshPlanning: primed.planning,
    allowedToolNames: ['space_save', 'tool_search'],
    allowToolJit: true,
    mcpToolScope: {
      authority: 'none',
      reason: 'single-action local acceptance fixture has no external authority',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    },
    model: model as never,
  });

  const outcome = await brackets.withHarnessRunContext({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
    onConversationPreamble: async (request: {
      deliveryKey: string;
      eventId: string;
      eventDigest: string;
    }) => ({
      status: 'delivered' as const,
      receipt: {
        version: 1 as const,
        deliveryKey: request.deliveryKey,
        eventId: request.eventId,
        eventDigest: request.eventDigest,
        surface: 'channel_message' as const,
        target: 'single-action-auto-workspace',
      },
    }),
  }, () => hostRunRunner(
    throwingRunner() as never,
    agent as never,
    [{
      type: 'message',
      role: 'user',
      content: 'Create one simple Workspace called Auto Lane Proof.',
    }] as never,
    {
      maxTurns: 6,
      hostTurnEngine: 'host_v1',
      context: identity,
    } as never,
  ));

  assert.equal(outcome.terminal, undefined, JSON.stringify(outcome));
  assert.equal(outcome.finalOutput, 'Created the Auto Lane Proof Workspace.');
  assert.deepEqual(emittedToolNames, ['tool_search', 'work_call', 'work_call']);
  assert.equal(emittedToolNames.includes('plan_task'), false, 'model-authored plan ceremony is forbidden');
  assert.equal(spaces.spaceStore.get(slug)?.version, 1, 'the exact local body ran once');

  const db = eventlog.openEventLog();
  const planControls = db.prepare(`
    SELECT logical_tool_call_id, state, outcome_kind
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'plan_task'
  `).all(session.id, source.seq) as Array<{
    logical_tool_call_id: string;
    state: string;
    outcome_kind: string | null;
  }>;
  assert.equal(planControls.length, 1, 'the host minted exactly one existing plan_task control');
  assert.deepEqual(
    planControls.map((row) => ({ state: row.state, outcome: row.outcome_kind })),
    [{ state: 'settled', outcome: 'succeeded' }],
  );

  const contract = expectedWork.loadExpectedWorkContract(session.id, source.seq);
  assert.equal(contract.status, 'ok', JSON.stringify(contract));
  if (contract.status === 'ok') {
    assert.deepEqual(contract.contract.operations.map((operation) => ({
      id: operation.id,
      effect: operation.effect,
      dependsOn: operation.dependsOn,
      dataFrom: operation.dataFrom,
      cardinality: operation.cardinality.kind,
    })), [{
      id: capabilityRef,
      effect: 'local_write',
      dependsOn: [],
      dataFrom: [],
      cardinality: 'once',
    }]);
  }

  const physical = db.prepare(`
    SELECT tool_name, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'space_save'
  `).all(session.id, source.seq);
  assert.deepEqual(physical, [{ tool_name: 'space_save', state: 'returned' }]);

  const mutations = db.prepare(`
    SELECT logical_tool_call_id, outcome_kind, execution_kind, physical_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND mutating = 1
     ORDER BY settled_at, logical_tool_call_id
  `).all(session.id, source.seq) as Array<{
    logical_tool_call_id: string;
    outcome_kind: string;
    execution_kind: string;
    physical_crossing_count: number;
  }>;
  assert.deepEqual(mutations.map((row) => ({
    id: row.logical_tool_call_id,
    outcome: row.outcome_kind,
    execution: row.execution_kind,
    crossings: row.physical_crossing_count,
  })), [
    {
      id: 'save-auto-lane-workspace',
      outcome: 'succeeded',
      execution: 'local_execution',
      crossings: 0,
    },
    {
      id: 'replay-auto-lane-workspace',
      outcome: 'policy_denial',
      execution: 'refused_pre_dispatch',
      crossings: 0,
    },
  ], 'the once lease lets one body run and pairs replay without another crossing');

  const preparedTerminal = terminalPreparation.prepareAcceptedTaskTerminal({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposedReply: 'Created the Auto Lane Proof Workspace.',
  });
  assert.equal(preparedTerminal.status, 'ready', JSON.stringify(preparedTerminal));
  const receiptCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM host_write_receipts
     WHERE session_id = ? AND source_user_seq = ?
  `).get(session.id, source.seq) as { n: number }).n;
  assert.equal(receiptCount, 2, 'commit plus readback receipts survive hidden compilation');
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ?
  `).get(session.id) as { n: number }).n, 0, 'ordinary reversible local work asks no permission');
});
