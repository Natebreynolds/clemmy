/**
 * The effect lifecycle contract (Clem 4 Stage 6 foundation).
 *
 * Every consequential external write follows one spine:
 *
 *   reserved -> dispatch_started -> provider_receipt -> observed -> committed
 *     -> checkpointed
 *
 * with typed exits (refused, released) and one deliberately uncomfortable
 * state: AMBIGUOUS — a dispatch that started and produced no receipt. The
 * 2026-08-03 incident and its class live in that state, and the whole point
 * of this module is that ambiguity has exactly two lawful exits: resolve by
 * OBSERVATION (ask the provider what actually happened) or STOP safely and
 * say so. Blind redispatch is not a transition that exists here, so recovery
 * code cannot reach it by accident.
 *
 * Identity is a digest, not a description: the idempotency key binds the
 * admitted plan, operation, account, recipient class, and canonical
 * arguments. An approval binds to that same digest — approving one exact
 * effect — and a changed account, recipient, or payload is a different
 * digest that the old approval cannot authorize.
 *
 * This is the CONTRACT the tool boundary and the executor migrate onto in
 * the Stage 6 slices; nothing calls it in production yet. Pure: crypto
 * digests and decisions only. Storage, providers, and clocks live behind the
 * adapters that will consume it.
 */
import { createHash } from 'node:crypto';

// ── identity ─────────────────────────────────────────────────────────────────

export interface EffectIdentityInput {
  admissionDigest: string;
  provider: string;
  operation: string;
  effectClass: 'write' | 'send';
  /** Stable account identity, never a rotating connection id. */
  accountIdentity: string;
  /** Who/what the effect lands on (recipient, resource id, channel). */
  recipientKey: string;
  /** Canonical argument digest (e.g. composioCarrierDigest). */
  argumentsDigest: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** One effect, one key. Two spellings of one call converge; any material
 *  difference — account, recipient, payload, plan — diverges. */
export function computeEffectIdentity(input: EffectIdentityInput): string {
  if (/^ca_/i.test(input.accountIdentity)) {
    throw new Error('effect identity must bind the stable account identity, never a rotating connection id');
  }
  return `ef_${sha256(stableJson(input)).slice(0, 40)}`;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export type EffectPhase =
  | 'reserved'
  | 'dispatch_started'
  | 'provider_receipt'
  | 'observed'
  | 'committed'
  | 'checkpointed'
  /** Refused before dispatch — never counts against idempotency. */
  | 'refused'
  /** Reservation released without dispatch (e.g. the call could not exist). */
  | 'released';

export interface EffectLedgerRow {
  effectId: string;
  phase: EffectPhase;
  at: string;
  /** Receipt/observation/commit references, phase-dependent. */
  ref?: string;
  detail?: string;
}

/** The exact forward order. A transition may only move one step forward. */
const FORWARD: readonly EffectPhase[] = [
  'reserved', 'dispatch_started', 'provider_receipt', 'observed', 'committed', 'checkpointed',
];

/**
 * Validate a phase transition. Forward one step at a time — a checkpoint
 * cannot appear before a commit, a commit cannot appear before a receipt, and
 * nothing follows a refusal or release. Skipping a phase is how a crash
 * window becomes invisible, so it refuses loudly instead.
 */
export function validateEffectTransition(
  from: EffectPhase | null,
  to: EffectPhase,
): { ok: true } | { ok: false; reason: string } {
  if (from === null) {
    return to === 'reserved' || to === 'refused'
      ? { ok: true }
      : { ok: false, reason: `an effect begins at reserved or refused, not ${to}` };
  }
  if (from === 'refused' || from === 'released' || from === 'checkpointed') {
    return { ok: false, reason: `${from} is terminal; nothing follows it` };
  }
  if (to === 'released') {
    return from === 'reserved'
      ? { ok: true }
      : { ok: false, reason: `only an undispatched reservation can be released; this effect is ${from}` };
  }
  const fromIndex = FORWARD.indexOf(from);
  const toIndex = FORWARD.indexOf(to);
  if (toIndex !== fromIndex + 1) {
    return { ok: false, reason: `cannot move ${from} -> ${to}; the lifecycle advances one phase at a time` };
  }
  return { ok: true };
}

// ── resume decisions (the crown-jewel rule) ──────────────────────────────────

export type EffectResumeDecision =
  /** Never dispatched: safe to dispatch (first time, not a retry). */
  | { action: 'dispatch' }
  /** Started, no receipt: AMBIGUOUS. Ask the provider what happened. */
  | { action: 'observe'; reason: string }
  /** Receipt exists but commit does not: finish the local half, no redispatch. */
  | { action: 'complete_commit'; receiptRef: string }
  /** Fully settled: nothing to do; replay must be free. */
  | { action: 'settled'; phase: EffectPhase }
  /** Cannot be resolved safely from this ledger: stop and say so. */
  | { action: 'stop'; reason: string };

/**
 * Decide what a resumed run may do about one effect, from its ledger alone.
 *
 * The rule the incident class demands, as a total function: a dispatch that
 * STARTED and produced no receipt is never re-dispatched — its two exits are
 * observation or an honest stop. There is no code path from ambiguity back
 * to dispatch, which is the structural difference between this and a prompt
 * asking recovery to be careful.
 */
export function decideEffectResume(rows: readonly EffectLedgerRow[]): EffectResumeDecision {
  if (rows.length === 0) return { action: 'dispatch' };

  // Validate the chain; an unlawful ledger is a stop, not a guess.
  let phase: EffectPhase | null = null;
  for (const row of rows) {
    const verdict = validateEffectTransition(phase, row.phase);
    if (!verdict.ok) return { action: 'stop', reason: `ledger is not lawful: ${verdict.reason}` };
    phase = row.phase;
  }

  switch (phase) {
    case 'refused':
    case 'released':
      // The reservation never became a dispatch; a NEW attempt may dispatch.
      return { action: 'dispatch' };
    case 'reserved':
      // Reserved but never started: the reservation is this attempt's to use.
      return { action: 'dispatch' };
    case 'dispatch_started':
      return {
        action: 'observe',
        reason: 'dispatch started with no provider receipt — the write may or may not exist; only observation can say',
      };
    case 'provider_receipt': {
      const receipt = [...rows].reverse().find((row) => row.phase === 'provider_receipt');
      return receipt?.ref
        ? { action: 'complete_commit', receiptRef: receipt.ref }
        : { action: 'stop', reason: 'a provider receipt row without a receipt reference cannot prove the write' };
    }
    case 'observed':
    case 'committed':
    case 'checkpointed':
      return { action: 'settled', phase };
    default:
      return { action: 'stop', reason: `unrecognized ledger phase ${String(phase)}` };
  }
}

// ── approvals bind digests, not descriptions ─────────────────────────────────

export interface EffectApproval {
  approvalId: string;
  /** The EXACT effect identity this approval authorizes. */
  effectId: string;
  /** Single use: the attempt that consumed it. */
  consumedByAttemptId?: string;
}

/**
 * May this approval authorize this effect for this attempt?
 *
 * Exact identity, single use. A changed account, recipient, or payload
 * produces a different effectId, and the old approval — however recent,
 * however similar the prose — authorizes nothing.
 */
export function approvalAuthorizes(
  approval: EffectApproval,
  effectId: string,
  attemptId: string,
): { ok: true } | { ok: false; reason: string } {
  if (approval.effectId !== effectId) {
    return { ok: false, reason: 'approval binds a different effect identity — the content changed after approval' };
  }
  if (approval.consumedByAttemptId && approval.consumedByAttemptId !== attemptId) {
    return { ok: false, reason: `approval was already consumed by attempt ${approval.consumedByAttemptId}` };
  }
  return { ok: true };
}
