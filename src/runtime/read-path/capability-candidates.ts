/**
 * Candidate-assisted routing (v3.8.0/F2).
 *
 * This is the whole of what retrieval is allowed to do: given the accepted
 * request, produce a small, scoped set of PROVEN capabilities worth putting in
 * front of the brain. It does not choose an effect, arguments, or an account,
 * and it never authorizes a dispatch. The brain still selects; the governed
 * boundary still gates. A wrong candidate costs one ordinary cold turn.
 *
 * Two tiers, in cost order:
 *
 *   EXACT/LEXICAL (synchronous, always available) — the existing tool-choice
 *   matcher, which now also resolves an exact accepted-source alias. A phrase
 *   that already settled successfully retrieves its capability on repeat even
 *   though it never names the tool.
 *
 *   SEMANTIC (local model, deadline-bounded) — natural paraphrases. Runs ONLY
 *   against the bundled local model, only when it is already warm, and only
 *   inside a request-scoped deadline. A cold model warms in the background and
 *   the turn proceeds on the lexical tier: a chat turn never waits on a model
 *   load, and semantic retrieval being unavailable degrades the experience by
 *   one cold turn rather than breaking it.
 */
import { createHash } from 'node:crypto';
import {
  backfillCapabilityAliasEmbeddings,
  acceptedPhraseDigest,
  boundedAliasTerms,
  capabilityAliasVerifiedReadOrigin,
  daemonAliasScope,
  lookupExactCapabilityAliasAuthorityHints,
  lookupExactCapabilityAliases,
  semanticCapabilityAliasAuthorityHints,
  semanticCapabilityAliases,
  type CapabilityAliasRow,
  type CapabilityAliasScope,
} from '../../memory/capability-alias-index.js';
import {
  getLocalEmbeddingProvider,
  localEmbeddingProviderSync,
  localEmbeddingSpaceKey,
} from '../../memory/embeddings.js';
import {
  ensureLiveComposioSchemaFingerprint,
  getCachedToolSchema,
  liveComposioSchemaFingerprint,
} from '../../tools/composio-schema-cache.js';
import {
  listToolChoices,
  toolFamilyForChoice,
  type MatchToolChoicesOptions,
  type StepToolChoiceMatch,
  type ToolChoiceRecord,
} from '../../memory/tool-choice-store.js';
import type { VerifiedReadCapabilityOrigin } from '../../memory/verified-read-origin.js';
import {
  capabilityEffectIsCompatible,
  requestedCapabilityEffectScope,
  type CapabilityEffect,
  type RequestedCapabilityEffectScope,
} from '../../memory/capability-effect-scope.js';
import { requestSemanticSegments } from '../../assistant/request-segments.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import { detectMultiItemIntent } from '../harness/multi-item-intent.js';
import { compileAcceptedGoal, type AcceptedGoalV1 } from '../graph/accepted-goal.js';
import {
  validatedTurnSourceStrategyBinding,
  type TurnSourceStrategyBindingV1,
} from '../harness/turn-control.js';
import {
  canonicalVerifiedReadResultShape,
  recoverCanonicalVerifiedReadOriginForAlias,
  verifiedReadOriginMatchesAliasDigest,
  verifiedReadOriginIsCanonical,
  type CanonicalVerifiedReadResultShape,
} from './verified-read-origin-authority.js';
import {
  capabilityCandidateKey,
  diversifyCapabilities,
  lexicalCapabilityProjectionForRequest,
  type CapabilityRequirementSegment,
  type RoleScopedStepToolChoiceMatch,
} from './lexical-capability-matches.js';

export type CapabilityCandidateTier = 'exact' | 'semantic';

export type CapabilityCandidate = {
  identifier: string;
  kind: string;
  intent: string;
  /** Always `capability_only` today: retrieval never carries execution rights. */
  klass: string;
  /** The stable account this capability was proven against, when bound. */
  accountIdentity?: string;
  via: CapabilityCandidateTier;
  score: number;
  /** Receipt-backed aliases are read; legacy lexical rows may be unknown. */
  effectClass?: CapabilityEffect;
  /** Live request contract, when this daemon has current provider authority. */
  requiredFields?: string[];
  schemaFingerprint?: string;
  schemaAuthority?: 'live' | 'validation_only' | 'missing' | 'not_applicable';
  /** Runtime-owned requirement identity; never derived from provider/query words. */
  roleKey?: string;
  /** One proven operation may satisfy more than one clause. */
  roleKeys?: string[];
  /** Requirement roles this candidate has structural evidence to resolve.
   * Medium lexical overlaps stay advisory and are intentionally absent. */
  resolutionRoleKeys?: string[];
  requirementIndex?: number;
  requirementText?: string;
  requestedEffect?: RequestedCapabilityEffectScope;
  /** Private receipt pointer used only to materialize/revalidate a source
   * strategy binding. It is never rendered to the model. */
  verifiedReadOrigin?: VerifiedReadCapabilityOrigin;
  /** True only when provenance was joined to this exact alias row, not borrowed
   * from a procedure-wide latest origin. */
  verifiedReadAliasSpecific?: true;
  /** Stored provider contract attached to the canonical read receipt. Private:
   * a source may bind only when this is exactly the current live contract. */
  verifiedReadSchemaFingerprint?: string;
  /** Shared non-generic source terms. Used only to keep a weak semantic hit
   * (for example unrelated Slack history) from becoming source authority. */
  sourceLexicalSupport?: number;
  /** Receipt-result fit for this exact source alias. Private ranking evidence,
   * never rendered and never execution authority. */
  sourceTaskFit?: number;
  sourceProjectionCoverage?: number;
  sourceCardinalityFit?: number;
  sourceRecordCount?: number;
  sourceStructurallyEligible?: true;
};

export interface CapabilityRequirementDescriptor extends CapabilityRequirementSegment {
  resolved: boolean;
  /** Exact capabilities that resolve this requirement, with live schema keys. */
  resolvedCapabilities: CapabilityCandidate[];
}

export type TurnCapabilityCandidates = {
  candidates: CapabilityCandidate[];
  /** Source-ordered requirements, including genuinely unresolved roles. */
  requirements: CapabilityRequirementDescriptor[];
  /** Advisory matches for the existing MCP recall seam. */
  matches: StepToolChoiceMatch[];
  /** Tool names to pin into the turn's JIT surface. */
  pinnedTools: string[];
  /** Whether the semantic tier actually participated in THIS turn. */
  semanticApplied: boolean;
  /** Whether the accepted request is action-shaped and therefore consumes
   * role-scoped discovery. Omitted by legacy fixtures, which remain enabled. */
  roleScopedDiscovery?: boolean;
  /** A unique, receipt-revalidated source strategy for collect+construct
   * preflight. Advisory retrieval still grants no dispatch authority. */
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
};

const DEFAULT_LIMIT = 5;
/** A request-scoped ceiling. A warm local embed is ~3ms; this is the point at
 *  which we stop waiting and answer from the lexical tier instead. */
const DEFAULT_DEADLINE_MS = 120;

function requiredFields(schema: Record<string, unknown> | null): string[] {
  const value = schema?.required;
  return Array.isArray(value)
    ? value.filter((field): field is string => typeof field === 'string').slice(0, 20)
    : [];
}

function attachLiveContract(
  candidate: CapabilityCandidate,
  liveFingerprintFor: (identifier: string) => string | null | undefined = liveComposioSchemaFingerprint,
): CapabilityCandidate {
  if (candidate.kind !== 'composio') {
    return { ...candidate, schemaAuthority: 'not_applicable' };
  }
  const schema = getCachedToolSchema(candidate.identifier);
  const fingerprint = liveFingerprintFor(candidate.identifier);
  if (fingerprint && schema) {
    return {
      ...candidate,
      schemaAuthority: 'live',
      schemaFingerprint: fingerprint,
      requiredFields: requiredFields(schema),
    };
  }
  return {
    ...candidate,
    schemaAuthority: schema ? 'validation_only' : 'missing',
  };
}

function candidateFromMatch(
  match: RoleScopedStepToolChoiceMatch,
  record: ToolChoiceRecord | undefined,
  liveFingerprintFor?: (identifier: string) => string | null | undefined,
): CapabilityCandidate {
  return attachLiveContract({
    identifier: match.identifier,
    kind: match.kind,
    intent: match.intent,
    klass: 'capability_only',
    ...(match.accountIdentity ? { accountIdentity: match.accountIdentity } : {}),
    via: 'exact',
    score: match.score,
    ...(match.effectClass ? { effectClass: match.effectClass } : {}),
    roleKey: match.roleKey,
    roleKeys: [match.roleKey],
    resolutionRoleKeys: match.tier === 'high' || match.acceptedPhraseAlias === true
      ? [match.roleKey]
      : [],
    requirementIndex: match.requirementIndex,
    requirementText: match.requirementText,
    requestedEffect: match.requestedEffect,
    ...(match.verifiedReadOrigin ? { verifiedReadOrigin: match.verifiedReadOrigin } : {}),
    ...(match.verifiedReadOrigin && record?.choice?.schemaFingerprint
      ? { verifiedReadSchemaFingerprint: record.choice.schemaFingerprint }
      : {}),
    sourceLexicalSupport: match.matched.length,
  }, liveFingerprintFor);
}

function candidateFromAlias(
  row: CapabilityAliasRow,
  score: number,
  requirement: CapabilityRequirementSegment,
  origin: VerifiedReadCapabilityOrigin | null,
  via: CapabilityCandidateTier = 'semantic',
  liveFingerprintFor?: (identifier: string) => string | null | undefined,
  sourceFit?: SourceTaskFit,
): CapabilityCandidate {
  return attachLiveContract({
    identifier: row.identifier,
    kind: row.kind,
    intent: row.intent,
    klass: row.klass,
    ...(row.accountIdentity ? { accountIdentity: row.accountIdentity } : {}),
    via,
    score,
    // The semantic alias index is materialized only from verified successful
    // read receipts; writes never enter this retrieval class.
    effectClass: 'read',
    // Semantic similarity is advisory evidence that this read may fit; it is
    // not evidence that an open-vocabulary clause itself is a read. Preserve
    // the runtime-owned role exactly and let only exact lexical receipt
    // agreement refine an unknown effect.
    roleKey: requirement.roleKey,
    roleKeys: [requirement.roleKey],
    resolutionRoleKeys: requirement.effect !== 'unknown' ? [requirement.roleKey] : [],
    requirementIndex: requirement.clauseIndex,
    requirementText: requirement.text,
    requestedEffect: requirement.effect,
    ...(origin ? { verifiedReadOrigin: origin, verifiedReadAliasSpecific: true as const } : {}),
    ...(row.schemaFingerprint ? { verifiedReadSchemaFingerprint: row.schemaFingerprint } : {}),
    sourceLexicalSupport: sourceTermSupport(requirement.text, row.terms),
    ...(sourceFit
      ? {
          sourceTaskFit: sourceFit.score,
          sourceProjectionCoverage: sourceFit.projectionCoverage,
          sourceCardinalityFit: sourceFit.cardinalityFit,
          sourceRecordCount: sourceFit.recordCount,
          ...(sourceFit.eligible ? { sourceStructurallyEligible: true as const } : {}),
        }
      : {}),
  }, liveFingerprintFor);
}

function recordForMatch(
  match: Pick<RoleScopedStepToolChoiceMatch, 'kind' | 'identifier' | 'accountIdentity'>,
  records: readonly ToolChoiceRecord[],
): ToolChoiceRecord | undefined {
  return records.find((record) => record.choice?.kind === match.kind
    && record.choice.identifier.toLowerCase() === match.identifier.toLowerCase()
    && (record.choice.accountIdentity ?? '') === (match.accountIdentity ?? ''));
}

function sourceTerm(token: string): string {
  return token.length > 4 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
}

function sourceTermSupport(requirementText: string, aliasTerms: readonly string[]): number {
  const requestTerms = new Set(boundedAliasTerms(requirementText).map(sourceTerm));
  return new Set(aliasTerms.map(sourceTerm).filter((term) => requestTerms.has(term))).size;
}

const PHYSICAL_REQUIREMENT_STOP_TERMS = new Set([
  'action', 'based', 'create', 'data', 'each', 'find', 'give', 'google',
  'make', 'new', 'number', 'return', 'task', 'tool', 'using', 'with',
]);

/** CTC incident rows may carry the whole objective as an alias. A physical
 * capability still has to name a meaningful noun from its assigned clause;
 * objective prose alone cannot turn a source operation into a destination. */
function physicalIdentifierSupportsRequirement(identifier: string, requirementText: string): boolean {
  const identifierTerms = boundedAliasTerms(identifier.replace(/[_:./-]+/g, ' ')).map(sourceTerm);
  const requirementTerms = boundedAliasTerms(requirementText)
    .map(sourceTerm)
    .filter((term) => term.length >= 4 && !PHYSICAL_REQUIREMENT_STOP_TERMS.has(term));
  return requirementTerms.some((term) => identifierTerms.some((physical) =>
    physical === term || physical.includes(term) || term.includes(physical)));
}

type SourceTaskFit = {
  score: number;
  projectionCoverage: number;
  cardinalityFit: number;
  recordCount: number;
  eligible: boolean;
};

const PROJECTION_QUALIFIERS = new Set(['field', 'number', 'value']);
const PROJECTION_TERM_ALIASES = new Map<string, string>([
  // Structured collection APIs commonly expose an entity's display name as
  // `title`. This is a schema-level synonym, not a provider/tool hint.
  ['title', 'name'],
]);

function sourceProjectionTerm(token: string): string {
  const normalized = sourceTerm(token);
  return PROJECTION_TERM_ALIASES.get(normalized) ?? normalized;
}

function projectionCoverage(
  projection: readonly string[],
  shape: CanonicalVerifiedReadResultShape,
  requestedCount: number,
): number {
  if (projection.length === 0) return 1;
  if (!shape.recordsInspectedCompletely || shape.recordFieldSignatures.length === 0) return 0;
  // A bounded collection needs the requested set to carry every projected
  // field, not every extra record a provider happened to return. Live Apify
  // proof returned 25 ordered Maps records for a five-row request; the first
  // five were field-complete while one unused later record lacked a phone.
  // Requiring all 25 would reject stronger evidence for returning a superset.
  const boundedRecords = requestedCount > 0
    ? shape.recordFieldSignatures.slice(0, requestedCount)
    : shape.recordFieldSignatures;
  if (requestedCount > 0 && boundedRecords.length < requestedCount) return 0;
  let covered = 0;
  for (const field of projection) {
    const terms = boundedAliasTerms(field)
      .map(sourceProjectionTerm)
      .filter((term) => !PROJECTION_QUALIFIERS.has(term));
    if (terms.length === 0) continue;
    if (boundedRecords.every((recordSignatures) =>
      recordSignatures.some((signature) => {
        const available = new Set(signature.map(sourceProjectionTerm));
        return terms.every((term) => available.has(term));
      }))) covered += 1;
  }
  return covered / projection.length;
}

function sourceCardinalityFit(requestedCount: number, observedCount: number): number {
  if (requestedCount <= 0 || observedCount <= 0) return 0;
  return Math.min(requestedCount, observedCount) / Math.max(requestedCount, observedCount);
}

function sourceModalityFit(
  requirementText: string,
  shape: CanonicalVerifiedReadResultShape,
): number {
  const requested = boundedAliasTerms(requirementText)
    .map(sourceTerm)
    .filter((term) => term.length >= 4 && !PHYSICAL_REQUIREMENT_STOP_TERMS.has(term));
  if (requested.length === 0) return 0;
  const evidence = new Set([
    ...shape.fieldSignatures.flat().map(sourceTerm),
    ...shape.locatorTerms.map(sourceTerm),
  ]);
  const shared = new Set(requested.filter((term) => evidence.has(term))).size;
  return Math.min(1, shared / Math.min(4, new Set(requested).size));
}

function explicitCapabilityNamespaceFit(input: string, identifier: string): number {
  const namespace = sourceTerm(identifier.replace(/^cx_/i, '').split(/[_:./\s-]+/)[0] ?? '');
  if (namespace.length < 3) return 0;
  return boundedAliasTerms(input).map(sourceTerm).includes(namespace) ? 1 : 0;
}

function taskFitForSource(input: {
  acceptedText: string;
  goal: AcceptedGoalV1;
  requirement: CapabilityRequirementSegment;
  identifier: string;
  semanticScore: number;
  shape: CanonicalVerifiedReadResultShape | null;
}): SourceTaskFit | undefined {
  const explicitFit = explicitCapabilityNamespaceFit(input.acceptedText, input.identifier);
  if (!input.shape) {
    return explicitFit > 0
      ? {
          score: input.semanticScore + explicitFit,
          projectionCoverage: 0,
          cardinalityFit: 0,
          recordCount: 0,
          eligible: false,
        }
      : undefined;
  }
  const requestedCount = input.goal.collection?.count ?? 0;
  const projected = projectionCoverage(
    input.goal.collection?.projection ?? [],
    input.shape,
    requestedCount,
  );
  const cardinality = sourceCardinalityFit(requestedCount, input.shape.recordCount);
  const modality = sourceModalityFit(input.requirement.text, input.shape);
  return {
    // Structured requested fields and exact cardinality dominate generic text
    // similarity. Explicitly naming a capability namespace is fresh authority.
    score: (projected * 0.5)
      + (cardinality * 0.25)
      + (modality * 0.15)
      + (input.semanticScore * 0.1)
      + explicitFit,
    projectionCoverage: projected,
    cardinalityFit: cardinality,
    recordCount: input.shape.recordCount,
    eligible: input.shape.recordsInspectedCompletely
      && input.shape.recordCount >= requestedCount
      && projected === 1,
  };
}

function canonicalOriginForAlias(
  row: CapabilityAliasRow,
  _records: readonly ToolChoiceRecord[],
): VerifiedReadCapabilityOrigin | null {
  const storedOrigin = capabilityAliasVerifiedReadOrigin(row);
  if (storedOrigin
    && verifiedReadOriginMatchesAliasDigest(storedOrigin, row.aliasDigest)
    && verifiedReadOriginIsCanonical({
    origin: storedOrigin,
    identifier: row.identifier,
    accountIdentity: row.accountIdentity,
    schemaFingerprint: row.schemaFingerprint ?? undefined,
  })) return storedOrigin;
  // A procedure's latest origin never vouches for its historical aliases. The
  // only legacy recovery is the exact accepted-phrase + receipt + settlement
  // join owned by the read-path verifier.
  return recoverCanonicalVerifiedReadOriginForAlias(row);
}

const MAX_SOURCE_SCHEMA_REFRESHES = 3;
const MIN_SEMANTIC_SOURCE_SHARED_TERMS = 2;
const DOMINANT_SOURCE_SCORE_DELTA = 0.08;
const SOURCE_AUTHORITY_HINT_LIMIT = 25;
const SOURCE_STRUCTURAL_HINT_FLOOR = 0.60;

type SourceSchemaRefreshState = {
  attempted: Set<string>;
  remaining: number;
};

async function ensureCanonicalSourceSchema(input: {
  kind: string;
  identifier: string;
  storedFingerprint?: string | null;
  liveFingerprintFor: (identifier: string) => string | null | undefined;
  ensureLiveFingerprintFor?: (identifier: string) => Promise<string | null | undefined>;
  refreshState: SourceSchemaRefreshState;
}): Promise<boolean> {
  if (input.kind !== 'composio') return true;
  const stored = input.storedFingerprint?.trim();
  if (!stored) return false;
  if (input.liveFingerprintFor(input.identifier) === stored) return true;
  if (!input.ensureLiveFingerprintFor) return false;
  const key = input.identifier.toLowerCase();
  if (!input.refreshState.attempted.has(key)) {
    if (input.refreshState.remaining <= 0) return false;
    input.refreshState.attempted.add(key);
    input.refreshState.remaining -= 1;
    await input.ensureLiveFingerprintFor(input.identifier).catch(() => undefined);
  }
  return input.liveFingerprintFor(input.identifier) === stored;
}

function sourceCandidateHasCurrentAuthority(candidate: CapabilityCandidate): boolean {
  if (candidate.kind !== 'composio') return true;
  return candidate.schemaAuthority === 'live'
    && Boolean(candidate.verifiedReadSchemaFingerprint)
    && candidate.schemaFingerprint === candidate.verifiedReadSchemaFingerprint;
}

function readSourceRole(roleKey: string | undefined): boolean {
  return Boolean(roleKey && /:read$/.test(roleKey));
}

function sourceCapabilityBinding(candidate: CapabilityCandidate): TurnSourceStrategyBindingV1['primary'] {
  return {
    capabilityId: `capability:${candidate.kind}:${candidate.identifier}`,
    ...(candidate.accountIdentity ? { accountIdentity: candidate.accountIdentity } : {}),
    ...(candidate.schemaFingerprint ? { schemaFingerprint: candidate.schemaFingerprint } : {}),
  };
}

function materializeSourceStrategyBinding(
  input: string,
  candidates: readonly CapabilityCandidate[],
  goal = compileAcceptedGoal({ text: input, multiItem: detectMultiItemIntent(input) }),
): TurnSourceStrategyBindingV1 | undefined {
  if (goal.construct !== 'collect_then_construct'
    || !goal.destination
    || (goal.effectCeiling !== 'external_write' && goal.effectCeiling !== 'local_write')) return undefined;
  const verifiedSources = candidates
    .filter((candidate) => candidate.effectClass === 'read'
      && candidate.verifiedReadOrigin
      && candidate.verifiedReadAliasSpecific === true
      && candidate.sourceStructurallyEligible === true
      && sourceCandidateHasCurrentAuthority(candidate)
      && (candidate.resolutionRoleKeys ?? []).some((roleKey) => readSourceRole(roleKey))
      && (candidate.via !== 'semantic'
        || (candidate.sourceLexicalSupport ?? 0) >= MIN_SEMANTIC_SOURCE_SHARED_TERMS))
    .sort((left, right) => ((right.sourceTaskFit ?? right.score) - (left.sourceTaskFit ?? left.score))
      || left.identifier.localeCompare(right.identifier));
  const primary = verifiedSources[0];
  if (!primary) return undefined;
  const runnerUp = verifiedSources[1];
  // Historical evidence may recommend a source only when it is unique or
  // meaningfully dominant. An alphabetical tie is not a user decision.
  if (runnerUp
    && (primary.sourceTaskFit ?? primary.score) - (runnerUp.sourceTaskFit ?? runnerUp.score)
      < DOMINANT_SOURCE_SCORE_DELTA) return undefined;
  // Ranking is deterministic and provider-neutral; other verified reads remain
  // explicit bounded fallbacks rather than becoming a fresh provider search.
  const primaryBinding = sourceCapabilityBinding(primary);
  const equivalentFallbacks = verifiedSources.slice(1, 4).map(sourceCapabilityBinding);
  const topology = 'single_aggregate_read_then_single_artifact_write' as const;
  const effect = goal.effectCeiling;
  const topologyDigest = createHash('sha256').update(JSON.stringify({
    topology,
    primary: primaryBinding,
    equivalentFallbacks,
    destination: goal.destination,
    effect,
  })).digest('hex');
  return {
    version: 1,
    primary: primaryBinding,
    equivalentFallbacks,
    topology,
    topologyDigest,
    destination: {
      family: goal.destination.family,
      posture: goal.destination.posture,
    },
    effect,
  };
}

function mergeCandidate(
  current: CapabilityCandidate | undefined,
  incoming: CapabilityCandidate,
): CapabilityCandidate {
  if (!current) return incoming;
  const roleKeys = [...new Set([
    ...(current.roleKeys ?? (current.roleKey ? [current.roleKey] : [])),
    ...(incoming.roleKeys ?? (incoming.roleKey ? [incoming.roleKey] : [])),
  ])];
  const resolutionRoleKeys = [...new Set([
    ...(current.resolutionRoleKeys ?? []),
    ...(incoming.resolutionRoleKeys ?? []),
  ])];
  const currentRank = current.sourceTaskFit ?? current.score;
  const incomingRank = incoming.sourceTaskFit ?? incoming.score;
  const preferred = incomingRank > currentRank ? incoming : current;
  return {
    ...preferred,
    ...(roleKeys.length > 0 ? { roleKey: roleKeys[0], roleKeys } : {}),
    resolutionRoleKeys,
  };
}


/** Whether a candidate's known effect class is compatible with the role's
 *  requested effect. Only a positive read/write CONTRADICTION disqualifies —
 *  unknowns on either side stay admissible (advisory evidence is handled by
 *  the tiers above; this guard exists so the wrong-class pin cannot spend the
 *  role's only search slot). */
export function effectClassMayCloseRole(
  candidateEffect: CapabilityEffect | undefined,
  requirementEffect: RequestedCapabilityEffectScope,
): boolean {
  if (!candidateEffect || candidateEffect === 'unknown') return true;
  if (requirementEffect === 'read') return candidateEffect === 'read';
  if (requirementEffect === 'write') return candidateEffect === 'write';
  return true;
}

function describeRequirements(
  requirements: readonly CapabilityRequirementSegment[],
  candidates: readonly CapabilityCandidate[],
): CapabilityRequirementDescriptor[] {
  return requirements.map((requirement) => {
    const roleCandidates = candidates.filter((candidate) =>
      (candidate.roleKeys ?? (candidate.roleKey ? [candidate.roleKey] : []))
        .includes(requirement.roleKey));
    // A strong lexical/exact-phrase match is structural evidence. Medium
    // overlap remains advisory even when its effect agrees: one generic action
    // token cannot let a stale memo settle a destination role. Semantic hits
    // populate this key only for known effects and never rewrite unknown roles.
    const resolvedCapabilities = roleCandidates.filter((candidate) =>
      candidate.resolutionRoleKeys?.includes(requirement.roleKey)
      // Advertise-tier MCP names are observational. They must not close a
      // role: the live miss was an unattached SEO tool resolving a mixed
      // find+write clause and denying the only search slot.
      && candidate.kind !== 'mcp'
      // EFFECT COMPATIBILITY: a proven capability of the WRONG effect class
      // can never close a role. Live 2026-08-21 ("what's on my calendar"):
      // a remembered create-event WRITE pin lexically matched the READ
      // clause, closed its role, and the governor then denied all seven
      // tool_searches (role_not_unresolved) — the turn had no read path and
      // parked. A candidate with an unknown/absent effect stays admissible;
      // only a POSITIVE mismatch is disqualifying.
      && effectClassMayCloseRole(candidate.effectClass, requirement.effect));
    // A mixed clause is two jobs. Remembered Slack/Sheets/SEO pins must not
    // mark the whole request resolved and spend the only search slot.
    const resolved = requirement.effect === 'mixed'
      ? false
      : resolvedCapabilities.length > 0;
    return {
      ...requirement,
      resolved,
      resolvedCapabilities,
    };
  });
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load the local model and give every stored alias a vector in the current
 * space. Production calls this once at startup (fire-and-forget); settlements
 * schedule their own incremental backfill so a mid-life learning event never
 * waits for the next boot.
 */
export async function warmCapabilityRetrieval(
  options: { scope?: CapabilityAliasScope } = {},
): Promise<boolean> {
  return backfillCapabilityAliasEmbeddings(options);
}

/**
 * The candidates worth showing the brain for THIS request. Advisory only.
 */
export async function resolveTurnCapabilityCandidates(options: {
  userInput: string;
  scope?: CapabilityAliasScope;
  limit?: number;
  deadlineMs?: number;
  liveSchemaFingerprintFor?: (identifier: string) => string | null | undefined;
  /** Deterministic metadata-only refresh seam. Omit with a custom live lookup
   * to keep fixtures offline; production uses the exact-slug Composio helper. */
  ensureLiveSchemaFingerprintFor?: (identifier: string) => Promise<string | null | undefined>;
  /** Deterministic fixture seam. Production reads the active procedural store. */
  choices?: MatchToolChoicesOptions['choices'];
  /** Semantic retrieval is on by default; tests may isolate the lexical class. */
  semantic?: boolean;
}): Promise<TurnCapabilityCandidates> {
  const input = options.userInput?.trim();
  if (!input) {
    return {
      candidates: [], requirements: [], matches: [], pinnedTools: [],
      semanticApplied: false, roleScopedDiscovery: false,
    };
  }
  const requestIntent = classifyMessageIntent(input).intent;
  const roleScopedDiscovery = requestIntent === 'action' || requestIntent === 'tool_intent';
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));
  const scope = options.scope ?? daemonAliasScope();
  const multiItem = detectMultiItemIntent(input);
  const acceptedGoal = compileAcceptedGoal({ text: input, multiItem });
  const collectThenConstructSourceResolution = acceptedGoal.construct === 'collect_then_construct'
    && Boolean(acceptedGoal.destination)
    && (acceptedGoal.effectCeiling === 'external_write' || acceptedGoal.effectCeiling === 'local_write');
  const liveFingerprintFor = options.liveSchemaFingerprintFor ?? liveComposioSchemaFingerprint;
  const ensureLiveFingerprintFor = options.ensureLiveSchemaFingerprintFor
    ?? (options.liveSchemaFingerprintFor ? undefined : ensureLiveComposioSchemaFingerprint);
  const refreshState: SourceSchemaRefreshState = {
    attempted: new Set<string>(),
    remaining: MAX_SOURCE_SCHEMA_REFRESHES,
  };
  const records = (() => {
    try { return options.choices ?? listToolChoices(); } catch { return []; }
  })();

  let matches: RoleScopedStepToolChoiceMatch[] = [];
  let requirements: CapabilityRequirementSegment[] = [];
  try {
    const projection = lexicalCapabilityProjectionForRequest({
      userInput: input,
      limit,
      scope,
      liveSchemaFingerprintFor: options.liveSchemaFingerprintFor,
      choices: options.choices,
    });
    matches = projection.matches.filter((match) => !match.verifiedReadOrigin
      || verifiedReadOriginIsCanonical({
        origin: match.verifiedReadOrigin,
        identifier: match.identifier,
        accountIdentity: match.accountIdentity ?? '',
        schemaFingerprint: records.find((record) => record.choice?.identifier === match.identifier)
          ?.choice?.schemaFingerprint,
      }));
    requirements = projection.requirements;
  } catch { /* retrieval never fails a turn */ }

  const byIdentifier = new Map<string, CapabilityCandidate>();
  for (const match of matches) {
    // For a collect→construct source, procedure prose is not provenance. The
    // exact alias index below must join the phrase to its own canonical receipt;
    // an originless DataForSEO write or unrelated remembered read stays out of
    // this source role without affecting legitimate destination/write matches.
    if (collectThenConstructSourceResolution && readSourceRole(match.roleKey)) continue;
    if (collectThenConstructSourceResolution
      && !physicalIdentifierSupportsRequirement(match.identifier, match.requirementText)) continue;
    const record = recordForMatch(match, records);
    const candidate = candidateFromMatch(match, record, liveFingerprintFor);
    const key = capabilityCandidateKey(candidate);
    byIdentifier.set(key, mergeCandidate(byIdentifier.get(key), candidate));
  }
  // The alias index preserves one row per account, while the canonical
  // procedure projection may expose only the latest alias path for one intent.
  // Materialize exact receipt-backed rows directly so retrieval never chooses
  // an account merely because a legacy intent file was superseded.
  const exactRequirement = requirements.find((requirement) => requirement.effect === 'read')
    ?? requirements.find((requirement) => requirement.effect === 'unknown');
  if (exactRequirement) {
    if (collectThenConstructSourceResolution) {
      const authorityHints = lookupExactCapabilityAliasAuthorityHints(acceptedPhraseDigest(input), { scope });
      for (const row of authorityHints) {
        const origin = canonicalOriginForAlias(row, records);
        if (!origin) continue;
        await ensureCanonicalSourceSchema({
          kind: row.kind,
          identifier: row.identifier,
          storedFingerprint: row.schemaFingerprint,
          liveFingerprintFor,
          ensureLiveFingerprintFor,
          refreshState,
        });
      }
    }
    const exactRows = lookupExactCapabilityAliases(acceptedPhraseDigest(input), {
      scope,
      liveSchemaFingerprintFor: liveFingerprintFor,
    });
    for (const row of exactRows) {
      const origin = canonicalOriginForAlias(row, records);
      if (!origin) continue;
      const shape = canonicalVerifiedReadResultShape({
        origin,
        identifier: row.identifier,
        aliasDigest: row.aliasDigest,
        accountIdentity: row.accountIdentity,
        schemaFingerprint: row.schemaFingerprint ?? undefined,
      });
      const sourceFit = collectThenConstructSourceResolution
        ? taskFitForSource({
            acceptedText: input,
            goal: acceptedGoal,
            requirement: exactRequirement,
            identifier: row.identifier,
            semanticScore: 1,
            shape,
          })
        : undefined;
      if (collectThenConstructSourceResolution
        && sourceFit?.eligible !== true) continue;
      const candidate = candidateFromAlias(
        row,
        1,
        exactRequirement,
        origin,
        'exact',
        liveFingerprintFor,
        sourceFit,
      );
      if (collectThenConstructSourceResolution
        && readSourceRole(candidate.roleKey)
        && !sourceCandidateHasCurrentAuthority(candidate)) continue;
      const key = capabilityCandidateKey(candidate);
      byIdentifier.set(key, mergeCandidate(byIdentifier.get(key), candidate));
    }
  }

  // Semantic tier: only against an ALREADY WARM local model, inside the
  // request deadline. A cold model warms in the background for later turns.
  let semanticApplied = false;
  const provider = options.semantic === false ? null : localEmbeddingProviderSync();
  if (provider) {
    const semanticRequirements = requirements.length > 0
      ? requirements
      : requestSemanticSegments(input).map((text, clauseIndex) => ({
          text,
          clauseIndex,
          effect: requestedCapabilityEffectScope(text),
          roleKey: `clause-${clauseIndex}:${requestedCapabilityEffectScope(text)}`,
        }));
    const semanticSegments = semanticRequirements.map((requirement) => (
      collectThenConstructSourceResolution
      && requirement.effect === 'read'
      && (acceptedGoal.collection?.projection.length ?? 0) > 0
        ? `${requirement.text}; return ${acceptedGoal.collection!.projection.join(' and ')}`
        : requirement.text
    ));
    const vectors = await withDeadline(
      provider.embed(semanticSegments).catch(() => null),
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );
    if (vectors?.some(Boolean)) {
      semanticApplied = true;
      for (let index = 0; index < semanticSegments.length; index += 1) {
        const query = vectors?.[index];
        if (!query) continue;
        const requestedEffect = requestedCapabilityEffectScope(semanticSegments[index] ?? input);
        const requirement = semanticRequirements[index];
        if (!requirement) continue;
        const origins = new Map<CapabilityAliasRow, VerifiedReadCapabilityOrigin>();
        const sourceFits = new Map<CapabilityAliasRow, SourceTaskFit>();
        let hits: ReturnType<typeof semanticCapabilityAliases>;
        if (collectThenConstructSourceResolution && requirement.effect === 'read') {
          // A cold schema cache must not delete a proven source before it can
          // reacquire authority. Hints remain private until exact alias origin,
          // relevance, and stored-vs-live contract checks all pass.
          const authorityHints = semanticCapabilityAliasAuthorityHints(query, {
            scope,
            embeddingSpace: localEmbeddingSpaceKey(),
            limit: SOURCE_AUTHORITY_HINT_LIMIT,
            floor: SOURCE_STRUCTURAL_HINT_FLOOR,
          });
          hits = [];
          for (const hit of authorityHints) {
            if (sourceTermSupport(requirement.text, hit.row.terms) < MIN_SEMANTIC_SOURCE_SHARED_TERMS) continue;
            const origin = canonicalOriginForAlias(hit.row, records);
            if (!origin) continue;
            const shape = canonicalVerifiedReadResultShape({
              origin,
              identifier: hit.row.identifier,
              aliasDigest: hit.row.aliasDigest,
              accountIdentity: hit.row.accountIdentity,
              schemaFingerprint: hit.row.schemaFingerprint ?? undefined,
            });
            const sourceFit = taskFitForSource({
              acceptedText: input,
              goal: acceptedGoal,
              requirement,
              identifier: hit.row.identifier,
              semanticScore: hit.score,
              shape,
            });
            // The wider hint pool remains private: every source, including a
            // high-similarity hit, must prove the complete per-record result
            // shape and enough records before it can enter the card/binding.
            if (sourceFit?.eligible !== true) continue;
            const current = await ensureCanonicalSourceSchema({
              kind: hit.row.kind,
              identifier: hit.row.identifier,
              storedFingerprint: hit.row.schemaFingerprint,
              liveFingerprintFor,
              ensureLiveFingerprintFor,
              refreshState,
            });
            if (!current) continue;
            origins.set(hit.row, origin);
            if (sourceFit) sourceFits.set(hit.row, sourceFit);
            hits.push(hit);
          }
        } else {
          hits = semanticCapabilityAliases(query, {
            scope,
            embeddingSpace: localEmbeddingSpaceKey(),
            limit,
            liveSchemaFingerprintFor: liveFingerprintFor,
          });
        }
        for (const hit of hits) {
          const origin = origins.get(hit.row) ?? canonicalOriginForAlias(hit.row, records);
          if (collectThenConstructSourceResolution && requirement.effect === 'read' && !origin) continue;
          const candidate = candidateFromAlias(
            hit.row,
            hit.score,
            requirement,
            origin,
            'semantic',
            liveFingerprintFor,
            sourceFits.get(hit.row),
          );
          if (!capabilityEffectIsCompatible(requestedEffect, candidate.effectClass ?? 'unknown')) continue;
          if (collectThenConstructSourceResolution
            && readSourceRole(candidate.roleKey)
            && !sourceCandidateHasCurrentAuthority(candidate)) continue;
          const key = capabilityCandidateKey(candidate);
          byIdentifier.set(key, mergeCandidate(byIdentifier.get(key), candidate));
        }
      }
    }
  } else if (options.semantic !== false) {
    void getLocalEmbeddingProvider().catch(() => null);
  }

  const allCandidates = [...byIdentifier.values()];
  const sourceStrategyBinding = materializeSourceStrategyBinding(input, allCandidates, acceptedGoal);
  let candidates = diversifyCapabilities(allCandidates, limit);
  const primaryCapability = sourceStrategyBinding?.primary.capabilityId.split(':').slice(2).join(':');
  if (primaryCapability && !candidates.some((candidate) => candidate.identifier === primaryCapability)) {
    const primaryCandidate = allCandidates.find((candidate) => candidate.identifier === primaryCapability);
    if (primaryCandidate) candidates = [primaryCandidate, ...candidates].slice(0, limit);
  }
  if (candidates.length === 0) {
    return {
      candidates: [],
      requirements: describeRequirements(requirements, []),
      matches: [],
      pinnedTools: [],
      semanticApplied,
      roleScopedDiscovery,
    };
  }
  const selectedKeys = new Set(candidates.map(capabilityCandidateKey));
  matches = matches.filter((match) => selectedKeys.has(capabilityCandidateKey(match)));

  // Pin the CARRIER each candidate needs, so the brain can actually reach it.
  // Retrieval widens what is visible; it never narrows what the brain may pick.
  const pinnedTools = new Set<string>();
  for (const candidate of candidates) {
    const record = records.find((r) => r.intent === candidate.intent && r.choice);
    if (record?.choice) for (const family of toolFamilyForChoice(record.choice)) pinnedTools.add(family);
  }

  // Every candidate the semantic tier contributed also becomes an advisory
  // match, so the MCP recall seam sees exactly what the JIT surface sees.
  const semanticMatches: StepToolChoiceMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.via !== 'semantic') continue;
    const record = records.find((r) => r.intent === candidate.intent && r.choice);
    if (!record?.choice) continue;
    semanticMatches.push({
      intent: record.intent,
      ...(record.procedureId ? { procedureId: record.procedureId } : {}),
      kind: record.choice.kind,
      identifier: record.choice.identifier,
      score: candidate.score,
      tier: 'medium',
      matched: [],
      alreadyBound: false,
      autoBindable: false,
      family: toolFamilyForChoice(record.choice),
      command: '',
    });
  }

  return {
    candidates,
    requirements: describeRequirements(requirements, candidates),
    matches: [...matches, ...semanticMatches],
    pinnedTools: [...pinnedTools],
    semanticApplied,
    roleScopedDiscovery,
    ...(sourceStrategyBinding ? { sourceStrategyBinding } : {}),
  };
}

/**
 * The bounded advisory card a brain sees for its turn's candidates: kind,
 * exact identifier, intent, provenance — never prior invocation arguments,
 * which are exactly the thing a stale replay would be made of.
 */
export function renderCapabilityCandidateCard(resolved: TurnCapabilityCandidates | undefined): string {
  const rows = resolved?.candidates.slice(0, 5) ?? [];
  const requirements = resolved?.roleScopedDiscovery === false
    ? []
    : resolved?.requirements ?? [];
  const sourceBinding = validatedTurnSourceStrategyBinding(resolved?.sourceStrategyBinding);
  const sourceLines = sourceBinding
    ? (() => {
        const renderIdentity = (
          identity: TurnSourceStrategyBindingV1['primary'],
          label: string,
        ): string => {
          const parsed = identity.capabilityId.match(/^capability:([^:]+):(.+)$/);
          const kind = parsed?.[1] ?? '';
          const identifier = parsed?.[2] ?? identity.capabilityId;
          const candidate = rows.find((row) => row.kind === kind && row.identifier === identifier);
          const required = candidate?.requiredFields?.length
            ? ` Required inner arguments: ${candidate.requiredFields.join(', ')}.`
            : '';
          const schema = identity.schemaFingerprint
            ? ` Bound schema fingerprint: ${identity.schemaFingerprint}.`
            : '';
          const account = identity.accountIdentity
            ? ` Bound account: ${identity.accountIdentity}.`
            : '';
          const carrier = kind === 'composio'
            ? `Via \`work_call\`: set \`name\` to exact \`${identifier}\` and put provider inputs in \`args_json\` (the host maps it to \`composio_execute_tool\`).`
            : kind === 'mcp'
              ? `Via \`work_call\`: set \`name\` to exact \`${identifier}\` and put its inputs in \`args_json\`.`
              : 'Use only its exact runtime carrier.';
          return `- ${label} \`${identity.capabilityId}\`: ${carrier}${required}${account}${schema}`;
        };
        return [
          '## Host-bound collection source for this task',
          'Routing only, not effect authorization. Do not rediscover it or substitute a source; physical admission revalidates the live account and schema.',
          renderIdentity(sourceBinding.primary, 'Primary'),
          ...sourceBinding.equivalentFallbacks.map((fallback, index) =>
            renderIdentity(fallback, `Equivalent fallback ${index + 1}`)),
        ];
      })()
    : [];
  if (rows.length === 0 && requirements.length === 0 && sourceLines.length === 0) return '';
  const lines = rows.map((c) => {
    const provenance = [
      c.klass,
      c.via === 'semantic' ? `semantic ${c.score.toFixed(2)}` : 'phrase-proven',
      ...(c.accountIdentity ? [`acct ${c.accountIdentity}`] : []),
    ].join('; ');
    const contract = c.schemaAuthority === 'live'
      ? ` Live schema${c.requiredFields?.length ? ` requires: ${c.requiredFields.join(', ')}` : ' has no required keys'}.`
      : c.schemaAuthority === 'validation_only'
        ? ' Cached validation only; refresh exact live schema if rejected.'
        : c.schemaAuthority === 'missing'
          ? ' No current schema; one exact refresh remains.'
          : '';
    const execution = c.kind === 'composio'
      ? `composio \`${c.identifier}\``
      : `${c.kind} \`${c.identifier}\``;
    const role = c.roleKey ? ` Role ${c.roleKey}.` : '';
    return `- ${execution}.${contract}${role} Intent metadata: ${JSON.stringify(c.intent)} (${provenance}).`;
  });
  const unresolved = requirements.filter((requirement) => !requirement.resolved);
  const discovery = requirements.length === 0
    ? []
    : unresolved.length === 0
      ? [
          '## Discovery roles for this request',
          `All ${requirements.length} load-bearing requirement${requirements.length === 1 ? '' : 's'} already have resolved paths. Use them first; exact selected-tool schema repair remains available.`,
        ]
      : [
          '## Discovery roles for this request',
          'For broad `tool_search`, copy one unresolved `role_key` exactly; synonymous queries/providers for that key share its slot. Claude native ToolSearch uses a `[role:<role_key>]` query prefix. Exact selected-tool schema repair is separate.',
          ...unresolved.map((requirement) => {
            const text = requirement.text.replace(/\s+/g, ' ').trim();
            return `- role_key \`${requirement.roleKey}\`: ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`;
          }),
        ];
  return [
    ...sourceLines,
    ...discovery,
    ...(lines.length > 0 ? [
      '## Advisory paths (nothing here is pre-authorized)',
      'Verify fit/account/schema/fresh args. Intent is metadata, never a tool name. Composio: use `composio_execute_tool` with exact `tool_slug`; do not rediscover.',
      ...lines,
    ] : []),
  ].join('\n');
}
