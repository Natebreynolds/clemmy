import { isDeepStrictEqual } from 'node:util';

/** Decode the model-facing JSON carrier before storing the executable call.
 * Strict provider schemas cannot represent arbitrary operation argument keys. */
export function normalizeWorkflowCallArguments<T extends { args?: Record<string, unknown> }>(
  call: T | undefined,
): T | undefined {
  if (!call) return call;
  const { args_json, ...rest } = call as T & { args_json?: unknown };
  if (args_json === undefined || args_json === null) return rest as T;
  if (typeof args_json !== 'string') throw new Error('call.args_json must be JSON object text.');
  let parsed: unknown;
  try { parsed = JSON.parse(args_json); }
  catch { throw new Error('call.args_json must contain valid JSON object text.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('call.args_json must encode an object, not an array or scalar.');
  }
  if (call.args && Object.keys(call.args).length > 0 && !isDeepStrictEqual(call.args, parsed)) {
    throw new Error('call.args and call.args_json disagree; provide one argument carrier.');
  }
  return { ...rest, args: parsed } as T;
}
