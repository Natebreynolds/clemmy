/**
 * The admission envelope: everything a running attempt may know about its own
 * authority, capability, and budget — fixed at admission, immutable while it
 * runs (Clem 4 Stage 4 foundation).
 *
 * The charter's no-ambient-policy rule is the reason this module exists.
 * Executors and node runners must not read environment variables, global
 * settings, or UI preferences mid-run; they receive an envelope and can
 * receive nothing else. On-demand tool acquisition therefore CANNOT be envelope mutation — it
 * is a content-addressed CapabilityBindingRevision that selects additional
 * bindings WITHIN the admitted universe. Revisions are monotonic (a later
 * revision contains every earlier binding, so prompt prefixes stay cacheable
 * and prior nodes keep exact identity) and narrowing-only (a revision can
 * never name a capability, account, or effect class the envelope did not
 * admit). Needing more than the envelope admits is not an expansion — it is a
 * PAUSE and a re-admission as a new attempt with new digests. Never call
 * authority widening "tool expansion."
 *
 * Pure: crypto digests and validation only. No filesystem, no environment,
 * no clock. The admission boundary that PARSES environment into an envelope
 * lives with the caller; this module owns the contract.
 */
import { createHash } from 'node:crypto';

// ── the admitted universe ────────────────────────────────────────────────────

export interface AdmittedCapability {
  /** Dispatchable identifier (tool name, slug, command). */
  name: string;
  /** Fingerprint of the callable schema. Co-travels with the name: a
   *  capability whose schema the run cannot see is not admitted. */
  schemaFingerprint: string;
  /** The widest effect this capability may perform in this attempt. */
  effectClass: 'read' | 'write' | 'send';
  /** Stable account identity it binds through; '' for accountless. */
  accountIdentity: string;
}

export interface EnvelopeBudget {
  maxUncachedTokens: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxElapsedMs: number;
}

export interface AdmissionEnvelopeInput {
  /** Logical turn / attempt identity this envelope is admitted for. */
  attemptId: string;
  tenant: string;
  workspace: string;
  /** Immutable policy snapshot hash (owned by the policy boundary). */
  policyHash: string;
  /** Effect ceiling for the whole attempt. Nothing inside may exceed it. */
  effectCeiling: 'read' | 'write' | 'send';
  /** The full admitted capability universe, schemas co-travelling. */
  capabilities: readonly AdmittedCapability[];
  budget: EnvelopeBudget;
}

export interface AdmissionEnvelope extends AdmissionEnvelopeInput {
  /** Content digest over everything above — the attempt's authority identity. */
  envelopeDigest: string;
}

export interface EnvelopeRefusal {
  ok: false;
  errors: string[];
}

export type EnvelopeResult = { ok: true; envelope: AdmissionEnvelope } | EnvelopeRefusal;

const EFFECT_RANK: Record<'read' | 'write' | 'send', number> = { read: 0, write: 1, send: 2 };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/**
 * Seal an envelope. Refuses a capability that exceeds the attempt's effect
 * ceiling — an envelope that contains its own violation would make every
 * later check a lie — refuses schema-less capabilities, rotating connection
 * ids as account identity, and non-finite budgets. The capability list is
 * canonically ordered inside the digest so construction order is not
 * identity.
 */
export function sealAdmissionEnvelope(input: AdmissionEnvelopeInput): EnvelopeResult {
  const errors: string[] = [];
  if (!input.attemptId.trim()) errors.push('attemptId is required');
  if (!input.policyHash.trim()) errors.push('policyHash is required');
  for (const [field, value] of Object.entries(input.budget)) {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`budget.${field} must be finite and positive; got ${String(value)}`);
    }
  }
  const seen = new Set<string>();
  for (const capability of input.capabilities) {
    if (!capability.name.trim()) errors.push('a capability requires a name');
    if (!capability.schemaFingerprint.trim()) {
      errors.push(`capability "${capability.name}" has no schema fingerprint — an advertised carrier must co-travel its callable schema`);
    }
    if (/^ca_/i.test(capability.accountIdentity)) {
      errors.push(`capability "${capability.name}" binds a rotating connection id; use the stable account identity`);
    }
    if (EFFECT_RANK[capability.effectClass] > EFFECT_RANK[input.effectCeiling]) {
      errors.push(`capability "${capability.name}" (${capability.effectClass}) exceeds the attempt's effect ceiling (${input.effectCeiling})`);
    }
    const key = `${capability.name}|${capability.accountIdentity}`;
    if (seen.has(key)) errors.push(`capability "${capability.name}" is admitted twice for one account`);
    seen.add(key);
  }
  if (errors.length > 0) return { ok: false, errors };

  const canonical = {
    attemptId: input.attemptId,
    tenant: input.tenant,
    workspace: input.workspace,
    policyHash: input.policyHash,
    effectCeiling: input.effectCeiling,
    capabilities: [...input.capabilities]
      .map((capability) => ({ ...capability }))
      .sort((a, b) => (a.name + a.accountIdentity < b.name + b.accountIdentity ? -1 : 1)),
    budget: { ...input.budget },
  };
  return {
    ok: true,
    envelope: Object.freeze({
      ...canonical,
      envelopeDigest: sha256(stableJson(canonical)),
    }),
  };
}

// ── capability binding revisions ─────────────────────────────────────────────

/**
 * The bindings a node actually sees: an ordered, append-only selection from
 * the admitted universe. Revision N+1 contains every binding of revision N —
 * the monotonic property that keeps the stable prompt prefix cacheable and
 * lets every node journal the exact revision it bound.
 */
export interface CapabilityBindingRevision {
  revision: number;
  envelopeDigest: string;
  /** Names selected from the envelope's capability universe, append-only. */
  bound: readonly string[];
  /** Content digest over (envelopeDigest, revision, bound). */
  revisionDigest: string;
}

export type RevisionResult =
  | { ok: true; revision: CapabilityBindingRevision }
  /** The request names something OUTSIDE the envelope. This is not a tool
   *  expansion — it is an authority boundary, and the only lawful response
   *  is to pause and re-admit a new attempt. */
  | { ok: false; kind: 'requires_readmission'; outside: string[] }
  | { ok: false; kind: 'invalid'; errors: string[] };

export function initialBindingRevision(
  envelope: AdmissionEnvelope,
  bound: readonly string[],
): RevisionResult {
  return appendBindings(envelope, null, bound);
}

/**
 * Append bindings to a revision. Monotonic by construction: the previous
 * revision's bindings are always carried, deduplicated, order preserved.
 * A name outside the admitted universe refuses with `requires_readmission`
 * and the exact outsiders named, so the pause is actionable.
 */
export function appendBindings(
  envelope: AdmissionEnvelope,
  previous: CapabilityBindingRevision | null,
  additions: readonly string[],
): RevisionResult {
  if (previous && previous.envelopeDigest !== envelope.envelopeDigest) {
    return { ok: false, kind: 'invalid', errors: ['revision belongs to a different envelope'] };
  }
  const universe = new Set(envelope.capabilities.map((capability) => capability.name));
  const outside = [...new Set(additions.filter((name) => !universe.has(name)))];
  if (outside.length > 0) return { ok: false, kind: 'requires_readmission', outside };

  const bound: string[] = [...(previous?.bound ?? [])];
  for (const name of additions) if (!bound.includes(name)) bound.push(name);
  const revision = (previous?.revision ?? 0) + 1;
  return {
    ok: true,
    revision: Object.freeze({
      revision,
      envelopeDigest: envelope.envelopeDigest,
      bound: Object.freeze(bound) as readonly string[],
      revisionDigest: sha256(stableJson({ envelopeDigest: envelope.envelopeDigest, revision, bound })),
    }),
  };
}

/**
 * Verify the monotonic chain property a journal replay depends on: every
 * revision extends its predecessor exactly — same envelope, +1 numbering, and
 * a strict prefix relationship on bindings. A chain that reorders or drops a
 * binding would invalidate every cached prefix and every node's recorded
 * identity, so it refuses loudly.
 */
export function validateRevisionChain(
  envelope: AdmissionEnvelope,
  chain: readonly CapabilityBindingRevision[],
): { ok: true } | EnvelopeRefusal {
  const errors: string[] = [];
  chain.forEach((entry, index) => {
    if (entry.envelopeDigest !== envelope.envelopeDigest) {
      errors.push(`revision ${entry.revision} belongs to a different envelope`);
      return;
    }
    if (entry.revision !== index + 1) {
      errors.push(`revision numbering breaks at position ${index}: expected ${index + 1}, got ${entry.revision}`);
    }
    const previous = index > 0 ? chain[index - 1]! : null;
    if (previous) {
      const prefixIntact = previous.bound.every((name, i) => entry.bound[i] === name);
      if (!prefixIntact) {
        errors.push(`revision ${entry.revision} reordered or dropped earlier bindings — monotonicity broken`);
      }
    }
    const expected = sha256(stableJson({
      envelopeDigest: entry.envelopeDigest,
      revision: entry.revision,
      bound: [...entry.bound],
    }));
    if (entry.revisionDigest !== expected) {
      errors.push(`revision ${entry.revision} digest does not match its content`);
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
