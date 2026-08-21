/**
 * Host bind/verify for one whole-plan grounding judgment.
 * The model returns per-operation verdicts only. Authority hashes stay host-owned.
 */
import { isHostAuthorityIdentity } from './host-authority.js';
import { createHash } from 'node:crypto';
import type { PlanGroundingJudgeResult } from './turn-semantic-model-port.js';
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import { PlanGroundingJudgeV1Schema, shownGroundingDescriptors } from './turn-semantic-proposal.js';

export interface GroundingOperationReceiptV1 {
  operationId: string;
  verdict: 'entailed' | 'conflict' | 'uncertain';
  capabilityRef: string;
  manifestDigest: string;
  rationale: string;
}

export interface GroundingReceiptV1 {
  modelIdentity: string;
  catalogSnapshotDigest: string;
  shownDescriptorDigest: string;
  proposalDigest: string;
  overallVerdict: 'entailed' | 'conflict' | 'uncertain';
  operations: readonly GroundingOperationReceiptV1[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  digest: string;
}

export interface SemanticValidationIssueV1 {
  code: string;
  path: string;
  message: string;
  operationId?: string;
  capabilityRef?: string;
}

export interface ExecutablePlanOperation {
  id: string;
  role: string;
  requestedEffect: string;
  capabilityRef: string | null;
  dependsOn: readonly string[];
  evidence: readonly string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function catalogSnapshotDigestFromDescriptors(
  descriptors: readonly Pick<HostCapabilityDescriptorV1, 'id' | 'manifestDigest'>[],
): string {
  const rows = [...descriptors]
    .map((entry) => ({ id: entry.id, manifestDigest: entry.manifestDigest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(JSON.stringify(rows));
}

export function groundingReceiptDigest(receipt: Omit<GroundingReceiptV1, 'digest'>): string {
  return sha256(JSON.stringify({
    modelIdentity: receipt.modelIdentity,
    catalogSnapshotDigest: receipt.catalogSnapshotDigest,
    shownDescriptorDigest: receipt.shownDescriptorDigest,
    proposalDigest: receipt.proposalDigest,
    overallVerdict: receipt.overallVerdict,
    operations: receipt.operations.map((operation) => ({
      operationId: operation.operationId,
      verdict: operation.verdict,
      capabilityRef: operation.capabilityRef,
      manifestDigest: operation.manifestDigest,
    })),
  }));
}

export function derivedPlanGroundingOverall(
  operations: ReadonlyArray<{ verdict: 'entailed' | 'conflict' | 'uncertain' }>,
): 'entailed' | 'conflict' | 'uncertain' {
  if (operations.length === 0) return 'uncertain';
  if (operations.every((operation) => operation.verdict === 'entailed')) return 'entailed';
  if (operations.some((operation) => operation.verdict === 'conflict')) return 'conflict';
  return 'uncertain';
}

export function requireFrozenCatalogForExecutablePlan(input: {
  operations: readonly ExecutablePlanOperation[];
  descriptors: readonly HostCapabilityDescriptorV1[];
}): SemanticValidationIssueV1 | null {
  if (input.operations.length === 0) return null;
  const needsCatalog = input.operations.some((operation) => (
    operation.requestedEffect !== 'host_only'
    && operation.requestedEffect !== 'none'
    && operation.requestedEffect !== 'compute'
    && Boolean(operation.capabilityRef)
    && operation.capabilityRef !== 'unknown'
  ));
  if (!needsCatalog) return null;
  if (input.descriptors.length === 0) {
    return {
      code: 'capability_catalog_empty',
      path: 'host.catalog.capabilities',
      message: 'executable operations require a frozen nonempty capability catalog',
    };
  }
  return null;
}

export function downstreamConsumersOf(
  operations: readonly Pick<ExecutablePlanOperation, 'id' | 'dependsOn'>[],
): Map<string, string[]> {
  const downstream = new Map<string, string[]>();
  for (const operation of operations) downstream.set(operation.id, []);
  for (const operation of operations) {
    for (const dep of operation.dependsOn) {
      downstream.get(dep)?.push(operation.id);
    }
  }
  return downstream;
}

export function parsePlanGroundingJudgeRaw(raw: unknown): PlanGroundingJudgeResult['operations'] | null {
  const parsed = PlanGroundingJudgeV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.operations.map((operation) => ({
    operationId: operation.operationId,
    verdict: operation.verdict,
    rationale: operation.rationale,
  }));
}

export function bindPlanGroundingReceipt(input: {
  judged: PlanGroundingJudgeResult;
  operations: readonly ExecutablePlanOperation[];
  descriptors: readonly HostCapabilityDescriptorV1[];
  catalogSnapshotDigest: string;
  shownDescriptorDigest: string;
  proposalDigest: string;
  /** Set EXCLUSIVELY by the host deterministic-compile lane, which never
   *  passes model output into this binder. Model-port verdicts must not
   *  claim the reserved host authority namespace. */
  hostMinted?: boolean;
}): { ok: true; receipt: GroundingReceiptV1 } | { ok: false; issue: SemanticValidationIssueV1 } {
  if (!input.judged.modelIdentity.trim() || input.judged.modelIdentity !== input.judged.modelIdentity.trim()) {
    return {
      ok: false,
      issue: {
        code: 'grounding_identity_invalid',
        path: 'grounding.modelIdentity',
        message: 'grounding judge identity is empty or non-canonical',
      },
    };
  }
  if (isHostAuthorityIdentity(input.judged.modelIdentity) && input.hostMinted !== true) {
    return {
      ok: false,
      issue: {
        code: 'grounding_identity_invalid',
        path: 'grounding.modelIdentity',
        message: 'the host deterministic-bind identity namespace is reserved; a model verdict cannot claim it',
      },
    };
  }
  const catalogIssue = requireFrozenCatalogForExecutablePlan({
    operations: input.operations,
    descriptors: input.descriptors,
  });
  if (catalogIssue) return { ok: false, issue: catalogIssue };
  if (!/^[a-f0-9]{64}$/i.test(input.shownDescriptorDigest)) {
    return {
      ok: false,
      issue: {
        code: 'grounding_shown_digest_invalid',
        path: 'grounding.shownDescriptorDigest',
        message: 'grounding receipt must bind the exact shown descriptor bytes',
      },
    };
  }
  const shown = shownGroundingDescriptors({
    descriptors: input.descriptors,
    referencedIds: input.operations.map((operation) => operation.capabilityRef),
  });
  if (!shown.ok) {
    return {
      ok: false,
      issue: {
        code: shown.code,
        path: 'grounding.descriptors',
        message: shown.message,
        capabilityRef: shown.capabilityRef,
      },
    };
  }
  if (shown.digest !== input.shownDescriptorDigest) {
    return {
      ok: false,
      issue: {
        code: 'grounding_shown_digest_mismatch',
        path: 'grounding.shownDescriptorDigest',
        message: 'grounding receipt digest is not the canonical digest of the shown descriptor bytes',
      },
    };
  }
  const expectedIds = input.operations.map((operation) => operation.id);
  const seen = new Set<string>();
  const byId = new Map(input.judged.operations.map((operation) => [operation.operationId, operation]));
  if (input.judged.operations.length !== expectedIds.length) {
    return {
      ok: false,
      issue: {
        code: 'grounding_coverage_mismatch',
        path: 'grounding.operations',
        message: 'grounding verdicts must cover each proposed operation exactly once',
      },
    };
  }
  for (const operation of input.judged.operations) {
    if (seen.has(operation.operationId) || !expectedIds.includes(operation.operationId)) {
      return {
        ok: false,
        issue: {
          code: seen.has(operation.operationId) ? 'grounding_duplicate_operation' : 'grounding_extra_operation',
          path: `grounding.operations.${operation.operationId}`,
          message: 'missing, duplicate, changed, or extra operation verdicts block',
          operationId: operation.operationId,
        },
      };
    }
    seen.add(operation.operationId);
  }
  for (const expected of expectedIds) {
    if (!byId.has(expected)) {
      return {
        ok: false,
        issue: {
          code: 'grounding_missing_operation',
          path: `grounding.operations.${expected}`,
          message: 'missing, duplicate, changed, or extra operation verdicts block',
          operationId: expected,
        },
      };
    }
  }
  const bound: GroundingOperationReceiptV1[] = [];
  for (const operation of input.operations) {
    const capabilityRef = operation.capabilityRef;
    if (!capabilityRef) {
      return {
        ok: false,
        issue: {
          code: 'missing_capability_ref',
          path: `work.operations.${operation.id}.capabilityRef`,
          message: 'executable operation requires an exact host-issued capability reference',
          operationId: operation.id,
        },
      };
    }
    const descriptor = input.descriptors.find((entry) => entry.id === capabilityRef);
    if (!descriptor) {
      if (
        operation.requestedEffect === 'host_only'
        || operation.requestedEffect === 'none'
        || operation.requestedEffect === 'compute'
      ) {
        continue;
      }
      return {
        ok: false,
        issue: {
          code: 'unknown_capability_ref',
          path: `work.operations.${operation.id}.capabilityRef`,
          message: 'capability reference is not present in the frozen host catalog',
          operationId: operation.id,
          capabilityRef,
        },
      };
    }
    const judged = byId.get(operation.id);
    if (!judged) {
      return {
        ok: false,
        issue: {
          code: 'grounding_missing_operation',
          path: `grounding.operations.${operation.id}`,
          message: 'missing, duplicate, changed, or extra operation verdicts block',
          operationId: operation.id,
          capabilityRef,
        },
      };
    }
    bound.push({
      operationId: operation.id,
      verdict: judged.verdict,
      capabilityRef,
      manifestDigest: descriptor.manifestDigest,
      rationale: judged.rationale,
    });
  }
  // Host owns overall. Per-operation verdicts are the only model-owned
  // grounding bytes; a chatty top-level "conflict" beside entailed ops
  // (live 2026-08-21 team-summary) is not authority.
  const overallVerdict = derivedPlanGroundingOverall(bound);
  const withoutDigest = {
    modelIdentity: input.judged.modelIdentity,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    shownDescriptorDigest: input.shownDescriptorDigest,
    proposalDigest: input.proposalDigest,
    overallVerdict,
    operations: bound,
    inputTokens: input.judged.inputTokens,
    outputTokens: input.judged.outputTokens,
    latencyMs: input.judged.latencyMs,
  };
  return { ok: true, receipt: { ...withoutDigest, digest: groundingReceiptDigest(withoutDigest) } };
}

export function validateGroundingReceiptReplay(input: {
  persisted: GroundingReceiptV1;
  operations: readonly ExecutablePlanOperation[];
  descriptors: readonly HostCapabilityDescriptorV1[];
  catalogSnapshotDigest: string;
  shownDescriptorDigest: string;
  proposalDigest: string;
}): SemanticValidationIssueV1 | null {
  const catalogIssue = requireFrozenCatalogForExecutablePlan({
    operations: input.operations,
    descriptors: input.descriptors,
  });
  if (catalogIssue) return catalogIssue;
  if (input.persisted.catalogSnapshotDigest !== input.catalogSnapshotDigest) {
    return {
      code: 'grounding_catalog_digest_mismatch',
      path: 'grounding.catalogSnapshotDigest',
      message: 'replayed grounding receipt is not bound to the frozen catalog snapshot',
    };
  }
  if (input.persisted.shownDescriptorDigest !== input.shownDescriptorDigest) {
    return {
      code: 'grounding_shown_digest_mismatch',
      path: 'grounding.shownDescriptorDigest',
      message: 'replayed grounding receipt is not bound to the exact shown descriptor bytes',
    };
  }
  if (input.persisted.proposalDigest !== input.proposalDigest) {
    return {
      code: 'grounding_proposal_digest_mismatch',
      path: 'grounding.proposalDigest',
      message: 'replayed grounding receipt is not bound to the admitted proposal digest',
    };
  }
  if (groundingReceiptDigest(input.persisted) !== input.persisted.digest) {
    return {
      code: 'grounding_receipt_digest_mismatch',
      path: 'grounding.digest',
      message: 'replayed grounding receipt digest does not bind the persisted verdicts',
    };
  }
  const rebound = bindPlanGroundingReceipt({
    judged: {
      verdict: input.persisted.overallVerdict,
      operations: input.persisted.operations.map((operation) => ({
        operationId: operation.operationId,
        verdict: operation.verdict,
        rationale: operation.rationale,
      })),
      modelIdentity: input.persisted.modelIdentity,
      inputTokens: input.persisted.inputTokens,
      outputTokens: input.persisted.outputTokens,
      latencyMs: input.persisted.latencyMs,
    },
    operations: input.operations,
    descriptors: input.descriptors,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    shownDescriptorDigest: input.shownDescriptorDigest,
    proposalDigest: input.proposalDigest,
  });
  if (!rebound.ok) return rebound.issue;
  if (rebound.receipt.digest !== input.persisted.digest) {
    return {
      code: 'grounding_receipt_changed',
      path: 'grounding.operations',
      message: 'replayed grounding verdicts do not match the persisted receipt',
    };
  }
  for (const [index, operation] of rebound.receipt.operations.entries()) {
    const persisted = input.persisted.operations[index];
    if (
      !persisted
      || persisted.operationId !== operation.operationId
      || persisted.verdict !== operation.verdict
      || persisted.capabilityRef !== operation.capabilityRef
      || persisted.manifestDigest !== operation.manifestDigest
    ) {
      return {
        code: 'grounding_receipt_changed',
        path: `grounding.operations.${operation.operationId}`,
        message: 'replayed grounding verdicts do not match the persisted receipt',
        operationId: operation.operationId,
        capabilityRef: operation.capabilityRef,
      };
    }
  }
  if (input.persisted.overallVerdict !== 'entailed') {
    const failed = input.persisted.operations.find((operation) => operation.verdict !== 'entailed');
    return {
      code: 'capability_not_grounded',
      path: failed ? `work.operations.${failed.operationId}` : 'grounding',
      message: 'named capabilities are not grounded in the accepted source and proposed plan',
      operationId: failed?.operationId,
      capabilityRef: failed?.capabilityRef,
    };
  }
  return null;
}
