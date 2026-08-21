/**
 * Host deterministic-bind authority namespace.
 *
 * A host-compiled admitted plan mints its grounding receipt and write
 * authority under this identity. The namespace is RESERVED: any identity a
 * MODEL port returns that matches it is refused at the binding boundary
 * (bindPlanGroundingReceipt / judgeAdmittedWrite), and the physical-dispatch
 * validator accepts it only when the plan re-proves itself — a from-scratch
 * recompute out of durable inputs the model has no write access to (the
 * user's accepted bytes, the frozen catalog snapshot, host-loaded policy)
 * must reproduce the persisted digests byte-for-byte.
 *
 * Host authority is therefore not a bypass: it is the only authority variety
 * that is RE-PROVABLE at dispatch time. A model receipt attests an opinion;
 * a host compile digest attests a computation anyone can run again.
 */
import { createHash } from 'node:crypto';

export const HOST_BIND_IDENTITY = 'host:deterministic-bind/v1';

export const HOST_AUTHORITY_RE = /^host:deterministic-bind\/v\d+$/;

export function isHostAuthorityIdentity(identity: unknown): boolean {
  return typeof identity === 'string' && HOST_AUTHORITY_RE.test(identity);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

/**
 * The backward link of the digest chain: binds a host-compiled proposal to
 * inputs no model can write. Deterministic — no clock, no randomness.
 */
export function hostCompileDigest(input: {
  compilerVersion: string;
  inputHash: string;
  audienceHash: string;
  policyRevision: string;
  catalogSnapshotDigest: string;
  proposalDigest: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    v: 1,
    compiler: 'host-deterministic-bind',
    compilerVersion: input.compilerVersion,
    inputHash: input.inputHash,
    audienceHash: input.audienceHash,
    policyRevision: input.policyRevision,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    proposalDigest: input.proposalDigest,
  }), 'utf8').digest('hex');
}
