/**
 * Complete a native tool call whose intent is unambiguous from its own schema.
 *
 * A refusal that the host could have answered itself costs the model a full
 * round trip and teaches it nothing it can use. Two shapes are exact enough to
 * complete without guessing, and both are proven by re-validating against the
 * tool's own schema:
 *
 *  - WRAP: a list field is missing and the unrecognized top-level fields form
 *    exactly one valid item of that list (one edit sent where edits are
 *    expected). Nothing is dropped and nothing is invented, so reads and
 *    ordinary writes take it; sends and admin changes keep the refusal.
 *  - RENAME: one required field is missing and exactly one unrecognized field
 *    carries a value that validates as it (an identifier sent under the name
 *    another tool uses). Reads only: a read that is wrong reports "not found";
 *    a write must be sent back.
 *  - SCALAR: a number or boolean field received the canonical text of that
 *    value ("1440", "0", "true"). The text and the value are the same datum,
 *    so reads and ordinary writes take it; a value that is not the exact
 *    canonical spelling ("1e3", "01", " 5") keeps the refusal.
 *
 * Every other invalid call keeps its ordinary refusal.
 */
import type { z } from 'zod';
import type { ToolSideEffect } from './tool-registry.js';

export type NativeArgumentRepair = {
  args: Record<string, unknown>;
  repair: 'wrapped_single_item' | 'renamed_field' | 'canonical_scalar';
  detail: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

/** The value a canonical scalar spelling denotes, or undefined. */
function canonicalScalar(expected: unknown, value: unknown): number | boolean | undefined {
  if (typeof value !== 'string') return undefined;
  if (expected === 'number' && CANONICAL_NUMBER.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && String(parsed) === value ? parsed : undefined;
  }
  if (expected === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return undefined;
}

function withValueAt(root: unknown, path: readonly PropertyKey[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(root) && typeof head === 'number') {
    const next = [...root];
    next[head] = withValueAt(root[head], rest, value);
    return next;
  }
  if (plainObject(root) && typeof head === 'string') {
    return { ...root, [head]: withValueAt(root[head], rest, value) };
  }
  return root;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key];
    else if (plainObject(current) && typeof key === 'string') current = current[key];
    else return undefined;
  }
  return current;
}

export function repairNativeArguments(
  schema: z.ZodTypeAny,
  input: unknown,
  options: { sideEffect: ToolSideEffect | null },
): NativeArgumentRepair | null {
  if (!plainObject(input)) return null;
  if (options.sideEffect !== 'read' && options.sideEffect !== 'write') return null;
  let first = schema.safeParse(input);
  if (first.success) return null;

  let args: Record<string, unknown> = input;
  const coerced: string[] = [];
  for (const issue of first.error.issues) {
    // A nullable field compiled from JSON Schema reports a union whose
    // alternatives each name the one type they expected.
    const expected = issue.code === 'invalid_type'
      ? [issue.expected]
      : issue.code === 'invalid_union'
        ? issue.errors.flatMap((alternative) => (
          alternative.length === 1 && alternative[0]!.code === 'invalid_type' && alternative[0]!.path.length === 0
            ? [alternative[0]!.expected]
            : []))
        : [];
    const value = valueAt(args, issue.path);
    const scalar = expected.map((type) => canonicalScalar(type, value)).find((candidate) => candidate !== undefined);
    if (scalar === undefined) continue;
    args = withValueAt(args, issue.path, scalar) as Record<string, unknown>;
    coerced.push(issue.path.join('.'));
  }
  const scalarDetail = coerced.length > 0
    ? `${coerced.map((path) => `"${path}"`).join(', ')} read as ${coerced.length === 1 ? 'its value' : 'their values'}`
    : '';
  if (coerced.length > 0) {
    first = schema.safeParse(args);
    if (first.success) return { args, repair: 'canonical_scalar', detail: scalarDetail };
  }
  const withScalarDetail = (detail: string): string => (scalarDetail ? `${scalarDetail}; ${detail}` : detail);
  const missing: string[] = [];
  const unrecognized: string[] = [];
  for (const issue of first.error.issues) {
    if (issue.code === 'unrecognized_keys' && issue.path.length === 0) {
      unrecognized.push(...issue.keys);
      continue;
    }
    if (
      issue.path.length === 1
      && typeof issue.path[0] === 'string'
      && /received undefined/i.test(issue.message)
    ) {
      missing.push(issue.path[0]);
      continue;
    }
    return null;
  }
  if (missing.length !== 1 || unrecognized.length === 0) return null;
  const target = missing[0]!;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!unrecognized.includes(key)) rest[key] = value;
  }

  if (options.sideEffect === 'read' && unrecognized.length === 1) {
    const renamed = { ...rest, [target]: args[unrecognized[0]!] };
    const parsed = schema.safeParse(renamed);
    if (parsed.success) {
      return {
        args: renamed,
        repair: 'renamed_field',
        detail: withScalarDetail(`"${unrecognized[0]}" was read as "${target}"`),
      };
    }
  }

  const item: Record<string, unknown> = {};
  for (const key of unrecognized) item[key] = args[key];
  const wrapped = { ...rest, [target]: [item] };
  const parsed = schema.safeParse(wrapped);
  if (parsed.success) {
    return {
      args: wrapped,
      repair: 'wrapped_single_item',
      detail: withScalarDetail(`${unrecognized.map((key) => `"${key}"`).join(', ')} became the one item of "${target}"`),
    };
  }
  return null;
}
