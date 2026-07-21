/**
 * table_ops tool (2026-07-21) — model-facing surface of the deterministic
 * table algebra in table-ops-core.ts (the capability audit's #1 missing
 * primitive: reconcile / diff / join / dedupe / tally).
 *
 * Context-efficiency contract: inputs can come from a prior tool call's
 * PARKED FULL OUTPUT (`left_call_id`) or a staged file (`left_file`), so a
 * 10k-row sheet read is reconciled WITHOUT the rows ever entering model
 * context (the visible read was digest-clipped at 12k bytes; the park kept
 * everything). Results over the inline cap spill to a staged JSONL file
 * whose path chains straight back in as `left_file` — or onward to an
 * upload via the file pipeline.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { getToolOutput } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';
import {
  loadTableFromText,
  opAggregate,
  opDedupe,
  opDiff,
  opIntersect,
  opJoin,
  opSelect,
  type AggregateMetric,
  type SelectWhere,
  type TableOpResult,
  type TableRow,
} from './table-ops-core.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const INLINE_ROW_CAP = 100;
const INLINE_BYTE_CAP = 24 * 1024;

function loadSide(
  side: 'left' | 'right',
  input: { rows?: string; callId?: string; file?: string; path?: string },
): TableRow[] {
  const sources = [input.rows, input.callId, input.file].filter((v) => v && v.trim());
  if (sources.length === 0) {
    throw new Error(`${side} table missing — provide ${side}_rows (JSON/CSV), ${side}_call_id (a prior tool call id), or ${side}_file (a staged file path).`);
  }
  if (sources.length > 1) {
    throw new Error(`${side} table over-specified — pass exactly ONE of ${side}_rows / ${side}_call_id / ${side}_file.`);
  }
  if (input.rows?.trim()) return loadTableFromText(input.rows, { path: input.path });
  if (input.callId?.trim()) {
    const sessionId = getToolOutputContext()?.sessionId;
    if (!sessionId) throw new Error(`${side}_call_id needs a live session context — pass ${side}_rows or ${side}_file instead.`);
    const stored = getToolOutput(sessionId, input.callId.trim());
    if (!stored) throw new Error(`no stored output for call id "${input.callId}" in this session — check the id (it appears in the tool result footer).`);
    return loadTableFromText(stored.output, { path: input.path });
  }
  const filePath = path.resolve(input.file!.trim());
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${side}_file is ${Math.round(stat.size / 1024 / 1024)}MB (cap 50MB).`);
  return loadTableFromText(readFileSync(filePath, 'utf-8'), { path: input.path });
}

function renderResult(op: string, result: TableOpResult): string {
  const summary: Record<string, unknown> = {
    op,
    leftCount: result.leftCount,
    ...(result.rightCount !== undefined ? { rightCount: result.rightCount } : {}),
    resultCount: result.rows.length,
  };
  const inline = result.rows.slice(0, INLINE_ROW_CAP);
  let payload = JSON.stringify({ ...summary, rows: inline }, null, 1);
  if (result.rows.length > INLINE_ROW_CAP || Buffer.byteLength(payload, 'utf-8') > INLINE_BYTE_CAP) {
    const dir = path.join(BASE_DIR, 'files', 'table-ops');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${op}.jsonl`);
    writeFileSync(file, result.rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
    payload = JSON.stringify({
      ...summary,
      rows: inline.slice(0, 20),
      note: `Full result (${result.rows.length} rows) written to ${file} — chain it onward as left_file (another table_ops) or as a file-input to an upload tool. Do NOT retype rows from memory.`,
      filePath: file,
    }, null, 1);
  }
  return payload;
}

export function registerTableOpsTools(server: McpServer): void {
  server.tool(
    'table_ops',
    [
      'Deterministic table operations over lists/rows — diff, intersect, join, dedupe, aggregate (group+count/sum/avg/min/max), select (filter/project/limit). Use this instead of eyeballing rows in context: it is exact at any size.',
      'Inputs: pass ONE source per side — inline rows (JSON array / JSONL / CSV / TSV string), a PRIOR TOOL CALL id (left_call_id — operates on the parked FULL output even when your visible copy was truncated), or a staged file path (left_file).',
      'key = comma-separated column name(s) to match on (string compare is trimmed + case-insensitive — email-friendly).',
      'Examples: who is in the CRM but not the sheet → op:diff, left_call_id:<crm read>, right_call_id:<sheet read>, key:email. Dedupe sheet rows → op:dedupe, key:email. Tally by owner → op:aggregate, group_by:owner.',
      'Large results spill to a JSONL file whose filePath chains back in as left_file or onward to uploads.',
    ].join(' '),
    {
      op: z.enum(['diff', 'intersect', 'join', 'dedupe', 'aggregate', 'select']),
      key: z.string().optional().describe('Comma-separated match column(s). Required for diff/intersect/join/dedupe.'),
      left_rows: z.string().optional(),
      left_call_id: z.string().optional(),
      left_file: z.string().optional(),
      left_path: z.string().optional().describe('Dot-path to the row array inside JSON input (e.g. "data.items").'),
      right_rows: z.string().optional(),
      right_call_id: z.string().optional(),
      right_file: z.string().optional(),
      right_path: z.string().optional(),
      group_by: z.string().optional().describe('aggregate: comma-separated group columns.'),
      metrics: z.string().optional().describe('aggregate: comma-separated fn:column pairs, e.g. "count,sum:amount,avg:days_open". Default count.'),
      where_column: z.string().optional(),
      where_op: z.enum(['eq', 'ne', 'contains', 'empty', 'nonempty']).optional(),
      where_value: z.string().optional(),
      columns: z.string().optional().describe('select/join: comma-separated columns to keep in the result.'),
      limit: z.number().int().min(1).max(10000).optional(),
    },
    async (args) => {
      try {
        const left = loadSide('left', { rows: args.left_rows, callId: args.left_call_id, file: args.left_file, path: args.left_path });
        const keys = (args.key ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        const needsRight = args.op === 'diff' || args.op === 'intersect' || args.op === 'join';
        const needsKey = needsRight || args.op === 'dedupe';
        if (needsKey && keys.length === 0) {
          return textResult(`ERROR: op "${args.op}" needs \`key\` — the column name(s) to match rows on (e.g. "email").`);
        }
        if (needsRight) {
          const right = loadSide('right', { rows: args.right_rows, callId: args.right_call_id, file: args.right_file, path: args.right_path });
          const result = args.op === 'diff' ? opDiff(left, right, keys)
            : args.op === 'intersect' ? opIntersect(left, right, keys)
            : opJoin(left, right, keys);
          const projected = args.columns
            ? opSelect(result.rows, { columns: args.columns.split(',').map((c) => c.trim()).filter(Boolean), limit: args.limit })
            : args.limit ? opSelect(result.rows, { limit: args.limit }) : null;
          return textResult(renderResult(args.op, projected ? { ...result, rows: projected.rows } : result));
        }
        if (args.op === 'dedupe') {
          return textResult(renderResult('dedupe', opDedupe(left, keys)));
        }
        if (args.op === 'aggregate') {
          const groupBy = (args.group_by ?? '').split(',').map((g) => g.trim()).filter(Boolean);
          if (groupBy.length === 0) return textResult('ERROR: op "aggregate" needs `group_by` — the column(s) to group on.');
          const metrics: AggregateMetric[] = (args.metrics ?? 'count')
            .split(',')
            .map((m) => m.trim())
            .filter(Boolean)
            .map((m) => {
              const [fn, column] = m.split(':').map((p) => p.trim());
              return { fn: fn as AggregateMetric['fn'], column: column || undefined };
            })
            .filter((m) => ['count', 'sum', 'avg', 'min', 'max'].includes(m.fn));
          return textResult(renderResult('aggregate', opAggregate(left, groupBy, metrics)));
        }
        // select
        const where: SelectWhere | undefined = args.where_column && args.where_op
          ? { column: args.where_column, op: args.where_op, value: args.where_value }
          : undefined;
        const result = opSelect(left, {
          where,
          columns: args.columns ? args.columns.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
          limit: args.limit,
        });
        return textResult(renderResult('select', result));
      } catch (err) {
        return textResult(`ERROR: table_ops ${args.op} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
