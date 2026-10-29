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

import { coerceOutputForContract, isBlockedStepOutput, verifyStepOutput } from '../execution/step-output-verify.js';
import type { WorkflowStepOutputContract } from '../memory/workflow-store.js';

export interface StepQuestionControl {
  kind: 'ask_owner';
  question: string;
  partialData: unknown;
}

export interface StepCapture {
  found: boolean;
  value: unknown;
  control?: StepQuestionControl;
}

type StepSubmission = { sourceUserSeq?: number } & (
  | { kind: 'result'; value: unknown }
  | { kind: 'question'; control: StepQuestionControl }
);

interface StepSubmissionSlot {
  submission?: StepSubmission;
  sourceFence?: number;
  inFlight: number;
}

// A question and a final result are competing submissions, never independent
// stores. The latest accepted submission from the current source owns the slot.
const stepSubmissions = new Map<string, StepSubmissionSlot>();
const ASK_OWNER_MAX_CHARS = 600;

function submissionSlot(sessionId: string): StepSubmissionSlot {
  let slot = stepSubmissions.get(sessionId);
  if (!slot) {
    slot = { inFlight: 0 };
    stepSubmissions.set(sessionId, slot);
  }
  return slot;
}

function dropEmptySubmissionSlot(sessionId: string, slot: StepSubmissionSlot): void {
  if (!slot.submission && slot.inFlight === 0 && stepSubmissions.get(sessionId) === slot) {
    stepSubmissions.delete(sessionId);
  }
}

function clearVisibleSubmission(sessionId: string): void {
  const slot = stepSubmissions.get(sessionId);
  if (!slot) return;
  delete slot.submission;
  // A take hides the payload immediately, but an older handler awaiting its
  // write check must not regain authority just because the newer value was read.
  // This fence exists only while such handlers are still pending.
  dropEmptySubmissionSlot(sessionId, slot);
}

function contextSourceUserSeq(sessionId: string): number | undefined {
  const ctx = getToolOutputContext();
  return ctx?.sessionId === sessionId && Number.isSafeInteger(ctx.sourceUserSeq) && (ctx.sourceUserSeq ?? 0) > 0
    ? ctx.sourceUserSeq : undefined;
}

function commitStepSubmission(sessionId: string, submission: StepSubmission): boolean {
  if (!sessionId) return false;
  const slot = submissionSlot(sessionId);
  // A handler may finish its write check after a newer accepted source has
  // submitted. Its old/unknown owner cannot overwrite that newer submission.
  if (slot.sourceFence !== undefined
    && (submission.sourceUserSeq === undefined || submission.sourceUserSeq < slot.sourceFence)) return false;
  slot.submission = submission;
  slot.sourceFence = submission.sourceUserSeq;
  return true;
}

function submissionForSource(sessionId: string, allowedSourceUserSeqs?: ReadonlySet<number>): StepSubmission | undefined {
  const submission = stepSubmissions.get(sessionId)?.submission;
  if (!submission || (allowedSourceUserSeqs !== undefined
    && (submission.sourceUserSeq === undefined || !allowedSourceUserSeqs.has(submission.sourceUserSeq)))) return undefined;
  return submission;
}

/** Runner-side: read AND clear the question a step asked the owner. */
export function takeStepQuestion(sessionId: string, allowedSourceUserSeqs?: ReadonlySet<number>): string | undefined {
  const submission = submissionForSource(sessionId, allowedSourceUserSeqs);
  if (submission?.kind !== 'question') return undefined;
  clearVisibleSubmission(sessionId);
  return submission.control.question;
}

/** The normalized shape of a question supplied to the actual handler. */
export function stepQuestionFromArgs(args: unknown): string | undefined {
  const raw = args && typeof args === 'object' ? (args as { ask_owner?: unknown }).ask_owner : undefined;
  const question = typeof raw === 'string' ? raw.trim() : '';
  return question ? question.slice(0, ASK_OWNER_MAX_CHARS) : undefined;
}

/** The submission acknowledgement returned to the MODEL inside the turn. It is
 *  transport chrome, never the deliverable: nothing outside this module may
 *  adopt it as a step output, terminal text, or blocked reason. Live
 *  2026-08-23 (runs 1787745601613-p49r2/-trnr2): two runs reported terminal
 *  blocked BY their own capture ack while the real payload sat stranded. */
export function stepResultAckText(chars: number): string {
  return `Step result captured (${chars} chars).`;
}

/** Recognizer for the ack format above — the belt that lets verdict writers
 *  refuse the echo even when a carrier smuggles it in as authored text. */
export function isStepResultAckEcho(text: string): boolean {
  return /^Step result captured \(\d+ chars\)\.$/.test(text.trim());
}

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

/** Loop-side completion fence. The workflow runner owns registration and
 * cleanup; conversation machinery may only ask whether this exact session is
 * still required to emit through the structural result channel. */
export function hasRegisteredStepContract(sessionId: string): boolean {
  return Boolean(sessionId) && stepContracts.has(sessionId);
}

/** Validate a submission against the registered contract. Returns null to
 *  ACCEPT, or the refusal message to send back to the model. */
function contractRefusal(sessionId: string, value: unknown): { refusal: string } | { accept: unknown } {
  const contract = stepContracts.get(sessionId);
  if (!contract) return { accept: value };
  // Bind exactly like the authoritative reduce gate (fence extraction etc.) and
  // gate on the BOUND value — the raw-value check refused payloads the reduce
  // gate passed (workflow contract review, defect B). Record the bound value so
  // downstream receives what the gate approved.
  const bound = coerceOutputForContract(value, contract);
  if (isBlockedStepOutput(bound)) return { accept: bound }; // honest blocks bypass shape checks
  const result = verifyStepOutput(contract, bound);
  if (result.ok) return { accept: bound };
  const used = contractRefusals.get(sessionId) ?? 0;
  if (used >= MAX_CONTRACT_REFUSALS) return { accept: bound }; // reduce gate stays authoritative
  contractRefusals.set(sessionId, used + 1);
  return { refusal: 'Step result REJECTED (not captured) — fix these and call workflow_step_result again: '
    + result.problems.join('; ')
    + '. Submit `data` as ONE valid JSON object with exactly the contracted keys and types.'
    + ' If you are genuinely blocked, submit {"blocked": true, "reason": "<specifics>"} as plain JSON (no code fences).' };
}

/** Handler-side: record a step's structured result for `sessionId`. */
export function recordStepResult(sessionId: string, value: unknown): void {
  commitStepSubmission(sessionId, { kind: 'result', value, sourceUserSeq: contextSourceUserSeq(sessionId) });
}

/** Runner-side: read AND clear the recorded result for `sessionId`.
 *  Returns `{ found, value }` so an explicit `null`/empty result is
 *  distinguishable from "the step never called the tool". */
export function takeStepResult(sessionId: string, allowedSourceUserSeqs?: ReadonlySet<number>): { found: boolean; value: unknown } {
  const submission = submissionForSource(sessionId, allowedSourceUserSeqs);
  if (submission?.kind !== 'result') return { found: false, value: undefined };
  clearVisibleSubmission(sessionId);
  return { found: true, value: submission.value };
}

/** Loop-side: check whether a step result exists without consuming it.
 *  The workflow runner remains the only owner that takes/clears the payload. */
export function peekStepResult(sessionId: string): { found: boolean; value: unknown } {
  const submission = submissionForSource(sessionId);
  return submission?.kind === 'result'
    ? { found: true, value: submission.value }
    : { found: false, value: undefined };
}

/** Full host capture, separate from the legacy completed-result reader. A
 * question remains honestly blocked to old readers; its complete partial data
 * belongs only to outer host control metadata, never a completed step output. */
export function peekStepCapture(sessionId: string, allowedSourceUserSeqs?: ReadonlySet<number>): StepCapture {
  const submission = submissionForSource(sessionId, allowedSourceUserSeqs);
  if (!submission) return { found: false, value: undefined };
  return submission.kind === 'result'
    ? { found: true, value: submission.value }
    : { found: true, value: { blocked: true, reason: submission.control.question }, control: submission.control };
}

/** Test/maintenance: drop a session's pending result without reading. */
export function clearStepResult(sessionId: string, allowedSourceUserSeqs?: ReadonlySet<number>): void {
  if (submissionForSource(sessionId, allowedSourceUserSeqs)) clearVisibleSubmission(sessionId);
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
export function recordStepResultFromTranscript(sessionId: string, text: string, sourceUserSeq?: number): boolean {
  if (!sessionId || !text || stepSubmissions.get(sessionId)?.submission) return false;
  const value = extractBalancedJsonCall(text) ?? extractXmlCall(text);
  if (value === undefined) return false;
  // A salvaged transcript call gets the same submission gate as a real one —
  // but without the refusal loop (nobody is listening); it simply isn't
  // recorded, and the runner's no-result path reports honestly.
  const contract = stepContracts.get(sessionId);
  const bound = contract ? coerceOutputForContract(value, contract) : value;
  if (contract && !isBlockedStepOutput(bound) && !verifyStepOutput(contract, bound).ok) return false;
  const source = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
    ? sourceUserSeq : contextSourceUserSeq(sessionId);
  return commitStepSubmission(sessionId, { kind: 'result', value: bound, sourceUserSeq: source });
}

/** How long the result call waits on its step's write check, well inside
 * the call's own deadline; a check still running then finishes on its own. */
const STEP_WRITE_CHECK_WAIT_MS = 40_000;

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
      ask_owner: z
        .string()
        .max(ASK_OWNER_MAX_CHARS)
        .optional()
        .describe('Only when this step cannot finish without the owner\'s own answer or decision: the one question, in plain words. '
          + 'The run then waits for their answer and resumes this step with it; pass what you have so far as data. Never guess an answer only the owner can give.'),
    },
    async ({ data, ask_owner }: { data: string; ask_owner?: string }) => {
      const ctx = getToolOutputContext();
      const sessionId = ctx?.sessionId;
      // Snapshot before awaiting the write check. The eventual commit and ACK
      // must still belong to the source that actually called this handler.
      const sourceUserSeq = sessionId ? contextSourceUserSeq(sessionId) : undefined;
      const value = coerceStepData(data);
      const question = stepQuestionFromArgs({ ask_owner });
      if (!sessionId) {
        return textResult('Step result received (no step context to bind it to).');
      }
      if (sourceUserSeq === undefined) {
        return textResult('Not recorded. This submission has no accepted source to bind it to.');
      }
      const slot = submissionSlot(sessionId);
      slot.inFlight += 1;
      try {
        if (question) {
          if (!commitStepSubmission(sessionId, { kind: 'question', sourceUserSeq,
            control: { kind: 'ask_owner', question, partialData: value } })) {
            return textResult('Not recorded. A newer accepted source owns this step submission.');
          }
          return textResult('Your question is with the owner. This run waits for their answer and resumes this step with it. End your turn now.');
        }
        const gate = contractRefusal(sessionId, value);
        if ('refusal' in gate) return textResult(gate.refusal);
        // This step's recoverable writes ran when proposed; they are checked
        // together against its saved instructions before the result counts.
        const { checkStepWritesWithin } = await import('../runtime/harness/authored-workflow-write-authority.js');
        const check = await checkStepWritesWithin(sessionId, STEP_WRITE_CHECK_WAIT_MS);
        if (check.status === 'correct') {
          return textResult(`Not recorded yet. A check of the writes this step made found: ${check.reason} `
            + 'Correct those writes now (they can be changed), then call workflow_step_result again with the result.');
        }
        if (!commitStepSubmission(sessionId, { kind: 'result', value: gate.accept, sourceUserSeq })) {
          return textResult('Not recorded. A newer accepted source owns this step submission.');
        }
        return textResult(stepResultAckText(data.length));
      } finally {
        slot.inFlight -= 1;
        dropEmptySubmissionSlot(sessionId, slot);
      }
    },
  );
}
