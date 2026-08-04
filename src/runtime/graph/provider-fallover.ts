/**
 * The provider-neutral fallover contract (Clem 4 Stage 8 foundation).
 *
 * Today Claude, Codex, and BYO brains each carry their own continuation,
 * recovery, and fallover control flow, and the divergence is a defect class.
 * The Stage 8 invariant is provider-neutral: RETRY, RECONNECT, AND BRAIN
 * FALLOVER NEVER DUPLICATE AN EXTERNAL WRITE — and this module states it as a
 * total function rather than as discipline distributed across three brains.
 *
 * Two decisions carry the contract:
 *
 *   1. `decideProviderFallover` — may this turn move to another brain NOW?
 *      It composes the effect ledger's resume decisions: a turn whose every
 *      effect is settled or never-dispatched may fall over; an AMBIGUOUS
 *      effect (dispatch started, no receipt) forces observation FIRST, on the
 *      turn's current identity — because falling over past an unobserved
 *      write is how the same email gets sent twice by two different brains.
 *   2. `workIdentityMatches` — may a new attempt reuse a prior attempt's
 *      output? Only when the admitted identity and input digests match.
 *      Target text alone is never work identity: an endurance-proof audit
 *      already caught a false green from target-only reuse once, and this
 *      makes that class unrepresentable at the contract level.
 *
 * Providers become adapters that translate protocol and report usage;
 * everything decided here is decided the same way for all of them. Pure:
 * decisions only. No production caller yet — the Stage 8 slices migrate the
 * brain seams onto this.
 */
import { decideEffectResume, type EffectLedgerRow } from './effect-lifecycle.js';

// ── fallover ─────────────────────────────────────────────────────────────────

export interface TurnEffectLedgers {
  /** Ledger rows per effect identity observed in this turn so far. */
  [effectId: string]: readonly EffectLedgerRow[];
}

export type FalloverDecision =
  /** Every effect settled or never dispatched: another brain may take over. */
  | { action: 'fallover_allowed' }
  /** Ambiguous effects exist: observe THESE first, then decide again. */
  | { action: 'observe_first'; effectIds: string[] }
  /** A ledger is unlawful or unprovable: stop; a human or reaper decides. */
  | { action: 'blocked'; reasons: string[] };

/**
 * May this turn fall over to another brain right now?
 *
 * The composition is the point: this function adds NO judgment of its own
 * about individual effects — it asks `decideEffectResume` per effect and
 * aggregates. An effect the ledger says is safe to dispatch has not happened
 * yet and cannot be duplicated; a settled effect will be reused, not re-run;
 * everything else holds fallover until observation resolves it. There is no
 * override parameter, because an override parameter is where the invariant
 * would go to die.
 */
export function decideProviderFallover(ledgers: TurnEffectLedgers): FalloverDecision {
  const ambiguous: string[] = [];
  const blocked: string[] = [];
  for (const [effectId, rows] of Object.entries(ledgers)) {
    const decision = decideEffectResume(rows);
    switch (decision.action) {
      case 'dispatch':
      case 'settled':
        break;
      case 'observe':
        ambiguous.push(effectId);
        break;
      case 'complete_commit':
        // The provider write EXISTS (receipt in hand); only the local commit
        // is missing. That is completable by any brain — but it must happen
        // before new work, so surface it as observe-first rather than a free
        // pass.
        ambiguous.push(effectId);
        break;
      case 'stop':
        blocked.push(`${effectId}: ${decision.reason}`);
        break;
    }
  }
  if (blocked.length > 0) return { action: 'blocked', reasons: blocked };
  if (ambiguous.length > 0) return { action: 'observe_first', effectIds: ambiguous };
  return { action: 'fallover_allowed' };
}

// ── work identity across attempts and brains ─────────────────────────────────

export interface WorkIdentity {
  /** The admitted run/graph identity the work belongs to. */
  admissionDigest: string;
  /** The node definition digest (what the work IS). */
  nodeDigest: string;
  /** The predecessor-artifact input digest (what the work consumed). */
  inputDigest: string;
}

/**
 * May a new attempt reuse a prior attempt's output? Exact identity on all
 * three digests. The provider that produced the output is deliberately NOT
 * part of work identity — a Claude-produced artifact is reusable by a Codex
 * continuation when the work is identical — and the target/topic text is
 * deliberately not consulted at all: "same target" produced a false green
 * under a revised contract once, and text similarity is not identity.
 */
export function workIdentityMatches(prior: WorkIdentity, current: WorkIdentity): boolean {
  return prior.admissionDigest === current.admissionDigest
    && prior.nodeDigest === current.nodeDigest
    && prior.inputDigest === current.inputDigest;
}

export type ReuseDecision =
  | { action: 'reuse'; outputRef: string }
  | { action: 'rerun'; reason: string };

/**
 * The reuse decision a fallover continuation must make per completed node.
 * Missing output refs re-run (an identity match without an artifact proves
 * nothing); identity mismatches name which digest diverged, so telemetry can
 * distinguish "the plan changed" from "the inputs changed".
 */
export function decideOutputReuse(input: {
  prior: WorkIdentity & { outputRef?: string };
  current: WorkIdentity;
}): ReuseDecision {
  const { prior, current } = input;
  if (!workIdentityMatches(prior, current)) {
    const diverged = (['admissionDigest', 'nodeDigest', 'inputDigest'] as const)
      .filter((key) => prior[key] !== current[key]);
    return { action: 'rerun', reason: `work identity diverged on ${diverged.join(', ')}` };
  }
  if (!prior.outputRef) {
    return { action: 'rerun', reason: 'identity matches but no output artifact was recorded' };
  }
  return { action: 'reuse', outputRef: prior.outputRef };
}
