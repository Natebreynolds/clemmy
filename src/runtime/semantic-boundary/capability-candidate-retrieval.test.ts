/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/capability-candidate-retrieval.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { competingCalendarManifest, productionCapabilityManifests } from '../harness/production-capability-catalog.js';
import { capabilityManifestDigest } from '../harness/capability-manifest.js';
import { hostDescriptorFromRegistered } from './admit-and-compile-accepted-source.js';
import { selectRelevantCapabilityDescriptors } from './capability-candidate-retrieval.js';
import { collectConstructWork } from './fake-semantic-model.js';
import { buildTurnSemanticHostViewV1 } from './build-semantic-host-view.js';
import { validateTurnSemanticProposalV1 } from './turn-semantic-proposal.js';

function descriptorsFromManifests() {
  const calendar = competingCalendarManifest();
  const ordered = [calendar, ...productionCapabilityManifests()];
  return ordered.map((manifest) => hostDescriptorFromRegistered({
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
}

test('retrieval keeps the persist-collection capability when a calendar writer is first', () => {
  const descriptors = descriptorsFromManifests();
  assert.equal(descriptors[0]?.id, 'cap:beta:calendar-create:v1');
  const selected = selectRelevantCapabilityDescriptors(descriptors, 5);
  const ids = selected.map((entry) => entry.id);
  assert.ok(ids.includes('cap:host_create:destination'));
  assert.ok(ids.includes('cap:host_lookup:source'));
  assert.equal(ids[0], 'cap:host_lookup:source');
  assert.notEqual(ids[0], 'cap:beta:calendar-create:v1');
});

test('shown catalog ids are exactly the retrieved descriptor ids', () => {
  const descriptors = descriptorsFromManifests();
  const selected = selectRelevantCapabilityDescriptors(descriptors, 5);
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'sess-retrieve',
    sourceUserSeq: 1,
    acceptedText: 'collect and persist the requested rows',
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
    capabilities: selected,
  });
  assert.deepEqual([...host.catalog.capabilityIds].sort(), selected.map((entry) => entry.id).sort());
  const work = collectConstructWork({
    count: 5,
    fields: ['title', 'date', 'link'],
    family: 'workbook',
    host,
  });
  assert.equal(work.operations.find((operation) => operation.role === 'destination')?.capabilityRef, 'cap:host_create:destination');
  const checked = validateTurnSemanticProposalV1({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      criteria: [{ id: 'c-set', statement: 'Bounded collection is present.' }],
      openSlots: [],
      candidates: [],
    },
    work,
    slotAnswers: [],
    rationale: 'retrieval-eval',
  }, host);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.issues.map((issue) => issue.message).join('; '));
});
