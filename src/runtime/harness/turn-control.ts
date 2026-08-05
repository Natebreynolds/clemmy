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
import { isKillRequested, appendEvent, getSession, listEvents, type KillRequestTarget } from './eventlog.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import { checkRunTokenWindow, type RunTokenWindow, type RunTokenStatus } from './run-token-budget.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import { getRuntimeEnv } from '../../config.js';

// The SDK's PermissionResult shape (structural — avoids importing SDK types here).
export interface ToolGateDeny {
  behavior: 'deny';
  message: string;
  interrupt: boolean;
  /** True when this deny is the fanout refuse-and-steer (its recovery text
   *  references run_tool_program — callers without that tool skip it). */
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
    /** The caller's recovery skeleton has run_tool_program, so the fanout
     *  refuse-and-steer is actionable. When false the fanout branch is a
     *  silent allow — no deny AND no guardrail_tripped event (review
     *  Turn-control review: emitting a discarded verdict fills the operator view
     *  with trips that never happened). */
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
      return {
        behavior: 'deny',
        interrupt: false,
        message: `Guardrail ${decision.action} (${decision.reason}): ${strippedToolName} has repeated too many times this turn — change approach (fan out with run_worker, or batch the reads with run_tool_program) instead of retrying one at a time.`,
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
type ConfirmedMutationEffect = Extract<RuntimeToolEffect, 'local_write' | 'external_write' | 'admin'>;
type ConfirmedActionFamily = 'create' | 'update' | 'delete' | 'send' | 'publish' | 'schedule' | 'upload' | 'commit' | 'merge' | 'import' | 'export' | 'sync' | 'configure';

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

function decisionAuthoritySignature(decision: TurnPreflightDecision): string {
  return JSON.stringify({
    phase: decision.phase,
    consequential: decision.consequential,
    destination: decision.destination,
    intentKey: decision.intentKey,
    confirmedIntentKey: decision.confirmedIntentKey,
    objective: decision.objective,
    reason: decision.reason,
    allowedMutationEffects: [...(decision.allowedMutationEffects ?? [])].sort(),
    allowedDestinations: [...(decision.allowedDestinations ?? [])].sort(),
    allowedActionFamilies: [...(decision.allowedActionFamilies ?? [])].sort(),
  });
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
 * request and only when that request has a durable `align` decision. An old
 * completed turn or an older alignment cannot grant permanent execution. */
function pendingAlignmentForCurrentInput(
  sessionId: string,
  sourceUserSeq?: number,
): TurnPreflightDecision | null {
  try {
    const rows = listEvents(sessionId, { types: ['user_input_received', 'turn_preflight_decision'] });
    const users = rows.filter((row) => row.type === 'user_input_received');
    const currentIndex = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? users.findIndex((row) => row.seq === sourceUserSeq)
      : users.length - 1;
    const previousUser = currentIndex > 0 ? users[currentIndex - 1] : undefined;
    if (!previousUser) return null;
    const decision = decisionForSource(sessionId, rows, previousUser.seq);
    return decision?.phase === 'align' && typeof decision.intentKey === 'string' && decision.intentKey
      ? decision
      : null;
  } catch {
    return null;
  }
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

/** Pure, typed preflight decision. Regexes contribute grammatical evidence;
 * they are not themselves authority. Session state and the persisted phase are
 * what the tool boundary ultimately consumes. */
export function classifyTurnPreflight(input: {
  message: string;
  sessionId?: string;
  sessionKind?: string;
  isMultiItem?: boolean;
  itemCount?: number;
  /** Exact accepted user event for this attempt. Avoids session-global
   *  "latest user" authority when a transport/fallback is racing. */
  sourceUserSeq?: number;
}): TurnPreflightDecision {
  const text = (input.message ?? '').trim();
  if (input.sessionKind !== 'chat' || !input.sessionId) {
    return { phase: 'execute', consequential: false, reason: 'non_chat' };
  }
  if (!confirmBeatEnabled()) {
    return { phase: 'execute', consequential: false, reason: 'feature_disabled' };
  }
  if (isConfirmationControl(text)) {
    const pending = pendingAlignmentForCurrentInput(input.sessionId, input.sourceUserSeq);
    if (pending) {
      return {
        phase: 'execute',
        consequential: true,
        destination: pending.destination,
        confirmedIntentKey: pending.intentKey,
        objective: pending.objective,
        allowedMutationEffects: pending.allowedMutationEffects,
        allowedDestinations: pending.allowedDestinations,
        allowedActionFamilies: pending.allowedActionFamilies,
        reason: 'continuation_approved',
      };
    }
  }

  // Pre-authorized work never earns a beat: the user already handed it off.
  if (PRE_AUTHORIZED_RE.test(text)) {
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
  const authority = mutationAuthorityForObjective(signalText, externalAction, nounShapedArtifactRequest);
  // Item count alone is a parallelism hint, not a consequential action. Pure
  // research/computation should start; only a batch that actually carries
  // mutation authority earns the extra conversational alignment beat.
  const multiItemAction = input.isMultiItem === true
    && (input.itemCount ?? 0) >= 3
    && (authority.allowedMutationEffects?.length ?? 0) > 0;

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
  '[confirm-first] Before doing the work, take ONE short conversational beat in your own words — a sentence or two, the way a colleague checks they understood before starting. '
  + 'Say how you are reading the request and which source or tool you would use, and invite a correction. '
  + 'Do NOT produce a plan summary, a checklist, or a bulleted proposal — that is a plan card, not a conversation. '
  + 'If the work may run for several minutes, say you will pick it up in the background and report back here. '
  + 'Do not call tools yet: wait for the go-ahead, then do the whole thing without asking again. Skip the beat entirely if the request is actually read-only.';

/** Directive for a fresh execution-shaped chat turn, or null. Pure over its
 *  inputs plus one point read (prior completed turns); never throws. */
export function confirmBeatDirective(input: {
  message: string;
  sessionId?: string;
  sessionKind?: string;
  isMultiItem?: boolean;
  itemCount?: number;
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
        && decisionAuthoritySignature(data) === decisionAuthoritySignature(decision);
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

// NOTE (fold, 2026-07-17): the fail-closed `preflightGateVerdict` tool-boundary
// gate that lived here was DEMOTED after adversarial workflow review
// confirmed it failed in both directions — bypassable (delegating carriers
// dispatch native-MCP writes past it, non-exact acknowledgements skip the
// envelope, interpreter shell scripts classify as compute) while hard-denying
// approved work (empty destination/action envelopes deny-all with no recovery,
// and the align phase blocked even reads). Alignment is delivered as the
// conversational [confirm-first] directive (confirmBeatDirective) with the
// typed decision persisted for telemetry/objective anchoring; CONSENT
// enforcement stays with the one existing authority — plan-scope /
// isAutoApprovedByScope and the approval registry (guardrails inform, they
// don't override).

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
