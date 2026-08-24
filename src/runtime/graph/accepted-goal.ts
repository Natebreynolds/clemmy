/**
 * One canonical goal interpretation for an accepted user source.
 *
 * Classifiers may widen risk. They may not freeze a weaker route or effect
 * ceiling than this object. The graph, expected-work contract, and preflight
 * are projections of it.
 */
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type { TurnGraphIR, TurnGraphRoute } from './turn-graph-ir.js';
import { classifyExternalEffectRequest } from '../../assistant/external-effect-taxonomy.js';

export type AcceptedGoalConstruct =
  | 'none'
  | 'collect_then_construct'
  | 'fanout'
  | 'single_act';

export type AcceptedGoalDestinationPosture = 'create_new' | 'named_existing';

export interface AcceptedGoalCollection {
  /** 0 means count is not the completeness predicate. */
  count: number;
  projection: string[];
  /** Counted N vs exhaust a typed dimension (region, category, page). */
  completeness?: 'count' | 'exhaust';
  /** Fields that define one unique record. Distinct from the full projection. */
  identityFields?: string[];
}

export interface AcceptedGoalDestination {
  posture: AcceptedGoalDestinationPosture;
  /** Semantic deliverable kind. Not an executable provider identity. */
  family: string;
  handleRequired: boolean;
  /** Host-owned exact destination identity. Absent until the binder admits one. */
  binding?: {
    manifestId: string;
    manifestDigest: string;
    accountId: string;
    operationId: string;
    schemaVersion: string;
    definitionFingerprint: string;
    effect: string;
    posture: AcceptedGoalDestinationPosture;
  };
}

export interface AcceptedGoalV1 {
  sourceUserSeq: number;
  /** Durable root that later slot-answer sources settle or amend. */
  goalId?: string;
  revision?: number;
  collection?: AcceptedGoalCollection;
  /**
   * Canonical sink list. Empty means no destination. A single-sink goal is
   * `destinations` of length 1 — never a different authority shape.
   */
  destinations?: AcceptedGoalDestination[];
  /**
   * Projection of `destinations[0]`. Not a second writer: compile and admit
   * always derive it from `destinations`.
   */
  destination?: AcceptedGoalDestination;
  effectCeiling: RuntimeToolEffect | 'none';
  route: TurnGraphRoute;
  construct: AcceptedGoalConstruct;
  evidenceRequirements?: readonly string[];
}

export interface AcceptedGoalConstraintsV1 {
  construct: AcceptedGoalConstruct;
  collection?: AcceptedGoalCollection;
  destinations?: AcceptedGoalDestination[];
  destination?: AcceptedGoalDestination;
  evidenceRequirements?: readonly string[];
}

/** Canonical sink list. `destination` is only a first-sink projection. */
export function destinationsOf(goal: {
  destinations?: readonly AcceptedGoalDestination[];
  destination?: AcceptedGoalDestination;
}): AcceptedGoalDestination[] {
  if (goal.destinations && goal.destinations.length > 0) return [...goal.destinations];
  return goal.destination ? [goal.destination] : [];
}

export function withCanonicalDestinations(
  destinations: readonly AcceptedGoalDestination[],
): Pick<AcceptedGoalV1, 'destinations' | 'destination'> {
  if (destinations.length === 0) return {};
  const list = destinations.map((entry) => ({ ...entry }));
  return { destinations: list, destination: list[0] };
}

/** Container families. Keys are kinds, not vendors. */
const DESTINATION_FAMILY_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['records', /\b(?:databases?|tables?|rosters?)\b/i],
  ['workbook', /\b(?:spreadsheets?|workbooks?|sheets?)\b/i],
  ['document', /\b(?:documents?|\bdocs?\b)\b/i],
  ['email', /\b(?:e-?mails?|mailbox)\b/i],
  ['calendar', /\b(?:calendars?|meetings?|events?)\b/i],
  ['file', /\b(?:files?|csvs?|exports?)\b/i],
];

const CREATE_NEW_RE =
  /\b(?:a|an|one|the|my|our|single)\s+(?:new\s+)?[a-z][\w-]*|\bnew\s+[a-z][\w-]*\b/i;
/** "Same" is only destination posture when it modifies the detected
 * destination family. A clarification can legitimately say "use the same
 * parameters" for its source call; treating that generic phrase as an
 * existing workbook changes the already-accepted destination on A/Q/B. */
const NAMED_EXISTING_DESTINATION_RULES: Readonly<Record<string, RegExp>> = {
  workbook: /\b(?:the\s+same|existing|current|usual)\s+(?:[a-z][\w-]*\s+)?(?:spreadsheets?|workbooks?|sheets?)\b/i,
  document: /\b(?:the\s+same|existing|current|usual)\s+(?:[a-z][\w-]*\s+)?(?:documents?|docs?)\b/i,
  email: /\b(?:the\s+same|existing|current|usual)\s+(?:[a-z][\w-]*\s+)?(?:e-?mails?|mailboxes?)\b/i,
  calendar: /\b(?:the\s+same|existing|current|usual)\s+(?:[a-z][\w-]*\s+)?(?:calendars?|meetings?|events?)\b/i,
  file: /\b(?:the\s+same|existing|current|usual)\s+(?:[a-z][\w-]*\s+)?(?:files?|csvs?|exports?)\b/i,
};
const HANDLE_REQUIRED_RE =
  /\b(?:paste|give|send|return|drop|share)\b[^.!?\n]{0,80}\b(?:link|url|handle)\b|\b(?:link|url)\s+here\b/i;
const FIELD_LIST_RE = new RegExp(
  String.raw`\b(?:add|put|place|save|drop|include|with)\s+(?:the\s+)?(?!and\b|or\b)([a-z][a-z'-]+)(?:(?:\s*,\s*(?:the\s+)?(?!and\b|or\b)([a-z][a-z'-]+))+\s*,?\s+and\s+|\s+and\s+)(?:the\s+)?(?!and\b|or\b)([a-z][a-z'-]+)`,
  'i',
);
const PER_ITEM_FIELD_PROJECTION_RE =
  /\b(?:give|provide|return|show|include|capture|record)\s+(?:(?:me|us)\s+)?(?:the\s+)?([^.!?\n]{1,160}?)\s+for\s+(?:each|every)\b/i;
const LEADING_PER_ITEM_FIELD_PROJECTION_RE =
  /\b(?:give|provide|return|show|include|capture|record)\s+(?:(?:me|us)\s+)?(?:the\s+)?(?:for\s+)?(?:each|every)\s+[a-z][a-z'-]*\s+([^.!?\n]{1,160}?)(?=\s*,?\s*(?:then|before|after)\b|[.;!?]|$)/i;
const CONSTRUCT_VERB_RE =
  /\b(?:put|add|place|save|drop|create|build|write|make|compile|assemble|export|populate|persist|store|upsert)\b/i;
const FIELD_BLOCK_RE =
  /(?:information|fields?|columns?|attributes?)[^\n]{0,120}(?:following|fields)\s*:\s*\n((?:[ \t]*[A-Za-z][^\n]{0,48}\n?)+)/i;

function destinationFamilyFromText(text: string): string | undefined {
  for (const [family, pattern] of DESTINATION_FAMILY_RULES) {
    if (pattern.test(text)) return family;
  }
  return undefined;
}

function namesExistingDestination(text: string, family: string): boolean {
  return NAMED_EXISTING_DESTINATION_RULES[family]?.test(text) === true;
}

function projectionFromBlockList(text: string): string[] {
  const block = FIELD_BLOCK_RE.exec(text ?? '')?.[1] ?? '';
  if (!block.trim()) return [];
  return block.split(/\n/)
    .map((line) => line.trim().replace(/^[•\-*\d.)]+\s+/, ''))
    .filter((line) => (
      /^[A-Za-z]/.test(line)
      && line.split(/\s+/).length <= 4
      && !/\b(?:if we|would be|please|thanks)\b/i.test(line)
    ));
}

export function projectionRolesFromText(text: string): string[] {
  const match = FIELD_LIST_RE.exec(text ?? '');
  const leadingPerItem = LEADING_PER_ITEM_FIELD_PROJECTION_RE.exec(text ?? '')?.[1] ?? '';
  const listed = match
    ? [match[1], match[2], match[3]]
    : projectionFromBlockList(text).length > 0
      ? projectionFromBlockList(text)
      : (leadingPerItem || PER_ITEM_FIELD_PROJECTION_RE.exec(text ?? '')?.[1] || '')
        .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i);
  const roles = listed
    .filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    .map((role) => role
      .trim()
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\s+/g, ' ')
      .toLowerCase())
    .filter((role) => role.length <= 64 && role.split(/\s+/).length <= 6);
  return [...new Set(roles)];
}

export function compileAcceptedGoal(input: {
  text: string;
  sourceUserSeq?: number;
  /** Injected multi-item signal. Graph modules must not import the detector. */
  multiItem?: {
    itemCount: number;
    isMultiItem: boolean;
    collectThenConstruct?: boolean;
  };
  /**
   * Host-admitted sinks. When present they replace text-derived family
   * detection so the compiler does not invent topology from vocabulary.
   */
  destinations?: readonly AcceptedGoalDestination[];
}): AcceptedGoalV1 {
  const text = (input.text ?? '').trim();
  const multi = input.multiItem ?? { itemCount: 0, isMultiItem: false };
  const projection = projectionRolesFromText(text);
  const admittedDestinations = input.destinations && input.destinations.length > 0
    ? input.destinations.map((entry) => ({ ...entry }))
    : undefined;
  const family = admittedDestinations?.[0]?.family ?? destinationFamilyFromText(text);
  const namedExisting = Boolean(family && namesExistingDestination(text, family));
  const createNew = Boolean(family && CREATE_NEW_RE.test(text) && !namedExisting);
  const destination: AcceptedGoalDestination | undefined = admittedDestinations?.[0]
    ?? (family
      ? {
          posture: namedExisting && !createNew ? 'named_existing' : 'create_new',
          family,
          handleRequired: HANDLE_REQUIRED_RE.test(text),
        }
      : undefined);
  const destinations = admittedDestinations
    ?? (destination ? [destination] : undefined);
  const persist = Boolean(destination) && CONSTRUCT_VERB_RE.test(text);
  const collection: AcceptedGoalCollection | undefined = (
    multi.itemCount >= 3 || (projection.length >= 2 && persist)
  )
    ? {
        count: multi.itemCount >= 3 ? multi.itemCount : 0,
        projection,
        completeness: multi.itemCount >= 3 ? 'count' : undefined,
      }
    : undefined;
  const construct: AcceptedGoalConstruct = multi.collectThenConstruct === true
    || Boolean(collection && persist)
    ? 'collect_then_construct'
    : multi.isMultiItem
      ? 'fanout'
      : destination && CONSTRUCT_VERB_RE.test(text)
        ? 'single_act'
        : 'none';
  const writeCeiling = Boolean((destinations?.length ?? 0) > 0 && construct !== 'none');
  // Host-admitted sinks already named the write. Their family string is an
  // identifier, not a vendor — renaming it must not change the ceiling.
  // Text-derived sinks still use the kind list until a binding exists.
  const providerDestination = Boolean(
    admittedDestinations?.some((sink) => (
      sink.binding?.effect === 'external_write' || sink.binding?.effect === 'admin'
    ))
    || (!admittedDestinations && (destinations ?? []).some((sink) => (
      sink.family === 'workbook'
      || sink.family === 'email'
      || sink.family === 'document'
      || sink.family === 'records'
    )))
    || classifyExternalEffectRequest(text).requested
  );
  const effectCeiling: RuntimeToolEffect | 'none' = !writeCeiling
    ? 'none'
    : providerDestination
      ? 'external_write'
      : 'local_write';
  // Only a construct forces the act route. Observation-only asks keep the
  // existing intent classifier (calendar lookup stays retrieve).
  const route: TurnGraphRoute = writeCeiling || construct !== 'none' ? 'act' : 'direct_reply';
  return {
    sourceUserSeq: Number.isSafeInteger(input.sourceUserSeq) && (input.sourceUserSeq ?? 0) > 0
      ? input.sourceUserSeq as number
      : 0,
    ...(collection ? { collection } : {}),
    ...withCanonicalDestinations(destinations ?? []),
    effectCeiling,
    route,
    construct,
  };
}

/** A layout/format question is not OPEN when the goal already named projection. */
export function clarificationBlockedByGoal(goal: AcceptedGoalV1, question: string): boolean {
  if ((goal.collection?.projection.length ?? 0) < 2) return false;
  return /\b(?:column|format|row per|layout)\b/i.test(question ?? '');
}

export function goalConstraintsOf(goal: AcceptedGoalV1): AcceptedGoalConstraintsV1 {
  const destinations = destinationsOf(goal);
  return {
    construct: goal.construct,
    ...(goal.collection ? { collection: goal.collection } : {}),
    ...withCanonicalDestinations(destinations),
    ...(goal.evidenceRequirements ? { evidenceRequirements: [...goal.evidenceRequirements] } : {}),
  };
}

export type AuthorityConsistencyInput = {
  graph: TurnGraphIR;
  contract?: { operations: ReadonlyArray<{ effect: string }> } | null;
  preflight?: {
    allowedMutationEffects?: readonly string[];
    phase?: string;
    reason?: string;
  } | null;
};

export type AuthorityConsistencyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Refuse activation when graph, contract, and preflight disagree about the
 * write ceiling. Classifiers may be conservative; they may not freeze a
 * weaker authority than the compiled graph.
 */
export function assertAuthorityConsistency(
  input: AuthorityConsistencyInput,
): AuthorityConsistencyResult {
  const { graph, contract, preflight } = input;
  const route = graph.classification.route;
  const ceiling = graph.effectCeiling;
  const ctc = graph.classification.multiItem.collectThenConstruct === true;
  if (ctc && route !== 'act') {
    return { ok: false, reason: 'collect-then-construct requires an act route' };
  }
  if (ctc && ceiling !== 'external_write' && ceiling !== 'local_write' && ceiling !== 'admin') {
    return { ok: false, reason: 'collect-then-construct requires a write effect ceiling' };
  }
  if (route === 'retrieve' && (ceiling === 'external_write' || ceiling === 'local_write' || ceiling === 'admin')) {
    return { ok: false, reason: 'a retrieve graph cannot carry a write ceiling' };
  }
  if (
    route === 'retrieve'
    && (preflight?.allowedMutationEffects ?? []).some((effect) => (
      effect === 'external_write' || effect === 'local_write' || effect === 'admin'
    ))
  ) {
    return { ok: false, reason: 'preflight write authority contradicts a retrieve graph' };
  }
  if (contract) {
    const writes = contract.operations.filter((operation) => (
      operation.effect === 'external_write'
      || operation.effect === 'local_write'
      || operation.effect === 'admin'
    ));
    if (ceiling === 'external_write' && !writes.some((operation) => operation.effect === 'external_write')) {
      return { ok: false, reason: 'expected-work is missing the external-write the graph ceiling requires' };
    }
    if (route === 'retrieve' && writes.length > 0) {
      return { ok: false, reason: 'expected-work writes contradict a retrieve graph' };
    }
    if (ctc && writes.length === 0) {
      return { ok: false, reason: 'collect-then-construct expected-work requires one write' };
    }
  }
  return { ok: true };
}
