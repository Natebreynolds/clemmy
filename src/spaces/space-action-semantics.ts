/**
 * Shared, conservative semantics for runner-backed Workspace actions.
 *
 * A runner name is only a hint: `approve-post.mjs` contains the noun "post",
 * but it does not publish anything. Treat explicit delivery verbs as outbound,
 * and treat "post" as outbound only when it is used as a verb/destination
 * (`post_to_linkedin`, `Post to X`). Composio actions still go through the
 * schema-aware external-write classifier at execution time.
 */
import type { SpaceAction } from './store.js';

function normalizedActionFields(action: SpaceAction): string[] {
  return [
    action.composioSlug,
    action.runner,
    action.label,
    action.id,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
}

const EXPLICIT_OUTBOUND_RE = /\b(send|reply|publish|tweet|dm|invite|sms|notify)\b/i;
const POST_TO_DESTINATION_RE = /\bpost\s+(?:to|on)\b/i;
const ADDRESSABLE_DELIVERY_RE = /\b(send|reply|dm|invite|sms|notify)\b/i;
const ADDRESSABLE_VERB_AT_START_RE = /^(?:email|message)\b/i;
const POST_VERB_AT_START_RE = /^post\b/i;
const LOCAL_ARTIFACT_AT_START_RE =
  /^(?:post|email|message)\s+(?:draft|preview|template|approval|note|record)\b/i;

/**
 * True only when the action metadata expresses an outbound delivery.
 * Noun phrases such as approve_post, review_post, or save_message stay local.
 */
export function workspaceActionLooksOutbound(action: SpaceAction): boolean {
  return normalizedActionFields(action).some((field) => {
    if (LOCAL_ARTIFACT_AT_START_RE.test(field)) return false;
    return EXPLICIT_OUTBOUND_RE.test(field)
      || POST_TO_DESTINATION_RE.test(field)
      || ADDRESSABLE_VERB_AT_START_RE.test(field)
      || POST_VERB_AT_START_RE.test(field);
  });
}

/**
 * Recipient integrity applies to addressable communication, not broadcast
 * publishing. A LinkedIn post may need approval, but asking it for `to_email`
 * is nonsensical and can trap the authoring loop in fake remediation.
 */
export function workspaceActionExpectsRecipient(action: SpaceAction): boolean {
  return normalizedActionFields(action).some((field) => {
    if (LOCAL_ARTIFACT_AT_START_RE.test(field)) return false;
    return ADDRESSABLE_DELIVERY_RE.test(field)
      || ADDRESSABLE_VERB_AT_START_RE.test(field);
  });
}
