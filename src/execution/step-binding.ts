import type { WorkflowStepInput } from '../memory/workflow-store.js';

/**
 * Step input binding (typed-workflow-contract P1).
 *
 * Pure + deterministic — no I/O, no LLM, no clock. Given a step's
 * declared `inputs` contract plus the run inputs, completed upstream
 * step outputs, and (for forEach) the current item, it resolves each
 * declared input to a concrete value and reports which REQUIRED inputs
 * are unresolved. The runner uses `missing` to fast-fail BEFORE the step
 * agent runs — turning the old silent empty-string starvation
 * (renderTemplate renders a missing token as '') into a loud, named
 * error.
 *
 * It deliberately mirrors renderTemplate's lookup semantics so the
 * structured STEP CONTEXT block and the rendered prose never disagree:
 *   - `input.<key>`            → runInputs[key]   (runInputs are already
 *                                normalized for url↔website↔domain by
 *                                normalizeWorkflowRunInputs upstream)
 *   - `steps.<id>.output`      → stepOutputs[id]
 *   - `steps.<id>.output.<p…>` → nested traversal of that output
 *   - `item` / `item.<p…>`     → the forEach item (nested traversal)
 *
 * Returns `{}`/empty when the step declares no `inputs` — the caller
 * then proceeds on today's template-only path byte-for-byte.
 */

export interface StepBindingResult {
  /** Declared input name → resolved value (or its default). */
  values: Record<string, unknown>;
  /** Outputs of the steps this step dependsOn, for the context block. */
  upstream: Record<string, unknown>;
  /** Names of REQUIRED inputs that resolved to undefined (no default). */
  missing: string[];
}

function traverse(root: unknown, path: string[]): unknown {
  let cursor: unknown = root;
  for (const p of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

/**
 * Resolve a `from` binding expression against the available sources.
 * Returns undefined when it can't resolve (caller falls back to default).
 */
export function resolveFrom(
  from: string,
  runInputs: Record<string, string>,
  stepOutputs: Record<string, unknown>,
  item: unknown,
): unknown {
  const expr = from.trim();
  if (!expr) return undefined;

  if (expr === 'item') return item;
  if (expr.startsWith('item.')) {
    return traverse(item, expr.slice('item.'.length).split('.'));
  }
  if (expr.startsWith('input.')) {
    const key = expr.slice('input.'.length);
    const v = runInputs[key];
    return v === undefined || v === '' ? undefined : v;
  }
  if (expr.startsWith('steps.')) {
    // steps.<id>.output[.<path…>]
    const rest = expr.slice('steps.'.length);
    const dot = rest.indexOf('.');
    if (dot === -1) return undefined; // needs at least `<id>.output`
    const id = rest.slice(0, dot);
    const tail = rest.slice(dot + 1); // `output` or `output.<path…>`
    if (tail !== 'output' && !tail.startsWith('output.')) return undefined;
    const out = stepOutputs[id];
    if (out === undefined || out === null) return undefined;
    if (tail === 'output') return out;
    return traverse(out, tail.slice('output.'.length).split('.'));
  }
  return undefined;
}

export function bindStepInputs(
  step: WorkflowStepInput,
  runInputs: Record<string, string>,
  stepOutputs: Record<string, unknown>,
  item?: unknown,
): StepBindingResult {
  const upstream: Record<string, unknown> = {};
  for (const dep of step.dependsOn ?? []) {
    if (dep in stepOutputs) upstream[dep] = stepOutputs[dep];
  }

  const decls = step.inputs;
  if (!decls || Object.keys(decls).length === 0) {
    return { values: {}, upstream, missing: [] };
  }

  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  const deps = step.dependsOn ?? [];

  for (const [name, decl] of Object.entries(decls)) {
    let value: unknown;
    if (decl.from) {
      value = resolveFrom(decl.from, runInputs, stepOutputs, item);
    } else {
      // Conventional resolution by the input's own name:
      //   run input → single matching upstream output → undefined.
      const fromInput = runInputs[name];
      if (fromInput !== undefined && fromInput !== '') {
        value = fromInput;
      } else if (deps.includes(name) && stepOutputs[name] !== undefined) {
        value = stepOutputs[name];
      }
    }

    if (value === undefined && decl.default !== undefined) {
      value = decl.default;
    }

    const required = decl.required !== false && decl.default === undefined;
    if (value === undefined) {
      if (required) missing.push(name);
      continue;
    }
    values[name] = value;
  }

  return { values, upstream, missing };
}
