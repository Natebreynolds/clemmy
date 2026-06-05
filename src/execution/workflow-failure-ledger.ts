/**
 * Cross-run workflow failure ledger (self-improvement hole #6).
 *
 * `selfHealAttempt` only tracks failures WITHIN a single re-queue chain, and a
 * fresh cron fire resets it to 0 — so a chronically-broken scheduled workflow
 * re-heals (re-running the WHOLE workflow, up to the cap) on every fire,
 * forever, silently burning tokens. This ledger counts CONSECUTIVE failures
 * per workflow across independent runs/fires so the engine can:
 *   1. STOP auto-healing once a workflow is clearly stuck (kills the expensive
 *      re-run multiplier), and
 *   2. ESCALATE ONCE (a loud notification) instead of failing silently.
 * A clean success resets the count (and the escalation latch).
 *
 * Best-effort JSON at STATE_DIR/workflow-failure-ledger.json. A benign
 * read-modify-write race under the bounded drain pool can at worst delay an
 * escalation by one run — acceptable for an advisory ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../memory/db.js';

const LEDGER_FILE = path.join(STATE_DIR, 'workflow-failure-ledger.json');

/** Consecutive failures before we stop auto-healing + escalate once. */
export function escalateThreshold(): number {
  const raw = Number.parseInt(process.env.CLEMENTINE_WORKFLOW_ESCALATE_AFTER ?? '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

interface LedgerEntry {
  consecutiveFailures: number;
  lastOutcomeAt: string;
  /** True once we've fired the escalation for the current failure streak. */
  escalated: boolean;
  lastError?: string;
}
type Ledger = Record<string, LedgerEntry>;

function load(): Ledger {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Ledger) : {};
  } catch {
    return {};
  }
}

function save(ledger: Ledger): void {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
  } catch {
    /* best-effort — a write failure just means we re-evaluate next run */
  }
}

export interface OutcomeResult {
  consecutiveFailures: number;
  /** True exactly on the run that crosses the threshold — fire ONE escalation. */
  justEscalated: boolean;
}

/**
 * Record a workflow run's terminal outcome. `ok=true` (clean success) resets
 * the streak; `ok=false` increments it. Returns the current streak and whether
 * THIS outcome just crossed the escalation threshold (so the caller fires the
 * loud notification exactly once).
 */
export function recordWorkflowOutcome(workflow: string, ok: boolean, error?: string): OutcomeResult {
  const ledger = load();
  const prior = ledger[workflow];
  if (ok) {
    if (prior) { delete ledger[workflow]; save(ledger); }
    return { consecutiveFailures: 0, justEscalated: false };
  }
  const count = (prior?.consecutiveFailures ?? 0) + 1;
  const wasEscalated = prior?.escalated ?? false;
  const justEscalated = count >= escalateThreshold() && !wasEscalated;
  ledger[workflow] = {
    consecutiveFailures: count,
    lastOutcomeAt: new Date().toISOString(),
    escalated: wasEscalated || count >= escalateThreshold(),
    ...(error ? { lastError: error.slice(0, 300) } : {}),
  };
  save(ledger);
  return { consecutiveFailures: count, justEscalated };
}

export function getConsecutiveFailures(workflow: string): number {
  return load()[workflow]?.consecutiveFailures ?? 0;
}

/** True when the workflow has failed enough in a row that re-running it to
 *  auto-heal is just burning tokens — escalate to the human instead. */
export function shouldStopAutoHeal(workflow: string): boolean {
  return getConsecutiveFailures(workflow) >= escalateThreshold();
}

/** Reset a workflow's failure streak — call on a clean success, on manual fix,
 *  or when the user re-enables it (a deliberate fresh start). */
export function clearWorkflowFailures(workflow: string): void {
  const ledger = load();
  if (ledger[workflow]) { delete ledger[workflow]; save(ledger); }
}
