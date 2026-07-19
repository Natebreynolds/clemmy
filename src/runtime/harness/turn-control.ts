/**
 * TURN-CONTROL SPINE — the lane-agnostic deterministic controls, in ONE place.
 *
 * Born from the 2026-07-16 unkillable-run incident: a 33-minute runaway chat
 * turn on the Claude SDK brain lane (the DEFAULT brain) had no working kill
 * switch, no confirm beat, no background offer, and ignored 15 grind
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

// ── background offer (policy 2026-07-16: always offer on long execution) ────

/** The nudge graduates to default ON (validated behavior; the incident's run
 *  got no offer partly because this flag sat default-off). */
export function backgroundOfferEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_BG_OFFER_NUDGE', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export const BACKGROUND_OFFER_MIN_TOOLS = 6;
export const BACKGROUND_OFFER_MIN_ELAPSED_MS = 90_000;

/** Pure trigger both lanes share: a chat-session execution grind that has
 *  either racked up tool calls or wall-clock deserves the one-shot offer. */
export function shouldOfferBackground(input: {
  sessionId: string;
  sessionKind?: string;
  toolCalls: number;
  elapsedMs: number;
  alreadyNudged: boolean;
  suppressed?: boolean;
}): boolean {
  if (!backgroundOfferEnabled()) return false;
  if (input.alreadyNudged || input.suppressed) return false;
  if (input.sessionId.startsWith('background:')) return false;
  const kind = input.sessionKind ?? (() => {
    try { return getSession(input.sessionId)?.kind; } catch { return undefined; }
  })();
  if (kind !== 'chat') return false;
  return input.toolCalls >= BACKGROUND_OFFER_MIN_TOOLS
    || input.elapsedMs >= BACKGROUND_OFFER_MIN_ELAPSED_MS;
}

// ── confirm beat (policy 2026-07-16: "shovel before driving over") ──────────
// "If I asked a friend to help me dig a hole and they just blindly drove to my
// house without a shovel it would be a waste of time." A FRESH chat request
// that is execution-shaped gets ONE conversational beat — confirm the plan,
// surface missing tools/connections, offer background — before the work
// starts. Delivered as a directive in the agent context packet (both lanes
// read it), NOT a formal plan card: the 2026-06-01 converse-until-aligned
// rollback stands — the model converses, the trigger is deterministic.

// Confirmation is based on a typed turn decision, not a write-ish word anywhere
// in the sentence. The structural patterns below are inputs to that decision,
// alongside session state, destination shape, multi-item intent, and explicit
// continuation controls. Persisting the typed result lets the tool boundary
// enforce it; a model cannot bypass alignment by ignoring prompt prose.
const REQUEST_ACTION =
  '(send|post|publish|deploy|host|notify|email|message|draft|create|update|upload|submit|schedule|dispatch|delete|remove|commit|push|merge|migrate|import|export|sync|build|write|prepare|research|analy[sz]e|collect|pull|gather|design|make|generate|convert|turn|transform|put|save|fill|add)';
const REQUEST_ASSIST_PREFIX = '(?:(?:try|attempt)\\s+to\\s+|help\\s+me\\s+(?:to\\s+)?)?';
const REQUESTED_ACTION_PATTERNS = [
  new RegExp(`^(?:please\\s+)?${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^i\\s+(?:need|want|would\\s+like)(?:\\s+for)?\\s+(?:you\\s+)?to\\s+${REQUEST_ASSIST_PREFIX}${REQUEST_ACTION}\\b`, 'i'),
  new RegExp(`^let(?:'s|\\s+us)\\s+${REQUEST_ACTION}\\b`, 'i'),
] as const;
const EXTERNAL_ACTION_RE =
  /\b(?:send|post|publish|deploy|host|notify|email|upload|submit|schedule|dispatch|delete|push|merge|migrate|sync)\b|\b(?:create|update|remove|import|export|draft|write|prepare|make|generate|build|design|convert)\b[^.!?\n]{0,50}\b(?:google\s+docs?|documents?|sites?|website|calendar|event|email|message|record|crm|sheets?|drive|notion|slack|teams|outlook|github|netlify)\b/i;
const CONFIRM_CONTROLS = new Set([
  'approve', 'approved', 'yes', 'yep', 'yeah', 'y', 'ok', 'okay',
  'go', 'go ahead', 'proceed', 'continue', 'resume',
]);
const READ_ONLY_LEAD_RE =
  /^(?:what|why|how|when|where|who|which|tell me|show me|check|look at|find|search|summarize|review|explain|compare|inspect|read|list|get)\b/i;
const EXTERNAL_DESTINATION_RE =
  /\b(?:google\s+(?:docs?|documents?|sheets?|drive)|netlify|vercel|railway|website|web\s*site|calendar|outlook|gmail|emails?|messages?|salesforce|crm|notion|slack|teams|github|pull request)\b/i;
const NOUN_SHAPED_REQUEST_RE =
  /\b(?:google\s+(?:docs?|documents?|sheets?)|website|web\s*site|calendar\s+event|email\s+draft|pull request)\b[^.!?\n]{0,100}\b(?:would\s+be|would\s+help|sounds?|please|for\s+me|i(?:'d|\s+would)\s+like)\b/i;

export type TurnPreflightPhase = 'read' | 'align' | 'execute';
type ConfirmedMutationEffect = Extract<RuntimeToolEffect, 'local_write' | 'external_write' | 'admin'>;
type ConfirmedActionFamily = 'create' | 'update' | 'delete' | 'send' | 'publish' | 'schedule' | 'upload' | 'commit' | 'merge' | 'import' | 'export' | 'sync' | 'configure';

export interface TurnPreflightDecision {
  phase: TurnPreflightPhase;
  consequential: boolean;
  destination?: string;
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
    | 'continuation_approved'
    | 'already_aligned_session'
    | 'read_only_request'
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

const DESTINATION_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['google_docs', /\b(?:google\s*docs?|googledocs|google\s+document)\b/i],
  ['google_sheets', /\b(?:google\s*sheets?|googlesheets|spreadsheet)\b/i],
  ['google_drive', /\b(?:google\s*drive|gdrive)\b/i],
  ['email', /\b(?:e-?mail|gmail|outlook|mail)\b/i],
  ['calendar', /\b(?:calendar|meeting|event)\b/i],
  ['website', /\b(?:website|web\s*site|netlify|vercel|railway|deploy|publish|host)\b/i],
  ['github', /\b(?:github|pull\s*request|git\s+push|push\s+it)\b/i],
  ['slack', /\bslack\b/i],
  ['teams', /\b(?:microsoft\s+teams|teams)\b/i],
  ['notion', /\bnotion\b/i],
  ['crm', /\b(?:crm|salesforce|hubspot)\b/i],
  ['messages', /\b(?:message|sms|text\s+message|discord)\b/i],
  ['documents', /\b(?:document|\bdoc\b|word\s+file)\b/i],
  ['local', /\b(?:local|workspace|repository|\brepo\b|source\s+file|codebase|filesystem)\b/i],
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
    /\b(?:in|on|via|using|through)\s+([A-Za-z][A-Za-z0-9.-]{1,30})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const alias = normalizeProviderAlias(match[1] ?? '');
      if (alias && !GENERIC_PROVIDER_STOPWORDS.has(alias)) aliases.push(`provider:${alias}`);
    }
  }
  return [...new Set(aliases)];
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
      ? /(?:^|\b(?:you|to|then|and)\s+)(?:please\s+)?(?:email|message)\b/i.test(normalized.trim())
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

function destinationFromText(text: string): string | undefined {
  return text.match(EXTERNAL_DESTINATION_RE)?.[0]?.replace(/\s+/g, ' ').trim();
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

  const requestedAction = REQUESTED_ACTION_PATTERNS.some((pattern) => pattern.test(text));
  const genericProviders = genericProviderAliasesFromObjective(text);
  const destination = destinationFromText(text) ?? genericProviders[0]?.replace(/^provider:/, '');
  const externalAction = requestedAction && (Boolean(destination) || EXTERNAL_ACTION_RE.test(text) || genericProviders.length > 0);
  const multiItemAction = input.isMultiItem === true && (input.itemCount ?? 0) >= 3;
  const nounShapedArtifactRequest = Boolean(destination) && NOUN_SHAPED_REQUEST_RE.test(text);
  const authority = mutationAuthorityForObjective(text, externalAction, nounShapedArtifactRequest);

  // Interrogative/read leads win when the user did not grammatically ask
  // Clementine to perform an action. This keeps “what should I send?” and
  // “can Google Docs create tables?” immediate even though they contain
  // consequential nouns and verbs.
  if ((READ_ONLY_LEAD_RE.test(text) || (!requestedAction && /\?\s*$/.test(text))) && !requestedAction) {
    return { phase: 'read', consequential: false, destination, reason: 'read_only_request' };
  }
  if (multiItemAction) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority, reason: 'multi_item_action',
    };
  }
  if (externalAction) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority, reason: 'external_action',
    };
  }
  if (nounShapedArtifactRequest) {
    return {
      phase: 'align', consequential: true, destination, objective: text,
      intentKey: intentKeyFor(text, destination), ...authority, reason: 'noun_shaped_artifact_request',
    };
  }
  return { phase: 'execute', consequential: false, destination, reason: 'ordinary_execution' };
}

export function confirmBeatEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_CONFIRM_BEAT', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

export const CONFIRM_BEAT_TEXT =
  '[confirm-first] Before executing, take one brief alignment beat: summarize the plan and destination in 2–3 lines, name the connection/capability you expect to use, and mention background execution if this may take several minutes. '
  + 'Do not call tools yet. Wait for the user’s go-ahead; then verify the connection and execute without asking again. Skip this only if the request is actually read-only.';

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
    return classifyTurnPreflight(input).phase === 'align' ? CONFIRM_BEAT_TEXT : null;
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
  } catch { /* fallback remains authoritative */ }
  return fallback;
}

export const BACKGROUND_OFFER_TEXT =
  '[background offer] This is turning into a long run while the user waits in the foreground. '
  + 'If finishing needs more than a step or two, offer the user a background handoff NOW: '
  + 'if the `offer_background` tool is available to you, call it with a one-line summary of the remaining work; '
  + 'otherwise END your reply by asking whether to (a) run the rest in the background, (b) hold it for later, or (c) keep going here. '
  + 'Then STOP and wait — do not keep grinding in the foreground. '
  + 'If you are genuinely a step or two from done, just finish; do not offer.';
