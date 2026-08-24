import { requestSemanticSegments } from '../../assistant/request-segments.js';
import {
  matchToolChoicesForStep,
  type MatchToolChoicesOptions,
  type StepToolChoiceMatch,
} from '../../memory/tool-choice-store.js';
import type { CapabilityEffect } from '../../memory/capability-effect-scope.js';
import {
  capabilityEffectIsCompatible,
  requestedCapabilityEffectScope,
  type RequestedCapabilityEffectScope,
} from '../../memory/capability-effect-scope.js';

const DEFAULT_LIMIT = 5;
const MAX_LEXICAL_POOL = 10;

export interface CapabilityRequirementSegment {
  /** Stable within the accepted request; contains no query/provider words. */
  roleKey: string;
  clauseIndex: number;
  text: string;
  effect: RequestedCapabilityEffectScope;
}

export interface RoleScopedStepToolChoiceMatch extends StepToolChoiceMatch {
  roleKey: string;
  requirementIndex: number;
  requirementText: string;
  requestedEffect: RequestedCapabilityEffectScope;
}

export interface LexicalCapabilityProjection {
  requirements: CapabilityRequirementSegment[];
  matches: RoleScopedStepToolChoiceMatch[];
}

export function capabilityRequirementRoleKey(
  clauseIndex: number,
  effect: RequestedCapabilityEffectScope,
): string {
  return `clause-${Math.max(0, clauseIndex)}:${effect}`;
}

/** Runtime-owned requirement identities for per-role retrieval/budgeting. */
export function requestCapabilityRequirements(userInput: string): CapabilityRequirementSegment[] {
  return requestSemanticSegments(userInput).map((text, clauseIndex) => {
    const effect = requestedCapabilityEffectScope(text);
    return {
      roleKey: capabilityRequirementRoleKey(clauseIndex, effect),
      clauseIndex,
      text,
      effect,
    };
  });
}

function resolvedRequirementEffect(
  requested: RequestedCapabilityEffectScope,
  matches: readonly StepToolChoiceMatch[],
): RequestedCapabilityEffectScope {
  if (requested !== 'unknown') return requested;
  // Medium advertise hits may come only from broad learned-ask context. They
  // are useful fallback suggestions, but cannot vote on a clause's effect:
  // doing so let a destination sibling relabel an exact source clause as
  // unknown. Prefer exact/high receipt matches whenever any exist.
  const effectEvidence = matches.some((match) => match.tier === 'high')
    ? matches.filter((match) => match.tier === 'high')
    : matches;
  const proven = new Set(effectEvidence
    .map((match) => match.effectClass)
    .filter((effect): effect is 'read' | 'write' => effect === 'read' || effect === 'write'));
  // The parser stays open-vocabulary. When every proven candidate agrees on
  // an effect, that structural receipt evidence can refine an unknown clause;
  // otherwise the role remains unknown and advisory.
  return proven.size === 1 ? [...proven][0] ?? 'unknown' : 'unknown';
}

export function capabilityCandidateKey(value: {
  identifier: string;
  accountIdentity?: string;
}): string {
  return `${value.identifier}::${value.accountIdentity ?? ''}`;
}

/** Structural integration namespace used only to diversify an advisory menu.
 * No provider name is known here: the namespace is derived from the callable
 * identifier shape for each supported carrier kind. */
function capabilityNamespace(value: { kind: string; identifier: string }): string {
  const identifier = value.identifier.trim();
  if (!identifier) return 'unknown';
  if (value.kind === 'mcp') return (identifier.split('__')[0] ?? identifier).toLowerCase();
  if (value.kind === 'cli') return (identifier.split(/\s+/)[0] ?? identifier).toLowerCase();
  const withoutDynamicPrefix = /^cx_/i.test(identifier) ? identifier.slice(3) : identifier;
  return (withoutDynamicPrefix.split(/[_:.\s/]+/)[0] ?? withoutDynamicPrefix).toLowerCase();
}

function capabilityDiversityKey(value: {
  kind: string;
  identifier: string;
}): string {
  return `${value.kind}:${capabilityNamespace(value)}`;
}

/** Account provenance is part of capability identity, but not a sibling
 * operation. Once one physical capability wins a role, retain every account
 * under which that exact operation was proven so retrieval never chooses an
 * account for the brain. */
function capabilityProvenanceGroupKey(value: {
  kind: string;
  identifier: string;
  roleKey?: string;
}): string {
  return `${value.kind}:${value.identifier.trim().toLowerCase()}::${value.roleKey ?? ''}`;
}

/**
 * Put one best candidate from every requirement and integration family into a
 * bounded menu. Sibling variants for an already-represented role+family stay
 * behind later exact-schema discovery instead of flooding the capability card.
 */
export function diversifyCapabilities<T extends {
  kind: string;
  identifier: string;
  score: number;
  accountIdentity?: string;
  effectClass?: CapabilityEffect;
  roleKey?: string;
}>(values: readonly T[], limit: number): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const key = `${capabilityCandidateKey(value)}::${value.roleKey ?? ''}`;
    const current = unique.get(key);
    if (!current || value.score > current.score) unique.set(key, value);
  }
  const pool = [...unique.values()];
  const bestByRole = new Map<string, T>();
  for (const value of pool) {
    if (!value.roleKey) continue;
    const current = bestByRole.get(value.roleKey);
    if (!current || value.score > current.score) bestByRole.set(value.roleKey, value);
  }
  const bestByFamily = new Map<string, T>();
  for (const value of pool) {
    const family = capabilityDiversityKey(value);
    const current = bestByFamily.get(family);
    if (!current || value.score > current.score) bestByFamily.set(family, value);
  }

  const selected: T[] = [];
  const selectedKeys = new Set<string>();
  const select = (value: T) => {
    const key = `${capabilityCandidateKey(value)}::${value.roleKey ?? ''}`;
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(value);
  };
  // A bounded menu serves requirements before offering sibling variants.
  for (const value of bestByRole.values()) select(value);
  for (const value of bestByFamily.values()) select(value);
  const selectedProvenanceGroups = new Set(selected.map(capabilityProvenanceGroupKey));
  for (const value of pool) {
    if (!value.accountIdentity) continue;
    if (selectedProvenanceGroups.has(capabilityProvenanceGroupKey(value))) select(value);
  }
  return selected.slice(0, limit);
}

export interface LexicalCapabilityRequestOptions {
  userInput: string;
  limit?: number;
  scope?: MatchToolChoicesOptions['scope'];
  liveSchemaFingerprintFor?: MatchToolChoicesOptions['liveSchemaFingerprintFor'];
  /** Deterministic fixture seam. Production always reads the active store. */
  choices?: MatchToolChoicesOptions['choices'];
}

/**
 * Match advisory procedural memory per semantic request clause, then against
 * the whole accepted request for exact-phrase continuity. Per-clause matching
 * keeps a later write from filtering out an earlier source read.
 */
export function lexicalCapabilityMatchesForRequest(
  options: LexicalCapabilityRequestOptions,
): RoleScopedStepToolChoiceMatch[] {
  return lexicalCapabilityProjectionForRequest(options).matches;
}

/** Per-clause capability projection. The requirements remain visible even
 * when no remembered operation fits, which lets the runtime budget one broker
 * lookup for that unresolved role without granting searches to resolved ones. */
export function lexicalCapabilityProjectionForRequest(
  options: LexicalCapabilityRequestOptions,
): LexicalCapabilityProjection {
  const input = options.userInput?.replace(/\s+/g, ' ').trim();
  if (!input) return { requirements: [], matches: [] };
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LEXICAL_POOL));
  const baseRequirements = requestCapabilityRequirements(input);
  const requirements: CapabilityRequirementSegment[] = [];
  const poolLimit = Math.min(MAX_LEXICAL_POOL, Math.max(4, limit * 2));
  const found: RoleScopedStepToolChoiceMatch[] = [];
  for (const requirement of baseRequirements) {
    try {
      const matches = matchToolChoicesForStep(requirement.text, {
        purpose: 'advertise',
        limit: poolLimit,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.liveSchemaFingerprintFor
          ? { liveSchemaFingerprintFor: options.liveSchemaFingerprintFor }
          : {}),
        ...(options.choices ? { choices: options.choices } : {}),
      });
      const effect = resolvedRequirementEffect(requirement.effect, matches);
      const projected = {
        ...requirement,
        effect,
        roleKey: capabilityRequirementRoleKey(requirement.clauseIndex, effect),
      };
      requirements.push(projected);
      // Once receipt evidence resolves an open-vocabulary role, an opposite-
      // effect fuzzy sibling cannot occupy that role's candidate budget.
      const compatibleMatches = matches.filter((match) =>
        capabilityEffectIsCompatible(projected.effect, match.effectClass ?? 'unknown'));
      found.push(...compatibleMatches.map((match) => ({
        ...match,
        roleKey: projected.roleKey,
        requirementIndex: requirement.clauseIndex,
        requirementText: requirement.text,
        requestedEffect: projected.effect,
      })));
    } catch {
      requirements.push(requirement);
    }
  }

  // Preserve an exact alias learned for the accepted request as a whole. It
  // never falsely settles a clause: only a capability that also matched one of
  // the source clauses receives that clause's role key.
  if (requirements.length > 1) {
    try {
      const whole = matchToolChoicesForStep(input, {
        purpose: 'advertise',
        limit: poolLimit,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.liveSchemaFingerprintFor
          ? { liveSchemaFingerprintFor: options.liveSchemaFingerprintFor }
          : {}),
        ...(options.choices ? { choices: options.choices } : {}),
      });
      for (const match of whole) {
        const existingIndexes = found
          .map((existing, index) => ({ existing, index }))
          .filter(({ existing }) => capabilityCandidateKey(existing) === capabilityCandidateKey(match))
          .map(({ index }) => index);
        if (existingIndexes.length > 0) {
          // The clause owns effect/role identity; the complete request may add
          // entity context that improves ranking (for example what kind of
          // rows the destination will contain). It may raise a clause match's
          // score but can never move the candidate to a different role.
          for (const index of existingIndexes) {
            const existing = found[index];
            if (!existing) continue;
            found[index] = {
              ...existing,
              score: Math.max(existing.score, match.score),
              matched: [...new Set([...existing.matched, ...match.matched])],
            };
          }
          continue;
        }
        const effect = requestedCapabilityEffectScope(input);
        found.push({
          ...match,
          roleKey: `request:${effect}`,
          requirementIndex: -1,
          requirementText: input,
          requestedEffect: effect,
        });
      }
    } catch { /* advisory retrieval never fails a turn */ }
  }
  return { requirements, matches: diversifyCapabilities(found, limit) };
}
