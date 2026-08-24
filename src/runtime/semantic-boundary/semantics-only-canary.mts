/**
 * Semantics-only canary: competing write capabilities, zero provider dispatch.
 * Run: CLEM_CANARY_DETERMINISTIC=1 npx tsx src/runtime/semantic-boundary/semantics-only-canary.mts
 * For an authenticated canary, export credentials in the process environment or
 * provide an explicit CLEM_CANARY_ENV_FILE. The canary never reads the live
 * Clementine home implicitly.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const isolated = mkdtempSync(path.join(os.tmpdir(), 'clem-semantics-canary-'));
process.env.CLEMENTINE_HOME = isolated;

const explicitEnvFile = process.env.CLEM_CANARY_ENV_FILE?.trim();
if (explicitEnvFile) {
  try {
    for (const line of readFileSync(path.resolve(explicitEnvFile), 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key] && /^(OPENAI|ANTHROPIC|XAI|AZURE|BYO_|CLEMMY_|MODEL_)/.test(key)) {
        process.env[key] = value;
      }
    }
  } catch {
    // An explicit but unreadable credential file still fails closed in the
    // configured-brain path; deterministic mode does not require credentials.
  }
}

const { createSession, resetEventLog } = await import('../harness/eventlog.js');
const { interpretAcceptedSource } = await import('./interpret-accepted-source.js');
const { buildTurnSemanticHostViewV1 } = await import('./build-semantic-host-view.js');
const { productionCapabilityManifests } = await import('../harness/production-capability-catalog.js');
const { attachSemanticContract, capabilityManifestDigest } = await import('../harness/capability-manifest.js');
const { hostDescriptorFromRegistered } = await import('./admit-and-compile-accepted-source.js');
const { configuredBrainSemanticPort, completeViaConfiguredBrain } = await import('./configured-brain-semantic-port.js');
const { catalogSnapshotDigestFromDescriptors } = await import('./plan-grounding.js');
const { entailedPlanGroundingJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const competing = attachSemanticContract({
  version: 1,
  manifestId: 'cap:host_create:calendar',
  providerKind: 'local_registry',
  operationId: 'host_create',
  providerIdentity: 'local_registry',
  providerVersion: 'host-catalog-v1',
  operationVersion: '1',
  definitionFingerprint: sha256('competing-calendar'),
  effect: 'external_write',
  destination: { family: 'scheduled_event', posture: 'create_new' },
  accountId: 'host:canary',
  idempotency: { required: true, policy: 'key_before_dispatch' },
  reconciliation: { supported: true, policy: 'exact_artifact' },
  outputContract: { kind: 'scheduled_event' },
  purpose: 'schedule_event',
  acceptedInputKinds: ['event'],
  producedOutputKinds: ['scheduled_event'],
  applicableDeliverableKinds: ['scheduled_event'],
  evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
  provenance: { issuer: 'host:canary', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
  lifecycle: { state: 'current' },
  advisoryRoles: ['destination'],
});

const descriptors = [...productionCapabilityManifests(), competing].map((manifest) => hostDescriptorFromRegistered({
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
  invoke: async () => {
    throw new Error('canary must not dispatch');
  },
})!);

resetEventLog();
createSession({ id: 'sess-semantics-canary', kind: 'chat' });
const snapshot = {
  sessionId: 'sess-semantics-canary',
  sourceUserSeq: 1,
  acceptedText: 'find five widgets and put them in a workbook',
  audienceKey: 'aud-canary',
  userId: 'user-canary',
  conversationKey: 'conv-canary',
  policyRevision: sha256('canary-policy'),
  capabilities: descriptors,
  catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(descriptors),
};
const host = buildTurnSemanticHostViewV1(snapshot);
const started = Date.now();
const result = await interpretAcceptedSource({
  snapshot,
  authority: {
    policyRevision: host.policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'external_write',
    allowedEffects: ['none', 'read', 'unknown', 'local_write', 'external_write'],
  },
  port: process.env.CLEM_CANARY_DETERMINISTIC === '1'
    ? {
        async interpret(call) {
          return {
            raw: fakeSemanticProposal('newConstruct', call.host),
            modelIdentity: 'canary/deterministic-brain',
            inputTokens: 10,
            outputTokens: 4,
            latencyMs: 5,
          };
        },
        async judgeSourceEffect(call) {
          return {
            verdict: 'entailed',
            effect: call.proposedEffect,
            destinationPosture: call.proposedDestinationPosture,
            proposalDigest: call.proposalDigest,
            modelIdentity: 'canary/deterministic-effect',
            inputTokens: 3,
            outputTokens: 1,
            latencyMs: 2,
          };
        },
        async judgePlanGrounding(call) {
          return entailedPlanGroundingJudge(call, 'canary/deterministic-grounding');
        },
      }
    : configuredBrainSemanticPort(completeViaConfiguredBrain),
  turn: 1,
});
const wallMs = Date.now() - started;
const dest = result.record.groundingVerdicts?.find((row) => row.capabilityRef.includes('destination') || row.capabilityRef.includes('calendar'));
process.stdout.write(`${JSON.stringify({
  status: result.status,
  reason: result.status === 'blocked' ? result.reason : undefined,
  home: isolated,
  providerDispatch: 0,
  modelCalls: {
    proposal: result.record.proposalCalls ?? null,
    effect: result.record.effectJudgeCalls ?? null,
    grounding: result.record.groundingJudgeCalls ?? null,
  },
  tokens: {
    input: result.record.inputTokens,
    output: result.record.outputTokens,
    proposalIn: result.record.proposalInputTokens,
    proposalOut: result.record.proposalOutputTokens,
    effectIn: result.record.judgeInputTokens,
    effectOut: result.record.judgeOutputTokens,
    groundingIn: result.record.groundingInputTokens,
    groundingOut: result.record.groundingOutputTokens,
  },
  latencyMs: result.record.latencyMs,
  wallMs,
  identities: {
    proposal: result.record.modelIdentity,
    effect: result.record.judgeIdentity ?? null,
    grounding: result.record.groundingIdentity ?? null,
  },
  grounding: {
    overall: result.record.groundingOverallVerdict ?? null,
    catalogDigest: result.record.groundingCatalogDigest ?? null,
    proposalDigest: result.record.groundingProposalDigest ?? null,
    receiptDigest: result.record.groundingReceiptDigest ?? null,
    operations: result.record.groundingVerdicts ?? null,
    destCapability: dest?.capabilityRef ?? null,
    destVerdict: dest?.verdict ?? null,
  },
  validationIssue: result.record.validationIssue ?? null,
  repairAttempted: result.record.repairAttempted,
  modelError: result.record.raw && typeof result.record.raw === 'object' && 'error' in (result.record.raw as object)
    ? (result.record.raw as { error?: unknown }).error
    : undefined,
}, null, 2)}\n`);
if (result.status !== 'admitted') process.exitCode = 2;
