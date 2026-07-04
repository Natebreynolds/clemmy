/**
 * RSH-5 — fix memory (the self-heal LEARNING loop).
 *
 * When an auto-applied heal actually STICKS (the healed re-run completes clean),
 * we remember what fixed that failure signature. The next time the same class of
 * failure appears — same workflow, same step, same normalized root cause — the
 * Doctor is handed that known-good fix as a hint, so it converges instantly
 * instead of re-deriving from scratch. This is "recall sharpens the diagnosis":
 * the workflow stops failing the same way.
 *
 * Two-stage, because a fix is only worth learning once it's PROVEN:
 *   1. recordPendingFix(runId, …)  — at apply time, keyed by the healed re-run.
 *   2a. confirmPendingFix(runId)    — that re-run completed clean → promote to
 *       the confirmed store (the fix stuck).
 *   2b. discardPendingFix(runId)    — that re-run failed / auto-reverted → forget.
 *   3. recallConfirmedFix(wf, step, signature) — fold into the next diagnosis.
 *
 * Persistence: two JSON files under state/workflow-fix-memory/ (pending +
 * confirmed), atomic writes. Single-writer (the daemon drain).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BASE_DIR } from '../config.js';

const MAX_CONFIRMED = 500;

export interface RememberedFix {
  workflowSlug: string;
  stepId: string;
  signature: string;
  fixKind: string;
  fixDescription: string;
  /** The structured fix payload (newStepPrompt / newOutputContractJson / … ) —
   *  kept so a future diagnosis can be handed the exact known-good edit. */
  fix: Record<string, unknown>;
  confirmedAt?: string;
}

/** Normalize a failure's root-cause text into a stable signature so the SAME
 *  class of failure matches run-to-run: lowercase, strip ids/numbers/urls/quotes,
 *  collapse whitespace, hash. Pure + exported for tests. */
export function fixSignature(text: string | undefined | null): string {
  const norm = (text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')          // urls
    .replace(/["'`]/g, '')                    // quotes
    .replace(/\b[0-9a-f]{6,}\b/g, '')         // hex ids
    .replace(/\b\d+\b/g, '')                  // numbers
    .replace(/[^a-z ]+/g, ' ')                // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

interface PendingFile { byRun: Record<string, RememberedFix> }
interface ConfirmedFile { byKey: Record<string, RememberedFix> }

function dir(): string { return path.join(BASE_DIR, 'state', 'workflow-fix-memory'); }
function pendingPath(): string { return path.join(dir(), 'pending.json'); }
function confirmedPath(): string { return path.join(dir(), 'confirmed.json'); }
function confirmedKey(workflowSlug: string, stepId: string, signature: string): string {
  return `${workflowSlug}::${stepId}::${signature}`;
}

function readJson<T>(p: string, fallback: T): T {
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as T;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* missing/corrupt → fresh */ }
  return fallback;
}
function writeJson(p: string, value: unknown): void {
  mkdirSync(dir(), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, p);
}

/** Record a just-applied heal as pending, keyed by the healed re-run's id. */
export function recordPendingFix(runId: string, entry: RememberedFix): void {
  if (!runId) return;
  const file = readJson<PendingFile>(pendingPath(), { byRun: {} });
  file.byRun[runId] = entry;
  writeJson(pendingPath(), file);
}

/** The healed re-run completed clean → promote its pending fix to confirmed.
 *  No-op if there was no pending fix for this run. Returns the promoted fix. */
export function confirmPendingFix(runId: string, nowIso: string): RememberedFix | null {
  const pending = readJson<PendingFile>(pendingPath(), { byRun: {} });
  const entry = pending.byRun[runId];
  if (!entry) return null;
  delete pending.byRun[runId];
  writeJson(pendingPath(), pending);

  const confirmed = readJson<ConfirmedFile>(confirmedPath(), { byKey: {} });
  confirmed.byKey[confirmedKey(entry.workflowSlug, entry.stepId, entry.signature)] = { ...entry, confirmedAt: nowIso };
  // bound the store: keep the most-recent MAX_CONFIRMED by confirmedAt
  const keys = Object.keys(confirmed.byKey);
  if (keys.length > MAX_CONFIRMED) {
    const kept = keys
      .sort((a, b) => (confirmed.byKey[b].confirmedAt ?? '').localeCompare(confirmed.byKey[a].confirmedAt ?? ''))
      .slice(0, MAX_CONFIRMED);
    const trimmed: Record<string, RememberedFix> = {};
    for (const k of kept) trimmed[k] = confirmed.byKey[k];
    confirmed.byKey = trimmed;
  }
  writeJson(confirmedPath(), confirmed);
  return entry;
}

/** The healed re-run failed / was reverted → forget the unproven pending fix. */
export function discardPendingFix(runId: string): void {
  const pending = readJson<PendingFile>(pendingPath(), { byRun: {} });
  if (!pending.byRun[runId]) return;
  delete pending.byRun[runId];
  writeJson(pendingPath(), pending);
}

/** Recall a proven fix for this (workflow, step, signature), or null. */
export function recallConfirmedFix(workflowSlug: string, stepId: string, signature: string): RememberedFix | null {
  const confirmed = readJson<ConfirmedFile>(confirmedPath(), { byKey: {} });
  return confirmed.byKey[confirmedKey(workflowSlug, stepId, signature)] ?? null;
}
