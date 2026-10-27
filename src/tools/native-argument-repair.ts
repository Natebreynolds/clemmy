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
 *  - UNWRAP: the arguments arrived in a carrier's shape (args_json holding
 *    them as JSON text, with the tool's own name beside it). The JSON text is
 *    the arguments, so reads and ordinary writes take it.
 *
 * Every other invalid call keeps its ordinary refusal.
 */
import type { z } from 'zod';
import type { ToolSideEffect } from './tool-registry.js';

export type NativeArgumentRepair = {
  args: Record<string, unknown>;
  repair: 'wrapped_single_item' | 'renamed_field' | 'canonical_scalar' | 'json_text_sibling' | 'carrier_unwrapped' | 'dropped_unknown_fields';
  detail: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

/** The value a canonical scalar spelling denotes, or undefined. */
function canonicalScalar(expected: unknown, value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  if (expected === 'number' && CANONICAL_NUMBER.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && String(parsed) === value ? parsed : undefined;
  }
  if (expected === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  // A list or object sent as its own JSON text is that value, read once.
  if ((expected === 'array' || expected === 'object') && /^\s*[[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (expected === 'array' ? Array.isArray(parsed) : plainObject(parsed)) return parsed;
    } catch { /* not that value's text */ }
  }
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

/**
 * An object sent in a field whose schema also offers a JSON-text sibling
 * (`args` beside `args_json`) moves into that sibling whole, encoded once. A
 * strict schema cannot type an open object's values, so the object form
 * arrives typed as text and its numbers and lists are refused; the JSON-text
 * sibling carries every nested type losslessly. Nothing is coerced, and the
 * move stands only if the whole call then validates.
 */
function moveObjectsToJsonTextSiblings(
  schema: z.ZodTypeAny,
  input: Record<string, unknown>,
  issues: readonly { path: readonly PropertyKey[] }[],
): { args: Record<string, unknown>; detail: string } | null {
  let args: unknown = input;
  const moved: string[] = [];
  const startsWith = (path: readonly PropertyKey[], prefix: readonly PropertyKey[]) => (
    prefix.length <= path.length && prefix.every((part, index) => path[index] === part));
  const movedPaths: PropertyKey[][] = [];
  for (const issue of issues) {
    // Several failures inside one object are one move.
    if (movedPaths.some((path) => startsWith(issue.path, path))) continue;
    // The innermost object on the failing path whose JSON-text sibling the
    // schema accepts: moving it must clear the failure there without the
    // sibling itself being refused.
    for (let index = issue.path.length - 1; index >= 0; index -= 1) {
      const key = issue.path[index];
      if (typeof key !== 'string') continue;
      const parentPath = issue.path.slice(0, index);
      const parent = valueAt(args, parentPath);
      if (!plainObject(parent)) continue;
      const value = parent[key];
      const sibling = `${key}_json`;
      if (!plainObject(value) || (parent[sibling] !== undefined && parent[sibling] !== null)) continue;
      // Only a sibling the schema declares. Inside an open record every key
      // validates, so a nested carrier's `arguments` became an invented
      // `arguments_json` there instead of its call's `args` moving to the
      // declared `args_json` (live: the workflow step then ran on a model).
      if (!declaredKeysAt(schema, parentPath)?.has(sibling)) continue;
      const { [key]: _object, ...rest } = parent;
      const candidate = withValueAt(args, parentPath, { ...rest, [sibling]: JSON.stringify(value) });
      const after = schema.safeParse(candidate);
      const stillFailing = !after.success && after.error.issues.some((left) => (
        startsWith(left.path, [...parentPath, key])
        || startsWith(left.path, [...parentPath, sibling])
        || (left.code === 'unrecognized_keys' && startsWith(left.path, parentPath) && left.path.length === parentPath.length
          && (left as { keys?: string[] }).keys?.includes(sibling))
      ));
      if (stillFailing) continue;
      args = candidate;
      movedPaths.push([...parentPath, key]);
      moved.push([...parentPath, key].join('.'));
      break;
    }
  }
  if (moved.length === 0 || !plainObject(args) || !schema.safeParse(args).success) return null;
  return {
    args,
    detail: `${moved.map((path) => `"${path}"`).join(', ')} sent as JSON text in ${moved.length === 1 ? 'its' : 'their'} _json field`,
  };
}

type ZodDefLike = { type?: string; innerType?: unknown; in?: unknown; shape?: Record<string, unknown>; element?: unknown };
const defOf = (schema: unknown): ZodDefLike | undefined => (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def;

/** A schema with its optional/nullable/default/pipe wrappers taken off. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = defOf(current);
    if (!def) break;
    if (['optional', 'nullable', 'default', 'readonly', 'catch', 'nonoptional', 'prefault'].includes(def.type ?? '')) {
      current = def.innerType;
      continue;
    }
    if (def.type === 'pipe') { current = def.in; continue; }
    break;
  }
  return current;
}

/** The keys the object schema at this path declares, or null when the value
 *  there is not a declared object (an open record declares none). */
function declaredKeysAt(schema: z.ZodTypeAny, path: readonly PropertyKey[]): Set<string> | null {
  let current = unwrapSchema(schema);
  for (const part of path) {
    const def = defOf(current);
    if (def?.type === 'object' && typeof part === 'string') current = unwrapSchema(def.shape?.[part]);
    else if (def?.type === 'array' && typeof part === 'number') current = unwrapSchema(def.element);
    else return null;
  }
  const def = defOf(current);
  return def?.type === 'object' ? new Set(Object.keys(def.shape ?? {})) : null;
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
  const jsonText = moveObjectsToJsonTextSiblings(schema, input, first.error.issues);
  if (jsonText) return { args: jsonText.args, repair: 'json_text_sibling', detail: jsonText.detail };

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
  // UNWRAP. Live 2026-10-18: workflow_run_status received {name, args_json}.
  const carrierKeys = new Set(['args_json', 'name']);
  if (unrecognized.includes('args_json') && unrecognized.every((key) => carrierKeys.has(key))
    && typeof args.args_json === 'string') {
    let carried: unknown;
    try { carried = JSON.parse(args.args_json); } catch { carried = undefined; }
    if (plainObject(carried)) {
      const unwrapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) if (!carrierKeys.has(key) || !unrecognized.includes(key)) unwrapped[key] = value;
      for (const [key, value] of Object.entries(carried)) if (!(key in unwrapped) || unwrapped[key] === null) unwrapped[key] = value;
      if (schema.safeParse(unwrapped).success) {
        return { args: unwrapped, repair: 'carrier_unwrapped', detail: withScalarDetail('the arguments in "args_json" were read as the call\'s own') };
      }
    }
  }
  // DROP (reads only): fields the schema does not declare, when the call is
  // whole without them. A read sent with an extra "topic" or "query" the
  // tool never takes returns what the tool does return, and the result names
  // what was left out; the model reads it and refines if it matters. A write
  // keeps the refusal: a dropped field could change what is written.
  if (options.sideEffect === 'read' && missing.length === 0 && unrecognized.length > 0) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) if (!unrecognized.includes(key)) kept[key] = value;
    if (schema.safeParse(kept).success) {
      return {
        args: kept,
        repair: 'dropped_unknown_fields',
        detail: withScalarDetail(`${unrecognized.map((key) => `"${key}"`).join(', ')} ${unrecognized.length === 1 ? 'is not an argument of this tool and was left out' : 'are not arguments of this tool and were left out'}`),
      };
    }
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
