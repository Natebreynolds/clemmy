/**
 * Bounded, deterministic structural diffs for Workspace observations.
 *
 * This is a presentation/query helper, not a reconciliation engine. It never
 * decides whether a change is good, and it never grants action authority.
 * Arrays of records use a conservative stable-key inference to avoid reporting
 * every later row as changed after one insertion. Everything else is compared
 * by JSON position.
 */
import { isSecretLikeKey } from '../runtime/security.js';

export type WorkspaceChangeOperation = 'add' | 'remove' | 'replace';

export interface WorkspaceObservationChange {
  op: WorkspaceChangeOperation;
  /** Human-readable structural path. Keyed rows use `/@id=value`. */
  path: string;
  /** Stable row identity when a keyed array could be proven. */
  entityKey?: string;
  before?: string;
  after?: string;
}

export interface WorkspaceObservationDiff {
  changed: boolean;
  summary: string;
  counts: Record<WorkspaceChangeOperation, number>;
  changes: WorkspaceObservationChange[];
  truncated: boolean;
}

export interface WorkspaceObservationDiffOptions {
  maxChanges?: number;
  maxDepth?: number;
  maxPreviewChars?: number;
  maxCollectionEntries?: number;
}

const STABLE_ROW_KEYS = ['id', '_id', 'uuid', 'key', 'slug', 'email'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pointerPart(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function joinPath(base: string, part: string): string {
  return `${base}/${pointerPart(part)}`;
}

function scalarKey(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function inferredStableKey(before: unknown[], after: unknown[]): string | null {
  const rows = [...before, ...after];
  if (rows.length === 0 || !rows.every(isRecord)) return null;
  for (const candidate of STABLE_ROW_KEYS) {
    const beforeKeys = before.map((row) => scalarKey((row as Record<string, unknown>)[candidate]));
    const afterKeys = after.map((row) => scalarKey((row as Record<string, unknown>)[candidate]));
    if (beforeKeys.some((key) => key === null) || afterKeys.some((key) => key === null)) continue;
    if (new Set(beforeKeys).size !== beforeKeys.length || new Set(afterKeys).size !== afterKeys.length) continue;
    return candidate;
  }
  return null;
}

function redactedPreviewValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[nested]';
  if (Array.isArray(value)) {
    const shown = value.slice(0, 8).map((entry) => redactedPreviewValue(entry, depth + 1));
    return value.length > shown.length ? [...shown, `[+${value.length - shown.length} more]`] : shown;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.slice(0, 12).map(([key, entry]) => [
      key,
      isSecretLikeKey(key) ? '[redacted]' : redactedPreviewValue(entry, depth + 1),
    ]));
  }
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 297)}…` : value;
  return value;
}

function preview(value: unknown, maxChars: number, path: string): string {
  const containsSecretKey = path.split('/').some((part) =>
    isSecretLikeKey(part.replace(/~1/g, '/').replace(/~0/g, '~')));
  if (containsSecretKey) return '[redacted]';
  let rendered: string;
  try {
    rendered = JSON.stringify(redactedPreviewValue(value));
  } catch {
    rendered = String(value);
  }
  if (rendered === undefined) rendered = String(value);
  return rendered.length > maxChars ? `${rendered.slice(0, Math.max(0, maxChars - 1))}…` : rendered;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function diffWorkspaceObservationDocuments(
  before: unknown,
  after: unknown,
  options: WorkspaceObservationDiffOptions = {},
): WorkspaceObservationDiff {
  const maxChanges = Math.max(1, Math.min(500, options.maxChanges ?? 80));
  const maxDepth = Math.max(1, Math.min(20, options.maxDepth ?? 8));
  const maxPreviewChars = Math.max(40, Math.min(2_000, options.maxPreviewChars ?? 240));
  const maxCollectionEntries = Math.max(10, Math.min(5_000, options.maxCollectionEntries ?? 500));
  const changes: WorkspaceObservationChange[] = [];
  let truncated = false;

  const emit = (
    op: WorkspaceChangeOperation,
    path: string,
    prior: unknown,
    next: unknown,
    entityKey?: string,
  ): void => {
    if (changes.length >= maxChanges) {
      truncated = true;
      return;
    }
    changes.push({
      op,
      path,
      ...(entityKey ? { entityKey } : {}),
      ...(op !== 'add' ? { before: preview(prior, maxPreviewChars, path) } : {}),
      ...(op !== 'remove' ? { after: preview(next, maxPreviewChars, path) } : {}),
    });
  };

  const visit = (
    prior: unknown,
    next: unknown,
    path: string,
    depth: number,
    entityKey?: string,
  ): void => {
    if (changes.length >= maxChanges) {
      if (!valuesEqual(prior, next)) truncated = true;
      return;
    }
    if (valuesEqual(prior, next)) return;
    if (depth >= maxDepth) {
      emit('replace', path, prior, next, entityKey);
      truncated = true;
      return;
    }
    if (Array.isArray(prior) && Array.isArray(next)) {
      if (prior.length + next.length > maxCollectionEntries * 2) {
        emit('replace', path, prior, next, entityKey);
        truncated = true;
        return;
      }
      const stableKey = inferredStableKey(prior, next);
      if (stableKey) {
        const previousRows = new Map(prior.map((row) => [
          scalarKey((row as Record<string, unknown>)[stableKey]) as string,
          row,
        ]));
        const currentRows = new Map(next.map((row) => [
          scalarKey((row as Record<string, unknown>)[stableKey]) as string,
          row,
        ]));
        const identities = [...new Set([...previousRows.keys(), ...currentRows.keys()])].sort();
        for (const identity of identities) {
          const priorRow = previousRows.get(identity);
          const nextRow = currentRows.get(identity);
          const rowIdentity = `${stableKey}=${identity}`;
          const rowPath = joinPath(path, `@${rowIdentity}`);
          if (priorRow === undefined) emit('add', rowPath, undefined, nextRow, rowIdentity);
          else if (nextRow === undefined) emit('remove', rowPath, priorRow, undefined, rowIdentity);
          else visit(priorRow, nextRow, rowPath, depth + 1, rowIdentity);
        }
        return;
      }
      const common = Math.min(prior.length, next.length);
      for (let index = 0; index < common; index += 1) {
        visit(prior[index], next[index], joinPath(path, String(index)), depth + 1, entityKey);
      }
      for (let index = common; index < prior.length; index += 1) {
        emit('remove', joinPath(path, String(index)), prior[index], undefined, entityKey);
      }
      for (let index = common; index < next.length; index += 1) {
        emit('add', joinPath(path, String(index)), undefined, next[index], entityKey);
      }
      return;
    }
    if (isRecord(prior) && isRecord(next)) {
      const keys = [...new Set([...Object.keys(prior), ...Object.keys(next)])].sort();
      if (keys.length > maxCollectionEntries) {
        emit('replace', path, prior, next, entityKey);
        truncated = true;
        return;
      }
      for (const key of keys) {
        const nextPath = joinPath(path, key);
        if (!Object.hasOwn(prior, key)) emit('add', nextPath, undefined, next[key], entityKey);
        else if (!Object.hasOwn(next, key)) emit('remove', nextPath, prior[key], undefined, entityKey);
        else visit(prior[key], next[key], nextPath, depth + 1, entityKey);
      }
      return;
    }
    emit('replace', path, prior, next, entityKey);
  };

  visit(before, after, '', 0);
  const counts: WorkspaceObservationDiff['counts'] = { add: 0, remove: 0, replace: 0 };
  for (const change of changes) counts[change.op] += 1;
  const changed = changes.length > 0 || truncated;
  const pieces = [
    countLabel(counts.add, 'addition'),
    countLabel(counts.remove, 'removal'),
    countLabel(counts.replace, 'replacement'),
  ];
  return {
    changed,
    summary: changed
      ? `${pieces.join(', ')}${truncated ? ' (bounded; more changes exist)' : ''}`
      : 'No data changes.',
    counts,
    changes,
    truncated,
  };
}
