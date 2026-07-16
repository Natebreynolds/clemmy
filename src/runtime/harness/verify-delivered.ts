import type { RunStoppedReason } from '../../types.js';
import { getRuntimeEnv } from '../../config.js';
import { isPromiseShapedReply, judgeObjectiveComplete, type ObjectiveJudgeFn } from './objective-judge.js';
import { looksLikeToolUnavailableSelfReport } from './tool-unavailable-text.js';

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
  // "Execution 0e30… marked blocked" / "the execution is blocked" — the shape
  // sess-mrds80fu's honest partial-progress report used; the old patterns only
  // matched "blocked on/by" and "I'm blocked", so the honesty backstop missed it.
  /\bexecution (?:is |was |remains |marked )?blocked\b/i,
  /\bstatus:\s*blocked\b/i,
  /\bmissing (data|access|credentials|the required)\b/i,
  /\bi('?m| am)\s+stopping\b[\s\S]{0,160}\bwithout\b[\s\S]{0,80}\b(number|result|deliverable|answer|verified)\b/i,
  /\bnothing that satisfies (the )?success (criterion|criteria)\b/i,
  /\bno verified (integer|number|result|deliverable|answer)\b/i,
  /\bno command executed and no tool result\b/i,
  // Runtime-error stubs that respond() produces when the model backend throws
  // (a wall-clock abort that survived the in-loop retries, a 5xx burst, a
  // transport timeout). These are NOT completed deliverables.
  /\bhit a runtime error\b/i,
  /\bwall-clock budget\b/i,
  /\bcould ?n['’]?t (finish|complete|proceed|continue)\b/i,
];

/** Move 3 kill-switch (default on; scoped to highStakes callers only). */
export function refuteCompletionEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_REFUTE_COMPLETION', 'on') ?? 'on').toLowerCase() !== 'off';
}

/**
 * Move 3 (trust roadmap #48): adversarial refute-the-completion for the
 * high-stakes terminal lane. Two independent judge calls with DISTINCT lenses
 * try to REFUTE the done-claim; only a UNANIMOUS refutation blocks (inform,
 * rarely block). Each lens fails OPEN (judge error/timeout = not refuted), so
 * a judge hiccup can never block a real completion. Cross-family + hedging
 * ride the existing judge plumbing underneath judgeObjectiveComplete.
 */
async function refuteHighStakesCompletion(
  objective: string,
  text: string,
  judge: (objective: string, reply: string) => Promise<{ done: boolean; reason?: string; failedOpen?: boolean }>,
): Promise<{ refuted: boolean; reason: string }> {
  const lenses = [
    `${objective}\n\nADVERSARIAL VERIFICATION — EVIDENCE LENS: assume the reply OVERSTATES completion. Judge done=true ONLY if the reply presents CONCRETE verifiable evidence of the finished deliverable (a link, an id, artifact content, or a specific confirmation of the sent/created thing). A claim, summary, or promise without evidence is done=false; name the missing evidence in reason.`,
    `${objective}\n\nADVERSARIAL VERIFICATION — OBJECTIVE LENS: assume the reply quietly NARROWED the objective. Judge done=true ONLY if every part of the stated objective is addressed in the reply. If any requested outcome is unaddressed or replaced with something easier, done=false; name what was dropped in reason.`,
  ];
  const verdicts = await Promise.all(lenses.map(async (lens) => {
    try {
      const v = await judge(lens, text);
      // failedOpen means the judge did not actually run — treat as NOT refuted.
      return { refutes: v.failedOpen ? false : !v.done, reason: v.reason ?? '' };
    } catch {
      return { refutes: false, reason: '' };
    }
  }));
  const refuted = verdicts.every((v) => v.refutes);
  const reason = verdicts.filter((v) => v.refutes).map((v) => v.reason).filter(Boolean).join(' | ').slice(0, 400);
  return { refuted, reason: reason || 'Both adversarial lenses refuted the completion claim.' };
}

/** Negation determiners that scope over a NOUN-PHRASE blocker mention. A risk
 *  report saying "no ambiguity or missing credentials encountered" / "None —
 *  no approval required" is the OPPOSITE of a blocker, but the phrase patterns
 *  (missing X, approval required, waiting on) are negation-blind and blocked a
 *  genuinely complete live run (2026-07-16 Stage-3 validation). Deliberately
 *  excludes verb negation (not / n't): "could not proceed" is a blocker idiom
 *  with its own patterns, and those must keep firing. */
const NEGATION_DETERMINERS = /\b(no|none|zero|without|never)\b/i;
const CLAUSE_BOUNDARY = /[.!?;:\n]/;

function matchIsNegated(text: string, matchIndex: number): boolean {
  const lookbackStart = Math.max(0, matchIndex - 60);
  let clause = text.slice(lookbackStart, matchIndex);
  const lastBoundary = (() => {
    for (let i = clause.length - 1; i >= 0; i--) {
      if (CLAUSE_BOUNDARY.test(clause[i])) return i;
    }
    return -1;
  })();
  if (lastBoundary >= 0) clause = clause.slice(lastBoundary + 1);
  return NEGATION_DETERMINERS.test(clause);
}

export function matchesBlockedText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (looksLikeToolUnavailableSelfReport(t)) return true;
  for (const re of BLOCKED_TEXT_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = global.exec(t)) !== null) {
      if (!matchIsNegated(t, m.index)) return true;
      if (m.index === global.lastIndex) global.lastIndex += 1; // zero-width safety
    }
  }
  return false;
}

/**
 * A structured CLASS of blocker, derived deterministically (zero-token) from the
 * blocker text + the runtime stoppedReason. The flat 400-char reason string told
 * the user/operator *something is wrong* but not *what kind* — so the unattended
 * lanes (cron/background/goal) couldn't route the remedy (a rate-limit wants
 * backoff, a permission wants the user, missing data wants escalation). This is
 * the routing signal: every blocked verdict now carries a type alongside the
 * human-readable reason. Pure tagging over the SAME vocabulary as
 * BLOCKED_TEXT_PATTERNS — no new LLM pass, no network.
 */
export type BlockerType =
  | 'needs_approval'   // an approval the run couldn't surface/obtain
  | 'needs_user_input' // a clarifying answer / information only the user has
  | 'permission'       // auth/credentials/access denied or missing
  | 'missing_data'     // a required input/source came back empty or absent
  | 'external_down'    // an upstream/external service was unreachable
  | 'rate_limited'     // throttled / quota exceeded (retry-with-backoff class)
  | 'budget'           // hit a turn/wall-clock/step budget before finishing
  | 'runtime_error'    // the run threw / crashed mid-turn
  | 'unverified_completion' // Move 3: a high-stakes done-claim failed adversarial refutation
  | 'unknown';         // blocked, but no pattern matched (still report it)

/**
 * Ordered most-specific-first; the FIRST match wins. Order is load-bearing:
 * rate-limit before external-down (a 429 is a throttle, not an outage),
 * approval/permission before the generic "need your X", budget before
 * missing-data (a "turn budget" line mentions neither data nor approval).
 */
const BLOCKER_TYPE_PATTERNS: Array<[BlockerType, RegExp]> = [
  ['rate_limited', /\b(rate[\s-]?limit|too many requests|\b429\b|quota (exceeded|reached)|throttl)/i],
  ['needs_approval', /\b(approval required|pending approval id|needs?\s+(your\s+)?approval|awaiting (an?\s+)?approval|blocked (on|by) (an?\s+)?approval|need (your )?approval)\b/i],
  ['permission', /\b(permission denied|not authoriz|unauthoriz|forbidden|\b403\b|access denied|missing (access|credentials)|need (more|additional|your)\s+(access|credentials)|auth(entication)?\s+(failed|required|error)|token (expired|invalid|missing)|re-?auth)\b/i],
  ['external_down', /\b(service (is )?(unavailable|down)|\b50[234]\b|upstream (error|unavailable)|connection (refused|reset|timed?\s?out)|could ?n['’]?t (reach|connect)|network error|api (is )?(down|unavailable)|unreachable)\b/i],
  ['budget', /\b(wall-?clock budget|turn budget|run budget|step budget|budget (exhausted|exceeded)|reached (its|the).{0,24}budget|max-?turns)\b/i],
  ['missing_data', /\b(missing (the )?(data|required|the required)|came back empty|returned (no|zero|empty)|no (data|results|records|rows)\s+(found|available|returned)|empty (result|dataset|sheet|response))\b/i],
  ['runtime_error', /\b(runtime error|hit a runtime error|unexpected error|uncaught|exception|stack ?trace|crashed|\b5xx\b)\b/i],
  ['needs_user_input', /\b(need (more|additional|your)\s+(input|information|clarification)|waiting (on|for) (your|user|the user)|need(s|ed)?\s+(you|your)\s+to|clarif|which (one|option))\b/i],
];

/**
 * Classify a blocker by KIND. Structured runtime signals (stoppedReason) win
 * when unambiguous; otherwise tag the text. Always returns a value (defaults to
 * 'unknown') — a blocker is never left untyped. Pure + deterministic + exported
 * so the background-task classifier and the proactive brief share one taxonomy.
 */
export function classifyBlocker(
  text: string | null | undefined,
  stoppedReason?: RunStoppedReason | string,
): BlockerType {
  if (stoppedReason === 'pending-approval') return 'needs_approval';
  if (stoppedReason === 'max-turns-with-grace') return 'budget';
  const t = (text ?? '').trim();
  if (t) {
    if (looksLikeToolUnavailableSelfReport(t)) return 'permission';
    for (const [type, re] of BLOCKER_TYPE_PATTERNS) {
      if (re.test(t)) return type;
    }
  }
  if (stoppedReason === 'error') return 'runtime_error';
  if (stoppedReason === 'cancelled') return 'unknown';
  return 'unknown';
}

export interface DeliveryVerdict {
  delivered: boolean;
  /** Honest run status to record. 'blocked' covers both stalled and
   *  not-yet-done; callers whose status enum lacks 'blocked' map it to
   *  their nearest non-completion (e.g. the gateway uses 'failed'). */
  status: 'completed' | 'blocked';
  reason?: string;
  /** The KIND of blocker, for routing/triage (only set when delivered:false). */
  blockerType?: BlockerType;
  /** Present when a completion was accepted through degraded verification. */
  verification?: { failedOpen?: boolean; selfJudge?: boolean };
}

export interface VerifyDeliveredOpts {
  stoppedReason?: RunStoppedReason | string;
  /** Test injection; defaults to the real (fail-open) objective judge. */
  judgeFn?: ObjectiveJudgeFn;
  /** Move 3 (trust roadmap #48): this completion guards an IRREVERSIBLE
   *  external write on an unattended lane — run the adversarial refuters
   *  before banking "done". Never set on ordinary chat turns (latency). */
  highStakes?: boolean;
}

const DELIVERED: DeliveryVerdict = { delivered: true, status: 'completed' };

/** Run the Move-3 refuters only for high-stakes callers; otherwise pass the
 *  accept through untouched (zero cost on ordinary lanes). */
async function maybeRefute(
  objective: string,
  text: string,
  opts: VerifyDeliveredOpts,
  accepted: DeliveryVerdict,
): Promise<DeliveryVerdict> {
  if (!opts.highStakes || !refuteCompletionEnabled() || !objective.trim() || !text.trim()) return accepted;
  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  const { refuted, reason } = await refuteHighStakesCompletion(objective, text, judge);
  if (!refuted) return accepted;
  return {
    delivered: false,
    status: 'blocked',
    reason,
    blockerType: 'unverified_completion',
  };
}

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
    const reason = (text || 'The run hit a runtime error before finishing.').slice(0, 400);
    return { delivered: false, status: 'blocked', reason, blockerType: classifyBlocker(reason, 'error') };
  }
  if (stoppedReason === 'cancelled') {
    return { delivered: false, status: 'blocked', reason: 'The run was cancelled before finishing.', blockerType: 'unknown' };
  }
  if (stoppedReason === 'pending-approval') {
    return { delivered: false, status: 'blocked', reason: 'Stopped awaiting an approval that was not surfaced.', blockerType: 'needs_approval' };
  }
  if (stoppedReason === 'max-turns-with-grace') {
    return {
      delivered: false,
      status: 'blocked',
      reason: (text || 'The run hit its turn budget before finishing; continue is required.').slice(0, 400),
      blockerType: 'budget',
    };
  }
  if (stoppedReason === 'token-budget') {
    // Stage 4: a budget park is a paused run, never a delivered one — banking
    // it as done would be exactly the false-complete the ceiling exists to
    // prevent (gateway/daemon report-back lanes call this directly).
    return {
      delivered: false,
      status: 'blocked',
      reason: 'The run reached its token budget before finishing; a user continue is required.',
      blockerType: 'budget',
    };
  }

  // 2) The agent's own words say it's blocked / needs input.
  if (matchesBlockedText(text)) {
    return { delivered: false, status: 'blocked', reason: text.slice(0, 400), blockerType: classifyBlocker(text) };
  }

  // 3) Suspicious-only judge: a promise-shaped reply is the one shape worth a
  //    verification call. Anything else is accepted (fail-open, token-cheap).
  if (!isPromiseShapedReply(text)) return maybeRefute(objective, text, opts, DELIVERED);
  if (!objective.trim() || !text) return DELIVERED;

  const judge = opts.judgeFn ?? judgeObjectiveComplete;
  const verdict = await judge(objective, text); // itself fail-open on error
  // AWAITING = the reply pauses for the user's decision. On the unattended
  // lanes that call this chokepoint (cron/background/gateway report-back),
  // banking it as a clean delivery would silently report success while the
  // work sits paused — surface it as needs-input so the report-back relays
  // the question (adversarial review, 2026-07-09).
  if (verdict.awaitingUser) {
    return {
      delivered: false,
      status: 'blocked',
      reason: (verdict.reason || text).slice(0, 400),
      blockerType: 'needs_user_input',
    };
  }
  if (verdict.done) {
    const accepted = verdict.failedOpen || verdict.selfJudge
      ? { ...DELIVERED, verification: { failedOpen: verdict.failedOpen, selfJudge: verdict.selfJudge } }
      : DELIVERED;
    return maybeRefute(objective, text, opts, accepted);
  }
  const reason = verdict.reason || 'Replied with a promise of work but no verifiable artifact.';
  return {
    delivered: false,
    status: 'blocked',
    reason,
    blockerType: classifyBlocker(reason),
  };
}
