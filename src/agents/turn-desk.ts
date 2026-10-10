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
 *      raises nor lowers that floor;
 *   5. hold — a climb rewrites the tools block, and the tools block sits
 *      before the conversation in the cached prompt prefix, so the next
 *      request re-sends the whole conversation uncached. When the session's
 *      last request was large and recent, its cache is worth more than the
 *      schemas: the turn keeps that request's rung and records the climb it
 *      held. The held tools stay callable by exact name, and the climb lands
 *      on a turn whose prefix is small or already cold.
 * Any fact that cannot be read gives today's surface (`facts_unavailable`).
 * All facts are durable records, so a restart decides the same rung.
 */
import {
  deskDeclarationFor,
  deskDeclaredToolNames,
  TOOL_REGISTRY,
  type DeskEvidenceKind,
  type DeskRung,
} from '../tools/tool-registry.js';
import {
  earlierInScopeDeskRungs,
  latestHostPromptPrefix,
  latestInScopeDeskEvent,
  sessionDispatchedToolsSince,
  sessionHasRetainedToolOutputLongerThan,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { PROMPT_INLINE_RECALLABLE_RESULT_CHARS } from '../runtime/harness/tool-output-format.js';
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

/** A climb is held while the session's last request carried at least this
 *  many prompt tokens and was composed within the warm window. */
export const DESK_HOLD_MIN_PROMPT_TOKENS = 20_000;
export const DESK_HOLD_WARM_MS = 30 * 60_000;

export type TurnDeskFallbackReason = 'out_of_scope' | 'doors_absent' | 'facts_unavailable';
/** Why an in-scope desk sits above the lean rung. */
export type TurnDeskClimb = DeskEvidenceKind | 'miss' | 'session_floor' | 'no_identified_target' | 'warm_prefix';

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
  /** A climb this turn did not take to keep a large, recent prompt prefix
   *  cached: the rung it would have reached, why, and the prefix's size. */
  held?: { rung: DeskRung; climbedBy: TurnDeskClimb[]; promptTokens: number };
}

export interface TurnDeskFacts {
  /** An existing host promotion identifies the request's target. */
  identifiedTarget: boolean;
  evidence: Readonly<Record<DeskEvidenceKind, boolean>>;
  missed: readonly string[];
  /** The rung the session's previous in-scope source recorded. */
  sessionFloor: DeskRung | null;
  /** The session's last request, when it was composed within the warm
   *  window: the rung its tools block carried and its prompt size. */
  warmPrefix?: { rung: DeskRung; promptTokens: number } | null;
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
  const warm = facts.warmPrefix;
  if (warm && warm.promptTokens >= DESK_HOLD_MIN_PROMPT_TOKENS
    && rungIndex(warm.rung) < rungIndex(rung)
    && rungIndex(warm.rung) >= rungIndex(facts.sessionFloor ?? 'lean')) {
    return {
      version: 1,
      rung: warm.rung,
      fallbackReason: null,
      climbedBy: warm.rung === 'lean' ? [] : ['warm_prefix'],
      missed,
      deferred: deferredOnRung(surfaceNames, warm.rung),
      sourceUserSeq,
      held: { rung, climbedBy: [...new Set(climbedBy)], promptTokens: warm.promptTokens },
    };
  }
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
  /** The decision time; defaults to now. */
  now?: number;
}

/** Read the host facts the desk decides on. Throws when a read fails. */
export function gatherTurnDeskFacts(input: TurnDeskFactInput): TurnDeskFacts {
  const previous = previousTurnDesk(input.sessionId, input.sourceUserSeq);
  const openWork = summarizeWorkManifests(input.sessionId).some((manifest) => manifest.remaining > 0);
  return {
    identifiedTarget: input.identifiedTarget,
    evidence: {
      // A reader matters only for a result shown in part: one longer than the
      // smallest inline presentation budget, whose footer named a reader. A
      // result shown whole needs none; reaching for a reader later is a miss.
      retained_output: sessionHasRetainedToolOutputLongerThan(input.sessionId, PROMPT_INLINE_RECALLABLE_RESULT_CHARS)
        || acceptedSourceHasAttachments({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq }),
      // Knowing how to call an operation is not evidence of delegation. A
      // remembered read must not permanently inflate this session's desk.
      // Actual delegated work retains the full surface; run_worker itself is
      // advertised on every rung, so a first delegation needs no promotion.
      delegation: sessionDispatchedToolsSince(input.sessionId, previous?.sourceUserSeq ?? 0,
        TOOL_REGISTRY.filter((tool) => tool.delegationPrimitive).map((tool) => tool.name)).length > 0,
      // The surface is built before the context packet exists; the desk ranks
      // the same accepted text with the packet's own ranker.
      listed_skill: rankSkills(input.requestText).length > 0,
      long_work: openWork,
    },
    // From the previous in-scope source's own user message, so a dispatch
    // made before any rebuild of that source still counts.
    missed: sessionDispatchedToolsSince(input.sessionId, previous?.sourceUserSeq ?? 0, deskDeclaredToolNames()),
    sessionFloor: sessionFloorRung(input.sessionId, input.sourceUserSeq),
    warmPrefix: warmPromptPrefix(input.sessionId, input.now ?? Date.now()),
  };
}

/** The session's last request when it is recent enough that its cached
 *  prefix is likely still warm. */
function warmPromptPrefix(sessionId: string, now: number): TurnDeskFacts['warmPrefix'] {
  const last = latestHostPromptPrefix(sessionId);
  if (!last || !(DESK_RUNGS as readonly string[]).includes(last.rung)) return null;
  const at = Date.parse(last.at);
  if (!Number.isFinite(at) || now - at > DESK_HOLD_WARM_MS) return null;
  return { rung: last.rung as DeskRung, promptTokens: last.totalTokens };
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
  /** A rebuild that is not ordinary host chat but is neither Plan, Execute
   *  nor the local-memory scope (an approval or recovery resume): it keeps the
   *  desk this same source already recorded. The desk only defers schemas of
   *  desk-declared tools, so it never narrows what the resume may call. */
  resumeMayKeepDesk?: boolean;
  /** Names on the policy-resolved surface, in order. */
  surfaceNames: readonly string[];
  requestText: string;
  identifiedTarget: boolean;
}

/** The one desk decision for a build. Never throws. */
export function resolveTurnDesk(input: TurnDeskInput): TurnDeskDecision {
  const sourceUserSeq = Number.isSafeInteger(input.sourceUserSeq) ? input.sourceUserSeq as number : 0;
  try {
    const sessionId = (input.sessionId ?? '').trim();
    if (!sessionId || sourceUserSeq <= 0 || isUnattendedSession(sessionId)) {
      return fullTurnDesk('out_of_scope', sourceUserSeq);
    }
    const surface = new Set(input.surfaceNames);
    const doors = surface.has('tool_search') && surface.has('call_tool');
    // A resume of a turn that already recorded its desk (after the owner
    // approves an action, after a recovery restart) is the same turn and keeps
    // that desk: a schema joining mid-turn re-sends the whole conversation
    // uncached on a provider that caches the prompt prefix.
    if (!input.ordinaryHostChat) {
      const recorded = input.resumeMayKeepDesk && doors ? recordedTurnDesk(sessionId, sourceUserSeq) : null;
      return recorded ? reuseTurnDesk(recorded, input.surfaceNames) : fullTurnDesk('out_of_scope', sourceUserSeq);
    }
    if (!doors) return fullTurnDesk('doors_absent', sourceUserSeq);
    const recorded = recordedTurnDesk(sessionId, sourceUserSeq);
    if (recorded) return reuseTurnDesk(recorded, input.surfaceNames);
    return decideTurnDesk(input.surfaceNames, gatherTurnDeskFacts({
      sessionId,
      sourceUserSeq,
      requestText: input.requestText,
      identifiedTarget: input.identifiedTarget,
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
