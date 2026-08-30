/**
 * ONE Codex model step, host-owned.
 *
 * The @openai/agents Runner is an extra harness on the Codex brain: it loops
 * model → tools → model, owns retries and maxTurns, and decides when a user
 * turn is "done" — a second control plane beside the graph kernel. The north
 * star makes the brain a NODE RUNNER: the host projects messages and the host
 * tool list, the model returns text and/or tool-call INTENTS, the HOST
 * executes tools and the HOST decides whether to call the model again.
 *
 * This module is that single step. It resolves the model through the SAME
 * default-provider registry codex-client boots (RouterModelProvider →
 * CodexResponsesModel under AUTH_MODE=codex_oauth, Claude/BYO otherwise), so
 * the Codex/ChatGPT OAuth wallet keeps billing agent completions and no
 * OPENAI_API_KEY is required for this path. It never executes a tool, never
 * loops, never writes an event, and never asks the user anything: budget and
 * continuation policy belong to the caller (the graph / host turn), and a
 * truncated response is reported as `limitHit` for the host to park or
 * continue — NEVER a needs_input.
 */
import { resolveHarnessModel } from './codex-client.js';
import {
  streamEventHasActionableContent,
  streamEventHasModelActivity,
} from './fallback-model.js';
import type {
  AgentInputItem,
  AgentOutputItem,
  Model,
  ModelResponse,
  ModelRequest,
  ModelSettings,
  SerializedTool,
  StreamEvent,
  Usage,
} from '@openai/agents';

export type ModelStepActivity = 'private' | 'actionable';
export type ModelStepStopReason =
  | 'completed'
  | 'tool_calls'
  | 'max_output'
  | 'content_filter'
  /**
   * Termination metadata was ABSENT and the response shape carried nothing
   * actionable — an empty or reasoning-only step.
   */
  | 'unknown'
  /**
   * Termination metadata was PRESENT and this host does not understand it:
   * `error`, `cancelled`, or a spelling that did not exist when this code was
   * written. Distinct from `unknown` on purpose — collapsing the two is what
   * allowed an explicit failure to be inferred into success from its output
   * shape. A host may never guess what an unrecognized termination meant.
   */
  | 'unrecognized';

export interface CodexOneStepInput {
  /** Model id routed through the registered default provider. */
  modelId?: string;
  systemInstructions?: string;
  /** Host-projected conversation (or a bare user string). */
  input: string | AgentInputItem[];
  /** Host tool list — schemas only; execution stays with the host. */
  tools?: SerializedTool[];
  modelSettings?: ModelSettings;
  /** Optional provider-visible structured output contract. The host still
   * performs exact local admission; this never grants tool authority. */
  outputType?: ModelRequest['outputType'];
  signal?: AbortSignal;
  /** Threads provider-side conversation state when the host wants it. */
  previousResponseId?: string;
  /** Use the provider stream as the one-step transport. The host runner sets
   * this so liveness is based on semantic activity rather than one fixed wall.
   * Direct utility callers may retain getResponse compatibility. */
  stream?: boolean;
  /** Semantic stream activity. Handshake/keepalive metadata never calls it. */
  onActivity?: (activity: ModelStepActivity) => void;
  /** Final provider-neutral request boundary. A rejection here stops before
   * either streaming or non-streaming model I/O. */
  beforeModelDispatch?: (request: ModelRequest) => Promise<void> | void;
  /** Test seam: model resolution injection. Production always resolves
   *  through codex-client's credential router (OAuth wallet). */
  resolveModel?: (modelId?: string) => Promise<Model> | Model;
}

export interface CodexOneStepToolCall {
  callId: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  argumentsJson: string;
}

export interface CodexOneStepResult {
  /** Assistant text from this single step ('' when the model only called tools). */
  text: string;
  /** Tool-call INTENTS for the HOST to execute (or refuse). */
  toolCalls: CodexOneStepToolCall[];
  /** The raw output items, for hosts that project history themselves. */
  output: AgentOutputItem[];
  /** True when the provider reports the response was cut short (length/limit).
   *  The host decides park/continue; this module never converts it to an ask. */
  limitHit: boolean;
  /** Provider-neutral completion reason observed from raw stream metadata,
   * response metadata, or (last) the current response's actionable shape. */
  stopReason: ModelStepStopReason;
  /**
   * The provider's exact termination spelling, kept ONLY when this host could
   * not interpret it. Diagnostics are private: this is for a log or a ledger
   * row, never for model-visible history.
   */
  rawStopReason?: string;
  /**
   * WHERE the stop reason came from. `stopReason` alone cannot say whether
   * `completed` was the provider's word or this host's reading of the output
   * shape — and the difference decides whether a contradiction check is even
   * meaningful. Inference has nothing to contradict.
   */
  terminationEvidence: 'absent' | 'recognized' | 'unrecognized' | 'failure';
  usage?: Usage;
  responseId?: string;
}

/**
 * THE RESPONSE-ADMISSION BOUNDARY.
 *
 * One place decides whether a model response is authoritative enough to enter
 * durable history, trigger approval, execute tools, or complete a turn. It is
 * pure and provider-neutral: it reads the normalized stop reason and the
 * response's own shape, and nothing else. No provider name, no model id, no
 * tool name, no prompt text may influence it.
 *
 * Every refusal here is a REFUSAL, not a downgrade: a blocked step yields no
 * text to answer with and no calls to execute, and its bytes never reach the
 * next request.
 */
export type ModelStepAdmission =
  | {
      admitted: true;
      kind: 'completed' | 'tool_calls';
      /**
       * The sole authoritative projection of this response. Callers must
       * persist `frame.history`, present its text, and execute its calls;
       * `CodexOneStepResult.output/text/toolCalls` remain transport
       * diagnostics and compatibility data only.
       */
      frame: Extract<ModelOutputFrame, { valid: true }>;
    }
  | { admitted: false; reason: ModelStepBlockedReason };

export type ModelStepBlockedReason =
  | 'provider_limit_hit'
  | 'provider_content_filter'
  | 'provider_unrecognized_stop'
  | 'provider_reported_failure'
  | 'provider_stop_contradiction'
  | 'model_incomplete_output'
  | 'model_unsupported_output'
  | 'model_malformed_tool_call'
  | 'model_empty_completion';

/**
 * Actionable output shapes this host does NOT execute. A response carrying one
 * is not a completion with a harmless extra item — it is a response whose
 * intent the host cannot carry out, and admitting its text would answer the
 * user while silently dropping the action the model believed it was taking.
 *
 * Provider-neutral by construction: these are canonical output-item kinds, not
 * vendor names.
 */
const UNSUPPORTED_ACTIONABLE_ITEMS = new Set([
  'hosted_tool_call',
  'tool_search_call',
  'computer_call',
  'shell_call',
  'apply_patch_call',
  'code_interpreter_call',
  'file_search_call',
  'web_search_call',
  'image_generation_call',
  'local_shell_call',
]);

/** Item lifecycle values that mean "this item is not finished". */
const ITEM_NOT_FINAL = new Set(['incomplete', 'in_progress']);

function own(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function optionalRecordClone(value: unknown):
  | { valid: true; value?: Record<string, unknown> }
  | { valid: false } {
  if (value === undefined) return { valid: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  try {
    return { valid: true, value: structuredClone(value as Record<string, unknown>) };
  } catch {
    return { valid: false };
  }
}

/**
 * THE OUTPUT-FRAME VALIDATOR — pure, provider-neutral, shape-only.
 *
 * Termination metadata says why the model stopped; this says what it actually
 * produced. Both must agree before anything is admitted, because either alone
 * is forgeable by an incomplete response: a lifecycle `completed` envelope can
 * still carry an unfinished assistant message, and a well-formed-looking call
 * can still have no id to settle against.
 */
export type ModelOutputFrame =
  | { valid: true; kind: 'completed'; text: string; history: AgentInputItem[] }
  | {
      valid: true;
      kind: 'tool_calls';
      calls: CodexOneStepToolCall[];
      preamble: string;
      history: AgentInputItem[];
    }
  | { valid: false; reason: ModelStepBlockedReason };

export function validateOutputFrame(output: AgentOutputItem[]): ModelOutputFrame {
  const calls: CodexOneStepToolCall[] = [];
  const history: AgentInputItem[] = [];
  const seenCallIds = new Set<string>();
  let text = '';
  let sawCompletedAssistant = false;
  let sawRefusal = false;

  for (const item of output) {
    if (!item || typeof item !== 'object') return { valid: false, reason: 'model_unsupported_output' };
    const source = item as unknown as Record<string, unknown>;
    const type = source.type;
    if (typeof type !== 'string') return { valid: false, reason: 'model_unsupported_output' };
    if (UNSUPPORTED_ACTIONABLE_ITEMS.has(type)) {
      return { valid: false, reason: 'model_unsupported_output' };
    }

    // Private continuation items are explicitly allowlisted and rebuilt from
    // their closed protocol shape. They may accompany either valid frame but
    // are never presentable or actionable on their own.
    if (type === 'reasoning') {
      if (own(source, 'status')) return { valid: false, reason: 'model_unsupported_output' };
      if (!Array.isArray(source.content)) return { valid: false, reason: 'model_unsupported_output' };
      const content: Array<Record<string, unknown>> = [];
      for (const rawPart of source.content) {
        if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
          return { valid: false, reason: 'model_unsupported_output' };
        }
        const part = rawPart as Record<string, unknown>;
        if (part.type !== 'input_text' || typeof part.text !== 'string') {
          return { valid: false, reason: 'model_unsupported_output' };
        }
        const partProviderData = optionalRecordClone(part.providerData);
        if (!partProviderData.valid) return { valid: false, reason: 'model_unsupported_output' };
        if (
          part.promptCacheBreakpoint !== undefined
          && (
            !part.promptCacheBreakpoint
            || typeof part.promptCacheBreakpoint !== 'object'
            || Array.isArray(part.promptCacheBreakpoint)
            || (part.promptCacheBreakpoint as { mode?: unknown }).mode !== 'explicit'
          )
        ) return { valid: false, reason: 'model_unsupported_output' };
        content.push({
          type: 'input_text',
          text: part.text,
          ...(partProviderData.value ? { providerData: partProviderData.value } : {}),
          ...(part.promptCacheBreakpoint !== undefined
            ? { promptCacheBreakpoint: { mode: 'explicit' } }
            : {}),
        });
      }
      let rawContent: Array<Record<string, unknown>> | undefined;
      if (source.rawContent !== undefined) {
        if (!Array.isArray(source.rawContent)) return { valid: false, reason: 'model_unsupported_output' };
        rawContent = [];
        for (const rawPart of source.rawContent) {
          if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
            return { valid: false, reason: 'model_unsupported_output' };
          }
          const part = rawPart as Record<string, unknown>;
          if (part.type !== 'reasoning_text' || typeof part.text !== 'string') {
            return { valid: false, reason: 'model_unsupported_output' };
          }
          const partProviderData = optionalRecordClone(part.providerData);
          if (!partProviderData.valid) return { valid: false, reason: 'model_unsupported_output' };
          rawContent.push({
            type: 'reasoning_text',
            text: part.text,
            ...(partProviderData.value ? { providerData: partProviderData.value } : {}),
          });
        }
      }
      const providerData = optionalRecordClone(source.providerData);
      if (!providerData.valid) return { valid: false, reason: 'model_unsupported_output' };
      if (source.id !== undefined && typeof source.id !== 'string') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      history.push({
        type: 'reasoning',
        content,
        ...(rawContent ? { rawContent } : {}),
        ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(providerData.value ? { providerData: providerData.value } : {}),
      } as unknown as AgentInputItem);
      continue;
    }

    if (type === 'compaction') {
      if (typeof source.encrypted_content !== 'string' || !source.encrypted_content) {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      if (source.id !== undefined && typeof source.id !== 'string') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      if (source.created_by !== undefined && typeof source.created_by !== 'string') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      const providerData = optionalRecordClone(source.providerData);
      if (!providerData.valid) return { valid: false, reason: 'model_unsupported_output' };
      history.push({
        type: 'compaction',
        encrypted_content: source.encrypted_content,
        ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(typeof source.created_by === 'string' ? { created_by: source.created_by } : {}),
        ...(providerData.value ? { providerData: providerData.value } : {}),
      } as unknown as AgentInputItem);
      continue;
    }

    if (type === 'message') {
      if (source.role !== 'assistant') return { valid: false, reason: 'model_unsupported_output' };
      if (typeof source.status === 'string' && ITEM_NOT_FINAL.has(source.status)) {
        return { valid: false, reason: 'model_incomplete_output' };
      }
      // Assistant messages have a required, exact lifecycle in the installed
      // protocol. Missing, malformed, failed, or future values are not
      // silently read as completed.
      if (source.status !== 'completed') return { valid: false, reason: 'model_unsupported_output' };
      if (!Array.isArray(source.content)) return { valid: false, reason: 'model_unsupported_output' };
      const content: Array<Record<string, unknown>> = [];
      let body = '';
      for (const rawPart of source.content) {
        if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
          return { valid: false, reason: 'model_unsupported_output' };
        }
        const part = rawPart as Record<string, unknown>;
        const partProviderData = optionalRecordClone(part.providerData);
        if (!partProviderData.valid) return { valid: false, reason: 'model_unsupported_output' };
        if (part.type === 'output_text' && typeof part.text === 'string') {
          body += part.text;
          content.push({
            type: 'output_text',
            text: part.text,
            ...(partProviderData.value ? { providerData: partProviderData.value } : {}),
          });
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          sawRefusal = true;
          body += part.refusal;
          content.push({
            type: 'refusal',
            refusal: part.refusal,
            ...(partProviderData.value ? { providerData: partProviderData.value } : {}),
          });
        } else {
          return { valid: false, reason: 'model_unsupported_output' };
        }
      }
      if (source.id !== undefined && typeof source.id !== 'string') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      const providerData = optionalRecordClone(source.providerData);
      if (!providerData.valid) return { valid: false, reason: 'model_unsupported_output' };
      history.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content,
        ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(providerData.value ? { providerData: providerData.value } : {}),
      } as unknown as AgentInputItem);
      if (body.trim()) {
        sawCompletedAssistant = true;
        text += body;
      }
      continue;
    }

    if (type === 'function_call') {
      if (typeof source.status === 'string' && ITEM_NOT_FINAL.has(source.status)) {
        return { valid: false, reason: 'model_incomplete_output' };
      }
      if (source.status !== undefined && source.status !== 'completed') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      if (source.namespace !== undefined) return { valid: false, reason: 'model_unsupported_output' };
      const callId = typeof source.callId === 'string'
        ? source.callId.trim()
        : typeof source.call_id === 'string' ? source.call_id.trim() : '';
      const name = typeof source.name === 'string' ? source.name.trim() : '';
      // A blank id cannot be settled and a duplicate id cannot be told apart
      // from its twin — either makes the call ledger ambiguous before it opens.
      if (!callId || !name) return { valid: false, reason: 'model_malformed_tool_call' };
      if (seenCallIds.has(callId)) return { valid: false, reason: 'model_malformed_tool_call' };
      // Arguments cross the wire as a string. Re-serializing an object here
      // would invent bytes the model never produced.
      if (typeof source.arguments !== 'string') {
        return { valid: false, reason: 'model_malformed_tool_call' };
      }
      if (source.id !== undefined && typeof source.id !== 'string') {
        return { valid: false, reason: 'model_unsupported_output' };
      }
      const providerData = optionalRecordClone(source.providerData);
      if (!providerData.valid) return { valid: false, reason: 'model_unsupported_output' };
      const canonicalCall: CodexOneStepToolCall = {
        callId,
        name,
        argumentsJson: source.arguments,
      };
      seenCallIds.add(callId);
      calls.push(canonicalCall);
      history.push({
        type: 'function_call',
        callId: canonicalCall.callId,
        name: canonicalCall.name,
        arguments: canonicalCall.argumentsJson,
        ...(source.status === 'completed' ? { status: 'completed' } : {}),
        ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(providerData.value ? { providerData: providerData.value } : {}),
      } as unknown as AgentInputItem);
      continue;
    }

    // Closed world: output kinds become admissible only through an explicit
    // branch above. A future passive-looking item is not persisted merely
    // because its name does not end in `_call`.
    return { valid: false, reason: 'model_unsupported_output' };
  }

  if (calls.length > 0) {
    // Completed text preamble is allowed alongside calls. A refusal plus an
    // action is contradictory authority: do not execute the action or present
    // the refusal while silently dropping it.
    if (sawRefusal) return { valid: false, reason: 'model_unsupported_output' };
    return { valid: true, kind: 'tool_calls', calls, preamble: text, history };
  }
  if (sawCompletedAssistant) return { valid: true, kind: 'completed', text, history };
  return { valid: false, reason: 'model_empty_completion' };
}

export function admitModelStep(step: CodexOneStepResult): ModelStepAdmission {
  // Provider-stated failure outranks everything: a cancelled or failed
  // response may still carry a perfectly well-formed frame, and that frame is
  // exactly what must not be believed.
  if (step.terminationEvidence === 'failure') {
    return { admitted: false, reason: 'provider_reported_failure' };
  }
  // Truncation next: a cut-short response can look complete in every other
  // respect, and its missing tail is what a shape check cannot see.
  if (step.limitHit || step.stopReason === 'max_output') {
    return { admitted: false, reason: 'provider_limit_hit' };
  }
  if (step.stopReason === 'content_filter') {
    return { admitted: false, reason: 'provider_content_filter' };
  }
  // An explicit termination this host cannot interpret is never inferred past.
  if (step.terminationEvidence === 'unrecognized' || step.stopReason === 'unrecognized') {
    return { admitted: false, reason: 'provider_unrecognized_stop' };
  }

  // The frame is validated for EVERY admission, including one whose stop
  // reason looks healthy. A lifecycle `completed` envelope does not prove the
  // assistant finished writing.
  const frame = validateOutputFrame(step.output);
  if (!frame.valid) return { admitted: false, reason: frame.reason };

  // A contradiction is only meaningful against the PROVIDER's account.
  // Inference read the same frame, so it has nothing to disagree with.
  if (step.terminationEvidence === 'recognized' && step.stopReason !== frame.kind) {
    return { admitted: false, reason: 'provider_stop_contradiction' };
  }
  return { admitted: true, kind: frame.kind, frame };
}

function textOfOutput(output: AgentOutputItem[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if ((item as { type?: string }).type !== 'message') continue;
    const message = item as { role?: string; content?: unknown };
    if (message.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const piece of content) {
      const typed = piece as { type?: string; text?: unknown };
      if ((typed.type === 'output_text' || typed.type === 'text') && typeof typed.text === 'string') {
        parts.push(typed.text);
      } else if (typed.type === 'refusal' && typeof (piece as { refusal?: unknown }).refusal === 'string') {
        parts.push((piece as { refusal: string }).refusal);
      }
    }
  }
  return parts.join('');
}

function toolCallsOfOutput(output: AgentOutputItem[]): CodexOneStepToolCall[] {
  const calls: CodexOneStepToolCall[] = [];
  for (const item of output) {
    const typed = item as {
      type?: string;
      callId?: unknown;
      call_id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (typed.type !== 'function_call') continue;
    if (typeof typed.name !== 'string') continue;
    calls.push({
      callId: typeof typed.callId === 'string'
        ? typed.callId
        : typeof typed.call_id === 'string'
          ? typed.call_id
          : '',
      name: typed.name,
      argumentsJson: typeof typed.arguments === 'string'
        ? typed.arguments
        : JSON.stringify(typed.arguments ?? {}),
    });
  }
  return calls;
}

function providerReportsTruncation(providerData: Record<string, unknown> | undefined): boolean {
  if (!providerData) return false;
  if (providerData.status !== 'incomplete') return false;
  const details = record(providerData.incomplete_details);
  if (!details || typeof details.reason !== 'string') return false;
  return new Set(['max_output_tokens', 'max_tokens', 'token_limit', 'length'])
    .has(normalizedToken(details.reason));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

type TerminationField =
  | { present: false }
  | { present: true; value: unknown };

const ABSENT_TERMINATION_FIELD: TerminationField = { present: false };

/**
 * AI SDK v3 exposes finish truth as the provider-neutral
 * `{ unified, raw }` record rather than a bare string. Normalize only that
 * exact closed shape here. Provider-specific `raw` remains diagnostic and can
 * never override the SDK's canonical `unified` value.
 */
function terminationFieldValue(value: unknown): unknown {
  const structured = record(value);
  if (!structured) return value;
  const keys = Object.keys(structured).sort();
  if (!own(structured, 'unified') || keys.some((key) => key !== 'raw' && key !== 'unified')) {
    return value;
  }
  if (typeof structured.unified !== 'string' || !structured.unified.trim()) return value;
  if (own(structured, 'raw') && structured.raw !== undefined && typeof structured.raw !== 'string') {
    return value;
  }
  return structured.unified;
}

function mergeTerminationFields(
  current: TerminationField,
  next: TerminationField,
): TerminationField {
  if (!next.present) return current;
  if (!current.present) return next;
  if (
    typeof current.value === 'string'
    && typeof next.value === 'string'
    && normalizedToken(current.value) === normalizedToken(next.value)
  ) return current;
  // Multiple explicit spellings that do not agree are themselves malformed
  // evidence. Represent the conflict as a non-string value so readTermination
  // fails closed; never let a later healthy spelling erase an earlier failure,
  // future value, or null.
  return { present: true, value: { conflictingTerminationEvidence: true } };
}

/** Locate bounded termination evidence without laundering null/malformed
 * fields into absence. Generic nested `reason` fields are deliberately not
 * stop authority; provider adapters must project them onto a canonical key. */
function terminationField(
  value: unknown,
  depth = 0,
  nullIsProvisionalAbsence = false,
): TerminationField {
  const source = record(value);
  if (!source || depth > 3) return ABSENT_TERMINATION_FIELD;
  let observed: TerminationField = ABSENT_TERMINATION_FIELD;
  for (const key of ['finishReason', 'finish_reason', 'stopReason', 'stop_reason']) {
    if (own(source, key)) {
      // Streaming Chat Completions deltas routinely carry
      // `finish_reason:null` until the terminal chunk. A `model` event is not
      // the final response envelope, so that one exact provisional spelling
      // is absence there. Null on response_done/non-stream responses remains
      // explicit malformed evidence and fails closed.
      if (!(nullIsProvisionalAbsence && source[key] === null)) {
        observed = mergeTerminationFields(observed, {
          present: true,
          value: terminationFieldValue(source[key]),
        });
      }
    }
  }
  const choices = Array.isArray(source.choices) ? source.choices : [];
  for (const choice of choices.slice(0, 2)) {
    observed = mergeTerminationFields(
      observed,
      terminationField(choice, depth + 1, nullIsProvisionalAbsence),
    );
  }
  for (const key of ['providerData', 'response']) {
    observed = mergeTerminationFields(
      observed,
      terminationField(source[key], depth + 1, nullIsProvisionalAbsence),
    );
  }
  return observed;
}

/**
 * ABSENT IS NOT THE SAME AS UNRECOGNIZED.
 *
 * These are three different facts and only the first licenses inference:
 *   absent        the provider said nothing about why it stopped, so the
 *                 response's own shape is the only evidence available.
 *   recognized    the provider said something this host understands.
 *   unrecognized  the provider said something explicit — `error`, `cancelled`,
 *                 or a spelling newer than this code — and the host does not
 *                 know what it means.
 *
 * Collapsing the last two into one `unknown` is the defect this replaces: a
 * response that explicitly reported `error` fell through to shape inference,
 * and partial text became `completed` while tool calls became `tool_calls`. An
 * explicit failure was laundered into authority to answer or to execute.
 */
type TerminationMetadata =
  | { kind: 'absent' }
  | { kind: 'recognized'; reason: Exclude<ModelStepStopReason, 'unknown' | 'unrecognized'> }
  | { kind: 'unrecognized'; raw: string }
  | { kind: 'failure'; raw: string };

/**
 * EXACT POSITIVE ALLOWLIST. Substring matching is what let `tool_call_error`
 * and `tool_use_cancelled` be read as successful tool-call completions — both
 * contain a recognized token and mean the opposite of it. A spelling earns
 * recognition by being listed, never by resembling something listed.
 */
const RECOGNIZED_STOPS = new Map<string, Exclude<ModelStepStopReason, 'unknown' | 'unrecognized'>>([
  ['stop', 'completed'],
  ['end_turn', 'completed'],
  ['complete', 'completed'],
  ['completed', 'completed'],
  ['success', 'completed'],
  ['tool_calls', 'tool_calls'],
  ['tool_call', 'tool_calls'],
  ['tool_use', 'tool_calls'],
  ['function_call', 'tool_calls'],
  ['length', 'max_output'],
  ['max_tokens', 'max_output'],
  ['max_output_tokens', 'max_output'],
  ['token_limit', 'max_output'],
  ['content_filter', 'content_filter'],
  ['safety', 'content_filter'],
]);

/** Lifecycle states that are an explicit statement of failure or non-finality. */
const LIFECYCLE_FAILURES = new Set(['failed', 'cancelled', 'canceled', 'incomplete', 'in_progress', 'queued', 'expired']);

function normalizedToken(value: string): string {
  return value.trim().toLowerCase().replace(/[ .-]+/g, '_');
}

/**
 * The response envelope's own lifecycle, read at BOUNDED canonical locations
 * only. Recursively hunting for any nested `status` would let an unrelated
 * sub-object's bookkeeping decide whether a turn may execute.
 */
function lifecycleTermination(
  providerData: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
  truncationReported: boolean,
): Extract<TerminationMetadata, { kind: 'failure' | 'unrecognized' }> | undefined {
  for (const source of [providerData, response]) {
    if (!source || !own(source, 'status')) continue;
    const status = source.status;
    if (typeof status !== 'string' || !status.trim()) {
      return {
        kind: 'unrecognized',
        raw: `malformed:status:${status === null ? 'null' : typeof status}`,
      };
    }
    const token = normalizedToken(status);
    // `incomplete` is ambiguous on its own and the envelope disambiguates it:
    // with truncation details it is a BOUNDED LIMIT, which is a more specific
    // and more actionable answer than an opaque failure. Without them it is an
    // unexplained non-final response and blocks as one. Both block; the
    // distinction is what the host can tell the user and whether continuing is
    // even meaningful.
    if (token === 'incomplete' && truncationReported) continue;
    if (LIFECYCLE_FAILURES.has(token)) return { kind: 'failure', raw: status.trim() };
    if (token !== 'completed') return { kind: 'unrecognized', raw: status.trim() };
  }
  return undefined;
}

function readTermination(field: TerminationField): TerminationMetadata {
  // A present-but-malformed field is EVIDENCE, not absence. Treating a number,
  // null or object as "nothing was said" would hand the turn back to shape
  // inference on a provider that plainly said something.
  if (!field.present) return { kind: 'absent' };
  const raw = field.value;
  if (typeof raw !== 'string') {
    return { kind: 'unrecognized', raw: `malformed:${raw === null ? 'null' : typeof raw}` };
  }
  const original = raw.trim();
  if (!original) {
    return { kind: 'unrecognized', raw: 'malformed:empty' };
  }
  const recognized = RECOGNIZED_STOPS.get(normalizedToken(original));
  if (recognized) return { kind: 'recognized', reason: recognized };
  return { kind: 'unrecognized', raw: original };
}

function inferredStopReason(output: AgentOutputItem[]): ModelStepStopReason {
  if (toolCallsOfOutput(output).length > 0) return 'tool_calls';
  return textOfOutput(output).trim() ? 'completed' : 'unknown';
}

async function streamedResponse(
  model: Model,
  request: ModelRequest,
  onActivity?: (activity: ModelStepActivity) => void,
): Promise<{ response: ModelResponse; termination?: TerminationField }> {
  let response: ModelResponse | undefined;
  let observedTermination: TerminationField = ABSENT_TERMINATION_FIELD;
  for await (const event of model.getStreamedResponse(request)) {
    const streamEvent = event as StreamEvent;
    if (streamEventHasActionableContent(streamEvent)) onActivity?.('actionable');
    else if (streamEventHasModelActivity(streamEvent)) onActivity?.('private');
    if (streamEvent.type === 'model') {
      const candidate = terminationField(streamEvent.event, 0, true);
      observedTermination = mergeTerminationFields(observedTermination, candidate);
    } else if (streamEvent.type === 'response_done') {
      response = streamEvent.response as unknown as ModelResponse;
      const candidate = terminationField(streamEvent.response);
      observedTermination = mergeTerminationFields(observedTermination, candidate);
    }
  }
  if (!response) throw new Error('model stream ended without a response_done event');
  return {
    response,
    ...(observedTermination.present ? { termination: observedTermination } : {}),
  };
}

/** One host invocation → one model request. Nothing more. */
export async function codexOneStep(input: CodexOneStepInput): Promise<CodexOneStepResult> {
  const model = await (input.resolveModel ?? resolveHarnessModel)(input.modelId);
  const request: ModelRequest = {
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    input: input.input,
    modelSettings: input.modelSettings ?? {},
    tools: input.tools ?? [],
    toolsExplicitlyProvided: true,
    outputType: input.outputType ?? 'text',
    handoffs: [],
    tracing: false,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.previousResponseId !== undefined
      ? { previousResponseId: input.previousResponseId }
      : {}),
  };
  const inspected = input.beforeModelDispatch?.(request);
  // The production recorder is synchronous, so do not introduce a microtask
  // window in which shared request inputs could change after they were sealed.
  if (inspected !== undefined) await inspected;
  const streamed = input.stream === true
    ? await streamedResponse(model, request, input.onActivity)
    : undefined;
  const response = streamed?.response ?? await model.getResponse(request);
  const output = response.output ?? [];
  const providerData = response.providerData;
  const providerTermination = terminationField(providerData);
  const responseTermination = mergeTerminationFields(
    providerTermination,
    terminationField(record(response)),
  );
  const observedTermination = mergeTerminationFields(
    streamed?.termination ?? ABSENT_TERMINATION_FIELD,
    responseTermination,
  );
  // A lifecycle failure is checked first and at bounded locations only: the
  // envelope saying `cancelled` or `failed` settles the turn regardless of how
  // healthy its finish reason or its payload look.
  const truncated = providerReportsTruncation(providerData);
  const lifecycle = lifecycleTermination(providerData, record(response), truncated);
  const termination: TerminationMetadata = lifecycle
    ?? (truncated
      ? { kind: 'recognized', reason: 'max_output' }
      : readTermination(observedTermination));
  // Shape is evidence ONLY when the provider offered none of its own.
  const stopReason: ModelStepStopReason = termination.kind === 'absent'
    ? inferredStopReason(output)
    : termination.kind === 'recognized'
      ? termination.reason
      : 'unrecognized';
  const streamedOrResponseId = response.responseId
    ?? (response as unknown as { id?: unknown }).id;
  const responseId = typeof streamedOrResponseId === 'string' && streamedOrResponseId.trim()
    ? streamedOrResponseId
    : undefined;
  return {
    text: textOfOutput(output),
    toolCalls: toolCallsOfOutput(output),
    output,
    limitHit: stopReason === 'max_output' || truncated,
    stopReason,
    terminationEvidence: termination.kind,
    ...(termination.kind === 'unrecognized' || termination.kind === 'failure'
      ? { rawStopReason: termination.raw }
      : {}),
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
  };
}
