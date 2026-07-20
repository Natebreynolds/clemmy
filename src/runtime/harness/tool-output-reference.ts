import { getRuntimeEnv } from '../../config.js';
import { getToolOutput } from './eventlog.js';
import { parseShellToolOutput } from '../../tools/code-mode-tool.js';
import { gatherTrustedEvidence } from './trusted-evidence.js';

/** Kill-switch for the dispatch-time resolution wiring (the primitive itself is
 *  always available). Default ON, but a no-op for any call without the syntax. */
export function toolOutputReferenceResolutionEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_TOOL_OUTPUT_REFERENCES', 'on') ?? 'on').trim().toLowerCase();
  return !['off', 'false', '0', 'disabled'].includes(raw);
}

/**
 * Layer 1 — structural prevention of fabrication.
 *
 * The 2026-07-19 incident happened because the model RE-TYPED 8 recipient
 * addresses from memory into a send and invented 5 of them. Gates can CATCH
 * that; they can't make it impossible. This makes it impossible: instead of
 * typing high-stakes values, the model emits a REFERENCE to the tool result they
 * came from —
 *
 *   { attendees_info: { $fromToolOutput: { callId: "call_x", path: "result.records[*].Email" } } }
 *
 * and the harness resolves it to the REAL values from the lossless tool_outputs
 * store at dispatch time. The values never pass through model-generated text, so
 * they cannot be fabricated, dropped, or transposed. Resolution is FAIL-CLOSED:
 * a reference that can't resolve is an error, never a silent empty send.
 */

const REF_KEY = '$fromToolOutput';

export interface ToolOutputRef {
  callId: string;
  /** Dot path into the parsed JSON, with `[*]` to map an array. Omit for the
   *  whole parsed value. e.g. "result.records[*].Email", "data.items[*]". */
  path?: string;
}

export interface ResolvedReference {
  callId: string;
  path?: string;
  /** Number of leaf values the reference produced (array length, or 1). */
  count: number;
}

export interface ResolveReferencesResult {
  resolved: unknown;
  references: ResolvedReference[];
  errors: string[];
}

/** A node is a reference iff it is exactly `{ $fromToolOutput: { callId, path? } }`. */
function asToolOutputRef(node: unknown): ToolOutputRef | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const keys = Object.keys(node as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== REF_KEY) return null;
  const spec = (node as Record<string, unknown>)[REF_KEY];
  if (!spec || typeof spec !== 'object') return null;
  const callId = (spec as Record<string, unknown>).callId;
  const path = (spec as Record<string, unknown>).path;
  if (typeof callId !== 'string' || !callId.trim()) return null;
  return { callId: callId.trim(), path: typeof path === 'string' && path.trim() ? path.trim() : undefined };
}

/** Split a path into steps, turning `records[*]` into `records` then `[*]`. */
function pathSteps(path: string): string[] {
  return path.split('.').flatMap((segment) => {
    const out: string[] = [];
    const m = /^([^[]*)((?:\[\*\])*)$/.exec(segment);
    if (!m) return [segment];
    if (m[1]) out.push(m[1]);
    const stars = m[2].match(/\[\*\]/g) ?? [];
    for (const _ of stars) out.push('[*]');
    return out;
  });
}

function applySteps(value: unknown, steps: string[]): unknown {
  if (steps.length === 0) return value;
  const [step, ...rest] = steps;
  if (step === '[*]') {
    if (!Array.isArray(value)) return undefined;
    return value.map((item) => applySteps(item, rest));
  }
  if (value && typeof value === 'object' && step in (value as Record<string, unknown>)) {
    return applySteps((value as Record<string, unknown>)[step], rest);
  }
  return undefined;
}

/** Extract a value from parsed JSON by a dot/`[*]` path (exported for tests). */
export function extractByPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return applySteps(value, pathSteps(path));
}

/** Parse a parked tool output as JSON, transparently unwrapping the
 *  `run_shell_command` `exit_code:/stdout:` wrapper around a `--json` payload. */
function parseParkedOutput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const shell = parseShellToolOutput(raw);
    return shell?.stdout_json;
  }
}

function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return value === undefined ? 0 : 1;
}

function resolveOne(sessionId: string, ref: ToolOutputRef, trustedCallIds: Set<string>, errors: string[]): unknown {
  // CAPABILITY POLICY (CaMeL-style): a reference may only bind from TRUSTED
  // grounded evidence — a read/compute tool result. A write/send confirmation or
  // an unknown call is not source authority, so a reference can never launder a
  // fabricated or already-sent payload into a new high-stakes field.
  if (!trustedCallIds.has(ref.callId)) {
    errors.push(`$fromToolOutput: "${ref.callId}" is not a trusted read/compute result in this session — a reference must bind from grounded evidence, not a write/send output or an unknown call`);
    return undefined;
  }
  const row = getToolOutput(sessionId, ref.callId);
  if (!row) {
    errors.push(`$fromToolOutput: no tool output found for call_id "${ref.callId}" in this session`);
    return undefined;
  }
  const parsed = parseParkedOutput(row.output);
  if (parsed === undefined) {
    errors.push(`$fromToolOutput: output for "${ref.callId}" is not JSON — cannot resolve a reference from it`);
    return undefined;
  }
  const value = extractByPath(parsed, ref.path);
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    errors.push(`$fromToolOutput: path "${ref.path ?? '(root)'}" resolved to nothing in "${ref.callId}"`);
    return undefined;
  }
  return value;
}

/**
 * Recursively replace every `$fromToolOutput` reference in `args` with the real
 * value from the session's tool_outputs store. Non-reference values pass through
 * unchanged. Returns the resolved args plus a manifest of what was resolved (for
 * the approval surface) and any errors (fail-closed: a caller MUST refuse to
 * dispatch when `errors` is non-empty).
 */
export function resolveToolOutputReferences(sessionId: string, args: unknown): ResolveReferencesResult {
  const references: ResolvedReference[] = [];
  const errors: string[] = [];
  // The set of call_ids that count as trusted grounded evidence this session
  // (read/compute tool results), computed once from the shared ledger. Layer 1
  // (reference) is only valid over Layer 2's trusted set — the policy binding.
  const trustedCallIds = new Set(
    gatherTrustedEvidence(sessionId).filter((s) => s.kind === 'tool').map((s) => s.id),
  );

  const walk = (node: unknown): unknown => {
    const ref = asToolOutputRef(node);
    if (ref) {
      const value = resolveOne(sessionId, ref, trustedCallIds, errors);
      references.push({ callId: ref.callId, path: ref.path, count: countLeaves(value) });
      return value;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) out[key] = walk(val);
      return out;
    }
    return node;
  };

  return { resolved: walk(args), references, errors };
}

/** True when the args tree contains at least one `$fromToolOutput` reference. */
export function hasToolOutputReference(args: unknown): boolean {
  if (asToolOutputRef(args)) return true;
  if (Array.isArray(args)) return args.some(hasToolOutputReference);
  if (args && typeof args === 'object') return Object.values(args as Record<string, unknown>).some(hasToolOutputReference);
  return false;
}
