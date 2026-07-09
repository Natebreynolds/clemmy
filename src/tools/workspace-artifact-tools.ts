import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { isSensitivePath } from '../runtime/security.js';
import { getWorkspaceDirs, textResult } from './shared.js';

const ARTIFACT_QUERY_MAX_CHARS = 50_000;

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realIfPossible(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function allowedArtifactRoots(): string[] {
  const roots = [BASE_DIR, process.cwd(), ...getWorkspaceDirs()]
    .map((entry) => realIfPossible(path.resolve(expandHome(entry))));
  return [...new Set(roots)];
}

function resolveAllowedArtifactPath(input: string): string {
  const resolved = path.resolve(expandHome(input));
  if (!existsSync(resolved)) throw new Error(`File does not exist: ${resolved}`);
  const real = realpathSync(resolved);
  if (isSensitivePath(resolved) || isSensitivePath(real)) {
    throw new Error(`workspace_artifact_query refuses sensitive paths: ${resolved}`);
  }
  const roots = allowedArtifactRoots();
  if (!roots.some((root) => isInside(root, real))) {
    const rootsList = roots.map((root) => `  - ${root}`).join('\n');
    throw new Error(`Path is outside allowed artifact roots: ${real}.\nAllowed roots:\n${rootsList}`);
  }
  if (!statSync(real).isFile()) throw new Error(`Not a file: ${real}`);
  return real;
}

function parseJsonOrJsonl(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error('artifact is empty and not valid JSON');
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error('artifact is not valid JSON or JSONL — use read_file for raw text');
    }
  }
}

type PathSegment = string | number;

function jsonPathSegments(expr?: string): PathSegment[] {
  const trimmed = (expr ?? '$').trim();
  if (!trimmed || trimmed === '$' || trimmed === '.') return [];
  let body = trimmed.startsWith('$') ? trimmed.slice(1) : trimmed;
  if (body.startsWith('.')) body = body.slice(1);
  const out: PathSegment[] = [];
  const re = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match[1] != null) out.push(match[1]);
    else if (match[2] != null) out.push(Number.parseInt(match[2], 10));
  }
  return out;
}

function valueAtPath(value: unknown, expr?: string): unknown {
  let cur = value;
  for (const segment of jsonPathSegments(expr)) {
    if (typeof segment === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[segment];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
  }
  return cur;
}

function valueAtSegments(value: unknown, segments: PathSegment[]): unknown {
  let cur = value;
  for (const segment of segments) {
    if (typeof segment === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[segment];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
  }
  return cur;
}

function projectRecord(rec: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0 || !rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const segments = jsonPathSegments(field);
    if (segments.length === 0) continue;
    const value = valueAtSegments(rec, segments);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function clipQueryBody(text: string, maxChars = ARTIFACT_QUERY_MAX_CHARS): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n...[clipped to ${maxChars} chars — narrow with json_path, fields, filter, offset, or a smaller limit]`;
}

function arrayFieldSummary(obj: Record<string, unknown>): string {
  const arrays = Object.entries(obj)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => `${key}(${(value as unknown[]).length})`);
  return arrays.length > 0 ? ` Array fields: ${arrays.join(', ')}.` : '';
}

export function queryWorkspaceArtifact(input: {
  path: string;
  json_path?: string;
  fields?: string[];
  filter_field?: string;
  filter_contains?: string;
  filter_equals?: string;
  offset?: number;
  limit?: number;
  max_chars?: number;
}): string {
  const filePath = resolveAllowedArtifactPath(input.path);
  const parsed = parseJsonOrJsonl(filePath);
  const selected = valueAtPath(parsed, input.json_path);
  const where = input.json_path?.trim() || '$';
  const fields = Array.isArray(input.fields) ? input.fields.filter((f) => typeof f === 'string' && f.trim()) : undefined;
  const maxChars = Number.isFinite(input.max_chars)
    ? Math.min(ARTIFACT_QUERY_MAX_CHARS, Math.max(100, Math.trunc(input.max_chars as number)))
    : ARTIFACT_QUERY_MAX_CHARS;

  if (selected === undefined) {
    return `No value found at json_path "${where}" in ${filePath}.`;
  }

  if (Array.isArray(selected)) {
    const filterField = typeof input.filter_field === 'string' && input.filter_field.trim() ? input.filter_field : undefined;
    const contains = typeof input.filter_contains === 'string' ? input.filter_contains.toLowerCase() : undefined;
    const equals = typeof input.filter_equals === 'string' ? input.filter_equals : undefined;
    let rows = selected as unknown[];
    if (filterField && (contains !== undefined || equals !== undefined)) {
      rows = rows.filter((row) => {
        const raw = valueAtPath(row, filterField);
        const text = raw == null ? '' : String(raw);
        if (equals !== undefined) return text === equals;
        return text.toLowerCase().includes(contains as string);
      });
    }
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset as number)) : 0;
    const limit = Number.isFinite(input.limit) ? Math.min(200, Math.max(1, Math.trunc(input.limit as number))) : 50;
    const page = rows.slice(offset, offset + limit).map((row) => projectRecord(row, fields));
    const end = offset + page.length;
    const more = end < rows.length ? ` More remains — call again with offset: ${end}.` : '';
    const header = `Artifact ${filePath} at ${where}: showing ${page.length} record(s) [${offset}-${end}] of ${rows.length} matching (${selected.length} total).${more}`;
    return clipQueryBody(`${header}\n\n${JSON.stringify(page, null, 1)}`, maxChars);
  }

  if (selected && typeof selected === 'object') {
    const obj = selected as Record<string, unknown>;
    const projected = projectRecord(obj, fields);
    const header = `Artifact ${filePath} at ${where}: object with ${Object.keys(obj).length} top-level key(s).${arrayFieldSummary(obj)}`;
    return clipQueryBody(`${header}\n\n${JSON.stringify(projected, null, 1)}`, maxChars);
  }

  return `Artifact ${filePath} at ${where}: scalar ${JSON.stringify(selected)}`;
}

export function registerWorkspaceArtifactTools(server: McpServer): void {
  server.tool(
    'workspace_artifact_query',
    [
      'Query a JSON/JSONL file from a Clementine run workspace or allowed project workspace without loading the whole artifact into context.',
      'Use this when a workflow step receives a __clementine_context_ref or a run-workspace artifact path and needs exact rows/fields from a large upstream output.',
      'Set json_path to the array/object you need (examples: "rows", "data.records", "items[25]"), then use fields/filter/offset/limit to pull only the slice needed for the next action.',
      'For raw text or non-JSON files use read_file instead.',
    ].join(' '),
    {
      path: z.string().min(1).describe('Absolute or workspace-relative artifact path, usually from __clementine_context_ref.path.'),
      json_path: z.string().optional().describe('Dot/bracket path to select before querying, e.g. "rows", "data.records", or "rows[42]". Defaults to root.'),
      fields: z.array(z.string()).optional().describe('Project each record/object to these fields. Nested paths are allowed, e.g. "account.email".'),
      filter_field: z.string().optional().describe('For selected arrays, keep records where this field matches filter_contains/filter_equals. Nested paths allowed.'),
      filter_contains: z.string().optional().describe('Case-insensitive substring match for filter_field.'),
      filter_equals: z.string().optional().describe('Exact string match for filter_field.'),
      offset: z.number().int().min(0).optional().describe('Skip this many matching records. Defaults to 0.'),
      limit: z.number().int().min(1).max(200).optional().describe('Return at most this many records. Defaults to 50.'),
      max_chars: z.number().int().min(100).max(ARTIFACT_QUERY_MAX_CHARS).optional().describe('Maximum response characters. Defaults to 50000.'),
    },
    async (input: Record<string, unknown>) => {
      try {
        return textResult(queryWorkspaceArtifact(input as Parameters<typeof queryWorkspaceArtifact>[0]), { maxChars: ARTIFACT_QUERY_MAX_CHARS + 500 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(message);
      }
    },
  );
}
