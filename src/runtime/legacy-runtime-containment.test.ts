import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RunContext, RunState, type Agent } from '@openai/agents';
import { BASE_DIR } from '../config.js';
import type { RunRequest, RuntimeContextValue } from '../types.js';
import { ApprovalStore } from './approval-store.js';
import { CodexNativeRuntime, createCodexToolDefinitions } from './codex-native-runtime.js';
import { OpenAIRuntime } from './openai.js';

type OpenAIAgentFactory = {
  createAgent(request: RunRequest): Promise<Agent<RuntimeContextValue>>;
};

type CodexToolRefuser = {
  refuseToolCall(
    toolCall: { call_id: string; name: string; arguments: string },
    callbacks?: { onToolActivity?: (activity: { toolName: string }) => Promise<void> },
  ): Promise<string>;
};

async function openAIAgent(runtime: OpenAIRuntime, request: RunRequest): Promise<Agent<RuntimeContextValue>> {
  return (runtime as unknown as OpenAIAgentFactory).createAgent(request);
}

function approvalRunState(
  agent: Agent<RuntimeContextValue>,
  toolName: string,
  argumentsJson: string,
): string {
  const state = new RunState(
    new RunContext<RuntimeContextValue>({ sessionId: 'legacy-openai' }),
    'approve this',
    agent,
    null,
  );
  const json = state.toJSON() as Record<string, unknown>;
  json.currentStep = {
    type: 'next_step_interruption',
    data: {
      interruptions: [{
        rawItem: {
          type: 'function_call',
          name: toolName,
          callId: `${toolName}-call`,
          arguments: argumentsJson,
        },
        toolName,
      }],
    },
  };
  return JSON.stringify(json);
}

test('OpenAIRuntime remains a text model but exposes zero executable tools and handoffs', async () => {
  const runtime = new OpenAIRuntime();
  const agent = await openAIAgent(runtime, {
    sessionId: 'controller-json',
    instructions: 'Return one JSON object only.',
    model: 'gpt-test-model',
    prompt: 'Choose the next controller action.',
  });

  assert.deepEqual(agent.tools, []);
  assert.deepEqual(agent.handoffs, []);
  assert.equal(agent.instructions, 'Return one JSON object only.');
  assert.equal(agent.model, 'gpt-test-model');
});

test('CodexNativeRuntime provider surface is model-only', async () => {
  assert.deepEqual(await createCodexToolDefinitions(), []);
  assert.deepEqual(await createCodexToolDefinitions(['write_file']), []);
});

test('an unexpected Codex provider function call is a terminal no-start, not a hidden executor', async () => {
  const runtime = new CodexNativeRuntime();
  const marker = path.join(BASE_DIR, 'output', 'codex-unadvertised-tool-body-ran.txt');
  let surfaced = 0;
  const refusal = await (runtime as unknown as CodexToolRefuser).refuseToolCall({
    call_id: 'unadvertised-write',
    name: 'write_file',
    arguments: JSON.stringify({ path: marker, content: 'executed', mode: 'overwrite' }),
  }, {
    onToolActivity: async (activity) => {
      assert.equal(activity.toolName, 'write_file');
      surfaced += 1;
    },
  });

  assert.match(refusal, /was not started/i);
  assert.equal(surfaced, 1);
  assert.equal(existsSync(marker), false);
});

test('OpenAIRuntime retires an opaque legacy approval without deserializing or resuming it', async () => {
  const runtime = new OpenAIRuntime();
  const store = new ApprovalStore();
  const approvalId = 'legacy-openai-opaque';
  store.add({
    id: approvalId,
    sessionId: 'legacy-openai',
    agentName: 'legacy-openai-agent',
    toolName: 'write_file',
    createdAt: new Date().toISOString(),
    status: 'pending',
    state: 'this is deliberately not an SDK RunState',
  });

  const result = await runtime.resolveApproval(approvalId, true);
  assert.equal(result.status, 'rejected');
  assert.match(result.text, /retired/i);
  assert.equal(store.get(approvalId)?.status, 'rejected');
  assert.equal(store.get(approvalId)?.state, 'this is deliberately not an SDK RunState');
});

test('OpenAIRuntime approved legacy write state executes zero tool bodies', async () => {
  const runtime = new OpenAIRuntime();
  const store = new ApprovalStore();
  const marker = path.join(BASE_DIR, 'output', 'openai-legacy-approval-body-ran.txt');
  const agent = await openAIAgent(runtime, { sessionId: 'legacy-openai-body', prompt: '' });
  const approvalId = 'legacy-openai-write';
  store.add({
    id: approvalId,
    sessionId: 'legacy-openai-body',
    agentName: 'legacy-openai-agent',
    toolName: 'write_file',
    createdAt: new Date().toISOString(),
    status: 'pending',
    state: approvalRunState(agent, 'write_file', JSON.stringify({
      path: marker,
      content: 'legacy body executed',
      mode: 'overwrite',
    })),
  });

  const result = await runtime.resolveApproval(approvalId, true);
  assert.equal(result.status, 'rejected');
  assert.equal(existsSync(marker), false, 'retired OpenAI approval executed write_file');
});

test('CodexNativeRuntime approved legacy write state executes zero tool bodies', async () => {
  const runtime = new CodexNativeRuntime();
  const store = new ApprovalStore();
  const marker = path.join(BASE_DIR, 'output', 'codex-legacy-approval-body-ran.txt');
  const approvalId = 'legacy-codex-write';
  store.add({
    id: approvalId,
    sessionId: 'legacy-codex-body',
    agentName: 'legacy-codex-agent',
    toolName: 'write_file',
    createdAt: new Date().toISOString(),
    status: 'pending',
    state: JSON.stringify({
      request: { sessionId: 'legacy-codex-body', prompt: 'continue' },
      toolCall: {
        call_id: 'legacy-write-call',
        name: 'write_file',
        arguments: JSON.stringify({ path: marker, content: 'legacy body executed', mode: 'overwrite' }),
      },
    }),
  });

  const result = await runtime.resolveApproval(approvalId, true);
  assert.equal(result.status, 'rejected');
  assert.match(result.text, /retired/i);
  assert.equal(existsSync(marker), false, 'retired Codex approval executed write_file');
  assert.equal(store.get(approvalId)?.status, 'rejected');
});

test('runtime construction quarantines pending legacy rows without deleting their state', () => {
  const store = new ApprovalStore();
  const approvalId = 'legacy-pending-before-runtime';
  store.add({
    id: approvalId,
    sessionId: 'legacy-quarantine',
    agentName: 'legacy-agent',
    toolName: 'run_shell_command',
    createdAt: new Date().toISOString(),
    status: 'pending',
    state: 'preserve-this-opaque-state',
  });

  new OpenAIRuntime();
  const quarantined = store.get(approvalId);
  assert.equal(quarantined?.status, 'rejected');
  assert.equal(quarantined?.state, 'preserve-this-opaque-state');
  assert.equal(store.listAll().some((approval) => approval.id === approvalId), true);
});
