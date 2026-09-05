/**
 * Existing adapter authority for a write granted by the host consent reducer.
 * Authored workflows and exact accepted chat calls share this one shape; a
 * chat write does not need a compiled plan to carry the reducer's decision.
 *
 * This authority carries exactly what the adapter verifies — the current
 * manifest's identity, versions, fingerprint, compiler and port — plus the
 * canonical arguments the host already schema-validated, and the grant that
 * produced it. It is minted only from decided host consent and never
 * persists as ledger authority; the dispatch ledger keeps its own rows.
 */
import { capabilityManifestDigest, type CapabilityManifestV1 } from './capability-manifest.js';

export const HOST_CONSENT_CALL_AUTHORITY_VERSION = 1 as const;

export interface HostConsentCallGrantV1 {
  /** The existing reducer's authored-workflow or exact accepted-call coverage. */
  coverageContractId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalCallId: string;
}

export interface HostConsentCallAuthorityV1 {
  version: typeof HOST_CONSENT_CALL_AUTHORITY_VERSION;
  kind: 'host_consent_call';
  operationId: string;
  capabilityRef: string;
  manifestId: string;
  manifestDigest: string;
  providerKind: CapabilityManifestV1['providerKind'];
  providerIdentity: string;
  operationVersion: string;
  liveProviderVersion: string;
  liveFingerprint: string;
  resolvedEffect: CapabilityManifestV1['effect'];
  argumentCompiler: { id: string; version: string };
  invokePortId: string;
  accountId: string;
  canonicalArgs: Record<string, unknown>;
  grant: HostConsentCallGrantV1;
}

/**
 * Mint from the exact manifest the host bound and the arguments it validated.
 * Every identity field is copied from the manifest, never from model text, so
 * the adapter's byte-for-byte comparison against its current sealed manifest
 * is the proof that this authority names the same capability.
 */
export function mintHostConsentCallAuthority(input: {
  manifest: CapabilityManifestV1;
  canonicalArgs: Record<string, unknown>;
  grant: HostConsentCallGrantV1;
}): HostConsentCallAuthorityV1 {
  const { manifest } = input;
  if (!input.canonicalArgs || typeof input.canonicalArgs !== 'object' || Array.isArray(input.canonicalArgs)) {
    throw new Error('host consent call authority requires canonical object arguments');
  }
  if (!/^(?:authored-workflow|accepted-call):[a-f0-9]{64}$/.test(input.grant.coverageContractId)) {
    throw new Error('host consent call authority requires exact reducer coverage');
  }
  return Object.freeze({
    version: HOST_CONSENT_CALL_AUTHORITY_VERSION,
    kind: 'host_consent_call',
    operationId: manifest.operationId,
    capabilityRef: manifest.manifestId,
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerIdentity: manifest.providerIdentity,
    operationVersion: manifest.operationVersion,
    liveProviderVersion: manifest.providerVersion,
    liveFingerprint: manifest.definitionFingerprint,
    resolvedEffect: manifest.effect,
    argumentCompiler: { id: manifest.argumentCompiler.id, version: manifest.argumentCompiler.version },
    invokePortId: manifest.invokePortId,
    accountId: manifest.accountId,
    canonicalArgs: Object.freeze({ ...input.canonicalArgs }),
    grant: Object.freeze({ ...input.grant }),
  });
}
