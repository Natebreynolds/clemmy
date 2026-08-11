import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalWriteEvidenceDigest,
  evaluateWriteEvidence,
  freezeWriteEvidenceBinding,
  type FrozenWriteEvidenceBindingV1,
  type WriteEvidenceInput,
  type WriteEvidenceManifestScopeV1,
  type WriteEvidenceObligation,
  type WriteEvidenceVerdict,
} from './write-evidence-kernel.js';

const TASK = {
  sessionId: 'session-1',
  sourceUserSeq: 7,
  acceptedTaskId: 'session-1#7',
};

const TARGET = canonicalWriteEvidenceDigest({ destination: 'target-1' });
const WRITE_INPUT = {
  destination: {
    records: [
      { opaque_key: 'row-1', opaque_value: 'alpha' },
      { opaque_key: 'row-2', opaque_value: 'beta' },
    ],
  },
};

function rawResult(
  logicalToolCallId: string,
  physicalDispatchId: string,
  resultHandleId: string,
  payload: unknown,
) {
  const rawPayloadJson = JSON.stringify(payload);
  return {
    ...TASK,
    logicalToolCallId,
    physicalDispatchId,
    resultHandleId,
    rawPayloadJson,
    rawPayloadSha256: canonicalWriteEvidenceDigest.raw(rawPayloadJson),
    rawByteCount: Buffer.byteLength(rawPayloadJson, 'utf8'),
  };
}

function settlement(
  logicalToolCallId: string,
  physicalDispatchId: string,
  resultHandleId: string,
) {
  return {
    ...TASK,
    logicalToolCallId,
    argumentDigest: 'a'.repeat(64),
    executionKind: 'provider_execution' as const,
    outcomeKind: 'succeeded' as const,
    resultHandleId,
    crossings: [{
      physicalDispatchId,
      ordinal: 1,
      state: 'returned' as const,
    }],
  };
}

function reversibleBinding(
  options: {
    observedCoverage?: 'selected_records' | 'exact_destination';
    verification?: FrozenWriteEvidenceBindingV1['verification'];
    sourceRequirementIds?: string[];
  } = {},
): FrozenWriteEvidenceBindingV1 {
  const sourceRequirementIds = options.sourceRequirementIds ?? [];
  return freezeWriteEvidenceBinding({
    protocolVersion: 1,
    ...TASK,
    workContractId: 'work-contract-1',
    requirementId: 'write-records',
    logicalToolCallId: 'write-call',
    effect: 'external_write',
    reversibility: 'reversible',
    targetDigest: TARGET,
    argumentDigest: 'a'.repeat(64),
    writeInputDigest: canonicalWriteEvidenceDigest(WRITE_INPUT),
    schemaDigest: canonicalWriteEvidenceDigest({ type: 'object' }),
    targetSelectorDigest: canonicalWriteEvidenceDigest(['/destination']),
    sourceRequirementIds,
    verification: options.verification ?? {
      kind: 'reversible_exact_v1',
      observedCoverage: options.observedCoverage ?? 'exact_destination',
      expected: {
        shape: 'set',
        recordsPointer: '/destination/records',
        identityField: 'identity',
        fields: [
          { id: 'identity', valuePointer: '/opaque_key' },
          { id: 'content', valuePointer: '/opaque_value' },
        ],
      },
      observed: {
        shape: 'set',
        recordsPointer: '/data/arbitrary_records',
        identityField: 'identity',
        fields: [
          { id: 'identity', valuePointer: '/different_key' },
          { id: 'content', valuePointer: '/different_value' },
        ],
      },
    },
  });
}

function irreversibleBinding(
  receiptPointer = '/data/provider_artifact/token',
): FrozenWriteEvidenceBindingV1 {
  return freezeWriteEvidenceBinding({
    protocolVersion: 1,
    ...TASK,
    workContractId: 'work-contract-1',
    requirementId: 'send-one',
    logicalToolCallId: 'write-call',
    effect: 'external_write',
    reversibility: 'irreversible',
    targetDigest: TARGET,
    argumentDigest: 'a'.repeat(64),
    writeInputDigest: canonicalWriteEvidenceDigest(WRITE_INPUT),
    schemaDigest: canonicalWriteEvidenceDigest({ type: 'object' }),
    targetSelectorDigest: canonicalWriteEvidenceDigest(['/destination']),
    sourceRequirementIds: [],
    verification: { kind: 'irreversible_receipt_v1', receiptPointer },
  });
}

function reversibleScope(
  sourceRequirementIds: readonly string[] = [],
  obligations?: WriteEvidenceObligation[],
): WriteEvidenceManifestScopeV1 {
  return {
    manifestId: 'manifest-1',
    nodeId: 'node-write',
    obligations: obligations ?? [
      ...(sourceRequirementIds.length > 0
        ? ['derivation_from_current_source' as const]
        : []),
      'commit_effect',
      'verify_committed_readback',
      'stale_destination_reconciled',
      'execution_terminal',
    ],
  };
}

function irreversibleScope(): WriteEvidenceManifestScopeV1 {
  return {
    manifestId: 'manifest-1',
    nodeId: 'node-send',
    obligations: ['commit_effect', 'verify_committed_receipt', 'execution_terminal'],
  };
}

function committedLedger(
  overrides: Partial<WriteEvidenceInput['writeLifecycle'][number]> = {},
): WriteEvidenceInput['writeLifecycle'] {
  const reservation = {
    kind: 'reservation' as const,
    eventId: 'reserve-1',
    ...TASK,
    logicalToolCallId: 'write-call',
    physicalDispatchId: 'write-physical',
    targetDigest: TARGET,
    writeInputDigest: canonicalWriteEvidenceDigest(WRITE_INPUT),
  };
  const terminal = {
    kind: 'succeeded' as const,
    eventId: 'terminal-1',
    reservationEventId: 'reserve-1',
    ...TASK,
    logicalToolCallId: 'write-call',
    physicalDispatchId: 'write-physical',
    targetDigest: TARGET,
    writeInputDigest: canonicalWriteEvidenceDigest(WRITE_INPUT),
    resultHandleId: 'write-result',
  };
  return [reservation, { ...terminal, ...overrides } as typeof terminal];
}

function reversibleInput(): WriteEvidenceInput {
  return {
    binding: reversibleBinding(),
    scope: reversibleScope(),
    writeInput: WRITE_INPUT,
    writeSettlement: settlement('write-call', 'write-physical', 'write-result'),
    writeResult: rawResult(
      'write-call',
      'write-physical',
      'write-result',
      { successful: true, data: { mutation: { opaque: 'mutation-1' } } },
    ),
    writeLifecycle: committedLedger(),
    readback: {
      targetDigest: TARGET,
      verificationContractId: reversibleBinding().bindingId,
      writeLogicalToolCallId: 'write-call',
      settlement: settlement('readback-call', 'readback-physical', 'readback-result'),
      result: rawResult(
        'readback-call',
        'readback-physical',
        'readback-result',
        {
          successful: true,
          data: {
            arbitrary_records: [
              { different_key: 'row-2', different_value: 'beta' },
              { different_key: 'row-1', different_value: 'alpha' },
            ],
          },
          meta: { complete: true },
        },
      ),
    },
    executionSet: {
      ...TASK,
      openedExecutionIds: ['execution-1'],
      executions: [{ executionId: 'execution-1', state: 'completed' }],
    },
  };
}

function verdict(
  input: WriteEvidenceInput,
  obligation: WriteEvidenceObligation,
): WriteEvidenceVerdict {
  const result = evaluateWriteEvidence(input);
  const found = result.verdicts.find((entry) => entry.obligation === obligation);
  assert.ok(found, `missing verdict for ${obligation}`);
  return found;
}

test('exact reversible evidence proves commit, readback, stale reconciliation, and terminal execution', () => {
  const result = evaluateWriteEvidence(reversibleInput());
  assert.equal(result.status, 'evaluated');
  assert.deepEqual(
    result.verdicts.map((entry) => [entry.obligation, entry.status]),
    [
      ['commit_effect', 'proved'],
      ['verify_committed_readback', 'proved'],
      ['stale_destination_reconciled', 'proved'],
      ['execution_terminal', 'proved'],
    ],
  );
  for (const entry of result.verdicts) {
    assert.equal(entry.status, 'proved');
    if (entry.status === 'proved') {
      assert.match(entry.proof.proofId, /^write-evidence:v1:[a-f0-9]{64}$/);
      assert.equal(entry.proof.acceptedTaskId, TASK.acceptedTaskId);
      assert.equal(entry.proof.targetDigest, TARGET);
    }
  }
});

test('a successful settlement result alone cannot prove commit', () => {
  const input = reversibleInput();
  input.writeLifecycle = [];
  assert.deepEqual(verdict(input, 'commit_effect'), {
    obligation: 'commit_effect',
    status: 'unproven',
    reason: 'write_lifecycle_missing',
  });
});

test('a provider 204-style empty result can prove commit only with its exact successful lifecycle', () => {
  const input = reversibleInput();
  input.writeSettlement = { ...input.writeSettlement, outcomeKind: 'empty_result' };
  input.writeResult = rawResult(
    'write-call', 'write-physical', 'write-result',
    { successful: true, status_code: 204 },
  );
  assert.equal(verdict(input, 'commit_effect').status, 'proved');
});

test('failed, orphaned, ambiguous, and uncertain write states cannot prove commit', () => {
  for (const state of ['failed', 'orphaned'] as const) {
    const input = reversibleInput();
    input.writeLifecycle = committedLedger({ kind: state });
    assert.equal(verdict(input, 'commit_effect').status, 'unproven');
  }

  const ambiguous = reversibleInput();
  ambiguous.writeLifecycle.push({
    ...ambiguous.writeLifecycle[0]!,
    eventId: 'reserve-ambiguous',
    physicalDispatchId: 'another-crossing',
  });
  assert.deepEqual(verdict(ambiguous, 'commit_effect'), {
    obligation: 'commit_effect', status: 'unproven', reason: 'write_lifecycle_ambiguous',
  });

  const uncertain = reversibleInput();
  uncertain.writeSettlement = {
    ...uncertain.writeSettlement,
    outcomeKind: 'uncertain_write',
  };
  assert.deepEqual(verdict(uncertain, 'commit_effect'), {
    obligation: 'commit_effect', status: 'unproven', reason: 'write_settlement_not_committed',
  });
});

test('a pre-dispatch refusal cannot be relabelled as a committed effect', () => {
  const input = reversibleInput();
  input.writeSettlement = {
    ...input.writeSettlement,
    executionKind: 'refused_pre_dispatch',
    outcomeKind: 'invalid_arguments',
    resultHandleId: undefined,
    crossings: [],
  };
  input.writeResult = undefined;
  input.writeLifecycle = [];
  assert.deepEqual(verdict(input, 'commit_effect'), {
    obligation: 'commit_effect', status: 'unproven', reason: 'write_settlement_not_committed',
  });
});

test('wrong task, logical call, physical crossing, or target cannot certify the write', () => {
  const variants: WriteEvidenceInput[] = [];

  const wrongTask = reversibleInput();
  wrongTask.writeLifecycle = wrongTask.writeLifecycle.map((fact) => ({
    ...fact, acceptedTaskId: 'accepted:other:1',
  }));
  variants.push(wrongTask);

  const wrongCall = reversibleInput();
  wrongCall.writeLifecycle = wrongCall.writeLifecycle.map((fact) => ({
    ...fact, logicalToolCallId: 'another-call',
  }));
  variants.push(wrongCall);

  const wrongCrossing = reversibleInput();
  wrongCrossing.writeLifecycle = wrongCrossing.writeLifecycle.map((fact) => ({
    ...fact, physicalDispatchId: 'another-crossing',
  }));
  variants.push(wrongCrossing);

  const wrongTarget = reversibleInput();
  wrongTarget.writeLifecycle = wrongTarget.writeLifecycle.map((fact) => ({
    ...fact, targetDigest: canonicalWriteEvidenceDigest({ destination: 'other' }),
  }));
  variants.push(wrongTarget);

  for (const input of variants) assert.equal(verdict(input, 'commit_effect').status, 'unproven');
});

test('an irreversible receipt is derived from raw provider bytes on the committed crossing', () => {
  const input = reversibleInput();
  input.binding = irreversibleBinding();
  input.scope = irreversibleScope();
  input.writeResult = rawResult(
    'write-call',
    'write-physical',
    'write-result',
    { successful: true, data: { provider_artifact: { token: 'opaque-receipt-7' } } },
  );
  input.readback = undefined;

  const result = verdict(input, 'verify_committed_receipt');
  assert.equal(result.status, 'proved');
  if (result.status === 'proved') {
    assert.equal(
      result.proof.evidenceDigests.includes(canonicalWriteEvidenceDigest('opaque-receipt-7')),
      true,
    );
    assert.equal(JSON.stringify(result.proof).includes('opaque-receipt-7'), false);
    assert.equal(result.proof.physicalDispatchIds.includes('write-physical'), true);
  }
});

test('request echoes, missing receipt values, and results from another crossing cannot prove a send receipt', () => {
  const echo = reversibleInput();
  echo.binding = irreversibleBinding('/request/token');
  echo.scope = irreversibleScope();
  echo.writeResult = rawResult(
    'write-call', 'write-physical', 'write-result',
    { successful: true, request: { token: 'caller-supplied' } },
  );
  echo.readback = undefined;
  assert.equal(verdict(echo, 'verify_committed_receipt').status, 'unproven');

  const missing = reversibleInput();
  missing.binding = irreversibleBinding('/data/provider_artifact/token');
  missing.scope = irreversibleScope();
  missing.writeResult = rawResult(
    'write-call', 'write-physical', 'write-result',
    { successful: true, data: { provider_artifact: {} } },
  );
  missing.readback = undefined;
  assert.equal(verdict(missing, 'verify_committed_receipt').status, 'unproven');

  const otherCrossing = reversibleInput();
  otherCrossing.binding = irreversibleBinding();
  otherCrossing.scope = irreversibleScope();
  otherCrossing.writeResult = rawResult(
    'write-call', 'another-crossing', 'write-result',
    { successful: true, data: { provider_artifact: { token: 'receipt' } } },
  );
  otherCrossing.readback = undefined;
  assert.equal(verdict(otherCrossing, 'verify_committed_receipt').status, 'unproven');
});

test('reversible readback compares exact host projections and rejects omission, extra, duplicate, or changed records', () => {
  const payloads = [
    [{ different_key: 'row-1', different_value: 'alpha' }],
    [
      { different_key: 'row-1', different_value: 'alpha' },
      { different_key: 'row-2', different_value: 'beta' },
      { different_key: 'row-3', different_value: 'stale' },
    ],
    [
      { different_key: 'row-1', different_value: 'alpha' },
      { different_key: 'row-1', different_value: 'alpha' },
    ],
    [
      { different_key: 'row-1', different_value: 'alpha' },
      { different_key: 'row-2', different_value: 'changed' },
    ],
  ];

  for (const records of payloads) {
    const input = reversibleInput();
    input.readback!.result = rawResult(
      'readback-call', 'readback-physical', 'readback-result',
      { successful: true, data: { arbitrary_records: records }, meta: { complete: true } },
    );
    assert.equal(verdict(input, 'verify_committed_readback').status, 'unproven');
    assert.equal(verdict(input, 'stale_destination_reconciled').status, 'unproven');
  }
});

test('readback from the wrong task or target cannot verify an otherwise identical payload', () => {
  const wrongTask = reversibleInput();
  wrongTask.readback = {
    ...wrongTask.readback!,
    result: { ...wrongTask.readback!.result, acceptedTaskId: 'accepted:other:1' },
  };
  assert.equal(verdict(wrongTask, 'verify_committed_readback').status, 'unproven');

  const wrongTarget = reversibleInput();
  wrongTarget.readback = {
    ...wrongTarget.readback!,
    targetDigest: canonicalWriteEvidenceDigest({ destination: 'other' }),
  };
  assert.equal(verdict(wrongTarget, 'verify_committed_readback').status, 'unproven');
});

test('selected-record equality does not prove stale-destination reconciliation', () => {
  const input = reversibleInput();
  input.binding = reversibleBinding({
    observedCoverage: 'selected_records',
  });
  input.scope = reversibleScope([], [
    'commit_effect',
    'verify_committed_readback',
    'stale_destination_reconciled',
    'execution_terminal',
  ]);
  input.readback!.verificationContractId = input.binding.bindingId;
  assert.equal(verdict(input, 'verify_committed_readback').status, 'proved');
  assert.deepEqual(verdict(input, 'stale_destination_reconciled'), {
    obligation: 'stale_destination_reconciled',
    status: 'unproven',
    reason: 'readback_does_not_cover_exact_destination',
  });
});

test('without a frozen selector and mapping there is no generic readback comparison', () => {
  const input = reversibleInput();
  input.binding = reversibleBinding({ verification: { kind: 'unavailable' } });
  input.readback!.verificationContractId = input.binding.bindingId;
  assert.deepEqual(verdict(input, 'verify_committed_readback'), {
    obligation: 'verify_committed_readback',
    status: 'unproven',
    reason: 'verification_contract_missing',
  });
});

test('derivation is proved only by an exact host transform fact over this task source set', () => {
  const input = reversibleInput();
  input.binding = reversibleBinding({ sourceRequirementIds: ['source-a', 'source-b'] });
  input.scope = reversibleScope(['source-a', 'source-b']);
  input.readback!.verificationContractId = input.binding.bindingId;
  input.derivation = {
    kind: 'host_deterministic_transform',
    ...TASK,
    workContractId: input.binding.workContractId,
    requirementId: input.binding.requirementId,
    sourceEvidence: [
      { requirementId: 'source-b', receiptId: 'receipt-b', contentDigest: 'b'.repeat(64) },
      { requirementId: 'source-a', receiptId: 'receipt-a', contentDigest: 'c'.repeat(64) },
    ],
    outputDigest: canonicalWriteEvidenceDigest(WRITE_INPUT),
    transformArtifactDigest: 'd'.repeat(64),
  };
  assert.equal(verdict(input, 'derivation_from_current_source').status, 'proved');

  const wrong = structuredClone(input);
  wrong.derivation!.sourceEvidence = wrong.derivation!.sourceEvidence.slice(0, 1);
  assert.equal(verdict(wrong, 'derivation_from_current_source').status, 'unproven');
});

test('execution terminal requires exact opened-vs-terminal identity accounting', () => {
  const input = reversibleInput();
  input.executionSet = {
    ...TASK,
    openedExecutionIds: ['execution-1', 'execution-2'],
    executions: [
      { executionId: 'execution-1', state: 'completed' },
      { executionId: 'execution-2', state: 'active' },
    ],
  };
  assert.deepEqual(verdict(input, 'execution_terminal'), {
    obligation: 'execution_terminal', status: 'unproven', reason: 'execution_set_not_terminal',
  });
});

test('binding content is self-addressed and any post-freeze mutation fails closed', () => {
  const input = reversibleInput();
  input.binding = { ...input.binding, targetDigest: canonicalWriteEvidenceDigest('tampered') };
  const result = evaluateWriteEvidence(input);
  assert.equal(result.status, 'invalid_binding');
  assert.equal(result.verdicts.every((entry) => entry.status === 'unproven'), true);
});
