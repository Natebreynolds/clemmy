import type { ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';

// Closed vocabularies prevent provider-controlled strings, prose, arguments or
// metadata from entering diagnostics. Counts saturate; no stream is retained.
const EVENT_TYPES = new Set(['response_started', 'response_done', 'output_text_delta']);
const PART_TYPES = new Set(['stream-start', 'response-metadata', 'text-start', 'text-delta', 'text-end',
  'reasoning-start', 'reasoning-delta', 'reasoning-end', 'tool-input-start', 'tool-input-delta',
  'tool-input-end', 'tool-call', 'tool-result', 'finish', 'error', 'source', 'file']);
const OUTPUT_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_result',
  'computer_call', 'computer_call_result', 'hosted_tool_call', 'tool_search_call', 'tool_search_output']);
const FINISH_REASONS = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown',
  'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);
const COUNT_LIMIT = 1_000_000_000;
type FinishReason = string | { unified?: string; raw?: string };
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

export function rawClaudeReportedModel(value: unknown): string | undefined {
  return typeof value === 'string' && /^claude-[A-Za-z0-9._:-]{1,180}$/.test(value) ? value : undefined;
}
export function rawClaudeTraceIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value) ? value : undefined;
}
function responseId(value: unknown): string | undefined {
  return typeof value === 'string' && /^msg_[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function finishReason(value: unknown): FinishReason | undefined {
  if (typeof value === 'string') return FINISH_REASONS.has(value) ? value : undefined;
  const fields = record(value);
  if (!fields || Object.keys(fields).some((key) => key !== 'unified' && key !== 'raw')) return undefined;
  const result: { unified?: string; raw?: string } = {};
  for (const key of ['unified', 'raw'] as const) {
    if (fields[key] === undefined) continue;
    if (typeof fields[key] !== 'string' || !FINISH_REASONS.has(fields[key])) return undefined;
    result[key] = fields[key];
  }
  return Object.keys(result).length ? result : undefined;
}
function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = Math.min(COUNT_LIMIT, (counts[key] ?? 0) + by);
}
function bytes(value: unknown): number {
  return typeof value === 'string' ? Math.min(COUNT_LIMIT, Buffer.byteLength(value, 'utf8')) : 0;
}

/** Observes only what the surrounding adapter exposes. It neither certifies
 * provider acceptance nor counts hidden physical retries as separate calls. */
export class RawClaudeStreamObservation {
  private readonly eventTypeCounts: Record<string, number> = {};
  private readonly outputItemTypeCounts: Record<string, number> = {};
  // Each layer is separate: SDK text-delta and output_text_delta represent the
  // same text and must not be added together as usage or a payload total.
  private readonly contentBytes = { providerTextDelta: 0, outputTextDelta: 0, reasoningDelta: 0, finalText: 0 };
  private reportedModel?: string;
  private reportedResponseId?: string;
  private reportedFinish?: FinishReason;
  private invalidModel = false;
  private invalidFinish = false;
  private sawDone = false;

  observe(event: StreamEvent): void {
    const e = event as unknown as RecordValue;
    const kind = typeof e.type === 'string' && EVENT_TYPES.has(e.type) ? e.type : 'other';
    if (e.type === 'model') {
      const part = record(e.event);
      const type = typeof part?.type === 'string' && PART_TYPES.has(part.type) ? part.type : 'other';
      increment(this.eventTypeCounts, `model.${type}`);
      if (type === 'response-metadata') {
        if (part?.modelId !== undefined) {
          const model = rawClaudeReportedModel(part.modelId);
          if (model) this.reportedModel = model;
          else this.invalidModel = true;
        }
        const id = responseId(part?.id);
        if (id) this.reportedResponseId = id;
      } else if (type === 'finish' && part?.finishReason !== undefined) {
        this.reportedFinish = finishReason(part.finishReason);
        if (!this.reportedFinish) this.invalidFinish = true;
      } else if (type === 'text-delta' || type === 'reasoning-delta') {
        const key = type === 'text-delta' ? 'providerTextDelta' : 'reasoningDelta';
        this.contentBytes[key] = Math.min(COUNT_LIMIT, this.contentBytes[key] + bytes(part?.delta));
      }
    } else {
      increment(this.eventTypeCounts, kind);
      if (e.type === 'output_text_delta') {
        this.contentBytes.outputTextDelta = Math.min(COUNT_LIMIT, this.contentBytes.outputTextDelta + bytes(e.delta));
      }
    }
    if (e.type !== 'response_done') return;
    this.sawDone = true;
    const response = record(e.response);
    const id = responseId(response?.responseId) ?? responseId(response?.id);
    if (id && !this.reportedResponseId) this.reportedResponseId = id;
    for (const item of Array.isArray(response?.output) ? response.output : []) {
      const output = record(item);
      const type = typeof output?.type === 'string' && OUTPUT_TYPES.has(output.type) ? output.type : 'other';
      increment(this.outputItemTypeCounts, type);
      if (type !== 'message') continue;
      for (const part of Array.isArray(output?.content) ? output.content : []) {
        const content = record(part);
        if (content?.type === 'output_text' || content?.type === 'text') {
          this.contentBytes.finalText = Math.min(COUNT_LIMIT, this.contentBytes.finalText + bytes(content.text));
        }
      }
    }
  }

  enrich(response: ModelResponse): ModelResponse {
    const existing = record(response.providerData);
    const additions = {
      ...(!existing?.model && this.reportedModel ? { model: this.reportedModel } : {}),
      ...(this.reportedModel ? { providerReportedModel: this.reportedModel } : {}),
      ...(existing?.finishReason === undefined && this.reportedFinish ? { finishReason: this.reportedFinish } : {}),
    };
    return Object.keys(additions).length ? { ...response, providerData: { ...existing, ...additions } } : response;
  }

  summary() {
    return {
      ...(this.reportedModel ? { providerReportedModel: this.reportedModel } : {}),
      ...(this.reportedResponseId ? { responseId: this.reportedResponseId } : {}),
      ...(this.reportedFinish ? { finishReason: this.reportedFinish } : {}),
      ...(this.invalidModel ? { unrecognizedModelMetadata: true } : {}),
      ...(this.invalidFinish ? { unrecognizedFinishMetadata: true } : {}),
      sawResponseDone: this.sawDone,
      eventTypeCounts: { ...this.eventTypeCounts },
      outputItemTypeCounts: { ...this.outputItemTypeCounts },
      contentBytes: { ...this.contentBytes },
    };
  }
}

export interface RawClaudeStreamDiagnostic extends ReturnType<RawClaudeStreamObservation['summary']> {
  kind: 'raw_claude_stream';
  transport: 'raw_messages';
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  attemptId?: string;
  requestModel?: string;
  elapsedMs: number;
  settlement: 'completed' | 'error' | 'closed';
}
