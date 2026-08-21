import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredBrainSemanticPort,
  semanticModelRoleForPurpose,
  tokensFromAgentRun,
} from './configured-brain-semantic-port.js';
import type { TurnSemanticHostViewV1 } from './turn-semantic-proposal.js';

test('semantic interpretation uses the brain while write judgment uses the judge role', () => {
  assert.equal(semanticModelRoleForPurpose('turn_semantics'), 'brain');
  assert.equal(semanticModelRoleForPurpose('turn_semantics_effect_judge'), 'judge');
  assert.equal(semanticModelRoleForPurpose('turn_semantics_plan_grounding'), 'judge');
});

test('configured brain receives bounded host capability descriptors, not only IDs', async () => {
  let seen: unknown;
  const port = configuredBrainSemanticPort(async (input) => {
    seen = JSON.parse(input.user);
    return { raw: { version: 1 }, modelIdentity: 'test', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  });
  const host: TurnSemanticHostViewV1 = {
    source: {
      sessionId: 'sess-desc',
      sourceUserSeq: 1,
      inputHash: 'a'.repeat(64),
      audienceHash: 'b'.repeat(64),
    },
    policyRevision: 'c'.repeat(64),
    resumableGoals: [],
    openQuestions: [],
    catalog: {
      capabilityIds: new Set(['cap:host_create:destination']),
      workflowIds: new Set(),
      capabilities: [{
        id: 'cap:host_create:destination',
        effect: 'external_write',
        purpose: 'persist_collection',
        acceptedInputKinds: ['records'],
        producedOutputKinds: ['created_resource'],
        applicableDeliverableKinds: ['created_resource'],
        inputShape: 'records',
        outputShape: 'created_resource',
        outputKind: 'created_resource',
        deliverableKind: 'created_resource',
        destinationPosture: 'create_new',
        evidenceKinds: ['receipt', 'readback'],
        handleRequired: true,
        readbackRequired: true,
        accountScope: 'host:production',
        manifestDigest: 'd'.repeat(64),
      }],
    },
  };
  await port.interpret({
    purpose: 'turn_semantics',
    host,
    acceptedText: 'unused',
  });
  const payload = seen as { host: { capabilities: Array<{ id: string; purpose: string }>; capabilityIds: string[] } };
  assert.deepEqual(payload.host.capabilityIds, ['cap:host_create:destination']);
  assert.equal(payload.host.capabilities[0]?.purpose, 'persist_collection');
  assert.equal(payload.host.capabilities[0]?.id, 'cap:host_create:destination');
});

test('tokensFromAgentRun reads real Agents SDK and wire usage instead of reporting zero', () => {
  assert.deepEqual(tokensFromAgentRun({
    state: { usage: { inputTokens: 2100, outputTokens: 854 } },
  }), { inputTokens: 2100, outputTokens: 854 });
  assert.deepEqual(tokensFromAgentRun({
    rawResponses: [
      { usage: { input_tokens: 1000, output_tokens: 200 } },
      { usage: { input_tokens: 1100, output_tokens: 654 } },
    ],
  }), { inputTokens: 2100, outputTokens: 854 });
  assert.deepEqual(tokensFromAgentRun({
    runContext: { usage: { requestUsageEntries: [{ inputTokens: 2954, outputTokens: 0 }] } },
  }), { inputTokens: 2954, outputTokens: 0 });
});
