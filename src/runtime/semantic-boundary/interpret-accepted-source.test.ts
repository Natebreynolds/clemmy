/** Run: npx tsx --test src/runtime/semantic-boundary/interpret-accepted-source.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const HOME = '/tmp/clem-semantic-interpret-test';
process.env.CLEMENTINE_HOME = HOME;

const { appendEvent, createSession, openEventLog, resetEventLog } = await import('../harness/eventlog.js');
const { interpretAcceptedSource, readClaimLinkedSemanticInterpretation } = await import('./interpret-accepted-source.js');
const { entailedPlanGroundingJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');
const { buildTurnSemanticHostViewV1 } = await import('./build-semantic-host-view.js');
const { productionCapabilityManifests } = await import('../harness/production-capability-catalog.js');
const { capabilityManifestDigest } = await import('../harness/capability-manifest.js');
const { hostDescriptorFromRegistered } = await import('./admit-and-compile-accepted-source.js');
const { catalogSnapshotDigestFromDescriptors } = await import('./plan-grounding.js');
import type { TurnSemanticModelPort } from './turn-semantic-model-port.js';
import type { HostSemanticAuthorityV1 } from './admit-turn-semantics.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function authority(host: { policyRevision: string; source: { audienceHash: string } }): HostSemanticAuthorityV1 {
  return {
    policyRevision: host.policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'external_write',
    allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
  };
}

const AUDIENCE = {
  audienceKey: 'aud-1',
  userId: 'user-1',
  conversationKey: 'conv-1',
} as const;

function productionDescriptors() {
  return productionCapabilityManifests().map((manifest) => {
    const digest = capabilityManifestDigest(manifest);
    return hostDescriptorFromRegistered({
      capabilityId: manifest.manifestId,
      toolName: manifest.operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      destination: manifest.destination,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: digest,
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => ({}),
    })!;
  });
}

function constructCatalog() {
  const capabilities = productionDescriptors();
  return {
    capabilities,
    catalogSnapshotDigest: catalogSnapshotDigestFromDescriptors(capabilities),
  };
}

function fakePort(calls: unknown[]): TurnSemanticModelPort {
  return {
    async interpret(call) {
      calls.push(call.purpose);
      const host = call.host;
      return {
        raw: fakeSemanticProposal('newConstruct', host),
        modelIdentity: 'fake-semantic/test',
        inputTokens: 12,
        outputTokens: 34,
        latencyMs: 5,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'fake-semantic/judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedPlanGroundingJudge(call, 'fake-semantic/grounding');
    },
  };
}

test('one semantic call per source and exact replay reuses it', async () => {
  resetEventLog();
  const sessionId = 'sess-semantic-1';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const calls: unknown[] = [];
  const first = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: fakePort(calls),
    turn: 1,
  });
  const second = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: fakePort(calls),
    turn: 1,
  });
  assert.equal(first.status, 'admitted');
  assert.equal(second.status, 'admitted');
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 1);
  if (first.status === 'admitted' && second.status === 'admitted') {
    assert.equal(first.record.payloadHash, second.record.payloadHash);
    assert.equal(first.record.purpose, 'turn_semantics');
    assert.equal(first.record.modelIdentity, 'fake-semantic/test');
  }
});

test('model failure keeps an open question instead of regex fallback', async () => {
  resetEventLog();
  const sessionId = 'sess-semantic-2';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 2,
    acceptedText: 'maybe',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    resumableGoals: [{ goalId: 'goal-17', baseRevision: 4 }],
    openQuestions: [{
      questionId: 'question-3',
      goalId: 'goal-17',
      goalRevision: 4,
      slotKey: 'resource-choice',
      question: 'Which host should I use?',
      options: [{ optionId: 'choice-a', label: 'Acme.io' }],
      allowFreeText: false,
    }],
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const failing: TurnSemanticModelPort = {
    async interpret() {
      throw new Error('model down');
    },
  };
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: failing,
    turn: 1,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.record.validationOutcome, 'model_failed');
});

test('concurrent interpretation produces one model call', async () => {
  resetEventLog();
  const sessionId = 'sess-semantic-3';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 3,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const calls: unknown[] = [];
  const port = fakePort(calls);
  const [a, b] = await Promise.all([
    interpretAcceptedSource({ snapshot, authority: authority(host), port, turn: 1 }),
    interpretAcceptedSource({ snapshot, authority: authority(host), port, turn: 1 }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(a.status, 'admitted');
  assert.equal(b.status, 'admitted');
});

test('replay fail-closes unless the complete persisted judge binding is exact', async () => {
  const cases = [
    {
      name: 'source write decision',
      mutate(identity: string, result: {
        verdict: 'entailed' | 'conflict' | 'uncertain';
        effect: string;
        destinationPosture: 'create_new' | 'named_existing' | null;
        proposalDigest: string;
      }) {
        const changed = { ...result, verdict: 'conflict' as const };
        return { identity, result: changed, digest: judgeDigest(identity, changed) };
      },
    },
    {
      name: 'effect',
      mutate(identity: string, result: {
        verdict: 'entailed' | 'conflict' | 'uncertain';
        effect: string;
        destinationPosture: 'create_new' | 'named_existing' | null;
        proposalDigest: string;
      }) {
        const changed = { ...result, effect: 'local_write' };
        return { identity, result: changed, digest: judgeDigest(identity, changed) };
      },
    },
    {
      name: 'destination',
      mutate(identity: string, result: {
        verdict: 'entailed' | 'conflict' | 'uncertain';
        effect: string;
        destinationPosture: 'create_new' | 'named_existing' | null;
        proposalDigest: string;
      }) {
        const changed = {
          ...result,
          destinationPosture: 'named_existing' as const,
        };
        return { identity, result: changed, digest: judgeDigest(identity, changed) };
      },
    },
    {
      name: 'digest',
      mutate(identity: string, result: {
        verdict: 'entailed' | 'conflict' | 'uncertain';
        effect: string;
        destinationPosture: 'create_new' | 'named_existing' | null;
        proposalDigest: string;
      }) {
        return { identity, result, digest: '0'.repeat(64) };
      },
    },
    {
      name: 'identity',
      mutate(_identity: string, result: {
        verdict: 'entailed' | 'conflict' | 'uncertain';
        effect: string;
        destinationPosture: 'create_new' | 'named_existing' | null;
        proposalDigest: string;
      }) {
        return { identity: 'forged-judge', result, digest: '0'.repeat(64) };
      },
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    resetEventLog();
    const sessionId = `sess-judge-replay-${index}`;
    createSession({ id: sessionId, kind: 'chat' });
    const snapshot = {
      sessionId,
      sourceUserSeq: 1,
      acceptedText: 'find five widgets and put them in a workbook',
      policyRevision: sha256('policy'),
      ...AUDIENCE,
      ...constructCatalog(),
    };
    const host = buildTurnSemanticHostViewV1(snapshot);
    const calls: unknown[] = [];
    const first = await interpretAcceptedSource({
      snapshot,
      authority: authority(host),
      port: fakePort(calls),
      turn: 1,
    });
    assert.equal(first.status, 'admitted', scenario.name);
    if (first.status !== 'admitted') continue;
    assert.ok(first.record.judgeIdentity, scenario.name);
    assert.ok(first.record.judgeResult, scenario.name);
    const mutation = scenario.mutate(first.record.judgeIdentity!, first.record.judgeResult!);
    const linked = readClaimLinkedSemanticInterpretation(sessionId, 1);
    assert.ok(linked, scenario.name);
    openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...first.record,
        judgeIdentity: mutation.identity,
        judgeResult: mutation.result,
        judgeDigest: mutation.digest,
      }),
      linked!.eventId,
    );
    const replay = await interpretAcceptedSource({
      snapshot,
      authority: authority(host),
      port: fakePort(calls),
      turn: 1,
    });
    assert.equal(replay.status, 'blocked', scenario.name);
    assert.equal(replay.replayed, true, scenario.name);
    assert.equal(calls.length, 1, scenario.name);
  }
});

test('unclaimed forged admitted event cannot be replayed', async () => {
  resetEventLog();
  const sessionId = 'sess-unclaimed-forge';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'turn_semantics_interpreted',
    data: {
      purpose: 'turn_semantics',
      sourceUserSeq: 1,
      inputHash: host.source.inputHash,
      audienceHash: host.source.audienceHash,
      policyRevision: host.policyRevision,
      payloadHash: 'a'.repeat(64),
      contextHash: 'b'.repeat(64),
      modelIdentity: 'forged',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      validationOutcome: 'admitted',
      repairAttempted: false,
      raw: fakeSemanticProposal('newConstruct', host),
    },
  });
  assert.equal(readClaimLinkedSemanticInterpretation(sessionId, 1), null);
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: { async interpret() { throw new Error('must not treat the forged event as claimed'); } },
    turn: 1,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.record.validationOutcome, 'model_failed');
});

test('later unlinked interpretation is ignored on replay', async () => {
  resetEventLog();
  const sessionId = 'sess-unlinked-later';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const calls: unknown[] = [];
  const first = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: fakePort(calls),
    turn: 1,
  });
  assert.equal(first.status, 'admitted');
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'turn_semantics_interpreted',
    data: {
      ...first.record,
      validationOutcome: 'invalid',
      judgeResult: { verdict: 'conflict', effect: 'none', destinationPosture: null, proposalDigest: '0'.repeat(64) },
    },
  });
  const replay = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: fakePort(calls),
    turn: 1,
  });
  assert.equal(replay.status, 'admitted');
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
});

test('wrong claim hash cannot replay the linked interpretation', async () => {
  resetEventLog();
  const sessionId = 'sess-wrong-claim-hash';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const first = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: fakePort([]),
    turn: 1,
  });
  assert.equal(first.status, 'admitted');
  openEventLog().prepare(
    `UPDATE turn_semantics_claims SET input_hash = ? WHERE session_id = ? AND source_user_seq = ?`,
  ).run('f'.repeat(64), sessionId, 1);
  assert.equal(readClaimLinkedSemanticInterpretation(sessionId, 1), null);
  const replay = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: { async interpret() { throw new Error('hash mismatch must not interpret again as admitted'); } },
    turn: 1,
  });
  assert.equal(replay.status, 'blocked');
});

test('one bounded repair admits after a destination posture mismatch', async () => {
  resetEventLog();
  const sessionId = 'sess-repair-admit';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  let interprets = 0;
  let judges = 0;
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        interprets += 1;
        const raw = fakeSemanticProposal('newConstruct', call.host);
        if (interprets === 1 && raw.work?.destination) {
          return {
            raw: {
              ...raw,
              work: {
                ...raw.work,
                destination: { ...raw.work.destination, posture: 'named_existing' },
              },
            },
            modelIdentity: 'repair-brain',
            inputTokens: 100,
            outputTokens: 40,
            latencyMs: 2,
          };
        }
        return {
          raw,
          modelIdentity: 'repair-brain',
          inputTokens: 80,
          outputTokens: 30,
          latencyMs: 2,
        };
      },
      async judgeSourceEffect(call) {
        judges += 1;
        if (call.proposedDestinationPosture !== 'create_new') {
          return {
            verdict: 'conflict',
            effect: call.proposedEffect,
            destinationPosture: 'create_new',
            proposalDigest: call.proposalDigest,
            modelIdentity: 'repair-judge',
            inputTokens: 20,
            outputTokens: 5,
            latencyMs: 1,
          };
        }
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'repair-judge',
          inputTokens: 21,
          outputTokens: 6,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return entailedPlanGroundingJudge(call, 'repair-grounding');
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'admitted');
  assert.equal(interprets, 2);
  assert.equal(judges, 2);
  assert.equal(result.record.repairAttempted, true);
  assert.equal(result.record.inputTokens, 222);
  assert.equal(result.record.outputTokens, 82);
});

test('unresolved mismatch stays blocked after one repair and records tokens', async () => {
  resetEventLog();
  const sessionId = 'sess-repair-blocked';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  let interprets = 0;
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        interprets += 1;
        return {
          raw: fakeSemanticProposal('newConstruct', call.host),
          modelIdentity: 'blocked-brain',
          inputTokens: 50,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return entailedPlanGroundingJudge(call, 'blocked-grounding');
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'conflict',
          effect: 'read',
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'blocked-judge',
          inputTokens: 12,
          outputTokens: 3,
          latencyMs: 1,
        };
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(interprets, 2);
  assert.equal(result.record.repairAttempted, true);
  assert.equal(result.record.validationOutcome, 'invalid');
  assert.equal(result.record.inputTokens, 124);
  assert.equal(result.record.outputTokens, 26);
});

test('whole-plan grounding is one call and persists an operation-keyed receipt', async () => {
  resetEventLog();
  const sessionId = 'sess-plan-ground';
  createSession({ id: sessionId, kind: 'chat' });
  const descriptors = productionDescriptors();
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    capabilities: descriptors,
    catalogSnapshotDigest: sha256('catalog-1'),
    ...AUDIENCE,
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  let groundingCalls = 0;
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        return {
          raw: fakeSemanticProposal('newConstruct', call.host),
          modelIdentity: 'plan-brain',
          inputTokens: 10,
          outputTokens: 4,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'plan-effect',
          inputTokens: 2,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        groundingCalls += 1;
        return entailedPlanGroundingJudge(call, 'plan-grounding');
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'admitted');
  assert.equal(groundingCalls, 1);
  assert.equal(result.record.groundingJudgeCalls, 1);
  assert.equal(result.record.proposalCalls, 1);
  assert.equal(result.record.effectJudgeCalls, 1);
  assert.equal(result.record.groundingOverallVerdict, 'entailed');
  assert.ok((result.record.groundingVerdicts ?? []).length >= 4);
  assert.ok(result.record.groundingReceiptDigest);
  const replay = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret() { throw new Error('should not re-call'); },
      async judgePlanGrounding() { throw new Error('should not re-judge'); },
    },
    turn: 1,
  });
  assert.equal(replay.status, 'admitted');
  assert.equal(replay.replayed, true);
});

test('tampered grounding receipt blocks replay', async () => {
  resetEventLog();
  const sessionId = 'sess-ground-tamper';
  createSession({ id: sessionId, kind: 'chat' });
  const descriptors = productionDescriptors();
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    capabilities: descriptors,
    catalogSnapshotDigest: sha256('catalog-1'),
    ...AUDIENCE,
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const first = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        return {
          raw: fakeSemanticProposal('newConstruct', call.host),
          modelIdentity: 'tamper-brain',
          inputTokens: 4,
          outputTokens: 2,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'tamper-effect',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return entailedPlanGroundingJudge(call, 'tamper-grounding');
      },
    },
    turn: 1,
  });
  assert.equal(first.status, 'admitted');
  const event = readClaimLinkedSemanticInterpretation(sessionId, 1);
  assert.ok(event);
  const row = openEventLog().prepare('SELECT data_json FROM events WHERE id = ?').get(event.eventId) as { data_json: string };
  const data = JSON.parse(row.data_json) as { groundingVerdicts: Array<{ verdict: string }> };
  data.groundingVerdicts[0]!.verdict = 'conflict';
  openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), event.eventId);
  const replay = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret() { throw new Error('no interpret'); },
    },
    turn: 1,
  });
  assert.equal(replay.status, 'blocked');
});

test('wrong source capability is not grounded', async () => {
  resetEventLog();
  const sessionId = 'sess-wrong-source';
  createSession({ id: sessionId, kind: 'chat' });
  const descriptors = productionDescriptors();
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    capabilities: descriptors,
    catalogSnapshotDigest: sha256('catalog-1'),
    ...AUDIENCE,
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        const raw = fakeSemanticProposal('newConstruct', call.host);
        return {
          raw: {
            ...raw,
            work: raw.work && {
              ...raw.work,
              operations: raw.work.operations.map((operation) => (
                operation.role === 'source'
                  ? { ...operation, capabilityRef: 'cap:host_lookup:collection' }
                  : operation
              )),
            },
          },
          modelIdentity: 'wrong-source',
          inputTokens: 4,
          outputTokens: 2,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'wrong-source-effect',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return {
          verdict: 'conflict',
          operations: call.dag.operations.map((operation) => ({
            operationId: operation.id,
            verdict: operation.role === 'source' ? 'conflict' : 'entailed',
            rationale: operation.role === 'source' ? 'source role is not a destination writer' : '',
          })),
          modelIdentity: 'wrong-source-grounding',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'blocked');
  assert.ok(
    result.record.validationIssue?.operationId === 'op-source'
    || result.record.validationIssue?.code === 'dag_kind_mismatch'
    || result.record.validationIssue?.code === 'capability_not_grounded',
    JSON.stringify(result.record.validationIssue),
  );
});

test('malformed grounding retries the judge, not the proposer', async () => {
  resetEventLog();
  const sessionId = 'sess-ground-retry';
  createSession({ id: sessionId, kind: 'chat' });
  const descriptors = productionDescriptors();
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    capabilities: descriptors,
    catalogSnapshotDigest: sha256('catalog-1'),
    ...AUDIENCE,
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  let interprets = 0;
  let groundings = 0;
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        interprets += 1;
        return {
          raw: fakeSemanticProposal('newConstruct', call.host),
          modelIdentity: 'retry-brain',
          inputTokens: 4,
          outputTokens: 2,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'retry-effect',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        groundings += 1;
        if (groundings === 1) return { verdict: 'entailed', operations: [], modelIdentity: 'retry-grounding', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
        return entailedPlanGroundingJudge(call, 'retry-grounding');
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'admitted');
  assert.equal(interprets, 1);
  assert.equal(groundings, 2);
});

function judgeDigest(
  judgeIdentity: string,
  judgeResult: {
    verdict: 'entailed' | 'conflict' | 'uncertain';
    effect: string;
    destinationPosture: 'create_new' | 'named_existing' | null;
    proposalDigest: string;
  },
): string {
  return sha256(JSON.stringify({
    judgeIdentity,
    verdict: judgeResult.verdict,
    effect: judgeResult.effect,
    destinationPosture: judgeResult.destinationPosture,
    proposalDigest: judgeResult.proposalDigest,
  }));
}

// ─── Any validation failure earns its one repair ─────────────────────────────
//
// The repair condition used to be an allowlist of eight blessed codes, and it
// did not match what actually fails. Measured on the production home: of 14
// planner validation failures, 10 carried codes the list did not name —
// dag_kind_mismatch, capability_grounding_conflict (the list said
// capability_grounding_FAILED), illegal_relation_payload, write_not_aligned,
// effect_exceeds_ceiling, capability_ref_effect_mismatch. Each ended its run
// with "I could not finish planning that… you can restate it", addressed to the
// USER, for a structural mistake the MODEL had just been told about precisely
// and was never shown. Six scheduled workflows died this way.
test('a structurally invalid proposal is repaired once, whatever the issue code', async () => {
  resetEventLog();
  const sessionId = 'sess-repair-any-code';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  let interprets = 0;
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        interprets += 1;
        const raw = fakeSemanticProposal('newConstruct', call.host);
        // A structural violation that is NOT a grounding/capability code: name
        // a relation payload the schema does not permit. The old allowlist had
        // no entry for this shape, so the run died instead of being repaired.
        if (interprets === 1) {
          return {
            raw: { ...raw, work: { ...raw.work, relations: [{ bogus: true }] } as never },
            modelIdentity: 'any-code-brain',
            inputTokens: 10,
            outputTokens: 4,
            latencyMs: 1,
          };
        }
        return {
          raw,
          modelIdentity: 'any-code-brain',
          inputTokens: 10,
          outputTokens: 4,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return entailedPlanGroundingJudge(call, 'any-code-grounding');
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: 'local_write',
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'any-code-judge',
          inputTokens: 6,
          outputTokens: 2,
          latencyMs: 1,
        };
      },
    },
    turn: 1,
  });
  assert.equal(
    result.record.repairAttempted,
    true,
    'the model must get its one correction regardless of which code the validator produced',
  );
  assert.equal(interprets, 2, 'exactly one repair, still bounded');
});

// ─── A blocked message must never contradict its own durable record ──────────
//
// Observed live 2026-08-25 (run 1787632002319-9538bf, step "research"): the
// planner failed once, REPAIRED successfully — validationOutcome=admitted — and
// the turn then blocked downstream (graph persist refused). The presentation
// keyed on repairAttempted alone and told the user the plan "did not pass my
// own structural check either time". The plan had passed.
test('an admitted record never renders as a failed structural check', async () => {
  const { blockedPresentationForSemanticRecord } = await import('./interpret-accepted-source.js');
  const admitted = blockedPresentationForSemanticRecord({
    validationOutcome: 'admitted',
    repairAttempted: true,
  } as never);
  assert.doesNotMatch(admitted, /did not pass/i, 'the plan passed; do not say it failed');
  assert.match(admitted, /fault on my side/i, 'own the internal failure plainly');
  assert.match(admitted, /nothing ran and nothing changed/i);

  const invalid = blockedPresentationForSemanticRecord({
    validationOutcome: 'invalid',
    repairAttempted: true,
  } as never);
  assert.match(invalid, /did not pass my own structural check either time/i);
});

// ─── Anti-laundering repair hint (live 2026-08-25) ───────────────────────────
//
// Three workflow steps died citing a disclosed foreign capability whose effect
// could not match — because NO disclosed descriptor carried the operation's
// requested effect at all. The bounded repair re-cited from the same menu and
// died identically. The hint now states the measured fact (the menu cannot
// satisfy this effect) and the admissible expression (host-native effects),
// and deliberately never enumerates near-miss refs or alternative effects —
// a listing hint coaches effect-flipping until something validates, which
// launders a foreign operation through admission instead of repairing it.
test('repair hint for an unsatisfiable effect states host-native guidance and lists no other capability', async () => {
  resetEventLog();
  const sessionId = 'sess-hostnative-hint';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'collect five widgets and store them locally',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const hints: string[] = [];
  let citedRef = '';
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        if (call.repairHint) hints.push(call.repairHint);
        const proposal = fakeSemanticProposal('newConstruct', call.host);
        // The live shape: keep the honest citation, declare an effect the
        // disclosed catalog cannot satisfy (no local_write descriptor exists).
        const ops = proposal.work!.operations;
        citedRef = ops[0]!.capabilityRef;
        ops[0] = { ...ops[0]!, requestedEffect: 'local_write' };
        return {
          raw: proposal,
          modelIdentity: 'hint-brain',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'hint-judge',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return entailedPlanGroundingJudge(call, 'hint-grounding');
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'blocked', 'the same broken proposal twice must stay blocked');
  assert.equal(hints.length, 1, 'exactly one bounded repair with a hint');
  const hint = JSON.parse(hints[0]!) as { hostNative?: { reason?: string; require?: string } | null };
  assert.equal(hint.hostNative?.reason, 'no_disclosed_capability_carries_requested_effect');
  assert.ok(hint.hostNative?.require?.includes('host_only'), 'the admissible expression is named');
  // No capability id other than the one the model itself cited may appear —
  // near-miss enumeration is the laundering vector.
  for (const descriptor of host.catalog.capabilities ?? []) {
    if (descriptor.id === citedRef) continue;
    assert.ok(!hints[0]!.includes(descriptor.id), `hint leaked an uncited capability id: ${descriptor.id}`);
  }
});

test('repair hint for a grounding conflict names the host-native expression and lists no other capability', async () => {
  resetEventLog();
  const sessionId = 'sess-grounding-hint';
  createSession({ id: sessionId, kind: 'chat' });
  const snapshot = {
    sessionId,
    sourceUserSeq: 1,
    acceptedText: 'collect five widgets and store them in a workbook',
    policyRevision: sha256('policy'),
    ...AUDIENCE,
    ...constructCatalog(),
  };
  const host = buildTurnSemanticHostViewV1(snapshot);
  const hints: string[] = [];
  const result = await interpretAcceptedSource({
    snapshot,
    authority: authority(host),
    port: {
      async interpret(call) {
        if (call.repairHint) hints.push(call.repairHint);
        return {
          raw: fakeSemanticProposal('newConstruct', call.host),
          modelIdentity: 'grounding-hint-brain',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed',
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'grounding-hint-judge',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        // The live shape: an honestly-cited, effect-matching capability that
        // does not SERVE the operation (Apify queue lock cited for a host
        // task/goal/memory context read).
        const operations = call.dag.operations.map((operation, index) => ({
          operationId: operation.id,
          verdict: index === 0 ? ('conflict' as const) : ('entailed' as const),
          rationale: index === 0 ? 'The assigned capability is a queue lock endpoint, not context retrieval.' : '',
        }));
        return {
          verdict: 'conflict',
          operations,
          modelIdentity: 'grounding-hint-grounding',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    },
    turn: 1,
  });
  assert.equal(result.status, 'blocked', 'the unchanged proposal stays blocked after the bounded repair');
  assert.equal(hints.length, 1, 'exactly one bounded repair with a hint');
  const hint = JSON.parse(hints[0]!) as { hostNative?: { reason?: string; require?: string } | null };
  assert.equal(hint.hostNative?.reason, 'cited_capability_rejected_for_operation');
  assert.ok(hint.hostNative?.require?.includes('host_only'), 'the admissible expression is named');
  const cited = new Set(
    (fakeSemanticProposal('newConstruct', host).work?.operations ?? []).map((operation) => operation.capabilityRef),
  );
  for (const descriptor of host.catalog.capabilities ?? []) {
    if (cited.has(descriptor.id)) continue;
    assert.ok(!hints[0]!.includes(descriptor.id), `hint leaked an uncited capability id: ${descriptor.id}`);
  }
});

// ─── The act-directly shape is a host-only sketch (live 2026-08-25) ──────────
//
// Unified-lane morning-briefing: Sonnet's ADMITTED proposal declared
// collect_then_construct with requestedEffect host_only and ZERO operations —
// nothing typed to bind. The sketch detector demanded at least one operation,
// so dispatch fell through to the unknown-ceiling wall and the run blocked
// after a successful plan. Zero-op host-native work (or absent work) is the
// model loop's job; a zero-op WRITE declaration keeps the fail-closed wall.
test('a zero-operation host-native plan is a host-only sketch; a zero-op write is not', async () => {
  const { isHostOnlySketchProposal } = await import('./interpret-accepted-source.js');
  const raw = (work: unknown) => ({ version: 1, relation: 'new_goal', goal: { objective: 'briefing' }, work });
  assert.equal(isHostOnlySketchProposal(raw(null)), true, 'work null — the act-directly shape');
  assert.equal(isHostOnlySketchProposal(raw({ requestedEffect: 'host_only', operations: [] })), true, 'zero-op host_only');
  assert.equal(isHostOnlySketchProposal(raw({ requestedEffect: 'compute', operations: [] })), true, 'zero-op compute');
  assert.equal(isHostOnlySketchProposal(raw({ requestedEffect: 'external_write', operations: [] })), false, 'zero-op write keeps the wall');
  assert.equal(isHostOnlySketchProposal(raw({ requestedEffect: 'host_only', operations: [{ requestedEffect: 'read' }] })), false, 'a foreign-read op is not a host-only sketch');
});
