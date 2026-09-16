/**
 * ONE identity comparison for a reviewed provider capability.
 *
 * Plan publication, Execute revalidation and per-call admission all ask the
 * same question: is the catalog entry the plan cited still the exact entry
 * with the exact provider input schema the person reviewed? Each answer used
 * to be hand-rolled with its own tolerance for a missing digest. The digest is
 * now sealed by every producer at registration, so every consumer compares
 * strictly through this module and no consumer fills a gap from the cache.
 */
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import {
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { peekProductionCapabilityAdapter } from './production-capability-adapter.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';

export type ReviewedProviderIdentityRefusal = 'entry_missing' | 'entry_not_callable' | 'schema_not_cached';

export type CurrentReviewedProviderIdentity =
  | {
      ok: true;
      entry: RegisteredHostCapability;
      canonical: CanonicalCatalogIdentityV1 & { providerInputSchemaDigest: string };
      schema: Record<string, unknown>;
    }
  | { ok: false; reason: ReviewedProviderIdentityRefusal; entry?: RegisteredHostCapability };

export type ReviewedProviderIdentityMismatch = 'identity_mismatch' | 'schema_digest_mismatch';

/** The one canonicalisation of a provider input schema: the producer's form. */
export function providerInputSchemaDigestOf(schema: unknown): string {
  return digestSchema(schema);
}

const equal = (a: unknown, b: unknown): boolean => {
  try {
    return closedCanonicalJson(a, SEALED_CALL_CANONICAL_LIMITS) === closedCanonicalJson(b, SEALED_CALL_CANONICAL_LIMITS);
  } catch {
    return false;
  }
};

/**
 * Resolve the current callable identity and cached provider schema for a
 * cited capability. A catalog rebuilt from durable manifests holds an entry
 * that is present but not yet callable until its carrier re-attests it; one
 * adapter refresh of that manifest is supply, never authority.
 */
export function currentReviewedProviderIdentity(capabilityRef: string): CurrentReviewedProviderIdentity {
  const factory = peekHostCapabilityCatalogFactory();
  let entry = factory?.get(capabilityRef);
  if (!entry) return { ok: false, reason: 'entry_missing' };
  if (!isCurrentCallableCatalogEntry(entry) && entry.manifest) {
    try { peekProductionCapabilityAdapter()?.refresh(new Set([entry.manifest.manifestId])); } catch { /* refresh is supply, never authority */ }
    entry = factory?.get(capabilityRef) ?? entry;
  }
  const canonical = isCurrentCallableCatalogEntry(entry) ? canonicalCatalogIdentityOf(entry) : null;
  // A callable row without a sealed provider schema digest was never
  // materialized under a current provider lease; it cannot anchor a reviewed
  // plan and nothing may fill that digest in from the cache.
  if (!canonical || typeof canonical.providerInputSchemaDigest !== 'string' || !canonical.providerInputSchemaDigest) {
    return { ok: false, reason: 'entry_not_callable', entry };
  }
  const schema = getCachedToolSchema(canonical.operationId);
  if (!schema) return { ok: false, reason: 'schema_not_cached', entry };
  return { ok: true, entry, canonical: canonical as CanonicalCatalogIdentityV1 & { providerInputSchemaDigest: string }, schema };
}

/**
 * Strict comparison of the current identity against the identity the plan
 * recorded at publication, then of the cached schema against the sealed
 * digest. Both sides carry the digest; a missing key is a mismatch.
 */
export function reviewedProviderIdentityMismatch(
  current: Extract<CurrentReviewedProviderIdentity, { ok: true }>,
  reviewedIdentity: Record<string, unknown>,
): ReviewedProviderIdentityMismatch | null {
  if (!equal(current.canonical, reviewedIdentity)) return 'identity_mismatch';
  if (providerInputSchemaDigestOf(current.schema) !== current.canonical.providerInputSchemaDigest) return 'schema_digest_mismatch';
  return null;
}

/** A call attestation matches a reviewed binding only on every identity field, strictly. */
export function attestationMatchesReviewedIdentity(
  attestation: HostCallAttestation | undefined,
  identity: Record<string, unknown> | null | undefined,
): boolean {
  if (!attestation || !identity) return false;
  return attestation.capabilityId === identity.capabilityId
    && attestation.manifestDigest === identity.manifestDigest
    && attestation.accountId === identity.account
    && typeof attestation.providerInputSchemaDigest === 'string'
    && attestation.providerInputSchemaDigest === identity.providerInputSchemaDigest;
}
