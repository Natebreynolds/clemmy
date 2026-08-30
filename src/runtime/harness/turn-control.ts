/**
 * TURN-CONTROL SPINE — the lane-agnostic deterministic controls, in ONE place.
 *
 * Born from the 2026-07-16 unkillable-run incident: a 33-minute runaway chat
 * turn on the Claude SDK brain lane (the DEFAULT brain) had no working kill
 * switch or background handoff and ignored 15 grind
 * advisories — because every one of those controls lived in the harness
 * loop / wrapToolForHarness spine, and the SDK lane consulted none of them.
 * The controls themselves were already pure functions over sessionId
 * (assertNotKilled, evaluateToolCall, the Stage-4 budget window); what was
 * missing was CONSULTATION. This module is the consultation surface both
 * lanes share, so a future lane inherits the spine instead of re-forgetting
 * controls piecemeal.
 *
 * Composition points:
 *  - Claude SDK lane: `withKillSwitchGate` + the widened grind enforcement
 *    wrap the composed canUseTool (the one gate every tool tier passes
 *    through, and the only reliable in-loop stop via deny+interrupt);
 *    `composeKillAwareShouldCancel` gives message-boundary aborts for the
 *    whole query stream.
 *  - Harness loop: already consults the underlying primitives directly;
 *    `evaluateTurnBoundary` unifies its between-step limit checks so both
 *    lanes park with identical verdicts.
 */
import { createHash } from 'node:crypto';
import { isKillRequested, appendEvent, getSession, getTurnGraphEventForSource, listEvents, type KillRequestTarget } from './eventlog.js';
import { evaluateToolCall, applyMode, mandateFor } from './tool-guardrail.js';
import { checkRunTokenWindow, type RunTokenWindow, type RunTokenStatus } from './run-token-budget.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import { getRuntimeEnv } from '../../config.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { detectMultiItemIntent } from './multi-item-intent.js';
import { compileAcceptedGoal } from '../graph/accepted-goal.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';

// The SDK's PermissionResult shape (structural — avoids importing SDK types here).
export interface ToolGateDeny {
  behavior: 'deny';
  message: string;
  interrupt: boolean;
  /** True when this deny is the fanout refuse-and-steer (its recovery is
   *  parallel direct calls; callers that opted out of fanout skip it). */
  fanout?: boolean;
}

/** Kill verdict for one tool call. Pure; never throws. */
export function killGateVerdict(sessionId: string | undefined, target?: KillRequestTarget): ToolGateDeny | null {
  try {
    if (!sessionId || !isKillRequested(sessionId, target)) return null;
    return {
      behavior: 'deny',
      // interrupt:true is the only reliable in-loop stop on the SDK lane —
      // the turn ends instead of the model retrying around a soft deny.
      interrupt: true,
      message: 'This run was stopped by the user (kill switch). Do not continue — acknowledge the stop.',
    };
  } catch {
    return null; // the gate must never itself break a tool call
  }
}

/**
 * Grind verdict for one NATIVE-EXTERNAL tool call (tools that never reach
 * wrapToolForHarness). Enforces the SAME ladder the wrapped lane gets:
 * fanout refuse-and-steer, soft block, halt, and the terminal escalate —
 * before this, withReadFanoutGuard evaluated these tools but silently
 * discarded every verdict except the fanout block, which is exactly how the
 * incident's model ignored 15 advisories. Returns null to allow.
 */
export function grindGateVerdict(
  authoritySessionId: string | undefined,
  strippedToolName: string,
  input: unknown,
  opts?: {
    /** Isolated/stable counter identity. Approval authority remains on the real
     *  session above so workers and resumed attempts cannot lose consent. */
    trackerScopeId?: string;
    /** Byte-pinned run_batch execution already certified by the user. */
    approvedBatch?: boolean;
    /** The caller opted into the fanout refuse-and-steer (recovery: parallel
     *  direct calls). When false the fanout branch is a silent allow — no deny
     *  AND no guardrail_tripped event (emitting a discarded verdict fills the
     *  operator view with trips that never happened). */
    honorFanout?: boolean;
  },
): ToolGateDeny | null {
  try {
    if (!authoritySessionId) return null;
    const trackerScopeId = opts?.trackerScopeId ?? authoritySessionId;
    const decision = applyMode(evaluateToolCall(
      trackerScopeId,
      strippedToolName,
      input,
      undefined,
      { authoritySessionId, approvedBatch: opts?.approvedBatch },
    ));
    const emit = (kind: string, reason: string): void => {
      try {
        appendEvent({
          sessionId: authoritySessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
          data: {
            kind,
            toolName: decision.toolName,
            count: decision.count,
            reason,
            effect: decision.effect ?? null,
            dangerousWrite: decision.dangerousWrite === true,
            trackerScopeId,
            sdk: true,
          },
        });
      } catch { /* telemetry never blocks */ }
    };
    if (decision.fanoutBlock) {
      if (!opts?.honorFanout) return null; // not actionable here — allow, and do not log a phantom trip
      emit('fanout_block', decision.fanoutBlock);
      return { behavior: 'deny', message: decision.fanoutBlock, interrupt: false, fanout: true };
    }
    if (decision.action === 'escalate') {
      emit('tool_call_guardrail_escalate', decision.reason);
      return {
        behavior: 'deny',
        interrupt: true, // terminal — matches ToolGuardrailEscalated ending the turn
        message: `Terminal guardrail (${decision.reason}): ${strippedToolName} repeated past the hard stop. The turn is over; report honestly what was and was not done.`,
      };
    }
    if (decision.action === 'block' || decision.action === 'halt') {
      emit('tool_call_guardrail', decision.reason);
      // Alternatives are named only when PROVEN available (mandateFor) — this
      // deny used to hardcode both tool names, which on the Claude native-MCP
      // lane prescribed routes the turn could not always take.
      const routes = [
        mandateFor('run_worker') ? 'fan out with run_worker' : null,
        'issue the remaining reads as PARALLEL tool calls in one response',
      ].filter((route): route is string => route !== null);
      const changeApproach = routes.length
        ? `change approach (${routes.join(', or ')}) instead of retrying one at a time.`
        : 'change approach — batch the remaining work in one call by a route available to you, or report the blocker — instead of retrying one at a time.';
      return {
        behavior: 'deny',
        interrupt: false,
        message: `Guardrail ${decision.action} (${decision.reason}): ${strippedToolName} has repeated too many times this turn — ${changeApproach}`,
      };
    }
  } catch { /* the guardrail must never itself break a tool call */ }
  return null;
}

/** shouldCancel composition: the SDK polls this before start and after every
 *  stream message — OR-ing the kill switch in gives the whole query
 *  message-boundary kill coverage, not just tool edges. */
export function composeKillAwareShouldCancel(
  sessionId: string,
  base?: () => boolean | Promise<boolean>,
  target?: KillRequestTarget,
): () => boolean | Promise<boolean> {
  return async () => {
    try {
      if (isKillRequested(sessionId, target)) return true;
    } catch { /* fail-open: a kill-read error must not cancel a healthy run */ }
    return base ? await base() : false;
  };
}

// ── between-step / between-query boundary verdict ───────────────────────────

export type TurnBoundaryVerdict =
  | { kind: 'continue'; tokenStatus?: RunTokenStatus }
  | { kind: 'killed'; reason: string }
  | { kind: 'limit'; limit: 'wall_clock' | 'token_budget' | 'max_steps'; tokenStatus?: RunTokenStatus };

/**
 * One boundary check shared by both lanes: kill → wall-clock → token budget →
 * step cap, in the loop's established precedence. Pure over its inputs plus
 * two point reads (kill row, token counter); never throws.
 */
export function evaluateTurnBoundary(input: {
  sessionId: string;
  sourceUserSeq?: number;
  startedAt: number;
  maxWallMs: number;
  stepIndex: number;
  maxSteps: number;
  tokenWindow: RunTokenWindow | null;
  now?: number;
}): TurnBoundaryVerdict {
  const now = input.now ?? Date.now();
  try {
    if (isKillRequested(
      input.sessionId,
      input.sourceUserSeq ? { sourceUserSeq: input.sourceUserSeq } : undefined,
    )) return { kind: 'killed', reason: 'kill switch' };
  } catch { /* fail-open */ }
  const tokenStatus = input.tokenWindow ? checkRunTokenWindow(input.tokenWindow) : undefined;
  if (input.maxWallMs > 0 && now - input.startedAt > input.maxWallMs) {
    return { kind: 'limit', limit: 'wall_clock', tokenStatus };
  }
  if (tokenStatus?.exceeded) return { kind: 'limit', limit: 'token_budget', tokenStatus };
  if (input.stepIndex >= input.maxSteps) return { kind: 'limit', limit: 'max_steps', tokenStatus };
  return { kind: 'continue', tokenStatus };
}

// Confirmation is based on a typed turn decision, not a write-ish word anywhere
// in the sentence. The structural patterns below are inputs to that decision,
// alongside session state, destination shape, multi-item intent, and explicit
// continuation controls. Persisting the typed result lets the tool boundary
// enforce it; a model cannot bypass alignment by ignoring prompt prose.
const REQUEST_ACTION =
  '(?:send|post|publish|deploy|host|notify|email|message|draft|create|update|upload|submit|schedule|dispatch|delete|remove|commit|push|merge|migrate|import|export|sync|build|write|prepare|research|analy[sz]e|collect|pull|gather|design|make|generate|convert|turn|transform|put|save|fill|add)';
const REQUEST_ASSIST_PREFIX = '(?:(?:try|attempt)\\s+to\\s+|help\\s+me\\s+(?:to\\s+)?)?';
const REQUESTED_ACTION_PATTERNS = [
  new RegExp(`^(?:please\\s+)?${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^i\\s+(?:need|want|would\\s+like)(?:\\s+for)?\\s+(?:you\\s+)?to\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  // "lets" without the apostrophe is how people actually type it, and a request
  // stated in the first-person PLURAL ("we need to draft these") is the owner's
  // habitual voice — neither was recognized, so his own bulk-draft request read
  // as a question and skipped alignment entirely (live, 2026-07-31).
  new RegExp(`^let'?s(?:\\s+us)?\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^let\\s+us\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^we\\s+(?:need|want|have|should|ought)(?:\\s+to)?\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^we(?:'re|\\s+are)?\\s+(?:going\\s+to|gonna)\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  /^(?:please\s+)?(?:let'?s\s+|we\s+(?:need|want|have)\s+to\s+|i\s+(?:need|want)\s+to\s+|can\s+you\s+)?get\s+[^.!?\n]{0,60}?\bready\b/i,
] as const;

/**
 * Pre-authorization: when the user has ALREADY said "do this without me", an
 * alignment beat is not collaboration, it is an interruption of the exact
 * autonomy they asked for. Found by replaying the owner's real corpus — two of
 * the newly-aligned messages were explicit hand-offs ("fully autonomously in
 * the background please"), which the beat would have stalled.
 */
const PRE_AUTHORIZED_RE =
  /\b(?:fully\s+autonomous(?:ly)?|autonomously|without\s+(?:asking|checking|stopping|confirming)|don'?t\s+(?:ask|stop|check\s+with)|no\s+need\s+to\s+(?:ask|confirm|check)|just\s+do\s+it|go\s+ahead\s+and|explicitly\s+authoriz(?:e|es|ed)|i\s+authoriz(?:e|ed))\b/i;

/**
 * A request is legible wherever it appears, not only at the start of a message.
 * Real requests arrive AFTER their context ("remember X, so … lets get 50
 * ready"), and every action pattern is anchored to `^` — so a context-first
 * message carried no action signal at all and fell through to the read-only
 * branch. Splitting on clause boundaries lets the SAME anchored patterns see
 * the ask, without loosening any of them.
 *
 * A COMMA-SEPARATED LIST OF IMPERATIVES is the same problem wearing different
 * punctuation, and it hid the exact request this fix came from (live
 * 2026-07-31): "find me 10 firms…, give me the keywords…, put them in a
 * spreadsheet, and find the best contact info". Only the conjunctions split, so
 * "put them in a spreadsheet" — an unambiguous external write — never began a
 * clause, no anchored pattern could see it, and the whole message classified
 * read-only. No beat fired, no destination was recorded, no mutation authority
 * was taken. The unstated spreadsheet then surfaced at the END of the run as a
 * reason to stop, because the beginning of the run never knew a write was asked
 * for at all.
 *
 * Splitting at a comma before an action verb is safe by construction: it only
 * gives the same `^`-anchored patterns more places to be tested, and cannot
 * make a non-action clause match one.
 */
export function requestClauses(text: string): string[] {
  return (text ?? '')
    .split(new RegExp(
      `(?:[.!?;\\n]+`
      + `|,\\s*(?=(?:so|then|and|but|now)\\b)`
      + `|,\\s*(?:and\\s+|then\\s+)?(?=${REQUEST_ACTION}\\b)`
      + `|(?=\\b(?:let'?s|can\\s+you|could\\s+you|please\\s+\\w|we\\s+(?:need|want|should|have)\\b|i\\s+(?:need|want)\\b)))`,
      'i',
    ))
    .map((clause) => (clause ?? '').replace(/^\s*(?:so|then|and|but|now|okay|ok|also|actually)\b[,\s]*/i, '').trim())
    .filter((clause) => clause.length >= 6);
}
const EXTERNAL_ACTION_RE =
  /\b(?:send|post|publish|deploy|host|notify|email|upload|submit|schedule|dispatch|delete|push|merge|migrate|sync)\b|\b(?:create|update|remove|import|export|draft|write|prepare|make|generate|build|design|convert)\b[^.!?\n]{0,50}\b(?:google\s+docs?|documents?|sites?|website|calendar|event|email|message|record|crm|sheets?|drive|notion|slack|teams|outlook|github|netlify)\b/i;
const CONFIRM_CONTROLS = new Set([
  'approve', 'approved', 'yes', 'yep', 'yeah', 'y', 'ok', 'okay',
  'go', 'go ahead', 'proceed', 'continue', 'resume',
]);
const READ_ONLY_LEAD_RE =
  /^(?:what|why|how|when|where|who|which|tell me|show me|check|look at|find|search|summarize|review|explain|compare|inspect|read|list|get)\b/i;
const NOUN_SHAPED_REQUEST_RE =
  /\b(?:google\s+(?:docs?|documents?|sheets?)|website|web\s*site|calendar\s+event|email\s+draft|pull request)\b[^.!?\n]{0,100}\b(?:would\s+be|would\s+help|sounds?|please|for\s+me|i(?:'d|\s+would)\s+like)\b/i;

export type TurnPreflightPhase = 'read' | 'align' | 'execute';
export const PREFLIGHT_ALIGNMENT_SOURCE = 'preflight_alignment';
type ConfirmedMutationEffect = Extract<RuntimeToolEffect, 'local_write' | 'external_write' | 'admin'>;
type ConfirmedActionFamily = 'create' | 'update' | 'delete' | 'send' | 'publish' | 'schedule' | 'upload' | 'commit' | 'merge' | 'import' | 'export' | 'sync' | 'configure';
export type TurnSourceStrategyPosture = 'materially_variant' | 'confirmed_exact' | 'standing_exact';
export type TurnConfirmationDisposition = 'material_source_strategy';

export interface TurnSourceCapabilityBindingV1 {
  /** Exact host capability identity, never a provider name inferred from prose. */
  capabilityId: string;
  /** Optional exact connected account boundary for this capability. */
  accountIdentity?: string;
  /** Optional exact schema/manifest identity observed by the selector. */
  schemaFingerprint?: string;
}

/** Provider-neutral result of source selection. This module transports the
 * binding; the selector authors it and the dispatch/carrier boundary enforces
 * it. Equivalent fallbacks are bounded so an approval cannot become a fresh
 * provider search. */
export interface TurnSourceStrategyBindingV1 {
  version: 1;
  primary: TurnSourceCapabilityBindingV1;
  equivalentFallbacks: readonly TurnSourceCapabilityBindingV1[];
  topology: 'single_aggregate_read_then_single_artifact_write';
  /** Digest of the selector's exact aggregate-read -> artifact-write plan. */
  topologyDigest: string;
  destination: {
    family: string;
    posture: 'create_new' | 'named_existing';
  };
  effect: ConfirmedMutationEffect;
}

export interface TurnPreflightDecision {
  phase: TurnPreflightPhase;
  consequential: boolean;
  destination?: string;
  /** The destination KIND is known and the specific one is not — the beat has
   *  to settle it now rather than let it surface as a mid-run stop. */
  destinationInstanceUnstated?: boolean;
  /** Digest of the concrete user request that is waiting for confirmation. */
  intentKey?: string;
  /** On the acknowledgement turn, the exact pending intent being authorized. */
  confirmedIntentKey?: string;
  /** Original consequential ask. Kept in typed state so an acknowledgement
   *  such as "go ahead" cannot replace the artifact/task objective. */
  objective?: string;
  /** Exact mutation classes and service families authorized by the aligned
   *  request. Reads remain available after approval; mutations fail closed. */
  allowedMutationEffects?: ConfirmedMutationEffect[];
  allowedDestinations?: string[];
  allowedActionFamilies?: ConfirmedActionFamily[];
  /** Host classification of whether the collection source is still a material
   * choice. This is provider-neutral; the active model authors the proposal. */
  sourceStrategyPosture?: TurnSourceStrategyPosture;
  /** A typed stop owned by the host. Model prose cannot silently downgrade it
   * to a same-turn preamble or upgrade an ordinary settled turn into a stop. */
  confirmationDisposition?: TurnConfirmationDisposition;
  /** Optional selector-authored binding carried byte-for-byte through a later
   * confirmation. Its presence never makes an unconfirmed strategy confirmed. */
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
  reason:
    | 'non_chat'
    | 'feature_disabled'
    | 'pre_authorized'
    | 'continuation_approved'
    | 'already_aligned_session'
    | 'read_only_request'
    | 'validation_blocked'
    | 'external_action'
    | 'multi_item_action'
    | 'noun_shaped_artifact_request'
    | 'collect_then_construct'
    | 'ordinary_execution';
}

function normalizedControl(text: string): string {
  return text.trim().toLowerCase().replace(/[.!]+$/g, '').replace(/\s+/g, ' ');
}

function isConfirmationControl(text: string): boolean {
  return CONFIRM_CONTROLS.has(normalizedControl(text));
}

function intentKeyFor(message: string, destination: string | undefined): string {
  return createHash('sha256')
    .update(`${message.trim().replace(/\s+/g, ' ').toLowerCase()}\0${destination?.toLowerCase() ?? ''}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * The ONE destination vocabulary. Both the mutation-authority keys
 * (`allowedDestinations`) and the human-facing destination label read from
 * here, so the two can never disagree about whether a word names a place.
 *
 * Every noun is PLURALIZED. They were singular-only, which meant "draft
 * outbound emails" carried no email destination while "draft an email" did —
 * an under-granted authority that only stayed invisible because a second,
 * separate regex happened to cover the plural for the other consumer.
 */
const DESTINATION_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['google_docs', /\b(?:google\s*docs?|googledocs|google\s+documents?)\b/i],
  ['google_sheets', /\b(?:google\s*sheets?|googlesheets|spreadsheets?)\b/i],
  ['google_drive', /\b(?:google\s*drive|gdrive)\b/i],
  ['email', /\b(?:e-?mails?|gmail|outlook|mail)\b/i],
  ['calendar', /\b(?:calendars?|meetings?|events?)\b/i],
  ['website', /\b(?:web\s*sites?|netlify|vercel|railway|deploy|publish|host)\b/i],
  ['github', /\b(?:github|pull\s*requests?|git\s+push|push\s+it)\b/i],
  ['slack', /\bslack\b/i],
  ['teams', /\b(?:microsoft\s+teams|teams)\b/i],
  ['notion', /\bnotion\b/i],
  ['crm', /\b(?:crm|salesforce|hubspot)\b/i],
  ['messages', /\b(?:messages?|sms|text\s+messages?|discord)\b/i],
  ['documents', /\b(?:documents?|\bdocs?\b|word\s+files?)\b/i],
  ['local', /\b(?:local|workspace|repository|\brepo\b|source\s+files?|codebase|filesystem)\b/i],
  ['memory', /\b(?:memory|remember|profile)\b/i],
];

function destinationKeysFromText(text: string): string[] {
  const keys = DESTINATION_RULES
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
  return [...new Set(keys)];
}

const GENERIC_PROVIDER_STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'new', 'existing', 'client', 'customer',
  'project', 'company', 'firm', 'single', 'one', 'another',
  // Grammar/scope words are not provider names. Without these, phrases such
  // as "in exactly one run_worker call" and "using no external tools" minted
  // fake destinations provider:exactly and provider:no, which in turn
  // upgraded a local read-only task into an external mutation.
  'all', 'any', 'each', 'every', 'exactly', 'external', 'local', 'no', 'not',
  'only', 'state', 'that', 'these', 'this', 'those', 'tool', 'tools', 'without',
]);

function normalizeProviderAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Capture an explicitly named provider without maintaining a closed list.
 * Examples: "create an Airtable record", "add a card in trello", "via Linear". */
function genericProviderAliasesFromObjective(text: string): string[] {
  const aliases: string[] = [];
  const patterns = [
    /\b(?:create|update|edit|delete|remove|add|send|schedule|publish|upload)\s+(?:an?\s+)?([A-Za-z][A-Za-z0-9.-]{1,30})\s+(?:record|card|issue|task|ticket|row|page|item|contact|lead|entry|message|event)\b/gi,
    /\b(?:use|prefer)\s+([A-Za-z][A-Za-z0-9.-]{1,30})\s+(?:to|for|as)\b/gi,
    // An explicit collection source is already the user's choice. Keep this
    // provider-neutral: the exact physical capability still has to arrive as
    // a selector-authored binding before any source call can cross the gate.
    /\bfrom\s+(?:the\s+)?([A-Za-z][A-Za-z0-9.-]{1,30})\s+api\b/gi,
    // "in/on <word>" is ordinary English far more often than a provider
    // reference ("research in detail", "run on Monday"). Keep only explicit
    // integration prepositions; known providers still resolve through
    // DESTINATION_RULES regardless of phrasing.
    /\b(?:via|using|through)\s+([A-Za-z][A-Za-z0-9.-]{1,30})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const alias = normalizeProviderAlias(match[1] ?? '');
      if (alias && !GENERIC_PROVIDER_STOPWORDS.has(alias)) aliases.push(`provider:${alias}`);
    }
  }
  return [...new Set(aliases)];
}

/** Remove explicitly forbidden action clauses before inferring destination or
 * mutation authority. Constraints such as "do not deploy to Netlify" and
 * "using no external tools" describe what must NOT happen; treating their
 * nouns as positive intent creates exactly the redundant confirmation loops
 * the typed preflight was meant to prevent. */
function positivePreflightSignalText(text: string): string {
  return text
    .replace(/\b(?:do\s+not|don't|never|without)\b[^.!?;\n]{0,160}/gi, ' ')
    .replace(/\bno\s+(?:external|remote|provider|network|write|writes|writing|mutation|mutations|tool|tools)\b[^.!?;\n]{0,120}/gi, ' ');
}

/**
 * A conditional mutation with a concrete incomplete value is not ready for an
 * alignment/execute beat yet. The useful next action is to identify the blocker.
 *
 * Strip hypothetical "if/unless something is missing" clauses before looking
 * for a real data marker, so a fully populated batch with a defensive rule does
 * not get mislabeled as blocked.
 */
function hasExplicitValidationBlocker(text: string): boolean {
  const gatedMutation =
    /\b(?:do\s+not|don't|never)\b[^.!?\n]{0,180}\b(?:create|write|send|publish|deploy|update|upload|submit)\b[^.!?\n]{0,120}\b(?:unless|until)\b/i.test(text)
    || /\b(?:validate|verify|check)\b[^.!?\n]{0,120}\bbefore\b[^.!?\n]{0,80}\b(?:create|write|send|publish|deploy|update|upload|submit)\b/i.test(text);
  if (!gatedMutation) return false;
  const concreteData = text
    .replace(/\bif\b[^.!?;\n]{0,220}/gi, ' ')
    .replace(/\bunless\b[^.!?;\n]{0,220}/gi, ' ');
  return (
    /\b(?:email|e-mail|field|value|data|row|record|address|phone|url|id)\b\s*(?::|—|-|=|\bis\b)?\s*\b(?:missing|blank|unknown|null|not\s+provided|tbd)\b/i.test(concreteData)
    || /\b(?:missing|blank|unknown|null|not\s+provided|tbd)\b\s+(?:email|e-mail|field|value|data|row|record|address|phone|url|id)\b/i.test(concreteData)
  );
}

/**
 * An unstated DESTINATION INSTANCE — the request names a kind of place to write
 * ("put them in a spreadsheet", "add these to the CRM") but not WHICH one.
 *
 * This is the single most common way a request that is otherwise perfectly clear
 * turns into nothing. Live 2026-07-31: a finished ten-firm scrape ended with "I
 * didn't write to a base I didn't know I should" — the whole deliverable
 * abandoned over a detail the user would have settled in four words, discovered
 * at the END of the work instead of the beginning.
 *
 * An unknown destination is not a reason to stop. It is a thing to confirm, and
 * the beat is where confirming belongs: before the work, in the same breath as
 * "here's how I'm reading this", at a moment when the answer costs nothing. Ask
 * it afterwards and the user has paid for the run and received none of it.
 *
 * Detection is deliberately generous, because the cost of a false positive is
 * one extra clause in a sentence the model was already writing, while the cost
 * of a false negative is an abandoned deliverable. Any concrete anchor counts as
 * stated: a link, a quoted or explicitly-named target, an instruction to make a
 * new one, or a possessive reference to a specific known thing.
 */
const DESTINATION_INSTANCE_ANCHOR_RE = new RegExp([
  // A link pins it exactly.
  'https?://\\S+',
  // A quoted or explicitly-named target: the "Prospects" base, a sheet called X.
  '["“‘\'][^"”’\']{2,60}["”’\']',
  '\\b(?:named|called|titled|labelled|labeled|id|ID)\\b\\s*[:=]?\\s*\\S+',
  // "a new spreadsheet" / "create a new base" — creating one IS the decision.
  '\\bnew\\b',
  // They asked to receive the artifact URL: the instance is the one we create.
  '\\b(?:give|send|paste|share)\\s+(?:me\\s+)?(?:the\\s+)?link\\b',
  // A reference to one specific existing thing the user has in mind.
  '\\b(?:the\\s+same|same\\s+one|as\\s+(?:last|before)|existing|usual|current)\\b',
].join('|'), 'i');

export function destinationInstanceUnstated(text: string, destination: string | undefined): boolean {
  if (!destination) return false;
  // Destinations that are singular by nature have no "which one" to settle:
  // there is one local filesystem, one memory, one connected calendar/mailbox
  // until the user says otherwise. Asking there is ceremony, not alignment.
  if (SINGULAR_DESTINATIONS.has(destination)) return false;
  return !DESTINATION_INSTANCE_ANCHOR_RE.test(text ?? '');
}

const SINGULAR_DESTINATIONS: ReadonlySet<string> = new Set([
  'local', 'memory', 'calendar', 'email', 'messages',
]);

/** The extra beat line for a request whose destination kind is clear and whose
 *  destination INSTANCE is not. Names the shape of the answer wanted — a
 *  proposal to correct, never an open question — so the beat stays one sentence
 *  and the user can say "yes" instead of doing the choosing. */
export function unstatedDestinationBeatLine(destination: string): string {
  return `[destination] The request says WHERE-kind (${destination.replace(/_/g, ' ')}) but not WHICH one. `
    + 'Name the specific destination you intend to use — an existing one you can see, or a new one you will create and what you will call it — '
    + 'as part of your beat, phrased as the choice you are making so they need only correct it. '
    + 'Do NOT start the work planning to settle this later: an unknown destination discovered at the END means the work is done and undelivered. '
    + 'If you cannot see any candidate, say what you will create instead — never treat not knowing as a reason to stop.';
}

function mutationAuthorityForObjective(
  text: string,
  externalAction: boolean,
  nounShapedArtifactRequest: boolean,
): Pick<TurnPreflightDecision, 'allowedMutationEffects' | 'allowedDestinations' | 'allowedActionFamilies'> {
  const allowedDestinations = destinationKeysFromText(text);
  allowedDestinations.push(...genericProviderAliasesFromObjective(text));
  const allowedActionFamilies = actionFamiliesFromText(text, true);
  const allowedMutationEffects: ConfirmedMutationEffect[] = [];
  if (externalAction || nounShapedArtifactRequest || allowedDestinations.some((key) => key !== 'local' && key !== 'memory')) {
    allowedMutationEffects.push('external_write');
  }
  if (allowedDestinations.includes('local') || allowedDestinations.includes('memory')) {
    allowedMutationEffects.push('local_write');
  }
  if (/\b(?:install|uninstall|configure|configuration|admin|permission|credential|secret|system setting)\b/i.test(text)) {
    allowedMutationEffects.push('admin');
  }
  return {
    allowedMutationEffects: [...new Set(allowedMutationEffects)],
    allowedDestinations,
    allowedActionFamilies,
  };
}

function actionFamiliesFromText(text: string, objective: boolean): ConfirmedActionFamily[] {
  const normalized = text.replace(/[_-]+/g, ' ');
  const actions: ConfirmedActionFamily[] = [];
  if (/\b(?:delete|remove|trash|archive|destroy|revoke)\b/i.test(normalized)) actions.push('delete');
  if (
    /\b(?:send|notify|dispatch|forward|reply|broadcast|dm)\b/i.test(normalized)
    || (objective
      ? /(?:^|\b(?:you|to|then|and)\s+)(?:please\s+)?(?:email|message)\s+(?!address|column|field|value|missing|blank|data|using|with|is\b|=|:)(?:the\s+)?[a-z0-9@]/i.test(normalized.trim())
      : /\b(?:email|message)\b/i.test(normalized))
  ) actions.push('send');
  if (
    /\b(?:deploy|publish|host|release|push)\b/i.test(normalized)
    || (objective
      ? /(?:^|\b(?:you|to|then|and)\s+)(?:please\s+)?post\b/i.test(normalized.trim())
      : /\bpost\b/i.test(normalized))
  ) actions.push('publish');
  if (/\b(?:schedule|book|invite)\b/i.test(normalized)) actions.push('schedule');
  if (/\b(?:upload|attach)\b/i.test(normalized)) actions.push('upload');
  if (/\bcommit\b/i.test(normalized)) actions.push('commit');
  if (/\bmerge\b/i.test(normalized)) actions.push('merge');
  if (/\bimport\b/i.test(normalized)) actions.push('import');
  if (/\bexport\b/i.test(normalized)) actions.push('export');
  if (/\bsync\b/i.test(normalized)) actions.push('sync');
  if (/\b(?:configure|configuration|install|uninstall|enable|disable|permission|credential|secret|setting)\b/i.test(normalized)) actions.push('configure');
  if (/\b(?:update|edit|modify|patch|append|rename|move|set|fill|add)\b/i.test(normalized)) actions.push('update');
  if (/\b(?:create|make|generate|build|write|prepare|draft|convert|turn|transform|save|new)\b/i.test(normalized)) actions.push('create');
  // "Create/build/deploy a website" normally requires both provisioning and
  // publishing; authorize that narrow pair without widening document creates.
  if (objective && actions.includes('create') && destinationKeysFromText(text).includes('website')) actions.push('publish');
  return [...new Set(actions)];
}

const MAX_SOURCE_BINDING_TEXT_CHARS = 512;
const MAX_EQUIVALENT_SOURCE_FALLBACKS = 3;

function sourceBindingText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_SOURCE_BINDING_TEXT_CHARS;
}

function validSourceCapabilityBinding(value: unknown): value is TurnSourceCapabilityBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.some((key) => !['capabilityId', 'accountIdentity', 'schemaFingerprint'].includes(key))) return false;
  return sourceBindingText(row.capabilityId)
    && (row.accountIdentity === undefined || sourceBindingText(row.accountIdentity))
    && (row.schemaFingerprint === undefined || sourceBindingText(row.schemaFingerprint));
}

/** Runtime decoder for eventlog state. Invalid/expanded bindings never become
 * confirmation authority. The validated object is returned unchanged so an
 * exact approval preserves the selector's bytes and field values. */
export function validatedTurnSourceStrategyBinding(
  value: unknown,
): TurnSourceStrategyBindingV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).some((key) => ![
    'version',
    'primary',
    'equivalentFallbacks',
    'topology',
    'topologyDigest',
    'destination',
    'effect',
  ].includes(key))) return null;
  if (binding.version !== 1 || !validSourceCapabilityBinding(binding.primary)) return null;
  if (
    !Array.isArray(binding.equivalentFallbacks)
    || binding.equivalentFallbacks.length > MAX_EQUIVALENT_SOURCE_FALLBACKS
    || !binding.equivalentFallbacks.every(validSourceCapabilityBinding)
  ) return null;
  if (binding.topology !== 'single_aggregate_read_then_single_artifact_write') return null;
  if (typeof binding.topologyDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(binding.topologyDigest)) return null;
  if (!binding.destination || typeof binding.destination !== 'object' || Array.isArray(binding.destination)) return null;
  const destination = binding.destination as Record<string, unknown>;
  if (Object.keys(destination).some((key) => !['family', 'posture'].includes(key))) return null;
  if (!sourceBindingText(destination.family)) return null;
  if (destination.posture !== 'create_new' && destination.posture !== 'named_existing') return null;
  if (binding.effect !== 'local_write' && binding.effect !== 'external_write' && binding.effect !== 'admin') return null;
  return value as TurnSourceStrategyBindingV1;
}

/**
 * The model that authors a material-source confirmation sees only the
 * selector's validated, structurally eligible binding. General capability
 * memory is intentionally absent here: an unrelated or originless procedure
 * may remain useful during ordinary execution, but cannot bias the source
 * proposal a user is being asked to approve.
 */
export function renderSourceStrategyConfirmationContext(value: unknown): string {
  const binding = validatedTurnSourceStrategyBinding(value);
  if (!binding) {
    return [
      '[source strategy confirmation — host-validated facts only]',
      'No validated source capability is bound. Do not propose or imply a provider from general capability memory.',
      'Ask the user to name the source; a bare confirmation cannot authorize execution.',
    ].join('\n');
  }
  const eligible = [binding.primary, ...binding.equivalentFallbacks];
  return [
    '[source strategy confirmation — host-validated facts only]',
    `Primary source: ${binding.primary.capabilityId}`,
    ...(binding.primary.accountIdentity ? [`Primary account: ${binding.primary.accountIdentity}`] : []),
    ...(binding.primary.schemaFingerprint ? [`Primary schema: ${binding.primary.schemaFingerprint}`] : []),
    ...(binding.equivalentFallbacks.length > 0
      ? [`Structurally eligible fallbacks: ${binding.equivalentFallbacks.map((row) => row.capabilityId).join(', ')}`]
      : ['Structurally eligible fallbacks: none']),
    `Bound topology: ${binding.topology}`,
    `Destination: ${binding.destination.posture} ${binding.destination.family}`,
    `Only these ${eligible.length} receipt-validated source path${eligible.length === 1 ? '' : 's'} may be named in the source proposal.`,
  ].join('\n');
}

function sourceCapabilityBindingsEqual(
  left: TurnSourceCapabilityBindingV1,
  right: TurnSourceCapabilityBindingV1,
): boolean {
  return left.capabilityId === right.capabilityId
    && left.accountIdentity === right.accountIdentity
    && left.schemaFingerprint === right.schemaFingerprint;
}

/** Exact structural equality for a selector-authored source binding. This is
 * deliberately field-wise: object serialization order is not authority. */
export function sourceStrategyBindingsEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  const validatedLeft = validatedTurnSourceStrategyBinding(left);
  const validatedRight = validatedTurnSourceStrategyBinding(right);
  if (!validatedLeft || !validatedRight) return false;
  return validatedLeft.version === validatedRight.version
    && sourceCapabilityBindingsEqual(validatedLeft.primary, validatedRight.primary)
    && validatedLeft.equivalentFallbacks.length === validatedRight.equivalentFallbacks.length
    && validatedLeft.equivalentFallbacks.every((entry, index) =>
      sourceCapabilityBindingsEqual(entry, validatedRight.equivalentFallbacks[index]!))
    && validatedLeft.topology === validatedRight.topology
    && validatedLeft.topologyDigest === validatedRight.topologyDigest
    && validatedLeft.destination.family === validatedRight.destination.family
    && validatedLeft.destination.posture === validatedRight.destination.posture
    && validatedLeft.effect === validatedRight.effect;
}

function canonicalSourceCapabilityBinding(value: TurnSourceCapabilityBindingV1): {
  capabilityId: string;
  accountIdentity?: string;
  schemaFingerprint?: string;
} {
  return {
    capabilityId: value.capabilityId,
    ...(value.accountIdentity ? { accountIdentity: value.accountIdentity } : {}),
    ...(value.schemaFingerprint ? { schemaFingerprint: value.schemaFingerprint } : {}),
  };
}

/** Reproduce the selector's content digest from typed fields. JSON is used only
 * as the canonical byte encoding fed into SHA-256; equality never depends on
 * caller object layout or serialization order. */
export function sourceStrategyTopologyDigestFor(value: unknown): string | null {
  const binding = validatedTurnSourceStrategyBinding(value);
  if (!binding) return null;
  return createHash('sha256').update(JSON.stringify({
    topology: binding.topology,
    primary: canonicalSourceCapabilityBinding(binding.primary),
    equivalentFallbacks: binding.equivalentFallbacks.map(canonicalSourceCapabilityBinding),
    destination: {
      family: binding.destination.family,
      posture: binding.destination.posture,
    },
    effect: binding.effect,
  })).digest('hex');
}

/** A replacement is a fresh source choice for the same task, never a way to
 * amend its destination or effect contract. Its selector digest must cover the
 * exact replacement bytes, and its primary must not reuse any A identity. */
export function materialSourceReplacementBindingIsCompatible(input: {
  parent: unknown;
  replacement: unknown;
}): input is {
  parent: TurnSourceStrategyBindingV1;
  replacement: TurnSourceStrategyBindingV1;
} {
  const parent = validatedTurnSourceStrategyBinding(input.parent);
  const replacement = validatedTurnSourceStrategyBinding(input.replacement);
  if (!parent || !replacement) return false;
  if ([parent.primary, ...parent.equivalentFallbacks]
    .some((identity) => sourceCapabilityBindingsEqual(identity, replacement.primary))) return false;
  if (
    parent.topology !== replacement.topology
    || parent.destination.family !== replacement.destination.family
    || parent.destination.posture !== replacement.destination.posture
    || parent.effect !== replacement.effect
    || sourceStrategyTopologyDigestFor(replacement) !== replacement.topologyDigest
  ) return false;
  const identities = [replacement.primary, ...replacement.equivalentFallbacks];
  return identities.every((identity, index) =>
    identities.findIndex((candidate) => sourceCapabilityBindingsEqual(candidate, identity)) === index);
}

function equalAuthoritySet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const l = [...new Set(left ?? [])].sort();
  const r = [...new Set(right ?? [])].sort();
  return l.length === r.length && l.every((entry, index) => entry === r[index]);
}

/** Complete authority comparison for durable decision readback. */
export function turnPreflightDecisionsEqual(
  left: TurnPreflightDecision,
  right: TurnPreflightDecision,
): boolean {
  return left.phase === right.phase
    && left.consequential === right.consequential
    && left.destination === right.destination
    && left.destinationInstanceUnstated === right.destinationInstanceUnstated
    && left.intentKey === right.intentKey
    && left.confirmedIntentKey === right.confirmedIntentKey
    && left.objective === right.objective
    && equalAuthoritySet(left.allowedMutationEffects, right.allowedMutationEffects)
    && equalAuthoritySet(left.allowedDestinations, right.allowedDestinations)
    && equalAuthoritySet(left.allowedActionFamilies, right.allowedActionFamilies)
    && left.sourceStrategyPosture === right.sourceStrategyPosture
    && left.confirmationDisposition === right.confirmationDisposition
    && sourceStrategyBindingsEqual(left.sourceStrategyBinding, right.sourceStrategyBinding)
    && left.reason === right.reason;
}

function variantIntentKey(input: {
  parentIntentKey: string;
  answer: string;
  binding: TurnSourceStrategyBindingV1;
}): string {
  const hash = createHash('sha256');
  for (const field of [
    'material-source-variant-alignment-v1',
    input.parentIntentKey,
    input.answer,
    input.binding.topologyDigest,
  ]) {
    hash.update(String(Buffer.byteLength(field, 'utf8'))).update(':').update(field).update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

/** Rebase an exact A/Q/B source correction onto a second *unconfirmed*
 * alignment decision. This copies the parent task's authority ceiling and
 * changes only the selector-authored source binding; it grants no consent. */
export function materiallyVariantSourceStrategyDecision(input: {
  parentDecision: TurnPreflightDecision;
  parentBinding: unknown;
  replacementBinding: unknown;
  acceptedAnswer: string;
}): TurnPreflightDecision | null {
  const parentBinding = validatedTurnSourceStrategyBinding(input.parentBinding);
  const replacementBinding = validatedTurnSourceStrategyBinding(input.replacementBinding);
  const answer = input.acceptedAnswer;
  if (
    !parentBinding
    || !replacementBinding
    || !answer
    || input.parentDecision.phase !== 'align'
    || input.parentDecision.consequential !== true
    || input.parentDecision.reason !== 'collect_then_construct'
    || input.parentDecision.sourceStrategyPosture !== 'materially_variant'
    || input.parentDecision.confirmationDisposition !== 'material_source_strategy'
    || !input.parentDecision.intentKey
    || !input.parentDecision.objective?.trim()
    || !sourceStrategyBindingsEqual(input.parentDecision.sourceStrategyBinding, parentBinding)
    || !materialSourceReplacementBindingIsCompatible({
      parent: parentBinding,
      replacement: replacementBinding,
    })
  ) return null;
  return {
    phase: 'align',
    consequential: true,
    ...(input.parentDecision.destination
      ? { destination: input.parentDecision.destination }
      : {}),
    intentKey: variantIntentKey({
      parentIntentKey: input.parentDecision.intentKey,
      answer,
      binding: replacementBinding,
    }),
    objective: input.parentDecision.objective,
    ...(input.parentDecision.allowedMutationEffects
      ? { allowedMutationEffects: [...input.parentDecision.allowedMutationEffects] }
      : {}),
    ...(input.parentDecision.allowedDestinations
      ? { allowedDestinations: [...input.parentDecision.allowedDestinations] }
      : {}),
    ...(input.parentDecision.allowedActionFamilies
      ? { allowedActionFamilies: [...input.parentDecision.allowedActionFamilies] }
      : {}),
    sourceStrategyPosture: 'materially_variant',
    confirmationDisposition: 'material_source_strategy',
    sourceStrategyBinding: replacementBinding,
    reason: 'collect_then_construct',
  };
}

function sourceProviderAlias(capabilityId: string): string | null {
  const composio = capabilityId.match(/^capability:composio:([^_:\s]+)(?:_|$)/i);
  const mcp = capabilityId.match(/^capability:mcp:([^_:\s]+)(?:__|:|$)/i);
  const provider = normalizeProviderAlias(composio?.[1] ?? mcp?.[1] ?? '');
  return provider || null;
}

/** Legacy named-primary selection remains available for ordinary answers such
 * as "Use Acme as the restaurant source", but the provider phrase must own the
 * whole answer. Negative constraints and fresh work clauses are not discarded
 * before matching: only the exact referential grammar below may revoke
 * fallbacks, and every other compound answer must re-enter alignment. */
function wholeAnswerNamedSourceProvider(text: string): string | null {
  const answer = text.trim();
  // This is a positive grammar, not a growing synonym deny-list. Preserve the
  // shipped bare/restaurant legacy forms; any other descriptor (including
  // backup/failover/alternate roles) is a new source-selection clause that
  // must return to typed alignment.
  const match = /^(?:use|prefer)\s+([A-Za-z][A-Za-z0-9.-]{1,30})\s+(?:as|for)\s+(?:the\s+)?(?:restaurant\s+)?source[.!]*$/i
    .exec(answer);
  const provider = normalizeProviderAlias(match?.[1] ?? '');
  return provider || null;
}

/** Deliberately exact grammar for narrowing an already-durable source binding.
 * The words "primary" and "fallback" are roles in that binding, never provider
 * names inferred from prose. Requiring the affirmative, same-arguments, and
 * explicit fallback-revocation clauses keeps this from becoming a generic
 * "yes, and ..." authority path. */
export function isPrimaryOnlyBoundSourceConfirmation(text: string): boolean {
  return /^(?:yes|yep|yeah|ok|okay|sure|go ahead|proceed|continue)\s*(?:[—–-]|[,;:])?\s*use exactly the primary source action you named,?\s+with the same (?:parameters|arguments)[.!]\s*(?:do not|don['’]?t) use (?:the )?fallback[.!]*$/i
    .test(text.trim());
}

/** Return the exact source binding B selects, or null. This helper never
 * grants authority by itself: callers must first prove the exact durable A/Q
 * edge. A bare confirmation or exact primary provider preserves the binding;
 * the bounded primary-only form removes every fallback without changing the
 * primary, topology, destination, effect, account, or schema identity. */
export function sourceStrategyBindingAffirmedByAnswer(
  text: string,
  value: unknown,
): TurnSourceStrategyBindingV1 | null {
  const binding = validatedTurnSourceStrategyBinding(value);
  if (!binding) return null;
  if (isConfirmationControl(text)) return binding;
  if (isPrimaryOnlyBoundSourceConfirmation(text)) {
    return binding.equivalentFallbacks.length === 0
      ? binding
      : { ...binding, equivalentFallbacks: [] };
  }
  const namedProvider = wholeAnswerNamedSourceProvider(text);
  if (!namedProvider) return null;
  // An explicitly named fallback is a new choice: approving it while leaving
  // the old primary and every fallback callable would widen what B selected.
  // Until the selector deterministically rebases that binding, only the exact
  // primary name (or a bare approval above) consumes A/Q.
  const primaryProvider = sourceProviderAlias(binding.primary.capabilityId);
  return primaryProvider && namedProvider === primaryProvider
    ? binding
    : null;
}

/** Boolean compatibility surface for callers that only need the verdict. */
export function answerAffirmsTurnSourceStrategyBinding(text: string, value: unknown): boolean {
  return sourceStrategyBindingAffirmedByAnswer(text, value) !== null;
}

function decisionForSource(
  sessionId: string,
  rows: ReturnType<typeof listEvents>,
  sourceUserSeq: number,
): TurnPreflightDecision | null {
  const row = rows
    .filter((event) => event.type === 'turn_preflight_decision')
    .sort((a, b) => b.seq - a.seq)
    .find((event) => (event.data as { sourceUserSeq?: number }).sourceUserSeq === sourceUserSeq);
  return row ? row.data as unknown as TurnPreflightDecision : null;
}

function latestUserSeq(rows: ReturnType<typeof listEvents>): number {
  return rows
    .filter((row) => row.type === 'user_input_received')
    .reduce((max, row) => Math.max(max, row.seq), 0);
}

function alignedDecisionForIntent(
  rows: ReturnType<typeof listEvents>,
  intentKey: string,
): TurnPreflightDecision | null {
  const row = rows
    .filter((event) => event.type === 'turn_preflight_decision')
    .sort((a, b) => b.seq - a.seq)
    .find((event) => {
      const candidate = event.data as unknown as TurnPreflightDecision;
      return candidate.phase === 'align' && candidate.intentKey === intentKey;
    });
  return row ? row.data as unknown as TurnPreflightDecision : null;
}

/** Acknowledgement authority exists only for the immediately preceding user
 * request and only when that request structurally stopped on its durable
 * `align` question. An advisory align row from a turn that went on to execute
 * is not pending consent and can never turn a later bare "yes" into authority. */
function pendingAlignmentForCurrentInput(
  sessionId: string,
  sourceUserSeq?: number,
  acceptedText?: string,
): TurnPreflightDecision | null {
  try {
    const rows = listEvents(sessionId, {
      types: [
        'user_input_received',
        'turn_preflight_decision',
        'awaiting_user_input',
        'conversation_completed',
      ],
    });
    const users = rows.filter((row) => row.type === 'user_input_received'
      && row.role === 'user'
      && row.data.synthetic !== true);
    const currentIndex = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? users.findIndex((row) => row.seq === sourceUserSeq)
      : users.length - 1;
    const previousUser = currentIndex > 0 ? users[currentIndex - 1] : undefined;
    const currentUser = currentIndex >= 0 ? users[currentIndex] : undefined;
    if (!previousUser || !currentUser) return null;
    if (
      typeof acceptedText !== 'string'
      || typeof currentUser.data.text !== 'string'
      || currentUser.data.text !== acceptedText
    ) return null;
    const decision = decisionForSource(sessionId, rows, previousUser.seq);
    if (decision?.phase !== 'align' || typeof decision.intentKey !== 'string' || !decision.intentKey) {
      return null;
    }
    if (
      decision.confirmationDisposition === 'material_source_strategy'
      && (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq !== currentUser.seq)
    ) return null;
    const awaiting = rows.find((row) => row.type === 'awaiting_user_input'
      && row.data.sourceUserSeq === previousUser.seq
      && row.data.source === PREFLIGHT_ALIGNMENT_SOURCE
      && row.data.intentKey === decision.intentKey);
    if (!awaiting) return null;
    // A material source question with no selector-authored binding is a real
    // question, but "Yes" cannot approve an unnamed provider. The user must
    // name a source (which is classified as fresh explicit authority) or the
    // selector must first persist one exact validated binding.
    if (decision.confirmationDisposition === 'material_source_strategy'
      && (!validatedTurnSourceStrategyBinding(decision.sourceStrategyBinding)
        || !validatedTurnSourceStrategyBinding(awaiting.data.sourceStrategyBinding))) return null;
    if (!sourceStrategyBindingsEqual(
      decision.sourceStrategyBinding,
      awaiting.data.sourceStrategyBinding,
    )) return null;
    const terminal = rows.find((row) => {
      const currentUserSeq = users[currentIndex]?.seq ?? Number.POSITIVE_INFINITY;
      if (
        row.type !== 'conversation_completed'
        || row.seq <= awaiting.seq
        || row.seq >= currentUserSeq
      ) return false;
      try {
        const presentation = presentationEventFromCompletionData(row.data);
        return presentation?.identity.sourceUserSeq === previousUser.seq
          && presentation.status === 'needs_input'
          && presentation.kind === 'question'
          && presentation.needs?.kind === 'input'
          && presentation.text === awaiting.data.question;
      } catch {
        return false;
      }
    });
    return terminal ? decision : null;
  } catch {
    return null;
  }
}

/** A named source answer is approval only when it selects the primary source
 * on the exact durable A/Q edge immediately preceding this accepted input.
 * This is deliberately narrower than general provider detection: the words do
 * not create authority, they merely consume the already-bound typed choice. */
function selectedPendingMaterialSourceBinding(
  text: string,
  pending: TurnPreflightDecision,
  currentBinding: unknown,
): TurnSourceStrategyBindingV1 | null {
  if (pending.confirmationDisposition !== 'material_source_strategy') return null;
  const pendingBinding = validatedTurnSourceStrategyBinding(pending.sourceStrategyBinding);
  const suppliedBinding = validatedTurnSourceStrategyBinding(currentBinding);
  if (!pendingBinding || !suppliedBinding) return null;
  const selected = sourceStrategyBindingAffirmedByAnswer(text, pendingBinding);
  if (!selected) return null;
  // The continuation resolver normally supplies the already-narrowed binding.
  // Accepting the original durable bytes as input is also safe: the return
  // value still narrows the preflight decision before any physical dispatch.
  if (
    !sourceStrategyBindingsEqual(suppliedBinding, pendingBinding)
    && !sourceStrategyBindingsEqual(suppliedBinding, selected)
  ) {
    return null;
  }
  return selected;
}

/**
 * Destinations that live inside this machine. Writing to them is real work, but
 * it is not the kind of write that needs the user to confirm WHERE first —
 * there is one filesystem and one memory.
 */
const NON_EXTERNAL_DESTINATION_KEYS: ReadonlySet<string> = new Set(['local', 'memory', 'documents']);

/**
 * The external destination named in a request, as the user's own words.
 *
 * Derived from DESTINATION_RULES — the SAME vocabulary that already decides
 * `allowedDestinations` — rather than from a second, narrower list. Two lists
 * for one question is how "put them in a spreadsheet" ended up carrying a
 * google_sheets authority key while reporting NO destination: the authority
 * vocabulary knew the word and the destination vocabulary did not (live
 * 2026-07-31). Whether a destination is external is now a property of its key,
 * not of a duplicate regex that can drift away from it.
 */
function destinationFromText(text: string): string | undefined {
  for (const [key, pattern] of DESTINATION_RULES) {
    if (NON_EXTERNAL_DESTINATION_KEYS.has(key)) continue;
    const match = text.match(pattern);
    if (match?.[0]) return match[0].replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

/** Facts the compiled turn graph already proved about this exact source.
 *  When typed semantics participated, the graph's construct/count/destination
 *  are semantic classification, not regex guesses — preflight must consume
 *  them. Live 2026-08-18: the graph said collect_then_construct count=25
 *  destination=google_sheets while preflight's own regexes read "Find me…"
 *  as a read-only lead, so a 25-item half-hour run launched with no
 *  alignment beat. Null when no graph exists (regexes remain the fallback). */
export interface CompiledGraphPreflightFacts {
  construct: string;
  itemCount: number;
  destinationFamily?: string;
  destinationPosture?: string;
  externalEffectRequested: boolean;
  projection: readonly string[];
}

export function compiledGraphPreflightFacts(
  sessionId: string | undefined,
  sourceUserSeq: number | undefined,
): CompiledGraphPreflightFacts | null {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  try {
    const event = getTurnGraphEventForSource(sessionId, sourceUserSeq as number);
    const graph = turnGraphFromShadowEvent(event);
    if (!graph) return null;
    const classification = graph.classification;
    const goal = classification.goalConstraints;
    return {
      construct: goal?.construct ?? 'none',
      itemCount: classification.multiItem?.itemCount ?? goal?.collection?.count ?? 0,
      ...(goal?.destination?.family ? { destinationFamily: goal.destination.family } : {}),
      ...(goal?.destination?.posture ? { destinationPosture: goal.destination.posture } : {}),
      externalEffectRequested: classification.externalEffectRequested === true,
      projection: goal?.collection?.projection ?? [],
    };
  } catch {
    return null;
  }
}

/** Pure, typed preflight decision. Regexes contribute grammatical evidence;
 * they are not themselves authority. Session state and the persisted phase are
 * what the tool boundary ultimately consumes. */
export interface ClassifyTurnPreflightInput {
  message: string;
  sessionId?: string;
  sessionKind?: string;
  isMultiItem?: boolean;
  itemCount?: number;
  /** Typed host/memory evidence may close a material source choice without
   * asking again. Omit when no exact source strategy has been established. */
  sourceStrategyPosture?: TurnSourceStrategyPosture;
  /** Optional validated result of a provider-neutral source selector. */
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
  /** Exact accepted user event for this attempt. Avoids session-global
   *  "latest user" authority when a transport/fallback is racing. */
  sourceUserSeq?: number;
}

function classifyTurnPreflightInternal(
  input: ClassifyTurnPreflightInput,
  forceFreshMaterialSourceAlignment = false,
): TurnPreflightDecision {
  const text = (input.message ?? '').trim();
  if (input.sessionKind !== 'chat' || !input.sessionId) {
    return { phase: 'execute', consequential: false, reason: 'non_chat' };
  }
  if (!forceFreshMaterialSourceAlignment && !confirmBeatEnabled()) {
    return { phase: 'execute', consequential: false, reason: 'feature_disabled' };
  }
  const confirmationControl = isConfirmationControl(text);
  const pending = (confirmationControl || Boolean(validatedTurnSourceStrategyBinding(input.sourceStrategyBinding)))
    ? pendingAlignmentForCurrentInput(input.sessionId, input.sourceUserSeq, input.message)
    : null;
  const selectedPendingSourceBinding = pending && !confirmationControl
    ? selectedPendingMaterialSourceBinding(text, pending, input.sourceStrategyBinding)
    : null;
  if (
    pending
    && (confirmationControl
      || selectedPendingSourceBinding)
  ) {
      return {
        phase: 'execute',
        consequential: true,
        destination: pending.destination,
        confirmedIntentKey: pending.intentKey,
        objective: pending.objective,
        allowedMutationEffects: pending.allowedMutationEffects,
        allowedDestinations: pending.allowedDestinations,
        allowedActionFamilies: pending.allowedActionFamilies,
        sourceStrategyPosture: 'confirmed_exact',
        ...(selectedPendingSourceBinding ?? pending.sourceStrategyBinding
          ? { sourceStrategyBinding: selectedPendingSourceBinding ?? pending.sourceStrategyBinding }
          : {}),
        reason: 'continuation_approved',
      };
  }

  // Pre-authorized work never earns a beat: the user already handed it off.
  if (!forceFreshMaterialSourceAlignment && PRE_AUTHORIZED_RE.test(text)) {
    return { phase: 'execute', consequential: false, reason: 'pre_authorized' };
  }
  const signalText = positivePreflightSignalText(text);
  // The ask may follow its context, so test the whole message AND its clauses
  // against the same (unchanged, still `^`-anchored) patterns.
  const requestedAction = REQUESTED_ACTION_PATTERNS.some((pattern) => pattern.test(signalText.trim()))
    || requestClauses(signalText).some((clause) => REQUESTED_ACTION_PATTERNS.some((pattern) => pattern.test(clause)));
  const genericProviders = genericProviderAliasesFromObjective(signalText);
  const destination = destinationFromText(signalText) ?? genericProviders[0]?.replace(/^provider:/, '');
  const externalAction = requestedAction && (Boolean(destination) || EXTERNAL_ACTION_RE.test(signalText) || genericProviders.length > 0);
  const nounShapedArtifactRequest = Boolean(destination) && NOUN_SHAPED_REQUEST_RE.test(signalText);
  // The compiled graph is authority when it exists for this exact source —
  // typed semantic classification outranks this function's own regexes. The
  // text detectors remain the fallback for turns that never compiled a graph.
  const graphFacts = compiledGraphPreflightFacts(input.sessionId, input.sourceUserSeq);
  const collectThenConstruct = graphFacts
    ? graphFacts.construct === 'collect_then_construct'
    : detectMultiItemIntent(signalText).collectThenConstruct === true
      || compileAcceptedGoal({
        text: signalText,
        sourceUserSeq: input.sourceUserSeq,
        multiItem: detectMultiItemIntent(signalText),
      }).construct === 'collect_then_construct';
  const sourceStrategyBinding = validatedTurnSourceStrategyBinding(input.sourceStrategyBinding);
  const sourceStrategyPosture: TurnSourceStrategyPosture | undefined = forceFreshMaterialSourceAlignment
    ? 'materially_variant'
    : input.sourceStrategyPosture
    ?? (genericProviders.length > 0 || /\bhttps?:\/\/\S+/i.test(signalText)
      ? 'confirmed_exact'
      : sourceStrategyBinding
        ? 'materially_variant'
        : undefined);
  const graphDestination = graphFacts?.destinationFamily?.replace(/_/g, ' ');
  const authority = mutationAuthorityForObjective(
    signalText,
    externalAction || collectThenConstruct,
    nounShapedArtifactRequest || collectThenConstruct,
  );
  // The ADMITTED destination posture outranks verb sniffing: "add them to a
  // Google sheet" reads as 'update' from text alone, but a create_new
  // destination IS a create — the live 2026-08-19 preflight authorized only
  // ["update"] on a brand-new sheet and starved the create authority.
  if (graphFacts?.destinationPosture === 'create_new' && !(authority.allowedActionFamilies ?? []).includes('create')) {
    authority.allowedActionFamilies = [...(authority.allowedActionFamilies ?? []), 'create'];
  }
  // Item count alone is a parallelism hint, not a consequential action. Pure
  // research/computation should start; only a batch that actually carries
  // mutation authority earns the extra conversational alignment beat.
  const multiItemAction = (input.isMultiItem === true || (graphFacts?.itemCount ?? 0) >= 3)
    && ((input.itemCount ?? graphFacts?.itemCount ?? 0) >= 3)
    && (authority.allowedMutationEffects?.length ?? 0) > 0;

  // A counted set landing in one container is a construct, even when the
  // sentence opens with find/show. That is classification, not a stop:
  // align speaks the bound how, then autonomous execution continues.
  if (collectThenConstruct) {
    const alignDestination = destination ?? graphDestination;
    return {
      phase: 'align',
      consequential: true,
      destination: alignDestination,
      objective: text,
      intentKey: intentKeyFor(text, alignDestination),
      ...authority,
      ...(sourceStrategyPosture ? { sourceStrategyPosture } : {}),
      ...(sourceStrategyPosture === 'materially_variant'
        ? { confirmationDisposition: 'material_source_strategy' as const }
        : {}),
      ...(sourceStrategyBinding ? { sourceStrategyBinding } : {}),
      destinationInstanceUnstated: destinationInstanceUnstated(signalText, alignDestination),
      reason: 'collect_then_construct',
    };
  }
  // Interrogative/read leads win when the user did not grammatically ask
  // Clementine to perform an action. This keeps “what should I send?” and
  // “can Google Docs create tables?” immediate even though they contain
  // consequential nouns and verbs.
  if ((READ_ONLY_LEAD_RE.test(signalText.trim()) || (!requestedAction && /\?\s*$/.test(text))) && !requestedAction) {
    return { phase: 'read', consequential: false, destination, reason: 'read_only_request' };
  }
  if (hasExplicitValidationBlocker(text)) {
    return {
      phase: 'read',
      consequential: false,
      destination,
      objective: text,
      reason: 'validation_blocked',
    };
  }
  if (multiItemAction) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority,
      destinationInstanceUnstated: destinationInstanceUnstated(signalText, destination),
      reason: 'multi_item_action',
    };
  }
  if (externalAction) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority,
      destinationInstanceUnstated: destinationInstanceUnstated(signalText, destination),
      reason: 'external_action',
    };
  }
  if (nounShapedArtifactRequest) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority,
      destinationInstanceUnstated: destinationInstanceUnstated(signalText, destination),
      reason: 'noun_shaped_artifact_request',
    };
  }
  return { phase: 'execute', consequential: false, destination, reason: 'ordinary_execution' };
}

export function classifyTurnPreflight(
  input: ClassifyTurnPreflightInput,
): TurnPreflightDecision {
  return classifyTurnPreflightInternal(input);
}

/** Host-owned fresh source alignment ignores the conversational beat kill
 * switch and pre-authorization shortcut: neither can grant source authority.
 * It always returns a non-authorizing material posture from exact accepted
 * text plus a selector-owned binding, ready for the formal durable A/Q/B beat. */
export function classifyFreshMaterialSourcePreflight(
  input: Omit<ClassifyTurnPreflightInput, 'sourceStrategyPosture'>,
): TurnPreflightDecision {
  return classifyTurnPreflightInternal(input, true);
}

// ─── Close-the-loop completion nudge (2026-07-30, live miss) ────────────────
// A completed chat reply that lands on a RECOMMENDATION with no question and
// no offer strands the decision with the user: they got a great answer and
// still have to carry the "so… do it?" back themselves. Deterministic trigger,
// model-owned phrasing: code only detects the shape (conservative markers, so
// false negatives are fine — this is a nudge, not a gate) and asks the model
// to close the loop in its own words; the model may return the reply unchanged
// when a closing question genuinely doesn't fit.
const RECOMMENDATION_MARKER_RE =
  /\b(?:best\s+(?:setup|route|approach|option|bet)\b|i(?:['’]d|\s+would)\s+recommend|i\s+recommend|my\s+recommendation|the\s+better\s+(?:route|approach|option|path)\b|you\s+should\s+(?:use|go\s+with))/i;
const DECISION_OFFER_RE =
  /\b(?:want\s+me\s+to|shall\s+i|should\s+i|i\s+can\s+(?:set|build|do|run|start|pull|create|kick)|say\s+the\s+word|let\s+me\s+know\s+(?:if|which|when)|if\s+you(?:['’]d|\s+would)?\s*like,?\s+i|happy\s+to\s+(?:set|build|do|run|start))\b/i;

export function closeTheLoopNudge(reply: string | null | undefined): string | null {
  const text = (reply ?? '').trim();
  if (!text || text.includes('?')) return null;
  if (!RECOMMENDATION_MARKER_RE.test(text)) return null;
  if (DECISION_OFFER_RE.test(text)) return null;
  return '[close-the-loop] Your reply lands on a recommendation but never asks the user what they want done with it — the decision is left sitting on the table. Re-state your final reply, closing with the concrete next step you would take and ONE direct question offering to do it, phrased in your own words. If a closing question genuinely does not fit this reply, re-state it unchanged.';
}

/**
 * Default ON. This shipped default-OFF and therefore never once fired: every
 * chat turn recorded `feature_disabled`, so the alignment layer existed in code
 * and not in the product. Measured on the owner's real 207-message chat corpus,
 * the beat lands on roughly one message in eleven — and only on substantial
 * action requests. A rollout flag on validated behavior is exactly the pattern
 * the project forbids; `off` survives as an operator kill-switch.
 */
export function confirmBeatEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CONFIRM_BEAT', 'on') ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * Standard-aware beat. The generic beat asks about plan and destination; what
 * actually determines whether a deliverable is RIGHT is the standard governing
 * it — and that standard is per-user, invisible, and silently absent (a user
 * with no outbound standard gets improvised emails and reads it as the model
 * being sloppy). So the beat says which standard is in force, or, when none is,
 * asks the ONE question that defines it and captures the answer. It gets
 * quieter over time by construction: every answered question becomes a standard
 * that never needs asking again.
 */
export function standardAwareBeatText(request: string): string {
  let proven = '';
  try {
    // Imported lazily: turn-control is on the hot path for every turn, and the
    // standard lookup only matters on the rare turn that earns a beat.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    proven = requireProvenStandardLine(request);
  } catch { proven = ''; }
  if (proven) return `${CONFIRM_BEAT_TEXT}\n${proven}`;
  return `${CONFIRM_BEAT_TEXT}\n`
    + '[standard] No proven standard governs this kind of work yet. If HOW the output should look is at all open '
    + '(format, personalization, tone, which fields), ask that ONE question in your beat — it is the question that '
    + 'decides whether the result is usable. Once they answer, remember it so this is never asked again.';
}

/** Indirection kept tiny so the memory layer is not imported on every turn. */
let provenStandardLineImpl: ((request: string) => string) | null = null;
export function setProvenStandardLineForTest(fn: ((request: string) => string) | null): void {
  provenStandardLineImpl = fn;
}
function requireProvenStandardLine(request: string): string {
  if (provenStandardLineImpl) return provenStandardLineImpl(request);
  return '';
}
/** Wired at startup by the memory layer so turn-control stays dependency-free. */
export function bindProvenStandardLine(fn: (request: string) => string): void {
  provenStandardLineImpl = fn;
}

/**
 * The beat is a CONVERSATION, not a status report. The earlier wording asked for
 * a 2–3 line plan summary plus the connection name plus a background note, which
 * produces a small briefing document — the opposite of the owner's stated ideal:
 * "sure, I'll search Salesforce for Brett's prospecting today — or did you want
 * something else?" A heavy beat is worse than none, because it adds ceremony to
 * every substantial request and trains the user to skim past it.
 *
 * This is a DIRECTIVE about shape and intent, never a script to parrot: it says
 * what the beat must accomplish (state the reading, invite the correction) and
 * what it must not become (a plan card, a checklist), and leaves the wording to
 * the model.
 */
export const CONFIRM_BEAT_TEXT =
  '[pre-execution alignment] This request is consequential. A separate openness pass has already decided whether a load-bearing value is missing; this execution path is reached only when that judgment is settled.\n'
  + 'Your context above already contains what you know: the capability resolution (which connections, tools, and proven procedures THIS ask can rely on) and your recalled memory. Use them — do not fetch more first.\n'
  + 'A brief conversational reading may already have been shown to the user for this exact source. Do not repeat it, produce a plan card, or ask for generic permission to begin. Proceed with the requested work in this same turn.\n'
  + 'If execution discovers a genuinely new load-bearing fact that the preflight context could not have known, use the ordinary clarification boundary once. Existing approval and external-write authority still govern irreversible actions; never widen them from this directive.';

/** Directive for a fresh execution-shaped chat turn, or null. Pure over its
 *  inputs plus one point read (prior completed turns); never throws. */
export function confirmBeatDirective(input: {
  message: string;
  sessionId?: string;
  sessionKind?: string;
  isMultiItem?: boolean;
  itemCount?: number;
  sourceStrategyPosture?: TurnSourceStrategyPosture;
  sourceUserSeq?: number;
}): string | null {
  try {
    const decision = classifyTurnPreflight(input);
    if (decision.phase !== 'align') return null;
    const beat = standardAwareBeatText(input.message);
    return decision.destinationInstanceUnstated && decision.destination
      ? `${beat}\n${unstatedDestinationBeatLine(decision.destination)}`
      : beat;
  } catch { return null; }
}

export interface TurnPreflightPersistenceIo {
  list: typeof listEvents;
  append: typeof appendEvent;
}

const DEFAULT_TURN_PREFLIGHT_IO: TurnPreflightPersistenceIo = {
  list: listEvents,
  append: appendEvent,
};

function exactPreflightSource(sourceUserSeq: number | undefined): number | null {
  return Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
    ? sourceUserSeq as number
    : null;
}

/** Persist one preflight decision for the latest user turn. Idempotent across
 * context builders (the Codex packet and Claude brain can both consult it). */
export function recordTurnPreflightDecision(
  sessionId: string | undefined,
  decision: TurnPreflightDecision,
  sourceUserSeq?: number,
  io: TurnPreflightPersistenceIo = DEFAULT_TURN_PREFLIGHT_IO,
): void {
  if (!sessionId) return;
  let exactSourceUserSeq = exactPreflightSource(sourceUserSeq) ?? undefined;
  try {
    const rows = io.list(sessionId, { types: ['user_input_received', 'turn_preflight_decision'] });
    exactSourceUserSeq ??= latestUserSeq(rows) || undefined;
    const alreadyRecorded = rows.some((row) => {
      if (row.type !== 'turn_preflight_decision') return false;
      const data = row.data as unknown as TurnPreflightDecision & { sourceUserSeq?: number };
      return data.sourceUserSeq === exactSourceUserSeq
        && turnPreflightDecisionsEqual(data, decision);
    });
    if (!alreadyRecorded) {
      io.append({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'turn_preflight_decision',
        data: { ...decision, sourceUserSeq: exactSourceUserSeq },
      });
    }
  } catch { /* telemetry/anchoring state — a failed persist must never break the turn */ }
}

// NOTE (fold, 2026-07-17): the old per-tool `preflightGateVerdict` boundary was
// DEMOTED after adversarial workflow review
// confirmed it failed in both directions — bypassable (delegating carriers
// dispatch native-MCP writes past it, non-exact acknowledgements skip the
// envelope, interpreter shell scripts classify as compute) while hard-denying
// approved work (empty destination/action envelopes deny-all with no recovery,
// and the align phase blocked even reads). The replacement is not another
// per-tool consent gate: a typed chat `align` source now commits a model-authored
// needs-input terminal before the ordinary tool-capable brain runs. Existing
// plan-scope/approval authority still governs execution after that conversation.

// ── one-release legacy alignment reader ─────────────────────────────────────
// Clementine 3.6/3.7 briefly persisted `intentKey`-shaped preflight rows
// while the beat itself was removed. Keep this read-only decoder so an
// in-flight upgrade can still interpret the user's immediately-following
// acknowledgement of one of those legacy alignments.
const LEGACY_CONFIRM_CONTROLS: ReadonlySet<string> = new Set([
  'approve', 'approved', 'yes', 'yep', 'yeah', 'y', 'ok', 'okay',
  'go', 'go ahead', 'proceed', 'continue', 'resume',
]);

function normalizedLegacyControl(text: string): string {
  return text.trim().toLowerCase().replace(/[.!]+$/g, '').replace(/\s+/g, ' ');
}

interface LegacyAlignmentDecision {
  phase?: unknown;
  objective?: unknown;
  sourceUserSeq?: unknown;
}

function legacyAlignedObjectiveForAcknowledgement(
  sessionId: string,
  acknowledgement: string,
  sourceUserSeq: number | undefined,
): string | null {
  const normalizedAcknowledgement = normalizedLegacyControl(acknowledgement);
  if (!LEGACY_CONFIRM_CONTROLS.has(normalizedAcknowledgement)) return null;
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received', 'turn_preflight_decision'] });
    const users = rows
      .filter((row) => row.type === 'user_input_received')
      .filter((row) => (row.data as { synthetic?: boolean } | undefined)?.synthetic !== true)
      .sort((a, b) => a.seq - b.seq);
    const currentIndex = users.findIndex((row) => row.seq === sourceUserSeq);
    if (currentIndex <= 0) return null;
    const currentText = (users[currentIndex]?.data as { text?: unknown } | undefined)?.text;
    if (
      typeof currentText !== 'string'
      || normalizedLegacyControl(currentText) !== normalizedAcknowledgement
    ) return null;
    const previousUserSeq = users[currentIndex - 1]?.seq;
    if (!previousUserSeq) return null;
    const legacyAlignment = rows
      .filter((row) => row.type === 'turn_preflight_decision')
      .filter((row) => (row.data as LegacyAlignmentDecision).sourceUserSeq === previousUserSeq)
      .sort((a, b) => b.seq - a.seq)
      .map((row) => row.data as LegacyAlignmentDecision)
      .find((decision) => decision.phase === 'align');
    const objective = typeof legacyAlignment?.objective === 'string'
      ? legacyAlignment.objective.trim()
      : '';
    return objective || null;
  } catch {
    return null;
  }
}

/** Recover the aligned objective for an acknowledgement turn. This keeps
 * artifact identity and completion judging anchored to "create two docs", not
 * to the low-information control message "go ahead". */
export function effectiveTurnObjective(
  sessionId: string | undefined,
  fallback: string,
  sourceUserSeq?: number,
): string {
  if (!sessionId) return fallback;
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received', 'turn_preflight_decision'] });
    const exactSourceUserSeq = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? sourceUserSeq as number
      : latestUserSeq(rows);
    // An explicit answer to a material clarification (for example, “Use
    // Apify as the restaurant source”) is not one of the tiny legacy control
    // words handled below, but its durable graph has already verified the
    // exact A/Q/B packet and recorded whether B inherits A. Recover the parent
    // objective only from that hash-validated graph lineage; caller-supplied
    // continuation fields alone can never widen completion/artifact authority.
    const graphEvent = getTurnGraphEventForSource(sessionId, exactSourceUserSeq);
    if (turnGraphFromShadowEvent(graphEvent)) {
      const lineage = graphEvent?.data.taskContinuationLineage as Record<string, unknown> | undefined;
      const disposition = lineage?.disposition;
      const parentSourceUserSeq = lineage?.parentSourceUserSeq;
      if (
        lineage?.consumingSourceUserSeq === exactSourceUserSeq
        && (disposition === 'affirmed' || disposition === 'selected' || disposition === 'provided')
        && typeof parentSourceUserSeq === 'number'
        && Number.isSafeInteger(parentSourceUserSeq)
        && parentSourceUserSeq > 0
      ) {
        const parent = rows.find((row) => row.type === 'user_input_received' && row.seq === parentSourceUserSeq);
        const parentText = typeof parent?.data.displayText === 'string' && parent.data.displayText.trim()
          ? parent.data.displayText.trim()
          : typeof parent?.data.text === 'string'
            ? parent.data.text.trim()
            : '';
        if (parentText) return parentText;
      }
    }
    const decision = decisionForSource(sessionId, rows, exactSourceUserSeq);
    if (decision?.phase === 'execute' && decision.confirmedIntentKey) {
      const aligned = alignedDecisionForIntent(rows, decision.confirmedIntentKey);
      if (aligned?.objective?.trim()) return aligned.objective.trim();
    }
    // One-release compat: an acknowledgement of a v3.6/3.7 legacy alignment
    // row still recovers its objective.
    const legacy = legacyAlignedObjectiveForAcknowledgement(sessionId, fallback, exactSourceUserSeq);
    if (legacy) return legacy;
  } catch { /* fallback remains authoritative */ }
  return fallback;
}
