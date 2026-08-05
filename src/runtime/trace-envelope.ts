/**
 * The trace envelope (R2/C2): one explicit identity that joins a turn's whole
 * causal chain —
 *
 *   accepted source -> logical turn -> activation/attempt -> admission/graph/
 *   node -> lane/surface/brain -> model call -> tool call -> receipt/evidence
 *   -> terminal commit -> delivery -> client acknowledgement
 *
 * — replacing inference from source-string prefixes. A lane is never required
 * to invent fields it genuinely cannot have; it IS required to be explicit
 * about the ones it does have, and a performance fixture whose required spans
 * are missing is UNCERTIFIABLE — visibly, without crashing any user turn.
 *
 * Privacy: envelopes carry identifiers and digests only. Raw payloads,
 * prompts, message text, and secrets never enter telemetry; `sealTraceEnvelope`
 * refuses value shapes that look like content instead of identity.
 *
 * Pure: types, validation, and arithmetic over an injected clock.
 */

export interface TraceEnvelope {
  /** Accepted-source identity of the turn (id, never message content). */
  acceptedSource?: string;
  logicalTurnId?: string;
  activationId?: string;
  attemptId?: string;
  admissionDigest?: string;
  nodeId?: string;
  /** Usage lane (chat/cron/workflow/...), surface, and brain. */
  lane?: string;
  surface?: string;
  brain?: string;
  modelCallId?: string;
  toolCallId?: string;
  receiptId?: string;
  terminalId?: string;
}

/** The spans a performance cohort may require. Names, not guesses. */
export type SpanName =
  | 'queue'
  | 'context_assembly'
  | 'memory_recall'
  | 'capability_resolution'
  | 'discovery'
  | 'slot_binding'
  | 'model_ttft'
  | 'model_total'
  | 'tool_provider'
  | 'verification'
  | 'terminal_commit'
  | 'delivery'
  | 'client_ack';

export interface TraceSpan {
  name: SpanName | (string & {});
  ms: number;
}

export interface TraceRecord {
  envelope: TraceEnvelope;
  spans: TraceSpan[];
}

const MAX_FIELD_LENGTH = 256;
const CONTENT_SHAPE = /[\n\r]|\s{3,}/;

export type EnvelopeSealResult =
  | { ok: true; envelope: TraceEnvelope }
  | { ok: false; errors: string[] };

/**
 * Validate an envelope: every present field must look like an identifier or
 * digest, never content. Absent fields are lawful — a cron lane has no client
 * acknowledgement and must not invent one.
 */
export function sealTraceEnvelope(envelope: TraceEnvelope): EnvelopeSealResult {
  const errors: string[] = [];
  for (const [field, value] of Object.entries(envelope)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`trace field "${field}" must be a non-empty identifier`);
      continue;
    }
    if (value.length > MAX_FIELD_LENGTH || CONTENT_SHAPE.test(value)) {
      errors.push(`trace field "${field}" looks like content, not identity — raw payloads never enter telemetry`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, envelope: { ...envelope } };
}

export type SpanCertification =
  | { certified: true }
  | { certified: false; missing: string[] };

/**
 * The certification rule: a performance sample may enter a declared cohort
 * only when every REQUIRED span is present with a finite positive duration.
 * A missing span makes the sample uncertifiable — it stays in attempted
 * counts and error reporting, it never silently improves a percentile.
 */
export function certifyPerformanceSample(
  record: TraceRecord,
  required: readonly (SpanName | (string & {}))[],
): SpanCertification {
  const present = new Map(record.spans.map((span) => [span.name, span.ms]));
  const missing = required.filter((name) => {
    const ms = present.get(name);
    return ms === undefined || !Number.isFinite(ms) || ms < 0;
  });
  return missing.length > 0 ? { certified: false, missing: [...missing] } : { certified: true };
}

/**
 * Span recorder over an injected clock. `mark(name)` opens a span,
 * `finish(name)` closes it; `spans()` returns everything closed so far.
 * Unclosed spans are simply absent — which certification then reports.
 */
export function createSpanRecorder(clock: () => number): {
  mark(name: TraceSpan['name']): void;
  finish(name: TraceSpan['name']): void;
  record(name: TraceSpan['name'], ms: number): void;
  spans(): TraceSpan[];
} {
  const open = new Map<string, number>();
  const closed: TraceSpan[] = [];
  return {
    mark(name) { open.set(name, clock()); },
    finish(name) {
      const startedAt = open.get(name);
      if (startedAt === undefined) return;
      open.delete(name);
      closed.push({ name, ms: clock() - startedAt });
    },
    record(name, ms) {
      if (Number.isFinite(ms) && ms >= 0) closed.push({ name, ms });
    },
    spans() { return [...closed]; },
  };
}
