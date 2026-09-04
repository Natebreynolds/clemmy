import {
  type CapabilityManifestOperationSemanticsV1,
  type ManifestEffect,
} from './capability-manifest.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import { catalogOperationIdentityKey } from './runtime-tool-identity.js';
import type { OperationVerificationContractV1 } from './mutation-verification-contract.js';

/**
 * Positive, durable authority that a later corrected call may satisfy the same
 * write shape/target. This is deliberately not named "reversibility": an
 * exact-artifact reconciliation contract can make a rejected call repairable
 * even when the provider definition did not declare a general undo operation.
 */
export interface CurrentManifestRecoverySemanticsV1 {
  version: 1;
  operationId: string;
  manifestDigest: string;
  basis: 'reversible_operation' | 'exact_artifact_reconciliation';
}

export interface CurrentManifestOperationSemanticsV1 {
  operationId: string;
  manifestDigest: string;
  effect: ManifestEffect;
  destination: { family: string; posture: string } | null;
  semantics: CapabilityManifestOperationSemanticsV1 | null;
  behaviorHints: {
    readOnly: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    openWorld: boolean | null;
  } | null;
  verification: OperationVerificationContractV1 | null;
}

function currentOperationEntries(operationId: string | null | undefined) {
  const normalized = String(operationId ?? '').trim().toLowerCase();
  if (!normalized) return [];
  const current = (peekHostCapabilityCatalogFactory()?.snapshot() ?? []).filter(isCurrentCallableCatalogEntry);
  const exact = current.filter((entry) => entry.manifest.operationId.trim().toLowerCase() === normalized);
  if (exact.length > 0) return exact;
  const key = catalogOperationIdentityKey(normalized);
  if (!key) return [];
  return current.filter((entry) => catalogOperationIdentityKey(entry.manifest.operationId) === key);
}

/** Reopen positive semantics only from one exact, current, digest-valid
 * materialized manifest. Provider/action names are compared as identities;
 * their tokens never decide the returned semantics. Ambiguous accounts or
 * definitions deliberately return null. */
export function currentManifestOperationContract(
  operationId: string | null | undefined,
): CurrentManifestOperationSemanticsV1 | null {
  const current = currentOperationEntries(operationId);
  const project = (entry: (typeof current)[number]): CurrentManifestOperationSemanticsV1 => ({
    operationId: entry.manifest.operationId,
    manifestDigest: entry.manifestDigest,
    effect: entry.manifest.effect,
    destination: entry.manifest.destination ?? null,
    semantics: entry.manifest.operationSemantics ?? null,
    behaviorHints: entry.manifest.externalDefinition?.behaviorHints ?? null,
    verification: entry.manifest.externalDefinition?.verification ?? null,
  });
  const uniqueEffect = (
    entries: typeof current,
  ): CurrentManifestOperationSemanticsV1 | null => {
    if (entries.length === 0) return null;
    const effects = new Set(entries.map((entry) => entry.manifest.effect));
    // Duplicate transports of the same operation are one contract when they
    // agree on effect. Occupancy of two current BATCH_GET reads must not
    // look like "no contract" and fail closed as a write.
    return effects.size === 1 ? project(entries[0]!) : null;
  };
  return uniqueEffect(current);
}

/**
 * Reopen repair authority only from one exact, current, registration-attested
 * callable. Multiple accounts/definitions fail closed because a top-level
 * lifecycle event does not carry a sealed catalog binding from which this
 * helper could safely choose between them.
 *
 * `exact_artifact_reconciliation` is a separate positive semantic from
 * reversibility. It requires the manifest's idempotency contract, an exact
 * artifact reconciliation policy, and the actual distinct reconcile port to
 * all be live. A merely non-send-shaped or unknown mutation earns nothing.
 */
export function currentManifestRecoverySemantics(
  operationId: string | null | undefined,
): CurrentManifestRecoverySemanticsV1 | null {
  const matches = currentOperationEntries(operationId);
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  const manifest = entry.manifest;
  if (manifest.effect !== 'external_write') return null;
  const declared = manifest.operationSemantics?.reversibility;
  if (declared === 'irreversible' || manifest.externalDefinition?.behaviorHints.destructive === true) {
    return null;
  }
  const base = {
    version: 1 as const,
    operationId: manifest.operationId,
    manifestDigest: entry.manifestDigest,
  };
  if (declared === 'reversible') {
    return { ...base, basis: 'reversible_operation' };
  }
  if (
    manifest.idempotency.required === true
    && manifest.idempotency.policy !== 'none'
    && manifest.reconciliation.supported === true
    && manifest.reconciliation.policy === 'exact_artifact'
    && typeof entry.reconcile === 'function'
    && typeof manifest.reconcilePortId === 'string'
    && manifest.reconcilePortId.trim().length > 0
    && manifest.reconcilePortId !== manifest.invokePortId
  ) {
    return { ...base, basis: 'exact_artifact_reconciliation' };
  }
  return null;
}

/** Parse only the closed event form. Event rows are host-authored, but this
 * keeps malformed/legacy rows from accidentally becoming recovery authority. */
export function parseCurrentManifestRecoverySemantics(
  value: unknown,
): CurrentManifestRecoverySemanticsV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1
    || (row.basis !== 'reversible_operation' && row.basis !== 'exact_artifact_reconciliation')
    || typeof row.operationId !== 'string'
    || !row.operationId.trim()
    || typeof row.manifestDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.manifestDigest)
    || Object.keys(row).some((key) => !['version', 'operationId', 'manifestDigest', 'basis'].includes(key))
    || Object.keys(row).length !== 4
  ) return null;
  return {
    version: 1,
    operationId: row.operationId,
    manifestDigest: row.manifestDigest,
    basis: row.basis,
  };
}

export function currentManifestOperationSemantics(
  operationId: string | null | undefined,
): (CurrentManifestOperationSemanticsV1 & {
  semantics: CapabilityManifestOperationSemanticsV1;
}) | null {
  const contract = currentManifestOperationContract(operationId);
  return contract?.semantics
    ? { ...contract, semantics: contract.semantics }
    : null;
}
