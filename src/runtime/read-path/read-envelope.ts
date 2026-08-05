/**
 * The read lane's sealed authority (v3.8.0/D1).
 *
 * The chat surface's capability envelope is instrumentation: it seals with
 * placeholder tenancy ('local'), a blank workspace, the session id standing in
 * for an attempt, and a universal 'send' ceiling, and its comments defer
 * enforcement. The generic cold-to-warm READ lane cannot run on that: its
 * envelope carries REAL identity, its ceiling is `read` by construction, and
 * absence of authority is refusal — unknown means unknown, never unlimited.
 *
 * Everything here composes the EXISTING primitives: sealAdmissionEnvelope for
 * the universe, CapabilityBindingRevision for monotonic binding, MCP scope by
 * intersection. No second resolver, no route table, and no provider or
 * operation name anywhere in this module — identity and authority only.
 */
import { createHash } from 'node:crypto';

import {
  appendBindings,
  initialBindingRevision,
  sealAdmissionEnvelope,
  type AdmissionEnvelope,
  type AdmittedCapability,
  type CapabilityBindingRevision,
  type EnvelopeBudget,
} from '../graph/admission-envelope.js';

export interface ReadLaneIdentity {
  /** Real tenant/user identity — never the placeholder 'local' by default. */
  tenant: string;
  /** Real workspace/project identity. */
  workspace: string;
  /** The accepted turn this lane runs for. */
  acceptedTurnId: string;
  /** The activation (finite budgeted window) this lane runs inside. */
  activationId: string;
  /**
   * STABLE logical account identity (normalized mailbox/handle). The rotating
   * provider connection is resolved live at DISPATCH by the account broker —
   * it never enters authority identity.
   */
  accountIdentity: string;
  /** Immutable policy snapshot hash. */
  policyHash: string;
  /** Version of the sealed finite budget contract (C3). */
  budgetVersion: string;
}

export interface ReadLaneEnvelope {
  identity: ReadLaneIdentity;
  envelope: AdmissionEnvelope;
  revision: CapabilityBindingRevision;
  /** Digest over identity + envelope + revision — the lane's authority id. */
  laneDigest: string;
}

export type ReadLaneSealResult =
  | { ok: true; lane: ReadLaneEnvelope }
  | { ok: false; errors: string[] };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Seal the read lane's authority.
 *
 * Refusals, all fail-closed:
 *  - empty tenant/workspace/turn/activation/policy/budget identity (a
 *    placeholder authority is no authority);
 *  - any capability whose effect class is not `read` (a write or send
 *    capability may not even be NAMED under this ceiling — exit to the
 *    governed path happens before authority, not after);
 *  - a capability without a co-travelling schema fingerprint;
 *  - a rotating `ca_...` account identity anywhere.
 */
export function sealReadLaneEnvelope(input: {
  identity: ReadLaneIdentity;
  /** The connected READ capability universe, schemas co-travelling. */
  capabilities: readonly AdmittedCapability[];
  /** Names active at revision 1 (may equal the whole universe). */
  activeCapabilityNames: readonly string[];
  budget: EnvelopeBudget;
}): ReadLaneSealResult {
  const errors: string[] = [];
  for (const [field, value] of Object.entries({
    tenant: input.identity.tenant,
    workspace: input.identity.workspace,
    acceptedTurnId: input.identity.acceptedTurnId,
    activationId: input.identity.activationId,
    policyHash: input.identity.policyHash,
    budgetVersion: input.identity.budgetVersion,
  })) {
    if (!String(value ?? '').trim()) {
      errors.push(`identity.${field} is required — a placeholder authority is no authority`);
    }
  }
  if (!input.identity.accountIdentity.trim()) {
    errors.push('identity.accountIdentity is required — an empty account identity must not seal');
  }
  if (/^ca_/i.test(input.identity.accountIdentity)) {
    errors.push('identity.accountIdentity is a rotating connection id; bind the stable logical account');
  }
  for (const capability of input.capabilities) {
    if (capability.effectClass !== 'read') {
      errors.push(`capability "${capability.name}" is ${capability.effectClass} — no write or send capability may appear under the read ceiling`);
    }
    if (capability.accountIdentity && capability.accountIdentity !== input.identity.accountIdentity) {
      errors.push(`capability "${capability.name}" binds account "${capability.accountIdentity}", not the lane's stable account — one lane, one account`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const sealed = sealAdmissionEnvelope({
    attemptId: `${input.identity.acceptedTurnId}:${input.identity.activationId}`,
    tenant: input.identity.tenant,
    workspace: input.identity.workspace,
    policyHash: input.identity.policyHash,
    effectCeiling: 'read',
    capabilities: input.capabilities,
    budget: input.budget,
  });
  if (!sealed.ok) return sealed;

  const revision = initialBindingRevision(sealed.envelope, input.activeCapabilityNames);
  if (!revision.ok) {
    return {
      ok: false,
      errors: revision.kind === 'requires_readmission'
        ? [`active surface names capabilities outside the sealed read universe: ${revision.outside.join(', ')}`]
        : revision.errors,
    };
  }
  return {
    ok: true,
    lane: Object.freeze({
      identity: Object.freeze({ ...input.identity }),
      envelope: sealed.envelope,
      revision: revision.revision,
      laneDigest: sha256(JSON.stringify({
        identity: input.identity,
        envelopeDigest: sealed.envelope.envelopeDigest,
        revisionDigest: revision.revision.revisionDigest,
      })),
    }),
  };
}

/**
 * Compose the lane's universe with an MCP scope by INTERSECTION: a name is
 * dispatchable only when both authorities admit it. Neither side can widen
 * the other; an absent MCP scope contributes nothing (it does not mean
 * "everything").
 */
export function intersectWithMcpScope(
  lane: ReadLaneEnvelope,
  mcpAllowedNames: readonly string[] | null,
): Set<string> {
  // The existing MCP authority contract treats null as DENY. An absent
  // authority contributes nothing — it never widens to everything.
  if (mcpAllowedNames === null) return new Set();
  const allowed = new Set(mcpAllowedNames);
  return new Set(lane.revision.bound.filter((name) => allowed.has(name)));
}

/** Injected durable revision storage: CAS by the previous revision digest. */
export interface RevisionStore {
  load(key: string): CapabilityBindingRevision | undefined;
  cas(key: string, expectedDigest: string | undefined, next: CapabilityBindingRevision): boolean;
}

/** In-process fallback registry — convergence semantics for callers that
 *  have not injected a durable store yet. Keyed by envelope+attempt. */
const REVISION_REGISTRY = new Map<string, CapabilityBindingRevision>();

function registryStore(): RevisionStore {
  return {
    load: (key) => REVISION_REGISTRY.get(key),
    cas: (key, expectedDigest, next) => {
      const current = REVISION_REGISTRY.get(key);
      if ((current?.revisionDigest ?? undefined) !== expectedDigest) return false;
      REVISION_REGISTRY.set(key, next);
      return true;
    },
  };
}

export type LaneAcquisition =
  | { ok: true; lane: ReadLaneEnvelope }
  | { ok: false; kind: 'requires_readmission'; outside: string[] }
  | { ok: false; kind: 'invalid'; errors: string[] };

/**
 * Acquire a capability WITHIN the admitted universe as the next monotonic
 * binding revision. Outside-universe acquisition returns the typed
 * `requires_readmission` — logging and continuing is forbidden; the caller
 * pauses and re-admits. Sequential await-serialized appends cannot lose one
 * another (each new lane object carries the previous revision).
 */
export function acquireLaneBinding(
  lane: ReadLaneEnvelope,
  name: string,
  store: RevisionStore = registryStore(),
): LaneAcquisition {
  // Durable monotonic acquisition (F24): CAS against the CURRENT stored
  // revision; a losing caller retries from the winner, so two concurrent
  // acquisitions converge on BOTH bindings instead of losing one.
  const key = `${lane.envelope.envelopeDigest}:${lane.identity.acceptedTurnId}:${lane.identity.activationId}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = store.load(key) ?? lane.revision;
    if (current.bound.includes(name)) {
      return { ok: true, lane: laneWithRevision(lane, current) };
    }
    const appended = appendBindings(lane.envelope, current, [name]);
    if (!appended.ok) {
      return appended.kind === 'requires_readmission'
        ? { ok: false, kind: 'requires_readmission', outside: appended.outside }
        : { ok: false, kind: 'invalid', errors: appended.errors };
    }
    const expected = store.load(key)?.revisionDigest
      ?? (current === lane.revision ? undefined : current.revisionDigest);
    if (store.cas(key, expected, appended.revision)) {
      return { ok: true, lane: laneWithRevision(lane, appended.revision) };
    }
    // Lost the race: retry from the winning revision.
  }
  return { ok: false, kind: 'invalid', errors: ['binding acquisition lost eight CAS rounds — the store is livelocked'] };
}

function laneWithRevision(lane: ReadLaneEnvelope, revision: CapabilityBindingRevision): ReadLaneEnvelope {
  return Object.freeze({
    ...lane,
    revision,
    laneDigest: sha256(JSON.stringify({
      identity: lane.identity,
      envelopeDigest: lane.envelope.envelopeDigest,
      revisionDigest: revision.revisionDigest,
    })),
  });
}

/** A dispatch-time membership check: a tool absent from the ACTIVE bound
 *  revision cannot dispatch, whatever the model asked for. */
export function laneAdmitsDispatch(lane: ReadLaneEnvelope, name: string): boolean {
  return lane.revision.bound.includes(name)
    && lane.envelope.capabilities.some((capability) => capability.name === name);
}

/** The exact bound dispatch (F26): identity, not a name lookup. */
export interface BoundReadDispatch {
  acceptedSource: string;
  activationId: string;
  laneDigest: string;
  envelopeDigest: string;
  revisionDigest: string;
  tenant: string;
  workspace: string;
  accountIdentity: string;
  identifier: string;
  provider: string;
  operation: string;
  schemaFingerprint: string;
  effectClass: 'read';
  args: Record<string, unknown>;
}

export type BoundDispatchResult =
  | { ok: true; dispatch: BoundReadDispatch }
  | { ok: false; reason: string };

/**
 * Bind a dispatch to the lane's full authority: active revision membership,
 * the capability's schema fingerprint and account, the read effect class,
 * and the lane/envelope/revision identity — a bare name match dispatches
 * nothing.
 */
export function boundDispatchFor(
  lane: ReadLaneEnvelope,
  input: { identifier: string; provider: string; operation: string; args: Record<string, unknown> },
): BoundDispatchResult {
  if (!lane.revision.bound.includes(input.identifier)) {
    return { ok: false, reason: `"${input.identifier}" is not in the active bound revision` };
  }
  const capability = lane.envelope.capabilities.find((candidate) => candidate.name === input.identifier);
  if (!capability) {
    return { ok: false, reason: `"${input.identifier}" is not in the admitted universe` };
  }
  if (capability.effectClass !== 'read') {
    return { ok: false, reason: `"${input.identifier}" is ${capability.effectClass} — the lane dispatches reads only` };
  }
  if (capability.accountIdentity && capability.accountIdentity !== lane.identity.accountIdentity) {
    return { ok: false, reason: `"${input.identifier}" binds a different account than the lane` };
  }
  return {
    ok: true,
    dispatch: {
      acceptedSource: lane.identity.acceptedTurnId,
      activationId: lane.identity.activationId,
      laneDigest: lane.laneDigest,
      envelopeDigest: lane.envelope.envelopeDigest,
      revisionDigest: lane.revision.revisionDigest,
      tenant: lane.identity.tenant,
      workspace: lane.identity.workspace,
      accountIdentity: lane.identity.accountIdentity,
      identifier: input.identifier,
      provider: input.provider,
      operation: input.operation,
      schemaFingerprint: capability.schemaFingerprint,
      effectClass: 'read',
      args: input.args,
    },
  };
}
