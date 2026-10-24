/**
 * LEARNED FROM USE — the repair before a read is sent.
 *
 * A read whose arguments carry a value its tool has already rejected, at
 * least twice and always fixed the same way by leaving that argument out
 * (memory/argument-corrections-store.ts, autoRepairable), goes out with the
 * argument left out. The tool would refuse the value again; the host already
 * holds what worked. The model is told what changed and why, so the repaired
 * call is its own answer and is never sent twice.
 *
 * The value is found where the carrier holds it: any object inside the call,
 * carrier JSON strings (args_json, arguments) read as the objects they encode
 * and written back encoded once. Only an exact key and value match is
 * removed; nothing else in the call changes. Writes are never repaired here.
 */
import { carrierJsonObject } from './carrier-json.js';
import { autoRepairable, type ArgumentCorrection } from '../../memory/argument-corrections-store.js';

export interface AppliedArgumentCorrection {
  correction: ArgumentCorrection;
}

/** The call with every applicable learned rejection removed, or null when
 *  none applies. Pure. */
export function repairWithArgumentCorrections(input: {
  argumentsJson: string;
  operation: string;
  corrections: readonly ArgumentCorrection[];
}): { argumentsJson: string; applied: ArgumentCorrection[] } | null {
  const operation = input.operation.trim().toLowerCase();
  const candidates = input.corrections.filter((entry) => entry.operation === operation && autoRepairable(entry));
  if (!operation || candidates.length === 0) return null;
  let root: unknown;
  try { root = JSON.parse(input.argumentsJson); } catch { return null; }
  const applied = new Set<ArgumentCorrection>();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 6) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{')) return value;
      const decoded = carrierJsonObject(trimmed);
      if (!decoded) return value;
      const before = applied.size;
      const next = visit(decoded, depth + 1);
      return applied.size > before ? JSON.stringify(next) : value;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = { ...(value as Record<string, unknown>) };
    for (const correction of candidates) {
      if (Object.prototype.hasOwnProperty.call(record, correction.argument)
        && record[correction.argument] === correction.rejectedValue && correction.fix.kind === 'omit') {
        delete record[correction.argument];
        applied.add(correction);
      }
    }
    for (const [key, item] of Object.entries(record)) record[key] = visit(item, depth + 1);
    return record;
  };
  const repaired = visit(root, 0);
  if (applied.size === 0) return null;
  return { argumentsJson: JSON.stringify(repaired), applied: [...applied] };
}

/** What the model is told about one applied repair. */
export function argumentCorrectionRepairLine(callId: string, correction: ArgumentCorrection): string {
  return `Host repair for call ${callId}: ${correction.operation} rejected ${correction.argument}=`
    + `${JSON.stringify(correction.rejectedValue)} ${correction.pairs} times before ("${correction.error.slice(0, 160)}"), `
    + `so the call ran with ${correction.argument} left out. That call already ran in the repaired form and its result is its answer; do not send it again.`;
}
