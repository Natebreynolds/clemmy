/**
 * Effect compatibility for procedural-memory retrieval.
 *
 * Similar provider/resource words are not enough to prove that a remembered
 * operation fits the current ask. `gmail email` describes both LIST_EMAILS and
 * SEND_EMAIL; allowing either one to rank on those nouns alone is exactly how
 * a read can inherit a write workflow (or a write can inherit a read workflow).
 *
 * This module is deliberately conservative:
 *   - only a clear request is scoped to read or write;
 *   - compound read+write work remains mixed and may retrieve both;
 *   - an unfamiliar legacy tool remains unknown and is not filtered out.
 *
 * Retrieval is still advisory. This narrows irrelevant memory; it does not
 * authorize a dispatch or replace the effect gates at the tool boundary.
 */
import { classifyMessageIntent } from '../assistant/message-intent.js';
import { classifyExternalEffectRequest } from '../assistant/external-effect-taxonomy.js';
import { composioSlugEffectEvidence } from '../integrations/composio/slug-effect.js';

export type CapabilityEffect = 'read' | 'write' | 'unknown';
export type RequestedCapabilityEffectScope = 'read' | 'write' | 'mixed' | 'unknown';

export interface EffectClassifiableChoice {
  kind: 'cli' | 'composio' | 'mcp';
  identifier: string;
  invocationTemplate?: string;
}

function cliCommandHead(command: string): string {
  const keep: string[] = [];
  for (const raw of command.trim().split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^(?:&&|\|\||\||;)$/.test(token)) break;
    if (/^-/.test(token)) break;
    if (/^["'`]/.test(token) || token.includes('=') || token.includes('{{') || token.includes('$(')) break;
    if (/^(?:\/|\.\/|\.\.\/)/.test(token)) break;
    keep.push(token);
  }
  return keep.join(' ');
}

// Extra high-signal CLI operations not present in provider API vocabulary.
// Arguments are excluded before this runs, so a search value mentioning
// "deploy" cannot turn a read procedure into a write.
const CLI_WRITE_OPERATION_RE = /\b(?:deploy|launch|merge|push|release|ship)\b/i;

// These are operation words, not a general consequential-intent classifier.
// The message-intent classifier first proves that the user is asking for an
// action; this second tier only determines which effect family that action
// names. Past-tense/advisory questions therefore stay read-scoped.
const READ_OPERATION_RE = /\b(?:read|review|summarize|search|research|find|list|fetch|retrieve|inspect|verify|check|look\s*up|lookup|query|view|show|count|audit|download|scan|browse|describe)\b/i;
const WRITE_OPERATION_RE = /\b(?:accept|add|append|approve|archive|assign|book|cancel|change|charge|close|comment|copy|create|delete|deploy|draft|edit|enable|disable|follow|forward|insert|invite|label|link|mark|merge|modify|move|mute|patch|pay|post|publish|push|put|refund|reject|remove|rename|reopen|replace|reply|reschedule|restore|save|schedule|send|set|share|star|submit|subscribe|tag|unarchive|unfollow|unlink|unmute|unsubscribe|update|upload|upsert|write)\b/i;
// A write can depend on a read even without a read VERB: "draft a reply to the
// latest email" and "create a report of my Gmail messages" both need GET/LIST
// memory as well as the eventual write. Keeping both effects here is cheaper
// than forcing rediscovery of the dependency and does not authorize either.
const READ_DEPENDENCY_RE = /\b(?:latest|recent|current|existing|matching|unread|summary|report|digest|analysis|availability|available|conflicts?|free|slots?)\b|\b(?:from|based\s+on|using)\s+(?:(?:my|our|the)\s+)?(?:[a-z0-9_-]+\s+){0,2}(?:availability|data|emails?|events?|files?|messages?|records?|rows?)\b|\bof\s+(?:(?:my|our|the)\s+)?(?:[a-z0-9_-]+\s+){0,2}(?:data|emails?|events?|files?|messages?|records?|rows?)\b|\b(?:all|each|old|older|matching|unread)\s+(?:[a-z0-9_-]+\s+){0,2}(?:emails?|events?|files?|messages?|records?|rows?)\b|\b(?:emails?|events?|files?|messages?|records?|rows?)\s+(?:after|before|from|matching|with|without)\b/i;
const CONVERSATIONAL_READ_QUESTION_RE = /^(?:what(?:['’]?s|\s+is|\s+are|\s+was|\s+were)\s+(?:on|in|inside|scheduled|happening|available|due)\b|(?:who|when|where)\b|how\s+many\b)/i;
// Weak payload grammar on a direct external effect is not itself a source
// read. A selection/reference cue keeps true read-before-write work mixed.
const EXPLICIT_SOURCE_SELECTION_RE =
  /\b(?:all|current|each|existing|latest|matching|old|older|recent|unread)\b|\b(?:based\s+on|from|using)\b|\bof\s+(?:my|our|the)\b/i;

/** The effect family the accepted request clearly asks to perform. */
export function requestedCapabilityEffectScope(text: string): RequestedCapabilityEffectScope {
  const input = text.trim();
  if (!input) return 'unknown';
  const intent = classifyMessageIntent(input).intent;

  // Questions, advice, history, verification, and explicit read operations
  // consume information even when their SUBJECT mentions a send/write.
  if (intent === 'lookup' || (intent !== 'action' && CONVERSATIONAL_READ_QUESTION_RE.test(input))) {
    return 'read';
  }
  if (intent !== 'action') return 'unknown';

  const externalEffect = classifyExternalEffectRequest(input);
  const explicitRead = READ_OPERATION_RE.test(input);
  const implicitReadDependency = READ_DEPENDENCY_RE.test(input);
  // A direct effect carrying a payload is one write role unless it explicitly
  // selects existing source material. This is effect-topology based: it works
  // for every external-effect family and does not special-case a destination.
  const directEffectHasSourceSelection = externalEffect.requested
    && EXPLICIT_SOURCE_SELECTION_RE.test(input);
  const read = explicitRead || (implicitReadDependency
    && (!externalEffect.requested || directEffectHasSourceSelection));
  // Communication nouns such as "email" and "message" are deliberately not
  // write verbs here. The shared external-effect classifier recognizes direct
  // "email Alice" / "message Bob" commands without turning "run the email
  // lookup workflow" into a write merely because its resource is email.
  const write = externalEffect.requested || WRITE_OPERATION_RE.test(input);
  if (read && write) return 'mixed';
  if (write) return 'write';
  if (read) return 'read';
  return 'unknown';
}

/** Evidence carried by a remembered operation's identifier/template. */
export function rememberedCapabilityEffect(
  choice: EffectClassifiableChoice,
): CapabilityEffect {
  const value = choice.kind === 'cli'
    ? cliCommandHead(choice.invocationTemplate ?? choice.identifier)
    : choice.identifier;
  const evidence = composioSlugEffectEvidence(value);
  if (evidence === 'read') return 'read';
  if (evidence === 'write' || (choice.kind === 'cli' && CLI_WRITE_OPERATION_RE.test(value))) return 'write';
  return 'unknown';
}

/** Unknown/mixed stays available; only a proven opposite effect is excluded. */
export function capabilityEffectIsCompatible(
  scope: RequestedCapabilityEffectScope,
  effect: CapabilityEffect,
): boolean {
  if (scope === 'unknown' || scope === 'mixed' || effect === 'unknown') return true;
  return scope === effect;
}
