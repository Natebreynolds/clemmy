/**
 * Production-shaped regression for the direct Composio gateway's two local
 * validation boundaries.
 *
 * Run:
 *   npx tsx --test src/tools/composio-direct-invalid-arguments-settlement.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-invalid-args-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.CLEMMY_EXECUTION_GATE = 'on';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import assert from 'node:assert/strict';
import { test } from 'node:test';

const eventlog = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const {
  attestToolLocalInputInvalidity,
  ToolCallsCounter,
  withHarnessRunContext,
  wrapToolForHarness,
} = await import('../runtime/harness/brackets.js');
const { tool: sdkTool } = await import('@openai/agents');
const { z } = await import('zod');
const composioClient = await import('../integrations/composio/client.js');
const {
  getComposioRuntimeTools,
  getDynamicComposioRuntimeTools,
} = await import('./composio-tools.js');

type AcceptedTask = {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
};

function acceptTask(text: string): AcceptedTask {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(recordTurnGraphShadow({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      turn: source.turn,
    },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: source.turn,
  };
}

function productionExecuteTool() {
  const direct = getComposioRuntimeTools().find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(direct, 'the production runtime exports the direct Composio gateway');
  return wrapToolForHarness(direct) as typeof direct & {
    invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
  };
}

async function invokeMalformedAndAssertSettlement(input: unknown, callId: string): Promise<void> {
  eventlog.resetEventLog();
  const accepted = acceptTask('List the current mailbox messages with the connected provider.');
  const wrapped = productionExecuteTool();
  const counter = new ToolCallsCounter(10);

  const output = await withHarnessRunContext({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    turn: accepted.turn,
    behaviorScopeId: `${accepted.sessionId}::invalid-args`,
    counter,
  }, () => wrapped.invoke(
    { context: { sessionId: accepted.sessionId } },
    JSON.stringify(input),
    { toolCall: { callId } },
  ));

  assert.equal(typeof output, 'string', 'the model receives repair guidance, not the internal carrier');
  assert.match(String(output), /rejected locally before provider dispatch/);
  assert.match(String(output), /arguments is a JSON object encoded as a string/);
  assert.doesNotMatch(String(output), /^\s*\[provider-dispatch:not-started:/,
    'settlement must not be rescued by the legacy marker parser');
  assert.doesNotMatch(String(output), /^\s*⚠️[^\n]*FAILED/,
    'settlement must not be rescued by the corrective-prose parser');
  assert.equal(counter.calls, 1, 'the refused malformed attempt still consumes one tool-call unit');

  const db = eventlog.openEventLog();
  const settlement = db.prepare(`
    SELECT execution_kind, outcome_kind, business_call,
           physical_crossing_count, host_crossing_count,
           result_handle_id, credited_progress
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ?
     ORDER BY settled_at DESC
     LIMIT 1
  `).get(accepted.sessionId, accepted.sourceUserSeq) as {
    execution_kind: string;
    outcome_kind: string;
    business_call: number;
    physical_crossing_count: number;
    host_crossing_count: number;
    result_handle_id: string | null;
    credited_progress: number;
  } | undefined;
  assert.deepEqual(settlement, {
    execution_kind: 'refused_pre_dispatch',
    outcome_kind: 'invalid_arguments',
    business_call: 1,
    physical_crossing_count: 0,
    host_crossing_count: 0,
    result_handle_id: null,
    credited_progress: 0,
  });

  const physical = db.prepare(`
    SELECT COUNT(*) AS count
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(accepted.sessionId, accepted.sourceUserSeq) as { count: number };
  assert.equal(physical.count, 0, 'no provider or host body crossing was admitted');

  const operations = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(CASE
             WHEN outcome_kind = 'succeeded' AND dispatch_state = 'not_started' THEN 1
             ELSE 0
           END), 0) AS false_successes
      FROM accepted_task_operations
     WHERE session_id = ? AND source_user_seq = ?
  `).get(accepted.sessionId, accepted.sourceUserSeq) as {
    count: number;
    false_successes: number;
  };
  assert.deepEqual(operations, { count: 0, false_successes: 0 });
}

test('direct composio outer-schema rejection remains invalid_arguments through the real SDK wrapper', async () => {
  await invokeMalformedAndAssertSettlement({
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    // The live malformed shape: an object reaches the SDK field whose wire
    // contract requires a JSON string. execute/provider code never starts.
    arguments: { folder: 'inbox' },
    connected_account_id: null,
  }, 'direct-composio-outer-invalid');
});

test('direct composio malformed inner JSON remains invalid_arguments after outer SDK validation', async () => {
  await invokeMalformedAndAssertSettlement({
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    arguments: '{"folder":"inbox"',
    connected_account_id: null,
  }, 'direct-composio-inner-invalid');
});

async function assertExecutionWrapRefusal(input: unknown, callId: string, toolOverride?: ReturnType<typeof sdkTool>) {
  eventlog.resetEventLog();
  const accepted = acceptTask('Use the exact connected provider operation once.');
  const direct = toolOverride ?? getComposioRuntimeTools()
    .find((candidate) => candidate.name === 'composio_execute_tool');
  assert.ok(direct);
  const wrapped = wrapToolForHarness(direct) as typeof direct & {
    invoke: (runContext: unknown, rawInput: string, details?: unknown) => Promise<unknown>;
  };
  const counter = new ToolCallsCounter(10);
  const output = await withHarnessRunContext({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    turn: accepted.turn,
    behaviorScopeId: `${accepted.sessionId}::fail-closed-invalidity-proof`,
    counter,
  }, () => wrapped.invoke(
    { context: { sessionId: accepted.sessionId } },
    JSON.stringify(input),
    { toolCall: { callId } },
  ));

  assert.match(String(output), /EXECUTION_WRAP_REQUIRED/);
  assert.doesNotMatch(String(output), /rejected locally before provider dispatch/);
  assert.equal(counter.calls, 1, 'ordinary execution-wrap refusal remains charged once');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(accepted.sessionId, accepted.sourceUserSeq) as { count: number }).count, 0);
  return output;
}

test('a valid unknown-effect carrier remains behind EXECUTION_WRAP_REQUIRED with zero provider work', async () => {
  await assertExecutionWrapRefusal({
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    arguments: '{"folder":"inbox"}',
    connected_account_id: null,
  }, 'direct-composio-valid-unknown-effect');
});

test('unproven, thrown, or ambiguous invalidity validators all fail closed before the tool body', async () => {
  const cases = [
    { label: 'unproven', validate: () => 'unproven' as const },
    { label: 'throw', validate: () => { throw new Error('validator fixture failure'); } },
    { label: 'ambiguous', validate: () => undefined as never },
  ];

  for (const fixture of cases) {
    let providerBodies = 0;
    const direct = attestToolLocalInputInvalidity(sdkTool({
      name: 'composio_execute_tool',
      description: `Fail-closed ${fixture.label} validator fixture.`,
      parameters: z.object({
        tool_slug: z.string().min(1),
        arguments: z.string().nullable(),
        connected_account_id: z.string().nullable(),
      }),
      execute: async () => {
        providerBodies += 1;
        return 'provider body ran';
      },
    }), fixture.validate);

    await assertExecutionWrapRefusal({
      tool_slug: 'FIXTURE_UNKNOWN_EFFECT',
      arguments: '{}',
      connected_account_id: null,
    }, `invalidity-${fixture.label}-fails-closed`, direct);
    assert.equal(providerBodies, 0, `${fixture.label} validator did not bypass effect authority`);
  }
});

test('invalidity authority does not survive a copied or invoke-mutated tool identity', async () => {
  for (const fixture of ['copied', 'invoke-mutated'] as const) {
    let providerBodies = 0;
    const attested = attestToolLocalInputInvalidity(sdkTool({
      name: 'composio_execute_tool',
      description: `Exact identity ${fixture} fixture.`,
      parameters: z.object({
        tool_slug: z.string().min(1),
        arguments: z.string().nullable(),
        connected_account_id: z.string().nullable(),
      }),
      execute: async () => {
        providerBodies += 1;
        return 'provider body ran';
      },
    }), () => 'invalid');

    let candidate: typeof attested;
    if (fixture === 'copied') {
      candidate = { ...attested };
    } else {
      const originalInvoke = attested.invoke;
      attested.invoke = (runContext, input, details) => originalInvoke(runContext, input, details);
      candidate = attested;
    }

    await assertExecutionWrapRefusal({
      tool_slug: 'FIXTURE_UNKNOWN_EFFECT',
      arguments: { malformed: true },
      connected_account_id: null,
    }, `invalidity-${fixture}-fails-closed`, candidate);
    assert.equal(providerBodies, 0, `${fixture} tool identity did not inherit invalidity authority`);
  }
});

test('generated cx_* outer-schema rejection remains typed and performs zero provider work', async () => {
  eventlog.resetEventLog();
  const accepted = acceptTask('List the matching fixture records with the connected provider.');
  const originalFetch = globalThis.fetch;
  let providerBodies = 0;

  composioClient.resetComposioClient();
  composioClient.__test__.setComposioApiKeyOverride('dynamic-invalid-arguments-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: 'ca_dynamic_invalid',
    status: 'ACTIVE',
    user_id: 'dynamic-invalid-owner',
    toolkit: { slug: 'fixture' },
  }]);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    tools: {
      async getRawComposioTools() {
        return [{
          slug: 'FIXTURE_LIST_RECORDS',
          name: 'List fixture records',
          description: 'List records matching one exact string query.',
          toolkit: { slug: 'fixture' },
          inputParameters: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string' } },
            additionalProperties: false,
          },
          outputParameters: null,
          version: 'fixture-v1',
        }];
      },
      async execute() {
        providerBodies += 1;
        return { successful: true, data: { records: [] } };
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`dynamic invalid-arguments fixture forbids external network: ${url}`);
  }) as typeof fetch;

  try {
    const direct = (await getDynamicComposioRuntimeTools({ perToolkitLimit: 1, totalLimit: 1 }))
      .find((candidate) => candidate.name === 'cx_fixture_list_records');
    assert.ok(direct, 'the production dynamic factory emitted the exact cx_* tool');
    const wrapped = wrapToolForHarness(direct!) as typeof direct & {
      invoke: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
    };
    const counter = new ToolCallsCounter(10);
    const output = await withHarnessRunContext({
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.sourceUserSeq,
      turn: accepted.turn,
      behaviorScopeId: `${accepted.sessionId}::dynamic-invalid-args`,
      counter,
    }, () => wrapped.invoke(
      { context: { sessionId: accepted.sessionId } },
      '{"query":',
      { toolCall: { callId: 'dynamic-composio-outer-invalid' } },
    ));

    assert.equal(typeof output, 'string');
    assert.match(String(output), /rejected locally before provider dispatch/);
    assert.equal(counter.calls, 1, 'the malformed generated-tool attempt is charged once');
    assert.equal(providerBodies, 0, 'the generated tool never entered its provider execute body');

    const db = eventlog.openEventLog();
    const settlement = db.prepare(`
      SELECT execution_kind, outcome_kind, business_call,
             physical_crossing_count, host_crossing_count,
             result_handle_id, credited_progress
        FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY settled_at DESC
       LIMIT 1
    `).get(accepted.sessionId, accepted.sourceUserSeq) as {
      execution_kind: string;
      outcome_kind: string;
      business_call: number;
      physical_crossing_count: number;
      host_crossing_count: number;
      result_handle_id: string | null;
      credited_progress: number;
    } | undefined;
    assert.deepEqual(settlement, {
      execution_kind: 'refused_pre_dispatch',
      outcome_kind: 'invalid_arguments',
      business_call: 1,
      physical_crossing_count: 0,
      host_crossing_count: 0,
      result_handle_id: null,
      credited_progress: 0,
    });
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ?
    `).get(accepted.sessionId, accepted.sourceUserSeq) as { count: number }).count, 0);
    assert.equal((db.prepare(`
      SELECT COUNT(*) AS count
        FROM accepted_task_operations
       WHERE session_id = ? AND source_user_seq = ?
    `).get(accepted.sessionId, accepted.sourceUserSeq) as { count: number }).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    composioClient.__test__.setConnectedAccountsLoader(null);
    composioClient.__test__.setComposioApiKeyOverride(null);
    composioClient.resetComposioClient();
  }
});

test.after(() => {
  try {
    eventlog.closeEventLog();
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
