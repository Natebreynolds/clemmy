import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-role-scale-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const {
  REQUEST_SEMANTIC_SEGMENT_LIMIT,
  requestSemanticSegments,
} = await import('../../assistant/request-segments.js');
const { WORK_TOPOLOGY_MAX_OPERATIONS } = await import('../graph/work-topology.js');
const candidates = await import('../read-path/capability-candidates.js');
const eventlog = await import('./eventlog.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { DiscoveryGovernor } = await import('./discovery-governor.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function acceptedRequest(requirementCount: number): string {
  return Array.from(
    { length: requirementCount },
    (_, index) => `execute requirement ${String(index).padStart(2, '0')}`,
  ).join('; ');
}

function expectedRoleKeys(requirementCount: number): string[] {
  return Array.from(
    { length: requirementCount },
    (_, index) => `clause-${index}:unknown`,
  );
}

test('semantic requirement capacity stays aligned with the accepted plan topology', () => {
  assert.equal(REQUEST_SEMANTIC_SEGMENT_LIMIT, WORK_TOPOLOGY_MAX_OPERATIONS);
  assert.equal(
    requestSemanticSegments(acceptedRequest(33), { limit: 10_000 }).length,
    WORK_TOPOLOGY_MAX_OPERATIONS,
    'caller input cannot widen the deterministic accepted-work ceiling',
  );
});

for (const requirementCount of [8, 9, 32] as const) {
  test(`${requirementCount} accepted operations retain one stable discovery role through rebuild and restart`, async () => {
    const request = acceptedRequest(requirementCount);
    const roleKeys = expectedRoleKeys(requirementCount);

    assert.deepEqual(
      requestSemanticSegments(request),
      Array.from(
        { length: requirementCount },
        (_, index) => `execute requirement ${String(index).padStart(2, '0')}`,
      ),
      'accepted segmentation must preserve every plan-sized operation in source order',
    );

    const firstProjection = await candidates.resolveTurnCapabilityCandidates({
      userInput: request,
      semantic: false,
      choices: [],
    });
    assert.equal(firstProjection.roleScopedDiscovery, true);
    assert.deepEqual(
      firstProjection.requirements.map((requirement) => requirement.roleKey),
      roleKeys,
      'the agent-facing candidate surface must retain one runtime-owned key per operation',
    );
    assert.ok(firstProjection.requirements.every((requirement) => !requirement.resolved));
    assert.deepEqual(firstProjection.candidates, [], 'roles do not grant an unproven provider candidate');
    assert.deepEqual(firstProjection.pinnedTools, [], 'roles do not widen executable tool authority');

    const card = candidates.renderCapabilityCandidateCard(firstProjection);
    assert.equal(card, candidates.renderCapabilityCandidateCard(firstProjection), 'prompt projection is deterministic');
    assert.ok(Buffer.byteLength(card, 'utf8') <= 16 * 1024, 'the complete 32-role card stays bounded');
    for (const roleKey of roleKeys) {
      assert.equal(
        card.split(`\`${roleKey}\``).length - 1,
        1,
        `${roleKey} must appear exactly once in the bounded agent prompt`,
      );
    }

    const session = eventlog.createSession({
      id: `discovery-role-scale-${requirementCount}`,
      kind: 'chat',
    });
    const source = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: request },
    });
    assert.ok(recordTurnGraphShadow({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
    }));

    const governor = new DiscoveryGovernor();
    governor.initializeTask({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      knownCapability: false,
    });
    const initialized = governor.initializeRoles({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      brokerCoverage: 'authorized_external_v1',
      requirements: firstProjection.requirements,
    });
    assert.equal(initialized.policy.roleScoped, true, 'a complete projection must not fall back to unscoped discovery');
    assert.equal(initialized.policy.roleCount, requirementCount);
    assert.equal(initialized.policy.unresolvedRoleCount, requirementCount);
    assert.deepEqual(initialized.roles.map((role) => role.roleKey), roleKeys);
    for (const [index, roleKey] of roleKeys.entries()) {
      const admitted = governor.admit({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        category: 'broad_discovery',
        subject: roleKey,
        callId: `role-scale-${requirementCount}-${index}`,
      });
      assert.equal(admitted.admitted, true, `${roleKey}: ${admitted.reason}`);
      assert.equal(admitted.subject, roleKey, 'exact membership must not collapse into unscoped provider authority');
    }

    const rebuiltProjection = await candidates.resolveTurnCapabilityCandidates({
      userInput: request,
      semantic: false,
      choices: [],
    });
    assert.deepEqual(
      rebuiltProjection.requirements.map((requirement) => requirement.roleKey),
      roleKeys,
      'a fallover rebuild must derive the same accepted role membership',
    );
    assert.equal(governor.initializeRoles({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      brokerCoverage: 'authorized_external_v1',
      requirements: rebuiltProjection.requirements,
    }).status, 'existing');

    eventlog.closeEventLog();
    const restarted = new DiscoveryGovernor();
    const state = restarted.getTaskState({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.equal(state?.policy.roleScoped, true);
    assert.equal(state?.policy.roleCount, requirementCount);
    assert.deepEqual(state?.roles.map((role) => role.roleKey), roleKeys);
  });
}
