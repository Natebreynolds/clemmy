import type { ConsolidatedFactKind } from './db.js';
import type { ConsolidatedFact } from './facts.js';
import { consolidateFact } from './reflection.js';
import { extractNamedResource } from './focus.js';
import { saveUserProfile, type UserProfile } from '../runtime/user-profile.js';

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
const PROHIBITION_ACTION_RE = /\b(?:send|sends|email|emails|e-?mail|cc|bcc|share|shares|post|posts|publish|delete|deletes|remove|removes|touch|modify|change|contact|message|reply|forward|push|deploy|overwrite|disclose|expose|text|dm|ping|notify)\b/i;
const PROHIBITION_ONE_OFF_RE = /\b(?:this once|just this|right now|today only|for now|this time|that one|never\s*mind)\b/i;

function isSafetyProhibition(text: string): boolean {
  return PROHIBITION_RE.test(text)
    && PROHIBITION_ACTION_RE.test(text)
    && !PROHIBITION_ONE_OFF_RE.test(text);
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
const STANDING_LIST_PHRASE_RE = /\b(?:to|use)\s+(?:this|that|these|those|the following|the|my|our)\s+(?:[\w'-]+\s+){0,3}?(?:list|distro|group|team|sheet|doc|document|spreadsheet|folder|channel|inbox)\b/i;

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

  const candidates: AutoMemoryCandidate[] = [];
  const prohibition = isSafetyProhibition(text);

  if (FEEDBACK_CUES.test(text)) {
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

  if (PROJECT_TERMS.test(text) && PROJECT_REQUIREMENT_CUES.test(text)) {
    addCandidate(candidates, {
      kind: 'project',
      content: `Clementine requirement: ${text}`,
      reason: 'project requirement signal',
    });
  }

  if (CONNECTED_APP_TERMS.test(text) && CONNECTED_APP_CUES.test(text)) {
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
  if (candidates.length === 0 && isDurableDeclarative(text)) {
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
  maxFacts?: number;
}): AutoCaptureResult {
  const candidates = extractAutoMemoryCandidates(input.message, input.maxFacts ?? 3);

  for (const candidate of candidates) {
    // Fire-and-forget: route the user-stated fact through the SAME Mem0
    // conflict resolver the tool-return reflection path uses, so a user
    // restating a preference ("actually, Wednesday now") UPDATEs/DELETEs
    // the stale fact instead of stacking a duplicate. trustLevel 1.0
    // keeps user statements authoritative over derived (0.6) facts on
    // conflict. The resolver makes an LLM call, so we never await it on
    // the chat turn — memory capture must never block the conversation.
    queueMicrotask(() => {
      consolidateFact(
        { kind: candidate.kind, text: candidate.content, trustLevel: 1.0, pin: candidate.pin },
        { sessionId: input.sessionId },
      ).catch(() => {
        // Swallow — a capture failure must never surface to the turn.
      });
    });
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
    profilePatch,
    profile,
  };
}
