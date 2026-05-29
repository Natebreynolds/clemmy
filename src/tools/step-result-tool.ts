import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

/**
 * workflow_step_result — the explicit structured-output channel for a
 * workflow step (the "real cure" for the prose-handoff problem).
 *
 * A workflow step is a deterministic unit: it does its one job and emits
 * its result HERE, as structured data, which becomes stepOutputs[stepId]
 * for the next step to consume — instead of the runner scraping the
 * agent's chat reply (prose), which starved downstream steps and caused
 * them to flail/re-queue the whole workflow.
 *
 * Capture mechanism: the handler stashes the FULL value (keyed by the
 * step's harness sessionId) in a module-local store; runStepViaHarness
 * reads it back with takeStepResult() after the step finishes. We do NOT
 * read it from the tool_called event log because that copy is clipped to
 * 8KB — a 50-row result would be truncated. The handler input is
 * unclipped, so the store has the real value.
 */

const stepResults = new Map<string, unknown>();

/** Handler-side: record a step's structured result for `sessionId`. */
export function recordStepResult(sessionId: string, value: unknown): void {
  if (!sessionId) return;
  stepResults.set(sessionId, value);
}

/** Runner-side: read AND clear the recorded result for `sessionId`.
 *  Returns `{ found, value }` so an explicit `null`/empty result is
 *  distinguishable from "the step never called the tool". */
export function takeStepResult(sessionId: string): { found: boolean; value: unknown } {
  if (!sessionId || !stepResults.has(sessionId)) return { found: false, value: undefined };
  const value = stepResults.get(sessionId);
  stepResults.delete(sessionId);
  return { found: true, value };
}

/** Test/maintenance: drop a session's pending result without reading. */
export function clearStepResult(sessionId: string): void {
  stepResults.delete(sessionId);
}

/**
 * Coerce the model-supplied `data` string into structured form when it's
 * valid JSON, else keep it as the raw string. Mirrors how the
 * deterministic-step runner treats stdout (JSON-if-parseable, else text).
 */
function coerceStepData(data: string): unknown {
  const trimmed = data.trim();
  if (!trimmed) return '';
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON despite the leading brace — keep the raw string.
    }
  }
  return data;
}

export function registerStepResultTool(server: McpServer): void {
  server.tool(
    'workflow_step_result',
    'Emit THIS workflow step\'s result as structured data — the explicit output the next step consumes. '
      + 'Call it exactly once, as your final action, with `data` = your result as a JSON string (preferred) or plain text. '
      + 'This replaces relying on your chat reply: downstream steps read `{{steps.<thisStep>.output}}` from what you pass here. '
      + 'Pass the COMPLETE structured payload the next step needs (e.g. the full array of records), not a summary of it.',
    {
      data: z
        .string()
        .min(1)
        .describe('The step result. Prefer a JSON object/array as a string; plain text is accepted for narrative steps.'),
    },
    async ({ data }: { data: string }) => {
      const ctx = getToolOutputContext();
      const sessionId = ctx?.sessionId;
      const value = coerceStepData(data);
      if (sessionId) {
        recordStepResult(sessionId, value);
        return textResult(`Step result captured (${data.length} chars).`);
      }
      // No session context — can't correlate to a step. Don't throw;
      // the runner's prose fallback will cover it.
      return textResult('Step result received (no step context to bind it to).');
    },
  );
}
