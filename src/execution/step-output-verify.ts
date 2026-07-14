/**
 * P4 — typed-contract EXIT half. Verify a step's emitted output against
 * its declared `output` contract AFTER the step returns, so a malformed
 * or fabricated result fails loudly instead of feeding garbage to the
 * next step. This is the runtime enforcement of the WorkflowStepOutputContract
 * that workflow-store already parses + round-trips (it was previously
 * "enforced at runtime in a later phase").
 *
 * Pure (no I/O except the filesystem existence check for verify.path_exists,
 * which is the whole point of artifact verification) + flag-gated by the
 * caller. Returns a structured result; the runner decides how to surface it.
 *
 * North star: "reports back without fail" — a step that claims success but
 * returned no real artifact (the revill "deploy_to_netlify returned blocked,
 * no URL" class) is caught as a hard verification failure, not a silent pass.
 */
import { existsSync } from 'node:fs';
import type { WorkflowStepOutputContract, WorkflowContractType } from '../memory/workflow-store.js';

export interface StepOutputVerifyResult {
  ok: boolean;
  /** Human-readable problems, one per failed check. Empty when ok. */
  problems: string[];
}

const OK: StepOutputVerifyResult = { ok: true, problems: [] };

/** Resolve a dot-notation path (e.g. "result.url") against a value. */
function resolvePath(value: unknown, dotted: string): unknown {
  let cursor: unknown = value;
  for (const part of dotted.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function matchesType(value: unknown, type: WorkflowContractType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    default: return true;
  }
}

/** Wave 3 P1-9: a value is "empty" when it carries no data — null/undefined,
 *  a blank/whitespace string, a zero-length array, or an object with no own
 *  keys. Numbers and booleans are never empty (0 / false are real values).
 *  Exported so the runner's substance-gap detector (Wave 2.1) uses the SAME
 *  definition of "empty" as the declared-contract path. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function isNonEmptyHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Verify `value` against `contract`. Shallow + conservative: an absent
 * contract → ok; a `type` mismatch, a missing `required_keys` entry, a
 * `verify.path_exists` path that isn't an existing file, or a
 * `verify.url_present` path that isn't a non-empty http(s) URL → failure.
 *
 * `fileExists` is injectable for tests (defaults to fs.existsSync).
 */
export function verifyStepOutput(
  contract: WorkflowStepOutputContract | undefined,
  value: unknown,
  fileExists: (p: string) => boolean = existsSync,
): StepOutputVerifyResult {
  if (!contract) return OK;
  const problems: string[] = [];

  if (contract.type && !matchesType(value, contract.type)) {
    problems.push(`expected output of type "${contract.type}" but got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
  }

  if (contract.required_keys && contract.required_keys.length > 0) {
    const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObj) {
      problems.push(`required_keys declared (${contract.required_keys.join(', ')}) but output is not an object`);
    } else {
      const obj = value as Record<string, unknown>;
      for (const key of contract.required_keys) {
        if (obj[key] === undefined || obj[key] === null) {
          problems.push(`missing required output key "${key}"`);
        }
      }
    }
  }

  // Wave 3 P1-9: emptiness checks. A "" / "." path targets the root value.
  // Problem strings are prefixed `non_empty:` / `min_items:` so the runner can
  // recognize an empty-data violation and route it to needs-attention with a
  // remediation message instead of a cryptic contract error.
  if (contract.non_empty && contract.non_empty.length > 0) {
    for (const p of contract.non_empty) {
      const resolved = p === '' || p === '.' ? value : resolvePath(value, p);
      if (isEmptyValue(resolved)) {
        problems.push(`non_empty: output "${p || '(root)'}" is empty (no data produced)`);
      }
    }
  }

  if (contract.min_items) {
    for (const [p, min] of Object.entries(contract.min_items)) {
      const resolved = p === '' || p === '.' ? value : resolvePath(value, p);
      if (!Array.isArray(resolved)) {
        problems.push(`min_items: output "${p || '(root)'}" is not an array (cannot count items)`);
      } else if (resolved.length < min) {
        problems.push(`min_items: output "${p || '(root)'}" has ${resolved.length} item(s), needs at least ${min}`);
      }
    }
  }

  if (contract.verify?.path_exists) {
    for (const p of contract.verify.path_exists) {
      const resolved = resolvePath(value, p);
      if (typeof resolved !== 'string' || resolved.trim().length === 0) {
        problems.push(`verify.path_exists: output "${p}" is not a file path string`);
      } else if (!fileExists(resolved.trim())) {
        problems.push(`verify.path_exists: file at "${p}" (${resolved.trim()}) does not exist`);
      }
    }
  }

  if (contract.verify?.url_present) {
    for (const p of contract.verify.url_present) {
      const resolved = resolvePath(value, p);
      if (!isNonEmptyHttpUrl(resolved)) {
        problems.push(`verify.url_present: output "${p}" is not a non-empty http(s) URL`);
      }
    }
  }

  return problems.length === 0 ? OK : { ok: false, problems };
}

/** A step that legitimately BLOCKED signals it couldn't produce its
 *  deliverable; contract checks are skipped for it (the runner surfaces the
 *  block's REASON instead of a cryptic "missing key"). One truth here — used
 *  by both the reduce-time gate and the submission-time gate. */
export function isBlockedStepOutput(output: unknown): boolean {
  return output !== null && typeof output === 'object' && !Array.isArray(output) &&
    (output as { blocked?: unknown }).blocked === true;
}

/**
 * Self-heal move 1 (2026-07-14). Render a step's output contract as a
 * machine-precise prompt block the RUNNER injects into every step prompt —
 * derived from the SAME contract verifyStepOutput gates on, so prompt/contract
 * drift is structurally impossible (the scorpion-facebook-trends class: the
 * authored prompt named different keys than the contract, and the model
 * improvised shapes — green or dead by coin flip).
 */
export function renderOutputContractSpec(contract: WorkflowStepOutputContract): string {
  const lines: string[] = [
    'OUTPUT CONTRACT — your workflow_step_result `data` is gated on this exact shape; a mismatch fails the run:',
  ];
  if (contract.type) {
    lines.push(contract.type === 'object'
      ? '- Submit a single JSON OBJECT (as JSON text in `data`) — never prose, never a double-encoded string.'
      : `- The result must be of type "${contract.type}".`);
  }
  if (contract.required_keys?.length) {
    lines.push(`- Required keys: ${contract.required_keys.join(', ')}.`);
  }
  const minItems = contract.min_items ?? {};
  const nonEmpty = new Set(contract.non_empty ?? []);
  for (const [pathKey, min] of Object.entries(minItems)) {
    lines.push(`- "${pathKey || '(root)'}" must be a JSON ARRAY with at least ${min} item(s) — never an object or a sentence.`);
    nonEmpty.delete(pathKey);
  }
  for (const pathKey of nonEmpty) {
    lines.push(`- "${pathKey || '(root)'}" must be non-empty (real data, not a placeholder).`);
  }
  for (const pathKey of contract.verify?.url_present ?? []) {
    lines.push(`- "${pathKey}" must contain a real http(s) URL.`);
  }
  for (const pathKey of contract.verify?.path_exists ?? []) {
    lines.push(`- "${pathKey}" must be a path to a file that actually exists.`);
  }
  lines.push('- If you are genuinely blocked, submit {"blocked": true, "reason": "<specifics>"} instead of a partial shape.');
  return lines.join('\n');
}

/** Wave 3 P1-9 classification, extracted + FIXED (2026-07-14): "empty output"
 *  (upstream produced no data — remediation message, not Doctor-routed) vs
 *  "output_contract" (the step emitted the WRONG SHAPE — diagnosable). The old
 *  in-line filter counted `min_items: X is not an array` as emptiness, which
 *  told the user "the source returned nothing" when 197KB of real data existed
 *  and only the shape was wrong (live scorpion-facebook-trends misdiagnosis). */
export function classifyContractProblems(problems: string[]): 'empty_output' | 'output_contract' {
  const emptyOnly = problems.length > 0 && problems.every((p) =>
    (p.startsWith('non_empty:') || p.startsWith('min_items:'))
    && !p.includes('is not an array'));
  return emptyOnly ? 'empty_output' : 'output_contract';
}
