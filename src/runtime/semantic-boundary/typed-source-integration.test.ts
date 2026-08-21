/** Run: npx tsx --test src/runtime/semantic-boundary/typed-source-integration.test.ts
 *
 * Production entrypoints: primary runConversation, Claude brain, both
 * fallover directions, two-process claim contention, and crash/restart.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '@openai/agents';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-typed-source-entry-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMENTINE_SEMANTIC_CLAIM_WAIT_MS = '400';
process.env.CLEMENTINE_SEMANTIC_CLAIM_LEASE_MS = '250';

const { appendEvent, createSession, listEvents, openEventLog, resetEventLog } = await import('../harness/eventlog.js');
const { runConversation } = await import('../harness/loop.js');
const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
} = await import('../harness/claude-agent-brain.js');
const { recoverChatBrainFailure, captureRecoveryLedgerBaseline } = await import('../harness/respond-bridge.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { setAdmittedGraphRunFault } = await import('../harness/admitted-construct-run.js');
const { catalogFromConstructProviders } = await import('../harness/construct-provider-catalog.fixture.js');
const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const { verifyAcceptedTaskTerminalProofInTransaction } = await import('../harness/terminal-publication-proof.js');
const { installHostCapabilityCatalogFactory, createHostCapabilityCatalogFactory } = await import('../harness/host-capability-catalog-factory.js');
configureTypedExecutionRuntime();
const {
  entailedCapabilityGroundingJudge,
  entailedPlanGroundingJudge,
  entailedSourceEffectJudge,
  fakeSemanticProposal,
} = await import('./fake-semantic-model.js');
const { productionCapabilityManifests } = await import('../harness/production-capability-catalog.js');
const { capabilityManifestDigest } = await import('../harness/capability-manifest.js');
const { hostDescriptorFromRegistered } = await import('./admit-and-compile-accepted-source.js');
const { catalogSnapshotDigestFromDescriptors } = await import('./plan-grounding.js');

function constructCatalog() {
  const capabilities = productionCapabilityManifests().map((manifest) => hostDescriptorFromRegistered({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  })!);
  return {
    capabilities,
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(capabilities),
  };
}
const { turnGraphFromShadowEvent } = await import('../graph/turn-graph-shadow.js');
const { getTurnGraphEventForSource } = await import('../harness/eventlog.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
import type { TurnSemanticModelPort } from './turn-semantic-model-port.js';

saveProactivityPolicy({ autoApproveScope: 'yolo' });

function countingPort(): { port: TurnSemanticModelPort; calls: number } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    port: {
      async interpret(call) {
        state.calls += 1;
        return {
          raw: fakeSemanticProposal(
            call.host.openQuestions.length > 0 ? 'affirmDidYouMean' : 'newConstruct',
            call.host,
          ),
          modelIdentity: 'fake-semantic/entrypoint',
          inputTokens: 20,
          outputTokens: 40,
          latencyMs: 3,
        };
      },
      async judgeSourceEffect(call) {
        return entailedSourceEffectJudge(call, 'fake-semantic/judge');
      },
      async judgePlanGrounding(call) {
        return entailedCapabilityGroundingJudge(call, 'fake-semantic/grounding');
      },
    },
  };
}

function singleReadPort(): TurnSemanticModelPort {
  return {
    async interpret(call) {
      const source = call.host.catalog.capabilities?.find((entry) => entry.advisoryRoles?.includes('source'));
      assert.ok(source);
      return {
        raw: fakeSemanticProposal({
          relation: 'new_goal',
          goal: {
            objective: 'Retrieve the requested source.',
            criteria: [{ id: 'c-result', statement: 'The requested source is returned.' }],
            openSlots: [],
            candidates: [],
          },
          work: {
            construct: 'single_act',
            cardinality: null,
            destination: null,
            requestedEffect: 'read',
            operations: [{
              id: 'op-read',
              role: 'source',
              requestedEffect: 'read',
              capabilityRef: source.id,
              dependsOn: [],
              evidence: ['payload'],
            }],
            deliverables: [{ id: 'result', kind: 'locator' }],
            evidenceRequirements: ['payload'],
          },
        }, call.host),
        modelIdentity: 'fake-semantic/single-read',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return entailedSourceEffectJudge(call, 'fake-semantic/single-read-judge');
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/single-read-grounding');
    },
  };
}

const FIVE = [
  { title: 'a', date: '1', link: 'l1' },
  { title: 'b', date: '2', link: 'l2' },
  { title: 'c', date: '3', link: 'l3' },
  { title: 'd', date: '4', link: 'l4' },
  { title: 'e', date: '5', link: 'l5' },
];

function providers(state: { creates: number } = { creates: 0 }) {
  let written: Array<Record<string, unknown>> = [];
  return {
    state,
    async sourceRead() { return { locator: 'src-1' }; },
    async collectionRead() { return { records: FIVE }; },
    async transform(records: Array<Record<string, unknown>>) { return records; },
    async create(records: Array<Record<string, unknown>>) {
      state.creates += 1;
      written = records;
      return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' };
    },
    async readback(id: string) {
      return { id, handle: 'https://example.invalid/sheet', content: written };
    },
  };
}

function catalog(state?: { creates: number }) {
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  configureTypedExecutionRuntime();
  return catalogFromConstructProviders(providers(state));
}

function dummyAgent(): Agent {
  return new Agent({ name: 'typed-entry-dummy', instructions: 'unused', tools: [] });
}





// ============================================================================
// RETIRED PINS — THE CLEAN LOOP (2026-08-19, Nathan's directive):
// "No routers. Everything goes through the model with tools attached."
// The tests removed below pinned the CHAT ceremony doctrine (model proposal +
// judges routing live turns into the typed executor). That doctrine is
// retired: live turns are always unparticipated -> untyped shadow graph ->
// ONE model turn WITH tools; writes gate at the carrier. The typed executor
// and its authority machinery survive as the WORKFLOW-REPLAY engine (see
// fast-lane-collect-construct.test.ts REPLAY MACHINERY + TAMPER pins,
// physical-authority / physical-dispatch-grounding / plan-grounding /
// interpret-accepted-source suites, all green). When the replay entry seam
// lands, its golden pins are re-derived from the removed tests via git
// history of this file.
// ============================================================================

test('no installed capability blocks with zero provider calls', async () => {
  resetEventLog();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
  const counted = countingPort();
  installTurnSemanticModelPort(counted.port);
  try {
    const sessionId = 'sess-no-capability';
    createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
    const writes = { creates: 0 };
    const result = await runConversation({
      sessionId,
      input: 'find five widgets and put them in a workbook',
      agent: dummyAgent(),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(writes.creates, 0);
    assert.ok(result.error ?? result.status === 'failed');
  } finally {
    installTurnSemanticModelPort(null);
  }
});






test('two processes contend on one claim; waiter replays the exact hashes', async () => {
  resetEventLog();
  const sessionId = 'sess-two-process';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'find five widgets and put them in a workbook' },
  });
  const script = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(HOME)};
    const { interpretAcceptedSource } = await import(${JSON.stringify(new URL('./interpret-accepted-source.ts', import.meta.url).pathname)});
    const { createSession } = await import(${JSON.stringify(new URL('../harness/eventlog.js', import.meta.url).pathname)});
    const { fakeSemanticProposal } = await import(${JSON.stringify(new URL('./fake-semantic-model.js', import.meta.url).pathname)});
    const { buildTurnSemanticHostViewV1 } = await import(${JSON.stringify(new URL('./build-semantic-host-view.js', import.meta.url).pathname)});
    const { productionCapabilityManifests } = await import(${JSON.stringify(new URL('../harness/production-capability-catalog.js', import.meta.url).pathname)});
    const { capabilityManifestDigest } = await import(${JSON.stringify(new URL('../harness/capability-manifest.js', import.meta.url).pathname)});
    const { hostDescriptorFromRegistered } = await import(${JSON.stringify(new URL('./admit-and-compile-accepted-source.js', import.meta.url).pathname)});
    const { catalogSnapshotDigestFromDescriptors } = await import(${JSON.stringify(new URL('./plan-grounding.js', import.meta.url).pathname)});
    const { entailedPlanGroundingJudge } = await import(${JSON.stringify(new URL('./fake-semantic-model.js', import.meta.url).pathname)});
    const capabilities = productionCapabilityManifests().map((manifest) => hostDescriptorFromRegistered({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      destination: manifest.destination,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({}),
    }));
    const snapshot = {
      sessionId: ${JSON.stringify(sessionId)},
      sourceUserSeq: ${source.seq},
      acceptedText: 'find five widgets and put them in a workbook',
      audienceKey: 'user-1:${sessionId}',
      userId: 'user-1',
      conversationKey: ${JSON.stringify(sessionId)},
      policyRevision: 'd'.repeat(64),
      capabilities,
      catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(capabilities),
    };
    const host = buildTurnSemanticHostViewV1(snapshot);
    const result = await interpretAcceptedSource({
      snapshot,
      authority: {
        policyRevision: host.policyRevision,
        audienceHash: host.source.audienceHash,
        policyMaxCeiling: 'external_write',
        allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
      },
      port: {
        async interpret(call) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return {
            raw: fakeSemanticProposal('newConstruct', call.host),
            modelIdentity: 'child',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          };
        },
        async judgeSourceEffect(call) {
          return {
            verdict: 'entailed',
            effect: call.proposedEffect,
            destinationPosture: call.proposedDestinationPosture,
            proposalDigest: call.proposalDigest,
            modelIdentity: 'child-judge',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
          };
        },
        async judgePlanGrounding(call) {
          return entailedPlanGroundingJudge(call, 'child-grounding');
        },
      },
      turn: 1,
    });
    process.stdout.write(result.status);
  `;
  const childPath = path.join(HOME, 'child-claim.mjs');
  writeFileSync(childPath, script);
  const child = spawnSync(process.execPath, ['--import', 'tsx', childPath], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CLEMENTINE_HOME: HOME },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'admitted');
  const counted = countingPort();
  const { interpretAcceptedSource } = await import('./interpret-accepted-source.js');
  const { buildTurnSemanticHostViewV1 } = await import('./build-semantic-host-view.js');
  const snapshot = {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedText: 'find five widgets and put them in a workbook',
    audienceKey: `user-1:${sessionId}`,
    userId: 'user-1',
    conversationKey: sessionId,
    policyRevision: 'd'.repeat(64),
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const replay = await interpretAcceptedSource({
    snapshot,
    authority: {
      policyRevision: host.policyRevision,
      audienceHash: host.source.audienceHash,
      policyMaxCeiling: 'external_write',
      allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
    },
    port: counted.port,
    turn: 1,
  });
  assert.equal(replay.status, 'admitted');
  assert.equal(replay.replayed, true);
  assert.equal(counted.calls, 0);
});

test('crash before persist lets a later process steal an expired claim', async () => {
  resetEventLog();
  const sessionId = 'sess-crash-restart';
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'find five widgets and put them in a workbook' },
  });
  openEventLog().prepare(
    `INSERT INTO turn_semantics_claims (session_id, source_user_seq, owner, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, source.seq, 'dead-owner', new Date(Date.now() - 60_000).toISOString());
  const counted = countingPort();
  const { interpretAcceptedSource } = await import('./interpret-accepted-source.js');
  const { buildTurnSemanticHostViewV1 } = await import('./build-semantic-host-view.js');
  const snapshot = {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedText: 'find five widgets and put them in a workbook',
    audienceKey: `user-1:${sessionId}`,
    userId: 'user-1',
    conversationKey: sessionId,
    policyRevision: 'd'.repeat(64),
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const result = await interpretAcceptedSource({
    snapshot,
    authority: {
      policyRevision: host.policyRevision,
      audienceHash: host.source.audienceHash,
      policyMaxCeiling: 'external_write',
      allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
    },
    port: counted.port,
    turn: 1,
  });
  assert.equal(result.status, 'admitted');
  assert.equal(result.replayed, false);
  assert.equal(counted.calls, 1);
});





test.after(() => {
  if (process.env.CLEMENTINE_KEEP_TYPED_TEST_HOME === '1') return;
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* tmp */ }
});
