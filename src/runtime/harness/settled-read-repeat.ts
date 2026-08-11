/**
 * Durable resolve-once guard for direct Composio reads.
 *
 * The ordinary loop guard is intentionally permissive for reads because an
 * identical status poll can be legitimate. That leaves a narrower waste case:
 * a direct, non-poll Composio read returns settled data and the model asks for
 * the byte-identical read again under the SAME accepted user source. The first
 * result already fulfils that source. A later internal model turn (including an
 * infrastructure retry) must be able to recover those authoritative bytes
 * without paying the provider again.
 *
 * This module only proves that recovery is available. The tool wrapper decides
 * whether to surface the prior bytes or a same-turn corrective. It is deliberately
 * fail-open: incomplete/clipped arguments, ambiguous lifecycle rows, failure
 * outputs, async/poll semantics, replayed dedupe calls, or an intervening write
 * all return null and leave the ordinary provider path untouched.
 */
import { detectJobReceipt } from '../../integrations/composio/async-job.js';
import {
  classifyComposioSlugEffect,
  composioActionIsEphemeralCompute,
} from '../../integrations/composio/slug-effect.js';
import { settlementCarriesVerifiedData } from '../../memory/verified-read-learning.js';
import { getRuntimeEnv } from '../../config.js';
import {
  getEvent,
  getRunAttemptSourceUserEvent,
  listEvents,
  resolveToolOutputForAuthority,
  type EventRow,
} from './eventlog.js';
import { extractJsonCandidate } from './json-repair.js';
import { hashToolCall } from './tool-guardrail.js';
import { SETTLED_READ_REPLAY_KIND } from './settled-read-replay-semantics.js';

export const SETTLED_READ_REPEAT_REPLAY_KIND = SETTLED_READ_REPLAY_KIND;

const DIRECT_COMPOSIO_TOOL = 'composio_execute_tool';
const POLL_SEMANTIC_TOKENS = new Set([
  'STATUS',
  'POLL',
  'RESULT',
  'RESULTS',
  'READY',
  'JOB',
  'JOBS',
  'RUN',
  'RUNS',
]);
const PENDING_ASYNC_STATE = /^(?:queued|pending|running|processing|in[_ -]?progress|started|working|waiting)$/i;
const POLLING_SOURCE_INTENT = /\b(?:monitor|watch|poll|keep\s+checking|check\s+(?:(?:it|the\s+\w+)\s+)?again|check\s+repeatedly|wait\s+(?:for|until)|continue\s+checking|until\s+(?:it|the\s+\w+)|when\s+(?:it|the\s+\w+)\s+(?:is|becomes))\b/i;
const MULTIPLE_EXECUTION_INTENT = /\b(?:run|call|read|check|query|sample|execute)\s+(?:it\s+)?(?:twice|three\s+times|multiple\s+times|\d+\s+times)|\b(?:two|three|multiple|\d+)\s+(?:independent\s+)?(?:runs|calls|reads|checks|queries|samples|executions)\b|\brepeat\s+(?:the\s+)?(?:run|call|read|check|query|sample|execution)\b/i;

export interface SettledDirectComposioRead {
  toolSlug: string;
  parsedResult: Record<string, unknown>;
}

export interface SettledReadRepeatResolution {
  currentCalledEventId: string;
  sourceCallId: string;
  sourceBehaviorScopeId: string;
  sourceReturnedSeq: number;
  output: string;
  toolSlug: string;
  recoveredAcrossBehaviorScope: boolean;
}

export interface SettledReadRepeatReplayDisposition {
  replayCallId: string;
  replayCalledEventId: string;
  sourceCallId: string;
  sourceUserSeq: number;
  toolSlug: string;
}

export interface ResolveSettledReadRepeatInput {
  sessionId: string;
  sourceUserSeq: number;
  currentCallId: string;
  toolName: string;
  args: unknown;
  currentBehaviorScopeId: string;
}

export interface SettledReadRepeatReplayLookup {
  sessionId: string;
  replayCallId: string;
  replayCalledEventId: string;
  toolName: string;
  effect: string;
  sourceUserSeq: number;
  replayBehaviorScopeId: string;
  toolSlug: string;
}

export interface SettledReadInfraRecovery {
  sourceCallId: string;
  sourceReturnedSeq: number;
  output: string;
  toolSlug: string;
}

export interface ResolveSettledReadInfraRecoveryInput {
  sessionId: string;
  sourceUserSeq: number;
  runAttemptId: string;
  failedTurn: number;
}

// Recovery text is sent directly back through the model boundary. Keep that
// repair bounded; a larger durable result remains queryable through the normal
// paginated result tools and is safer to re-dispatch than to flood one prompt.
const INFRA_RECOVERY_MAX_OUTPUT_BYTES = 32_000;

/** Default-on with an explicit operational escape hatch. Turning the broader
 * tool guardrail off also restores the old byte-for-byte dispatch behavior. */
export function settledReadRepeatEnabled(): boolean {
  if ((getRuntimeEnv('CLEMMY_TOOL_GUARDRAIL', 'warn') ?? 'warn').toLowerCase() === 'off') return false;
  return (getRuntimeEnv('CLEMMY_SETTLED_READ_REPEAT', 'on') ?? 'on').toLowerCase() !== 'off';
}

function settledReadRepeatMaxAgeMs(): number {
  const parsed = Number.parseInt(getRuntimeEnv('CLEMMY_SETTLED_READ_MAX_AGE_MS', '300000') ?? '300000', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventNumber(event: EventRow, field: string): number | null {
  const value = event.data[field];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function eventString(event: EventRow, field: string): string {
  return nonEmptyString(event.data[field]) ?? '';
}

function eventToolSlug(event: EventRow): string {
  return eventString(event, 'toolSlug') || eventString(event, 'effectiveTool');
}

function parseExactArguments(value: unknown): unknown | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // A clipped argument preview or malformed carrier is not exact authority.
    return null;
  }
}

function composioSlugFromArgs(toolName: string, args: unknown): string | null {
  if (toolName !== DIRECT_COMPOSIO_TOOL) return null;
  const parsed = parseExactArguments(args);
  if (!parsed) return null;
  return nonEmptyString((parsed as Record<string, unknown>).tool_slug);
}

/**
 * Poll-shaped actions are excluded even if one sample happens to be terminal.
 * Resolve-once is for snapshot reads; an explicit status/result/run endpoint
 * owns different freshness semantics and stays on the existing poll rail.
 */
export function composioReadHasPollSemantics(toolSlug: string): boolean {
  const tokens = toolSlug
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const normalized = tokens.join('_');
  return tokens.some((token) => POLL_SEMANTIC_TOKENS.has(token))
    || /(?:^|_)TASK_GET(?:_|$)/.test(normalized)
    || /(?:^|_)GET_TASK(?:_|$)/.test(normalized);
}

function containsPendingAsyncState(value: unknown, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => containsPendingAsyncState(item, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:status|state|phase|job_status|run_status)$/i.test(key)
      && typeof child === 'string'
      && PENDING_ASYNC_STATE.test(child.trim())) return true;
    if (containsPendingAsyncState(child, depth + 1)) return true;
  }
  return false;
}

/** A monitor/watch request owns repeat-read semantics even when the provider's
 * action name itself is generic. */
export function acceptedSourceRequestsPolling(sessionId: string, sourceUserSeq: number): boolean {
  try {
    const matches = listEvents(sessionId, {
      sinceSeq: sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    })
      .filter((event) => event.seq === sourceUserSeq);
    if (matches.length !== 1) return true;
    const text = matches[0]!.data.text;
    return typeof text !== 'string'
      || POLLING_SOURCE_INTENT.test(text)
      || MULTIPLE_EXECUTION_INTENT.test(text);
  } catch {
    return true;
  }
}

/**
 * Classify only a direct, non-poll Composio READ carrying verified terminal
 * data. Formatted tool returns may append routing prose, so recover the one
 * balanced leading JSON value before applying the settled-data verifier.
 */
export function classifySettledDirectComposioRead(input: {
  toolName: string;
  args: unknown;
  output: string;
}): SettledDirectComposioRead | null {
  const toolSlug = composioSlugFromArgs(input.toolName, input.args);
  if (!toolSlug || classifyComposioSlugEffect(toolSlug) !== 'read') return null;
  if (composioActionIsEphemeralCompute(toolSlug)) return null;
  if (composioReadHasPollSemantics(toolSlug)) return null;
  const candidate = extractJsonCandidate(input.output);
  if (!candidate) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!settlementCarriesVerifiedData(parsed)) return null;
  if (containsPendingAsyncState(parsed)) return null;
  try {
    if (detectJobReceipt(toolSlug, parsed)) return null;
  } catch {
    return null;
  }
  return { toolSlug, parsedResult: parsed as Record<string, unknown> };
}

/** Model-facing text for the one-shot advisory/recovery rail. */
export function formatSettledReadRepeatAdvisory(input: {
  toolSlug: string;
  sourceCallId: string;
  recoveredAcrossBehaviorScope: boolean;
}): string {
  const recovery = input.recoveredAcrossBehaviorScope
    ? 'The harness recovered the settled result from the earlier internal attempt for this same accepted request; no provider call was repeated.'
    : 'This exact read already succeeded in the current internal turn; no provider call was repeated.';
  return `[harness settled-read replay] ${recovery} Use the ${input.toolSlug} result from call_id "${input.sourceCallId}" for the next step or answer naturally. Do not issue this exact read again in this accepted request.`;
}

/** A compact first-success steer keeps capable models from requesting the
 * duplicate in the first place. This is attached only after the clean result
 * has passed settlement/learning, and only for the same narrow classifier the
 * deterministic replay guard trusts. */
export function formatSettledReadSuccessAdvisory(toolSlug: string): string {
  return `[harness settled-read] Fresh ${toolSlug} data for this accepted request is above. Use it for the next step or answer naturally; do not issue the exact call again unless a write changes the source or the user starts a new request.`;
}

/** Remove this rail's model-facing control-plane prose before tool output is
 * parked, reflected, or learned. Other independently-owned blocks are left for
 * their own sanitizers so this helper cannot mutate provider-shaped content. */
export function stripSettledReadHarnessAdvisory(output: string): string {
  return output.replace(
    /(?:^|(?:\r?\n){1,2})\[harness settled-read(?: replay)?\] (?:Fresh |The harness recovered |This exact read already succeeded)[^\r\n]*(?=\r?\n|$)/gm,
    '',
  );
}

/** Canonical data for the existing guardrail_tripped event type. */
export function settledReadRepeatReplayMarker(input: {
  replayCallId: string;
  replayCalledEventId: string;
  sourceCallId: string;
  sourceUserSeq: number;
  toolSlug: string;
  sourceBehaviorScopeId: string;
  replayBehaviorScopeId: string;
}): Record<string, unknown> {
  return {
    kind: SETTLED_READ_REPEAT_REPLAY_KIND,
    replayCallId: input.replayCallId,
    replayCalledEventId: input.replayCalledEventId,
    replayTool: DIRECT_COMPOSIO_TOOL,
    replayEffect: 'read',
    sourceCallId: input.sourceCallId,
    sourceUserSeq: input.sourceUserSeq,
    toolSlug: input.toolSlug,
    sourceBehaviorScopeId: input.sourceBehaviorScopeId,
    replayBehaviorScopeId: input.replayBehaviorScopeId,
  };
}

function replayCalledEventIds(events: readonly EventRow[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'guardrail_tripped') continue;
    if (event.data.kind !== SETTLED_READ_REPEAT_REPLAY_KIND) continue;
    const calledEventId = nonEmptyString(event.data.replayCalledEventId);
    if (calledEventId) ids.add(calledEventId);
  }
  return ids;
}

/** Hook-side disposition: a replay remains visible in the lifecycle audit but
 * must not be parked/reflected/learned as a new physical provider result. */
export function settledReadRepeatReplayDisposition(
  input: SettledReadRepeatReplayLookup,
): SettledReadRepeatReplayDisposition | null {
  try {
    if (!input.sessionId.trim()
      || !input.replayCallId.trim()
      || !input.replayCalledEventId.trim()
      || input.toolName !== DIRECT_COMPOSIO_TOOL
      || input.effect !== 'read'
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || !input.replayBehaviorScopeId.trim()
      || !input.toolSlug.trim()) return null;
    const called = getEvent(input.replayCalledEventId);
    if (!called
      || called.sessionId !== input.sessionId
      || called.type !== 'tool_called'
      || eventString(called, 'callId') !== input.replayCallId
      || eventString(called, 'tool') !== input.toolName
      || eventString(called, 'effect') !== input.effect
      || eventNumber(called, 'sourceUserSeq') !== input.sourceUserSeq
      || eventString(called, 'runScopeId') !== input.replayBehaviorScopeId
      || eventToolSlug(called) !== input.toolSlug) return null;
    // Search only the tiny post-call window. This stays independent of total
    // session history without a correctness-losing fixed-row cap: even an
    // unusually busy same-session interval cannot make replay bytes look fresh.
    const matches = listEvents(input.sessionId, {
      sinceSeq: called.seq,
      types: ['guardrail_tripped'],
    })
      .filter((event) => event.data.kind === SETTLED_READ_REPEAT_REPLAY_KIND
        && event.data.replayCallId === input.replayCallId
        && event.data.replayCalledEventId === input.replayCalledEventId
        && event.data.replayTool === input.toolName
        && event.data.replayEffect === input.effect
        && event.data.sourceUserSeq === input.sourceUserSeq
        && event.data.replayBehaviorScopeId === input.replayBehaviorScopeId
        && event.data.toolSlug === input.toolSlug);
    if (matches.length !== 1) return null;
    const data = matches[0]!.data;
    const sourceCallId = nonEmptyString(data.sourceCallId);
    const toolSlug = nonEmptyString(data.toolSlug);
    const sourceUserSeq = data.sourceUserSeq;
    if (!sourceCallId || !toolSlug
      || typeof sourceUserSeq !== 'number'
      || !Number.isSafeInteger(sourceUserSeq)
      || sourceUserSeq <= 0) return null;
    return {
      replayCallId: input.replayCallId,
      replayCalledEventId: input.replayCalledEventId,
      sourceCallId,
      sourceUserSeq,
      toolSlug,
    };
  } catch {
    return null;
  }
}

function sameCanonicalCall(event: EventRow, toolName: string, signature: string): boolean {
  if (event.type !== 'tool_called' || eventString(event, 'tool') !== toolName) return false;
  const eventArgs = parseExactArguments(event.data.arguments);
  return eventArgs !== null && hashToolCall(toolName, eventArgs) === signature;
}

function matchingReturn(events: readonly EventRow[], called: EventRow): EventRow | null {
  const callId = eventString(called, 'callId');
  const matches = events.filter((event) =>
    event.type === 'tool_returned'
    && event.parentEventId === called.id
    && eventString(event, 'callId') === callId
  );
  return matches.length === 1 ? matches[0]! : null;
}

function interveningMutationOrSteer(
  events: readonly EventRow[],
  returnedSeq: number,
  currentCalledSeq: number,
): boolean {
  for (const event of events) {
    if (event.seq <= returnedSeq || event.seq >= currentCalledSeq) continue;
    if (event.type === 'user_steer_note' || event.type === 'user_input_received') return true;
    if (event.type !== 'tool_called') continue;
    // Current lifecycle rows always carry an effect. A legacy/malformed row in
    // the interval is unknown state, so decline recovery rather than guess.
    if (eventString(event, 'effect') !== 'read') return true;
  }
  return false;
}

/**
 * Recover the durable bytes from a direct read that settled immediately before
 * a model/infrastructure failure.
 *
 * Unlike resolveSettledReadRepeat, this runs before a replacement call exists.
 * The durable run-attempt binding, exact source/turn attribution, and the latest
 * canonical occurrence together provide the upper boundary. Only that latest
 * occurrence may recover: if a later call started (including a timed-out one),
 * the earlier read is not enough to answer and this optimization fails closed.
 */
export function resolveSettledReadForInfraRecovery(
  input: ResolveSettledReadInfraRecoveryInput,
): SettledReadInfraRecovery | null {
  try {
    if (!input.sessionId.trim()
      || !input.runAttemptId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || !Number.isSafeInteger(input.failedTurn)
      || input.failedTurn <= 0) return null;

    const boundSource = getRunAttemptSourceUserEvent({
      sessionId: input.sessionId,
      attemptId: input.runAttemptId,
    });
    if (!boundSource || boundSource.seq !== input.sourceUserSeq) return null;
    if (acceptedSourceRequestsPolling(input.sessionId, input.sourceUserSeq)) return null;

    const events = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: [
        'tool_called',
        'tool_returned',
        'guardrail_tripped',
        'user_input_received',
        'user_steer_note',
      ],
    });
    const canonicalCalls = events
      .filter((event) => event.type === 'tool_called'
        && event.turn === input.failedTurn
        && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
        && eventString(event, 'attemptId') === input.runAttemptId
        && eventString(event, 'accounting') === 'top_level')
      .sort((a, b) => b.seq - a.seq);
    const called = canonicalCalls[0];
    if (!called
      || eventString(called, 'tool') !== DIRECT_COMPOSIO_TOOL
      || eventString(called, 'effect') !== 'read'
      || replayCalledEventIds(events).has(called.id)) return null;

    const args = parseExactArguments(called.data.arguments);
    if (!args) return null;
    const calledSlug = composioSlugFromArgs(DIRECT_COMPOSIO_TOOL, args);
    if (!calledSlug || eventToolSlug(called) !== calledSlug) return null;

    const returned = matchingReturn(events, called);
    if (!returned
      || returned.turn !== input.failedTurn
      || eventNumber(returned, 'sourceUserSeq') !== input.sourceUserSeq
      || eventString(returned, 'attemptId') !== input.runAttemptId
      || eventString(returned, 'accounting') !== 'top_level'
      || eventString(returned, 'tool') !== DIRECT_COMPOSIO_TOOL
      || eventString(returned, 'effect') !== 'read'
      || eventToolSlug(returned) !== calledSlug
      || returned.data.providerDispatched === false
      || nonEmptyString(returned.data.replayKind)) return null;
    if (interveningMutationOrSteer(events, returned.seq, Number.POSITIVE_INFINITY)) return null;

    const returnedAt = Date.parse(returned.createdAt);
    const now = Date.now();
    if (!Number.isFinite(returnedAt)
      || now < returnedAt
      || now - returnedAt > settledReadRepeatMaxAgeMs()) return null;

    const sourceCallId = eventString(called, 'callId');
    if (!sourceCallId) return null;
    const authority = resolveToolOutputForAuthority(input.sessionId, sourceCallId);
    if (authority.status !== 'ok'
      || authority.effect !== 'read'
      || authority.sourceUserSeq !== input.sourceUserSeq
      || authority.record.truncatedAtWrite) return null;
    const output = stripSettledReadHarnessAdvisory(authority.record.output);
    if (!output.trim()
      || Buffer.byteLength(output, 'utf8') > INFRA_RECOVERY_MAX_OUTPUT_BYTES) return null;
    const settled = classifySettledDirectComposioRead({
      toolName: DIRECT_COMPOSIO_TOOL,
      args,
      output,
    });
    if (!settled || settled.toolSlug !== calledSlug) return null;

    return {
      sourceCallId,
      sourceReturnedSeq: returned.seq,
      output,
      toolSlug: calledSlug,
    };
  } catch {
    // Recovery never gains authority by throwing or guessing.
  }
  return null;
}

/**
 * Resolve the authoritative prior bytes for one redundant direct read.
 *
 * The current call must already have its hook-authored tool_called event. That
 * gives this lookup an exact upper boundary and proves the supplied accepted
 * source/run scope match the live invocation. The prior lifecycle may belong
 * to an older behavior scope (infra recovery), but never to an older user
 * source.
 */
export function resolveSettledReadRepeat(
  input: ResolveSettledReadRepeatInput,
): SettledReadRepeatResolution | null {
  try {
    if (!input.sessionId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || !input.currentCallId.trim()
      || !input.currentBehaviorScopeId.trim()) return null;

    const currentSlug = composioSlugFromArgs(input.toolName, input.args);
    if (!currentSlug || classifyComposioSlugEffect(currentSlug) !== 'read') return null;
    if (composioActionIsEphemeralCompute(currentSlug)) return null;
    if (composioReadHasPollSemantics(currentSlug)) return null;
    if (acceptedSourceRequestsPolling(input.sessionId, input.sourceUserSeq)) return null;

    const events = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: [
        'tool_called',
        'tool_returned',
        'guardrail_tripped',
        'user_input_received',
        'user_steer_note',
      ],
    });
    const currentCalls = events.filter((event) =>
      event.type === 'tool_called'
      && eventString(event, 'callId') === input.currentCallId
      && !events.some((candidate) => candidate.type === 'tool_returned'
        && candidate.parentEventId === event.id
        && eventString(candidate, 'callId') === input.currentCallId)
    );
    if (currentCalls.length !== 1) return null;
    const current = currentCalls[0]!;
    if (eventNumber(current, 'sourceUserSeq') !== input.sourceUserSeq
      || eventString(current, 'runScopeId') !== input.currentBehaviorScopeId
      || eventString(current, 'tool') !== input.toolName
      || eventString(current, 'effect') !== 'read'
      || eventToolSlug(current) !== currentSlug
      || eventString(current, 'accounting') === 'transport_mirror') return null;

    const signature = hashToolCall(input.toolName, input.args);
    if (!sameCanonicalCall(current, input.toolName, signature)) return null;
    const replayed = replayCalledEventIds(events);
    const candidates = events
      .filter((event) => event.seq < current.seq
        && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
        && eventString(event, 'effect') === 'read'
        && eventToolSlug(event) === currentSlug
        && eventString(event, 'accounting') !== 'transport_mirror'
        && sameCanonicalCall(event, input.toolName, signature))
      .sort((a, b) => b.seq - a.seq);

    for (const called of candidates) {
      const sourceCallId = eventString(called, 'callId');
      if (!sourceCallId || replayed.has(called.id)) continue;
      const returned = matchingReturn(events, called);
      // The newest non-replay exact occurrence is the freshness authority. If
      // it is incomplete/ambiguous/failed, never fall back to an older result.
      if (!returned
        || eventNumber(returned, 'sourceUserSeq') !== input.sourceUserSeq
        || eventString(returned, 'tool') !== input.toolName
        || eventString(returned, 'effect') !== 'read'
        || eventToolSlug(returned) !== currentSlug) return null;
      if (interveningMutationOrSteer(events, returned.seq, current.seq)) return null;
      const returnedAt = Date.parse(returned.createdAt);
      const currentAt = Date.parse(current.createdAt);
      if (!Number.isFinite(returnedAt)
        || !Number.isFinite(currentAt)
        || currentAt < returnedAt
        || currentAt - returnedAt > settledReadRepeatMaxAgeMs()) return null;

      const authority = resolveToolOutputForAuthority(input.sessionId, sourceCallId);
      if (authority.status !== 'ok'
        || authority.effect !== 'read'
        || authority.record.truncatedAtWrite) return null;
      const settled = classifySettledDirectComposioRead({
        toolName: input.toolName,
        args: input.args,
        output: authority.record.output,
      });
      if (!settled || settled.toolSlug !== currentSlug) return null;
      const modelFacingOutput = returned.data.result;
      if (typeof modelFacingOutput !== 'string' || !modelFacingOutput.trim()) return null;
      const replayOutput = stripSettledReadHarnessAdvisory(modelFacingOutput);
      if (!replayOutput.trim()) return null;
      const sourceBehaviorScopeId = eventString(called, 'runScopeId');
      if (!sourceBehaviorScopeId) return null;
      return {
        currentCalledEventId: current.id,
        sourceCallId,
        sourceBehaviorScopeId,
        sourceReturnedSeq: returned.seq,
        // Replay the bounded text the original model lifecycle recorded (8KB
        // by default, with a recall_tool_result hint), never the side store's
        // potentially multi-megabyte authority bytes.
        output: replayOutput,
        toolSlug: currentSlug,
        recoveredAcrossBehaviorScope: sourceBehaviorScopeId !== input.currentBehaviorScopeId,
      };
    }
  } catch {
    // A recovery optimization never gains authority by throwing.
  }
  return null;
}
