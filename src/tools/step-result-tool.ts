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

import { isBlockedStepOutput, verifyStepOutput } from '../execution/step-output-verify.js';
import type { WorkflowStepOutputContract } from '../memory/workflow-store.js';

const stepResults = new Map<string, unknown>();

// Self-heal move 2 (2026-07-14): the step's OUTPUT CONTRACT, registered by the
// workflow runner for the step session's lifetime. workflow_step_result
// validates against it AT SUBMISSION and refuses with the exact problems so
// the model fixes its own output in-turn — previously a doomed result was
// captured silently and the run died minutes later at the reduce gate, after
// the only agent who could fix it was gone. Bounded: after
// MAX_CONTRACT_REFUSALS the result is accepted and the reduce gate stays
// authoritative (a stubborn model must not spin forever). Fail-open: no
// registered contract -> accept exactly as before.
const stepContracts = new Map<string, WorkflowStepOutputContract>();
const contractRefusals = new Map<string, number>();
const MAX_CONTRACT_REFUSALS = 2;

export function registerStepContract(sessionId: string, contract: WorkflowStepOutputContract | undefined): void {
  if (!sessionId || !contract) return;
  stepContracts.set(sessionId, contract);
  contractRefusals.delete(sessionId);
}

export function clearStepContract(sessionId: string): void {
  stepContracts.delete(sessionId);
  contractRefusals.delete(sessionId);
}

/** Validate a submission against the registered contract. Returns null to
 *  ACCEPT, or the refusal message to send back to the model. */
function contractRefusal(sessionId: string, value: unknown): string | null {
  const contract = stepContracts.get(sessionId);
  if (!contract) return null;
  if (isBlockedStepOutput(value)) return null; // honest blocks bypass shape checks
  const result = verifyStepOutput(contract, value);
  if (result.ok) return null;
  const used = contractRefusals.get(sessionId) ?? 0;
  if (used >= MAX_CONTRACT_REFUSALS) return null; // reduce gate stays authoritative
  contractRefusals.set(sessionId, used + 1);
  return 'Step result REJECTED (not captured) — fix these and call workflow_step_result again: '
    + result.problems.join('; ')
    + '. Submit `data` as ONE valid JSON object with exactly the contracted keys and types.';
}

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

/** Loop-side: check whether a step result exists without consuming it.
 *  The workflow runner remains the only owner that takes/clears the payload. */
export function peekStepResult(sessionId: string): { found: boolean; value: unknown } {
  if (!sessionId || !stepResults.has(sessionId)) return { found: false, value: undefined };
  return { found: true, value: stepResults.get(sessionId) };
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

function unescapeXmlText(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceTranscriptValue(value: string): unknown {
  const trimmed = unescapeXmlText(value).trim();
  if (!trimmed) return '';
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(trimmed) || /^[[{"]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? coerceStepData(parsed) : parsed;
    } catch {
      /* keep as text */
    }
  }
  return unescapeXmlText(value);
}

function extractBalancedJsonCall(text: string): unknown | undefined {
  const call = /\bworkflow_step_result\s*\(/i.exec(text);
  if (!call) return undefined;
  let i = call.index + call[0].length;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const open = text[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : open === '"' ? '"' : '';
  if (!close) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      if (open === '"' && !inString) {
        try {
          const parsed = JSON.parse(text.slice(i, j + 1));
          return typeof parsed === 'string' ? coerceStepData(parsed) : parsed;
        } catch {
          return undefined;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (open !== '"' && ch === open) depth += 1;
    if (open !== '"' && ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(i, j + 1));
          return typeof parsed === 'string' ? coerceStepData(parsed) : parsed;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function extractXmlCall(text: string): unknown | undefined {
  const invoke = /<invoke\s+name=["']workflow_step_result["'][^>]*>([\s\S]{0,4000}?)<\/invoke>/i.exec(text);
  if (!invoke?.[1]) return undefined;
  const params = [...invoke[1].matchAll(/<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi)];
  if (params.length === 0) return undefined;
  const dataParam = params.find((m) => m[1] === 'data');
  if (dataParam?.[2]) return coerceStepData(unescapeXmlText(dataParam[2]));
  const out: Record<string, unknown> = {};
  for (const match of params) {
    const key = match[1];
    if (!key) continue;
    out[key] = coerceTranscriptValue(match[2] ?? '');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Best-effort repair for models that write the inert structural result call
 *  as text instead of invoking the tool. Never executes arbitrary tools. */
export function recordStepResultFromTranscript(sessionId: string, text: string): boolean {
  if (!sessionId || !text || stepResults.has(sessionId)) return false;
  const value = extractBalancedJsonCall(text) ?? extractXmlCall(text);
  if (value === undefined) return false;
  // A salvaged transcript call gets the same submission gate as a real one —
  // but without the refusal loop (nobody is listening); it simply isn't
  // recorded, and the runner's no-result path reports honestly.
  const contract = stepContracts.get(sessionId);
  if (contract && !isBlockedStepOutput(value) && !verifyStepOutput(contract, value).ok) return false;
  recordStepResult(sessionId, value);
  return true;
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
        const refusal = contractRefusal(sessionId, value);
        if (refusal) return textResult(refusal);
        recordStepResult(sessionId, value);
        return textResult(`Step result captured (${data.length} chars).`);
      }
      // No session context — can't correlate to a step. Don't throw;
      // the runner's prose fallback will cover it.
      return textResult('Step result received (no step context to bind it to).');
    },
  );
}
