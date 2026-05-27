/**
 * Run: npx tsx --test src/runtime/harness/contract.test.ts
 *
 * Harness ↔ Codex wire-contract regression tests.
 *
 * The first scenario reproduces a real production failure observed
 * 2026-05-19: the workflow runner handed off Orchestrator → Executor
 * and Codex /responses then rejected the next turn with
 *   400 "No tool output found for function call call_XXX."
 *
 * The SDK adds both a function_call item (the handoff invocation)
 * AND a function_call_result item (the handoff transfer message)
 * to the next turn's input. If either one is dropped or mis-keyed
 * by our wire serializer, Codex blows up. This test asserts the
 * pairing survives end-to-end, using the same item shapes the SDK
 * actually emits in production.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Sandboxed HOME so any module that lazily writes to ~/.clementine-next
// during import doesn't touch the user's real state.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-contract-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildCodexRequestBody } = await import('./codex-model.js');
const sdk = await import('@openai/agents');

// The SDK's AgentInputItem shape for these two item kinds (from
// @openai/agents-core/dist/types/protocol.d.ts). Both carry callId
// in camelCase — the serializer's job is to map them to call_id
// in the Codex wire format and keep both on the same id.
interface SDKFunctionCallItem {
  type: 'function_call';
  id?: string;
  callId: string;
  name: string;
  arguments: string;
  status: 'in_progress' | 'completed' | 'incomplete';
}

interface SDKFunctionCallResultItem {
  type: 'function_call_result';
  id?: string;
  callId: string;
  name: string;
  output: { type: 'text'; text: string };
  status: 'in_progress' | 'completed' | 'incomplete';
}

// Mirrors what `getToolCallOutputItem` in the SDK's runImplementation.js
// produces for a handoff transfer — same fields, same casing.
function buildHandoffPair(callId: string): [SDKFunctionCallItem, SDKFunctionCallResultItem] {
  return [
    {
      type: 'function_call',
      id: 'fc_handoff_1',
      callId,
      name: 'transfer_to_Executor',
      arguments: '{}',
      status: 'completed',
    },
    {
      type: 'function_call_result',
      callId,
      name: 'transfer_to_Executor',
      output: { type: 'text', text: 'Transferred to Executor.' },
      status: 'completed',
    },
  ];
}

interface WireItem {
  type?: string;
  call_id?: string;
}

function findItems(body: { input: unknown[] }, type: string): WireItem[] {
  return (body.input as WireItem[]).filter((it) => it && it.type === type);
}

function buildRequest(input: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    input,
    tools: [],
    handoffs: [],
    modelSettings: {},
    outputType: 'text',
    tracing: false,
    ...overrides,
  } as unknown as Parameters<typeof buildCodexRequestBody>[1];
}

async function withNativeCompactionEnv<T>(
  value: string | undefined,
  threshold: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previousValue = process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
  const previousThreshold = process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
  if (value == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
  else process.env.CLEMMY_CODEX_NATIVE_COMPACTION = value;
  if (threshold == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
  else process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD = threshold;
  try {
    return await fn();
  } finally {
    if (previousValue == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION;
    else process.env.CLEMMY_CODEX_NATIVE_COMPACTION = previousValue;
    if (previousThreshold == null) delete process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD;
    else process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD = previousThreshold;
  }
}

test('native Codex compaction is omitted by default and previous_response_id is never sent', async () => {
  await withNativeCompactionEnv(undefined, undefined, () => {
    const body = buildCodexRequestBody('gpt-5', buildRequest(
      [{ role: 'user', content: 'hello' }],
      { previousResponseId: 'resp_forbidden' },
    ));
    const wire = body as unknown as Record<string, unknown>;
    assert.equal(wire.context_management, undefined);
    assert.equal(wire.previous_response_id, undefined);
    assert.equal(wire.previousResponseId, undefined);
  });
});

test('native Codex compaction flag sends SDK context_management with backend-safe snake-case threshold', async () => {
  await withNativeCompactionEnv('1', '4', () => {
    const body = buildCodexRequestBody('gpt-5', buildRequest([{ role: 'user', content: 'hello' }]));
    assert.deepEqual(body.context_management, [{ type: 'compaction', compact_threshold: 1000 }]);
  });

  await withNativeCompactionEnv('1', undefined, () => {
    const body = buildCodexRequestBody('gpt-5', buildRequest(
      [{ role: 'user', content: 'hello' }],
      {
        modelSettings: {
          contextManagement: [{ type: 'compaction', compactThreshold: 1234, keep: 'provider-data' }],
        },
      },
    ));
    assert.deepEqual(body.context_management, [{ type: 'compaction', compact_threshold: 1234, keep: 'provider-data' }]);
  });
});

test('compaction input items round-trip only when native Codex compaction flag is enabled', async () => {
  const input = [
    { role: 'user', content: 'hello' },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'ciphertext', created_by: 'server' },
  ];

  await withNativeCompactionEnv(undefined, undefined, () => {
    const body = buildCodexRequestBody('gpt-5', buildRequest(input));
    assert.equal(findItems(body, 'compaction').length, 0);
  });

  await withNativeCompactionEnv('1', '4', () => {
    const body = buildCodexRequestBody('gpt-5', buildRequest(input));
    const compactions = findItems(body, 'compaction') as Array<Record<string, unknown>>;
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].id, 'cmp_1');
    assert.equal(compactions[0].encrypted_content, 'ciphertext');
    assert.equal(compactions[0].created_by, 'server');
  });
});

test('handoff round-trip: function_call and function_call_output both reach the wire with matching call_id', () => {
  const callId = 'call_FcJvAFqYbLnNZlg62XKGdiFt';
  const [fc, fcr] = buildHandoffPair(callId);
  const input = [
    { role: 'user', content: 'go' },
    fc,
    fcr,
  ];
  // Cast: ModelRequest's input typing is strict; the test deliberately
  // uses a hand-built shape that mirrors the SDK's runtime output.
  const body = buildCodexRequestBody('gpt-5', buildRequest(input));

  const calls = findItems(body, 'function_call');
  const outputs = findItems(body, 'function_call_output');

  assert.equal(calls.length, 1, `expected exactly one function_call on the wire, got ${calls.length}`);
  assert.equal(outputs.length, 1, `expected exactly one function_call_output on the wire, got ${outputs.length}`);
  assert.equal(calls[0].call_id, callId, 'function_call.call_id should be preserved');
  assert.equal(outputs[0].call_id, callId, 'function_call_output.call_id must match the function_call (this is the Codex pairing contract)');
});

test('regular tool call round-trip: same pairing contract holds', () => {
  // Same shape as a handoff, just a non-transfer function name. The
  // serializer must not key off the tool name — it must pair on call_id
  // for ANY function call, handoff or otherwise.
  const callId = 'call_regular_xyz';
  const input = [
    { role: 'user', content: 'go' },
    {
      type: 'function_call',
      id: 'fc_1',
      callId,
      name: 'run_shell_command',
      arguments: '{"command":"echo hi"}',
      status: 'completed',
    },
    {
      type: 'function_call_result',
      callId,
      name: 'run_shell_command',
      output: { type: 'text', text: 'hi\n' },
      status: 'completed',
    },
  ];
  const body = buildCodexRequestBody('gpt-5', buildRequest(input));
  const calls = findItems(body, 'function_call');
  const outputs = findItems(body, 'function_call_output');

  assert.equal(calls.length, 1);
  assert.equal(outputs.length, 1);
  assert.equal(calls[0].call_id, callId);
  assert.equal(outputs[0].call_id, callId);
});

test('SDK round-trip: handoff produces an input on turn 2 that includes the function_call_result paired with the handoff function_call', async () => {
  // This is the runtime-level reproduction of the production failure
  // observed 2026-05-19 (workflow run sess-mpcxx4v1-102cdfb2):
  //   Codex /responses returned 400: "No tool output found for
  //   function call call_FcJvAFqYbLnNZlg62XKGdiFt."
  // The wire serialization tests above pass — so the question this
  // test answers is whether the SDK itself, given our handoff
  // configuration, actually passes the function_call_result into
  // the next turn's input. If it does, the bug is upstream of the
  // SDK boundary entirely.
  type CapturedInput = unknown[];
  const captures: CapturedInput[] = [];
  let callIndex = 0;
  const expectedCallId = 'call_handoff_seed';

  const stubModel: import('@openai/agents').Model = {
    async getResponse(request) {
      // Snapshot the input we got on each call.
      const inputCopy = JSON.parse(JSON.stringify(request.input));
      captures.push(inputCopy);
      callIndex += 1;
      if (callIndex === 1) {
        // Turn 1: Orchestrator → emit a handoff function call.
        return {
          output: [
            {
              type: 'function_call',
              id: 'fc_handoff_1',
              callId: expectedCallId,
              name: 'transfer_to_Executor',
              arguments: '{}',
              status: 'completed',
            },
          ],
          usage: new sdk.Usage(),
          responseId: 'resp_1',
        } as unknown as import('@openai/agents').ModelResponse;
      }
      // Turn 2: Executor → emit a final assistant message.
      return {
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', providerData: {} }],
          },
        ],
        usage: new sdk.Usage(),
        responseId: 'resp_2',
      } as unknown as import('@openai/agents').ModelResponse;
    },
    async *getStreamedResponse() {
      throw new Error('not used in this test');
    },
  };

  const stubProvider: import('@openai/agents').ModelProvider = {
    getModel() {
      return stubModel;
    },
  };

  const executor = new sdk.Agent({
    name: 'Executor',
    instructions: 'You are the Executor stub.',
  });

  const orchestrator = new sdk.Agent({
    name: 'Orchestrator',
    instructions: 'You are the Orchestrator stub.',
    handoffs: [sdk.handoff(executor)],
  });

  const runner = new sdk.Runner({ modelProvider: stubProvider });
  await runner.run(orchestrator, 'do thing');

  // The SDK calls the model at least twice for an Orchestrator → Executor → final flow.
  assert.ok(captures.length >= 2, `expected at least 2 model calls, got ${captures.length}`);

  const turn2Input = captures[1] as Array<Record<string, unknown>>;
  const fcItems = turn2Input.filter((it) => it.type === 'function_call');
  const fcrItems = turn2Input.filter((it) => it.type === 'function_call_result');

  assert.ok(fcItems.length >= 1, 'SDK should carry the handoff function_call into turn 2 input');
  assert.ok(fcrItems.length >= 1, 'SDK should carry the handoff function_call_result into turn 2 input (this is the contract Codex enforces)');

  const fcCallIds = new Set(fcItems.map((it) => it.callId));
  for (const fcr of fcrItems) {
    assert.ok(fcCallIds.has(fcr.callId as string), `function_call_result has callId ${fcr.callId} but there is no function_call with that callId in the same input — Codex will reject this with "No tool output found for function call".`);
  }
});

test('SDK round-trip: parallel handoffs (model emits transfer_to_X twice) still produces a fully-paired turn-2 input', async () => {
  // The production failure (sess-mpcxx4v1-102cdfb2) logged TWO
  // `handoff (Orchestrator -> Executor)` events. The SDK's
  // executeHandoffCalls handles this by accepting the first and
  // rejecting subsequent ones with a "Multiple handoffs detected"
  // tool-call-output. This test asserts that even in that case,
  // every function_call in the next turn's input has a matching
  // function_call_result.
  type CapturedInput = unknown[];
  const captures: CapturedInput[] = [];
  let callIndex = 0;

  const stubModel: import('@openai/agents').Model = {
    async getResponse(request) {
      captures.push(JSON.parse(JSON.stringify(request.input)));
      callIndex += 1;
      if (callIndex === 1) {
        return {
          output: [
            { type: 'function_call', id: 'fc_h1', callId: 'call_handoff_A', name: 'transfer_to_Executor', arguments: '{}', status: 'completed' },
            { type: 'function_call', id: 'fc_h2', callId: 'call_handoff_B', name: 'transfer_to_Executor', arguments: '{}', status: 'completed' },
          ],
          usage: new sdk.Usage(),
          responseId: 'resp_1',
        } as unknown as import('@openai/agents').ModelResponse;
      }
      return {
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', providerData: {} }] }],
        usage: new sdk.Usage(),
        responseId: 'resp_2',
      } as unknown as import('@openai/agents').ModelResponse;
    },
    async *getStreamedResponse() { throw new Error('not used'); },
  };

  const stubProvider: import('@openai/agents').ModelProvider = { getModel: () => stubModel };
  const executor = new sdk.Agent({ name: 'Executor', instructions: 'stub' });
  const orchestrator = new sdk.Agent({ name: 'Orchestrator', instructions: 'stub', handoffs: [sdk.handoff(executor)] });
  const runner = new sdk.Runner({ modelProvider: stubProvider });
  await runner.run(orchestrator, 'do thing');

  assert.ok(captures.length >= 2, `expected at least 2 model calls, got ${captures.length}`);
  const turn2 = captures[1] as Array<Record<string, unknown>>;
  const calls = turn2.filter((it) => it.type === 'function_call').map((it) => it.callId as string);
  const outputCallIds = new Set(turn2.filter((it) => it.type === 'function_call_result').map((it) => it.callId as string));
  for (const cid of calls) {
    assert.ok(outputCallIds.has(cid), `parallel-handoff: function_call ${cid} has no paired function_call_result on turn-2 input. all calls=${calls.join(',')}, outputs=${[...outputCallIds].join(',')}`);
  }
});

test('Phase B plumbing: tool_choice memory drives the recall → remember → recall-hit lifecycle', async () => {
  // Asserts the discipline plumbing works end-to-end:
  //   1. First recall on an unknown intent → null (forces discovery).
  //   2. After discovery + probe, remember writes the choice.
  //   3. Second recall returns the recorded choice — future runs skip discovery.
  //   4. On runtime failure, invalidate clears the active choice and the next
  //      recall sees an empty choice + the failure in fallbacks.
  // This is what the Orchestrator prompt's TOOL DISCOVERY DISCIPLINE relies on.
  const { recallToolChoice, rememberToolChoice, invalidateToolChoice } = await import(
    '../../memory/tool-choice-store.js'
  );

  const intent = 'phase-b-smoke.salesforce.accounts.list_stale';
  assert.equal(recallToolChoice(intent), null, 'fresh intent should miss');

  // Simulate the Orchestrator after a successful probe of the sf CLI.
  rememberToolChoice({
    intent,
    description: 'Pull stale Salesforce accounts via the local CLI.',
    choice: {
      kind: 'cli',
      identifier: 'sf',
      invocationTemplate: 'sf data query --json --query "{{query}}"',
      testEvidence: 'sf --version exit 0',
    },
    fallbacks: [
      { kind: 'composio', identifier: 'SALESFORCE_QUERY_RECORDS', reason: 'toolkit not connected', failedAt: new Date().toISOString() },
    ],
  });

  const recallHit = recallToolChoice(intent);
  assert.ok(recallHit?.choice, 'second recall should return the recorded choice');
  assert.equal(recallHit!.choice!.kind, 'cli');
  assert.equal(recallHit!.choice!.identifier, 'sf');
  assert.equal(recallHit!.fallbacks.length, 1, 'fallback list must persist with the choice');

  // Simulate runtime failure path.
  invalidateToolChoice(intent, 'EPERM uv_cwd after macOS update');
  const recallAfterInvalidate = recallToolChoice(intent);
  assert.equal(recallAfterInvalidate?.choice, null, 'invalidate clears the active choice');
  assert.equal(recallAfterInvalidate!.fallbacks.length, 2, 'invalidate appends the failure to fallbacks');
});

test('Phase B wiring: Orchestrator tool surface includes the discovery + memory tools', async () => {
  // The Orchestrator's `tools:` array is curated narrowly (the agent
  // has zero direct action tools). The Phase B discipline requires
  // tool_choice_recall / _remember / _invalidate AND local_cli_list /
  // local_cli_probe to be present, alongside the existing
  // composio_search_tools and lazy skill tools. Without them, the prompt
  // rubric is unreachable.
  const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
  const orchestrator = await buildOrchestratorAgent();
  const toolNames = new Set(
    (orchestrator.tools as unknown as Array<{ name?: string }>).map((t) => t.name ?? ''),
  );
  for (const required of [
    'tool_choice_recall',
    'tool_choice_remember',
    'tool_choice_invalidate',
    'local_cli_list',
    'local_cli_probe',
    'composio_search_tools',
    'skill_list',
    'skill_read',
    'draft_plan',
    'request_approval',
    'ask_user_question',
  ]) {
    assert.ok(
      toolNames.has(required),
      `Orchestrator is missing required tool "${required}" — Phase B discipline cannot run`,
    );
  }
});

test('multi-tool turn: every function_call has a paired function_call_output on the wire', () => {
  // The model can emit several parallel tool calls in one turn. The
  // SDK then runs each and appends each result; the next turn's input
  // contains ALL the calls and ALL the outputs. Codex validates the
  // pairing across the whole array — one orphan call_id is enough
  // to 400 the entire request.
  const ids = ['call_a', 'call_b', 'call_c'];
  const input: unknown[] = [{ role: 'user', content: 'go' }];
  for (const id of ids) {
    input.push({
      type: 'function_call',
      id: `fc_${id}`,
      callId: id,
      name: 'memory_search',
      arguments: '{"query":"x"}',
      status: 'completed',
    });
  }
  for (const id of ids) {
    input.push({
      type: 'function_call_result',
      callId: id,
      name: 'memory_search',
      output: { type: 'text', text: 'no hits' },
      status: 'completed',
    });
  }
  const body = buildCodexRequestBody('gpt-5', buildRequest(input));
  const calls = findItems(body, 'function_call');
  const outputs = findItems(body, 'function_call_output');

  assert.equal(calls.length, ids.length);
  assert.equal(outputs.length, ids.length);

  // Every call's id must appear among the outputs.
  const outIds = new Set(outputs.map((o) => o.call_id));
  for (const c of calls) {
    assert.ok(c.call_id && outIds.has(c.call_id), `function_call ${c.call_id} has no paired function_call_output on the wire`);
  }
});
