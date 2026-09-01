/**
 * Provider-neutral pre-dispatch read evidence refinement.
 *
 * A callable name is not evidence semantics. `get`, `list`, and `search` are
 * conventions, not contracts, and unfamiliar providers routinely violate
 * them. The immutable expected-work contract owns what the accepted task
 * asks to cover:
 *
 *   - single + once: one answer, so one durable observation is sufficient;
 *   - complete_set: the whole selected source, so exhaustion is required;
 *   - single + each(accepted_input): one point observation for one exact bound
 *     member;
 *   - accepted_set + set(accepted_input): one provider batch carrying the
 *     entire exact finite universe, without pretending it exhausts the
 *     provider's whole source.
 *
 * `resolved_operation` is one bounded operation observation. It deliberately
 * promises neither point identity nor source exhaustion: generic JSON Schema
 * cannot distinguish a record identifier from a filter. Schema and args still
 * never invent finite-universe or complete-source coverage.
 */
import { createHash } from 'node:crypto';

import {
  EXPECTED_WORK_MAX_UNIVERSE_MEMBERS,
  type ExpectedWorkCardinalityV1,
  type ExpectedWorkCoverageV1,
  type ExpectedWorkOperationV1,
  type ExpectedWorkUniverseV1,
} from './expected-work-contract.js';
import {
  inspectProviderEnvelope,
  providerRequestEchoKey,
} from './provider-read-evidence.js';

/** Compatibility shape for the v32 carrier while its shared V1 unions land. */
export type PreDispatchExpectedReadCoverage = ExpectedWorkCoverageV1 | 'accepted_set';
export type PreDispatchExpectedReadCardinality = ExpectedWorkCardinalityV1
  | { kind: 'set'; universeId: string };
export type PreDispatchExpectedReadOperation = Omit<
  ExpectedWorkOperationV1,
  'coverage' | 'cardinality'
> & {
  coverage?: PreDispatchExpectedReadCoverage;
  cardinality: PreDispatchExpectedReadCardinality;
};

export interface PreDispatchReadEvidenceInput {
  operation: PreDispatchExpectedReadOperation;
  universes: readonly ExpectedWorkUniverseV1[];
  /** Exact member bound by action admission for `single + each`. */
  universeItemId?: string;
  /**
   * Host-sealed members of the operation's universe, supplied only when the
   * contract could not enumerate them at accept time (a source-derived
   * universe). This module still proves nothing from them by itself: the seal
   * is derived by the host from the producer read's settled complete result.
   */
  universeMembers?: readonly string[];
  /** Exact provider-ready input schema observed before dispatch. */
  inputSchema: unknown;
  /** Exact provider-ready arguments. Values are consumed only in this pure call. */
  args: unknown;
}

export interface FiniteReadStructuralProof {
  universeId: string;
  memberCount: number;
  /** RFC 6901 pointer into the provider-ready argument object. */
  argumentPointer: string;
  /** Relative RFC 6901 pointer when an array contains objects rather than ids. */
  memberIdPointer: string | null;
  /** Recomputable structural digests. The row separately keeps the logical
   * call's task-salted argument digest; this module never substitutes for it. */
  schemaDigest: string;
  memberDigest: string;
}

export type PreDispatchReadEvidenceDecision =
  | {
      status: 'authoritative';
      mode: 'point_read';
      requiresExhaustion: false;
      basis: 'expected_single';
    }
  | {
      status: 'authoritative';
      mode: 'point_read';
      requiresExhaustion: false;
      basis: 'accepted_input_member' | 'sealed_source_member';
      proof: FiniteReadStructuralProof;
    }
  | {
      status: 'authoritative';
      mode: 'collection_read';
      requiresExhaustion: false;
      basis: 'expected_resolved_operation';
    }
  | {
      status: 'authoritative';
      mode: 'collection_read';
      requiresExhaustion: true;
      basis: 'expected_complete_set';
    }
  | {
      status: 'authoritative';
      mode: 'finite_read';
      requiresExhaustion: false;
      basis: 'accepted_input_finite_set';
      proof: FiniteReadStructuralProof;
    }
  | {
      status: 'unknown';
      mode: 'unknown_read';
      /** Unknown fails closed; it may never bless page one as terminal. */
      requiresExhaustion: true;
      reason:
        | 'operation_is_not_read'
        | 'read_coverage_is_missing'
        | 'resolved_operation_has_no_immutable_read_shape'
        | 'coverage_cardinality_mismatch'
        | 'finite_universe_is_missing'
        | 'finite_universe_is_not_accepted_input'
        | 'finite_universe_is_invalid'
        | 'finite_selector_not_proven'
        | 'finite_selector_is_ambiguous';
    };

export interface FiniteReadResultCoverageInput {
  /** Pre-dispatch proof frozen beside the exact logical call. */
  proof: FiniteReadStructuralProof;
  /** Exact members rehydrated from the immutable expected-work contract. */
  requestedMembers: readonly string[];
  /** Raw bytes redeemed from the successful logical settlement handle. */
  rawResult: unknown;
}

export type FiniteReadResultCoverageDecision =
  | {
      status: 'proved';
      resultArrayPointer: string;
      memberIdPointer: string | null;
      memberCount: number;
      memberDigest: string;
    }
  | {
      status: 'unproven';
      reason:
        | 'requested_members_conflict'
        | 'provider_result_contradiction_or_uninspected'
        | 'member_correspondence_missing'
        | 'member_correspondence_ambiguous'
        | 'result_structure_unreadable';
    };

const MAX_STRUCTURAL_DEPTH = 10;
const MAX_STRUCTURAL_NODES = 8_192;

function unknown(
  reason: Extract<PreDispatchReadEvidenceDecision, { status: 'unknown' }>['reason'],
): Extract<PreDispatchReadEvidenceDecision, { status: 'unknown' }> {
  return { status: 'unknown', mode: 'unknown_read', requiresExhaustion: true, reason };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonical(value: unknown): string | null {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) return null;
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      return JSON.stringify(entry);
    }
    if (typeof entry === 'number') {
      return Number.isFinite(entry) ? JSON.stringify(entry) : null;
    }
    if (typeof entry !== 'object') return null;
    if (seen.has(entry)) return null;
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        const values: string[] = [];
        for (const item of entry) {
          const encoded = visit(item, depth + 1);
          if (encoded === null) return null;
          values.push(encoded);
        }
        return `[${values.join(',')}]`;
      }
      if (!plainRecord(entry)) return null;
      const fields: string[] = [];
      for (const key of Object.keys(entry).filter((key) => entry[key] !== undefined).sort()) {
        const encoded = visit(entry[key], depth + 1);
        if (encoded === null) return null;
        fields.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${fields.join(',')}}`;
    } finally {
      seen.delete(entry);
    }
  };
  return visit(value, 0);
}

function sha256Canonical(value: unknown): string | null {
  const encoded = canonical(value);
  return encoded === null ? null : createHash('sha256').update(encoded).digest('hex');
}

function pointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerForPath(path: readonly string[]): string {
  return path.length === 0 ? '' : `/${path.map(pointerToken).join('/')}`;
}

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.length === 0
    || value.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS
    || value.some((entry) => typeof entry !== 'string')
  ) return false;
  const actual = value as string[];
  if (new Set(actual).size !== actual.length) return false;
  return [...actual].sort().every((entry, index) => entry === expected[index]);
}

function stringArraySchemaAt(
  schema: unknown,
  path: readonly string[],
): Record<string, unknown> | null {
  let current = schema;
  for (const segment of path) {
    if (!plainRecord(current) || !plainRecord(current.properties)) return null;
    current = current.properties[segment];
  }
  if (!plainRecord(current) || current.type !== 'array' || !plainRecord(current.items)) {
    return null;
  }
  return current.items;
}

interface SelectorMatch {
  argumentPath: string[];
  memberIdPath: string[] | null;
}

function schemaAtObjectPath(schema: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current = schema;
  for (const segment of path) {
    if (!plainRecord(current) || !plainRecord(current.properties)) return null;
    current = current.properties[segment];
  }
  return plainRecord(current) ? current : null;
}

function scalarPaths(value: unknown): string[][] | null {
  if (!plainRecord(value)) return null;
  const paths: string[][] = [];
  let nodes = 0;
  const visit = (entry: unknown, path: string[], depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) return false;
    if (typeof entry === 'string') {
      paths.push(path);
      return true;
    }
    if (!plainRecord(entry)) return true;
    for (const key of Object.keys(entry).sort()) {
      if (!visit(entry[key], [...path, key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, [], 0) ? paths : null;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!plainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function matchingSetSelectorPaths(
  args: unknown,
  schema: unknown,
  members: readonly string[],
): SelectorMatch[] | null {
  if (!plainRecord(args) || !plainRecord(schema)) return null;
  const matches: SelectorMatch[] = [];
  let nodes = 0;
  const visit = (value: unknown, path: string[], depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) return false;
    if (Array.isArray(value)) {
      const itemSchema = stringArraySchemaAt(schema, path);
      if (!itemSchema) return true;
      if (itemSchema.type === 'string' && exactStringSet(value, members)) {
        matches.push({ argumentPath: path, memberIdPath: null });
        return true;
      }
      if (itemSchema.type !== 'object' || value.length !== members.length || value.length === 0) {
        return true;
      }
      const firstPaths = scalarPaths(value[0]);
      if (!firstPaths) return false;
      for (const memberIdPath of firstPaths) {
        const extracted = value.map((entry) => valueAtPath(entry, memberIdPath));
        if (
          exactStringSet(extracted, members)
          && schemaAtObjectPath(itemSchema, memberIdPath)?.type === 'string'
        ) {
          matches.push({ argumentPath: path, memberIdPath });
        }
      }
      return true;
    }
    if (!plainRecord(value)) return true;
    for (const key of Object.keys(value).sort()) {
      if (!visit(value[key], [...path, key], depth + 1)) return false;
    }
    return true;
  };
  return visit(args, [], 0) ? matches : null;
}

function matchingItemSelectorPaths(
  args: unknown,
  schema: unknown,
  itemId: string,
): SelectorMatch[] | null {
  if (!plainRecord(args) || !plainRecord(schema)) return null;
  const matches: SelectorMatch[] = [];
  let nodes = 0;
  const visit = (value: unknown, path: string[], depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) return false;
    if (typeof value === 'string') {
      if (value === itemId && schemaAtObjectPath(schema, path)?.type === 'string') {
        matches.push({ argumentPath: path, memberIdPath: null });
      }
      return true;
    }
    if (!plainRecord(value)) return true;
    for (const key of Object.keys(value).sort()) {
      if (!visit(value[key], [...path, key], depth + 1)) return false;
    }
    return true;
  };
  return visit(args, [], 0) ? matches : null;
}

function structuralProof(input: {
  universeId: string;
  members: readonly string[];
  match: SelectorMatch;
  inputSchema: unknown;
  args: unknown;
}): FiniteReadStructuralProof | null {
  const schemaDigest = sha256Canonical(input.inputSchema);
  const memberDigest = sha256Canonical([...input.members].sort());
  // Canonicalize the full args as a boundedness/integrity check even though
  // the durable row uses the logical ledger's task-salted argument digest.
  if (!schemaDigest || !sha256Canonical(input.args) || !memberDigest) return null;
  return {
    universeId: input.universeId,
    memberCount: input.members.length,
    argumentPointer: pointerForPath(input.match.argumentPath),
    memberIdPointer: input.match.memberIdPath === null
      ? null
      : pointerForPath(input.match.memberIdPath),
    schemaDigest,
    memberDigest,
  };
}

/**
 * Refine one read before its first physical dispatch.
 *
 * The returned digests are structural proof material, not a stand-alone grant.
 * Production must freeze them in a row bound to the exact accepted task, work
 * contract, requirement, logical call, provider schema fingerprint, and the
 * ledger's salted argument digest before using the decision as authority.
 */
export function refinePreDispatchReadEvidence(
  input: PreDispatchReadEvidenceInput,
): PreDispatchReadEvidenceDecision {
  try {
    const { operation } = input;
    if (operation.effect !== 'read') return unknown('operation_is_not_read');
    if (!operation.coverage) return unknown('read_coverage_is_missing');

    if (operation.coverage === 'complete_set') {
      return {
        status: 'authoritative',
        mode: 'collection_read',
        requiresExhaustion: true,
        basis: 'expected_complete_set',
      };
    }

    if (operation.coverage === 'resolved_operation') {
      if (operation.cardinality.kind !== 'once') {
        return unknown('coverage_cardinality_mismatch');
      }
      return {
        status: 'authoritative',
        mode: 'collection_read',
        requiresExhaustion: false,
        basis: 'expected_resolved_operation',
      };
    }

    if (operation.coverage === 'single' && operation.cardinality.kind === 'once') {
      return {
        status: 'authoritative', mode: 'point_read', requiresExhaustion: false,
        basis: 'expected_single',
      };
    }
    if (
      (operation.coverage === 'single' && operation.cardinality.kind !== 'each')
      || (operation.coverage === 'accepted_set' && operation.cardinality.kind !== 'set')
    ) return unknown('coverage_cardinality_mismatch');

    const cardinality = operation.cardinality;
    if (cardinality.kind !== 'each' && cardinality.kind !== 'set') {
      return unknown('coverage_cardinality_mismatch');
    }
    const universeId = cardinality.universeId;
    const universe = input.universes.find((entry) => entry.id === universeId);
    if (!universe) return unknown('finite_universe_is_missing');
    // A per-item read may also range over a source-derived universe, but only
    // against the member list the host already sealed from the producer read.
    const sealedMembers = universe.seal === 'accepted_input'
      ? universe.members
      : operation.coverage === 'single' && input.universeMembers
        ? input.universeMembers
        : null;
    if (!sealedMembers) return unknown('finite_universe_is_not_accepted_input');
    const members = [...sealedMembers].sort();
    if (
      members.length === 0
      || members.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS
      || new Set(members).size !== members.length
      || members.some((member) => typeof member !== 'string' || !member.trim())
    ) return unknown('finite_universe_is_invalid');

    if (operation.coverage === 'single') {
      const itemId = input.universeItemId;
      if (!itemId || !members.includes(itemId)) return unknown('finite_selector_not_proven');
      const itemMatches = matchingItemSelectorPaths(input.args, input.inputSchema, itemId);
      if (!itemMatches || itemMatches.length === 0) return unknown('finite_selector_not_proven');
      if (itemMatches.length !== 1) return unknown('finite_selector_is_ambiguous');
      const proof = structuralProof({
        universeId,
        members: [itemId],
        match: itemMatches[0]!,
        inputSchema: input.inputSchema,
        args: input.args,
      });
      return proof
        ? {
            status: 'authoritative', mode: 'point_read', requiresExhaustion: false,
            basis: universe.seal === 'accepted_input'
              ? 'accepted_input_member'
              : 'sealed_source_member',
            proof,
          }
        : unknown('finite_selector_not_proven');
    }

    const matches = matchingSetSelectorPaths(input.args, input.inputSchema, members);
    if (!matches || matches.length === 0) return unknown('finite_selector_not_proven');
    if (matches.length !== 1) return unknown('finite_selector_is_ambiguous');
    const proof = structuralProof({
      universeId,
      members,
      match: matches[0]!,
      inputSchema: input.inputSchema,
      args: input.args,
    });
    if (!proof) return unknown('finite_selector_not_proven');

    return {
      status: 'authoritative',
      mode: 'finite_read',
      requiresExhaustion: false,
      basis: 'accepted_input_finite_set',
      proof,
    };
  } catch {
    return unknown('finite_selector_not_proven');
  }
}

interface ResultSelectorMatch {
  resultArrayPath: string[];
  memberIdPath: string[] | null;
}

function resultScalarPaths(value: unknown): string[][] | null {
  if (!plainRecord(value)) return null;
  const paths: string[][] = [];
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, path: string[], depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) return false;
    if (typeof entry === 'string') {
      paths.push(path);
      return true;
    }
    if (!plainRecord(entry)) return true;
    if (stack.has(entry)) return false;
    stack.add(entry);
    try {
      const keys = Object.keys(entry);
      if (keys.length > 256) return false;
      for (const key of keys.sort()) {
        if (providerRequestEchoKey(key)) continue;
        if (!visit(entry[key], [...path, key], depth + 1)) return false;
      }
      return true;
    } finally {
      stack.delete(entry);
    }
  };
  return visit(value, [], 0) ? paths : null;
}

function matchingResultArrays(
  rawResult: unknown,
  members: readonly string[],
): { matches: ResultSelectorMatch[]; unreadable: boolean } {
  const matches: ResultSelectorMatch[] = [];
  const stack = new WeakSet<object>();
  let nodes = 0;
  let unreadable = false;
  const visit = (value: unknown, path: string[], depth: number): void => {
    if (unreadable) return;
    nodes += 1;
    if (nodes > MAX_STRUCTURAL_NODES || depth > MAX_STRUCTURAL_DEPTH) {
      unreadable = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (stack.has(value)) {
      unreadable = true;
      return;
    }
    stack.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS) {
          unreadable = true;
          return;
        }
        let matchedHere = false;
        if (exactStringSet(value, members)) {
          matches.push({ resultArrayPath: path, memberIdPath: null });
          matchedHere = true;
        } else if (value.length === members.length && value.length > 0 && plainRecord(value[0])) {
          const paths = resultScalarPaths(value[0]);
          if (paths === null) {
            unreadable = true;
            return;
          }
          for (const memberIdPath of paths) {
            const extracted = value.map((entry) => valueAtPath(entry, memberIdPath));
            if (exactStringSet(extracted, members)) {
              matches.push({ resultArrayPath: path, memberIdPath });
              matchedHere = true;
            }
          }
        }
        // Once an array is a candidate, its nested business payload is not a
        // second result set. Multiple candidate arrays/identity paths still
        // remain visible and make the proof ambiguous.
        if (!matchedHere) {
          for (let index = 0; index < value.length; index += 1) {
            visit(value[index], [...path, String(index)], depth + 1);
          }
        }
        return;
      }
      if (!plainRecord(value)) {
        unreadable = true;
        return;
      }
      const keys = Object.keys(value);
      if (keys.length > 256) {
        unreadable = true;
        return;
      }
      for (const key of keys.sort()) {
        // Request/input carriers may repeat the exact selector set, but an echo
        // is not returned business evidence.
        if (providerRequestEchoKey(key)) continue;
        visit(value[key], [...path, key], depth + 1);
      }
    } finally {
      stack.delete(value);
    }
  };
  visit(rawResult, [], 0);
  return { matches, unreadable };
}

/**
 * Prove that a finite read returned exactly one structured result for every
 * frozen requested member. No result field name is semantic: a candidate is a
 * scalar array equal to the set, or an object array with one unique relative
 * scalar path whose values equal it. Provider-normalized/omitted identities
 * remain unproven because the host has no provider-neutral equivalence proof.
 */
export function proveFiniteReadResultCoverage(
  input: FiniteReadResultCoverageInput,
): FiniteReadResultCoverageDecision {
  try {
    const members = [...input.requestedMembers].sort();
    const memberDigest = sha256Canonical(members);
    if (
      members.length === 0
      || members.length !== input.proof.memberCount
      || members.length > EXPECTED_WORK_MAX_UNIVERSE_MEMBERS
      || new Set(members).size !== members.length
      || members.some((member) => typeof member !== 'string' || !member.trim())
      || memberDigest === null
      || memberDigest !== input.proof.memberDigest
    ) {
      return { status: 'unproven', reason: 'requested_members_conflict' };
    }
    if (inspectProviderEnvelope(input.rawResult).verdict !== 'clean') {
      return { status: 'unproven', reason: 'provider_result_contradiction_or_uninspected' };
    }
    const inspected = matchingResultArrays(input.rawResult, members);
    if (inspected.unreadable) return { status: 'unproven', reason: 'result_structure_unreadable' };
    if (inspected.matches.length === 0) {
      return { status: 'unproven', reason: 'member_correspondence_missing' };
    }
    if (inspected.matches.length !== 1) {
      return { status: 'unproven', reason: 'member_correspondence_ambiguous' };
    }
    const match = inspected.matches[0]!;
    return {
      status: 'proved',
      resultArrayPointer: pointerForPath(match.resultArrayPath),
      memberIdPointer: match.memberIdPath === null ? null : pointerForPath(match.memberIdPath),
      memberCount: members.length,
      memberDigest,
    };
  } catch {
    return { status: 'unproven', reason: 'result_structure_unreadable' };
  }
}
