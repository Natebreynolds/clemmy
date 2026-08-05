/**
 * Run: npx tsx --test src/runtime/harness/read-lane-production-seam.test.ts
 *
 * E4 production-seam matrix: the shared accepted-turn read resolver, called
 * from respond-bridge BEFORE brain divergence, serving warm reads for three
 * unrelated carrier families on both brains — and, critically, costing
 * ORDINARY chat nothing.
 *
 * The bridge is exercised through its real entry (`respondPreferHarness`)
 * with injected ports, so a passing test proves production reachability
 * rather than direct module calls.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const { listEvents } = await import('./eventlog.js');
type ReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;
type AcceptedTurnReadPorts = import('../read-path/read-lane-chat.js').AcceptedTurnReadPorts;
type AssistantRequest = import('../../types.js').AssistantRequest;

const ACCOUNT = 'person@example.com';
const SCOPE = productionScope(ACCOUNT);

/** Three unrelated carrier families: builtin/local, MCP, connected broker. */
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
        const response = await respondPreferHarness('cron', {
          sessionId, message: operation.paraphrases[0]!,
        }, async () => ({ text: 'legacy', sessionId }));
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
    await respondPreferHarness('cron', {
      sessionId, message: OPERATIONS[2]!.paraphrases[0]!,
    }, async () => ({ text: 'legacy', sessionId }));
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
      await respondPreferHarness('cron', {
        sessionId, message: operation.paraphrases[1]!,
      }, async () => ({ text: 'legacy', sessionId }));
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
  installBridge({ brain: 'codex', ports: () => portsFor({ sessionId }) });
  try {
    const first = await respondPreferHarness('cron', {
      sessionId, message: operation.paraphrases[0]!,
    }, async () => ({ text: 'legacy', sessionId }));
    const firstSeq = listEvents(sessionId).find((event) => event.type === 'user_input_received')?.seq;
    assert.ok(firstSeq);
    // A retry that REUSES the accepted source must not mint a second terminal.
    await respondPreferHarness('cron', {
      sessionId, message: operation.paraphrases[0]!, sourceUserSeq: firstSeq,
    }, async () => ({ text: 'legacy', sessionId }));
    const completions = listEvents(sessionId).filter((event) => event.type === 'conversation_completed');
    assert.equal(completions.length, 1,
      `one accepted source produced ${completions.length} terminals`);
    assert.equal(first.text, operation.evidence);
  } finally {
    resetBridge();
  }
});

test('E4: no internal narration reaches the committed terminal', async () => {
  await promoteAll();
  const operation = OPERATIONS[2]!;
  const sessionId = 'sess-narration';
  installBridge({ brain: 'claude', ports: () => portsFor({ sessionId }) });
  try {
    const response = await respondPreferHarness('cron', {
      sessionId, message: operation.paraphrases[0]!,
    }, async () => ({ text: 'legacy', sessionId }));
    assert.equal(response.text.includes(operation.identifier), false, 'a dispatch identifier leaked');
    assert.equal(/rcpt_|readrcpt_/.test(response.text), false, 'a receipt id leaked');
    assert.equal(/discovery|schema|dispatch|tool call/i.test(response.text), false, 'control narration leaked');
  } finally {
    resetBridge();
  }
});
