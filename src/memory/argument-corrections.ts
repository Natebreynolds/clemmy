/**
 * LEARNED FROM USE — the learner.
 *
 * After a turn, its own receipts are read for a call that failed and a later
 * call to the same operation that succeeded. An argument the two differ in is
 * learned only when the tool's own error names it (its value or its key): the
 * tool said what was wrong, and the later call shows what worked. Content the
 * model rewrote (a query, a message body, anything with spaces) is never a
 * rejected VALUE; a key the tool did not accept is learned whatever its value.
 *
 * No model, no guessing: what is recorded is what the receipts show. A later
 * pair that fixed the same rejection differently, or a host repair that failed,
 * marks the record conflicting, and it is never applied on its own again.
 *
 * The same day, the record names the saved memories that hold the rejected
 * value, so the memory renderer shows the correction beside them; the nightly
 * self-heal then rewrites them (self-heal.ts, rewrite_fact_from_use).
 */
import { listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import { redactSensitiveText } from '../runtime/security.js';
import { carrierJsonObject } from '../runtime/harness/carrier-json.js';
import { openMemoryDb } from './db.js';
import {
  ARGUMENT_CORRECTION_APPLIED,
  argumentCorrectionStoreExists,
  loadArgumentCorrections,
  saveArgumentCorrections,
  sameRejection,
  type ArgumentCorrection,
  type ArgumentFix,
} from './argument-corrections-store.js';

/** A carrier's own fields: how the call travels, never what the tool was asked. */
const CARRIER_KEYS = new Set([
  'requirement_id', 'name', 'universe_item_id', 'universe_selector',
  'seal_amendment', 'source_call_ids', 'source_record_ids', 'account_selection', 'role_key',
]);
/** Routing fields at any depth: which operation and account, never a value the tool judged. */
const ROUTING_KEYS = new Set(['requirement_id', 'tool_slug', 'connected_account_id']);
/** Outcomes where the tool answered about the call itself; a timeout or a
 *  policy refusal says nothing about an argument. */
const LEARNABLE_FAILURES = new Set(['unknown', 'invalid_arguments']);
const MAX_VALUE_CHARS = 200;
const MIN_FACT_MATCH_CHARS = 6;

type Scalar = string | number | boolean;

/** Every scalar argument in a call, by its path, reading carrier JSON strings
 *  (args_json, arguments) as the objects they encode. */
export function callArgumentLeaves(argumentsValue: unknown): Map<string, Scalar> {
  const leaves = new Map<string, Scalar>();
  const walk = (value: unknown, pathParts: string[], depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{')) {
        const decoded = carrierJsonObject(trimmed);
        if (decoded) { walk(decoded, pathParts, depth + 1); return; }
      }
      if (pathParts.length > 0) leaves.set(pathParts.join('.'), value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      if (pathParts.length > 0) leaves.set(pathParts.join('.'), value);
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const carrier = depth === 0 && ('args_json' in record || 'args' in record || 'arguments' in record);
      for (const [key, item] of Object.entries(record)) {
        if ((carrier && CARRIER_KEYS.has(key)) || ROUTING_KEYS.has(key)) continue;
        walk(item, [...pathParts, key], depth + 1);
      }
    }
  };
  walk(typeof argumentsValue === 'string' ? (carrierJsonObject(argumentsValue) ?? argumentsValue) : argumentsValue, [], 0);
  return leaves;
}

const lastKey = (leafPath: string): string => leafPath.split('.').at(-1) ?? leafPath;

/** A value that names something (an id, a username, a size), not content a
 *  model wrote. */
function identifierLike(value: Scalar): boolean {
  if (typeof value !== 'string') return true;
  return value.length > 0 && value.length <= MAX_VALUE_CHARS && !/\s/.test(value);
}

/** The part of an error that judges the call. A structured validation reply
 *  carries the tool's whole schema (every key quoted) and guidance beside its
 *  verdict; only the verdict (its detail, its listed violations) names what
 *  was wrong. */
export function errorVerdict(error: string): { text: string; violations?: string[] } {
  const start = error.indexOf('{');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(error.slice(start)) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (typeof parsed.detail === 'string' || Array.isArray(parsed.violations))) {
        const violations = Array.isArray(parsed.violations)
          ? parsed.violations.filter((entry): entry is string => typeof entry === 'string') : undefined;
        const text = [parsed.error, parsed.detail, parsed.message].filter((part) => typeof part === 'string').join(': ');
        return { text: text || error.slice(0, start), ...(violations ? { violations } : {}) };
      }
    } catch { /* cut short or not one JSON reply: read its verdict fields as text */ }
    const detail = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(error)?.[1];
    const listed = /"violations"\s*:\s*\[([^\]]*)\]/.exec(error)?.[1];
    const violations = listed !== undefined ? [...listed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!) : undefined;
    if (detail !== undefined || violations !== undefined) {
      return { text: (detail ?? '').replace(/\\"/g, '"'), ...(violations ? { violations } : {}) };
    }
    // A structured reply whose verdict was cut off names nothing it can be held to.
    if (/"schema"\s*:/.test(error)) return { text: '' };
  }
  return { text: error };
}

/** Whether the tool's own error names this argument: listed as a violation,
 *  quoted, or as a command-line flag, or its value. A short value, a number or
 *  a true/false counts only with its key named too: such text turns up in
 *  errors by chance. */
function errorNames(error: string, key: string, value: Scalar): { value: boolean; key: boolean } {
  const verdict = errorVerdict(error);
  if (verdict.violations && verdict.violations.some((entry) => entry.toLowerCase() === key.toLowerCase())) {
    return { value: false, key: true };
  }
  const lower = verdict.text.toLowerCase();
  const k = key.toLowerCase();
  const flag = `--${k.replace(/_/g, '-')}`;
  const keyNamed = k.length >= 2 && ([`"${k}"`, `'${k}'`, `\`${k}\``, `\\"${k}\\"`].some((quoted) => lower.includes(quoted))
    || new RegExp(`(^|[^a-z0-9-])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`).test(lower));
  const text = String(value).toLowerCase();
  const distinctive = typeof value === 'string' && text.length >= MIN_FACT_MATCH_CHARS;
  const valueNamed = text.length >= 1 && lower.includes(text) && (distinctive || keyNamed);
  return { value: valueNamed, key: keyNamed };
}

export interface LearnedPair {
  operation: string;
  /** The effect the call was dispatched under (read, local_write, …). */
  effect: string;
  argument: string;
  rejectedValue?: Scalar;
  fix: ArgumentFix;
  error: string;
}

interface CallRow { seq: number; callId: string; operation: string; effect: string; leaves: Map<string, Scalar> }

/** The rejections this source's receipts prove, and the host repairs it
 *  applied that failed. Pure over the event rows. */
export function rejectionsFromRows(rows: ReadonlyArray<{ seq: number; type: string; data: Record<string, unknown> }>): {
  pairs: LearnedPair[];
  failedRepairs: Array<{ operation: string; argument: string; rejectedValue?: Scalar }>;
  succeededRepairs: Array<{ operation: string; argument: string; rejectedValue?: Scalar }>;
} {
  const calls = new Map<string, CallRow>();
  const results = new Map<string, string>();
  const settled: Array<{ seq: number; callId: string; kind: string }> = [];
  const applied = new Map<string, { operation: string; argument: string; rejectedValue?: Scalar }>();
  for (const row of rows) {
    const callId = typeof row.data.callId === 'string' ? row.data.callId : '';
    if (row.type === 'tool_called' && callId && row.data.accounting !== 'transport_mirror') {
      const operation = String(row.data.effectiveTool ?? row.data.tool ?? '').toLowerCase();
      if (!operation || operation === 'tool_search') continue;
      calls.set(callId, { seq: row.seq, callId, operation, effect: String(row.data.effect ?? ''),
        leaves: callArgumentLeaves(row.data.arguments) });
    } else if (row.type === 'tool_returned' && callId && row.data.accounting !== 'transport_mirror') {
      results.set(callId, typeof row.data.result === 'string' ? row.data.result : JSON.stringify(row.data.result ?? ''));
    } else if (row.type === 'tool_attempt_settled' && callId && typeof row.data.kind === 'string') {
      settled.push({ seq: row.seq, callId, kind: row.data.kind });
    } else if (row.type === 'guardrail_tripped' && row.data.kind === ARGUMENT_CORRECTION_APPLIED && callId) {
      applied.set(callId, {
        operation: String(row.data.operation ?? ''), argument: String(row.data.argument ?? ''),
        ...(row.data.rejectedValue !== undefined ? { rejectedValue: row.data.rejectedValue as Scalar } : {}),
      });
    }
  }
  settled.sort((a, b) => a.seq - b.seq);
  const pairs: LearnedPair[] = [];
  const failedRepairs: Array<{ operation: string; argument: string; rejectedValue?: Scalar }> = [];
  const succeededRepairs: Array<{ operation: string; argument: string; rejectedValue?: Scalar }> = [];
  for (let index = 0; index < settled.length; index += 1) {
    const failed = settled[index]!;
    if (failed.kind === 'succeeded' || failed.kind === 'empty_result') {
      const repair = applied.get(failed.callId);
      if (repair) succeededRepairs.push(repair);
      continue;
    }
    if (!LEARNABLE_FAILURES.has(failed.kind)) continue;
    const repair = applied.get(failed.callId);
    if (repair) failedRepairs.push(repair);
    const before = calls.get(failed.callId);
    if (!before) continue;
    const later = settled.slice(index + 1).find((row) => row.kind === 'succeeded'
      && calls.get(row.callId)?.operation === before.operation);
    const after = later ? calls.get(later.callId) : undefined;
    if (!after) continue;
    const error = results.get(failed.callId) ?? '';
    if (!error.trim()) continue;
    for (const [leafPath, value] of before.leaves) {
      const now = after.leaves.get(leafPath);
      if (now === value) continue;
      // The operation's own name is how the call was routed, not an argument.
      if (String(value).toLowerCase() === before.operation) continue;
      const argument = lastKey(leafPath);
      const named = errorNames(error, argument, value);
      const fix: ArgumentFix | null = now === undefined ? { kind: 'omit' }
        : identifierLike(now) ? { kind: 'replace', value: now } : null;
      if (!fix) continue;
      // Only a VALUE the tool named is learned. A key the tool did not accept
      // belongs to the tool's current schema, which changes; memory of it
      // would keep stripping a key the tool later accepts.
      if (identifierLike(value) && named.value) {
        pairs.push({ operation: before.operation, effect: before.effect, argument, rejectedValue: value, fix, error });
      }
    }
  }
  return { pairs, failedRepairs, succeededRepairs };
}

function sameFix(a: ArgumentFix, b: ArgumentFix): boolean {
  return a.kind === b.kind && (a.kind === 'omit' || (b.kind === 'replace' && a.value === b.value));
}

function factsHolding(value: Scalar): number[] {
  const text = String(value);
  if (typeof value !== 'string' || text.length < MIN_FACT_MATCH_CHARS) return [];
  try {
    return (openMemoryDb().prepare('SELECT id FROM consolidated_facts WHERE active = 1 AND instr(content, ?) > 0 ORDER BY id LIMIT 5')
      .all(text) as Array<{ id: number }>).map((row) => row.id);
  } catch { return []; }
}

const boundedError = (error: string): string => redactSensitiveText(errorVerdict(error).text).replace(/\s+/g, ' ').trim().slice(0, 300);

type RepairRef = { operation: string; argument: string; rejectedValue?: Scalar };
const BACKFILL_DAYS = 14;

function foldIntoStore(pairs: readonly LearnedPair[], failedRepairs: readonly RepairRef[],
  succeededRepairs: readonly RepairRef[], now: Date): void {
  const store = [...loadArgumentCorrections()];
  const stamp = now.toISOString();
  for (const pair of pairs) {
    const existing = store.find((entry) => sameRejection(entry, pair.operation, pair.argument, pair.rejectedValue));
    // Only a read's rejection speaks for a saved memory: a write that failed
    // can fail for what it was writing, not for the value it named.
    const factIds = pair.rejectedValue !== undefined && pair.effect === 'read' ? factsHolding(pair.rejectedValue) : [];
    if (existing) {
      existing.pairs += 1;
      existing.lastSeen = stamp;
      existing.error = boundedError(pair.error);
      if (!sameFix(existing.fix, pair.fix)) existing.conflicting = true;
      existing.factIds = [...new Set([...(existing.factIds ?? []), ...factIds])].slice(0, 5);
    } else {
      store.push({
        operation: pair.operation, effect: pair.effect, argument: pair.argument,
        ...(pair.rejectedValue !== undefined ? { rejectedValue: pair.rejectedValue } : {}),
        fix: pair.fix, error: boundedError(pair.error), pairs: 1, firstSeen: stamp, lastSeen: stamp,
        ...(factIds.length > 0 ? { factIds } : {}),
      });
    }
  }
  // A repair that worked keeps its record current; one that failed means the
  // record no longer holds, and it is never applied on its own again.
  for (const repair of succeededRepairs) {
    const existing = store.find((entry) => sameRejection(entry, repair.operation, repair.argument, repair.rejectedValue));
    if (!existing) continue;
    existing.repairSuccesses = (existing.repairSuccesses ?? 0) + 1;
    existing.lastSeen = stamp;
  }
  for (const repair of failedRepairs) {
    const existing = store.find((entry) => sameRejection(entry, repair.operation, repair.argument, repair.rejectedValue));
    if (!existing) continue;
    existing.repairFailures = (existing.repairFailures ?? 0) + 1;
    existing.conflicting = true;
    existing.lastSeen = stamp;
  }
  saveArgumentCorrections(store, now);
}

/**
 * The receipts of recent turns, read once when this machine has no store yet,
 * so what they already prove is not waited for again. The same rules as a live
 * turn. Settlements are read first (small); only a turn where a call failed
 * and a later call to the same tool succeeded has its calls and replies read,
 * through the per-session index, a few turns at a time with the event loop
 * free between them. Runs once per process; writes the store only when it
 * found something.
 * Resolves to how many pairs it found; never rejects.
 */
export async function seedArgumentCorrectionsFromRecentTurns(days = BACKFILL_DAYS, now = new Date()): Promise<number> {
  if (argumentCorrectionStoreExists() || seeding || seededInProcess) return 0;
  seeding = true;
  try {
    const db = openEventLog();
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const boundary = db.prepare(`SELECT seq FROM events WHERE type = 'user_input_received' AND created_at >= ?
      ORDER BY seq LIMIT 1`).get(since) as { seq: number } | undefined;
    const candidates: Array<{ sessionId: string; sourceUserSeq: number }> = [];
    if (boundary) {
      const settled = db.prepare(`SELECT session_id AS sessionId, seq,
          json_extract(data_json, '$.sourceUserSeq') AS sourceUserSeq,
          json_extract(data_json, '$.tool') AS tool, json_extract(data_json, '$.kind') AS kind
        FROM events WHERE type = 'tool_attempt_settled' AND seq >= ? ORDER BY seq`).all(boundary.seq) as Array<{
          sessionId: string; seq: number; sourceUserSeq: unknown; tool: unknown; kind: unknown }>;
      const failedTools = new Map<string, Set<string>>();
      const seen = new Set<string>();
      for (const row of settled) {
        if (typeof row.sourceUserSeq !== 'number' || typeof row.tool !== 'string') continue;
        const key = `${row.sessionId}\u0000${row.sourceUserSeq}`;
        if (typeof row.kind === 'string' && LEARNABLE_FAILURES.has(row.kind)) {
          const tools = failedTools.get(key) ?? new Set<string>();
          tools.add(row.tool);
          failedTools.set(key, tools);
        } else if (row.kind === 'succeeded' && failedTools.get(key)?.has(row.tool) && !seen.has(key)) {
          seen.add(key);
          candidates.push({ sessionId: row.sessionId, sourceUserSeq: row.sourceUserSeq });
        }
      }
    }
    const pairs: LearnedPair[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const { sessionId, sourceUserSeq } = candidates[index]!;
      try {
        const rows = listEvents(sessionId, { types: ['tool_called', 'tool_returned', 'tool_attempt_settled'], sinceSeq: sourceUserSeq })
          .filter((row) => row.data.sourceUserSeq === sourceUserSeq);
        pairs.push(...rejectionsFromRows(rows).pairs);
      } catch { /* one unreadable turn teaches nothing */ }
      if (index % 8 === 7) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Nothing found writes nothing: a file with no records would only mark
    // that the read ran, and a fresh home then gains a file on its first
    // turn. Once per process is the marker instead.
    if (pairs.length > 0) foldIntoStore(pairs, [], [], now);
    return pairs.length;
  } catch {
    return 0;
  } finally {
    seeding = false;
    seededInProcess = true;
  }
}
let seeding = false;
let seededInProcess = false;

/** Test seam: forget that this process already read its recent turns. */
export function _resetArgumentCorrectionSeedForTests(): void {
  seeding = false;
  seededInProcess = false;
}

/** Fold one source's proven rejections into the store. The first time on a
 *  machine, recent turns are read instead, this one among them. Never throws. */
export function learnArgumentCorrections(sessionId: string, sourceUserSeq: number, now = new Date()): LearnedPair[] {
  if (!argumentCorrectionStoreExists() && !seededInProcess) {
    void seedArgumentCorrectionsFromRecentTurns(BACKFILL_DAYS, now);
    return [];
  }
  let learned: ReturnType<typeof rejectionsFromRows>;
  try {
    const rows = listEvents(sessionId, {
      types: ['tool_called', 'tool_returned', 'tool_attempt_settled', 'guardrail_tripped'], sinceSeq: sourceUserSeq,
    }).filter((row) => row.data.sourceUserSeq === sourceUserSeq);
    learned = rejectionsFromRows(rows);
  } catch { return []; }
  if (learned.pairs.length === 0 && learned.failedRepairs.length === 0 && learned.succeededRepairs.length === 0) return [];
  try { foldIntoStore(learned.pairs, learned.failedRepairs, learned.succeededRepairs, now); } catch { /* learning stays additive */ }
  return learned.pairs;
}
