/**
 * HOST DETERMINISTIC COMPILE — the fast lane that kills the admission
 * ceremony for asks the host can prove end-to-end.
 *
 * Live 2026-08-19 sess-mt0c3kkc: "top 5 restaurants → Google sheet" paid 97
 * seconds and six brain/judge calls to author a plan the host could already
 * derive: the connected goal catalog proves search + row-create + readback
 * from frozen schemas, host-bind synthesizes the exact 5-op chain, and every
 * receipt digest is host-computed even on the model path. When ALL the
 * deterministic classifiers fire, the host authors the proposal itself —
 * validated by the SAME admitTurnSemantics, ground through the SAME
 * bindPlanGroundingReceipt — under the reserved host authority identity,
 * with zero model calls.
 *
 * Everything here is a pure function of durable bytes: the user's accepted
 * text, the frozen catalog, durable capability-resolution rows. That is what
 * makes host authority acceptable at dispatch time — the plan can be
 * RECOMPUTED from scratch and must reproduce the persisted digests
 * byte-for-byte (see installHostCompiledGroundingVerifier).
 *
 * When any classifier declines, the model ceremony runs unchanged. No flags.
 */
import { createHash } from 'node:crypto';
import { canonicalProposalPayloadHash, type TurnSemanticProposalV1 } from './turn-semantic-proposal.js';
import { HOST_BIND_IDENTITY, hostCompileDigest } from './host-authority.js';
import {
  normalizedFamily,
  synthesizeConstructOperations,
  type HostBoundOperation,
} from './host-bind-operations.js';
import { catalogEntriesForAcceptedSource } from '../harness/indexed-capability-catalog.js';

export const HOST_COMPILER_VERSION = 'v1';

const MAX_FAST_LANE_COUNT = 25;
const MAX_FAST_LANE_TEXT = 8_000;

/**
 * Deterministic cardinality: the ask states how many items to collect.
 * Conservative — a miss falls to the model ceremony, never guesses.
 */
export function extractCollectCount(text: string): number | null {
  const patterns = [
    /\b(?:top|first|best|biggest|largest|leading)\s+(\d{1,3})\b/i,
    /\b(\d{1,3})\s+(?:best|top|biggest|largest|leading)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const count = Number(match[1]);
      if (Number.isSafeInteger(count) && count >= 1 && count <= MAX_FAST_LANE_COUNT) return count;
      return null;
    }
  }
  return null;
}

/**
 * Catalog-driven destination family: the ask names a family some registered
 * create-capable capability actually carries. The family vocabulary comes
 * from the catalog (via the same normalizer host-bind uses), never from a
 * hardcoded provider list. Tokens are checked in text order; the first
 * catalog family the text names wins — deterministic.
 */
export function deriveDestinationFamily(text: string, availableFamilies: readonly string[]): string | null {
  const families = new Set(availableFamilies.map((family) => normalizedFamily(family)).filter(Boolean));
  if (families.size === 0) return null;
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    const family = normalizedFamily(token);
    if (family && families.has(family)) return family;
  }
  return null;
}

/**
 * The host-authored proposal. PURE function of (text, count, family) — the
 * recompute verifier rebuilds these exact bytes at dispatch time, so every
 * member including rationale is deterministic. Operations stay EMPTY here:
 * the same host-bind splice that serves the model lane binds them after
 * admission, and the grounding receipt covers the spliced set.
 */
export function buildHostProposal(input: {
  acceptedText: string;
  count: number;
  family: string;
}): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: input.acceptedText.trim(),
      criteria: [
        { id: 'crit-collect', statement: `collect exactly ${input.count} items named by the request` },
        { id: 'crit-construct', statement: `create one new ${input.family} destination containing the collected items` },
      ],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: { count: input.count, fields: [] },
      destination: { posture: 'create_new', family: input.family, handleRequired: true },
      requestedEffect: 'external_write',
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: HOST_BIND_IDENTITY,
  };
}

export interface HostDeterministicCompileResult {
  proposal: TurnSemanticProposalV1;
  count: number;
  family: string;
  operations: HostBoundOperation[];
}

/**
 * The classifier + compile. Null = decline (model ceremony runs unchanged).
 * Role-structural and provider-agnostic: fires for any toolkit whose frozen
 * schemas prove the goal roles, never for a named provider.
 */
export function hostDeterministicCompile(input: {
  acceptedText: string;
  identity: { sessionId: string; sourceUserSeq: number };
  /** Open goals/questions in scope → the turn may be a continuation; decline. */
  hasOpenContext: boolean;
  /** Standing policy effects — a write the policy would refuse declines here
   *  so the model ceremony produces the existing honest refusal semantics. */
  allowedEffects: ReadonlyArray<string>;
}): HostDeterministicCompileResult | null {
  try {
    const text = input.acceptedText.trim();
    if (!text || text.length > MAX_FAST_LANE_TEXT) return null;
    if (input.hasOpenContext) return null;
    if (!input.allowedEffects.includes('external_write')) return null;
    const count = extractCollectCount(text);
    if (count === null) return null;

    // Families this source can actually create into, from the same catalog
    // host-bind uses: frozen snapshot ∩ (proofs ∪ connect-time index hits).
    const catalog = catalogEntriesForAcceptedSource({
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      objective: text,
    });
    const createFamilies = catalog
      .filter((entry) => entry.effect === 'external_write' || entry.effect === 'local_write')
      .map((entry) => entry.destination?.family ?? entry.manifest?.destination?.family ?? '')
      .filter(Boolean);
    const family = deriveDestinationFamily(text, createFamilies);
    if (!family) return null;

    // The whole chain must bind against frozen schemas — the same probes the
    // executor's argument compiler will run. Partial proof declines.
    const operations = synthesizeConstructOperations({
      construct: 'collect_then_construct',
      objective: text,
      destinationFamily: family,
      effectCeiling: 'external_write',
      count,
      identity: input.identity,
    });
    if (!operations || operations.length === 0) return null;

    return { proposal: buildHostProposal({ acceptedText: text, count, family }), count, family, operations };
  } catch {
    return null; // a compile failure is a decline, never a crash
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Dispatch-time recompute for host-compiled records. Rebuilds the proposal
 * from durable inputs the model cannot write and requires byte-identity with
 * the persisted digests. Installed on the physical-dispatch guard by
 * configureTypedExecutionRuntime.
 */
export function verifyHostCompiledRecord(input: {
  record: {
    groundingIdentity?: string;
    groundingProposalDigest?: string;
    groundingCatalogDigest?: string;
    hostCompileDigest?: string;
    hostCompilerVersion?: string;
    inputHash?: string;
    audienceHash?: string;
    policyRevision?: string;
  };
  identity?: { sessionId: string; sourceUserSeq: number };
  /** Injected durable-text loader (keeps this module eventlog-free). */
  loadAcceptedText: (identity: { sessionId: string; sourceUserSeq: number }) => string | null;
}): { ok: true } | { ok: false; reason: string } {
  const { record, identity } = input;
  if (!identity) return { ok: false, reason: 'host_authority_unproven' };
  if (record.hostCompilerVersion !== HOST_COMPILER_VERSION) {
    return { ok: false, reason: 'host_compile_recompute_mismatch' };
  }
  if (!record.hostCompileDigest || !/^[a-f0-9]{64}$/i.test(record.hostCompileDigest)) {
    return { ok: false, reason: 'host_authority_unproven' };
  }
  const text = input.loadAcceptedText(identity);
  if (!text || sha256(text) !== record.inputHash) {
    return { ok: false, reason: 'host_compile_source_mismatch' };
  }
  const compiled = hostDeterministicCompile({
    acceptedText: text,
    identity,
    hasOpenContext: false,
    allowedEffects: ['external_write'],
  });
  if (!compiled) return { ok: false, reason: 'host_compile_recompute_mismatch' };
  const recomputedProposalDigest = canonicalProposalPayloadHash(compiled.proposal);
  if (recomputedProposalDigest !== record.groundingProposalDigest) {
    return { ok: false, reason: 'host_compile_recompute_mismatch' };
  }
  const recomputedCompileDigest = hostCompileDigest({
    compilerVersion: HOST_COMPILER_VERSION,
    inputHash: record.inputHash ?? '',
    audienceHash: record.audienceHash ?? '',
    policyRevision: record.policyRevision ?? '',
    catalogSnapshotDigest: record.groundingCatalogDigest ?? '',
    proposalDigest: recomputedProposalDigest,
  });
  if (recomputedCompileDigest !== record.hostCompileDigest) {
    return { ok: false, reason: 'host_compile_recompute_mismatch' };
  }
  return { ok: true };
}
