import { savedMemoryCorrectionClaim } from './saved-memory-correction.js';
import type { ConsolidatedFactKind } from './db.js';
import type { ConsolidatedFact } from './facts.js';
import {
  drainDurableConsolidationCandidates,
  enqueueAutoCaptureCandidates,
  UNJUDGED_OWNER_STATEMENT_REASON,
} from './durable-consolidation.js';
import { extractNamedResource } from './focus.js';
import type { UserProfile } from '../runtime/user-profile.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { readSourceSessionContext } from '../runtime/harness/source-session-context.js';
import { currentSourceSessionContext } from '../runtime/harness/source-session-context-scope.js';
import { createAutomaticMemoryOrigin, type AutomaticMemoryOrigin,
  type AutomaticMemoryOriginInput, type MemoryDestinationSpan } from './memory-destination.js';
import { getRuntimeEnv } from '../config.js';
import { isHarnessInjectedInput } from '../runtime/harness/objective-judge.js';
import { EXPLICIT_MEMORY_INSTRUCTION_RE, isSelfContainedComputation } from '../assistant/message-intent.js';
import { hasUnresolvedExplicitMemoryReference, isUnresolvedMemoryReferencePayload } from './unresolved-memory-reference.js';
import pino from 'pino';

/** Defense-in-depth (2026-06-23): auto-memory must learn only from REAL user
 *  messages — never from harness/judge/stall/grounding/outcome re-prompts that
 *  the loop records as user_input_received. Those were being stored as pinned
 *  "Standing prohibition" facts injected into every chat + voice prompt. Kill
 *  switch (default on); =off disables only this legacy text layer. Exact
 *  source-provenance admission below is unconditional. */
function autoCaptureHarnessSkipEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_AUTO_CAPTURE_HARNESS_SKIP', 'on') ?? 'on').toLowerCase() !== 'off';
}

const logger = pino({ name: 'clementine.auto-capture' });

/**
 * A pasted workflow/step DEFINITION (the "Workflow: <name> … Step: <name> …"
 * shape) is a structured artifact, not a user statement. PROJECT_TERMS matches
 * the literal word "workflow", so without this guard such a paste is folded
 * into a `Clementine requirement: …` fact — the 2026-06-08 audit found many such
 * polluting rows. The real definition already lives in the workflow store, so
 * dropping the fragmentary capture loses no knowledge. Requires BOTH markers so
 * casual prose mentioning a single "workflow:" or "step:" is never dropped.
 * Flag-gated (CLEMMY_AUTOCAP_SKIP_WORKFLOW_TEXT, default ON).
 */
function looksLikeWorkflowDefinitionDump(text: string): boolean {
  return /\bworkflow:\s/i.test(text) && /\bstep:\s/i.test(text);
}
function autocapSkipWorkflowTextEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_AUTOCAP_SKIP_WORKFLOW_TEXT', 'on') || 'on').toLowerCase() !== 'off';
}

export interface AutoMemoryCandidate {
  kind: ConsolidatedFactKind;
  content: string;
  reason: string;
  /** Pin the resulting fact (always-injected, decay-exempt). Set for a
   *  safety-critical prohibition so it can never be scoped out at action time. */
  pin?: boolean;
}

export interface AutoCaptureResult {
  candidates: AutoMemoryCandidate[];
  /** Always empty now — user-stated facts are consolidated asynchronously
   *  through the Mem0 conflict resolver (see captureInteractionSignals),
   *  so committed rows aren't known synchronously. Kept for back-compat;
   *  callers should report on `candidates` instead. */
  facts: ConsolidatedFact[];
  /** Durable learned-claim rows written before asynchronous consolidation. */
  queuedCandidateIds?: number[];
  episodeId?: string | null;
  /** Stable intake call identity. This is evidence metadata only; callers may
   * not treat its presence as completion authority without redeeming the
   * normalized host receipt against the memory ledger. */
  callId?: string | null;
  profilePatch?: Record<string, unknown>;
  profile?: UserProfile;
}

/** Immutable source authority for automatic memory admission. Automatic
 * memory must never infer authorship from prose: runtime-authored carriers are
 * also stored as `user_input_received`, so eligibility follows the exact
 * accepted event (or an explicit direct-user boundary) instead. */
export type AutoCaptureSourceProvenance =
  | {
      authority: 'accepted_user_input';
      sessionId: string;
      eventId: string;
      seq: number;
      role: string;
      type: string;
      data: Record<string, unknown>;
    }
  | {
      authority: 'direct_user_input';
      role: 'user';
      type: 'direct_user_input';
      data: Record<string, unknown> & { synthetic: false };
    };

type AcceptedAutoCaptureEvent = {
  sessionId: string;
  id: string;
  seq: number;
  role: string;
  type: string;
  data: Record<string, unknown>;
};

export function autoCaptureProvenanceFromAcceptedEvent(
  event: AcceptedAutoCaptureEvent,
): AutoCaptureSourceProvenance {
  return {
    authority: 'accepted_user_input',
    sessionId: event.sessionId,
    eventId: event.id,
    seq: event.seq,
    role: event.role,
    type: event.type,
    data: event.data,
  };
}

export function autoCaptureProvenanceFromDirectUserInput(
  source: string,
): AutoCaptureSourceProvenance {
  return {
    authority: 'direct_user_input',
    role: 'user',
    type: 'direct_user_input',
    data: { synthetic: false, source },
  };
}

const MACHINE_CAPTURE_CARRIER_RE =
  /(?:^|[^a-z0-9])(?:outcome|system|harness|notification|daemon|workflow|background|execution|cron|controller|agent)(?:$|[^a-z0-9])/i;

function machineCarrierValue(value: unknown): boolean {
  return typeof value === 'string' && MACHINE_CAPTURE_CARRIER_RE.test(value.trim());
}

/** Pure, fail-closed provenance predicate shared with the independently
 * re-derived durable host receipt. Missing provenance is never user authority. */
export function isEligibleAutoCaptureSourceProvenance(
  provenance: AutoCaptureSourceProvenance | undefined,
  expected: { sessionId?: string; sourceEventId?: string } = {},
): boolean {
  if (!provenance || provenance.role !== 'user') return false;
  if (provenance.authority === 'accepted_user_input') {
    // Two durable user rows carry owner words: the accepted source and a
    // mid-run steer note. Each binds its own source-event identity so a
    // capture request cannot present one row's sequence as the other's.
    const expectedSourceEventId = provenance.type === 'user_input_received'
      ? `user-source:${provenance.seq}`
      : provenance.type === 'user_steer_note'
        ? `user-steer:${provenance.seq}`
        : null;
    if (
      expectedSourceEventId === null
      || !provenance.sessionId
      || !provenance.eventId
      || !Number.isSafeInteger(provenance.seq)
      || provenance.seq <= 0
    ) return false;
    // The accepted-event variant is exact only when the capture request binds
    // the same durable session + sequence. A detached EventRow-shaped object
    // is not sufficient authority by itself.
    if (!expected.sessionId || !expected.sourceEventId) return false;
    if (provenance.sessionId !== expected.sessionId) return false;
    if (expected.sourceEventId !== expectedSourceEventId) return false;
  } else if (provenance.data.synthetic !== false) {
    // A direct boundary has no event row to re-read, so it must positively
    // attest that the input came from the user-facing request boundary.
    return false;
  }

  const data = provenance.data;
  if (data.synthetic === true || data.system === true || data.notification === true) return false;
  // Malformed/non-boolean machine flags fail closed instead of being coerced.
  if ('synthetic' in data && data.synthetic !== undefined && typeof data.synthetic !== 'boolean') return false;
  if ('system' in data && data.system !== undefined && typeof data.system !== 'boolean') return false;
  if ('notification' in data && data.notification !== undefined && typeof data.notification !== 'boolean') return false;
  if (
    machineCarrierValue(data.source)
    || machineCarrierValue(data.carrier)
    || machineCarrierValue(data.origin)
  ) return false;
  return true;
}

function normalizeOwnerText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The owner's own words on an accepted source row: what they typed or saw
 * sent, never a host expansion of it. A surface may keep a display copy beside
 * the typed text; either is the owner's. */
export function acceptedOwnerTexts(data: Record<string, unknown>): string[] {
  const typed = [data.displayText, data.text]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (typed.length > 0) return typed;
  return typeof data.message === 'string' && data.message.trim() ? [data.message] : [];
}

/** The owner text automatic memory should learn from, in display precedence. */
export function acceptedOwnerText(data: Record<string, unknown>): string {
  return acceptedOwnerTexts(data)[0] ?? '';
}

/** Automatic memory learns only the owner's words. A host may expand an
 * accepted source for the model — a reviewed plan, a clarification capsule, a
 * retry prompt — and that expansion carries the source's identity without being
 * its author's statement. A message outside the accepted text is therefore not
 * admissible; a narrower clause of it (the fresh clause after a decline) is. */
export function captureMessageIsOwnerAuthored(
  message: string,
  provenance: AutoCaptureSourceProvenance,
): boolean {
  if (provenance.authority !== 'accepted_user_input') return true;
  const candidate = normalizeOwnerText(message);
  if (!candidate) return false;
  return acceptedOwnerTexts(provenance.data)
    .some((text) => normalizeOwnerText(text).includes(candidate));
}

/** Extraction keeps offsets privately so the public candidate shape stays
 * compatible. Offsets always describe the complete source claim, even when
 * the old display candidate has a host wrapper or preview-length cap. */
const candidateSourceSpans = new WeakMap<AutoMemoryCandidate, { source: string; span: MemoryDestinationSpan }>();
const instructionSourceSpans = new WeakMap<ExplicitMemoryInstructionParse, MemoryDestinationSpan>();

function normalizedSourceView(source: string): { text: string; starts: number[]; ends: number[] } {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of source.matchAll(/\s+|[^\s]/gu)) {
    const token = /^\s/u.test(match[0]) ? ' ' : match[0];
    for (let unit = 0; unit < token.length; unit++) {
      text += token[unit]; starts.push(match.index + (token.length > 1 ? unit : 0));
      ends.push(match.index + (token.length > 1 ? unit + 1 : match[0].length));
    }
  }
  return { text, starts, ends };
}

/** Whitespace-only fallback for callers supplying a narrowed source. Never
 * choose an arbitrary repeated occurrence when its original offset was lost. */
export function uniqueAutomaticMemorySpan(source: string, text: string): MemoryDestinationSpan | null {
  const wanted = normalizeOwnerText(text);
  if (!wanted) return null;
  const view = normalizedSourceView(source);
  const start = view.text.indexOf(wanted);
  if (start < 0 || view.text.indexOf(wanted, start + 1) >= 0) return null;
  return { start: view.starts[start]!, end: view.ends[start + wanted.length - 1]! };
}

function rawNormalizedSpan(source: string, normalized: string, span: MemoryDestinationSpan): MemoryDestinationSpan | null {
  const view = normalizedSourceView(source);
  // clean() only trims whitespace and enclosing literal delimiters. Locate
  // that complete cleaned view by its known enclosing trim, not a claim search.
  let start = view.text.length - view.text.trimStart().length;
  let end = view.text.trimEnd().length;
  while (end - start >= 2 && /["'`]/.test(view.text[start]!) && view.text[start] === view.text[end - 1]) {
    start++; end--;
    while (start < end && /\s/.test(view.text[start]!)) start++;
    while (end > start && /\s/.test(view.text[end - 1]!)) end--;
  }
  if (view.text.slice(start, end) !== normalized || span.start < 0 || span.end > normalized.length || span.end <= span.start) return null;
  return { start: view.starts[start + span.start]!, end: view.ends[start + span.end - 1]! };
}

function automaticMemorySource(input: {
  message: string; sessionId: string; sourceEventId?: string; sourceProvenance: AutoCaptureSourceProvenance;
}): AutomaticMemoryOriginInput['source'] | null {
  const provenance = input.sourceProvenance;
  if (provenance.authority === 'direct_user_input') {
    return { authority: 'direct_user_input', sessionId: input.sessionId, eventId: null, eventSeq: null,
      eventType: 'direct_user_input', ownerText: input.message, context: null };
  }
  try {
    const row = openEventLog().prepare('SELECT id, seq, role, type, data_json FROM events WHERE session_id = ? AND seq = ?')
      .get(input.sessionId, provenance.seq) as { id: string; seq: number; role: string; type: string; data_json: string } | undefined;
    if (!row || row.id !== provenance.eventId || row.role !== provenance.role || row.type !== provenance.type) return null;
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const actual = autoCaptureProvenanceFromAcceptedEvent({ ...row, sessionId: input.sessionId, data });
    if (!isEligibleAutoCaptureSourceProvenance(actual, input)) return null;
    const ownerText = acceptedOwnerText(data);
    if (!ownerText || automaticOwnerPrivacyRefused(ownerText) || ownerText !== acceptedOwnerText(provenance.data)
      || !normalizeOwnerText(ownerText).includes(normalizeOwnerText(input.message))) return null;
    // A steer belongs to its own owner row, but inherits only the currently
    // verified execution context. It cannot masquerade as an accepted task.
    const active = currentSourceSessionContext(input.sessionId);
    const context = row.type === 'user_input_received'
      ? readSourceSessionContext({ sessionId: input.sessionId, sourceUserSeq: row.seq })
      : active ? readSourceSessionContext(active, active.digest) : null;
    return { authority: 'accepted_user_input', sessionId: input.sessionId, eventId: row.id, eventSeq: row.seq,
      eventType: row.type as 'user_input_received' | 'user_steer_note', ownerText,
      context: context ? { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq,
        digest: context.digest, memoryScope: { ...context.memoryScope } } : null };
  } catch { return null; }
}

/** Reopen the retained source, never today's session scope. A missing source,
 * changed owner bytes, or replaced project/agent leaves intake unqualified. */
export function automaticMemoryOriginSourceIsCurrent(origin: AutomaticMemoryOrigin): boolean {
  const source = origin.source;
  if (source.authority !== 'accepted_user_input' || !source.context) return false;
  try {
    const row = openEventLog().prepare('SELECT id, seq, role, type, data_json FROM events WHERE session_id = ? AND seq = ?')
      .get(source.sessionId, source.eventSeq) as { id: string; seq: number; role: string; type: string; data_json: string } | undefined;
    if (!row || row.id !== source.eventId || row.type !== source.eventType) return false;
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const provenance = autoCaptureProvenanceFromAcceptedEvent({ ...row, sessionId: source.sessionId, data });
    const token = row.type === 'user_steer_note' ? 'user-steer' : 'user-source';
    if (!isEligibleAutoCaptureSourceProvenance(provenance, { sessionId: source.sessionId, sourceEventId: `${token}:${row.seq}` })
      || acceptedOwnerText(data) !== source.ownerText || automaticOwnerPrivacyRefused(source.ownerText)) return false;
    const context = readSourceSessionContext(source.context, source.context.digest);
    return context !== null && context.memoryScope.projectId === source.context.memoryScope.projectId
      && context.memoryScope.agentKey === source.context.memoryScope.agentKey;
  } catch { return false; }
}

/** Shared with exact-source intake verification. Wrappers belong to the host,
 * not to the owner's claim. Unknown mappings retain the full source as held
 * evidence, never as a license to save a rewritten or truncated claim. */
export function automaticMemoryOriginsForCapture(input: {
  message: string; sessionId: string; sourceEventId?: string; sourceProvenance: AutoCaptureSourceProvenance;
}, candidates: readonly AutoMemoryCandidate[]): Array<AutomaticMemoryOrigin | null> {
  const source = automaticMemorySource(input);
  if (!source) return candidates.map(() => null);
  return candidates.map(candidate => {
    const retained = candidateSourceSpans.get(candidate);
    const narrowed = normalizeOwnerText(source.ownerText) === normalizeOwnerText(input.message)
      ? { start: 0, end: source.ownerText.length } : uniqueAutomaticMemorySpan(source.ownerText, input.message);
    let exact: MemoryDestinationSpan | null = null;
    if (retained?.source === input.message && narrowed) {
      // Map the known extraction interval through the narrowed view. The whole
      // narrowed view must be unique; a repeated claim within it is unambiguous.
      const local = normalizedSourceView(input.message);
      const first = local.starts.findIndex(offset => offset === retained.span.start);
      const last = local.ends.lastIndexOf(retained.span.end);
      const raw = normalizedSourceView(source.ownerText.slice(narrowed.start, narrowed.end));
      const localStart = local.text.length - local.text.trimStart().length;
      const rawStart = raw.text.length - raw.text.trimStart().length;
      if (first >= localStart && last >= first && local.text.trim() === raw.text.trim()) {
        exact = { start: narrowed.start + raw.starts[first - localStart + rawStart]!,
          end: narrowed.start + raw.ends[last - localStart + rawStart]! };
      }
    }
    const complete = candidate.reason === 'explicit remember request' || candidate.reason === 'explicit durable correction'
      || candidate.pin === true;
    return createAutomaticMemoryOrigin({ source, claim: exact ?? { start: 0, end: source.ownerText.length },
      claimMode: exact ? complete ? 'complete' : 'selectable' : 'unresolved',
      candidate: { kind: candidate.kind, text: candidate.content } });
  });
}

function emptyAutoCaptureResult(): AutoCaptureResult {
  return { candidates: [], facts: [], profilePatch: undefined, profile: undefined };
}

const PROJECT_TERMS = /\b(clementine|clemmy|agent|assistant|dashboard|discord|composio|memory|workflow|autonom(?:y|ous)|setup|install|mcp|oauth|keychain|electron|tooling|project)\b/i;
const PROJECT_REQUIREMENT_CUES = /\b(should|needs?|must|has to|have to|main goal|north star|goal|i want|i need|we need|make sure|be able to|easy to|full autonomous|proactive|persistent|long-running|long lasting)\b/i;
// Bare "always" / "never" are intentionally NOT preference signals. They are
// common in task history ("the deploy never actually ran") and were the main
// source of one-turn requests becoming permanent, pinned instructions.
const FEEDBACK_CUES = /\b(i (?:do not|don'?t) like|i hate|i would rather|i prefer|instead of|from now on|please (?:always|never|don'?t|do not)|too noisy|not helpful)\b/i;
const EXPLICIT_PREFERENCE_CUES = /\b(?:i (?:do not|don'?t) like|i hate|i would rather|i prefer|too noisy|not helpful)\b/i;
const CONNECTED_APP_TERMS = /\b(composio|outlook|gmail|google calendar|calendar|slack|notion|github|linear|asana|salesforce|hubspot|drive|docs|sheets)\b/i;
const CONNECTED_APP_CUES = /\b(i|we|the agent|users?)\s+(?:use|uses|have|has|need|needs|want|wants|connect|connects|access|auth|authenticate|oauth)\b/i;

const LOW_SIGNAL = /^(approve|approved|reject|rejected|yes|no|ok|okay|cool|perfect|nice|thanks|thank you|lets do it|let'?s do it|keep going|continue|great job|sounds good)[.!?]*$/i;

// Safety-critical PROHIBITION: a durable "never / do not <comms-or-mutating
// action>" rule. These are the highest-stakes facts — they must NEVER be scoped
// out of the prompt at action time — so when one is detected the fact is
// captured AND PINNED (always-injected, decay-exempt). Tight by design: a
// prohibition word AND an action verb, EXCLUDING one-off phrasing and the
// idiom "never mind" so chit-chat can't trip it.
const PROHIBITION_RE = /\b(?:never|under no circumstances|do not|don'?t|do n'?t)\b/i;
const PROHIBITION_ACTION_RE = /\b(?:send|sends|email|emails|e-?mail|cc|bcc|share|shares|post|posts|publish|delete|deletes|remove|removes|touch|modify|change|create|edit|save|write|mark|contact|message|reply|forward|push|deploy|overwrite|disclose|expose|text|dm|ping|notify)\b/i;
const PROHIBITION_ONE_OFF_RE = /\b(?:this once|just this|right now|today only|for now|this time|that one|never\s*mind)\b/i;
const NEGATED_ACTION_RE = /\b(?:do not|don'?t|do n'?t)\s+(?:(?:ever|also|just|please|blindly|accidentally|automatically|anything|any|the|a|an|it|this|that|or|and|,|-|\/)\s*){0,8}(?:send|sends|email|emails|e-?mail|cc|bcc|share|shares|post|posts|publish|delete|deletes|remove|removes|touch|modify|change|create|edit|save|write|mark|contact|message|reply|forward|push|deploy|overwrite|disclose|expose|text|dm|ping|notify)\b/i;
const HARD_PROHIBITION_RE = /\b(?:never|under no circumstances)\b(?:(?![.!?]).){0,120}\b(?:send|sends|email|emails|e-?mail|cc|bcc|share|shares|post|posts|publish|delete|deletes|remove|removes|touch|modify|change|create|edit|save|write|mark|contact|message|reply|forward|push|deploy|overwrite|disclose|expose|text|dm|ping|notify)\b/i;
const HISTORICAL_NEVER_RE = /\bnever\s+(?:actually|previously|yet|did|does|was|were|has|have|had|ran|happened|got|failed|finished|completed|executed|deployed|sent|wrote|created)\b/i;
const PERSISTENT_SCOPE_RE = /\b(?:always|from now on|from here on(?: out)?|going forward|by default|as a rule|each time|every time|whenever|in the future|for future|next time|under no circumstances)\b/i;
const ONE_OFF_TASK_SAFETY_RE = /(?:\b(?:read[- ]only|live\s+smoke|stress\s+test|draft\s+only|just\s+draft|after the tool returns|disposable|diagnostic|validation)\b|(?:^|[_\W])smoke(?:[_\W]|$))/i;
const ONE_OFF_TASK_START_RE = /^\s*(?:hey\s+)?(?:can you|could you|please|i (?:want|need) you to|we need you to|check|pull|draft|write|create|build|run|execute|deploy|send|email|post|update|fix|call|use|using|find|list|research|mock up|take|read|author)\b/i;
const TASK_REQUEST_RE = /(?:^|[.!?;]\s+|—\s+)(?:hey\s+)?(?:can you|could you|please|i (?:want|need) you to|we need you to|check|pull|draft|write|create|build|run|execute|deploy|send|email|post|update|fix|call|use|using|find|list|research|mock up|take|read|author)\b/i;
const CURRENT_TURN_SCOPE_RE = /\b(?:today|tomorrow|yesterday|right now|currently|this (?:request|run|turn|task|time)|for now|this once|that one|just answer|answer in chat|reply with|do not deploy yet|don'?t send yet|until (?:you|the|it)|disposable)\b/i;
const EXPLICIT_EPHEMERAL_SCOPE_RE = /\b(?:for|in|during)\s+this\s+(?:task|request|run|turn)\b/i;
const STANDALONE_PROHIBITION_START_RE = /^\s*(?:please\s+)?(?:never|under no circumstances|do not|don'?t|do n'?t)\b/i;
const STANDALONE_PROHIBITION_OBJECT_RE = /\b(?:this|that|it|these|those)\b|\b(?:yet|today|tonight|tomorrow|right now|for now|this time|this once)\b/i;
const CLEMENTINE_VISION_RE = /\b(?:i want|i need|we need)\s+(?:clementine|clemmy|the agent|my (?:agent|assistant))\s+to\b|\b(?:north star|main goal)\b/i;
const ONE_OFF_VALIDATION_RE = /\b(?:live\s+validation(?:\s+only)?|validation\s+only|live\s+read[- ]only\s+validation|read[- ]only\s+live\s+validation|read[- ]only\s+validation\s+after|live\s+validation\s+after|live\s+(?:local\s+)?safety\s+validation|(?:this\s+is\s+(?:a\s+)?)?(?:live|read[- ]only|local|safety)\s+diagnostic(?:\s+(?:only|probe|run|test))?|diagnostic\s+(?:only|probe|run|test))\b/i;
const MEMORY_CAPTURE_OPTOUT_RE = /\b(?:do\s+not|don'?t|do n'?t)\s+(?:(?:save|store|remember|capture|persist)\s+(?:this|it|that|the request|this request)?\s*(?:as|to|in)?\s*(?:a\s+)?(?:memory|durable memory|long[- ]term memory)?|(?:write(?:\s+to)?|change|modify|update)\s+(?:my\s+|the\s+|any\s+)?(?:memory|durable memory|long[- ]term memory))\b/i;
// A local task can be explicitly excluded from memory while another clause in
// the same turn explicitly grants durable authority ("do not save this task;
// remember X"). This shape is deliberately narrower than the general opt-out:
// only a named task object earns clause-local scope. Generic "this", "anything
// from this turn", and direct memory-store prohibitions remain turn-wide.
const TASK_SCOPED_MEMORY_OPTOUT_RE = /\b(?:do\s+not|don'?t|do n'?t)\s+(?:save|store|remember|capture|persist)\s+(?:(?:this|that|the)\s+)?(?:[\w-]+\s+){0,4}task\s+(?:as|to|in)\s+(?:a\s+)?(?:memory|durable memory|long[- ]term memory)\b/i;
const MUST_CALL_TOOL_RE = /\byou\s+must\s+call\s+\w+/i;
const DO_NOT_CALL_TOOL_RE = /\bdo\s+not\s+call\s+\w+/i;
const NO_EXTERNAL_CHANGES_RE = /\bdo\s+not\s+make\s+any\s+external\s+changes\b/i;
const ONE_OFF_CONNECTED_APP_LOOKUP_START_RE = /^\s*(?:hey\s+)?(?:can you|could you|please|check|pull|read|show|tell me|look|find|list|summari[sz]e|what(?:'s| is)?|do i have|any(?:thing)?)\b/i;
const ONE_OFF_CONNECTED_APP_LOOKUP_CONTEXT_RE = /\b(?:today|tomorrow|tmrw|tmr|yesterday|right now|currently|this (?:morning|afternoon|week|month)|next (?:day|week)|calendar|inbox|e-?mail|messages?|meetings?|events?|unread|connected|connection|connections|accounts?|usable|stale|available)\b/i;

function hasDirectSafetyProhibition(text: string): boolean {
  const directNegation = NEGATED_ACTION_RE.test(text);
  const hardStanding = HARD_PROHIBITION_RE.test(text) && !HISTORICAL_NEVER_RE.test(text);
  return hardStanding || directNegation;
}

function looksLikeOneOffTaskRequest(text: string): boolean {
  return ONE_OFF_TASK_START_RE.test(text) || TASK_REQUEST_RE.test(text);
}

function isStandaloneSafetyProhibition(text: string): boolean {
  if (text.length > 180 || !STANDALONE_PROHIBITION_START_RE.test(text)) return false;
  if (STANDALONE_PROHIBITION_OBJECT_RE.test(text)) return false;
  if (CURRENT_TURN_SCOPE_RE.test(text) || ONE_OFF_TASK_SAFETY_RE.test(text)) return false;
  // A second imperative after the prohibition means this is a task with a
  // local safety clause ("Do not send. Pull the records and answer here.").
  const afterFirstSentence = text.replace(/^[^.!?]*[.!?]\s*/, '');
  if (afterFirstSentence !== text && TASK_REQUEST_RE.test(afterFirstSentence)) return false;
  return true;
}

function isOneOffTaskSafetyInstruction(text: string): boolean {
  if (!hasDirectSafetyProhibition(text)) return false;
  if (ONE_OFF_TASK_SAFETY_RE.test(text)) return true;
  if (CURRENT_TURN_SCOPE_RE.test(text)) return true;
  return looksLikeOneOffTaskRequest(text) && /\b(?:today|tomorrow|this request|this run|this turn|this task|just|only|yet|until)\b/i.test(text);
}

function isOneOffValidationOrToolProbe(text: string): boolean {
  return ONE_OFF_VALIDATION_RE.test(text)
    || MEMORY_CAPTURE_OPTOUT_RE.test(text)
    || (MUST_CALL_TOOL_RE.test(text) && DO_NOT_CALL_TOOL_RE.test(text) && NO_EXTERNAL_CHANGES_RE.test(text));
}

function isOneOffConnectedAppLookup(text: string): boolean {
  return CONNECTED_APP_TERMS.test(text)
    && ONE_OFF_CONNECTED_APP_LOOKUP_START_RE.test(text)
    && ONE_OFF_CONNECTED_APP_LOOKUP_CONTEXT_RE.test(text);
}

function isSafetyProhibition(text: string): boolean {
  return PROHIBITION_RE.test(text)
    && PROHIBITION_ACTION_RE.test(text)
    && hasDirectSafetyProhibition(text)
    && !PROHIBITION_ONE_OFF_RE.test(text)
    && !isOneOffTaskSafetyInstruction(text)
    && (PERSISTENT_SCOPE_RE.test(text) || isStandaloneSafetyProhibition(text));
}

// Standing-rule capture — a durable "going forward / every Monday / by default"
// instruction that should PERSIST ACROSS SESSIONS (routed to the facts vault),
// as opposed to a one-off action (handled by the session-scoped Active Task pin
// in working-memory.ts). A marker alone is not enough — an imperative verb AND
// a concrete target are also required (see hasConcreteStandingTarget).
const STANDING_MARKER_RE = /\b(?:always|never|from now on|from here on(?: out)?|going forward|by default|as a rule|next time|in the future|for future|every (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|whenever)\b/i;
// The imperative verbs isDurableDeclarative explicitly rejects — exactly why a
// standing imperative is uncaptured today.
const STANDING_VERB_RE = /\b(?:send|e-?mail|message|dm|post|publish|reply|forward|cc|bcc|route|use)\b/i;
// NON-global on purpose: a /g regex carries lastIndex across .test() calls.
const STANDING_EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Determiner-qualified destination, allowing a few adjective words before the
// noun ("to the MARKETING list", "to my OUTREACH sheet"). Still bounded so it
// stays a destination phrase, not arbitrary prose.
const STANDING_LIST_PHRASE_RE = /\b(?:to|use)\s+(?:this|that|these|those|the following|the|my|our)\s+(?:[\w'-]+\s+){0,3}?(?:list|distro|group|team|sheet|doc|document|spreadsheet|folder|channel|inbox|account|mailbox|address)\b/i;

// Enforceable SENDER/account routing rule → kind:'constraint' (the dispatch gate
// enforces it; rememberFact auto-pins constraints). HIGH PRECISION on purpose:
// findEmailSendConstraint reads the FIRST email in the rule as the allowed FROM
// account, so a recipient mention ("email reports@acme.example weekly") must NEVER
// classify as a constraint — only an explicit from/use/as/via sender marker on
// the email qualifies. Default-on; kill-switch CLEMMY_AUTOCAP_CONSTRAINTS=off.
const SENDER_ACCOUNT_RE = /\b(?:from|as|using|use|via|through)\s+(?:the\s+)?(?:account\s+)?[\w.+-]+@[\w-]+\.[\w.-]+/i;
const EMAIL_APP_RE = /\b(?:outlook|gmail|e-?mail|mailbox|inbox)\b/i;
const STANDING_DIRECTIVE_RE = /\b(?:always|only|never|from now on|by default|going forward|each time|every time|whenever)\b/i;
function autocapConstraintsEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_AUTOCAP_CONSTRAINTS', 'on') || 'on').toLowerCase() !== 'off';
}
function isEnforceableSenderConstraint(text: string): boolean {
  return autocapConstraintsEnabled()
    && STANDING_DIRECTIVE_RE.test(text)
    && EMAIL_APP_RE.test(text)
    && SENDER_ACCOUNT_RE.test(text);
}

/**
 * A standing marker only earns a durable fact when it names a CONCRETE target:
 * a resource locator (sheet/doc id or URL), at least one email, or a determiner-
 * qualified list/distro/sheet phrase. This is the false-positive guard — a bare
 * exhortation ("going forward be careful", "I always forget lunch") never
 * qualifies. Shares extractNamedResource with the Active Task pin so "the user
 * named their own resource" means the same thing across both layers.
 */
function hasConcreteStandingTarget(text: string): boolean {
  return extractNamedResource(text) !== null
    || STANDING_EMAIL_RE.test(text)
    || STANDING_LIST_PHRASE_RE.test(text);
}

function clean(value: string, maxChars = 260): string {
  let text = value.replace(/\s+/g, ' ').trim();
  // Remove enclosing quotation only. A trailing quote can belong to a quoted
  // value inside the fact; dropping it changes the owner's recorded text.
  while (text.length >= 2 && /["'`]/.test(text[0]!) && text[0] === text.at(-1)) {
    text = text.slice(1, -1).trim();
  }
  return text.slice(0, maxChars);
}

/**
 * Keep explicit store requests as the fact itself, not as a second-order
 * "the user asked Clementine to remember..." wrapper. The full user turn still
 * lives in the evidence episode, so this only cleans the canonical claim that
 * is injected on later turns.
 *
 * Deliberately do not strip bare "remember to ...": that wording can describe
 * a reminder/task rather than a declarative fact, and preserving it is safer
 * than turning it into the awkward/ambiguous "to ...".
 */
const EXPLICIT_REMEMBER_LEADERS = [
    // Natural variants such as "remember this release-validation fact
    // exactly: <claim>" are still explicit store requests. Strip the
    // descriptive command wrapper before the generic "remember this" rule,
    // otherwise "release-validation fact exactly:" becomes part of memory.
    /^(?:please\s+)?remember\s+(?:this\s+)?(?:[\w-]+\s+){0,5}?fact(?:\s+exactly)?\s*:\s*/i,
    /^(?:please\s+)?remember\s+(?:for\s+later|for\s+future\s+reference)(?:\s+that)?\s*:?\s*/i,
    /^(?:please\s+)?remember\s+(?:this|that|exactly)\s*:?\s*/i,
    /^(?:please\s+)?remember\s*:\s*/i,
    // Keep bare "remember to ..." intact (see function comment), but clean
    // ordinary command forms such as "remember my name is Nathan".
    /^(?:please\s+)?remember\s+(?!to\b)/i,
    /^(?:please\s+)?note\s+that\s+/i,
    /^(?:please\s+)?note\s*:\s*/i,
    /^(?:please\s+)?keep\s+in\s+mind(?:\s+that)?\s+/i,
    /^(?:please\s+)?don'?t\s+forget(?:\s+that)?\s+/i,
    /^(?:please\s+)?make\s+a\s+note(?:\s+that)?\s*:?\s*/i,
] as const;

// A memory command may follow independent live work ("Summarize this, and
// remember that Cedar is Cedar-17"). Find only command-shaped occurrences at a
// clause boundary; a mid-sentence mention such as "explain what remember means"
// grants no durable-write authority. The shape is shared with the router
// (message-intent) so capture and routing can never disagree about what a
// memory instruction is.
const EXPLICIT_REMEMBER_COMMAND_RE = EXPLICIT_MEMORY_INSTRUCTION_RE;

const SECONDARY_MEMORY_REQUEST_VERB_SOURCE = [
  'answer', 'analy[sz]e', 'assess', 'advise', 'brainstorm', 'calculate',
  'check', 'clear', 'compare', 'create', 'delete', 'deploy', 'draft', 'edit',
  'email', 'evaluate', 'execute', 'explain', 'fetch', 'find', 'forget', 'give',
  'help', 'inspect', 'list', 'look\\s+up', 'manage', 'message', 'multiply',
  'outline', 'post', 'publish', 'purge', 'read', 'recommend', 'research',
  'restore', 'review', 'run', 'schedule', 'scrape', 'send', 'show',
  'summari[sz]e', 'take', 'tell', 'test', 'translate', 'unpin', 'update',
  'upload', 'verify', 'write',
].join('|');
const SECONDARY_MEMORY_QUESTION_SOURCE = '(?:what|when|where|who|why|how|which|do(?:es|did)?\\s+(?:you|we|i)|is|are|can|could|would|will|have|has)';
const SECONDARY_MEMORY_TOOL_NAME_SOURCE = 'memory_(?:forget|list_facts|read|recall_all|remember|restore|search)';
const SECONDARY_MEMORY_DELIVERABLE_SOURCE = '(?:answer|analysis|summary|report|brief|review|draft|email|message|list|outline|plan|recommendation|translation|update)';
const SECONDARY_MEMORY_ACTION_GERUND_SOURCE = '(?:analy[sz]ing|assessing|brainstorming|calculating|checking|comparing|creating|deleting|deploying|drafting|editing|emailing|evaluating|executing|explaining|fetching|finding|forgetting|helping|inspecting|listing|managing|messaging|outlining|posting|publishing|purging|reading|recommending|researching|restoring|reviewing|running|scheduling|scraping|sending|showing|summari[sz]ing|testing|translating|unpinning|updating|uploading|verifying|writing)';
const SECONDARY_MEMORY_MUTATION_PARTICIPLE_SOURCE = '(?:called|cleared|created|deleted|deployed|drafted|emailed|executed|forgotten|inserted|invoked|migrated|published|purged|refunded|removed|restored|reviewed|run|scheduled|sent|shared|tested|translated|unpinned|updated|uploaded|used|verified|written)';
const SECONDARY_MEMORY_MUTATION_FORM_SOURCE = `(?:${SECONDARY_MEMORY_MUTATION_PARTICIPLE_SOURCE}|${SECONDARY_MEMORY_ACTION_GERUND_SOURCE})`;
const SECONDARY_MEMORY_INDIRECT_REQUEST_SOURCE = [
  '(?:i|we)\\s+(?:have|had)\\s+(?:(?:a|another|one(?:\\s+more)?)\\s+)?questions?\\b',
  '(?:i|we)\\s+(?:wonder|wondered)\\b',
  '(?:i|we)\\s+(?:am|are|was|were)\\s+(?:curious|wondering)\\b',
  '(?:i|we)(?:\\s+would|[\'’]d)\\s+like\\s+to\\s+know\\b',
  '(?:i|we)\\s+(?:need|want)\\s+to\\s+know\\b',
  '(?:i|we)\\s+(?:have|had)\\s+something\\s+to\\s+ask\\b',
  '(?:one\\s+more|another)\\s+question\\s+(?:is|about)\\b',
  'there\\s+(?:is|was)\\s+(?:one\\s+more|another)\\s+question\\b',
  `(?:i|we)\\s+(?:need|want|would\\s+like)\\s+(?:(?:an?|the|some|your)\\s+)?${SECONDARY_MEMORY_DELIVERABLE_SOURCE}\\b`,
  `(?:i|we)\\s+(?:expect|anticipate)\\s+(?:(?:an?|the|some|your)\\s+)?(?:[\\w-]+\\s+){0,2}${SECONDARY_MEMORY_DELIVERABLE_SOURCE}\\b`,
  `(?:i|we)\\s+(?:(?:am|are|was|were)\\s+)?hoping\\s+(?:you\\s+)?(?:(?:can|could|would|will)\\s+)?(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b`,
  `let(?:['’]s|\\s+us)\\s+(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b`,
  `(?:i|we)\\s+should\\s+(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b`,
  `maybe\\s+(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b`,
  `(?:i|we)\\s+(?:have|had)\\s+(?:(?:an?|another|one\\s+more)\\s+)?asks?\\s*:\\s*(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b`,
  `(?:i|we)\\s+(?:need|want)\\s+you\\s+(?:${SECONDARY_MEMORY_ACTION_GERUND_SOURCE})\\b`,
  `(?:i|we)\\s+(?:could|would)\\s+use\\s+(?:(?:an?|the|some|your)\\s+)?${SECONDARY_MEMORY_DELIVERABLE_SOURCE}\\b`,
  `(?:the\\s+)?[\\w'’.-]+(?:\\s+[\\w'’.-]+){0,5}\\s+(?:(?:should|must)\\s+be|needs?(?:\\s+to\\s+be)?)\\s+${SECONDARY_MEMORY_MUTATION_FORM_SOURCE}\\b`,
  `let\\s+${SECONDARY_MEMORY_TOOL_NAME_SOURCE}\\s+(?:run|execute|operate)\\b`,
  `${SECONDARY_MEMORY_TOOL_NAME_SOURCE}\\s+is\\s+the\\s+tool\\s+to\\s+(?:run|call|invoke|use)\\b`,
  `(?:i|we)\\s+need\\s+${SECONDARY_MEMORY_TOOL_NAME_SOURCE}\\s+(?:to\\s+)?(?:run|called|invoked|used)\\b`,
].join('|');
const SECONDARY_MEMORY_REQUEST_SOURCE = [
  '(?:(?:also|and\\s+then|then|plus|so)\\s+)?',
  '(?:(?:while|if|since|once|after|before)\\b[^.!?;]{0,64}[,:]\\s*)?',
  '(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+|(?:i|we)\\s+(?:need|want)\\s+you\\s+to\\s+|our\\s+next\\s+task\\s+is\\s+to\\s+)?',
  `(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE}|${SECONDARY_MEMORY_QUESTION_SOURCE})\\b`,
].join('');
const SECONDARY_MEMORY_SENTENCE_RE = new RegExp(`([.!?;])\\s+(?=${SECONDARY_MEMORY_REQUEST_SOURCE})`, 'i');
const SECONDARY_MEMORY_INDIRECT_SENTENCE_RE = new RegExp(
  `([.!?;])\\s+(?=(?:(?:also|and(?:\\s+then)?|then|plus|so)\\s+)?(?:${SECONDARY_MEMORY_INDIRECT_REQUEST_SOURCE}))`,
  'i',
);
const SECONDARY_MEMORY_TRANSITION_RE = new RegExp(
  `(?:\\s+[—–]\\s+|\\s+-\\s+|,\\s*|\\s+)(?=(?:also|and(?:\\s+then)?|then|plus|so)\\s+(?:(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+)?(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b|(?:${SECONDARY_MEMORY_INDIRECT_REQUEST_SOURCE})))`,
  'i',
);
const SECONDARY_MEMORY_CONDITIONAL_RE = new RegExp(
  `(?:,\\s*|\\s+)(?=(?:while\\s+(?:you\\s+)?(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b|if\\s+you\\s+(?:can|could|would)\\s+(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b|(?:if|since|while|when|once|after|before|provided|assuming)\\b[^.!?;]{0,64}[,:]\\s*(?:(?:please|kindly)\\s+)?(?:${SECONDARY_MEMORY_REQUEST_VERB_SOURCE})\\b))`,
  'i',
);

function explicitRememberCommandStart(text: string): number | null {
  const match = EXPLICIT_REMEMBER_COMMAND_RE.exec(text);
  if (!match?.[1] || match.index === undefined) return null;
  return match.index + match[0].lastIndexOf(match[1]);
}

function stripTerminalMemoryFraming(text: string): string {
  const framing: Array<{ pattern: RegExp; retainFirst?: boolean }> = [
    { pattern: /\s+(?:then\s+)?(?:just\s+)?confirm(?:\s+only)?\s+(?:(?:you(?:'ve| have)\s+)?(?:noted|saved|remembered)\s+it|after\s+it\s+is\s+(?:noted|saved|stored|remembered))(?:\s*[—,:;-]\s*nothing\s+else)?[.!?]*$/i },
    // Durability/next-conversation wording describes the requested storage
    // contract, not the claim itself. The source episode keeps the full turn.
    { pattern: /\s+this\s+is\s+(?:a\s+)?durable\s+(?:fact|memory)\s+that\s+(?:must|should|needs?\s+to)\s+be\s+available\s+in\s+(?:a|the)\s+new\s+(?:conversation|session)[.!?]*$/i },
    // A standalone final sentence is framing; "I need to confirm" is not.
    { pattern: /(?<=[.!?])\s+(?:just\s+)?confirm[.!?]*$/i },
    { pattern: /([.!?]["'`]?)\s+(?:please\s+)?(?:briefly\s+|just\s+)?acknowledge(?:\s+(?:it|this))?[.!?]*$/i, retainFirst: true },
    { pattern: /(?<=[.!?])\s+(?:a|an)\s+(?:(?:natural|brief|short|simple)\s+)?(?:acknowledg(?:e)?ment|confirmation|reply)\s+(?:is|will\s+be)\s+(?:enough|sufficient)[.!?]*$/i },
  ];
  let result = text;
  for (const { pattern, retainFirst } of framing) {
    const match = pattern.exec(result);
    if (!match) continue;
    const boundary = match.index + (retainFirst ? match[1]!.length : 0);
    if (!memoryLiteralMask(result)[boundary]) result = result.slice(0, boundary);
  }
  return result.trim();
}

interface MemoryClauseIsolation {
  sourceSpan?: MemoryDestinationSpan;
  memoryContent: string;
  hasSecondaryWork: boolean;
}

/** Literal spans cannot grant a clause boundary. An unmatched delimiter keeps
 * the rest protected; apostrophes inside words are not quotation delimiters. */
function memoryLiteralMask(text: string): boolean[] {
  const mask = Array<boolean>(text.length).fill(false);
  const word = (value: string | undefined) => Boolean(value && /[\p{L}\p{N}_]/u.test(value));
  let closing = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      if (closing) { mask[i] = true; if (i + 1 < text.length) mask[++i] = true; continue; }
      // An escaped quote outside a known literal is ambiguous, not permission
      // to split later command-looking words out of its content.
      if (/["'`“‘]/.test(text[i + 1] ?? '')) { mask.fill(true, i); break; }
    }
    if ((ch === "'" || ch === '’') && word(text[i - 1]) && word(text[i + 1])) {
      mask[i] = Boolean(closing); continue;
    }
    if (closing) {
      mask[i] = true;
      if (text.startsWith(closing, i)) {
        for (let n = 1; n < closing.length; n++) mask[i + n] = true;
        i += closing.length - 1; closing = '';
      }
      continue;
    }
    if ((ch === "'" || ch === '’') && word(text[i - 1])) continue;
    if (ch === '`') {
      closing = /^`+/.exec(text.slice(i))![0];
      for (let n = 0; n < closing.length; n++) mask[i + n] = true;
      i += closing.length - 1;
    } else if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      closing = ch === '“' ? '”' : ch === '‘' ? '’' : ch; mask[i] = true;
    }
  }
  return mask;
}

function memoryClauses(text: string): Array<{ start: number; text: string; unquoted: string }> {
  const mask = memoryLiteralMask(text);
  const clauses: Array<{ start: number; text: string; unquoted: string }> = [];
  let start = 0;
  const append = (end: number) => {
    const raw = text.slice(start, end);
    const unquoted = raw.split('').map((ch, n) => mask[start + n] ? ' ' : ch).join('');
    clauses.push({ start, text: raw.trim(), unquoted: unquoted.trim() }); start = end;
  };
  for (const match of text.matchAll(/[.!?;](?:["'`”’]+)?\s+/g)) {
    const end = match.index! + match[0].length;
    if (!mask[end - 1]) append(end);
  }
  if (start < text.length) append(text.length);
  return clauses;
}

const MEMORY_ACKNOWLEDGEMENT_CLAUSE_RE = /^(?:please\s+)?(?:(?:briefly|just)\s+)?confirm(?:\s+only)?\s+(?:what\s+you\s+(?:saved|stored|remembered|noted)|(?:that\s+)?you(?:'ve|\s+have)\s+(?:saved|stored|remembered|noted)\s+(?:it|this|that))[.!?;]*$/i;
const MEMORY_NEGATED_ACTION_CLAUSE_RE = /^(?:(?:for|in|during)\s+this\s+(?:task|request|run|turn)\s*,?\s*)?(?:please\s+)?(?:do\s+not|don'?t)\s+(?:create|change|delete|edit|send|write|save|store|modify|update|publish|post|contact|use)\b[^.!?]*[.!?;]?$/i;
// A complete acknowledgement may own generic no-work response restrictions,
// never an arbitrary prohibition with a named object, recipient or condition.
const MEMORY_GENERIC_RESOURCE_SOURCE = '(?:(?:any|new|existing|external|local)\\s+)*(?:files|documents|projects?|settings|messages|emails)';
const MEMORY_GENERIC_ACTION_SOURCE = `(?:create|change|delete|edit|send|write|modify|update)\\s+${MEMORY_GENERIC_RESOURCE_SOURCE}`;
const MEMORY_GENERIC_RESPONSE_RESTRICTION_RE = new RegExp(`^(?:please\\s+)?(?:do\\s+not|don'?t)\\s+${MEMORY_GENERIC_ACTION_SOURCE}(?:\\s*(?:,\\s*(?:(?:or|and)\\s+)?|(?:or|and)\\s+)(?:${MEMORY_GENERIC_ACTION_SOURCE}|${MEMORY_GENERIC_RESOURCE_SOURCE}))*[.!?;]?$`, 'i');

/** Only remove a contiguous task-only suffix, never splice neighboring claims
 * together. Bare "Confirm both" and substantive procedures remain untouched. */
function boundedMemoryTaskTail(text: string): number | null {
  const clauses = memoryClauses(text);
  const acknowledgement = (clause: typeof clauses[number]) => clause.text === clause.unquoted
    && MEMORY_ACKNOWLEDGEMENT_CLAUSE_RE.test(clause.text);
  const negative = (clause: typeof clauses[number]) => clause.text === clause.unquoted
    && MEMORY_NEGATED_ACTION_CLAUSE_RE.test(clause.unquoted)
    && !PERSISTENT_SCOPE_RE.test(clause.unquoted)
    && !/\b(?:is|are|was|were|has|have|means|equals)\b/i.test(clause.unquoted);
  for (let i = 1; i < clauses.length; i++) {
    const first = clauses[i]!;
    const ack = acknowledgement(first);
    if (!ack && !(negative(first) && EXPLICIT_EPHEMERAL_SCOPE_RE.test(first.unquoted))) continue;
    // A complete confirmation request owns only a generic no-work response
    // restriction. Named targets/conditions and later facts remain ambiguous.
    if (clauses.slice(i).every(clause => acknowledgement(clause)
      || (negative(clause) && (EXPLICIT_EPHEMERAL_SCOPE_RE.test(clause.unquoted)
        || (ack && MEMORY_GENERIC_RESPONSE_RESTRICTION_RE.test(clause.text)))))) return first.start;
  }
  return null;
}

function isolateMemoryFromSecondaryWork(text: string): MemoryClauseIsolation {
  const mask = memoryLiteralMask(text);
  const matches = [
    SECONDARY_MEMORY_SENTENCE_RE,
    SECONDARY_MEMORY_INDIRECT_SENTENCE_RE,
    SECONDARY_MEMORY_TRANSITION_RE,
    SECONDARY_MEMORY_CONDITIONAL_RE,
  ].map(pattern => [...text.matchAll(new RegExp(pattern.source, 'gi'))]
    .find(match => !mask[match.index!]))
    .filter((match): match is RegExpExecArray => Boolean(match?.index !== undefined));
  const taskTail = boundedMemoryTaskTail(text);
  const boundaries = [
    ...matches.map(match => (match.index ?? 0) + (match[1]?.length ?? 0)),
    ...(taskTail === null ? [] : [taskTail]),
  ];
  if (boundaries.length === 0) {
    return { memoryContent: text.trim(), hasSecondaryWork: false };
  }
  const isolated = text.slice(0, Math.min(...boundaries)).trim();
  return {
    memoryContent: isolated || text.trim(),
    hasSecondaryWork: Boolean(isolated),
  };
}

function parseRememberInstruction(text: string): MemoryClauseIsolation | null {
  const commandStart = explicitRememberCommandStart(text);
  if (commandStart === null) return null;
  const command = text.slice(commandStart);
  const leader = EXPLICIT_REMEMBER_LEADERS.find((candidate) => candidate.test(command));
  // Bare "remember to ..." intentionally keeps its command wording; every
  // other recognized memory command is cleaned to the user-authored claim.
  const content = leader ? command.replace(leader, '') : command;

  const isolated = isolateMemoryFromSecondaryWork(stripTerminalMemoryFraming(content));
  const claimStart = commandStart + (leader ? command.match(leader)![0].length : 0)
    + (content.length - content.trimStart().length);
  return {
    sourceSpan: { start: claimStart, end: claimStart + isolated.memoryContent.length },
    memoryContent: isolated.memoryContent || text,
    hasSecondaryWork: commandStart > 0 || isolated.hasSecondaryWork,
  };
}

/** Whether privacy/scope language cancels an otherwise explicit memory clause.
 * The isolated memory content is authoritative for same-content scope. A
 * preceding, specifically task-scoped opt-out may coexist with a later memory
 * command; every broader or ambiguous opt-out remains fail-closed. */
function explicitMemoryInstructionIsSuppressed(
  text: string,
  instruction: ExplicitMemoryInstructionParse,
): boolean {
  if (
    MEMORY_CAPTURE_OPTOUT_RE.test(instruction.memoryContent)
    || EXPLICIT_EPHEMERAL_SCOPE_RE.test(instruction.memoryContent)
  ) return true;

  if (!MEMORY_CAPTURE_OPTOUT_RE.test(text)) return false;
  const commandStart = explicitRememberCommandStart(text);
  if (commandStart === null) return true;
  const beforeCommand = text.slice(0, commandStart);
  return !TASK_SCOPED_MEMORY_OPTOUT_RE.test(beforeCommand);
}

/** A narrowed graph clause cannot discard the owner's broader privacy
 * boundary. Reuse the complete-turn policy, including its existing named
 * task-only exception, rather than reinterpreting opt-out wording here. */
function automaticOwnerPrivacyRefused(ownerText: string): boolean {
  const text = clean(ownerText, Infinity);
  if (!MEMORY_CAPTURE_OPTOUT_RE.test(text)) return false;
  const parsed = parseExplicitMemoryInstruction(text);
  return !parsed || explicitMemoryInstructionIsSuppressed(text, parsed);
}

// A user can explicitly revise durable knowledge without repeating the word
// "remember". Keep this deliberately narrower than the general correction
// detector: future-reference language grants durable intent, while the
// remainder still has to be a factual claim rather than an instruction to
// rewrite the current reply/artifact. The complete text is retained because
// conflict resolution needs both the correction cue and any quoted stale value.
// Unrelated live work is isolated later; the exact full turn remains the source
// episode, while only the correction claim is eligible for promotion.
const FUTURE_REFERENCE_CORRECTION_LEADER_RE = /^\s*(?:(?:small\s+)?correction\s+(?:for\s+later|for\s+future\s+reference)|(?:for\s+later|for\s+future\s+reference)\s*[,:—–-]?\s*(?:small\s+)?correction)\s*[,:—–-]\s*/i;
const CORRECTION_FACT_RELATION_RE = /\b(?:is|are|was|were|has|have|uses?|prefers?|works?|reports?|lives?|equals?|means?|belongs?|closes?|starts?|ends?|moved?)\b/i;
const CORRECTION_IMPERATIVE_RE = /^\s*(?:please\s+)?(?:add|change|create|delete|edit|format|make|move|remove|rename|rewrite|send|shorten|update|use|write)\b/i;

function isExplicitDurableCorrectionRequest(text: string): boolean {
  const savedClaim = savedMemoryCorrectionClaim(text);
  if (savedClaim && savedClaim.length >= 12 && /^from now on\b/i.test(savedClaim)) return true;
  const leader = FUTURE_REFERENCE_CORRECTION_LEADER_RE.exec(text);
  if (!leader && savedClaim === null) return false;
  const claim = savedClaim ?? text.slice(leader![0].length).trim();
  return claim.length >= 12
    && !CORRECTION_IMPERATIVE_RE.test(claim)
    && CORRECTION_FACT_RELATION_RE.test(claim);
}

export type ExplicitMemoryInstructionKind = 'remember' | 'future_reference_correction';

export interface ExplicitMemoryInstructionParse {
  kind: ExplicitMemoryInstructionKind;
  memoryContent: string;
  hasSecondaryWork: boolean;
}

/** Parse the durable-memory portion of a compound user turn without changing
 * the source turn itself. The returned `memoryContent` is safe to enqueue as a
 * candidate; callers must keep the original message for transcript, provider,
 * and episode evidence. This module-level seam lets every brain share the same
 * memory/action boundary without importing runtime code into memory. */
export function parseExplicitMemoryInstruction(message: string): ExplicitMemoryInstructionParse | null {
  const text = clean(message, Infinity);
  if (!text) return null;
  if (isExplicitDurableCorrectionRequest(text)) {
    const isolated = isolateMemoryFromSecondaryWork(stripTerminalMemoryFraming(text));
    const parsed: ExplicitMemoryInstructionParse = {
      kind: 'future_reference_correction',
      memoryContent: isolated.memoryContent || text,
      hasSecondaryWork: isolated.hasSecondaryWork,
    };
    instructionSourceSpans.set(parsed, { start: 0, end: parsed.memoryContent.length });
    return parsed;
  }
  const remembered = parseRememberInstruction(text);
  if (!remembered) return null;
  const parsed: ExplicitMemoryInstructionParse = {
    kind: 'remember',
    memoryContent: remembered.memoryContent,
    hasSecondaryWork: remembered.hasSecondaryWork,
  };
  if (remembered.sourceSpan) instructionSourceSpans.set(parsed, remembered.sourceSpan);
  return parsed;
}

/** The one gate every caller shares for "is this message an explicit memory
 * instruction": the parse, minus a same-turn opt-out. Detection only — the
 * caller decides what to do with the message, and never reads its subject. */
export function explicitMemoryInstructionFor(message: string): ExplicitMemoryInstructionParse | null {
  const text = clean(message, Infinity);
  if (!text) return null;
  const parsed = parseExplicitMemoryInstruction(text);
  return parsed && !explicitMemoryInstructionIsSuppressed(text, parsed) ? parsed : null;
}

/** Automatic intake cannot turn a referential storage directive into a claim.
 * Reuse the ordinary clause boundary as well as the unstripped command so a
 * separate task after it does not make the reference self-contained. */
export function unresolvedAutomaticMemoryReference(message: string): boolean {
  const text = clean(message, Infinity);
  const instruction = parseExplicitMemoryInstruction(text);
  const commandStart = explicitRememberCommandStart(text);
  const isolatedCommand = commandStart === null ? '' : isolateMemoryFromSecondaryWork(
    stripTerminalMemoryFraming(text.slice(commandStart)),
  ).memoryContent;
  return instruction?.kind === 'remember'
    && (hasUnresolvedExplicitMemoryReference(text)
      || hasUnresolvedExplicitMemoryReference(isolatedCommand)
      || isUnresolvedMemoryReferencePayload(instruction.memoryContent));
}

function explicitRememberKind(content: string): ConsolidatedFactKind {
  // A literal project/tooling context should not be mislabeled as a personal
  // preference merely because the user used the word "remember".
  return PROJECT_TERMS.test(content) ? 'project' : 'user';
}

/** Explicit memory authority belongs to the isolated claim and its command
 * wrapper. Separate current work cannot contribute a pin or sender constraint.
 * A genuine preceding rule is retained as its contiguous owner source span. */
function explicitMemoryAuthority(text: string, instruction: ExplicitMemoryInstructionParse): {
  content: string; prohibition: boolean; constraint: boolean; ambiguous: boolean;
} {
  const start = instruction.kind === 'remember' ? explicitRememberCommandStart(text) : null;
  const command = start === null ? '' : text.slice(start);
  const leader = EXPLICIT_REMEMBER_LEADERS.map(pattern => pattern.exec(command)?.[0]).find(Boolean) ?? '';
  // Only an entire command-level prefix supplies durability. A preceding task
  // mentioning future reference cannot lend that authority to the claim.
  const durablePrefix = start === null ? '' : text.slice(0, start)
    .match(/^\s*(?:for future reference|going forward|from now on)\s*,\s*$/i)?.[0] ?? '';
  const claimAuthority = `${durablePrefix}${PERSISTENT_SCOPE_RE.test(leader) ? leader : ''}${instruction.memoryContent}`;
  const prefix = start === null ? [] : memoryClauses(text.slice(0, start));
  const rules = prefix.filter(clause => !EXPLICIT_EPHEMERAL_SCOPE_RE.test(clause.unquoted)
    && !TASK_SCOPED_MEMORY_OPTOUT_RE.test(clause.unquoted)
    && (isSafetyProhibition(clause.text) || isEnforceableSenderConstraint(clause.text)));
  const nonRules = prefix.filter(clause => clause.text && !/^(?:and|also|then)[,:]?$/i.test(clause.text) && !rules.includes(clause));
  const claimStart = instructionSourceSpans.get(instruction)?.start ?? -1;
  const ambiguous = rules.length > 0 && (nonRules.length > 0 || claimStart < 0);
  return {
    content: rules.length > 0 && !ambiguous ? text.slice(0, claimStart + instruction.memoryContent.length).trim() : instruction.memoryContent,
    prohibition: isSafetyProhibition(claimAuthority) || rules.some(clause => isSafetyProhibition(clause.text)),
    constraint: isEnforceableSenderConstraint(claimAuthority) || rules.some(clause => isEnforceableSenderConstraint(clause.text)),
    ambiguous,
  };
}

function addCandidate(candidates: AutoMemoryCandidate[], candidate: AutoMemoryCandidate): void {
  // Storage is not a prompt preview. Preserve every condition in an explicit
  // user instruction or pinned rule; retrieval owns its presentation budget.
  const lossless = candidate.reason === 'explicit remember request'
    || candidate.reason === 'explicit durable correction' || candidate.pin === true;
  const content = clean(candidate.content, lossless ? Infinity : 260);
  // Explicit store requests are user-authored memory intent, not a heuristic:
  // accept the same minimum as memory_remember so short labels/codewords are not
  // silently lost after removing the old long wrapper. Keep the higher floor for
  // inferred candidates to avoid filling durable memory with low-signal scraps.
  const minChars = candidate.reason === 'explicit remember request' ? 3 : 12;
  if (!content || content.length < minChars) return;
  const key = `${candidate.kind}:${content.toLowerCase()}`;
  if (candidates.some((entry) => `${entry.kind}:${entry.content.toLowerCase()}` === key)) return;
  candidates.push({ ...candidate, content });
}

function extractPreferredName(message: string): string | undefined {
  const match = message.match(/\b(?:call me|you can call me|my name is)\s+([A-Za-z][A-Za-z0-9 ._-]{1,50})/i);
  if (!match) return undefined;
  return clean(match[1].split(/[.!?,;\n]/)[0] ?? '', 80);
}

export function extractProfilePatchFromMessage(message: string): Record<string, unknown> | undefined {
  // Profile adaptation is a durable write independent of fact extraction. It
  // must honor the same privacy boundary instead of leaking a name/tone through
  // this side channel after candidate capture correctly returned nothing.
  if (MEMORY_CAPTURE_OPTOUT_RE.test(message) || EXPLICIT_EPHEMERAL_SCOPE_RE.test(message)) {
    return undefined;
  }
  const patch: Record<string, unknown> = {};
  const preferredName = extractPreferredName(message);
  if (preferredName) patch.preferredName = preferredName;

  if (/\b(skip the recap|keep (?:it )?(?:short|concise)|be concise|terse|less detail|don'?t overexplain|do not overexplain|no preamble)\b/i.test(message)) {
    patch.communicationTone = 'terse';
  } else if (/\b(be thorough|go deep|walk me through|explain in detail|more detail|give me the full context)\b/i.test(message)) {
    patch.communicationTone = 'verbose';
  }

  if (/\b(casual tone|be casual|less formal)\b/i.test(message)) {
    patch.formality = 'casual';
  } else if (/\b(formal tone|be formal)\b/i.test(message)) {
    patch.formality = 'formal';
  } else if (/\b(professional tone|keep it professional)\b/i.test(message)) {
    patch.formality = 'professional';
  }

  if (/\b(notify sparingly|don'?t ping me|do not ping me|fewer check-?ins|less noisy|too noisy)\b/i.test(message)) {
    patch.urgencyTolerance = 'low';
  } else if (/\b(keep me updated|frequent updates|proactive check-?ins|check in often|tell me as you go)\b/i.test(message)) {
    patch.urgencyTolerance = 'high';
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Producing no candidates has two very different meanings, and only one of them
 * may ever be overridden.
 *
 * A REFUSAL is an instruction: the owner said "do not save this as memory", the
 * text is a harness re-prompt rather than the owner's words at all, or it is a
 * smoke-test probe describing this turn. Every path must honor that.
 *
 * A NON-MATCH is only silence — the phrasing patterns did not recognize the
 * sentence. That carries no instruction, and it is what the model reviewer
 * exists to judge again.
 *
 * Before these were separated, both produced a bare `[]`, so the only way to
 * re-judge unfamiliar phrasing would also have resurrected memories the owner
 * explicitly declined. That is why this predicate exists rather than a second
 * copy of the conditions.
 */
export function durableCaptureRefused(message: string): boolean {
  const text = clean(message, Infinity);
  if (!text) return false;
  if (autoCaptureHarnessSkipEnabled() && isHarnessInjectedInput(text)) return true;
  // A request to remember "that correction" is still a memory request, but
  // its object is not a fact. Refuse both direct capture and the unmatched
  // owner fallback; the brain keeps the full input to resolve through tools.
  if (unresolvedAutomaticMemoryReference(text)) return true;
  // An isolated "remember X" clause is explicit durable authority and overrides
  // the whole-turn task/probe scopes below — but never the harness check above,
  // which is about whether these are the owner's words in the first place.
  const explicitInstruction = explicitMemoryInstructionFor(text);
  if (explicitInstruction) return explicitMemoryAuthority(text, explicitInstruction).ambiguous;
  // One-off validation/probe prompts often contain durable-looking words such as
  // "instead of" or "must", but they describe this smoke turn, not user memory.
  // An explicit current-task scope likewise belongs in working memory, even when
  // the sentence also contains durable-looking markers such as "always".
  return isOneOffValidationOrToolProbe(text) || EXPLICIT_EPHEMERAL_SCOPE_RE.test(text);
}

function extractNormalizedAutoMemoryCandidates(message: string, maxCandidates = 3): AutoMemoryCandidate[] {
  const text = clean(message, Infinity);
  if (!text || LOW_SIGNAL.test(text)) return [];
  // Don't fold a pasted workflow definition into facts (it pollutes the store
  // and duplicates the workflow store).
  if (autocapSkipWorkflowTextEnabled() && looksLikeWorkflowDefinitionDump(text)) return [];
  // Harness-injected re-prompts (judge/stall/parse/grounding/YOLO/outcome) are
  // recorded as user_input_received but must NEVER become durable "user" facts —
  // they were being pinned as "Standing prohibition" and injected into every
  // chat + voice prompt (2026-06-23 fact pollution).
  if (durableCaptureRefused(text)) return [];
  // Parse explicit durable authority before applying whole-turn task/probe
  // heuristics. The parser isolates a separate "remember X" clause, while the
  // suppression check keeps same-content and turn-wide privacy language
  // authoritative.
  const explicitMemoryInstruction = explicitMemoryInstructionFor(text);
  const explicitAuthority = explicitMemoryInstruction ? explicitMemoryAuthority(text, explicitMemoryInstruction) : null;

  const candidates: AutoMemoryCandidate[] = [];
  const prohibition = explicitAuthority?.prohibition ?? isSafetyProhibition(text);
  const taskRequest = looksLikeOneOffTaskRequest(text);
  const persistentScope = PERSISTENT_SCOPE_RE.test(text);
  const explicitPreference = EXPLICIT_PREFERENCE_CUES.test(text);
  const explicitRemember = explicitMemoryInstruction?.kind === 'remember';
  const explicitDurableCorrection = explicitMemoryInstruction?.kind === 'future_reference_correction';

  // Enforceable sender/account routing rule → kind:'constraint' so the dispatch
  // gate (constraint-guard via listConstraints) actually ENFORCES it, closing the
  // round-trip a kind:'user'/'feedback' fact could never reach. Emitted FIRST; the
  // feedback branch below is gated on this so the same rule isn't also stored as a
  // plain (un-enforced) preference.
  if (explicitAuthority?.constraint ?? isEnforceableSenderConstraint(text)) {
    addCandidate(candidates, {
      kind: 'constraint',
      content: `Standing rule (enforced): ${explicitAuthority?.content ?? text}`,
      reason: 'enforceable sender/account routing rule',
      pin: true,
    });
  }
  const capturedConstraint = candidates.some((c) => c.kind === 'constraint');

  // "Correction for later" is the same durable authority as "remember this",
  // but preserving the complete CORRECTION is essential: the consolidation
  // layer uses its cue and quoted old value to retire exactly one stale fact
  // without a model conflict-resolution call. A following live request is not
  // part of that fact; only the source episode keeps the complete user turn.
  if (explicitDurableCorrection && explicitMemoryInstruction && !capturedConstraint) {
    const content = explicitAuthority?.content ?? explicitMemoryInstruction.memoryContent;
    addCandidate(candidates, {
      kind: explicitRememberKind(content),
      content,
      reason: 'explicit durable correction',
    });
    return candidates.slice(0, maxCandidates);
  }

  // An explicit store request is already the user's durable-memory decision.
  // Canonicalize it before the broader project/feedback heuristics see words
  // such as "project", "must", or "durable" in the surrounding command. Those
  // heuristics previously stored a second, truncated "Clementine requirement:
  // Remember this..." wrapper before memory_remember wrote the clean claim.
  if (explicitRemember && explicitMemoryInstruction && !capturedConstraint) {
    const content = explicitAuthority?.content ?? explicitMemoryInstruction.memoryContent;
    if (prohibition) {
      addCandidate(candidates, {
        kind: 'feedback',
        content: `Standing prohibition: ${content}`,
        reason: 'safety-critical prohibition (auto-pinned)',
        pin: true,
      });
    } else {
      addCandidate(candidates, {
        kind: explicitRememberKind(content),
        content,
        reason: 'explicit remember request',
      });
    }
    return candidates.slice(0, maxCandidates);
  }
  if (capturedConstraint && explicitRemember) return candidates.slice(0, maxCandidates);

  if (
    FEEDBACK_CUES.test(text)
    && !capturedConstraint
    && (!taskRequest || persistentScope || explicitPreference)
  ) {
    const kind: ConsolidatedFactKind = PROJECT_TERMS.test(text) ? 'feedback' : 'user';
    addCandidate(candidates, {
      kind,
      content: kind === 'feedback' ? `Standing product feedback: ${text}` : `User preference: ${text}`,
      reason: 'explicit user preference or feedback',
      // A "never/do-not <action>" rule (e.g. "never email the test list") is
      // safety-critical — pin it so scoped recall can't drop it at action time.
      pin: prohibition,
    });
  }

  if (
    PROJECT_TERMS.test(text)
    && PROJECT_REQUIREMENT_CUES.test(text)
    && !isOneOffValidationOrToolProbe(text)
    && (!taskRequest || CLEMENTINE_VISION_RE.test(text))
  ) {
    addCandidate(candidates, {
      kind: 'project',
      content: `Clementine requirement: ${text}`,
      reason: 'project requirement signal',
    });
  }

  if (
    CONNECTED_APP_TERMS.test(text)
    && CONNECTED_APP_CUES.test(text)
    && !isOneOffConnectedAppLookup(text)
    && (!taskRequest || persistentScope)
  ) {
    addCandidate(candidates, {
      kind: 'reference',
      content: `Connected-app context: ${text}`,
      reason: 'connected app access or setup signal',
    });
  }

  // Safety-critical prohibition the cued branches above didn't catch
  // (e.g. "do not send to the prod list" — no feedback/project/app cue). Capture
  // it as a PINNED standing rule so it's always injected. Gated len===0 so it
  // never duplicates a prohibition the feedback branch already pinned.
  if (candidates.length === 0 && prohibition) {
    addCandidate(candidates, {
      kind: 'feedback',
      content: `Standing prohibition: ${text}`,
      reason: 'safety-critical prohibition (auto-pinned)',
      pin: true,
    });
  }

  // Explicit store request. The shared parser recognizes command-shaped
  // clauses (including action-first compound turns) while questions and
  // incidental mentions of "remember" grant no durable-write authority.
  if (candidates.length === 0 && explicitRemember && explicitMemoryInstruction) {
    const content = explicitMemoryInstruction.memoryContent;
    addCandidate(candidates, {
      kind: explicitRememberKind(content),
      content,
      reason: 'explicit remember request',
    });
  }

  // Declarative-fact fallback (broaden beyond the four keyword gates).
  // If nothing matched but the message is a substantial first-person /
  // possessive declarative ("My CFO is Dana", "We bank with First
  // Republic", "The Henderson contract closes March 3"), capture it.
  // This is ADDITIVE — it only fires when the cued paths found nothing,
  // so it never reduces what's captured today. Questions and commands
  // are excluded so we don't store "what's my balance?" as a fact.
  if (
    candidates.length === 0
    && !taskRequest
    && !isOneOffConnectedAppLookup(text)
    && !HISTORICAL_NEVER_RE.test(text)
    && isDurableDeclarative(text)
  ) {
    addCandidate(candidates, {
      kind: 'user',
      content: text,
      reason: 'durable first-person declarative',
    });
  }

  // Standing-rule fallback (gap-only). A durable "going forward / every Monday /
  // by default, send X to Y" instruction with a concrete target. Gated on
  // candidates.length === 0 (like the declarative fallback above) so it NEVER
  // alters what the cued/declarative branches already capture — it only fills
  // the gap those markers miss. Captured as a 'feedback' fact (a standing
  // instruction to Clem), so it persists + cross-session-injects + dedups via
  // the same consolidateFact path as every other candidate. The session-scoped
  // Active Task pin still covers the current turn when the rule is actionable now.
  if (
    candidates.length === 0
    && STANDING_MARKER_RE.test(text)
    && STANDING_VERB_RE.test(text)
    && hasConcreteStandingTarget(text)
    && !HISTORICAL_NEVER_RE.test(text)
  ) {
    addCandidate(candidates, {
      kind: 'feedback',
      content: `Standing instruction: ${text}`,
      reason: 'standing instruction (marker + concrete target)',
      // Pin when it names a connected app: a routing rule like "by default route
      // outreach through my marketing list" must survive objective-scoped recall
      // so it's injected at action time, not evicted as an off-topic fact.
      pin: CONNECTED_APP_TERMS.test(text),
    });
  }

  return candidates.slice(0, maxCandidates);
}

/** Retain the original extraction interval before wrappers, normalization or
 * candidate previews can discard it. Repeated literal text is never searched. */
export function extractAutoMemoryCandidates(message: string, maxCandidates = 3): AutoMemoryCandidate[] {
  const text = clean(message, Infinity);
  // Split only separate, unquoted, command-shaped memory clauses. Each match
  // supplies its original interval; identical claims in different commands
  // keep separate identities. Semantic splitting stays with the reviewer.
  const instruction = explicitMemoryInstructionFor(text);
  const clauses = instruction?.kind === 'remember' ? memoryClauses(text) : [];
  const commands = clauses.filter(clause => {
    const command = explicitRememberCommandStart(clause.text);
    return command !== null && !memoryLiteralMask(clause.text)[command]
      && explicitMemoryInstructionFor(clause.text)?.kind === 'remember';
  });
  const cuts = !durableCaptureRefused(text) && commands.length > 1
    ? [0, ...commands.slice(1).map(clause => clause.start), text.length] : [0, text.length];
  const candidates: AutoMemoryCandidate[] = [];
  for (let n = 0; n < cuts.length - 1; n++) {
    const rawBlock = text.slice(cuts[n]!, cuts[n + 1]!);
    const blockStart = cuts[n]! + rawBlock.length - rawBlock.trimStart().length;
    const block = rawBlock.trim();
    const selected = extractNormalizedAutoMemoryCandidates(block, maxCandidates);
    const parsed = explicitMemoryInstructionFor(block);
    const authority = parsed ? explicitMemoryAuthority(block, parsed) : null;
    const span = parsed ? instructionSourceSpans.get(parsed) : undefined;
    const blockSpan = span && authority
      ? { start: authority.content === parsed!.memoryContent ? span.start : 0, end: span.end }
      : { start: 0, end: block.length };
    const rawSpan = rawNormalizedSpan(message, text,
      { start: blockStart + blockSpan.start, end: blockStart + blockSpan.end });
    if (rawSpan) for (const candidate of selected) candidateSourceSpans.set(candidate, { source: message, span: rawSpan });
    candidates.push(...selected);
  }
  return candidates.slice(0, maxCandidates);
}

export type AutoMemoryAdmissionScope = 'ephemeral' | 'durable' | 'standing_policy';

export interface AutoMemoryAdmissionDecision {
  scope: AutoMemoryAdmissionScope;
  reasons: string[];
}

/**
 * Read-only explanation of the deterministic admission decision. This is the
 * observability seam for evals/UI: callers can inspect whether a turn stayed
 * ephemeral without writing a candidate or invoking a model.
 */
export function assessAutoMemoryAdmission(message: string): AutoMemoryAdmissionDecision {
  const candidates = extractAutoMemoryCandidates(message);
  if (candidates.length === 0) {
    return { scope: 'ephemeral', reasons: ['no durable-memory admission rule matched'] };
  }
  const standing = candidates.some((candidate) => candidate.pin || candidate.kind === 'constraint');
  return {
    scope: standing ? 'standing_policy' : 'durable',
    reasons: [...new Set(candidates.map((candidate) => candidate.reason))],
  };
}

/**
 * Conservative test for "this looks like a durable fact worth keeping"
 * without relying on the four keyword gates. Intentionally strict to
 * avoid storing chit-chat: needs first-person/possessive subject, a
 * stative verb, real length, and must not be a question or an
 * imperative task ("send the email").
 */
function isDurableDeclarative(text: string): boolean {
  if (text.length < 20 || text.length > 400) return false;
  if (/[?]\s*$/.test(text)) return false; // questions aren't facts
  // Punctuation is not a reliable question detector for chat/voice input. In
  // production, requests such as "can I have the body of the emails" and
  // "can you fix the view here I am not seeing the data" were stored because
  // the embedded "I have" / "I am" matched the declarative regex below. A
  // leading interrogative or request auxiliary keeps those turns ephemeral.
  if (/^\s*(?:can|could|would|will|should|do|did|does|what|when|where|who|why|how|is|are|am|have|has)\b/i.test(text)) return false;
  // First-person / possessive / "the X is/are" declaratives with a
  // stative verb. e.g. "my … is", "we use …", "I work at …", "our … are".
  const declarative =
    /\b(?:my|our)\b[\s\w'-]{1,40}\b(?:is|are|was|were|uses?|prefers?|lives?|works?|has|have|owns?|runs?|manages?|reports?)\b/i.test(text)
    || /\b(?:i|we)\b\s+(?:am|are|was|were|use|prefer|live|work|have|own|run|manage|report|always|never|usually|typically)\b/i.test(text)
    || /^\s*the\b[\s\w'-]{1,50}\b(?:is|are|was|were|closes?|starts?|ends?|happens?|moved?)\b/i.test(text);
  if (!declarative) return false;
  // Exclude obvious imperative tasks ("send …", "create …", "schedule …").
  if (/^\s*(?:send|create|update|delete|schedule|draft|write|make|post|add|remove|fix|build|run|call|email|book)\b/i.test(text)) return false;
  return true;
}

/** Shortest owner message that could carry a durable fact, and the longest one
 *  worth paying a reviewer call for. Both are structural: they ask how much
 *  text there is, never what it says. Every judgment about MEANING belongs to
 *  the reviewer, which is the whole point of this path. */
const MIN_REVIEWABLE_OWNER_CHARS = 12;
const MAX_REVIEWABLE_OWNER_CHARS = 2000;

/**
 * The unmatched-message fallback. Deliberately carries no `pin` and the neutral
 * `user` kind: this candidate asserts nothing about the message except that a
 * model should look at it. If the reviewer says `task`, the drain rejects it and
 * the outcome is identical to the drop that happens today.
 */
function unjudgedOwnerStatement(message: string): AutoMemoryCandidate[] {
  const text = message.trim();
  // An explicit decline outranks the reviewer. Re-judging is for phrasing the
  // patterns did not recognize, never for something the owner refused.
  if (durableCaptureRefused(text)) return [];
  if (text.length < MIN_REVIEWABLE_OWNER_CHARS) return [];
  if (text.length > MAX_REVIEWABLE_OWNER_CHARS) return [];
  return [{ kind: 'user', content: text, reason: UNJUDGED_OWNER_STATEMENT_REASON }];
}

/** Deterministic producer selection, also replayed by exact-source receipt
 * verification. It carries no completed-save authority. */
export function selectAutoMemoryCandidates(message: string, maxCandidates = 3): AutoMemoryCandidate[] {
  if ((autoCaptureHarnessSkipEnabled() && isHarnessInjectedInput(message)) || isSelfContainedComputation(message)) return [];
  const matched = extractAutoMemoryCandidates(message, maxCandidates);
  if (matched.length > 0) {
    // Several heuristics may label the same entire claim. Keep the producer's
    // first classification (constraints already have priority), not competing
    // rows for one immutable claim. Distinct source intervals never collapse.
    const spans = new Set<string>();
    return matched.filter(candidate => {
      const span = candidateSourceSpans.get(candidate)?.span;
      const key = span ? `${span.start}:${span.end}` : `${candidate.kind}:${candidate.content}`;
      if (spans.has(key)) return false;
      spans.add(key); return true;
    });
  }
  const candidates = unjudgedOwnerStatement(message);
  const start = message.length - message.trimStart().length;
  for (const candidate of candidates) candidateSourceSpans.set(candidate,
    { source: message, span: { start, end: message.trimEnd().length } });
  return candidates;
}

export function captureInteractionSignals(input: {
  message: string;
  sessionId?: string;
  sourceEventId?: string;
  occurredAt?: string;
  maxFacts?: number;
  sourceProvenance: AutoCaptureSourceProvenance;
}): AutoCaptureResult {
  if (!isEligibleAutoCaptureSourceProvenance(input.sourceProvenance, {
    sessionId: input.sessionId,
    sourceEventId: input.sourceEventId,
  })) {
    return emptyAutoCaptureResult();
  }
  if (!captureMessageIsOwnerAuthored(input.message, input.sourceProvenance)) {
    logger.warn(
      {
        sessionId: input.sessionId,
        sourceEventId: input.sourceEventId,
        messageChars: input.message.length,
      },
      'auto-capture refused a message that is not the owner\'s accepted words',
    );
    return emptyAutoCaptureResult();
  }
  // Harness-injected re-prompts (judge/stall/parse/grounding/YOLO/outcome) are
  // recorded as user_input_received but are NOT user messages — never learn from
  // them. (Defense-in-depth; the loop also gates capture to the first chat turn.)
  if (autoCaptureHarnessSkipEnabled() && isHarnessInjectedInput(input.message)) {
    return emptyAutoCaptureResult();
  }
  if (isSelfContainedComputation(input.message)) {
    return emptyAutoCaptureResult();
  }
  const candidates = selectAutoMemoryCandidates(input.message, input.maxFacts ?? 3);

  // Persist the exact source turn + replayable claim rows synchronously, then
  // run the semantic conflict resolver off the response path. A daemon restart
  // after this point cannot lose the memory: maintenance drains pending rows.
  // Re-delivery of the same sourceEventId reuses the ledger rows, so retries do
  // not create duplicate facts or duplicate "learning decision" entries.
  let queuedCandidateIds: number[] = [];
  let episodeId: string | null = null;
  let callId: string | null = null;
  if (candidates.length > 0 && input.sessionId) {
    try {
      const origins = automaticMemoryOriginsForCapture({ ...input, sessionId: input.sessionId }, candidates);
      if (origins.some(origin => origin === null)) throw new Error('Automatic memory source could not be reopened.');
      const queued = enqueueAutoCaptureCandidates({
        message: input.message,
        sessionId: input.sessionId,
        sourceEventId: input.sourceEventId,
        occurredAt: input.occurredAt,
        candidates,
        origins,
      });
      queuedCandidateIds = queued.candidateIds;
      episodeId = queued.episodeId;
      callId = queued.callId;
      if (queuedCandidateIds.length > 0) {
        queueMicrotask(() => {
          void drainDurableConsolidationCandidates({ ids: queuedCandidateIds, limit: queuedCandidateIds.length })
            .catch((err) => {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err), candidateIds: queuedCandidateIds },
                'auto-capture immediate consolidation failed; durable maintenance replay remains queued',
              );
            });
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId: input.sessionId },
        'auto-capture could not persist its durable intake ledger',
      );
    }
  }

  // Profile changes are durable memory too. They follow the checked reviewed
  // destination in the drain, never an unreviewed whole-message side channel.

  return {
    candidates,
    facts: [],
    queuedCandidateIds,
    episodeId,
    callId,
  };
}
