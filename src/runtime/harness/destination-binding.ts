/**
 * Host-owned destination identity. Semantic deliverable kinds stay
 * diagnostic; they never select a provider, account, or invocation.
 */
import { createHash } from 'node:crypto';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';

export interface CanonicalDestinationBindingV1 {
  manifestId: string;
  manifestDigest: string;
  accountId: string;
  operationId: string;
  schemaVersion: string;
  definitionFingerprint: string;
  effect: string;
  posture: 'create_new' | 'named_existing';
}

export interface DestinationEvidenceFloorV1 {
  handleRequired: boolean;
  evidenceRequirements: readonly string[];
}

export type DestinationBindResult =
  | {
      ok: true;
      binding: CanonicalDestinationBindingV1;
      floor: DestinationEvidenceFloorV1;
    }
  | { ok: false; reason: string };

const WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function destinationBindingDigest(binding: CanonicalDestinationBindingV1): string {
  return sha256(JSON.stringify(binding));
}

function isWriteCapability(entry: RegisteredHostCapability): boolean {
  return WRITE_EFFECTS.has(entry.effect);
}

/**
 * Select the unique compatible write destination from the frozen catalog.
 * Candidate IDs are host-issued opaque catalog identities. Deliverable
 * kind strings are never compared.
 */
export function bindExecutableDestination(input: {
  requestedEffect: string;
  destinationPosture: 'create_new' | 'named_existing' | null;
  candidateIds?: readonly string[];
  catalog: readonly RegisteredHostCapability[];
}): DestinationBindResult {
  const posture = input.destinationPosture;
  if (!posture || !WRITE_EFFECTS.has(input.requestedEffect)) {
    return { ok: false, reason: 'destination bind requires a write effect and posture' };
  }
  const trusted = input.catalog.filter((entry) => (
    Boolean(entry.manifestDigest?.trim())
    && Boolean(entry.manifest)
    && isWriteCapability(entry)
    && entry.destination?.posture === posture
    && entry.effect === input.requestedEffect
  ));
  const named = [...new Set((input.candidateIds ?? []).filter((id) => id.trim().length > 0))];
  if (named.length === 0) {
    return { ok: false, reason: 'destination bind requires an exact capability reference' };
  }
  const selected = trusted.filter((entry) => named.includes(entry.capabilityId));
  if (selected.length !== 1) {
    return { ok: false, reason: selected.length === 0
      ? 'no unique compatible destination manifest'
      : 'ambiguous compatible destination manifests' };
  }
  const capability = selected[0]!;
  const manifest = capability.manifest as CapabilityManifestV1;
  const binding: CanonicalDestinationBindingV1 = {
    manifestId: manifest.manifestId,
    manifestDigest: capability.manifestDigest!,
    accountId: manifest.accountId,
    operationId: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    effect: manifest.effect,
    posture,
  };
  return {
    ok: true,
    binding,
    floor: evidenceFloorFromManifest(manifest, { handleRequired: false, evidenceRequirements: [] }),
  };
}

/** If either the proposal or the trusted manifest requires a handle or
 * exact readback, the host requires it. A handle proves target identity; it
 * does not by itself invent a readback obligation. */
export function evidenceFloorFromManifest(
  manifest: CapabilityManifestV1,
  proposed: { handleRequired: boolean; evidenceRequirements: readonly string[] },
): DestinationEvidenceFloorV1 {
  const write = WRITE_EFFECTS.has(manifest.effect);
  const handleRequired = Boolean(
    proposed.handleRequired
    || write
    || manifest.evidenceContract.readbackRequired
    || manifest.readbackContract?.required,
  );
  const requirements = new Set(proposed.evidenceRequirements);
  for (const kind of manifest.evidenceContract.kinds) requirements.add(kind);
  if (handleRequired) {
    requirements.add('artifact_handle');
  }
  if (manifest.evidenceContract.readbackRequired || manifest.readbackContract?.required) {
    requirements.add('readback');
    if (manifest.readbackContract?.contentDigestRequired) requirements.add('exact_readback');
  }
  return {
    handleRequired,
    evidenceRequirements: [...requirements],
  };
}

export function unionEvidenceFloor(
  ...floors: Array<DestinationEvidenceFloorV1 | undefined | null>
): DestinationEvidenceFloorV1 {
  const requirements = new Set<string>();
  let handleRequired = false;
  for (const floor of floors) {
    if (!floor) continue;
    handleRequired = handleRequired || floor.handleRequired;
    for (const item of floor.evidenceRequirements) requirements.add(item);
  }
  return { handleRequired, evidenceRequirements: [...requirements] };
}
