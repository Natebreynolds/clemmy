import type { RunStoppedReason } from '../../types.js';
import { isPromiseShapedReply, judgeObjectiveComplete, type ObjectiveJudgeFn } from './objective-judge.js';

/**
 * Report-back honesty chokepoint shared by the async lanes that otherwise
 * hard-code success — cron (daemon/runner.ts), the gateway/mobile router,
 * and the autonomy loop. Before this, a transport blip or an "I'll do that
 * next" reply shipped as a confident "completed"/"ok" on exactly the
 * unattended surfaces where the user can't self-verify.
 *
 * Two design rules, both deliberate:
 *
 *  1. STRICTLY FAIL-OPEN. When disabled, on any uncertainty, or on a judge
 *     hiccup, this returns delivered:true. So it can only ever convert a
 *     FALSE "completed" into an honest "blocked" — never wedge a real
 *     completion. The change is monotonic.
 *
 *  2. SUSPICIOUS-ONLY judge. The only path that spends a model call is a
 *     promise-shaped reply (future-tense intent, no artifact). Every other
 *     accept/reject is a cheap string / stoppedReason check, so this is
 *     safe to call on high-frequency cron and live mobile turns.
 *
 * This is the lightweight core: it does NOT do the per-call ExecutionStore
 * scan or fan-out ledger read that classifyBackgroundTaskOutcome layers on
 * top for the background-task lane (those need a runSessionId). It shares the
 * blocked-text vocabulary with that classifier via BLOCKED_TEXT_PATTERNS.
 */

// Kill-switch (default ON). Set CLEMMY_VERIFY_DELIVERED=off to disable.
export function verifyDeliveredEnabled(): boolean {
  return (process.env.CLEMMY_VERIFY_DELIVERED ?? 'on').toLowerCase() !== 'off';
}

/**
 * The agent's own final words say it's blocked / waiting on input / approval
 * / hit a runtime-error stub. Moved here from background-tasks.ts so every
 * async lane shares one source of truth.
 */
export const BLOCKED_TEXT_PATTERNS: RegExp[] = [
  /\bapproval required\b/i,
  /\bpending approval id\b/i,
  /\bi('?m| am)\s+blocked\b/i,
  /\bi can('?t|not)\s+(complete|finish|proceed|continue)\b/i,
  /\bunable to (complete|finish|proceed|continue|access|retrieve|pull)\b/i,
  /\bcannot (complete|finish|proceed|continue) (this|the) (task|work|objective)\b/i,
  /\bneed (more|additional|your) (input|information|access|approval|credentials)\b/i,
  /\bwaiting (on|for) (your|user|the user)\b/i,
  /\bblocked (on|by)\b/i,
  /\bmissing (data|access|credentials|the required)\b/i,
  // Runtime-error stubs that respond() produces when the model backend throws
  // (a wall-clock abort that survived the in-loop retries, a 5xx burst, a
  // transport timeout). These are NOT completed deliverables.
  /\bhit a runtime error\b/i,
  /\bwall-clock budget\b/i,
  /\bcould ?n['’]?t (finish|complete|proceed|continue)\b/i,
];

export function matchesBlockedText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return BLOCKED_TEXT_PATTERNS.some((re) => re.test(t));
}

export interface DeliveryVerdict {
  delivered: boolean;
  /** Honest run status to record. 'blocked' covers both stalled and
   *  not-yet-done; callers whose status enum lacks 'blocked' map it to
   *  their nearest non-completion (e.g. the gateway uses 'failed'). */
  status: 'completed' | 'blocked';
  reason?: string;
}

export interface VerifyDeliveredOpts {
  stoppedReason?: RunStoppedReason | string;
  /** Test injection; defaults to the real (fail-open) objective judge. */
  judgeFn?: ObjectiveJudgeFn;
}

const DELIVERED: DeliveryVerdict = { delivered: true, status: 'completed' };

export async function verifyDelivered(
  objective: string,
  finalText: string,
  opts: VerifyDeliveredOpts = {},
): Promise<DeliveryVerdict> {
  if (!verifyDeliveredEnabled()) return DELIVERED;

  const text = (finalText ?? '').trim();
  const stoppedReason = opts.stoppedReason;

  // 1) The runtime itself says the turn didn't finish cleanly.
  if (stoppedReason === 'error') {
    return {
      delivered: false,
      status: 'blocked',
      reason: (text || 'The run hit a runtime error before finishing.').slice(0, 400),
    };
  }
  if (stoppedReason === 'cancelled') {
    return { delivered: false, status: 'blocked', reason: 'The run was cancelled before finishing.' };
  }
  if (stoppedReason === 'pending-approval') {
    return { delivered: false, status: 'blocked', reason: 'Stopped awaiting an approval that was not surfaced.' };
  }
  if (stoppedReason === 'max-turns-with-grace') {
    return {
      delivered: false,
      status: 'blocked',
      reason: (text || 'The run hit its turn budget before finishing; continue is required.').slice(0, 400),
    };
  }

  // 2) The agent's own words say it's blocked / needs input.
  if (matchesBlockedText(text)) {
    return { delivered: false, status: 'blocked', reason: text.slice(0, 400) };
  }

  // 3) Suspicious-only judge: a promise-shaped reply is the one shape worth a
  //    verification call. Anything else is accepted (fail-open, token-cheap).
  if (!isPromiseShapedReply(text)) return DELIVERED;
  if (!objective.trim() || !text) return DELIVERED;

  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  const verdict = await judge(objective, text); // itself fail-open on error
  if (verdict.done) return DELIVERED;
  return {
    delivered: false,
    status: 'blocked',
    reason: verdict.reason || 'Replied with a promise of work but no verifiable artifact.',
  };
}
