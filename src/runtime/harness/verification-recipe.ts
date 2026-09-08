import { createHash } from 'node:crypto';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import type {
  CanonicalCatalogIdentityV1,
  RegisteredHostCapability,
} from './host-capability-catalog-factory.js';

/**
 * A frozen execution recipe for verifying one mutation.
 *
 * The business graph holds only the work a person asked for. Verification is
 * not business work and is never model-authored: the host derives an exact
 * recipe from the current manifests at plan time, freezes it onto the
 * mutation's own sealed binding, and later executes it as a deterministic child
 * call through the ordinary host invocation kernel.
 *
 * Live 2026-08-26: a natural two-operation plan (create a sheet, write its
 * header row) was admitted, the sheet was really created, and only then did the
 * dependent write discover that a mutation discharges solely against a
 * host-issued readback the plan never contained. Teaching a model to author the
 * ceremony does not hold — the next plan omits it again. Deriving it does.
 *
 * The recipe AUTHORIZES CONSTRUCTION of the verifier call. It grants no
 * physical dispatch: lease, admission, settlement and proof all remain with the
 * kernels that already own them.
 *
 * Nothing here reads a provider, toolkit or operation NAME. Selection is by
 * manifest facts only — effect, account, provider kind, resource family, the
 * handle a mutation produces, and the readback contract a capability declares.
 * Provider-shaped request/response projection lives at the catalog edge and is
 * referenced from here by identity, never inlined.
 */

export type VerificationProofKind =
  /** The resource exists and is the one the mutation claims to have made. */
  | 'resource_identity_v1'
  /** The content read back is exactly the content the mutation asked for. */
  | 'reversible_exact_content_v1';

export type VerificationTargetSource =
  | 'owner_result_resource_id'
  | 'verified_predecessor_resource_id'
  | 'owner_write_target';

export interface VerificationRecipeV1 {
  readonly version: 1;
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  readonly ownerBindingDigest: string;
  readonly proof: VerificationProofKind;
  /** Exact canonical identity of the capability that will do the reading. */
  readonly verifier: CanonicalCatalogIdentityV1;
  readonly targetSource: VerificationTargetSource;
  /** Argument paths that must carry the exact target id. */
  readonly requestTargetPointers: readonly string[];
  /** Versioned projector that reads the resource id out of a response. */
  readonly responseProjector: string;
  /** Verifier arguments fixed at freeze time (a range, a field mask). */
  readonly staticArgs: Readonly<Record<string, unknown>>;
  readonly recipeDigest: string;
}

export type VerificationRecipeResult =
  | { readonly ok: true; readonly recipe: VerificationRecipeV1 }
  | {
      readonly ok: false;
      readonly code: 'verification_successor_required';
      readonly detail: string;
      readonly requirementId: string;
    };

const MUTATION_EFFECTS = new Set(['external_write', 'local_write', 'admin']);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

export function verificationRecipeDigest(recipe: Omit<VerificationRecipeV1, 'recipeDigest'>): string {
  return createHash('sha256').update(canonicalJson(recipe), 'utf8').digest('hex');
}

/**
 * The proof a mutation's own manifest demands.
 *
 * `contentDigestRequired` is the manifest's own statement that this operation
 * has intended content worth comparing. A create that provisions an empty
 * resource says false, and demanding content proof from it demands a document
 * that cannot exist — the requirement then never discharges however faithfully
 * the readback ran.
 */
export function proofKindForMutation(manifest: CapabilityManifestV1): VerificationProofKind | null {
  const readback = manifest.readbackContract;
  const evidenceReadback = manifest.evidenceContract?.readbackRequired === true;
  if (!readback?.required && !evidenceReadback) return null;
  return readback?.contentDigestRequired ? 'reversible_exact_content_v1' : 'resource_identity_v1';
}

function sameAccount(mutation: CapabilityManifestV1, verifier: CapabilityManifestV1): boolean {
  const left = (mutation.accountId ?? '').trim();
  return left.length > 0 && left === (verifier.accountId ?? '').trim();
}

function sameProvider(mutation: CapabilityManifestV1, verifier: CapabilityManifestV1): boolean {
  return mutation.providerKind === verifier.providerKind
    && (mutation.providerIdentity ?? '').trim() === (verifier.providerIdentity ?? '').trim();
}

function sameResourceFamily(mutation: CapabilityManifestV1, verifier: CapabilityManifestV1): boolean {
  const family = (mutation.destination?.family ?? '').trim().toLowerCase();
  if (!family) return false;
  if ((verifier.destination?.family ?? '').trim().toLowerCase() === family) return true;
  return verifier.applicableDeliverableKinds
    .some((kind) => kind.trim().toLowerCase() === family);
}

/** The verifier must accept the handle the mutation hands back. */
function acceptsProducedHandle(mutation: CapabilityManifestV1, verifier: CapabilityManifestV1): boolean {
  const produced = new Set([
    ...mutation.producedOutputKinds.map((kind) => kind.trim().toLowerCase()),
    (mutation.outputContract?.kind ?? '').trim().toLowerCase(),
  ].filter(Boolean));
  if (produced.size === 0) return false;
  return verifier.acceptedInputKinds.some((kind) => produced.has(kind.trim().toLowerCase()));
}

/**
 * A verifier must DECLARE itself one.
 *
 * Accepting inputs is not a declaration — nearly every read accepts inputs, and
 * treating that as qualification would let an unrelated search stand in as
 * proof that a specific resource exists. The capability's own manifest has to
 * say it reads a resource back, which the catalog edge sets from the operation's
 * exact shape.
 */
function declaresReadbackPurpose(verifier: CapabilityManifestV1): boolean {
  return verifier.readbackContract?.required === true
    && verifier.acceptedInputKinds.length > 0;
}

export function compatibleVerifiers(input: {
  readonly mutation: CapabilityManifestV1;
  readonly catalog: readonly RegisteredHostCapability[];
}): readonly RegisteredHostCapability[] {
  return input.catalog.filter((entry) => {
    const manifest = entry.manifest;
    if (!manifest || entry.effect !== 'read' || manifest.effect !== 'read') return false;
    if (manifest.manifestId === input.mutation.manifestId) return false;
    return sameAccount(input.mutation, manifest)
      && sameProvider(input.mutation, manifest)
      && sameResourceFamily(input.mutation, manifest)
      && acceptsProducedHandle(input.mutation, manifest)
      && declaresReadbackPurpose(manifest);
  });
}

/**
 * The same compatibility question asked of the planning card.
 *
 * At plan time the host holds provider-neutral DESCRIPTORS; the full manifests
 * are resolved later, at seal time. Both tiers must answer identically, or a
 * plan could pass preflight and then fail to freeze — creating exactly the
 * dead-end this whole mechanism exists to prevent. So this mirrors
 * `compatibleVerifiers` field for field, on the descriptor projection of the
 * same facts.
 */
export interface VerifierDescriptorFacts {
  readonly id: string;
  readonly effect: string;
  readonly accountScope: string;
  readonly acceptedInputKinds: readonly string[];
  readonly producedOutputKinds: readonly string[];
  readonly applicableDeliverableKinds: readonly string[];
  readonly deliverableKind: string;
  readonly outputKind: string;
  readonly readbackRequired: boolean;
}

export function compatibleVerifierDescriptors(input: {
  readonly mutation: VerifierDescriptorFacts;
  readonly candidates: readonly VerifierDescriptorFacts[];
}): readonly VerifierDescriptorFacts[] {
  const account = (input.mutation.accountScope ?? '').trim();
  const family = (input.mutation.deliverableKind ?? '').trim().toLowerCase();
  const produced = new Set([
    ...input.mutation.producedOutputKinds.map((kind) => kind.trim().toLowerCase()),
    (input.mutation.outputKind ?? '').trim().toLowerCase(),
  ].filter(Boolean));
  if (!account || !family || produced.size === 0) return [];
  return input.candidates.filter((candidate) => {
    if (candidate.effect !== 'read' || candidate.id === input.mutation.id) return false;
    // Same declaration bar as the manifest tier: accepting inputs is not
    // qualification. Both tiers must answer identically or a plan could pass
    // preflight and then fail to freeze — recreating the dead-end exactly.
    if (!candidate.readbackRequired) return false;
    if ((candidate.accountScope ?? '').trim() !== account) return false;
    const sameFamily = (candidate.deliverableKind ?? '').trim().toLowerCase() === family
      || candidate.applicableDeliverableKinds
        .some((kind) => kind.trim().toLowerCase() === family);
    if (!sameFamily) return false;
    return candidate.acceptedInputKinds.some((kind) => produced.has(kind.trim().toLowerCase()));
  });
}

/**
 * Freeze one verification recipe for one mutation.
 *
 * Zero or several compatible verifiers is a refusal, and the caller must refuse
 * the whole plan on it — BEFORE any mutation crosses. A partially verifiable
 * plan is exactly the shape that creates something it can never close out.
 */
export function deriveVerificationRecipe(input: {
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  readonly ownerBindingDigest: string;
  readonly ownerEffect: string;
  readonly mutation: CapabilityManifestV1;
  readonly catalog: readonly RegisteredHostCapability[];
  readonly canonicalIdentityOf: (entry: RegisteredHostCapability) => CanonicalCatalogIdentityV1 | null;
  readonly targetSource: VerificationTargetSource;
  readonly requestTargetPointers: readonly string[];
  readonly responseProjector: string;
  readonly staticArgs?: Readonly<Record<string, unknown>>;
}): VerificationRecipeResult {
  const refuse = (detail: string): VerificationRecipeResult => ({
    ok: false, code: 'verification_successor_required',
    requirementId: input.ownerRequirementId, detail,
  });

  if (!MUTATION_EFFECTS.has(input.ownerEffect)) {
    return refuse(`"${input.ownerRequirementId}" is not a mutation and needs no verification recipe`);
  }
  const proof = proofKindForMutation(input.mutation);
  if (!proof) {
    return refuse(`"${input.ownerRequirementId}" declares no readback contract, so no proof kind is determinable`);
  }
  if (input.requestTargetPointers.length === 0 || !input.responseProjector.trim()) {
    return refuse(
      `"${input.ownerRequirementId}" has no exact request target pointer or response projector; `
      + 'the catalog edge must declare how its resource id is carried and returned',
    );
  }

  const candidates = compatibleVerifiers({ mutation: input.mutation, catalog: input.catalog });
  if (candidates.length === 0) {
    return refuse(
      `no disclosed read capability can read back "${input.ownerRequirementId}" `
      + '(same provider and account, same resource family, accepting the handle it returns)',
    );
  }
  if (candidates.length > 1) {
    return refuse(
      `${candidates.length} disclosed read capabilities could read back "${input.ownerRequirementId}"; `
      + 'exactly one exact verifier must be determinable before any mutation runs',
    );
  }
  const verifier = input.canonicalIdentityOf(candidates[0]!);
  if (!verifier) {
    return refuse(`the verifier for "${input.ownerRequirementId}" has no canonical catalog identity`);
  }

  const draft = {
    version: 1 as const,
    acceptedTaskId: input.acceptedTaskId,
    workContractId: input.workContractId,
    ownerRequirementId: input.ownerRequirementId,
    ownerBindingDigest: input.ownerBindingDigest,
    proof,
    verifier,
    targetSource: input.targetSource,
    requestTargetPointers: [...input.requestTargetPointers],
    responseProjector: input.responseProjector,
    staticArgs: { ...(input.staticArgs ?? {}) },
  };
  return { ok: true, recipe: { ...draft, recipeDigest: verificationRecipeDigest(draft) } };
}

/**
 * Deterministic identity for one verifier call.
 *
 * Derived only from durable facts, so the same source and the same durable
 * target reproduce the same identity in a new process. That is what lets a
 * settled verifier replay after restart with zero new provider crossings
 * instead of dispatching a second time.
 */
export function verifierLogicalCallId(input: {
  readonly acceptedTaskId: string;
  readonly workContractId: string;
  readonly ownerRequirementId: string;
  readonly ownerBindingDigest: string;
  readonly recipeDigest: string;
  readonly proof: VerificationProofKind;
  /** Empty until the target is known; a targetless identity is never dispatched. */
  readonly targetDigest: string;
}): string {
  const digest = createHash('sha256').update(canonicalJson({
    version: 1,
    acceptedTaskId: input.acceptedTaskId,
    workContractId: input.workContractId,
    ownerRequirementId: input.ownerRequirementId,
    ownerBindingDigest: input.ownerBindingDigest,
    recipeDigest: input.recipeDigest,
    proof: input.proof,
    targetDigest: input.targetDigest,
  }), 'utf8').digest('hex');
  return `verify:${input.ownerRequirementId}:${digest.slice(0, 32)}`;
}

export function verificationTargetDigest(resourceId: string): string {
  return createHash('sha256').update(`resource:${resourceId}`, 'utf8').digest('hex');
}
