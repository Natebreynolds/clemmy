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
 *  keys. Numbers and booleans are never empty (0 / false are real values). */
function isEmptyValue(value: unknown): boolean {
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
