/**
 * LEARNED FROM USE — the store (owner 2026-10-24: "based on the user's habits,
 * based on the successful calls … shouldn't the fact be updated").
 *
 * One record per tool argument value a tool rejected, with what made the same
 * call work: the argument left out, or a different value. It is written from
 * the turn's own receipts after a call failed and a later call to the same
 * operation succeeded (argument-corrections.ts), never from a model's opinion.
 * It is per machine, like tool procedures: what a local program accepts
 * depends on how it is set up here.
 *
 * Three readers:
 *  - the host, before a read is sent: a value rejected at least
 *    AUTO_REPAIR_MIN_PAIRS times with one consistent fix gets that fix
 *    (argument-correction-repair.ts);
 *  - the memory renderer: a saved memory that holds the rejected value shows a
 *    "checked by use" note beside it the same day;
 *  - the nightly self-heal: that memory is rewritten so it stops misleading.
 *
 * Records fade: one unseen for RETENTION_DAYS is dropped. Leaf module (no
 * memory database, no event log) so any renderer can read it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

export type ArgumentFix = { kind: 'omit' } | { kind: 'replace'; value: string | number | boolean };

export interface ArgumentCorrection {
  /** The effective operation, lowercase (a tool slug, CLI operation or MCP tool). */
  operation: string;
  /** The effect the failing call was dispatched under (read, local_write, …). */
  effect?: string;
  /** The argument's key. */
  argument: string;
  /** The exact value the tool rejected. */
  rejectedValue?: string | number | boolean;
  fix: ArgumentFix;
  /** The tool's own words about the rejection, bounded and redacted. */
  error: string;
  /** Failed-then-fixed pairs seen. */
  pairs: number;
  /** A later pair fixed it differently, or an applied fix failed: never auto-applied again. */
  conflicting?: boolean;
  /** The host applied the fix and the call worked. */
  repairSuccesses?: number;
  /** The applied fix itself failed this many times. */
  repairFailures?: number;
  firstSeen: string;
  lastSeen: string;
  /** Active saved memories that held the rejected value when it was learned. */
  factIds?: number[];
  /** Memories the nightly self-heal already rewrote for this record. */
  rewrittenFactIds?: number[];
}

interface StoreFile {
  version: 1;
  corrections: ArgumentCorrection[];
}

export const AUTO_REPAIR_MIN_PAIRS = 2;
/** The guardrail kind the host journals when it applies a learned fix. */
export const ARGUMENT_CORRECTION_APPLIED = 'argument_correction_applied';
const RETENTION_DAYS = 60;
const MAX_RECORDS = 300;

let pathOverride: string | null = null;
let cache: { file: string; mtimeMs: number; data: StoreFile } | null = null;

let resolvedPath: string | null = null;
function storePath(): string {
  if (pathOverride) return pathOverride;
  resolvedPath ??= path.join(BASE_DIR, 'memory', 'argument-corrections', `${getMachineId()}.json`);
  return resolvedPath;
}

/** Test seam: a store file of the test's own. */
export function _setArgumentCorrectionStorePathForTests(file: string | null): void {
  pathOverride = file;
  resolvedPath = null;
  cache = null;
}

/** Whether this machine has a store yet (even an empty one). */
export function argumentCorrectionStoreExists(): boolean {
  try { return existsSync(storePath()); } catch { return true; }
}

export function loadArgumentCorrections(): ArgumentCorrection[] {
  const file = storePath();
  try {
    if (!existsSync(file)) return [];
    const { mtimeMs } = statOf(file);
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.data.corrections;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreFile>;
    const corrections = parsed?.version === 1 && Array.isArray(parsed.corrections) ? parsed.corrections : [];
    cache = { file, mtimeMs, data: { version: 1, corrections } };
    return corrections;
  } catch {
    return [];
  }
}

/** The cache follows the file, so a write from another process is read. */
function statOf(file: string): { mtimeMs: number } {
  return { mtimeMs: statSync(file).mtimeMs };
}

export function saveArgumentCorrections(corrections: readonly ArgumentCorrection[], now = new Date()): void {
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  const kept = corrections
    .filter((entry) => Date.parse(entry.lastSeen) >= cutoff)
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, MAX_RECORDS);
  const file = storePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, corrections: kept } satisfies StoreFile, null, 2), 'utf8');
  renameSync(temp, file);
  cache = null;
}

export function sameRejection(entry: ArgumentCorrection, operation: string, argument: string,
  rejectedValue: string | number | boolean | undefined): boolean {
  return entry.operation === operation && entry.argument === argument
    && (entry.rejectedValue === undefined ? rejectedValue === undefined : entry.rejectedValue === rejectedValue);
}

/** A record the host may apply on its own before a read is sent: learned
 *  from reads, seen at least twice with one fix, and that fix leaves the
 *  argument out. A different value is advice only: it can change what is read. */
export function autoRepairable(entry: ArgumentCorrection): boolean {
  return entry.pairs >= AUTO_REPAIR_MIN_PAIRS && entry.conflicting !== true
    && entry.fix.kind === 'omit' && entry.effect === 'read' && entry.rejectedValue !== undefined;
}

export function describeFix(entry: Pick<ArgumentCorrection, 'argument' | 'fix'>): string {
  return entry.fix.kind === 'omit'
    ? `with ${entry.argument} left out`
    : `with ${entry.argument} set to ${JSON.stringify(entry.fix.value)}`;
}

/** The same-day note a saved memory carries when it holds a value a tool
 *  rejected: what the tool said and what worked. Undefined when none. */
export function useCorrectionNoteForFact(factId: number): string | undefined {
  let corrections: ArgumentCorrection[];
  try { corrections = loadArgumentCorrections(); } catch { return undefined; }
  const notes = corrections
    .filter((entry) => entry.rejectedValue !== undefined && entry.effect === 'read' && entry.factIds?.includes(factId)
      && !entry.rewrittenFactIds?.includes(factId) && entry.conflicting !== true)
    .slice(0, 2)
    .map((entry) => `${entry.operation} rejects ${entry.argument}=${JSON.stringify(entry.rejectedValue)}`
      + ` ("${entry.error.slice(0, 120)}"); it works ${describeFix(entry)}`);
  return notes.length > 0 ? `(Checked by use: ${notes.join('; ')}.)` : undefined;
}

/** The nightly self-heal rewrote (or an undo restored) this memory for the
 *  rejection: the same-day note stops (or comes back) with it. */
export function markFactRewrittenFromUse(input: {
  operation: string; argument: string; rejectedValue: string | number | boolean; factId: number; rewritten: boolean;
}): void {
  const corrections = [...loadArgumentCorrections()];
  const entry = corrections.find((candidate) => sameRejection(candidate, input.operation, input.argument, input.rejectedValue));
  if (!entry) return;
  const rewritten = new Set(entry.rewrittenFactIds ?? []);
  if (input.rewritten) rewritten.add(input.factId); else rewritten.delete(input.factId);
  entry.rewrittenFactIds = [...rewritten];
  saveArgumentCorrections(corrections);
}
