/**
 * The one note a failed tool attempt carries back to the model, whatever the
 * tool: what kind of failure it was in plain words, and the next door.
 *
 * Owner's rule (10-20): when Clem cannot do something with a tool, she finds
 * another tool and says how, or says plainly why it cannot be done; she never
 * ends on something incomplete. The page-read and browser doors have their own
 * typed notes; this is the general case, keyed on the settled attempt's
 * outcome kind, never on the provider's wording. Live 10-20 (Windows tester):
 * two refused retries and the reply "the retry was refused before execution"
 * — no other door tried, nothing the owner could do named.
 */
import type { AttemptOutcomeKind } from './attempt-outcome.js';

const NEXT_DOOR = 'Before telling the owner it cannot be done, take the next door for the same outcome: '
  + 'another tool on this surface that reaches it, or one tool_search for the outcome in plain words, then call what it returns. '
  + 'If no door works, say plainly what failed, why, and what would make it possible, and ask the owner only for what only they can supply.';

export function failedAttemptNextDoorNote(kind: AttemptOutcomeKind, toolName: string): string | undefined {
  const tool = toolName.trim() || 'This call';
  switch (kind) {
    case 'succeeded':
    case 'empty_result':
    case 'uncertain_write':
      return undefined;
    case 'invalid_arguments':
      return `${tool} did not accept the arguments as sent. Correct only what its answer names and retry it once; if it refuses again, ${NEXT_DOOR}`;
    case 'transient':
      return `${tool} hit a passing fault (a timeout or a dropped connection). Retry it once; if it fails again, ${NEXT_DOOR}`;
    case 'unsupported_capability':
      return `${tool} cannot do this at all; do not retry it. ${NEXT_DOOR}`;
    case 'ignored_requirement':
      return `${tool} answered but dropped something the request required. Do not report it as done. ${NEXT_DOOR}`;
    case 'input_required':
      return `${tool} needs something only the owner can supply. Ask them for exactly that, in plain words, and say what you will do once you have it.`;
    case 'auth_failure':
      return `${tool}'s connection is not signed in or has expired. Tell the owner plainly which connection needs attention and what you will do once it works; meanwhile, ${NEXT_DOOR}`;
    case 'policy_denial':
      return `${tool} was refused on policy. Do not retry it or route around the policy; tell the owner plainly what was refused and why, and offer what you can do instead.`;
    case 'unknown':
    default:
      return `${tool} failed without a readable reason. ${NEXT_DOOR}`;
  }
}
