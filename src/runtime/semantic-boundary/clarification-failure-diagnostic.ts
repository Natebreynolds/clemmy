/** Bounded observations about one failed clarification proposal, never retry or
 * execution authority. No error message, response body or model content. */
export interface ClarificationFailureSource {
  sessionId: string;
  sourceUserSeq: number;
  attemptId?: string;
}

export interface ClarificationFailureDiagnostic extends ClarificationFailureSource {
  version: 1;
  kind: 'deadline' | 'http_error' | 'sdk_output_invalid' | 'wire_envelope_invalid' | 'unknown';
  phase: 'model_selection' | 'sdk_run' | 'sdk_output_validation' | 'wire_envelope_validation';
  deadlineFired: boolean;
  /** Runner invocation at failure time only. Neither field certifies a physical
   * provider call or rules out a later settlement after cancellation. */
  sdkRunStarted: boolean;
  sdkRunReturned: boolean;
  /** What the accounting observer saw by this failure, not total billable work. */
  usageRecordedAtFailure?: boolean;
  httpStatus?: number;
}

const diagnostics = new WeakMap<object, Readonly<ClarificationFailureDiagnostic>>();

export function validatedClarificationFailureDiagnostic(
  value: unknown,
  source: Pick<ClarificationFailureSource, 'sessionId' | 'sourceUserSeq'>,
): ClarificationFailureDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  const keys = ['version', 'sessionId', 'sourceUserSeq', 'attemptId', 'kind', 'phase', 'deadlineFired',
    'sdkRunStarted', 'sdkRunReturned', 'usageRecordedAtFailure', 'httpStatus'];
  if (Object.keys(d).some((key) => !keys.includes(key)) || d.version !== 1
    || d.sessionId !== source.sessionId || typeof d.sessionId !== 'string' || !d.sessionId || d.sessionId.length > 512
    || d.sourceUserSeq !== source.sourceUserSeq || !Number.isSafeInteger(d.sourceUserSeq) || (d.sourceUserSeq as number) <= 0
    || (d.attemptId !== undefined && (typeof d.attemptId !== 'string' || !d.attemptId || d.attemptId.length > 512))
    || typeof d.kind !== 'string' || !['deadline', 'http_error', 'sdk_output_invalid', 'wire_envelope_invalid', 'unknown'].includes(d.kind)
    || typeof d.phase !== 'string' || !['model_selection', 'sdk_run', 'sdk_output_validation', 'wire_envelope_validation'].includes(d.phase)
    || typeof d.deadlineFired !== 'boolean' || typeof d.sdkRunStarted !== 'boolean' || typeof d.sdkRunReturned !== 'boolean'
    || (d.usageRecordedAtFailure !== undefined && typeof d.usageRecordedAtFailure !== 'boolean')
    || (d.httpStatus !== undefined && (!Number.isInteger(d.httpStatus) || (d.httpStatus as number) < 400 || (d.httpStatus as number) > 599))
    || (d.kind === 'deadline') !== d.deadlineFired
    || (d.kind === 'http_error') !== (d.httpStatus !== undefined)
    || (d.sdkRunReturned && !d.sdkRunStarted)
    || (d.phase === 'model_selection' && (d.sdkRunStarted || d.sdkRunReturned))
    || (d.phase === 'sdk_run' && (!d.sdkRunStarted || d.sdkRunReturned))
    || (d.phase === 'sdk_output_validation' && !d.sdkRunStarted)
    || (d.phase === 'wire_envelope_validation' && (!d.sdkRunStarted || !d.sdkRunReturned))
    || (d.kind === 'sdk_output_invalid' && d.phase !== 'sdk_output_validation')
    || (d.kind === 'wire_envelope_invalid' && d.phase !== 'wire_envelope_validation')) return null;
  return { ...d } as unknown as ClarificationFailureDiagnostic;
}

export function retainClarificationFailureDiagnostic(error: unknown, diagnostic: ClarificationFailureDiagnostic): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  const safe = validatedClarificationFailureDiagnostic(diagnostic, diagnostic);
  if (safe) diagnostics.set(error, Object.freeze(safe));
}

/** Only this producer's error object can carry a diagnostic across the catch.
 * An arbitrary error.diagnostic field or an older source/attempt cannot. */
export function clarificationFailureDiagnosticFor(error: unknown, source: ClarificationFailureSource): ClarificationFailureDiagnostic | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
  const d = diagnostics.get(error);
  if (!d || d.attemptId !== source.attemptId) return null;
  return validatedClarificationFailureDiagnostic(d, source);
}
