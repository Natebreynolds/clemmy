/**
 * workflow_state tool (2026-07-21) — the model-facing surface of the durable
 * per-workflow state store (src/execution/workflow-run-state.ts). See that
 * module for the why: recurring runs were amnesiac and duplicated work.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  filterUnprocessed,
  markProcessed,
  readWorkflowState,
  setWorkflowStateValues,
} from '../execution/workflow-run-state.js';
import { textResult } from './shared.js';

export function registerWorkflowStateTools(server: McpServer): void {
  server.tool(
    'workflow_state',
    [
      'Durable per-workflow memory that PERSISTS ACROSS RUNS — watermarks, cursors, and a processed-item ledger. A recurring workflow (hourly inbox scrape, daily follow-ups) MUST use this to avoid redoing work: ',
      'action "filter_unprocessed" with candidate item ids (message ids, file ids) returns which are NEW vs already handled in prior runs — process only the fresh ones. ',
      'action "mark_processed" records item ids as done (call it AFTER the items truly completed). ',
      'action "get" reads the stored values (e.g. last-run watermark); action "set" merges values (pass null to delete a key; keep values SMALL — ids and cursors, not data). ',
      'State is keyed by the workflow name; ad-hoc/chat tasks may pass any stable name for the recurring job.',
    ].join(''),
    {
      workflow: z.string().min(1).describe('Workflow name (or a stable job name for ad-hoc recurring work).'),
      action: z.enum(['get', 'set', 'mark_processed', 'filter_unprocessed']),
      values: z.string().optional().describe('For action "set": a JSON object of values to merge (null value deletes the key).'),
      keys: z.array(z.string()).optional().describe('For "mark_processed" / "filter_unprocessed": the item keys.'),
    },
    async ({ workflow, action, values, keys }) => {
      try {
        if (action === 'get') {
          const state = readWorkflowState(workflow);
          const processedCount = Object.keys(state.processed).length;
          return textResult(JSON.stringify({
            values: state.values,
            processedCount,
            updatedAt: state.updatedAt,
            note: processedCount > 0 ? 'Use filter_unprocessed with candidate ids instead of reading the full ledger.' : undefined,
          }));
        }
        if (action === 'set') {
          if (!values) return textResult('ERROR: action "set" needs `values` — a JSON object to merge.');
          let patch: unknown;
          try { patch = JSON.parse(values); } catch { return textResult('ERROR: `values` must be valid JSON (an object).'); }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return textResult('ERROR: `values` must be a JSON object of key/value pairs.');
          }
          const state = setWorkflowStateValues(workflow, patch as Record<string, unknown>);
          return textResult(`Saved. State now has ${Object.keys(state.values).length} value key(s); persists across runs.`);
        }
        if (!keys || keys.length === 0) {
          return textResult(`ERROR: action "${action}" needs \`keys\` — the item ids.`);
        }
        if (action === 'mark_processed') {
          const state = markProcessed(workflow, keys);
          return textResult(`Marked ${keys.length} key(s) processed (${Object.keys(state.processed).length} total in the ledger).`);
        }
        const { fresh, seen } = filterUnprocessed(workflow, keys);
        return textResult(JSON.stringify({
          fresh,
          seenCount: seen.length,
          note: fresh.length === 0
            ? 'Every candidate was already processed in a prior run — nothing new to do for these.'
            : `Process ONLY the ${fresh.length} fresh key(s); the other ${seen.length} were completed in prior runs.`,
        }));
      } catch (err) {
        return textResult(`ERROR: workflow_state ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
