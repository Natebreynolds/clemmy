/**
 * Run: npx tsx --test src/runtime/harness/read-lane-production-seam.test.ts
 *
 * E4 production-seam matrix: the provider-neutral accepted-turn resolver is
 * called from respond-bridge BEFORE brain divergence. Injected resolver ports
 * prove that shared seam for three carrier families; production activation is
 * deliberately narrower and separately proves only governed Composio reads.
 * Both paths must cost ORDINARY chat nothing.
 *
 * Every case crosses the bridge's real entry (`respondPreferHarness`). Tests
 * explicitly say when they use injected provider-neutral resolver ports and
 * when they exercise the default production factory without that injection.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-e4-seam-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

import test from 'node:test';
import assert from 'node:assert/strict';

const { respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
const { promoteFromVerifiedReceipt } = await import('../../memory/procedure-receipts.js');
const { productionScope } = await import('../read-path/read-lane-chat.js');
const eventlog = await import('./eventlog.js');
const { closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
const { listEvents } = eventlog;
type ReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;
type AcceptedTurnReadPorts = import('../read-path/read-lane-chat.js').AcceptedTurnReadPorts;
type AssistantRequest = import('../../types.js').AssistantRequest;

test.after(() => {
  _setBridgeImplsForTests({});
  eventlog.closeEventLog();
  closeOperationalTelemetryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
});

const ACCOUNT = 'person@example.com';
const SCOPE = productionScope(ACCOUNT);

test('E4 deterministic warm presenter preserves natural strings and humanizes records and lists', async () => {
  const { presentWarmReadEvidence } = await import('../read-path/read-lane-adapters.js');
  const natural = 'I found two events.\n\n- Stand-up at 9:00\n- Design review at 11:30';
  assert.equal(presentWarmReadEvidence(natural), natural, 'natural evidence changed byte-for-byte');
  const jsonLookingNatural = '{"note":"keep this exact string"}';
  assert.equal(presentWarmReadEvidence(jsonLookingNatural), jsonLookingNatural,
    'a natural JSON-looking string was reinterpreted as structured evidence');
  assert.equal(presentWarmReadEvidence({ successful: true, data: natural }), natural,
    'a generic success wrapper changed an already-natural result');

  const record = presentWarmReadEvidence({
    successful: true,
    data: { result: { title: 'Design review', owner: 'Sam' } },
  });
  assert.equal(record, "Here's what I found:\n\n- Title: Design review\n- Owner: Sam");
  assert.doesNotMatch(record, /^\{.*\}$/s, 'record evidence remained raw one-line JSON');

  const list = presentWarmReadEvidence({
    ok: true,
    results: [
      { title: 'Design review', startsAt: '11:30' },
      { title: 'Focus block', startsAt: '15:00' },
    ],
  });
  assert.match(list, /^Here's what I found:\n\n\| Title \| Starts At \|/);
  assert.match(list, /\| Design review \| 11:30 \|/);
  assert.doesNotMatch(list, /"results"|"title":/, 'list evidence leaked a JSON envelope');
});

test('E4 deterministic warm presenter keeps structured output within the receipt bound', async () => {
  const {
    presentWarmReadEvidence,
    WARM_READ_PRESENTATION_MAX_CHARS,
  } = await import('../read-path/read-lane-adapters.js');
  // This remains under the accepted 4 KB serialized-evidence limit while the
  // conversational prefix/bullets would exceed it without output bounding.
  const evidence = { items: Array.from({ length: 995 }, () => 'x') };
  assert.ok(JSON.stringify(evidence).length <= WARM_READ_PRESENTATION_MAX_CHARS);
  const presented = presentWarmReadEvidence(evidence);
  assert.ok(presented.length <= WARM_READ_PRESENTATION_MAX_CHARS);
  assert.match(presented, /additional results omitted/);
});

test('E4 deterministic warm presenter preserves nested multiline content and keeps provider Markdown inert', async () => {
  const { presentWarmReadEvidence } = await import('../read-path/read-lane-adapters.js');
  const multiline = 'first line\n  indented second line\n\n```literal fence```';
  const presented = presentWarmReadEvidence({
    successful: true,
    error: null,
    data: {
      items: [{
        'title|*role*': '<admin>',
        body: multiline,
      }],
    },
  });
  assert.ok(presented.includes('- Title\\|\\*role\\*: &lt;admin&gt;'),
    'provider-controlled bullet label/value changed Markdown structure');
  assert.ok(presented.includes('      first line\n        indented second line\n      \n      ```literal fence```'),
    'nested multiline evidence lost intentional line breaks or indentation');
  assert.doesNotMatch(presented, /- Successful:|- Error:|- Data:|- Items:/,
    'a successful envelope with inert error metadata was not unwrapped');

  const table = presentWarmReadEvidence({
    items: [
      { 'name|role': '[*admin*](unsafe)', note: '<b>one</b>' },
      { 'name|role': '_viewer_', note: '<script>two</script>' },
    ],
  });
  assert.ok(table.includes('| Name\\|role | Note |'), 'provider key fabricated a Markdown table column');
  assert.doesNotMatch(table, /<b>|<script>|"name\|role"/, 'provider cell markup or raw JSON escaped presentation');
  assert.ok(table.includes('\\[\\*admin\\*\\](unsafe)'), 'provider link syntax remained active in a table cell');
});

test('E4 deterministic warm presenter balances its bounded fallback around adversarial backticks', async () => {
  const {
    presentWarmReadEvidence,
    WARM_READ_PRESENTATION_MAX_CHARS,
  } = await import('../read-path/read-lane-adapters.js');
  const deep = {
    one: { two: { three: { four: { five: { six: { payload: '`'.repeat(4_000) } } } } } },
  };
  const presented = presentWarmReadEvidence(deep);
  assert.ok(presented.length <= WARM_READ_PRESENTATION_MAX_CHARS);
  assert.match(presented, /^Here's what I found:\n\n```text\n/);
  assert.ok(presented.endsWith('\n```'), 'bounded fallback lost its closing fence');
  assert.match(presented, /additional results omitted/);
});

test('E4 deterministic warm presenter truncates only at complete Markdown and Unicode boundaries', async () => {
  const {
    presentWarmReadEvidence,
    WARM_READ_PRESENTATION_MAX_CHARS,
  } = await import('../read-path/read-lane-adapters.js');
  const prefix = "Here's what I found:\n\n- Value: ";
  const suffix = '\n\n... (additional results omitted)';
  const available = WARM_READ_PRESENTATION_MAX_CHARS - suffix.length;
  const visiblePrefix = (presented: string): string => {
    const omission = presented.indexOf(suffix);
    assert.notEqual(omission, -1, 'fixture did not cross the presentation bound');
    return presented.slice(0, omission);
  };

  const entityFiller = 'a'.repeat(available - prefix.length - 2);
  const entity = presentWarmReadEvidence({ value: `${entityFiller}<${'tail'.repeat(20)}` });
  assert.equal(entity.length <= WARM_READ_PRESENTATION_MAX_CHARS, true);
  assert.equal(visiblePrefix(entity), `${prefix}${entityFiller}`,
    'the bound retained a partial &lt; entity');

  const escapeFiller = 'a'.repeat(available - prefix.length - 1);
  const escape = presentWarmReadEvidence({ value: `${escapeFiller}*${'tail'.repeat(20)}` });
  assert.equal(visiblePrefix(escape), `${prefix}${escapeFiller}`,
    'the bound retained a dangling Markdown backslash escape');

  const surrogateFiller = 'a'.repeat(available - prefix.length - 1);
  const surrogate = presentWarmReadEvidence({ value: `${surrogateFiller}😀${'tail'.repeat(20)}` });
  assert.equal(visiblePrefix(surrogate), `${prefix}${surrogateFiller}`,
    'the bound retained half of a Unicode surrogate pair');
  assert.equal(surrogate.includes('\uFFFD'), false, 'bounded Unicode produced a replacement character');
});

test('E4 pre-encoding read receipts replay their original bounded raw-text draft deterministically', async () => {
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-legacy-untyped-warm-receipt';
  const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
  const attempt = eventlog.getActiveRunAttempt(sessionId)!;
  const record: ReceiptRecord = {
    receiptId: 'readrcpt_legacy_untyped',
    at: '2026-08-08T00:00:00.000Z',
    provider: operation.provider,
    operation: operation.operation,
    effectClass: 'read',
    identifier: operation.identifier,
    schemaFingerprint: `fp-${operation.identifier}`,
    scope: { ...SCOPE },
    dispatchOutcome: 'succeeded',
    readEvidenceRef: 'evt:legacy-untyped',
  };
  const rawLegacyDraft = '{"successful":true,"data":{"items":[{"title":"legacy raw text"}]}}';
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'read_receipt',
    data: {
      record,
      sourceUserSeq: request.sourceUserSeq,
      attemptId: attempt.attemptId,
      evidenceSummary: rawLegacyDraft,
      // Intentionally no evidenceEncoding: this is the pre-v1 receipt shape.
    },
  });
  const ports = adapters.buildProductionReadPorts({
    sessionId,
    sourceUserSeq: request.sourceUserSeq!,
    sourceTurn: 1,
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    userInput: request.message,
    scope: SCOPE,
    authorizedArtifact: {
      artifactId: 'pa_legacy_untyped',
      kind: operation.kind,
      identifier: operation.identifier,
      provider: operation.provider,
      operation: operation.operation,
      schemaFingerprint: `fp-${operation.identifier}`,
      scope: { ...SCOPE },
    },
    connectedAccountIds: new Set<string>(),
    liveSchemaFingerprint: () => `fp-${operation.identifier}`,
    accountConnected: () => true,
  });
  assert.equal((await ports.present(record)).draft, rawLegacyDraft);
  assert.equal((await ports.present(record)).draft, rawLegacyDraft,
    'legacy replay changed across identical reads');
});

function acceptedRequest(sessionId: string, message: string, runId?: string): AssistantRequest {
  if (!eventlog.getSession(sessionId)) {
    eventlog.createSession({ id: sessionId, kind: 'chat', channel: 'home', title: message.slice(0, 60) });
  }
  const attempt = eventlog.beginRunAttempt(sessionId, { runId });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: message, attemptId: attempt.attemptId, source: 'test' },
  }, { armRunInFlight: true });
  return { sessionId, message, sourceUserSeq: source.seq, ...(runId ? { runId } : {}) };
}

/** Injected resolver fixtures: builtin/local, MCP, and connected broker. */
const OPERATIONS = [
  {
    label: 'local/builtin read',
    provider: 'localdocs', operation: 'note_lookup',
    identifier: 'note_lookup', kind: 'cli' as const,
    templateArgs: { scopeAll: true },
    paraphrases: ['localdocs note lookup please', 'do a localdocs note lookup'],
    evidence: 'Note: the invoice thread ends with Sam approving the total.',
  },
  {
    label: 'MCP read',
    provider: 'chatterly', operation: 'history_search',
    identifier: 'chatterly__history_search', kind: 'mcp' as const,
    templateArgs: { limit: 20 },
    paraphrases: ['run a chatterly history search', 'chatterly history search now'],
    evidence: 'Two matches in #finance from last week.',
  },
  {
    label: 'connected broker read',
    provider: 'schedulerco', operation: 'list_events',
    identifier: 'SCHEDULERCO_LIST_EVENTS', kind: 'composio' as const,
    templateArgs: { window: 'today' },
    paraphrases: ['schedulerco list events', 'list events on schedulerco'],
    evidence: 'Three blocks: 9:00 standup, 11:30 review, 15:00 focus.',
  },
];

let receiptSeq = 0;

/** Deterministic ports; every dispatch appends a real durable receipt row. */
function portsFor(input: {
  sessionId: string;
  connected?: boolean;
  fingerprintFor?: (identifier: string) => string | undefined;
  onDispatch?: (identifier: string) => void;
}): AcceptedTurnReadPorts {
  const receipts = new Map<string, ReceiptRecord>();
  const fingerprintFor = input.fingerprintFor ?? ((identifier: string) => `fp-${identifier}`);
  return {
    scope: () => SCOPE,
    liveSchemaFingerprint: (identifier) => fingerprintFor(identifier),
    accountConnected: () => input.connected ?? true,
    receipts: { resolve: (id) => receipts.get(id) },
    async dispatch(bound) {
      input.onDispatch?.(bound.identifier);
      const record: ReceiptRecord = {
        receiptId: `rcpt_${(receiptSeq += 1)}`,
        at: '2026-08-04T00:00:00.000Z',
        provider: bound.provider,
        operation: bound.operation,
        effectClass: 'read',
        identifier: bound.identifier,
        schemaFingerprint: bound.schemaFingerprint,
        scope: { tenant: bound.tenant, workspace: bound.workspace, accountIdentity: bound.accountIdentity },
        dispatchOutcome: 'succeeded',
        readEvidenceRef: `ev-${receiptSeq}`,
      };
      receipts.set(record.receiptId, record);
      return { receiptId: record.receiptId };
    },
    async present(evidence) {
      const fixture = OPERATIONS.find((candidate) => candidate.identifier === evidence.identifier);
      return { draft: fixture?.evidence ?? 'Done.' };
    },
    clock: () => 0,
  };
}

async function promoteAll(): Promise<void> {
  for (const operation of OPERATIONS) {
    const record: ReceiptRecord = {
      receiptId: `seed_${operation.identifier}`,
      at: '2026-08-04T00:00:00.000Z',
      provider: operation.provider,
      operation: operation.operation,
      effectClass: 'read',
      identifier: operation.identifier,
      schemaFingerprint: `fp-${operation.identifier}`,
      scope: { ...SCOPE },
      dispatchOutcome: 'succeeded',
      readEvidenceRef: 'seed-ev',
    };
    const promoted = await promoteFromVerifiedReceipt({
      scope: { ...SCOPE },
      provider: operation.provider,
      operation: operation.operation,
      effectClass: 'read',
      kind: operation.kind,
      identifier: operation.identifier,
      templateArgs: operation.templateArgs,
      receiptId: record.receiptId,
      acquiredSchemaFingerprint: `fp-${operation.identifier}`,
    }, { resolve: (id) => (id === record.receiptId ? record : undefined) });
    assert.equal(promoted.ok, true, `${operation.label}: ${JSON.stringify(promoted)}`);
  }
}

/** Bridge harness: both brains, deterministic, no live transport. */
function installBridge(input: {
  brain: 'claude' | 'codex';
  ports: (request: AssistantRequest) => AcceptedTurnReadPorts | null;
  onBrainRun?: () => void;
}): void {
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    acceptedTurnReadPorts: (_surface, request) => input.ports(request),
    // Both brain paths record that they ran — a warm read must reach NEITHER.
    claudeAgentBrain: async (_surface, request) => {
      input.onBrainRun?.();
      return { text: 'brain answer', sessionId: request.sessionId };
    },
    runConversation: async (options) => {
      input.onBrainRun?.();
      return {
        status: 'completed',
        publicPresentation: { kind: 'answer', text: 'brain answer' },
        sessionId: options.sessionId,
      } as unknown as Awaited<ReturnType<typeof import('./loop.js').runConversation>>;
    },
    buildAgent: async () => ({} as never),
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = input.brain === 'claude' ? 'on' : 'off';
}

function resetBridge(): void {
  _setBridgeImplsForTests({});
  delete process.env.CLEMMY_CLAUDE_AGENT_BRAIN;
}

/** Default production read factory, deterministic ordinary brain. */
function installProductionBridge(onBrainRun?: () => void): void {
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    claudeAgentBrain: async (_surface, request) => {
      onBrainRun?.();
      return { text: 'brain answer', sessionId: request.sessionId };
    },
    runConversation: async (options) => {
      onBrainRun?.();
      return {
        status: 'completed',
        publicPresentation: { kind: 'answer', text: 'brain answer' },
        sessionId: options.sessionId,
      } as never;
    },
    buildAgent: async () => ({} as never),
    // Deliberately no acceptedTurnReadPorts override.
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
}

// ─── the seam matrix ─────────────────────────────────────────────────────────

test('E4: a warm read is served through the SHARED bridge seam on both brains — one dispatch, one terminal, no brain run', async () => {
  await promoteAll();
  for (const brain of ['claude', 'codex'] as const) {
    for (const operation of OPERATIONS) {
      const sessionId = `sess-${brain}-${operation.identifier}`;
      const dispatched: string[] = [];
      let brainRuns = 0;
      installBridge({
        brain,
        ports: () => portsFor({ sessionId, onDispatch: (id) => dispatched.push(id) }),
        onBrainRun: () => { brainRuns += 1; },
      });
      try {
        const response = await respondPreferHarness('cron',
          acceptedRequest(sessionId, operation.paraphrases[0]!),
          async () => ({ text: 'legacy', sessionId }));
        assert.equal(response.text, operation.evidence,
          `${brain}/${operation.label}: the warm evidence draft was not the committed terminal`);
        assert.deepEqual(dispatched, [operation.identifier],
          `${brain}/${operation.label}: expected exactly one bound dispatch`);
        assert.equal(brainRuns, 0,
          `${brain}/${operation.label}: a brain ran although the read lane served the turn`);
        const counters = (response.raw as { readLane?: { counters?: Record<string, number> } } | undefined)?.readLane?.counters;
        assert.equal(counters?.schema_discovery_calls, 0);
        assert.equal(counters?.tool_discovery_calls, 0);
        assert.equal(counters?.provider_dispatches, 1);
        assert.equal(counters?.validation_repairs, 0);
        assert.equal(counters?.public_terminals, 1);
        assert.equal(counters?.external_write_or_send_dispatches, 0);
        // ONE public terminal for the accepted source.
        const completions = listEvents(sessionId)
          .filter((event) => event.type === 'conversation_completed');
        assert.equal(completions.length, 1,
          `${brain}/${operation.label}: expected exactly one committed terminal`);
      } finally {
        resetBridge();
      }
    }
  }
});

test('E4: ordinary chat pays NOTHING — no dispatch, no discovery, the normal brain owns the turn', async () => {
  await promoteAll();
  for (const brain of ['claude', 'codex'] as const) {
    const sessionId = `sess-plain-${brain}`;
    const dispatched: string[] = [];
    let brainRuns = 0;
    installBridge({
      brain,
      ports: () => portsFor({ sessionId, onDispatch: (id) => dispatched.push(id) }),
      onBrainRun: () => { brainRuns += 1; },
    });
    try {
      const response = await respondPreferHarness('cron', {
        sessionId, message: 'what do you think about the plan for next quarter?',
      }, async () => ({ text: 'legacy', sessionId }));
      assert.equal(brainRuns, 1, `${brain}: the ordinary brain did not run`);
      assert.deepEqual(dispatched, [], `${brain}: an ordinary turn dispatched a provider read`);
      assert.equal(response.text, 'brain answer');
    } finally {
      resetBridge();
    }
  }
});

test('E4: operation words inside commentary, judgment, or compound work stay brain-owned', async () => {
  await promoteAll();
  const messages = [
    'Hey, schedulerco list events is finally working!',
    'Schedulerco list events and tell me which one I should move.',
    'What do you think about schedulerco list events?',
    'Schedulerco list events for tomorrow.',
  ];
  for (const brain of ['claude', 'codex'] as const) {
    for (const [index, message] of messages.entries()) {
      const sessionId = `sess-conversational-warm-guard-${brain}-${index}`;
      const dispatched: string[] = [];
      let brainRuns = 0;
      installBridge({
        brain,
        ports: () => portsFor({ sessionId, onDispatch: (id) => dispatched.push(id) }),
        onBrainRun: () => { brainRuns += 1; },
      });
      try {
        const response = await respondPreferHarness('cron',
          acceptedRequest(sessionId, message),
          async () => ({ text: 'legacy', sessionId }));
        assert.deepEqual(dispatched, [], `${brain}: conversational wording dispatched a warm read`);
        assert.equal(brainRuns, 1, `${brain}: conversational wording bypassed the brain`);
        assert.equal(response.text, 'brain answer');
      } finally {
        resetBridge();
      }
    }
  }
});

test('E4: an unknown live schema declines to the brain — never a blind warm dispatch', async () => {
  await promoteAll();
  const sessionId = 'sess-unknown-schema';
  const dispatched: string[] = [];
  let brainRuns = 0;
  installBridge({
    brain: 'codex',
    ports: () => portsFor({
      sessionId,
      fingerprintFor: () => undefined,
      onDispatch: (id) => dispatched.push(id),
    }),
    onBrainRun: () => { brainRuns += 1; },
  });
  try {
    await respondPreferHarness('cron',
      acceptedRequest(sessionId, OPERATIONS[2]!.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.deepEqual(dispatched, [], 'a warm dispatch ran with no live schema');
    assert.equal(brainRuns, 1, 'the turn did not fall back to the ordinary brain');
  } finally {
    resetBridge();
  }
});

test('E4: a disconnected account declines to the brain; reconnect re-warms under the same stable account', async () => {
  await promoteAll();
  const operation = OPERATIONS[1]!;
  for (const connected of [false, true]) {
    const sessionId = `sess-conn-${String(connected)}`;
    const dispatched: string[] = [];
    let brainRuns = 0;
    installBridge({
      brain: 'claude',
      ports: () => portsFor({ sessionId, connected, onDispatch: (id) => dispatched.push(id) }),
      onBrainRun: () => { brainRuns += 1; },
    });
    try {
      await respondPreferHarness('cron',
        acceptedRequest(sessionId, operation.paraphrases[1]!),
        async () => ({ text: 'legacy', sessionId }));
      if (connected) {
        assert.deepEqual(dispatched, [operation.identifier], 'the reconnected account did not re-warm');
        assert.equal(brainRuns, 0);
      } else {
        assert.deepEqual(dispatched, [], 'a disconnected account dispatched');
        assert.equal(brainRuns, 1, 'the disconnected turn did not fall back to the brain');
      }
    } finally {
      resetBridge();
    }
  }
});

test('E4: the same accepted source commits exactly ONE terminal even across a repeated bridge call', async () => {
  await promoteAll();
  const operation = OPERATIONS[0]!;
  const sessionId = 'sess-one-terminal';
  let providerDispatches = 0;
  let brainRuns = 0;
  installBridge({
    brain: 'codex',
    ports: () => portsFor({ sessionId, onDispatch: () => { providerDispatches += 1; } }),
    onBrainRun: () => { brainRuns += 1; },
  });
  try {
    const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
    const first = await respondPreferHarness('cron', request,
      async () => ({ text: 'legacy', sessionId }));
    const firstSeq = request.sourceUserSeq;
    assert.ok(firstSeq);
    // A retry that REUSES the accepted source must not mint a second terminal.
    await respondPreferHarness('cron', {
      sessionId, message: operation.paraphrases[0]!, sourceUserSeq: firstSeq,
    }, async () => ({ text: 'legacy', sessionId }));
    const completions = listEvents(sessionId).filter((event) => event.type === 'conversation_completed');
    assert.equal(completions.length, 1,
      `one accepted source produced ${completions.length} terminals`);
    assert.equal(first.text, operation.evidence);
    assert.equal(providerDispatches, 1, 'terminal replay repeated the provider read');
    assert.equal(brainRuns, 0, 'terminal replay ran a brain before losing the duplicate commit');

    const wrongText = await respondPreferHarness('cron', {
      ...request,
      message: 'a different request borrowing the source sequence',
    }, async () => ({ text: 'legacy', sessionId }));
    assert.match(wrongText.text, /did not match the accepted turn identity/i);
    const wrongRun = await respondPreferHarness('cron', {
      ...request,
      runId: 'stranger-run',
    }, async () => ({ text: 'legacy', sessionId }));
    assert.match(wrongRun.text, /did not match the accepted turn identity/i);
    assert.equal(providerDispatches, 1, 'forged replay identity repeated the provider read');
    assert.equal(brainRuns, 0, 'forged replay identity reached the brain');
  } finally {
    resetBridge();
  }
});

test('E4: concurrent followers for one accepted attempt coalesce to one dispatch and one terminal', async () => {
  await promoteAll();
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-one-concurrent-warm-activation';
  let factoryCalls = 0;
  let providerDispatches = 0;
  let brainRuns = 0;
  installBridge({
    brain: 'codex',
    ports: () => {
      factoryCalls += 1;
      return portsFor({ sessionId, onDispatch: () => { providerDispatches += 1; } });
    },
    onBrainRun: () => { brainRuns += 1; },
  });
  const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
  try {
    const [first, follower] = await Promise.all([
      respondPreferHarness('cron', request, async () => ({ text: 'legacy', sessionId })),
      respondPreferHarness('cron', request, async () => ({ text: 'legacy', sessionId })),
    ]);
    assert.equal(first.text, operation.evidence);
    assert.equal(follower.text, operation.evidence);
    assert.equal(factoryCalls, 1, 'concurrent follower built a second warm activation');
    assert.equal(providerDispatches, 1, 'concurrent follower dispatched independently');
    assert.equal(brainRuns, 0);
    const completed = listEvents(sessionId).filter((event) => event.type === 'conversation_completed');
    assert.equal(completed.length, 1);
    assert.match(String(completed[0]!.data.artifactId), /^pa_[a-f0-9]{40}$/);
    assert.match(String(completed[0]!.data.laneDigest), /^[a-f0-9]{64}$/);
    assert.match(String(completed[0]!.data.warmReadPolicyDigest), /^[a-f0-9]{64}$/);
    assert.equal((completed[0]!.data.counters as { public_terminals?: number }).public_terminals, 1,
      'the winning delivery commit did not persist its one public terminal');
  } finally {
    resetBridge();
  }
});

test('E4: a concurrent follower with a different tool policy is blocked without joining or starting another path', async () => {
  await promoteAll();
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-concurrent-policy-conflict';
  let providerDispatches = 0;
  let brainRuns = 0;
  let releaseDispatch!: () => void;
  let markDispatchEntered!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => { markDispatchEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  installBridge({
    brain: 'codex',
    ports: () => {
      const base = portsFor({ sessionId });
      const dispatch = base.dispatch;
      return {
        ...base,
        async dispatch(bound) {
          providerDispatches += 1;
          markDispatchEntered();
          await release;
          return dispatch(bound);
        },
      };
    },
    onBrainRun: () => { brainRuns += 1; },
  });
  const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
  try {
    const leader = respondPreferHarness('cron', request,
      async () => ({ text: 'legacy', sessionId }));
    await dispatchEntered;
    const follower = await respondPreferHarness('cron', {
      ...request,
      allowedToolNames: ['composio_execute_tool'],
    }, async () => ({ text: 'legacy', sessionId }));
    assert.match(follower.text, /different tool boundary/i);
    const carrierDeniedFollower = await respondPreferHarness('cron', {
      ...request,
      allowedToolNames: [],
    }, async () => ({ text: 'legacy', sessionId }));
    assert.match(carrierDeniedFollower.text, /different tool boundary/i,
      'carrier-denied follower fell through to a brain while warm provider I/O was in flight');
    releaseDispatch();
    const served = await leader;
    assert.equal(served.text, operation.evidence);
    const serialFollower = await respondPreferHarness('cron', {
      ...request,
      allowedToolNames: ['composio_execute_tool'],
    }, async () => ({ text: 'legacy', sessionId }));
    assert.match(serialFollower.text, /different tool boundary/i,
      'durable terminal replay leaked a warm answer across a changed tool policy');
    assert.equal(providerDispatches, 1);
    assert.equal(brainRuns, 0);
  } finally {
    releaseDispatch?.();
    resetBridge();
  }
});

test('E4: a brain-first restricted invocation blocks a warm duplicate for the same accepted source', async () => {
  await promoteAll();
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-brain-first-policy-conflict';
  let providerDispatches = 0;
  let factoryCalls = 0;
  let brainRuns = 0;
  let releaseBrain!: () => void;
  let markBrainEntered!: () => void;
  const brainEntered = new Promise<void>((resolve) => { markBrainEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseBrain = resolve; });
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    acceptedTurnReadPorts: () => {
      factoryCalls += 1;
      return portsFor({ sessionId, onDispatch: () => { providerDispatches += 1; } });
    },
    runConversation: async (options) => {
      brainRuns += 1;
      markBrainEntered();
      await release;
      return {
        status: 'completed',
        publicPresentation: { kind: 'answer', text: 'brain answer' },
        sessionId: options.sessionId,
      } as never;
    },
    buildAgent: async () => ({} as never),
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
  const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
  try {
    const restricted = respondPreferHarness('cron', {
      ...request,
      allowedToolNames: [],
    }, async () => ({ text: 'legacy', sessionId }));
    await brainEntered;
    const warmDuplicate = await respondPreferHarness('cron', request,
      async () => ({ text: 'legacy', sessionId }));
    assert.match(warmDuplicate.text, /different tool boundary/i);
    assert.equal(factoryCalls, 0, 'warm duplicate built ports while the source brain was already owned');
    assert.equal(providerDispatches, 0, 'warm duplicate dispatched while the source brain was already running');
    releaseBrain();
    assert.equal((await restricted).text, 'brain answer');
    assert.equal(brainRuns, 1);
  } finally {
    releaseBrain?.();
    resetBridge();
  }
});

test('E4: no internal narration reaches the committed terminal', async () => {
  await promoteAll();
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-narration';
  installBridge({ brain: 'claude', ports: () => portsFor({ sessionId }) });
  try {
    const response = await respondPreferHarness('cron',
      acceptedRequest(sessionId, operation.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text.includes(operation.identifier), false, 'a dispatch identifier leaked');
    assert.equal(/rcpt_|readrcpt_/.test(response.text), false, 'a receipt id leaked');
    assert.equal(/discovery|schema|dispatch|tool call/i.test(response.text), false, 'control narration leaked');
  } finally {
    resetBridge();
  }
});

test('E4 authority: missing or mismatched accepted source never even builds warm ports', async () => {
  await promoteAll();
  for (const shape of ['missing', 'mismatch'] as const) {
    const sessionId = `sess-authority-${shape}`;
    let factoryCalls = 0;
    let brainRuns = 0;
    installBridge({
      brain: 'codex',
      ports: () => { factoryCalls += 1; return portsFor({ sessionId }); },
      onBrainRun: () => { brainRuns += 1; },
    });
    try {
      let request: AssistantRequest = { sessionId, message: OPERATIONS[2]!.paraphrases[0]! };
      if (shape === 'mismatch') {
        const accepted = acceptedRequest(sessionId, request.message);
        // A newer active attempt owns another valid source. The requested
        // source remains durable, but it is not current warm-read authority.
        acceptedRequest(sessionId, 'a newer accepted turn owns the session');
        request = accepted;
      }
      const response = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.equal(response.text, 'brain answer');
      assert.equal(factoryCalls, 0, `${shape}: warm authority reached a port factory`);
      assert.equal(brainRuns, 1, `${shape}: ordinary brain did not continue`);
    } finally {
      resetBridge();
    }
  }
});

test('E4 authority correlation accepts either an external run id or Discord current attempt id, never a stranger', async () => {
  const { currentAcceptedReadAuthority } = await import('../read-path/accepted-read-authority.js');

  const discordSession = 'sess-authority-discord-correlation';
  const discordRequest = acceptedRequest(discordSession, 'discord accepted source');
  const discordAttempt = eventlog.getActiveRunAttempt(discordSession)!;
  assert.ok(currentAcceptedReadAuthority(
    discordSession,
    discordRequest.sourceUserSeq,
    discordAttempt.attemptId,
  ), 'Discord attempt-id correlation was rejected');

  const externalSession = 'sess-authority-external-correlation';
  const externalRequest = acceptedRequest(externalSession, 'external accepted source', 'external-run-42');
  assert.ok(currentAcceptedReadAuthority(
    externalSession,
    externalRequest.sourceUserSeq,
    'external-run-42',
  ), 'external run-id correlation was rejected');
  assert.equal(currentAcceptedReadAuthority(
    externalSession,
    externalRequest.sourceUserSeq,
    'another-run',
  ), null, 'an unrelated run correlation gained warm-read authority');
});

test('E4 caller tool authority: empty, unrelated, or dynamic-only allows and carrier exclusion all over-decline before ports', async () => {
  await promoteAll();
  const cases: Array<{ label: string; patch: Partial<AssistantRequest> }> = [
    { label: 'empty allowlist', patch: { allowedToolNames: [] } },
    { label: 'unrelated allowlist', patch: { allowedToolNames: ['note_lookup'] } },
    {
      label: 'dynamic slug without governed carrier',
      patch: { allowedToolNames: [OPERATIONS[2]!.identifier] },
    },
    { label: 'governed carrier excluded', patch: { excludeToolNames: ['composio_execute_tool'] } },
  ];
  for (const [index, fixture] of cases.entries()) {
    const sessionId = `sess-tool-authority-${index}`;
    let factoryCalls = 0;
    let brainRuns = 0;
    installBridge({
      brain: 'codex',
      ports: () => {
        factoryCalls += 1;
        return portsFor({ sessionId });
      },
      onBrainRun: () => { brainRuns += 1; },
    });
    try {
      const response = await respondPreferHarness('cron', {
        ...acceptedRequest(sessionId, OPERATIONS[2]!.paraphrases[0]!),
        ...fixture.patch,
      }, async () => ({ text: 'legacy', sessionId }));
      assert.equal(response.text, 'brain answer', `${fixture.label}: ordinary brain did not own the decline`);
      assert.equal(factoryCalls, 0, `${fixture.label}: entered the warm port factory without carrier authority`);
      assert.equal(brainRuns, 1, `${fixture.label}: ordinary brain did not run exactly once`);
    } finally {
      resetBridge();
    }
  }
});

test('E4 cancellation authority: pre-cancel and an existing exact Stop both cause zero warm construction or dispatch', async () => {
  await promoteAll();
  for (const mode of ['predicate', 'durable-stop'] as const) {
    const sessionId = `sess-warm-cancel-${mode}`;
    let factoryCalls = 0;
    let providerDispatches = 0;
    let brainRuns = 0;
    installBridge({
      brain: 'codex',
      ports: () => {
        factoryCalls += 1;
        return portsFor({ sessionId, onDispatch: () => { providerDispatches += 1; } });
      },
      onBrainRun: () => { brainRuns += 1; },
    });
    const request = acceptedRequest(sessionId, OPERATIONS[2]!.paraphrases[0]!);
    if (mode === 'predicate') request.shouldCancel = () => true;
    else {
      const attempt = eventlog.getActiveRunAttempt(sessionId)!;
      eventlog.requestKill(sessionId, 'Stop before warm activation', {
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        sourceUserSeq: request.sourceUserSeq,
      });
    }
    try {
      const response = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.equal(response.text, 'brain answer');
      assert.equal(factoryCalls, 0, `${mode}: a cancelled accepted source built warm ports`);
      assert.equal(providerDispatches, 0, `${mode}: a cancelled accepted source dispatched`);
      assert.equal(brainRuns, 1);
    } finally {
      resetBridge();
    }
  }
});

test('E4 production restart: exact-slug authority refresh serves through the full bridge with one business dispatch and no brain', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  let providerDispatches = 0;
  let brainRuns = 0;
  let metadataRefreshes = 0;
  let refreshedFingerprint: string | undefined;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => [{
      slug: 'schedulerco', connectionId: 'ca_rotating-but-not-authority', status: 'ACTIVE', accountEmail: ACCOUNT,
    }],
    liveFingerprint: () => refreshedFingerprint,
    ensureLiveFingerprint: async (_identifier, observer) => {
      metadataRefreshes += 1;
      refreshedFingerprint = `fp-${operation.identifier}`;
      observer?.({ outcome: 'refreshed', durationMs: 4, fingerprint: refreshedFingerprint });
      return refreshedFingerprint;
    },
    dispatchTool: (async (slug, args, options) => {
      assert.equal(options.sessionId?.startsWith('sess-production-default'), true);
      assert.equal(options.preferredIdentity, ACCOUNT);
      assert.ok(options.dispatchBoundary, 'production adapter bypassed the gateway boundary');
      const result = await options.dispatchBoundary!({
        toolSlug: slug, args, connectionId: 'ca_rotating-but-not-authority', identity: ACCOUNT,
        schemaFingerprint: `fp-${operation.identifier}`,
      }, async () => {
        providerDispatches += 1;
        return { successful: true, data: { items: [{ title: 'Design review' }] } };
      });
      return { ok: true, result, connectionId: 'ca_rotating-but-not-authority', identity: ACCOUNT };
    }) as never,
  });
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    claudeAgentBrain: async (_surface, request) => {
      brainRuns += 1;
      return { text: 'brain answer', sessionId: request.sessionId };
    },
    runConversation: async (options) => {
      brainRuns += 1;
      return { status: 'completed', publicPresentation: { kind: 'answer', text: 'brain answer' }, sessionId: options.sessionId } as never;
    },
    buildAgent: async () => ({} as never),
    // Deliberately no acceptedTurnReadPorts injection: this is production reachability.
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
  const sessionId = 'sess-production-default';
  try {
    const response = await respondPreferHarness('cron',
      acceptedRequest(sessionId, operation.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text, "Here's what I found:\n\n- Title: Design review");
    assert.equal(metadataRefreshes, 1, 'restart authority did not perform exactly one metadata refresh');
    assert.equal(providerDispatches, 1);
    assert.equal(brainRuns, 0, 'a brain ran after the production warm lane served');
    const events = listEvents(sessionId);
    const completed = events.filter((event) => event.type === 'conversation_completed');
    assert.equal(completed.length, 1);
    assert.equal((completed[0]!.data.counters as { schema_discovery_calls?: number }).schema_discovery_calls, 0,
      'metadata authority refresh inflated cold-lane discovery accounting');
    const metadata = events.filter((event) => event.type === 'warm_schema_metadata_refresh');
    assert.equal(metadata.length, 1, 'physical metadata refresh was not independently observable');
    assert.deepEqual(Object.keys(metadata[0]!.data).sort(),
      ['artifactId', 'attemptId', 'durationMs', 'outcome', 'sourceUserSeq']);
    assert.equal(metadata[0]!.data.outcome, 'matched');
    assert.equal(metadata[0]!.data.durationMs, 4);
    assert.doesNotMatch(JSON.stringify(metadata[0]!.data), /schedulerco|example\.com|connection|schema|slug/i,
      'schema metadata telemetry leaked provider identity or contract data');
    const called = events.filter((event) => event.type === 'tool_called'
      && (event.data as { warmRead?: boolean }).warmRead === true);
    const returned = events.filter((event) => event.type === 'tool_returned'
      && (event.data as { warmRead?: boolean }).warmRead === true);
    const receipt = events.find((event) => event.type === 'read_receipt');
    assert.equal(called.length, 1, 'the warm provider dispatch was not counted exactly once');
    assert.equal(returned.length, 1, 'the warm provider return was not counted exactly once');
    const calledData = called[0]!.data as Record<string, unknown>;
    const returnedData = returned[0]!.data as Record<string, unknown>;
    assert.equal(calledData.tool, 'composio_execute_tool');
    assert.equal(calledData.effectiveTool, operation.identifier);
    assert.equal(calledData.accounting, 'top_level');
    assert.equal(calledData.sourceUserSeq, (listEvents(sessionId)
      .find((event) => event.type === 'user_input_received'))?.seq);
    assert.deepEqual(calledData.arguments, { tool_slug: operation.identifier },
      'historical invocation args leaked into canonical lifecycle telemetry');
    assert.equal(returnedData.canonicalCallId, calledData.canonicalCallId);
    assert.equal(returnedData.ok, true);
    assert.equal(returned[0]!.parentEventId, called[0]!.id);
    assert.equal(receipt?.data.evidenceEncoding, 'json-v1',
      'structured evidence was stored without typed presentation authority');
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 cold→warm canary: verified empty args materialize and serve the exact literal repeat without manual promotion', async () => {
  const adapters = await import('../read-path/read-lane-adapters.js');
  const composio = await import('../../tools/composio-tools.js');
  const schemaCache = await import('../../tools/composio-schema-cache.js');
  const worker = await import('../../memory/learning-worker.js');
  const aliasIndex = await import('../../memory/capability-alias-index.js');
  const procedureStore = await import('../../memory/procedure-store.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  const slug = 'HEALTHCO_LIST_STATUS';
  const phrase = 'healthco list status';
  const stableAccount = 'warm@example.com';
  schemaCache.rememberToolSchema(slug, { type: 'object', properties: {}, additionalProperties: false }, Date.now());
  const dispatchSchemaFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(dispatchSchemaFingerprint);

  const teachingSession = 'sess-cold-empty-teaching';
  acceptedRequest(teachingSession, phrase);
  let coldProviderDispatches = 0;
  await composio.runComposioExecuteForTestInSession(
    slug,
    {},
    (async () => {
      coldProviderDispatches += 1;
      return { successful: true, data: { items: [{ status: 'healthy' }] } };
    }) as never,
    teachingSession,
    ' SMTP:Warm@Example.COM ',
  );
  assert.equal(coldProviderDispatches, 1);
  const queued = aliasIndex.listPendingLearning()
    .find((pending) => pending.sessionId === teachingSession && pending.identifier === slug);
  assert.ok(queued, 'real execute settlement did not enqueue durable learning');
  assert.equal(queued.executableEmptyArgs, true);
  assert.equal(queued.accountIdentity, stableAccount);
  assert.equal(queued.schemaFingerprint, dispatchSchemaFingerprint);
  const drained = await worker.drainPendingLearning();
  assert.equal(drained.failed, 0);

  const artifacts = procedureStore.listActiveArtifactRows()
    .map((document) => procedureReceipts.parseProcedureArtifactDocument(document))
    .filter((parsed): parsed is Extract<typeof parsed, { ok: true }> => parsed.ok)
    .map((parsed) => parsed.artifact)
    .filter((artifact) => artifact.identifier === slug);
  assert.equal(artifacts.length, 1, 'cold settlement did not mint exactly one executable artifact');
  assert.deepEqual(artifacts[0]!.template, { args: {}, slots: [] });
  assert.deepEqual(artifacts[0]!.scope, productionScope(stableAccount));
  assert.equal(artifacts[0]!.schemaFingerprint, dispatchSchemaFingerprint);

  let providerDispatches = 0;
  let brainRuns = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => [{
      slug: 'healthco', connectionId: 'ca_rotated', status: 'ACTIVE', accountEmail: stableAccount,
    }],
    liveFingerprint: (identifier) => identifier === slug ? dispatchSchemaFingerprint : undefined,
    dispatchTool: (async (identifier, args, options) => {
      const result = await options.dispatchBoundary!({
        toolSlug: identifier,
        args,
        connectionId: 'ca_rotated',
        identity: stableAccount,
        schemaFingerprint: dispatchSchemaFingerprint,
      }, async () => {
        providerDispatches += 1;
        return { successful: true, data: { items: [{ status: 'healthy' }] } };
      });
      return { ok: true, result, connectionId: 'ca_rotated', identity: stableAccount };
    }) as never,
  });
  installProductionBridge(() => { brainRuns += 1; });
  const warmSession = 'sess-cold-empty-warm-repeat';
  try {
    // Canary scope is intentionally literal and exact: learned natural
    // paraphrase aliases remain capability_only input to the ordinary brain.
    const response = await respondPreferHarness('cron', acceptedRequest(warmSession, phrase),
      async () => ({ text: 'legacy', sessionId: warmSession }));
    assert.equal(response.text, "Here's what I found:\n\n- Status: healthy");
    assert.equal(providerDispatches, 1);
    assert.equal(brainRuns, 0);
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 production gateway: a typed gateway block falls back with no receipt or fake terminal', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-production-block';
  let brainRuns = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => [{ slug: 'schedulerco', connectionId: 'ca_x', status: 'ACTIVE', accountEmail: ACCOUNT }],
    liveFingerprint: () => `fp-${operation.identifier}`,
    dispatchTool: (async () => ({
      ok: false, reason: 'constraint', message: 'blocked before provider', toolkit: 'schedulerco',
    })) as never,
  });
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    runConversation: async (options) => {
      brainRuns += 1;
      return { status: 'completed', publicPresentation: { kind: 'answer', text: 'brain answer' }, sessionId: options.sessionId } as never;
    },
    buildAgent: async () => ({} as never),
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
  try {
    const response = await respondPreferHarness('cron',
      acceptedRequest(sessionId, operation.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text, 'brain answer');
    assert.equal(brainRuns, 1);
    assert.equal(listEvents(sessionId).some((event) => event.type === 'read_receipt'), false);
    assert.equal(listEvents(sessionId).some((event) => event.type === 'conversation_completed'), false);
    const lifecycle = listEvents(sessionId).filter((event) =>
      (event.type === 'tool_called' || event.type === 'tool_returned')
      && (event.data as { warmRead?: boolean }).warmRead === true);
    assert.deepEqual(lifecycle.map((event) => event.type), ['tool_called', 'tool_returned']);
    assert.equal((lifecycle[1]!.data as { ok?: boolean }).ok, false);
    assert.equal(lifecycle[1]!.parentEventId, lifecycle[0]!.id);
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 production gateway: superseding the attempt at the immediate boundary causes zero provider dispatch', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-production-race';
  let providerDispatches = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => [{ slug: 'schedulerco', connectionId: 'ca_x', status: 'ACTIVE', accountEmail: ACCOUNT }],
    liveFingerprint: () => `fp-${operation.identifier}`,
    dispatchTool: (async (slug, args, options) => {
      const newer = eventlog.beginRunAttempt(sessionId, {});
      eventlog.recordRunAttemptUserInput(newer, {
        turn: 2, role: 'user', data: { text: 'newer turn', attemptId: newer.attemptId },
      });
      const result = await options.dispatchBoundary!({
        toolSlug: slug,
        args,
        connectionId: 'ca_x',
        identity: ACCOUNT,
        schemaFingerprint: `fp-${operation.identifier}`,
      }, async () => {
        providerDispatches += 1;
        return { successful: true, data: { items: [] } };
      });
      return { ok: true, result, connectionId: 'ca_x', identity: ACCOUNT };
    }) as never,
  });
  let brainRuns = 0;
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    runConversation: async (options) => {
      brainRuns += 1;
      return { status: 'completed', publicPresentation: { kind: 'answer', text: 'brain answer' }, sessionId: options.sessionId } as never;
    },
    buildAgent: async () => ({} as never),
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
  try {
    const response = await respondPreferHarness('cron',
      acceptedRequest(sessionId, operation.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text, 'brain answer');
    assert.equal(providerDispatches, 0, 'superseded source crossed the provider boundary');
    assert.equal(brainRuns, 1);
    assert.equal(listEvents(sessionId).some((event) => event.type === 'read_receipt'), false);
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 production gateway: gateway-validated schema mismatch stops before provider and earns no artifact credit', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const procedureStore = await import('../../memory/procedure-store.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-production-gateway-schema-mismatch';
  const evidenceCount = (): number => procedureStore.listActiveArtifactRows()
    .map((document) => procedureReceipts.parseProcedureArtifactDocument(document))
    .filter((parsed): parsed is Extract<typeof parsed, { ok: true }> => parsed.ok)
    .find((parsed) => parsed.artifact.identifier === operation.identifier)?.artifact.evidence.length ?? 0;
  const beforeEvidence = evidenceCount();
  let providerDispatches = 0;
  let brainRuns = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => [{
      slug: 'schedulerco', connectionId: 'ca_schema', status: 'ACTIVE', accountEmail: ACCOUNT,
    }],
    liveFingerprint: () => `fp-${operation.identifier}`,
    dispatchTool: (async (slug, args, options) => {
      const result = await options.dispatchBoundary!({
        toolSlug: slug,
        args,
        connectionId: 'ca_schema',
        identity: ACCOUNT,
        schemaFingerprint: 'fp-a-different-gateway-contract',
      }, async () => {
        providerDispatches += 1;
        return { successful: true, data: { items: [] } };
      });
      return { ok: true, result, connectionId: 'ca_schema', identity: ACCOUNT };
    }) as never,
  });
  installProductionBridge(() => { brainRuns += 1; });
  try {
    const response = await respondPreferHarness('cron',
      acceptedRequest(sessionId, operation.paraphrases[0]!),
      async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text, 'brain answer');
    assert.equal(providerDispatches, 0);
    assert.equal(brainRuns, 1);
    assert.equal(evidenceCount(), beforeEvidence, 'pre-provider schema refusal credited the artifact');
    const returned = listEvents(sessionId).find((event) => event.type === 'tool_returned'
      && (event.data as { warmRead?: boolean }).warmRead === true);
    assert.equal((returned?.data as { providerDispatched?: boolean } | undefined)?.providerDispatched, false);
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 production cancellation is rechecked after connection I/O and at the immediate provider boundary', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  for (const phase of ['after-connections', 'at-boundary'] as const) {
    const sessionId = `sess-production-cancel-${phase}`;
    let cancelled = false;
    let connectionLoads = 0;
    let gatewayCalls = 0;
    let providerDispatches = 0;
    let brainRuns = 0;
    adapters._setProductionReadAdapterDependenciesForTests({
      liveFingerprint: () => `fp-${operation.identifier}`,
      listConnections: async () => {
        connectionLoads += 1;
        if (phase === 'after-connections') cancelled = true;
        return [{
          slug: 'schedulerco', connectionId: 'ca_cancel', status: 'ACTIVE', accountEmail: ACCOUNT,
        }];
      },
      dispatchTool: (async (slug, args, options) => {
        gatewayCalls += 1;
        if (phase === 'at-boundary') cancelled = true;
        const result = await options.dispatchBoundary!({
          toolSlug: slug,
          args,
          connectionId: 'ca_cancel',
          identity: ACCOUNT,
          schemaFingerprint: `fp-${operation.identifier}`,
        }, async () => {
          providerDispatches += 1;
          return { successful: true, data: { items: [] } };
        });
        return { ok: true, result, connectionId: 'ca_cancel', identity: ACCOUNT };
      }) as never,
    });
    installProductionBridge(() => { brainRuns += 1; });
    try {
      const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
      request.shouldCancel = () => cancelled;
      const response = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.equal(response.text, 'brain answer');
      assert.equal(connectionLoads, 1);
      assert.equal(gatewayCalls, phase === 'after-connections' ? 0 : 1,
        `${phase}: cancellation was checked at the wrong boundary`);
      assert.equal(providerDispatches, 0, `${phase}: cancellation crossed the provider boundary`);
      assert.equal(brainRuns, 1);
      assert.equal(listEvents(sessionId).some((event) => event.type === 'read_receipt'), false);
    } finally {
      adapters._setProductionReadAdapterDependenciesForTests(null);
      resetBridge();
    }
  }
});

test('E4 production post-provider authority loss never runs a brain or repeats the paid read', async () => {
  const adapters = await import('../read-path/read-lane-adapters.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  const operation = OPERATIONS[2]!;
  for (const phase of ['cancelled', 'superseded', 'cancelled-async'] as const) {
    await promoteAll();
    const sessionId = `sess-production-post-provider-${phase}`;
    let cancelled = false;
    let providerDispatches = 0;
    let brainRuns = 0;
    adapters._setProductionReadAdapterDependenciesForTests({
      liveFingerprint: () => `fp-${operation.identifier}`,
      listConnections: async () => [{
        slug: 'schedulerco', connectionId: 'ca_post_provider', status: 'ACTIVE', accountEmail: ACCOUNT,
      }],
      dispatchTool: (async (slug, args, options) => {
        const result = await options.dispatchBoundary!({
          toolSlug: slug,
          args,
          connectionId: 'ca_post_provider',
          identity: ACCOUNT,
          schemaFingerprint: `fp-${operation.identifier}`,
        }, async () => {
          providerDispatches += 1;
          if (phase === 'superseded') {
            const newer = eventlog.beginRunAttempt(sessionId, {});
            eventlog.recordRunAttemptUserInput(newer, {
              turn: 2,
              role: 'user',
              data: { text: 'newer accepted source', attemptId: newer.attemptId },
            });
          } else {
            cancelled = true;
          }
          return phase === 'cancelled-async'
            ? { successful: true, data: { job_id: 'job-after-cancel', status: 'queued' } }
            : { successful: true, data: { items: [{ title: 'Provider result' }] } };
        });
        return { ok: true, result, connectionId: 'ca_post_provider', identity: ACCOUNT };
      }) as never,
    });
    installProductionBridge(() => { brainRuns += 1; });
    const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
    if (phase !== 'superseded') request.shouldCancel = () => cancelled;
    try {
      const first = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.match(first.text, /stopped after the provider was contacted/i);
      assert.equal(providerDispatches, 1);
      assert.equal(brainRuns, 0, `${phase}: authority loss fell through to a brain`);
      assert.equal(listEvents(sessionId).some((event) => event.type === 'read_receipt'), false);
      assert.equal(listEvents(sessionId).some((event) => event.type === 'conversation_completed'), false);

      const returned = listEvents(sessionId).find((event) => event.type === 'tool_returned'
        && (event.data as { warmRead?: boolean }).warmRead === true);
      assert.equal((returned?.data as { providerDispatched?: boolean } | undefined)?.providerDispatched, true);
      if (phase === 'cancelled-async') {
        assert.equal((returned?.data as { artifactQuarantined?: boolean } | undefined)?.artifactQuarantined, true);
      }

      const replay = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.match(replay.text, /already contacted the provider/i);
      assert.equal(providerDispatches, 1, `${phase}: replay repeated paid provider work`);
      assert.equal(brainRuns, 0, `${phase}: replay ran a brain`);

      if (phase === 'cancelled-async') {
        assert.equal(procedureReceipts.activeArtifactForKey({
          scope: SCOPE,
          provider: operation.provider,
          operation: operation.operation,
          effectClass: 'read',
        }), null);
        const freshSession = `${sessionId}-fresh`;
        const fresh = await respondPreferHarness('cron',
          acceptedRequest(freshSession, operation.paraphrases[0]!),
          async () => ({ text: 'legacy', sessionId: freshSession }));
        assert.equal(fresh.text, 'brain answer');
        assert.equal(providerDispatches, 1, 'quarantined async artifact launched job #2 on a fresh source');
        assert.equal(brainRuns, 1);
      }
    } finally {
      adapters._setProductionReadAdapterDependenciesForTests(null);
      resetBridge();
    }
  }
});

test('E4 production terminal-commit failure preserves paid no-retry evidence without crediting the artifact', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const procedureStore = await import('../../memory/procedure-store.js');
  const procedureReceipts = await import('../../memory/procedure-receipts.js');
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-production-warm-commit-failure';
  const evidenceCount = (): number => procedureStore.listActiveArtifactRows()
    .map((document) => procedureReceipts.parseProcedureArtifactDocument(document))
    .filter((parsed): parsed is Extract<typeof parsed, { ok: true }> => parsed.ok)
    .find((parsed) => parsed.artifact.identifier === operation.identifier)?.artifact.evidence.length ?? 0;
  const beforeEvidence = evidenceCount();
  let providerDispatches = 0;
  let brainRuns = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    liveFingerprint: () => `fp-${operation.identifier}`,
    listConnections: async () => [{
      slug: 'schedulerco', connectionId: 'ca_commit_failure', status: 'ACTIVE', accountEmail: ACCOUNT,
    }],
    dispatchTool: (async (slug, args, options) => {
      const result = await options.dispatchBoundary!({
        toolSlug: slug,
        args,
        connectionId: 'ca_commit_failure',
        identity: ACCOUNT,
        schemaFingerprint: `fp-${operation.identifier}`,
      }, async () => {
        providerDispatches += 1;
        return { successful: true, data: { items: [{ title: 'Safe result' }] } };
      });
      return { ok: true, result, connectionId: 'ca_commit_failure', identity: ACCOUNT };
    }) as never,
  });
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    runConversation: async (options) => {
      brainRuns += 1;
      return { status: 'completed', publicPresentation: { kind: 'answer', text: 'brain answer' }, sessionId: options.sessionId } as never;
    },
    buildAgent: async () => ({} as never),
    commitTurnOutcome: (() => { throw new Error('synthetic terminal store outage'); }) as never,
  });
  process.env.CLEMMY_CLAUDE_AGENT_BRAIN = 'off';
  const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
  try {
    const first = await respondPreferHarness('cron', request,
      async () => ({ text: 'legacy', sessionId }));
    assert.match(first.text, /stopped after the provider returned/i);
    assert.equal(providerDispatches, 1);
    assert.equal(brainRuns, 0);
    assert.equal(listEvents(sessionId).some((event) => event.type === 'conversation_completed'), false);
    assert.equal(evidenceCount(), beforeEvidence, 'uncommitted warm answer credited its artifact');

    const replay = await respondPreferHarness('cron', request,
      async () => ({ text: 'legacy', sessionId }));
    assert.match(replay.text, /already contacted the provider/i);
    assert.equal(providerDispatches, 1, 'commit-failure replay repeated provider work');
    assert.equal(brainRuns, 0, 'commit-failure replay ran a brain');
    assert.equal(evidenceCount(), beforeEvidence);
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    resetBridge();
  }
});

test('E4 production evidence: queued handles and oversized payloads stop without fake receipts or paid replay', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;
  const cases: Array<{ label: string; payload: unknown }> = [
    {
      label: 'queued-handle',
      payload: { successful: true, data: { job_id: 'job-queued-1', status: 'queued' } },
    },
    {
      label: 'oversized-payload',
      payload: { successful: true, data: { items: [{ blob: 'x'.repeat(4_100) }] } },
    },
  ];
  for (const fixture of cases) {
    // The queued case intentionally quarantines the exact artifact. A fresh
    // receipt is required before exercising the independent oversize case.
    await promoteAll();
    const sessionId = `sess-production-${fixture.label}`;
    let providerDispatches = 0;
    let brainRuns = 0;
    adapters._setProductionReadAdapterDependenciesForTests({
      liveFingerprint: () => `fp-${operation.identifier}`,
      listConnections: async () => [{
        slug: 'schedulerco', connectionId: 'ca_evidence', status: 'ACTIVE', accountEmail: ACCOUNT,
      }],
      dispatchTool: (async (slug, args, options) => {
        const result = await options.dispatchBoundary!({
          toolSlug: slug,
          args,
          connectionId: 'ca_evidence',
          identity: ACCOUNT,
          schemaFingerprint: `fp-${operation.identifier}`,
        }, async () => {
          providerDispatches += 1;
          return fixture.payload;
        });
        return { ok: true, result, connectionId: 'ca_evidence', identity: ACCOUNT };
      }) as never,
    });
    installProductionBridge(() => { brainRuns += 1; });
    try {
      const request = acceptedRequest(sessionId, operation.paraphrases[0]!);
      const response = await respondPreferHarness('cron',
        request,
        async () => ({ text: 'legacy', sessionId }));
      assert.match(response.text, /result could not be safely presented/i);
      assert.equal(providerDispatches, 1);
      assert.equal(brainRuns, 0, `${fixture.label}: a post-dispatch decline ran the brain`);
      assert.equal(listEvents(sessionId).some((event) => event.type === 'read_receipt'), false,
        `${fixture.label}: non-evidence payload minted a receipt`);
      assert.equal(listEvents(sessionId).filter((event) => event.type === 'conversation_completed').length, 1,
        `${fixture.label}: spent read did not durably close the source`);
      const lifecycle = listEvents(sessionId).filter((event) =>
        (event.type === 'tool_called' || event.type === 'tool_returned')
        && (event.data as { warmRead?: boolean }).warmRead === true);
      assert.deepEqual(lifecycle.map((event) => event.type), ['tool_called', 'tool_returned']);
      assert.equal((lifecycle[1]!.data as { ok?: boolean }).ok, false);
      assert.equal((lifecycle[1]!.data as { providerDispatched?: boolean }).providerDispatched, true);
      assert.match(String(lifecycle[1]!.data.warmReadPolicyDigest), /^[a-f0-9]{64}$/);

      const replay = await respondPreferHarness('cron', request,
        async () => ({ text: 'legacy', sessionId }));
      assert.equal(replay.text, response.text);
      assert.equal(providerDispatches, 1, `${fixture.label}: serial retry repeated the paid read`);
      assert.equal(brainRuns, 0, `${fixture.label}: serial retry ran the ordinary brain`);

      const procedureReceipts = await import('../../memory/procedure-receipts.js');
      assert.equal((lifecycle[1]!.data as { artifactQuarantined?: boolean }).artifactQuarantined, true);
      // The lifecycle deliberately does not expose arbitrary provider data;
      // resolve the exact known logical key to prove its pointer was cleared.
      assert.equal(procedureReceipts.activeArtifactForKey({
        scope: SCOPE,
        provider: operation.provider,
        operation: operation.operation,
        effectClass: 'read',
      }), null, `${fixture.label}: known warm-parity failure remained active`);

      const freshSession = `${sessionId}-fresh-source`;
      const fresh = await respondPreferHarness('cron',
        acceptedRequest(freshSession, operation.paraphrases[0]!),
        async () => ({ text: 'legacy', sessionId: freshSession }));
      assert.equal(fresh.text, 'brain answer');
      assert.equal(providerDispatches, 1, `${fixture.label}: fresh source repeated known paid failure`);
      assert.equal(brainRuns, 1, `${fixture.label}: quarantined artifact did not decline to the ordinary brain`);
    } finally {
      adapters._setProductionReadAdapterDependenciesForTests(null);
      resetBridge();
    }
  }
});

test('E4 production factory declines unrelated, unknown-schema, and wrong-toolkit shapes before unsafe I/O', async () => {
  await promoteAll();
  const adapters = await import('../read-path/read-lane-adapters.js');
  const operation = OPERATIONS[2]!;

  const build = async (label: string, message: string) => {
    const sessionId = `sess-factory-order-${label}`;
    const request = acceptedRequest(sessionId, message);
    const attempt = eventlog.getActiveRunAttempt(sessionId)!;
    return adapters.buildProductionReadPortsForAcceptedTurn({
      sessionId,
      sourceUserSeq: request.sourceUserSeq!,
      sourceTurn: 1,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      message,
    });
  };

  let connectionLoads = 0;
  let fingerprintReads = 0;
  let fingerprintRefreshes = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    listConnections: async () => { connectionLoads += 1; return []; },
    liveFingerprint: () => { fingerprintReads += 1; return undefined; },
    ensureLiveFingerprint: async (_identifier, observer) => {
      fingerprintRefreshes += 1;
      observer?.({ outcome: 'unavailable', durationMs: 2 });
      return undefined;
    },
  });
  try {
    assert.equal(await build('unrelated', 'help me think through a project plan'), null);
    assert.equal(fingerprintReads, 0, 'unrelated chat consulted catalog authority');
    assert.equal(connectionLoads, 0, 'unrelated chat listed provider accounts');

    assert.equal(await build('unknown-schema', operation.paraphrases[0]!), null);
    assert.equal(fingerprintReads, 2, 'refresh result was not re-read at the governed boundary');
    assert.equal(fingerprintRefreshes, 1, 'unknown schema did not receive one bounded exact-slug refresh');
    assert.equal(connectionLoads, 0, 'unknown schema still paid account/provider I/O');

    let refreshedFingerprint: string | undefined;
    adapters._setProductionReadAdapterDependenciesForTests({
      liveFingerprint: () => refreshedFingerprint,
      ensureLiveFingerprint: async (_identifier, observer) => {
        fingerprintRefreshes += 1;
        refreshedFingerprint = `fp-${operation.identifier}`;
        observer?.({ outcome: 'refreshed', durationMs: 3, fingerprint: refreshedFingerprint });
        return refreshedFingerprint;
      },
      listConnections: async () => {
        connectionLoads += 1;
        return [{
          slug: 'schedulerco', connectionId: 'ca_refreshed', status: 'ACTIVE', accountEmail: ACCOUNT,
        }];
      },
    });
    assert.ok(await build('schema-refreshed', operation.paraphrases[0]!),
      'a successful exact-slug schema refresh did not restore warm admission after restart');

    connectionLoads = 0;
    adapters._setProductionReadAdapterDependenciesForTests({
      liveFingerprint: () => `fp-${operation.identifier}`,
      listConnections: async () => {
        connectionLoads += 1;
        return [{ slug: 'outlook', connectionId: 'ca_wrong_toolkit', status: 'ACTIVE', accountEmail: ACCOUNT }];
      },
    });
    assert.equal(await build('wrong-toolkit', operation.paraphrases[0]!), null,
      'same-email connection in another toolkit authorized the candidate');
    assert.equal(connectionLoads, 1, 'wrong-toolkit case did not inspect exactly one bounded snapshot');

    for (const status of ['INACTIVE', 'EXPIRED', 'INITIATED']) {
      adapters._setProductionReadAdapterDependenciesForTests({
        liveFingerprint: () => `fp-${operation.identifier}`,
        listConnections: async () => {
          connectionLoads += 1;
          return [{
            slug: 'schedulerco', connectionId: `ca_${status.toLowerCase()}`,
            status, accountEmail: ACCOUNT,
          }];
        },
      });
      assert.equal(await build(`status-${status.toLowerCase()}`, operation.paraphrases[0]!), null,
        `${status} connection gained autonomous warm authority`);
    }
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
  }
});

test('E4 static guard: the production read adapter has no raw Composio client dispatch', () => {
  const source = readFileSync(new URL('../read-path/read-lane-adapters.ts', import.meta.url), 'utf-8');
  assert.doesNotMatch(source, /executeComposioTool\s*\(/,
    'the warm adapter can bypass the governed dispatchComposioTool gateway');
});
