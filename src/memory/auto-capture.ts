import type { ConsolidatedFactKind } from './db.js';
import type { ConsolidatedFact } from './facts.js';
import { drainDurableConsolidationCandidates, enqueueAutoCaptureCandidates } from './durable-consolidation.js';
import { extractNamedResource } from './focus.js';
import { saveUserProfile, type UserProfile } from '../runtime/user-profile.js';
import { getRuntimeEnv } from '../config.js';
import { isHarnessInjectedInput } from '../runtime/harness/objective-judge.js';
import pino from 'pino';

/** Defense-in-depth (2026-06-23): auto-memory must learn only from REAL user
 *  messages — never from harness/judge/stall/grounding/outcome re-prompts that
 *  the loop records as user_input_received. Those were being stored as pinned
 *  "Standing prohibition" facts injected into every chat + voice prompt. Kill
 *  switch (default on); =off restores the old always-capture behavior. */
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
  profilePatch?: Record<string, unknown>;
  profile?: UserProfile;
}

const PROJECT_TERMS = /\b(clementine|clemmy|agent|assistant|dashboard|discord|composio|memory|workflow|autonom(?:y|ous)|setup|install|mcp|oauth|keychain|electron|tooling|project)\b/i;
const PROJECT_REQUIREMENT_CUES = /\b(should|needs?|must|has to|have to|main goal|north star|goal|i want|i need|we need|make sure|be able to|easy to|full autonomous|proactive|persistent|long-running|long lasting)\b/i;
const FEEDBACK_CUES = /\b(i (?:do not|don'?t) like|i hate|i would rather|i prefer|instead of|from now on|please (?:always|never|don'?t|do not)|\balways\b|\bnever\b|\btoo noisy\b|\bnot helpful\b)\b/i;
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
const ONE_OFF_TASK_SAFETY_RE = /\b(?:read[- ]only|smoke(?:\s+test)?|live\s+smoke|stress\s+test|draft\s+only|just\s+draft|after the tool returns)\b/i;
const ONE_OFF_TASK_START_RE = /^\s*(?:hey\s+)?(?:can you|please|check|pull|draft|write|create|build|run|call|use|using|find|list|research|mock up|take|read|author)\b/i;
const ONE_OFF_VALIDATION_RE = /\b(?:live\s+validation(?:\s+only)?|validation\s+only|live\s+read[- ]only\s+validation|read[- ]only\s+live\s+validation|read[- ]only\s+validation\s+after|live\s+validation\s+after|live\s+(?:local\s+)?safety\s+validation|(?:this\s+is\s+(?:a\s+)?)?(?:live|read[- ]only|local|safety)\s+diagnostic(?:\s+(?:only|probe|run|test))?|diagnostic\s+(?:only|probe|run|test))\b/i;
const MEMORY_CAPTURE_OPTOUT_RE = /\b(?:do\s+not|don'?t|do n'?t)\s+(?:(?:save|store|remember|capture|persist)\s+(?:this|it|that|the request|this request)?\s*(?:as|to|in)?\s*(?:a\s+)?(?:memory|durable memory|long[- ]term memory)?|(?:write(?:\s+to)?|change|modify|update)\s+(?:my\s+|the\s+|any\s+)?(?:memory|durable memory|long[- ]term memory))\b/i;
const MUST_CALL_TOOL_RE = /\byou\s+must\s+call\s+\w+/i;
const DO_NOT_CALL_TOOL_RE = /\bdo\s+not\s+call\s+\w+/i;
const NO_EXTERNAL_CHANGES_RE = /\bdo\s+not\s+make\s+any\s+external\s+changes\b/i;
const ONE_OFF_CONNECTED_APP_LOOKUP_START_RE = /^\s*(?:hey\s+)?(?:can you|could you|please|check|pull|read|show|tell me|look|find|list|summari[sz]e|what(?:'s| is)?|do i have|any(?:thing)?)\b/i;
const ONE_OFF_CONNECTED_APP_LOOKUP_CONTEXT_RE = /\b(?:today|tomorrow|tmrw|tmr|yesterday|right now|currently|this (?:morning|afternoon|week|month)|next (?:day|week)|calendar|inbox|e-?mail|messages?|meetings?|events?|unread|connected|connection|connections|accounts?|usable|stale|available)\b/i;

function hasDirectSafetyProhibition(text: string): boolean {
  return HARD_PROHIBITION_RE.test(text) || NEGATED_ACTION_RE.test(text);
}

function isOneOffTaskSafetyInstruction(text: string): boolean {
  if (!hasDirectSafetyProhibition(text)) return false;
  if (ONE_OFF_TASK_SAFETY_RE.test(text)) return true;
  return ONE_OFF_TASK_START_RE.test(text) && /\b(?:today|tomorrow|this request|this run|this turn|just|only)\b/i.test(text);
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
    && !isOneOffTaskSafetyInstruction(text);
}

// Standing-rule capture — a durable "going forward / every Monday / by default"
// instruction that should PERSIST ACROSS SESSIONS (routed to the facts vault),
// as opposed to a one-off action (handled by the session-scoped Active Task pin
// in working-memory.ts). "always" / "never" / "from now on" are DELIBERATELY
// OMITTED: they already match FEEDBACK_CUES above and are captured today, so the
// length-gated branch below would never run for them. This marker set fills only
// the gap those cues miss. A marker alone is not enough — an imperative verb AND
// a concrete target are also required (see hasConcreteStandingTarget).
const STANDING_MARKER_RE = /\b(?:from here on(?: out)?|going forward|by default|as a rule|every (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|whenever)\b/i;
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
  return value
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
    .slice(0, maxChars);
}

function addCandidate(candidates: AutoMemoryCandidate[], candidate: AutoMemoryCandidate): void {
  const content = clean(candidate.content);
  if (!content || content.length < 12) return;
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

export function extractAutoMemoryCandidates(message: string, maxCandidates = 3): AutoMemoryCandidate[] {
  const text = clean(message, 900);
  if (!text || LOW_SIGNAL.test(text)) return [];
  // Don't fold a pasted workflow definition into facts (it pollutes the store
  // and duplicates the workflow store).
  if (autocapSkipWorkflowTextEnabled() && looksLikeWorkflowDefinitionDump(text)) return [];
  // Harness-injected re-prompts (judge/stall/parse/grounding/YOLO/outcome) are
  // recorded as user_input_received but must NEVER become durable "user" facts —
  // they were being pinned as "Standing prohibition" and injected into every
  // chat + voice prompt (2026-06-23 fact pollution).
  if (autoCaptureHarnessSkipEnabled() && isHarnessInjectedInput(text)) return [];
  // One-off validation/probe prompts often contain durable-looking words such as
  // "instead of" or "must", but they describe this smoke turn, not user memory.
  if (isOneOffValidationOrToolProbe(text)) return [];

  const candidates: AutoMemoryCandidate[] = [];
  const prohibition = isSafetyProhibition(text);

  // Enforceable sender/account routing rule → kind:'constraint' so the dispatch
  // gate (constraint-guard via listConstraints) actually ENFORCES it, closing the
  // round-trip a kind:'user'/'feedback' fact could never reach. Emitted FIRST; the
  // feedback branch below is gated on this so the same rule isn't also stored as a
  // plain (un-enforced) preference.
  if (isEnforceableSenderConstraint(text)) {
    addCandidate(candidates, {
      kind: 'constraint',
      content: `Standing rule (enforced): ${text}`,
      reason: 'enforceable sender/account routing rule',
      pin: true,
    });
  }
  const capturedConstraint = candidates.some((c) => c.kind === 'constraint');

  if (FEEDBACK_CUES.test(text) && !capturedConstraint) {
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

  if (PROJECT_TERMS.test(text) && PROJECT_REQUIREMENT_CUES.test(text) && !isOneOffValidationOrToolProbe(text)) {
    addCandidate(candidates, {
      kind: 'project',
      content: `Clementine requirement: ${text}`,
      reason: 'project requirement signal',
    });
  }

  if (CONNECTED_APP_TERMS.test(text) && CONNECTED_APP_CUES.test(text) && !isOneOffConnectedAppLookup(text)) {
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

  // Explicit store request. Broadened from the old
  // `remember (that|this|my|i|we)` — that dropped "remember to call the
  // vendor", "remember: ship Friday", and "note that …" / "don't forget
  // …". A "do you remember X?" question is NOT a store request, so we
  // exclude leading interrogatives.
  if (
    candidates.length === 0
    && !/^\s*(?:do|did|does|can|could|would|will)\b/i.test(text)
    && /\b(?:remember|note|keep in mind|don'?t forget|make a note)\b/i.test(text)
  ) {
    addCandidate(candidates, {
      kind: 'user',
      content: `User explicitly asked Clementine to remember: ${text}`,
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
  if (candidates.length === 0 && !isOneOffConnectedAppLookup(text) && isDurableDeclarative(text)) {
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

export function captureInteractionSignals(input: {
  message: string;
  sessionId?: string;
  sourceEventId?: string;
  occurredAt?: string;
  maxFacts?: number;
}): AutoCaptureResult {
  // Harness-injected re-prompts (judge/stall/parse/grounding/YOLO/outcome) are
  // recorded as user_input_received but are NOT user messages — never learn from
  // them. (Defense-in-depth; the loop also gates capture to the first chat turn.)
  if (autoCaptureHarnessSkipEnabled() && isHarnessInjectedInput(input.message)) {
    return { candidates: [], facts: [], profilePatch: undefined, profile: undefined };
  }
  const candidates = extractAutoMemoryCandidates(input.message, input.maxFacts ?? 3);

  // Persist the exact source turn + replayable claim rows synchronously, then
  // run the semantic conflict resolver off the response path. A daemon restart
  // after this point cannot lose the memory: maintenance drains pending rows.
  // Re-delivery of the same sourceEventId reuses the ledger rows, so retries do
  // not create duplicate facts or duplicate "learning decision" entries.
  let queuedCandidateIds: number[] = [];
  let episodeId: string | null = null;
  if (candidates.length > 0 && input.sessionId) {
    try {
      const queued = enqueueAutoCaptureCandidates({
        message: input.message,
        sessionId: input.sessionId,
        sourceEventId: input.sourceEventId,
        occurredAt: input.occurredAt,
        candidates,
      });
      queuedCandidateIds = queued.candidateIds;
      episodeId = queued.episodeId;
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

  const profilePatch = extractProfilePatchFromMessage(input.message);
  let profile: UserProfile | undefined;
  if (profilePatch) {
    try {
      profile = saveUserProfile(profilePatch);
    } catch {
      // Profile adaptation is opportunistic, not critical path.
    }
  }

  return {
    candidates,
    facts: [],
    queuedCandidateIds,
    episodeId,
    profilePatch,
    profile,
  };
}
