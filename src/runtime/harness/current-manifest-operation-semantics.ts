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

/** Reopen positive semantics only from one exact, current, digest-valid
 * materialized manifest. Provider/action names are compared as identities;
 * their tokens never decide the returned semantics. Ambiguous accounts or
 * definitions deliberately return null. */
export function currentManifestOperationContract(
  operationId: string | null | undefined,
): CurrentManifestOperationSemanticsV1 | null {
  const normalized = String(operationId ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const current = (peekHostCapabilityCatalogFactory()?.snapshot() ?? []).filter(isCurrentCallableCatalogEntry);
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
  const exact = current.filter((entry) => entry.manifest.operationId.trim().toLowerCase() === normalized);
  const exactContract = uniqueEffect(exact);
  if (exactContract) return exactContract;
  if (exact.length > 1) return null;
  const key = catalogOperationIdentityKey(normalized);
  if (!key) return null;
  return uniqueEffect(
    current.filter((entry) => catalogOperationIdentityKey(entry.manifest.operationId) === key),
  );
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
