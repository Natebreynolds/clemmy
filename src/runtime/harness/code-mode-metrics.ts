/**
 * code-mode-metrics — aggregate `codemode_program_summary` events into a real
 * efficiency readout. This is the consumer the DELETE-WHEN-VALIDATED mandate was
 * waiting on: the summary events flowed but nothing read them, so the token win
 * stayed projected, never measured.
 *
 * The honest measure: `intermediateBytes` is the raw size of every tool RESULT a
 * program dispatched — the payloads that stayed in the sandbox instead of
 * entering the conversation as N discrete tool_returned events. `returnBytes` is
 * the distilled value that DID enter context. `savedBytes = intermediate −
 * return` is the token-proxy win. It is an UPPER BOUND: discrete tool calls may
 * themselves truncate very large outputs, so the realized saving can be smaller —
 * but the direction and the per-program shape are real and now telemetered.
 */

/** One parsed `codemode_program_summary` event's data. All fields optional so a
 *  pre-enrichment (older) event degrades gracefully to zeros. */
export interface CodeModeSummaryEvent {
  ok?: boolean;
  rpcCalls?: number;
  durationMs?: number;
  intermediateBytes?: number;
  returnBytes?: number;
  savedBytes?: number;
}

export interface CodeModeEfficiencySummary {
  programs: number;
  okPrograms: number;
  totalRpcCalls: number;
  totalIntermediateBytes: number;
  totalReturnBytes: number;
  totalSavedBytes: number;
  /** savedBytes / 4 — a rough, tool-agnostic bytes→tokens proxy (upper bound). */
  estTokensSaved: number;
  avgSavedBytesPerProgram: number;
  avgRpcCallsPerProgram: number;
  avgDurationMs: number;
}

const BYTES_PER_TOKEN = 4;

export function summarizeCodeModeEfficiency(events: CodeModeSummaryEvent[]): CodeModeEfficiencySummary {
  const programs = events.length;
  let okPrograms = 0;
  let totalRpcCalls = 0;
  let totalIntermediateBytes = 0;
  let totalReturnBytes = 0;
  let totalSavedBytes = 0;
  let totalDurationMs = 0;

  for (const e of events) {
    if (e.ok) okPrograms += 1;
    totalRpcCalls += e.rpcCalls ?? 0;
    totalIntermediateBytes += e.intermediateBytes ?? 0;
    totalReturnBytes += e.returnBytes ?? 0;
    // Prefer the emitted savedBytes; else derive it (older events without it).
    totalSavedBytes += e.savedBytes ?? Math.max(0, (e.intermediateBytes ?? 0) - (e.returnBytes ?? 0));
    totalDurationMs += e.durationMs ?? 0;
  }

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    programs,
    okPrograms,
    totalRpcCalls,
    totalIntermediateBytes,
    totalReturnBytes,
    totalSavedBytes,
    estTokensSaved: Math.round(totalSavedBytes / BYTES_PER_TOKEN),
    avgSavedBytesPerProgram: programs ? Math.round(totalSavedBytes / programs) : 0,
    avgRpcCallsPerProgram: programs ? round1(totalRpcCalls / programs) : 0,
    avgDurationMs: programs ? Math.round(totalDurationMs / programs) : 0,
  };
}

/** One-line human readout for the measure-efficiency CLI / logs. */
export function formatCodeModeEfficiency(s: CodeModeEfficiencySummary): string {
  if (s.programs === 0) return 'CODE MODE EFFICIENCY: (no codemode_program_summary events in window)';
  const okPct = Math.round((s.okPrograms / s.programs) * 100);
  return [
    `CODE MODE EFFICIENCY  programs ${s.programs} (${okPct}% ok) · avg ${s.avgRpcCallsPerProgram} calls/prog · avg ${s.avgDurationMs}ms`,
    `  context saved: ~${s.estTokensSaved.toLocaleString()} tokens (${s.totalSavedBytes.toLocaleString()} bytes kept out of context; ${s.totalReturnBytes.toLocaleString()} distilled in) · avg ${s.avgSavedBytesPerProgram.toLocaleString()} bytes/prog`,
    '  (upper bound — discrete calls may also truncate large outputs; the mechanism + shape are real)',
  ].join('\n');
}
