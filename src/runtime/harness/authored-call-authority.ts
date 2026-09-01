/**
 * Call authority for a write the host granted on an AUTHORED workflow step.
 *
 * Owner rule (2026-07-24, reaffirmed 2026-09-01): saving and enabling a
 * workflow is the consent for its authored write/send steps; the only human
 * gate inside a saved workflow is a step authored `requiresApproval`. The
 * host evaluates that consent per call (authored-workflow-write-authority.ts)
 * and, once it decides `proceed`, the shipped invoke adapter still needs a
 * call authority to forward a generic external write. Until 2026-09-01 the
 * only minter was the admitted-construct lane (plan_task → work_call), so a
 * consented authored write reached the adapter with no authority and died
 * inside it ("generic external write requires current call authority") —
 * settled as an uncertain mutation for a call that never left the process.
 *
 * This authority carries exactly what the adapter verifies — the current
 * manifest's identity, versions, fingerprint, compiler and port — plus the
 * canonical arguments the host already schema-validated, and the grant that
 * produced it. It is minted only from a decided authored consent and never
 * persists as ledger authority; the dispatch ledger keeps its own rows.
 */
import { capabilityManifestDigest, type CapabilityManifestV1 } from './capability-manifest.js';

export const AUTHORED_CALL_AUTHORITY_VERSION = 1 as const;

export interface AuthoredCallGrantV1 {
  /** `authored-workflow:<receipt authority digest>` from the consent coverage. */
  coverageContractId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalCallId: string;
}

export interface AuthoredCallAuthorityV1 {
  version: typeof AUTHORED_CALL_AUTHORITY_VERSION;
  kind: 'authored_workflow_step';
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
  grant: AuthoredCallGrantV1;
}

/**
 * Mint from the exact manifest the host bound and the arguments it validated.
 * Every identity field is copied from the manifest, never from model text, so
 * the adapter's byte-for-byte comparison against its current sealed manifest
 * is the proof that this authority names the same capability.
 */
export function mintAuthoredCallAuthority(input: {
  manifest: CapabilityManifestV1;
  canonicalArgs: Record<string, unknown>;
  grant: AuthoredCallGrantV1;
}): AuthoredCallAuthorityV1 {
  const { manifest } = input;
  if (!input.canonicalArgs || typeof input.canonicalArgs !== 'object' || Array.isArray(input.canonicalArgs)) {
    throw new Error('authored call authority requires canonical object arguments');
  }
  if (!input.grant.coverageContractId.startsWith('authored-workflow:')) {
    throw new Error('authored call authority requires an authored-workflow coverage contract');
  }
  return Object.freeze({
    version: AUTHORED_CALL_AUTHORITY_VERSION,
    kind: 'authored_workflow_step',
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
