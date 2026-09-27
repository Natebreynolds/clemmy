/**
 * The round-one desk: which tool schemas an ordinary host chat turn sends.
 *
 * The desk is a fixed ladder of three byte-stable tools blocks:
 *   lean    — today's surface without the schemas of every desk-declared tool
 *             (ToolDecl.desk in tool-registry.ts);
 *   readers — lean plus the tools declared on the readers rung;
 *   full    — today's surface.
 * A rung removes schemas, never tools. A deferred tool keeps its place on the
 * agent (`deferLoading: true`): the host dispatches it by exact name, the
 * call_tool dispatcher carries it to its own handler, an exact-name
 * tool_search returns its schema, and one names-only line after the cache
 * boundary names it with a purpose phrase. The host drops a deferred schema
 * from the request only while tool_search and call_tool both ride it
 * (advertised-tool-wire.ts), so the desk requires both doors.
 *
 * One decision per accepted source, in this order:
 *   1. scope — only an ordinary host chat turn has a desk. Plan, execute, act,
 *      frozen-contract, local-memory, legacy, unattended and workflow turns are
 *      today's surface (fallback `out_of_scope`);
 *   2. doors — tool_search and call_tool must both be on the policy-resolved
 *      surface, or the turn is today's surface (fallback `doors_absent`);
 *   3. reuse — a re-entry on the same accepted source reads back the rung its
 *      tool_search_scope event recorded, so a schema never joins or leaves
 *      the request mid-turn;
 *   4. decide — structural host facts only, never the request's wording:
 *      the evidence each desk declaration names climbs the session to that
 *      tool's rung; a desk tool this session dispatched (a miss, or any use)
 *      climbs to its rung; and the session never descends below the highest rung
 *      any earlier in-scope source recorded, however many out-of-scope
 *      sources or rebuilds of older sources came after it. An out-of-scope or
 *      facts_unavailable source records no in-scope desk, so it neither
 *      raises nor lowers that floor.
 * Any fact that cannot be read gives today's surface (`facts_unavailable`).
 * All facts are durable records, so a restart decides the same rung.
 */
import {
  deskDeclarationFor,
  deskDeclaredToolNames,
  type DeskEvidenceKind,
  type DeskRung,
} from '../tools/tool-registry.js';
import {
  earlierInScopeDeskRungs,
  latestInScopeDeskEvent,
  sessionDispatchedToolsSince,
  sessionHasRetainedToolOutputs,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { acceptedSourceHasAttachments } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { rankSkills } from '../runtime/harness/context-packet.js';
import { summarizeWorkManifests } from '../runtime/harness/work-manifest.js';
import { isUnattendedSession } from '../runtime/harness/unattended-session.js';

export const DESK_RUNGS: readonly DeskRung[] = ['lean', 'readers', 'full'];

/**
 * The no-signal rule. When true, nothing becomes unreachable is the rule: an
 * in-scope turn with no identified target also starts on the lean rung, since
 * every deferred tool stays named, one exact-name tool_search from its schema
 * and callable through call_tool, and a miss costs one round and climbs the
 * ladder. When false, such a turn is today's full surface and only a turn
 * whose target an existing host promotion identifies starts lean.
 */
export const NO_TARGET_STARTS_LEAN = true;

export type TurnDeskFallbackReason = 'out_of_scope' | 'doors_absent' | 'facts_unavailable';
/** Why an in-scope desk sits above the lean rung. */
export type TurnDeskClimb = DeskEvidenceKind | 'miss' | 'session_floor' | 'no_identified_target';

export interface TurnDeskDecision {
  version: 1;
  rung: DeskRung;
  /** Set when the turn carries today's full surface because the desk does not
   *  apply to it; null for every in-scope decision. */
  fallbackReason: TurnDeskFallbackReason | null;
  climbedBy: TurnDeskClimb[];
  /** Desk tools this session dispatched since its previous in-scope source. */
  missed: string[];
  /** Tools callable this turn whose schemas are not sent. */
  deferred: string[];
  sourceUserSeq: number;
}

export interface TurnDeskFacts {
  /** An existing host promotion identifies the request's target. */
  identifiedTarget: boolean;
  evidence: Readonly<Record<DeskEvidenceKind, boolean>>;
  missed: readonly string[];
  /** The rung the session's previous in-scope source recorded. */
  sessionFloor: DeskRung | null;
}

const rungIndex = (rung: DeskRung): number => DESK_RUNGS.indexOf(rung);
const higher = (left: DeskRung, right: DeskRung): DeskRung => (rungIndex(right) > rungIndex(left) ? right : left);

/** The rung of the tools that declare this evidence (lean when none does). */
export function deskRungForEvidence(kind: DeskEvidenceKind): DeskRung {
  let rung: DeskRung = 'lean';
  for (const name of deskDeclaredToolNames()) {
    const declaration = deskDeclarationFor(name);
    if (declaration?.promotedBy.includes(kind)) rung = higher(rung, declaration.rung);
  }
  return rung;
}

/** The desk tools on this surface whose rung is above `rung`. */
export function deferredOnRung(surfaceNames: Iterable<string>, rung: DeskRung): string[] {
  return [...new Set(surfaceNames)].filter((name) => {
    const declaration = deskDeclarationFor(name);
    return declaration !== null && rungIndex(declaration.rung) > rungIndex(rung);
  });
}

export function fullTurnDesk(reason: TurnDeskFallbackReason, sourceUserSeq: number): TurnDeskDecision {
  return { version: 1, rung: 'full', fallbackReason: reason, climbedBy: [], missed: [], deferred: [], sourceUserSeq };
}

/** Pure decision over facts for the tools on this surface. */
export function decideTurnDesk(
  surfaceNames: Iterable<string>,
  facts: TurnDeskFacts,
  sourceUserSeq: number,
): TurnDeskDecision {
  let rung: DeskRung = 'lean';
  const climbedBy: TurnDeskClimb[] = [];
  const climb = (to: DeskRung, because: TurnDeskClimb): void => {
    if (to === 'lean') return;
    climbedBy.push(because);
    rung = higher(rung, to);
  };
  if (!facts.identifiedTarget && !NO_TARGET_STARTS_LEAN) climb('full', 'no_identified_target');
  for (const [kind, present] of Object.entries(facts.evidence) as Array<[DeskEvidenceKind, boolean]>) {
    if (present) climb(deskRungForEvidence(kind), kind);
  }
  const missed = [...new Set(facts.missed)].filter((name) => deskDeclarationFor(name) !== null).sort();
  for (const name of missed) climb(deskDeclarationFor(name)!.rung, 'miss');
  if (facts.sessionFloor) climb(facts.sessionFloor, 'session_floor');
  return {
    version: 1,
    rung,
    fallbackReason: null,
    climbedBy: [...new Set(climbedBy)],
    missed,
    deferred: deferredOnRung(surfaceNames, rung),
    sourceUserSeq,
  };
}

function isInScopeRecord(value: unknown): value is TurnDeskDecision {
  const desk = value as Partial<TurnDeskDecision> | undefined;
  return Boolean(desk)
    && desk!.version === 1
    && desk!.fallbackReason === null
    && typeof desk!.rung === 'string'
    && DESK_RUNGS.includes(desk!.rung as DeskRung)
    && Number.isSafeInteger(desk!.sourceUserSeq)
    && Array.isArray(desk!.deferred);
}

function inScopeDesk(event: EventRow | null): TurnDeskDecision | null {
  const desk = (event?.data as { desk?: unknown } | undefined)?.desk;
  return isInScopeRecord(desk) ? desk : null;
}

/** The in-scope desk this accepted source already decided, if a build recorded one. */
export function recordedTurnDesk(sessionId: string, sourceUserSeq: number): TurnDeskDecision | null {
  return inScopeDesk(latestInScopeDeskEvent(sessionId, sourceUserSeq, 'same_source'));
}

/** The desk of the session's newest in-scope source before this one: the
 *  start of the miss window. */
export function previousTurnDesk(sessionId: string, sourceUserSeq: number): TurnDeskDecision | null {
  return inScopeDesk(latestInScopeDeskEvent(sessionId, sourceUserSeq, 'earlier_source'));
}

export interface TurnDeskFactInput {
  sessionId: string;
  sourceUserSeq: number;
  /** The accepted request text, ranked the way the context packet ranks skills. */
  requestText: string;
  identifiedTarget: boolean;
  /** Capabilities on the turn's host-fresh planning card. */
  planningCapabilityCount: number;
  /** Operations disclosed to this turn (card plus proven disclosure). */
  disclosedOperationCount: number;
}

/** Read the host facts the desk decides on. Throws when a read fails. */
export function gatherTurnDeskFacts(input: TurnDeskFactInput): TurnDeskFacts {
  const previous = previousTurnDesk(input.sessionId, input.sourceUserSeq);
  const openWork = summarizeWorkManifests(input.sessionId).some((manifest) => manifest.remaining > 0);
  return {
    identifiedTarget: input.identifiedTarget,
    evidence: {
      retained_output: sessionHasRetainedToolOutputs(input.sessionId)
        || acceptedSourceHasAttachments({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq }),
      delegation: input.planningCapabilityCount > 0 || input.disclosedOperationCount > 0,
      // The surface is built before the context packet exists; the desk ranks
      // the same accepted text with the packet's own ranker.
      listed_skill: rankSkills(input.requestText).length > 0,
      long_work: openWork,
    },
    // From the previous in-scope source's own user message, so a dispatch
    // made before any rebuild of that source still counts.
    missed: sessionDispatchedToolsSince(input.sessionId, previous?.sourceUserSeq ?? 0, deskDeclaredToolNames()),
    sessionFloor: sessionFloorRung(input.sessionId, input.sourceUserSeq),
  };
}

/** The highest rung any earlier in-scope source of this session recorded. */
function sessionFloorRung(sessionId: string, sourceUserSeq: number): DeskRung | null {
  let floor: DeskRung | null = null;
  for (const rung of earlierInScopeDeskRungs(sessionId, sourceUserSeq)) {
    if (!(DESK_RUNGS as readonly string[]).includes(rung)) continue;
    floor = floor === null ? rung as DeskRung : higher(floor, rung as DeskRung);
  }
  return floor;
}

/** Reuse a recorded in-scope decision on re-entry, restricted to this surface. */
export function reuseTurnDesk(recorded: TurnDeskDecision, surfaceNames: Iterable<string>): TurnDeskDecision {
  return {
    ...recorded,
    climbedBy: [...recorded.climbedBy],
    missed: [...recorded.missed],
    deferred: deferredOnRung(surfaceNames, recorded.rung),
  };
}

export interface TurnDeskInput {
  sessionId: string | null | undefined;
  sourceUserSeq: number | null | undefined;
  /** The build is the ordinary host chat branch: host-fresh planning on a
   *  tool-bearing surface, not Plan, Execute, act, a frozen contract or the
   *  local-memory scope. */
  ordinaryHostChat: boolean;
  /** Names on the policy-resolved surface, in order. */
  surfaceNames: readonly string[];
  requestText: string;
  identifiedTarget: boolean;
  planningCapabilityCount: number;
  disclosedOperationCount: number;
}

/** The one desk decision for a build. Never throws. */
export function resolveTurnDesk(input: TurnDeskInput): TurnDeskDecision {
  const sourceUserSeq = Number.isSafeInteger(input.sourceUserSeq) ? input.sourceUserSeq as number : 0;
  try {
    const sessionId = (input.sessionId ?? '').trim();
    if (!input.ordinaryHostChat || !sessionId || sourceUserSeq <= 0 || isUnattendedSession(sessionId)) {
      return fullTurnDesk('out_of_scope', sourceUserSeq);
    }
    const surface = new Set(input.surfaceNames);
    if (!surface.has('tool_search') || !surface.has('call_tool')) {
      return fullTurnDesk('doors_absent', sourceUserSeq);
    }
    const recorded = recordedTurnDesk(sessionId, sourceUserSeq);
    if (recorded) return reuseTurnDesk(recorded, input.surfaceNames);
    return decideTurnDesk(input.surfaceNames, gatherTurnDeskFacts({
      sessionId,
      sourceUserSeq,
      requestText: input.requestText,
      identifiedTarget: input.identifiedTarget,
      planningCapabilityCount: input.planningCapabilityCount,
      disclosedOperationCount: input.disclosedOperationCount,
    }), sourceUserSeq);
  } catch {
    return fullTurnDesk('facts_unavailable', sourceUserSeq);
  }
}

/** One names-only line for the deferred tools, placed after the cache boundary. */
export function renderDeskNamesLine(deferred: readonly string[]): string | null {
  const entries = deferred.flatMap((name) => {
    const declaration = deskDeclarationFor(name);
    return declaration ? [`${name} (${declaration.purpose})`] : [];
  });
  if (entries.length === 0) return null;
  return `[on-request tools] Callable now by exact name; their schemas are not preloaded: ${entries.join('; ')}.`
    + ' tool_search with the exact name returns the schema. Call the tool directly, or through call_tool({name, args_json}).';
}
