import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveExecutionDraft, PlanPreparationSchema } from './publish-plan.js';
import type { HostCapabilityDescriptorV1 } from '../runtime/semantic-boundary/turn-semantic-proposal.js';

function descriptor(id: string, posture: 'create_new' | 'named_existing', family = 'file'): HostCapabilityDescriptorV1 {
  return { id, effect: 'local_write', purpose: 'author_artifact', acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'], applicableDeliverableKinds: [family], inputShape: 'evidence',
    outputShape: 'evidence', outputKind: family, deliverableKind: family, destinationPosture: posture,
    evidenceKinds: ['local_commit_receipt'], handleRequired: true, readbackRequired: false,
    accountScope: 'test', manifestDigest: 'a'.repeat(64) };
}
function project(contracts: HostCapabilityDescriptorV1[]) {
  const outline = PlanPreparationSchema.parse({ steps: contracts.map((row, i) => ({ id: row.id,
    action: 'Write the reviewed artifact.', effect: row.effect, capabilityRef: row.id,
    staticArguments: { path: `/test/${i}`, content: 'reviewed bytes' },
    dependsOn: i ? [contracts[i - 1]!.id] : [], verification: 'Saved content matches.' })),
    successCriteria: ['All reviewed artifacts saved.'] });
  const before = JSON.stringify(outline);
  const result = deriveExecutionDraft(outline, new Map(contracts.map(row => [row.id, row])));
  assert.equal(JSON.stringify(outline), before, 'projection preserves exact reviewed arguments');
  assert.equal(result.topology.operations.length, contracts.length);
  return result;
}

test('mixed creation and append steps do not inherit the first write destination', () => {
  const draft = project([descriptor('create', 'create_new'), descriptor('append', 'named_existing')]);
  assert.equal(draft.destination, null);
  assert.deepEqual(draft.topology.operations[1]!.dependsOn, ['create']);
});
test('independent artifact families do not inherit the first write destination', () => {
  assert.equal(project([descriptor('file', 'create_new'), descriptor('sheet', 'create_new', 'workbook')]).destination, null);
});
test('a shared destination posture is retained when every target contract agrees', () => {
  assert.deepEqual(project([descriptor('one', 'named_existing'), descriptor('two', 'named_existing')]).destination,
    { posture: 'named_existing', family: 'file', handleRequired: true });
});
