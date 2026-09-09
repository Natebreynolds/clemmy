import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import { parseProviderAcknowledgementMode, selectProviderAcknowledgementMode } from './provider-acknowledgement-contract.js';

const workContractId = `expected-work:v1:${'a'.repeat(64)}`;

function fixture() {
  // Minimal frozen-contract inputs for this pure policy boundary. Provider
  // execution/settlement authority is tested separately in integration.
  const graph = {
    classification: { goalConstraints: {
      evidenceRequirements: ['tool_result'],
      destinations: [{ posture: 'create_new', handleRequired: false }],
    } },
    workTopology: { topology: { operations: [{
      id: 'draft_a', effect: 'external_write', cardinality: { kind: 'once' },
      dependsOn: [] as string[], dataFrom: [] as string[],
    }] } },
  };
  const manifest = {
    effect: 'external_write', destination: { posture: 'create_new' },
    evidenceContract: { kinds: ['tool_result'], readbackRequired: false },
  };
  return { graph, manifest };
}

function select(value: ReturnType<typeof fixture>, contract = workContractId) {
  return selectProviderAcknowledgementMode({
    graph: value.graph as unknown as TurnGraphIR,
    manifest: value.manifest as unknown as CapabilityManifestV1,
    operationId: 'draft_a', workContractId: contract,
  });
}

test('only the accepted provider-result create selects acknowledgement with its exact work contract', () => {
  const value = fixture();
  assert.deepEqual(select(value), {
    version: 1, kind: 'provider_acknowledgement_v1', workContractId,
  });
  assert.equal(select(value, 'task:unbound'), null);
  assert.equal(selectProviderAcknowledgementMode({
    graph: value.graph as unknown as TurnGraphIR,
    manifest: value.manifest as unknown as CapabilityManifestV1,
    operationId: 'another_operation', workContractId,
  }), null);
});

test('explicit accepted evidence or destination requirements cannot be lowered to acknowledgement', () => {
  for (const requirement of ['readback', 'receipt', 'artifact_handle']) {
    const value = fixture();
    value.graph.classification.goalConstraints.evidenceRequirements.push(requirement);
    assert.equal(select(value), null, requirement);
  }
  for (const posture of ['replace', 'append', 'unknown']) {
    const value = fixture();
    value.graph.classification.goalConstraints.destinations[0]!.posture = posture;
    assert.equal(select(value), null, posture);
  }
  const handle = fixture();
  handle.graph.classification.goalConstraints.destinations[0]!.handleRequired = true;
  assert.equal(select(handle), null);
  const missing = fixture();
  missing.graph.classification.goalConstraints.destinations = [];
  assert.equal(select(missing), null);
});

test('derived content, collection writes and non-provider effects retain stronger evidence paths', () => {
  const derived = fixture();
  derived.graph.workTopology.topology.operations[0]!.dataFrom = ['source_read'];
  assert.equal(select(derived), null);
  const each = fixture();
  each.graph.workTopology.topology.operations[0]!.cardinality.kind = 'each';
  assert.equal(select(each), null);
  for (const effect of ['read', 'local_write', 'admin', 'unknown']) {
    const value = fixture();
    value.graph.workTopology.topology.operations[0]!.effect = effect;
    assert.equal(select(value), null, effect);
  }
});

test('a selected adapter verification or readback contract always wins over acknowledgement', () => {
  for (const additional of [
    { operationSemantics: { atomicInputContent: { version: 1 } } },
    { externalDefinition: { verification: { version: 1 } } },
    { readbackContract: { required: true } },
    { evidenceContract: { kinds: ['tool_result'], readbackRequired: true } },
    { evidenceContract: { kinds: ['tool_result', 'receipt'], readbackRequired: false } },
    { destination: { posture: 'replace' } },
    { effect: 'local_write' },
  ]) {
    const value = fixture();
    Object.assign(value.manifest, additional);
    assert.equal(select(value), null, JSON.stringify(additional));
  }
});

test('the durable mode rejects unknown versions, additional assertions and unbound identifiers', () => {
  const mode = { version: 1, kind: 'provider_acknowledgement_v1', workContractId };
  assert.deepEqual(parseProviderAcknowledgementMode(mode), mode);
  for (const raw of [null, [], {}, { ...mode, version: 2 },
    { ...mode, kind: 'readback_verified' }, { ...mode, workContractId: 'caller-claimed' },
    { ...mode, contentVerified: true }]) {
    assert.equal(parseProviderAcknowledgementMode(raw), null);
  }
});
