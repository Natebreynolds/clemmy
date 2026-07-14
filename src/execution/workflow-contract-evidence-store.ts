/**
 * T3.1 (conservative) — success-path contract tightening from ACCUMULATED
 * run evidence.
 *
 * A clean run's verified output is ground truth for what a step can produce, so
 * we can derive an output contract the next run is held to — "every run makes
 * the workflow better", not just failed ones. BUT deriving that contract from a
 * SINGLE run is dangerous: one run that happened to return {name,email,phone}
 * would freeze `required_keys: [name,email,phone]`, and the next legitimate run
 * that returns {name,email} (that record simply has no phone) FAILS — a false
 * failure the tightening itself introduced. Same trap for arrays: a "new leads
 * today" step that returns 5 today and 0 tomorrow would fail on the zero day.
 *
 * The fix: never tighten from one run. Record each clean run's observed shape,
 * and only require what has been INVARIANT across the last N clean runs
 * (intersection of keys; non-empty only if EVERY run was non-empty). By
 * construction the derived contract can only require things that have always
 * been true — so it cannot fail a run that looks like the runs we learned from.
 *
 * Kill-switch CLEMMY_WORKFLOW_AUTO_TIGHTEN (default on). Persistence mirrors
 * workflow-watermark-store: one JSON file per workflow, atomic write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getRuntimeEnv } from '../config.js';
import type { WorkflowDefinition, WorkflowStepInput, WorkflowStepOutputContract } from '../memory/workflow-store.js';

/** Clean runs required before ANY tightening is derived — one lucky run must
 *  never freeze a contract. */
export const MIN_RUNS_TO_TIGHTEN = 3;
/** Rolling window of observations kept per step. */
const MAX_OBSERVATIONS = 12;
const MAX_REQUIRED_KEYS = 6;
const IDENTIFIER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function autoTightenEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKFLOW_AUTO_TIGHTEN', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

export interface ShapeObservation {
  at?: string;
  type: 'object' | 'array';
  /** object: the non-empty identifier keys present this run. */
  keys?: string[];
  /** array: was it non-empty this run? */
  nonEmpty?: boolean;
}

/** Extract the tightenable shape of one step output, or null when there is
 *  nothing safe to learn from (string/number/boolean output, an honest
 *  {blocked} shape, or null/undefined). Pure. */
export function observeStepOutputShape(output: unknown): ShapeObservation | null {
  if (output === null || output === undefined) return null;
  if (Array.isArray(output)) {
    return { type: 'array', nonEmpty: output.length > 0 };
  }
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (record.blocked === true) return null; // honest blocked shape, not a deliverable
    if (record.gap === true) return null; // declared gap from an optional step — a soft failure, never learnable shape (fold-1 review: 3 gapped runs would lock required_keys [gap, reason])
    const keys = Object.keys(record)
      .filter((k) => IDENTIFIER_KEY_RE.test(k))
      .filter((k) => {
        const v = record[k];
        if (v === null || v === undefined) return false;
        if (typeof v === 'string') return v.trim().length > 0;
        if (Array.isArray(v)) return v.length > 0;
        return true;
      });
    return { type: 'object', keys };
  }
  return null; // scalar → deriving a contract adds nothing, only false-failure risk
}

/**
 * Derive a contract from accumulated observations — ONLY what has been invariant.
 * Returns null unless there are ≥ MIN_RUNS_TO_TIGHTEN observations that all agree
 * on the type. For objects, required_keys = keys present in EVERY observation
 * (intersection, capped). For arrays, min_items:1 ONLY if EVERY observation was
 * non-empty. Pure — the safety proof is here: the result can only assert things
 * true across every recorded clean run.
 */
export function deriveStableContract(observations: ShapeObservation[]): WorkflowStepOutputContract | null {
  if (observations.length < MIN_RUNS_TO_TIGHTEN) return null;
  // The window must be shape-consistent — a step that flips between object and
  // array is not stable; learn nothing rather than guess.
  const type = observations[observations.length - 1].type;
  if (!observations.every((o) => o.type === type)) return null;

  if (type === 'array') {
    const allNonEmpty = observations.every((o) => o.nonEmpty === true);
    return allNonEmpty ? { type: 'array', min_items: { '': 1 } } : { type: 'array' };
  }
  // object: intersect the key sets across every observation
  let intersection: string[] = [...(observations[0].keys ?? [])];
  for (const o of observations.slice(1)) {
    const keys = new Set<string>(o.keys ?? []);
    intersection = intersection.filter((k) => keys.has(k));
  }
  const required = intersection.sort().slice(0, MAX_REQUIRED_KEYS);
  if (required.length === 0) return { type: 'object' };
  return { type: 'object', required_keys: required };
}

/** Is `derived` a MEANINGFUL tightening over "no contract"? A bare {type} with
 *  no keys / no min_items is not worth a workflow rewrite (type alone rarely
 *  fails and adds little), so we skip it. */
export function isMeaningfulTightening(derived: WorkflowStepOutputContract | null): boolean {
  if (!derived) return false;
  if (derived.required_keys && derived.required_keys.length > 0) return true;
  if (derived.min_items && Object.keys(derived.min_items).length > 0) return true;
  return false;
}

// ─── persistence ─────────────────────────────────────────────────────────────

interface EvidenceFile { steps: Record<string, ShapeObservation[]> }

function evidenceDir(): string {
  return path.join(BASE_DIR, 'state', 'workflow-contract-evidence');
}
function evidencePath(workflowSlug: string): string {
  const safe = workflowSlug.replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(evidenceDir(), `${safe}.json`);
}
function readEvidence(workflowSlug: string): EvidenceFile {
  try {
    const parsed = JSON.parse(readFileSync(evidencePath(workflowSlug), 'utf-8')) as EvidenceFile;
    if (parsed && typeof parsed === 'object' && parsed.steps) return parsed;
  } catch { /* missing/corrupt → fresh */ }
  return { steps: {} };
}
function writeEvidence(workflowSlug: string, file: EvidenceFile): void {
  mkdirSync(evidenceDir(), { recursive: true });
  const target = evidencePath(workflowSlug);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
  renameSync(tmp, target);
}

export function readShapeObservations(workflowSlug: string, stepId: string): ShapeObservation[] {
  return readEvidence(workflowSlug).steps[stepId] ?? [];
}

export function recordShapeObservation(workflowSlug: string, stepId: string, obs: ShapeObservation, nowIso: string): void {
  const file = readEvidence(workflowSlug);
  const list = file.steps[stepId] ?? [];
  list.push({ ...obs, at: nowIso });
  file.steps[stepId] = list.slice(-MAX_OBSERVATIONS);
  writeEvidence(workflowSlug, file);
}

export interface StableTightening {
  stepId: string;
  output: WorkflowStepOutputContract;
  evidence: string;
}

/**
 * Record this clean run's step shapes, then return the tightenings now supported
 * by ≥ MIN_RUNS_TO_TIGHTEN invariant observations. Only touches steps with NO
 * author-declared contract and skips forEach wrappers. This is the single entry
 * the runner calls on a clean run. Returns [] when the kill-switch is off.
 */
export function recordAndDeriveStableTightenings(
  workflowSlug: string,
  def: WorkflowDefinition,
  stepOutputs: Record<string, unknown>,
  nowIso: string,
): StableTightening[] {
  if (!autoTightenEnabled()) return [];
  const out: StableTightening[] = [];
  for (const step of def.steps ?? []) {
    if (contractAlreadyDeclared(step)) continue; // author-declared wins, always
    if (step.forEach) continue;                  // aggregate wrapper shape is incidental
    if (!(step.id in stepOutputs)) continue;
    const obs = observeStepOutputShape(stepOutputs[step.id]);
    if (!obs) continue; // scalar/blocked/empty → nothing safe to learn
    recordShapeObservation(workflowSlug, step.id, obs, nowIso);
    const observations = readShapeObservations(workflowSlug, step.id);
    const derived = deriveStableContract(observations);
    if (!isMeaningfulTightening(derived)) continue;
    out.push({
      stepId: step.id,
      output: derived!,
      evidence: `invariant across ${observations.length} clean runs`,
    });
  }
  return out;
}

function contractAlreadyDeclared(step: WorkflowStepInput): boolean {
  return Boolean(step.output && Object.keys(step.output).length > 0);
}
