/**
 * Retirement guards for the pre-harness accepted-turn read lane.
 *
 * The typed resolver and production port builder remain available as dormant
 * components for a future shared-kernel carrier. They are not a production
 * execution route: cron/background must enter their ordinary brain/harness
 * path, and respond-bridge must contain no caller for the old warm executor.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_CLAUDE_BRAIN = process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-lane-retired-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-A\n');

const { respondPreferHarness, _setBridgeImplsForTests } = await import('./respond-bridge.js');
const adapters = await import('../read-path/read-lane-adapters.js');
const { productionScope } = await import('../read-path/read-lane-chat.js');
const { promoteFromVerifiedReceipt } = await import('../../memory/procedure-receipts.js');
const eventlog = await import('./eventlog.js');
const { presentationEventForOutcome, turnOutcomeId } = await import('./turn-outcome.js');
const { closeOperationalTelemetryDb } = await import('../operational-telemetry.js');
type AssistantRequest = import('../../types.js').AssistantRequest;
type DurableReceiptRecord = import('../../memory/procedure-receipts.js').DurableReceiptRecord;

function stubAnswerPresentation(
  opts: { sessionId: string; sourceUserSeq?: number },
  text: string,
) {
  const source = eventlog.listEvents(opts.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === opts.sourceUserSeq);
  assert.ok(source, 'the bridge must establish the accepted source before runConversation');
  const identity = { sessionId: opts.sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return presentationEventForOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
  });
}

test.after(() => {
  adapters._setProductionReadAdapterDependenciesForTests(null);
  _setBridgeImplsForTests({});
  eventlog.closeEventLog();
  closeOperationalTelemetryDb();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
  if (PRIOR_CLAUDE_BRAIN === undefined) delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  else process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = PRIOR_CLAUDE_BRAIN;
});

test('typed warm presenter remains available and deterministic for future shared-kernel wiring', () => {
  const natural = 'I found two events.\n\n- Stand-up at 9:00\n- Design review at 11:30';
  assert.equal(adapters.presentWarmReadEvidence(natural), natural);
  assert.equal(
    adapters.presentWarmReadEvidence({ successful: true, data: natural }),
    natural,
  );

  const record = adapters.presentWarmReadEvidence({
    successful: true,
    data: { result: { title: 'Design review', owner: 'Sam' } },
  });
  assert.equal(record, "Here's what I found:\n\n- Title: Design review\n- Owner: Sam");
  assert.doesNotMatch(record, /^\{.*\}$/s);

  const list = adapters.presentWarmReadEvidence({
    ok: true,
    results: [
      { title: 'Design review', startsAt: '11:30' },
      { title: 'Focus block', startsAt: '15:00' },
    ],
  });
  assert.match(list, /^Here's what I found:\n\n\| Title \| Starts At \|/);
  assert.match(list, /\| Design review \| 11:30 \|/);
  assert.doesNotMatch(list, /"results"|"title":/);
});

test('typed warm presenter keeps adversarial structured evidence bounded and inert', () => {
  const deep = {
    one: { two: { three: { four: { five: { six: { payload: '`'.repeat(4_000) } } } } } },
  };
  const presented = adapters.presentWarmReadEvidence(deep);
  assert.ok(presented.length <= adapters.WARM_READ_PRESENTATION_MAX_CHARS);
  assert.match(presented, /^Here's what I found:\n\n```text\n/);
  assert.ok(presented.endsWith('\n```'));
  assert.match(presented, /additional results omitted/);

  const table = adapters.presentWarmReadEvidence({
    items: [
      { 'name|role': '[*admin*](unsafe)', note: '<b>one</b>' },
      { 'name|role': '_viewer_', note: '<script>two</script>' },
    ],
  });
  assert.ok(table.includes('| Name\\|role | Note |'));
  assert.doesNotMatch(table, /<b>|<script>|"name\|role"/);
  assert.ok(table.includes('\\[\\*admin\\*\\](unsafe)'));
});

function sourceFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
    { cwd: path.resolve('.'), encoding: 'utf-8' },
  )
    .split('\n')
    .filter((file) => /\.(?:ts|tsx|mts)$/.test(file));
}

test('caller topology: accepted-turn read execution has no production caller outside typed read-path components', () => {
  const executionSymbols = /\b(?:resolveAcceptedTurnRead|runColdToWarmRead|buildProductionReadPortsForAcceptedTurn)\b/;
  const callers = sourceFiles()
    .filter((file) => !file.includes('.test.'))
    .filter((file) => !file.startsWith('src/runtime/read-path/'))
    .filter((file) => existsSync(file) && executionSymbols.test(readFileSync(file, 'utf-8')));
  assert.deepEqual(callers, [], `retired accepted-turn read callers: ${callers.join(', ')}`);

  const bridge = readFileSync('src/runtime/harness/respond-bridge.ts', 'utf-8');
  assert.doesNotMatch(
    bridge,
    /acceptedTurnReadPorts|tryServeAcceptedTurnRead|serveAcceptedTurnReadUnderAuthority/,
    'respond-bridge still exposes the retired pre-harness execution splice',
  );
  assert.doesNotMatch(
    bridge,
    /from ['"]\.\.\/read-path\/read-lane-(?:chat|adapters)\.js['"]/,
    'respond-bridge still imports an executable accepted-turn read component',
  );
  assert.match(bridge, /exactTerminalReplayForRequest/,
    'retiring execution accidentally removed exact terminal replay');
  assert.match(bridge, /exactWarmProviderSpentForRequest/,
    'retiring execution accidentally removed paid-read no-retry replay');
});

const IDENTIFIER = 'SCHEDULERCO_LIST_EVENTS';
const ACCOUNT = 'person@example.com';
const MESSAGE = 'schedulerco list events';

function acceptedRequest(sessionId: string): AssistantRequest {
  eventlog.createSession({ id: sessionId, kind: 'execution', channel: 'test', title: MESSAGE });
  const attempt = eventlog.beginRunAttempt(sessionId, {});
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: MESSAGE, attemptId: attempt.attemptId, source: 'test' },
  }, { armRunInFlight: true });
  return {
    sessionId,
    message: MESSAGE,
    sourceUserSeq: source.seq,
    runId: attempt.runId ?? undefined,
  };
}

async function seedExecutableRead(): Promise<void> {
  const record: DurableReceiptRecord = {
    receiptId: 'seed_retired_warm_read',
    at: '2026-08-25T00:00:00.000Z',
    provider: 'schedulerco',
    operation: 'list_events',
    effectClass: 'read',
    identifier: IDENTIFIER,
    schemaFingerprint: `fp-${IDENTIFIER}`,
    scope: productionScope(ACCOUNT),
    dispatchOutcome: 'succeeded',
    readEvidenceRef: 'seed-evidence',
  };
  const promoted = await promoteFromVerifiedReceipt({
    scope: productionScope(ACCOUNT),
    provider: record.provider,
    operation: record.operation,
    effectClass: 'read',
    kind: 'composio',
    identifier: IDENTIFIER,
    templateArgs: { window: 'today' },
    receiptId: record.receiptId,
    acquiredSchemaFingerprint: record.schemaFingerprint,
  }, { resolve: (receiptId) => receiptId === record.receiptId ? record : undefined });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
}

test('zero body: cron and background ignore an executable warm artifact and enter their normal execution brain', async () => {
  await seedExecutableRead();
  let providerBodies = 0;
  let brainRuns = 0;
  let legacyRuns = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    liveFingerprint: () => `fp-${IDENTIFIER}`,
    listConnections: async () => [{
      slug: 'schedulerco',
      connectionId: 'ca_should_never_be_used',
      status: 'ACTIVE',
      accountEmail: ACCOUNT,
    }],
    dispatchTool: (async () => {
      providerBodies += 1;
      throw new Error('retired accepted-turn read reached provider body');
    }) as never,
  });
  process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'on';
  _setBridgeImplsForTests({
    configure: async () => ({ ok: true }),
    claudeAgentBrain: async (_surface, request) => {
      brainRuns += 1;
      return { text: 'ordinary execution brain', sessionId: request.sessionId };
    },
    runConversation: async (options) => {
      brainRuns += 1;
      return {
        status: 'completed',
        publicPresentation: stubAnswerPresentation(options, 'ordinary harness brain'),
        sessionId: options.sessionId,
      } as never;
    },
    buildAgent: async () => ({} as never),
  });

  try {
    for (const surface of ['cron', 'background'] as const) {
      const request = acceptedRequest(`retired-warm-${surface}`);
      const response = await respondPreferHarness(surface, request, async () => {
        legacyRuns += 1;
        return { text: 'legacy', sessionId: request.sessionId };
      });
      assert.match(response.text, /^ordinary (?:execution|harness) brain$/,
        `${surface}: request did not reach an ordinary configured brain lane`);
    }
    assert.equal(providerBodies, 0, 'retired pre-harness lane executed a provider body');
    assert.equal(brainRuns, 2, 'normal cron/background execution routing changed');
    assert.equal(legacyRuns, 0, 'execution requests escaped to legacy routing');
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
    _setBridgeImplsForTests({});
  }
});

test('typed production port builder still declines unrelated chat before schema/account/provider I/O', async () => {
  let schemaReads = 0;
  let connectionLoads = 0;
  let providerBodies = 0;
  adapters._setProductionReadAdapterDependenciesForTests({
    liveFingerprint: () => { schemaReads += 1; return undefined; },
    listConnections: async () => { connectionLoads += 1; return []; },
    dispatchTool: (async () => { providerBodies += 1; throw new Error('unreachable'); }) as never,
  });
  const request = acceptedRequest('retired-warm-unrelated-builder');
  const attempt = eventlog.getActiveRunAttempt(request.sessionId)!;
  try {
    assert.equal(await adapters.buildProductionReadPortsForAcceptedTurn({
      sessionId: request.sessionId,
      sourceUserSeq: request.sourceUserSeq!,
      sourceTurn: 1,
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      message: 'help me think through a project plan',
    }), null);
    assert.deepEqual({ schemaReads, connectionLoads, providerBodies }, {
      schemaReads: 0,
      connectionLoads: 0,
      providerBodies: 0,
    });
  } finally {
    adapters._setProductionReadAdapterDependenciesForTests(null);
  }
});
