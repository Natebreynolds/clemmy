/**
 * Run: npx tsx --test src/runtime/read-path/read-lane.test.ts
 *
 * D1+D3+D4 acceptance: the generic read-only cold-to-warm lane, proven with
 * deterministic shims over THREE unrelated operations in different carrier
 * families — an event listing, a message-history search, and a record lookup.
 * They are fixtures, not branches: a genericity pin proves no operation or
 * provider name appears in the lane's control flow, and every fixture runs
 * through the SAME mechanism on both brain shims.
 *
 * The deterministic structural target for every warm run:
 *   procedure_resolution = hit, schema_discovery_calls = 0,
 *   tool_discovery_calls = 0, provider_dispatches = 1,
 *   validation_repairs = 0, public_terminals = 1,
 *   external_write_or_send_dispatches = 0.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-lane-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const { sealReadLaneEnvelope, acquireLaneBinding, intersectWithMcpScope, laneAdmitsDispatch } = await import('./read-envelope.js');
const { runColdToWarmRead, bindSlots, unboundSlots } = await import('./read-lane.js');
const { sealBudgetContract, createBudgetMeter } = await import('../budget-contract.js');
const { createSpanRecorder, certifyPerformanceSample } = await import('../trace-envelope.js');
type ReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;
type IntentResolution = import('./read-lane.js').IntentResolution;
type ReadLanePorts = import('./read-lane.js').ReadLanePorts;
type ReadLaneEnvelope = import('./read-envelope.js').ReadLaneEnvelope;

// ─── the three unrelated operations (fixtures, not branches) ─────────────────

interface OperationFixture {
  label: string;
  provider: string;
  operation: string;
  identifier: string;
  kind: 'composio' | 'mcp' | 'cli';
  templateArgs: Record<string, unknown>;
  slotValues: Record<string, string>;
  paraphrases: { claude: string[]; codex: string[] };
  evidenceText: string;
}

const OPERATIONS: OperationFixture[] = [
  {
    label: 'event listing',
    provider: 'schedulerco',
    operation: 'list_events',
    identifier: 'SCHEDULERCO_LIST_EVENTS',
    kind: 'composio',
    templateArgs: { window: '{{window}}', ordering: 'start_time' },
    slotValues: { window: 'today' },
    paraphrases: {
      claude: ['what is on my agenda for the day', 'show today on the planner'],
      codex: ['list my scheduled blocks for today', 'pull up the day plan'],
    },
    evidenceText: 'Three blocks: 9:00 standup, 11:30 review, 15:00 focus.',
  },
  {
    label: 'message search',
    provider: 'chatterly',
    operation: 'search_history',
    identifier: 'chatterly__history_search',
    kind: 'mcp',
    templateArgs: { query: '{{query}}', limit: 20 },
    slotValues: { query: 'invoice' },
    paraphrases: {
      claude: ['find the thread where we discussed the invoice', 'search chat history for invoice'],
      codex: ['dig up invoice mentions from the history', 'where did the invoice come up'],
    },
    evidenceText: 'Two matches in #finance from last week.',
  },
  {
    label: 'record lookup',
    provider: 'documind',
    operation: 'get_record',
    identifier: 'documind-cli records get {{recordId}}',
    kind: 'cli',
    templateArgs: { command: 'records get {{recordId}}' },
    slotValues: { recordId: 'r-42' },
    paraphrases: {
      claude: ['open record r-42', 'what does entry r-42 say'],
      codex: ['fetch the r-42 record', 'look up item r-42'],
    },
    evidenceText: 'Record r-42: onboarding checklist, owner Sam, 7 fields.',
  },
];

// ─── the deterministic shim world ────────────────────────────────────────────

let receiptSeq = 0;

/** One connected world: receipts, catalog fingerprints, discovery, dispatch.
 *  Persistent pieces (the artifact store) live under CLEMENTINE_HOME, so a
 *  "restart" builds a fresh world and lane over the same durable state. */
function shimWorld(input?: { fingerprintFor?: (identifier: string) => string }) {
  const receipts = new Map<string, ReceiptRecord>();
  const counters = { discover: 0, dispatch: 0 };
  const fingerprintFor = input?.fingerprintFor ?? ((identifier: string) => `fp-${identifier}`);
  const scopeFor = (tenant: string, workspace: string, account: string) =>
    ({ tenant, workspace, accountIdentity: account });

  function portsFor(options: {
    brain: 'claude' | 'codex';
    tenant?: string;
    workspace?: string;
    account?: string;
    connected?: boolean;
    dispatchError?: { error: string; transient: boolean };
    overrideSlotValues?: Record<string, string>;
  }): { ports: ReadLanePorts; scope: ReturnType<typeof scopeFor> } {
    const scope = scopeFor(options.tenant ?? 'tenant-1', options.workspace ?? 'ws-1', options.account ?? 'person@example.com');
    const ports: ReadLanePorts = {
      async resolveIntent(text): Promise<IntentResolution> {
        // Deterministic per-brain paraphrase table — the ONLY brain-shaped
        // judgment. Both brains resolve to the same logical operation.
        for (const operation of OPERATIONS) {
          if (operation.paraphrases[options.brain].some((phrase) => text === phrase)) {
            return {
              kind: 'read',
              provider: operation.provider,
              operation: operation.operation,
              slotValues: options.overrideSlotValues ?? operation.slotValues,
            };
          }
        }
        if (text.startsWith('send') || text.startsWith('update')) return { kind: 'effectful' };
        return { kind: 'unresolved' };
      },
      liveSchemaFingerprint: (identifier) => fingerprintFor(identifier),
      accountConnected: () => options.connected ?? true,
      async discover(provider, operation) {
        counters.discover += 1;
        const fixture = OPERATIONS.find((candidate) => candidate.provider === provider && candidate.operation === operation);
        if (!fixture) return undefined;
        return {
          identifier: fixture.identifier,
          schemaFingerprint: fingerprintFor(fixture.identifier),
          templateArgs: fixture.templateArgs,
          kind: fixture.kind,
        };
      },
      async dispatch({ identifier, args }) {
        counters.dispatch += 1;
        if (options.dispatchError) return options.dispatchError;
        const fixture = OPERATIONS.find((candidate) => candidate.identifier === identifier);
        const record: ReceiptRecord = {
          receiptId: `rcpt_${(receiptSeq += 1)}`,
          at: '2026-08-04T00:00:00.000Z',
          provider: fixture?.provider ?? 'unknown',
          operation: fixture?.operation ?? 'unknown',
          effectClass: 'read',
          identifier,
          schemaFingerprint: fingerprintFor(identifier),
          scope,
          dispatchOutcome: 'succeeded',
          readEvidenceRef: `ev:${JSON.stringify(args)}`,
        };
        receipts.set(record.receiptId, record);
        return { receiptId: record.receiptId };
      },
      receipts: { resolve: (id) => receipts.get(id) },
      async present(evidence) {
        const fixture = OPERATIONS.find((candidate) => candidate.provider === evidence.provider);
        return { draft: fixture?.evidenceText ?? 'Done.' };
      },
    };
    return { ports, scope };
  }

  return { portsFor, counters, receipts };
}

function laneFor(over: Partial<Parameters<typeof sealReadLaneEnvelope>[0]['identity']> = {}): ReadLaneEnvelope {
  const account = over.accountIdentity ?? 'person@example.com';
  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: 'tenant-1', workspace: 'ws-1',
      acceptedTurnId: 'turn-1', activationId: 'act-1',
      accountIdentity: account,
      policyHash: 'policy-1', budgetVersion: 'v1',
      ...over,
    },
    capabilities: OPERATIONS.map((operation) => ({
      name: operation.identifier,
      schemaFingerprint: `fp-${operation.identifier}`,
      effectClass: 'read' as const,
      accountIdentity: account,
    })),
    activeCapabilityNames: OPERATIONS.map((operation) => operation.identifier),
    budget: { maxUncachedTokens: 100_000, maxModelCalls: 10, maxToolCalls: 10, maxElapsedMs: 60_000 },
  });
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  return (sealed as Extract<typeof sealed, { ok: true }>).lane;
}

function meter() {
  const sealed = sealBudgetContract({
    uncachedInputTokens: 100_000, outputTokens: 10_000, modelCalls: 4, toolCalls: 4,
    discoveryCalls: 1, validationRepairs: 0, retries: 1, artifactBytes: 1_000_000,
    artifactCount: 10, expansions: 0, effects: 0, elapsedMs: 60_000, concurrency: 1,
  });
  assert.equal(sealed.ok, true);
  return createBudgetMeter((sealed as Extract<typeof sealed, { ok: true }>).contract);
}

async function runLane(input: {
  world: ReturnType<typeof shimWorld>;
  brain: 'claude' | 'codex';
  text: string;
  lane?: ReadLaneEnvelope;
  portsOptions?: Parameters<ReturnType<typeof shimWorld>['portsFor']>[0];
}) {
  const { ports, scope } = input.world.portsFor({ brain: input.brain, ...(input.portsOptions ?? {}) });
  const spans = createSpanRecorder(() => 0);
  return {
    result: await runColdToWarmRead({
      lane: input.lane ?? laneFor(),
      input: input.text,
      scope,
      budget: meter(),
      spans,
      ports,
    }),
    spans,
  };
}

const WARM_GATE = {
  procedure_resolution: 'hit',
  schema_discovery_calls: 0,
  tool_discovery_calls: 0,
  provider_dispatches: 1,
  validation_repairs: 0,
  public_terminals: 1,
  external_write_or_send_dispatches: 0,
} as const;

// ─── D4: the three-operation cold/warm matrix, both brains ───────────────────

test('D4: three unrelated operations run cold (one discovery, one dispatch, one artifact, one terminal) then warm (the exact structural gate) through ONE mechanism', async () => {
  for (const operation of OPERATIONS) {
    const world = shimWorld();
    // COLD, on the claude brain shim's first paraphrase.
    const cold = await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });
    assert.equal(cold.result.outcome, 'terminal', `${operation.label} cold: ${JSON.stringify(cold.result)}`);
    const coldResult = cold.result as Extract<typeof cold.result, { outcome: 'terminal' }>;
    assert.equal(coldResult.warm, false);
    assert.equal(coldResult.counters.schema_discovery_calls, 1, `${operation.label}: cold must make AT MOST one acquisition — and needs exactly one here`);
    assert.equal(coldResult.counters.provider_dispatches, 1);
    assert.equal(coldResult.counters.public_terminals, 1);
    assert.equal(coldResult.counters.external_write_or_send_dispatches, 0);
    assert.equal(coldResult.text, operation.evidenceText);

    // WARM, on a DIFFERENT paraphrase from the OTHER brain shim.
    const warm = await runLane({ world, brain: 'codex', text: operation.paraphrases.codex[0]! });
    assert.equal(warm.result.outcome, 'terminal', `${operation.label} warm: ${JSON.stringify(warm.result)}`);
    const warmResult = warm.result as Extract<typeof warm.result, { outcome: 'terminal' }>;
    assert.equal(warmResult.warm, true, `${operation.label}: the second run did not go warm`);
    assert.deepEqual(warmResult.counters, WARM_GATE, `${operation.label}: warm structural gate broken`);
    assert.equal(warmResult.text, operation.evidenceText);
  }
});

test('D4: both brains select the same binding and canonical dispatch shape', async () => {
  const operation = OPERATIONS[0]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! }); // cold promote

  const dispatches: Array<{ identifier: string; args: Record<string, unknown> }> = [];
  for (const brain of ['claude', 'codex'] as const) {
    const { ports, scope } = world.portsFor({ brain });
    const spy: ReadLanePorts = {
      ...ports,
      async dispatch(request) { dispatches.push(request); return ports.dispatch(request); },
    };
    const result = await runColdToWarmRead({
      lane: laneFor(), input: operation.paraphrases[brain][1]!, scope,
      budget: meter(), spans: createSpanRecorder(() => 0), ports: spy,
    });
    assert.equal(result.outcome, 'terminal');
    assert.equal((result as Extract<typeof result, { outcome: 'terminal' }>).warm, true);
  }
  assert.deepEqual(dispatches[0], dispatches[1],
    'the two brains dispatched different canonical shapes for one logical operation');
});

test('D4: restart and compaction preserve procedure, envelope, and revision identity — the warm gate survives a new activation', async () => {
  const operation = OPERATIONS[1]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });

  // "Restart": a brand-new world (fresh receipts, fresh ports, fresh spans),
  // a brand-new lane sealed from the same identity inputs, a new activation.
  const restartedWorld = shimWorld();
  const restartedLane = laneFor({ activationId: 'act-2' });
  const warm = await runLane({
    world: restartedWorld, brain: 'codex', text: operation.paraphrases.codex[1]!, lane: restartedLane,
  });
  assert.equal(warm.result.outcome, 'terminal', JSON.stringify(warm.result));
  assert.deepEqual((warm.result as Extract<typeof warm.result, { outcome: 'terminal' }>).counters, WARM_GATE);

  // Identity is deterministic where it must be: the same sealed inputs
  // reproduce the same envelope and revision digests exactly (compaction
  // cannot drift them) …
  assert.equal(laneFor().envelope.envelopeDigest, laneFor().envelope.envelopeDigest);
  assert.equal(laneFor().revision.revisionDigest, laneFor().revision.revisionDigest);
  // … and a new activation is a NEW attempt authority by the envelope
  // primitive's design (attemptId is sealed identity), so the lane digest
  // changes while the PROCEDURE identity — scope + logical key + content
  // address — is what carries warmth across activations, proven above by the
  // warm gate itself.
  assert.notEqual(restartedLane.laneDigest, laneFor().laneDigest);
});

test('D4: schema drift quarantines BEFORE dispatch and falls back to the generic cold path', async () => {
  const operation = OPERATIONS[0]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });

  // The live contract drifts. The warm resolution must quarantine without
  // dispatching the stale shape, then the SAME turn completes via cold
  // discovery against the new contract.
  const driftedWorld = shimWorld({ fingerprintFor: (identifier) => `fp2-${identifier}` });
  const drifted = await runLane({ world: driftedWorld, brain: 'codex', text: operation.paraphrases.codex[0]! });
  assert.equal(drifted.result.outcome, 'terminal', JSON.stringify(drifted.result));
  const result = drifted.result as Extract<typeof drifted.result, { outcome: 'terminal' }>;
  assert.equal(result.warm, false, 'a drifted artifact dispatched as warm');
  assert.equal(result.counters.procedure_resolution, 'stale');
  assert.equal(result.counters.schema_discovery_calls, 1);
  assert.equal(result.counters.provider_dispatches, 1);

  // And the NEXT run is warm again under the new proven contract.
  const rewarmed = await runLane({ world: driftedWorld, brain: 'claude', text: operation.paraphrases.claude[1]! });
  assert.deepEqual((rewarmed.result as Extract<typeof rewarmed.result, { outcome: 'terminal' }>).counters, WARM_GATE);
});

test('D4: wrong tenant, workspace, or account never reuses — every foreign AUTHORITY goes cold', async () => {
  const operation = OPERATIONS[2]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });
  for (const portsOptions of [
    { brain: 'codex' as const, tenant: 'tenant-2' },
    { brain: 'codex' as const, workspace: 'ws-2' },
    { brain: 'codex' as const, account: 'other@example.com' },
  ]) {
    // E3.1: lane and scope are ONE sealed authority, so the foreign run
    // seals its own lane for its own identity — and still never reuses
    // tenant-1's proven procedure.
    const foreignLane = laneFor({
      tenant: portsOptions.tenant ?? 'tenant-1',
      workspace: portsOptions.workspace ?? 'ws-1',
      accountIdentity: portsOptions.account ?? 'person@example.com',
    });
    const foreign = await runLane({
      world, brain: 'codex', text: operation.paraphrases.codex[0]!, portsOptions, lane: foreignLane,
    });
    assert.equal(foreign.result.outcome, 'terminal', JSON.stringify(foreign.result));
    assert.equal((foreign.result as Extract<typeof foreign.result, { outcome: 'terminal' }>).warm, false,
      `${JSON.stringify(portsOptions)}: a foreign scope reused a proven procedure`);
  }
});

test('D4: reconnecting the same stable logical account works after live verification', async () => {
  const operation = OPERATIONS[1]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });

  const disconnected = await runLane({
    world, brain: 'codex', text: operation.paraphrases.codex[0]!,
    portsOptions: { brain: 'codex', connected: false },
  });
  assert.equal(disconnected.result.outcome, 'failed');
  assert.equal((disconnected.result as Extract<typeof disconnected.result, { outcome: 'failed' }>).transient, true);

  // Reconnected (a NEW rotating connection, the SAME stable account): warm.
  const reconnected = await runLane({ world, brain: 'codex', text: operation.paraphrases.codex[0]! });
  assert.deepEqual((reconnected.result as Extract<typeof reconnected.result, { outcome: 'terminal' }>).counters, WARM_GATE);
});

test('D4: missing slots ask ONE concise question once and never poison the artifact', async () => {
  const operation = OPERATIONS[1]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });

  const unslotted = await runLane({
    world, brain: 'codex', text: operation.paraphrases.codex[0]!,
    portsOptions: { brain: 'codex', overrideSlotValues: {} },
  });
  assert.equal(unslotted.result.outcome, 'needs_slots');
  const needs = unslotted.result as Extract<typeof unslotted.result, { outcome: 'needs_slots' }>;
  assert.deepEqual(needs.missingSlots, ['query']);
  assert.match(needs.question, /query/);
  assert.equal(needs.counters.provider_dispatches, 0, 'a dispatch ran without its slots');

  // The artifact was not poisoned: the answered follow-up is warm.
  const answered = await runLane({ world, brain: 'codex', text: operation.paraphrases.codex[1]! });
  assert.deepEqual((answered.result as Extract<typeof answered.result, { outcome: 'terminal' }>).counters, WARM_GATE);
});

test('D4: transient provider failure does not quarantine — the next run is still warm', async () => {
  const operation = OPERATIONS[0]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });

  const flaky = await runLane({
    world, brain: 'codex', text: operation.paraphrases.codex[0]!,
    portsOptions: { brain: 'codex', dispatchError: { error: 'HTTP 503 from the provider', transient: true } },
  });
  assert.equal(flaky.result.outcome, 'failed');
  assert.equal((flaky.result as Extract<typeof flaky.result, { outcome: 'failed' }>).transient, true);

  const recovered = await runLane({ world, brain: 'codex', text: operation.paraphrases.codex[1]! });
  assert.deepEqual((recovered.result as Extract<typeof recovered.result, { outcome: 'terminal' }>).counters, WARM_GATE);
});

test('D4: write/send intent exits BEFORE dispatch; no write capability can even seal under the read ceiling', async () => {
  const world = shimWorld();
  const exited = await runLane({ world, brain: 'claude', text: 'send the invoice summary to Brett' });
  assert.equal(exited.result.outcome, 'exits_to_governed_path');
  assert.equal(exited.result.counters.provider_dispatches, 0);
  assert.equal(exited.result.counters.external_write_or_send_dispatches, 0);
  assert.equal(world.counters.dispatch, 0, 'an effectful intent reached the provider through the read lane');

  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: 't', workspace: 'w', acceptedTurnId: 'turn', activationId: 'act',
      accountIdentity: 'person@example.com', policyHash: 'p', budgetVersion: 'v1',
    },
    capabilities: [{ name: 'X_SEND_MAIL', schemaFingerprint: 'fp', effectClass: 'send', accountIdentity: '' }],
    activeCapabilityNames: ['X_SEND_MAIL'],
    budget: { maxUncachedTokens: 1, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 1 },
  });
  assert.equal(sealed.ok, false, 'a send capability sealed under the read ceiling');
});

test('D4: no internal narration reaches the terminal — identifiers, slugs, and receipts stay inside', async () => {
  const operation = OPERATIONS[0]!;
  const world = shimWorld();
  const cold = await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });
  const text = (cold.result as Extract<typeof cold.result, { outcome: 'terminal' }>).text;
  assert.equal(text.includes(operation.identifier), false, 'a dispatch identifier leaked into the terminal');
  assert.equal(/rcpt_/.test(text), false, 'a receipt id leaked into the terminal');
  assert.equal(/discovery|schema|tool call|dispatch/i.test(text), false, 'control narration leaked into the terminal');
});

// ─── D1: sealed authority ────────────────────────────────────────────────────

test('D1: placeholder identity refuses — a blank tenant, workspace, turn, or budget version is no authority', () => {
  for (const over of [
    { tenant: '' }, { workspace: '  ' }, { acceptedTurnId: '' },
    { activationId: '' }, { policyHash: '' }, { budgetVersion: '' },
  ]) {
    const sealed = sealReadLaneEnvelope({
      identity: {
        tenant: 't', workspace: 'w', acceptedTurnId: 'turn', activationId: 'act',
        accountIdentity: 'person@example.com', policyHash: 'p', budgetVersion: 'v1',
        ...over,
      },
      capabilities: [],
      activeCapabilityNames: [],
      budget: { maxUncachedTokens: 1, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 1 },
    });
    assert.equal(sealed.ok, false, `${JSON.stringify(over)} sealed`);
  }
  const rotating = sealReadLaneEnvelope({
    identity: {
      tenant: 't', workspace: 'w', acceptedTurnId: 'turn', activationId: 'act',
      accountIdentity: 'ca_rotating123', policyHash: 'p', budgetVersion: 'v1',
    },
    capabilities: [], activeCapabilityNames: [],
    budget: { maxUncachedTokens: 1, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 1 },
  });
  assert.equal(rotating.ok, false, 'a rotating connection id became authority identity');
});

test('D1: MCP scope composes by intersection — neither authority can widen the other', () => {
  const lane = laneFor();
  const withScope = intersectWithMcpScope(lane, [OPERATIONS[0]!.identifier, 'mcp-only-tool']);
  assert.deepEqual([...withScope], [OPERATIONS[0]!.identifier]);
  const noScope = intersectWithMcpScope(lane, null);
  assert.equal(noScope.size, 0, 'null MCP authority is DENY under the existing MCP contract — never everything');
});

test('D1: outside-universe acquisition returns typed requires_readmission; inside-universe acquisition is a monotonic revision', async () => {
  const lane = laneFor();
  const outside = acquireLaneBinding(lane, 'NOT_IN_UNIVERSE');
  assert.deepEqual(outside, { ok: false, kind: 'requires_readmission', outside: ['NOT_IN_UNIVERSE'] });

  // A lane whose revision 1 bound only some of the universe can acquire the
  // rest monotonically.
  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: 'tenant-1', workspace: 'ws-1', acceptedTurnId: 'turn-narrow', activationId: 'act',
      accountIdentity: 'person@example.com', policyHash: 'p', budgetVersion: 'v1',
    },
    capabilities: OPERATIONS.map((operation) => ({
      name: operation.identifier, schemaFingerprint: 'fp', effectClass: 'read' as const, accountIdentity: '',
    })),
    activeCapabilityNames: [OPERATIONS[0]!.identifier],
    budget: { maxUncachedTokens: 1, maxModelCalls: 1, maxToolCalls: 1, maxElapsedMs: 1 },
  });
  assert.equal(sealed.ok, true);
  const narrow = (sealed as Extract<typeof sealed, { ok: true }>).lane;
  assert.equal(laneAdmitsDispatch(narrow, OPERATIONS[1]!.identifier), false,
    'a tool absent from the active bound revision dispatched');
  const acquired = acquireLaneBinding(narrow, OPERATIONS[1]!.identifier);
  assert.equal(acquired.ok, true);
  const grown = (acquired as Extract<typeof acquired, { ok: true }>).lane;
  assert.equal(grown.revision.revision, 2);
  assert.equal(laneAdmitsDispatch(grown, OPERATIONS[1]!.identifier), true);
  // The read lane refuses to DISPATCH outside its bound revision (typed).
  const world = shimWorld();
  const { ports, scope } = world.portsFor({ brain: 'claude' });
  const refused = await runColdToWarmRead({
    lane: narrow, input: OPERATIONS[1]!.paraphrases.claude[0]!, scope,
    budget: meter(), spans: createSpanRecorder(() => 0), ports,
  });
  assert.equal(refused.outcome, 'requires_readmission', JSON.stringify(refused));
});

// ─── the mechanism is generic and its spans are certifiable ──────────────────

test('the lane knows no operation, provider, or fixture name — genericity is pinned textually', async () => {
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    readFileSync(path.join(here, 'read-lane.ts'), 'utf-8'),
    readFileSync(path.join(here, 'read-envelope.ts'), 'utf-8'),
  ].join('\n');
  for (const forbidden of [
    ...OPERATIONS.map((operation) => operation.provider),
    ...OPERATIONS.map((operation) => operation.operation),
    ...OPERATIONS.map((operation) => operation.identifier),
    'calendar', 'outlook', 'gmail', 'slack', 'drive', 'notion', 'crm',
  ]) {
    assert.equal(sources.toLowerCase().includes(forbidden.toLowerCase()), false,
      `the lane's control flow names "${forbidden}" — operations are fixtures, never branches`);
  }
});

test('warm runs produce the spans the performance cohort requires — and a missing span is uncertifiable', async () => {
  const operation = OPERATIONS[0]!;
  const world = shimWorld();
  await runLane({ world, brain: 'claude', text: operation.paraphrases.claude[0]! });
  const warm = await runLane({ world, brain: 'codex', text: operation.paraphrases.codex[0]! });
  const record = { envelope: { lane: 'read' }, spans: warm.spans.spans() };
  const certified = certifyPerformanceSample(record, ['capability_resolution', 'tool_provider', 'verification', 'terminal_commit']);
  assert.deepEqual(certified, { certified: true }, JSON.stringify(record.spans));
  const uncertifiable = certifyPerformanceSample(record, ['model_ttft']);
  assert.equal(uncertifiable.certified, false);
});

// ─── slot binding stays pure and structural ──────────────────────────────────

test('bindSlots fills structure without reinventing field names; unboundSlots names exactly what is missing', () => {
  const bound = bindSlots({ a: '{{x}}', nested: { b: ['{{y}}', 'lit'] } }, { x: '1', y: '2' });
  assert.deepEqual(bound, { a: '1', nested: { b: ['2', 'lit'] } });
  assert.deepEqual(unboundSlots({ a: '{{x}}', b: '{{x}}', c: '{{z}}' }), ['x', 'z']);
});
