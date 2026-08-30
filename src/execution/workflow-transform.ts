import type {
  WorkflowTransformExpressionV1,
  WorkflowTransformV1,
} from '../memory/workflow-store.js';
import {
  opAggregate,
  opSelect,
  type AggregateMetric,
  type SelectWhere,
  type TableRow,
} from '../tools/table-ops-core.js';
import { resolveFrom } from './step-binding.js';

/** Authoring/runtime ceilings for the reviewed in-process transform lane. */
export const WORKFLOW_TRANSFORM_MAX_SPEC_BYTES = 64 * 1024;
export const WORKFLOW_TRANSFORM_MAX_VALUE_BYTES = 64 * 1024 * 1024;
export const WORKFLOW_TRANSFORM_MAX_AST_NODES = 256;
export const WORKFLOW_TRANSFORM_MAX_DEPTH = 16;
export const WORKFLOW_TRANSFORM_MAX_ITEMS = 50_000;
export const WORKFLOW_TRANSFORM_MAX_EVALUATIONS = 2_000_000;
export const WORKFLOW_TRANSFORM_MAX_FIELDS = 256;

const SAFE_FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,127}$/;
const SAFE_SOURCE_RE = /^(?:input\.[A-Za-z0-9_-]+|steps\.[A-Za-z0-9_-]+\.output(?:\.[A-Za-z0-9_-]+)*|item(?:\.[A-Za-z0-9_-]+)*)$/;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SELECT_OPS = new Set(['eq', 'ne', 'contains', 'empty', 'nonempty']);
const METRIC_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);

export class WorkflowTransformError extends Error {
  readonly code = 'workflow_transform_invalid';

  constructor(message: string) {
    super(`workflow_transform_invalid: ${message}`);
    this.name = 'WorkflowTransformError';
  }
}

export interface WorkflowTransformReference {
  kind: 'input' | 'step' | 'item';
  source: string;
  key?: string;
  stepId?: string;
}

export type WorkflowTransformValidation =
  | { ok: true; transform: WorkflowTransformV1; references: WorkflowTransformReference[] }
  | { ok: false; errors: string[] };

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownKeysOnly(record: PlainRecord, allowed: readonly string[], at: string, errors: string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allow.has(key)) errors.push(`${at} has unsupported field "${key}".`);
  }
}

function jsonByteLength(value: unknown): number | null {
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? null : Buffer.byteLength(rendered, 'utf8');
  } catch {
    return null;
  }
}

function jsonCompatibilityError(
  value: unknown,
  at: string,
  seen = new WeakSet<object>(),
  depth = 0,
): string | null {
  if (depth > 64) return `${at} exceeds the JSON nesting ceiling.`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${at} contains a non-finite number.`;
  if (typeof value !== 'object') return `${at} contains a non-JSON ${typeof value} value.`;
  if (seen.has(value)) return `${at} contains a cycle.`;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = jsonCompatibilityError(value[index], `${at}[${index}]`, seen, depth + 1);
      if (issue) return issue;
    }
    seen.delete(value);
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `${at} must be a plain JSON object.`;
  for (const [key, child] of Object.entries(value as PlainRecord)) {
    if (RESERVED_KEYS.has(key)) return `${at} contains reserved key "${key}".`;
    const issue = jsonCompatibilityError(child, `${at}.${key}`, seen, depth + 1);
    if (issue) return issue;
  }
  seen.delete(value);
  return null;
}

function safeField(value: unknown, at: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !SAFE_FIELD_RE.test(value) || RESERVED_KEYS.has(value)) {
    errors.push(`${at} must be a safe field name (1-128 letters, numbers, space, "_", "-", or ".").`);
    return false;
  }
  return true;
}

function sourceReference(from: string): WorkflowTransformReference {
  if (from.startsWith('input.')) return { kind: 'input', source: from, key: from.slice('input.'.length) };
  if (from.startsWith('steps.')) {
    const stepId = from.slice('steps.'.length).split('.')[0];
    return { kind: 'step', source: from, stepId };
  }
  return { kind: 'item', source: from };
}

function validateExpression(
  value: unknown,
  state: {
    errors: string[];
    references: WorkflowTransformReference[];
    nodes: number;
  },
  at: string,
  depth: number,
  itemScope: boolean,
): void {
  state.nodes += 1;
  if (state.nodes > WORKFLOW_TRANSFORM_MAX_AST_NODES) {
    state.errors.push(`transform has more than ${WORKFLOW_TRANSFORM_MAX_AST_NODES} expression nodes.`);
    return;
  }
  if (depth > WORKFLOW_TRANSFORM_MAX_DEPTH) {
    state.errors.push(`${at} exceeds the transform depth ceiling of ${WORKFLOW_TRANSFORM_MAX_DEPTH}.`);
    return;
  }
  if (!isRecord(value)) {
    state.errors.push(`${at} must be an expression object.`);
    return;
  }
  const op = value.op;
  if (typeof op !== 'string') {
    state.errors.push(`${at}.op must name a reviewed transform operation.`);
    return;
  }

  switch (op) {
    case 'literal': {
      ownKeysOnly(value, ['op', 'value'], at, state.errors);
      if (!Object.hasOwn(value, 'value')) state.errors.push(`${at}.value is required.`);
      else {
        const issue = jsonCompatibilityError(value.value, `${at}.value`);
        if (issue) state.errors.push(issue);
      }
      return;
    }
    case 'get': {
      ownKeysOnly(value, ['op', 'from'], at, state.errors);
      const from = value.from;
      if (typeof from !== 'string' || !SAFE_SOURCE_RE.test(from)) {
        state.errors.push(`${at}.from must be input.<key>, steps.<id>.output[.<path>], or item[.<path>].`);
        return;
      }
      if (from.split('.').some((segment) => RESERVED_KEYS.has(segment))) {
        state.errors.push(`${at}.from contains a reserved path segment.`);
        return;
      }
      const reference = sourceReference(from);
      if (reference.kind === 'item' && !itemScope) {
        state.errors.push(`${at}.from uses item outside a map.each expression.`);
        return;
      }
      state.references.push(reference);
      return;
    }
    case 'jsonParse':
    case 'jsonStringify':
    case 'count': {
      ownKeysOnly(value, ['op', 'value'], at, state.errors);
      validateExpression(value.value, state, `${at}.value`, depth + 1, itemScope);
      return;
    }
    case 'object': {
      ownKeysOnly(value, ['op', 'fields'], at, state.errors);
      if (!Array.isArray(value.fields) || value.fields.length > WORKFLOW_TRANSFORM_MAX_FIELDS) {
        state.errors.push(`${at}.fields must be an array of at most ${WORKFLOW_TRANSFORM_MAX_FIELDS} fields.`);
        return;
      }
      const keys = new Set<string>();
      value.fields.forEach((entry, index) => {
        const fieldAt = `${at}.fields[${index}]`;
        if (!isRecord(entry)) {
          state.errors.push(`${fieldAt} must be {key,value}.`);
          return;
        }
        ownKeysOnly(entry, ['key', 'value'], fieldAt, state.errors);
        if (safeField(entry.key, `${fieldAt}.key`, state.errors)) {
          if (keys.has(entry.key)) state.errors.push(`${at} repeats field "${entry.key}".`);
          keys.add(entry.key);
        }
        validateExpression(entry.value, state, `${fieldAt}.value`, depth + 1, itemScope);
      });
      return;
    }
    case 'array': {
      ownKeysOnly(value, ['op', 'items'], at, state.errors);
      if (!Array.isArray(value.items) || value.items.length > WORKFLOW_TRANSFORM_MAX_ITEMS) {
        state.errors.push(`${at}.items must be an array of at most ${WORKFLOW_TRANSFORM_MAX_ITEMS} expressions.`);
        return;
      }
      value.items.forEach((entry, index) => {
        validateExpression(entry, state, `${at}.items[${index}]`, depth + 1, itemScope);
      });
      return;
    }
    case 'map': {
      ownKeysOnly(value, ['op', 'value', 'each'], at, state.errors);
      validateExpression(value.value, state, `${at}.value`, depth + 1, itemScope);
      validateExpression(value.each, state, `${at}.each`, depth + 1, true);
      return;
    }
    case 'select': {
      ownKeysOnly(value, ['op', 'value', 'where', 'columns', 'limit'], at, state.errors);
      validateExpression(value.value, state, `${at}.value`, depth + 1, itemScope);
      if (value.where !== undefined) {
        if (!isRecord(value.where)) state.errors.push(`${at}.where must be an object.`);
        else {
          ownKeysOnly(value.where, ['column', 'op', 'value'], `${at}.where`, state.errors);
          safeField(value.where.column, `${at}.where.column`, state.errors);
          if (typeof value.where.op !== 'string' || !SELECT_OPS.has(value.where.op)) {
            state.errors.push(`${at}.where.op must be eq, ne, contains, empty, or nonempty.`);
          }
          if (value.where.value !== undefined && typeof value.where.value !== 'string') {
            state.errors.push(`${at}.where.value must be a string when supplied.`);
          }
        }
      }
      if (value.columns !== undefined) {
        if (!Array.isArray(value.columns) || value.columns.length > WORKFLOW_TRANSFORM_MAX_FIELDS) {
          state.errors.push(`${at}.columns must be an array of at most ${WORKFLOW_TRANSFORM_MAX_FIELDS} field names.`);
        } else value.columns.forEach((column, index) => safeField(column, `${at}.columns[${index}]`, state.errors));
      }
      if (
        value.limit !== undefined
        && (
          typeof value.limit !== 'number'
          || !Number.isInteger(value.limit)
          || value.limit < 1
          || value.limit > WORKFLOW_TRANSFORM_MAX_ITEMS
        )
      ) {
        state.errors.push(`${at}.limit must be an integer from 1 to ${WORKFLOW_TRANSFORM_MAX_ITEMS}.`);
      }
      return;
    }
    case 'aggregate': {
      ownKeysOnly(value, ['op', 'value', 'groupBy', 'metrics'], at, state.errors);
      validateExpression(value.value, state, `${at}.value`, depth + 1, itemScope);
      if (!Array.isArray(value.groupBy) || value.groupBy.length < 1 || value.groupBy.length > 32) {
        state.errors.push(`${at}.groupBy must contain 1-32 field names.`);
      } else value.groupBy.forEach((field, index) => safeField(field, `${at}.groupBy[${index}]`, state.errors));
      if (value.metrics !== undefined) {
        if (!Array.isArray(value.metrics) || value.metrics.length > 32) {
          state.errors.push(`${at}.metrics must be an array of at most 32 metrics.`);
        } else value.metrics.forEach((metric, index) => {
          const metricAt = `${at}.metrics[${index}]`;
          if (!isRecord(metric)) {
            state.errors.push(`${metricAt} must be {fn,column?}.`);
            return;
          }
          ownKeysOnly(metric, ['fn', 'column'], metricAt, state.errors);
          if (typeof metric.fn !== 'string' || !METRIC_FNS.has(metric.fn)) {
            state.errors.push(`${metricAt}.fn must be count, sum, avg, min, or max.`);
          }
          if (metric.column !== undefined) safeField(metric.column, `${metricAt}.column`, state.errors);
          if (metric.fn !== 'count' && metric.column === undefined) {
            state.errors.push(`${metricAt}.column is required for ${String(metric.fn)}.`);
          }
        });
      }
      return;
    }
    default:
      state.errors.push(`${at}.op "${op}" is not a reviewed transform operation.`);
  }
}

/** Strict parser used by authoring, durable-load validation, and execution. */
export function validateWorkflowTransform(value: unknown): WorkflowTransformValidation {
  const bytes = jsonByteLength(value);
  if (bytes === null) return { ok: false, errors: ['transform must be JSON-compatible.'] };
  if (bytes > WORKFLOW_TRANSFORM_MAX_SPEC_BYTES) {
    return { ok: false, errors: [`transform specification is ${bytes} bytes (cap ${WORKFLOW_TRANSFORM_MAX_SPEC_BYTES}).`] };
  }
  if (!isRecord(value)) return { ok: false, errors: ['transform must be an object.'] };
  const errors: string[] = [];
  ownKeysOnly(value, ['version', 'expression'], 'transform', errors);
  if (value.version !== 1) errors.push('transform.version must equal 1.');
  const state = { errors, references: [] as WorkflowTransformReference[], nodes: 0 };
  validateExpression(value.expression, state, 'transform.expression', 1, false);
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    transform: structuredClone(value) as unknown as WorkflowTransformV1,
    references: state.references,
  };
}

export type ParseWorkflowTransformAuthoringValueResult =
  | { ok: true; transform: WorkflowTransformV1 }
  | { ok: false; message: string };

/** Accept the MCP's JSON-string carrier or an already-structured dashboard value. */
export function parseWorkflowTransformAuthoringValue(value: unknown): ParseWorkflowTransformAuthoringValueResult {
  let candidate = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value); }
    catch (error) {
      return { ok: false, message: `transform JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const validation = validateWorkflowTransform(candidate);
  return validation.ok
    ? { ok: true, transform: validation.transform }
    : { ok: false, message: validation.errors.join(' ') };
}

interface TransformEvaluationContext {
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
  item?: unknown;
}

interface TransformEvaluationBudget {
  evaluations: number;
  items: number;
}

function consumeEvaluation(budget: TransformEvaluationBudget, items = 0): void {
  budget.evaluations += 1;
  budget.items += items;
  if (budget.evaluations > WORKFLOW_TRANSFORM_MAX_EVALUATIONS) {
    throw new WorkflowTransformError(`evaluation exceeded ${WORKFLOW_TRANSFORM_MAX_EVALUATIONS} expression operations.`);
  }
  if (budget.items > WORKFLOW_TRANSFORM_MAX_EVALUATIONS) {
    throw new WorkflowTransformError(`evaluation exceeded ${WORKFLOW_TRANSFORM_MAX_EVALUATIONS} item visits.`);
  }
}

function asBoundedArray(value: unknown, op: string, budget: TransformEvaluationBudget): unknown[] {
  if (!Array.isArray(value)) throw new WorkflowTransformError(`${op} requires an array input.`);
  if (value.length > WORKFLOW_TRANSFORM_MAX_ITEMS) {
    throw new WorkflowTransformError(`${op} received ${value.length} items (cap ${WORKFLOW_TRANSFORM_MAX_ITEMS}).`);
  }
  consumeEvaluation(budget, value.length);
  return value;
}

function asRows(value: unknown, op: string, budget: TransformEvaluationBudget): TableRow[] {
  const rows = asBoundedArray(value, op, budget);
  if (!rows.every(isRecord)) throw new WorkflowTransformError(`${op} requires an array of objects.`);
  return rows as TableRow[];
}

function boundedValueBytes(value: unknown, at: string): number {
  const bytes = jsonByteLength(value);
  if (bytes === null) throw new WorkflowTransformError(`${at} is not JSON-compatible.`);
  if (bytes > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) {
    throw new WorkflowTransformError(`${at} is ${bytes} bytes (cap ${WORKFLOW_TRANSFORM_MAX_VALUE_BYTES}).`);
  }
  return bytes;
}

function addCompositeBytes(current: number, value: unknown, at: string): number {
  const next = current + boundedValueBytes(value, at) + 1;
  if (next > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) {
    throw new WorkflowTransformError(`${at} would exceed the ${WORKFLOW_TRANSFORM_MAX_VALUE_BYTES}-byte output cap.`);
  }
  return next;
}

function evaluateExpression(
  expression: WorkflowTransformExpressionV1,
  context: TransformEvaluationContext,
  budget: TransformEvaluationBudget,
): unknown {
  consumeEvaluation(budget);
  switch (expression.op) {
    case 'literal':
      return structuredClone(expression.value);
    case 'get': {
      const value = resolveFrom(expression.from, context.inputs, context.stepOutputs, context.item);
      if (value === undefined) throw new WorkflowTransformError(`source "${expression.from}" did not resolve.`);
      return value;
    }
    case 'jsonParse': {
      const raw = evaluateExpression(expression.value, context, budget);
      if (typeof raw !== 'string') throw new WorkflowTransformError('jsonParse requires a string input.');
      if (Buffer.byteLength(raw, 'utf8') > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) {
        throw new WorkflowTransformError(`jsonParse input exceeds ${WORKFLOW_TRANSFORM_MAX_VALUE_BYTES} bytes.`);
      }
      try { return JSON.parse(raw); }
      catch (error) {
        throw new WorkflowTransformError(`jsonParse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    case 'jsonStringify': {
      const value = evaluateExpression(expression.value, context, budget);
      const issue = jsonCompatibilityError(value, 'jsonStringify input');
      if (issue) throw new WorkflowTransformError(issue);
      const rendered = JSON.stringify(value);
      boundedValueBytes(rendered, 'jsonStringify output');
      return rendered;
    }
    case 'object': {
      const out: PlainRecord = {};
      let bytes = 2;
      for (const field of expression.fields) {
        const child = evaluateExpression(field.value, context, budget);
        bytes = addCompositeBytes(bytes, child, `object field "${field.key}"`);
        out[field.key] = child;
      }
      return out;
    }
    case 'array': {
      const out: unknown[] = [];
      let bytes = 2;
      for (const item of expression.items) {
        const child = evaluateExpression(item, context, budget);
        bytes = addCompositeBytes(bytes, child, 'array item');
        out.push(child);
      }
      return out;
    }
    case 'count': {
      const value = evaluateExpression(expression.value, context, budget);
      if (Array.isArray(value) || typeof value === 'string') return value.length;
      if (isRecord(value)) return Object.keys(value).length;
      throw new WorkflowTransformError('count requires an array, object, or string input.');
    }
    case 'map': {
      const items = asBoundedArray(evaluateExpression(expression.value, context, budget), 'map', budget);
      const out: unknown[] = [];
      let bytes = 2;
      for (const item of items) {
        const child = evaluateExpression(expression.each, { ...context, item }, budget);
        bytes = addCompositeBytes(bytes, child, 'map output item');
        out.push(child);
      }
      return out;
    }
    case 'select': {
      const rows = asRows(evaluateExpression(expression.value, context, budget), 'select', budget);
      const output = opSelect(rows, {
        where: expression.where as SelectWhere | undefined,
        columns: expression.columns,
        limit: expression.limit,
      }).rows;
      boundedValueBytes(output, 'select output');
      return output;
    }
    case 'aggregate': {
      const rows = asRows(evaluateExpression(expression.value, context, budget), 'aggregate', budget);
      const output = opAggregate(rows, expression.groupBy, (expression.metrics ?? [{ fn: 'count' }]) as AggregateMetric[]).rows;
      boundedValueBytes(output, 'aggregate output');
      return output;
    }
  }
}

/** Execute one already-validated pure transform. Validation is repeated at the
 * runtime boundary so a corrupt durable row never becomes executable. */
export function executeWorkflowTransform(input: {
  transform: unknown;
  inputs: Record<string, string>;
  stepOutputs: Record<string, unknown>;
}): unknown {
  const validation = validateWorkflowTransform(input.transform);
  if (!validation.ok) throw new WorkflowTransformError(validation.errors.join(' '));
  // Validate and size every distinct external source once. This prevents a
  // map from repeatedly serializing a large upstream value while avoiding a
  // false failure on unrelated outputs elsewhere in a long workflow.
  let sourceBytes = 2;
  const checkedSources = new Set<string>();
  for (const reference of validation.references) {
    if (reference.kind === 'item' || checkedSources.has(reference.source)) continue;
    checkedSources.add(reference.source);
    const value = resolveFrom(reference.source, input.inputs, input.stepOutputs, undefined);
    if (value === undefined) throw new WorkflowTransformError(`source "${reference.source}" did not resolve.`);
    const issue = jsonCompatibilityError(value, `source "${reference.source}"`);
    if (issue) throw new WorkflowTransformError(issue);
    sourceBytes = addCompositeBytes(sourceBytes, value, `source "${reference.source}"`);
  }
  const budget: TransformEvaluationBudget = { evaluations: 0, items: 0 };
  const output = evaluateExpression(validation.transform.expression, {
    inputs: input.inputs,
    stepOutputs: input.stepOutputs,
  }, budget);
  const compatibilityIssue = jsonCompatibilityError(output, 'transform output');
  if (compatibilityIssue) throw new WorkflowTransformError(compatibilityIssue);
  const bytes = jsonByteLength(output);
  if (bytes === null) throw new WorkflowTransformError('output is not JSON-compatible.');
  if (bytes > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) {
    throw new WorkflowTransformError(`output is ${bytes} bytes (cap ${WORKFLOW_TRANSFORM_MAX_VALUE_BYTES}).`);
  }
  return structuredClone(output);
}
