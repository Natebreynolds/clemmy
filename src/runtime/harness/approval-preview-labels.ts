import { inspectProviderEnvelope } from './provider-read-evidence.js';
import { loadPhysicalRequestEvidence } from './dispatch-ledger.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { listAccountAliases } from '../../memory/account-alias-store.js';
import { openEventLog } from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { evidenceAcceptedTaskId } from './host-completion-work.js';
import { labelIdentifierWithJev } from '../jev/control-plane.js';
import type { ApprovalCallPreview } from './approval-call-preview.js';

/**
 * Human names for the identifiers an approval card shows.
 *
 * A card that shows only an opaque id tells the owner nothing. When Clem found
 * that id in an earlier result of this conversation, the record it came from
 * names it. The host gathers the strings of the
 * records that carry the exact value, and Jev picks the one a person would
 * recognise, or none. Display only: the card keeps the exact value, and the
 * approval still pins the untouched arguments.
 */

const LABEL_SOURCES = 3; // this accepted source and up to two before it
const LABEL_WINDOW_MS = 2 * 60 * 60_000;
const MAX_LABELLED_VALUES = 4;
const MAX_CANDIDATES = 20;
const MAX_CANDIDATE_CHARS = 80;
const MAX_PAYLOAD_CHARS = 4_000_000;

/** An argument value worth naming is one token, as ids are, never prose. */
function identifierValue(value: string): boolean {
  return value.length >= 3 && value.length <= 120 && !/\s/.test(value);
}

/**
 * The strings of every record that carries `value` as one of its own fields,
 * plus the strings one level inside those records, most repeated first. A URL
 * is never a name.
 */
export function labelCandidatesFor(payloads: readonly unknown[], value: string): string[] {
  const counts = new Map<string, number>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== 'string') return;
    const text = candidate.trim();
    if (!text || text === value || text.length > MAX_CANDIDATE_CHARS || text.includes('://')) return;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  };
  const visit = (node: unknown, depth: number) => {
    if (depth > 12 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 2_000)) visit(item, depth + 1);
      return;
    }
    const fields = Object.values(node as Record<string, unknown>);
    if (fields.some((field) => field === value)) {
      for (const field of fields) {
        add(field);
        if (field && typeof field === 'object' && !Array.isArray(field)) {
          for (const inner of Object.values(field as Record<string, unknown>)) add(inner);
        }
      }
    }
    for (const field of fields) visit(field, depth + 1);
  };
  for (const payload of payloads) visit(payload, 0);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_CANDIDATES)
    .map(([text]) => text);
}

/** Parsed settled results of this accepted source and the few before it,
 *  redeemed through the same authenticated path the reviewer uses. */
export function recentSettledPayloads(input: {
  sessionId: string;
  sourceUserSeq: number;
  nowMs?: number;
}): unknown[] {
  try {
    const db = openEventLog();
    const since = new Date((input.nowMs ?? Date.now()) - LABEL_WINDOW_MS).toISOString();
    const sources = db.prepare(`
      SELECT seq FROM events
       WHERE session_id = ? AND type = 'user_input_received' AND role = 'user'
         AND seq <= ? AND (seq = ? OR created_at >= ?)
       ORDER BY seq DESC LIMIT ?
    `).all(input.sessionId, input.sourceUserSeq, input.sourceUserSeq, since, LABEL_SOURCES) as Array<{ seq: number }>;
    const payloads: unknown[] = [];
    for (const source of sources) {
      const calls = db.prepare(`
        SELECT s.logical_tool_call_id AS callId, l.tool_name AS toolName
          FROM logical_call_settlements s
          JOIN logical_tool_calls l
            ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
           AND l.logical_tool_call_id = s.logical_tool_call_id
         WHERE s.session_id = ? AND s.source_user_seq = ?
           AND s.outcome_kind IN ('succeeded', 'empty_result')
         ORDER BY s.rowid
      `).all(input.sessionId, source.seq) as Array<{ callId: string; toolName: string }>;
      for (const call of calls) {
        if (call.toolName === 'tool_search') continue;
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.sessionId,
          sourceUserSeq: source.seq,
          acceptedTaskId: evidenceAcceptedTaskId(input.sessionId, source.seq),
          logicalToolCallId: call.callId,
        });
        if (redeemed.status !== 'ok' || redeemed.value.rawPayloadJson.length > MAX_PAYLOAD_CHARS) continue;
        try { payloads.push(JSON.parse(redeemed.value.rawPayloadJson)); } catch { /* not a record */ }
      }
    }
    return payloads;
  } catch {
    return [];
  }
}

/** One settled call on one account: what it was asked and what it returned. */
export interface SettledCallEvidence {
  operation: string;
  accountId: string;
  args: unknown;
  result: unknown;
}

/** Whether some record of a result holds `value` as one of its own fields. */
function carriesValue(node: unknown, value: string, depth = 0): boolean {
  if (depth > 12 || !node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.slice(0, 2_000).some((item) => carriesValue(item, value, depth + 1));
  const fields = Object.values(node as Record<string, unknown>);
  return fields.some((field) => field === value) || fields.some((field) => carriesValue(field, value, depth + 1));
}

/** The identifier-shaped string arguments of a call, at any depth. */
function identifierArguments(args: unknown, depth = 0): string[] {
  if (depth > 8 || args === null || args === undefined) return [];
  if (typeof args === 'string') return identifierValue(args.trim()) ? [args.trim()] : [];
  if (typeof args !== 'object') return [];
  const children = Array.isArray(args) ? args.slice(0, 200) : Object.values(args as Record<string, unknown>);
  return children.flatMap((child) => identifierArguments(child, depth + 1));
}

/**
 * What a returned value was made from.
 *
 * Some values an approval shows were never looked up: an operation returned
 * them. The record that carries such a value often names nothing (an opened
 * conversation is an id and a flag), while the thing it was opened FOR has a
 * name in another result. The link between the two is the call itself: its
 * arguments are what it was made from, its result is the value.
 *
 * This returns the one identifier a value was made from, or undefined when
 * the relation is not exact:
 *  - the calls are on the account the approval will use, and nowhere else;
 *  - the value was returned by the call, not passed to it;
 *  - the provider's own envelope reports no failure;
 *  - every call that returned the value was given the same single identifier.
 * Several identifiers, or calls that disagree, name nothing. It knows no
 * operation, provider or field name, and it asks no model: naming the
 * identifier is the caller's existing question.
 */
export function producedFromIdentifier(input: {
  accountId: string;
  value: string;
  evidence: readonly SettledCallEvidence[];
}): string | undefined {
  if (!input.accountId) return undefined;
  const made = new Set<string>();
  for (const call of input.evidence) {
    if (call.accountId !== input.accountId) continue;
    if (!carriesValue(call.result, input.value)) continue;
    if (inspectProviderEnvelope(call.result).verdict !== 'clean') continue;
    const given = [...new Set(identifierArguments(call.args))];
    // Passed in, so not produced by this call.
    if (given.includes(input.value)) continue;
    if (given.length !== 1) return undefined;
    made.add(given[0]!);
  }
  return made.size === 1 ? [...made][0] : undefined;
}

/** Exact source/account-scoped relations, with no inference or model calls. */
export function settledDestinationEvidence(input: {
  sessionId: string; sourceUserSeq: number; accountId: string;
}): SettledCallEvidence[] {
  const db = openEventLog();
  const rows = db.prepare(`SELECT logical_tool_call_id AS callId FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ? AND outcome_kind = 'succeeded'
    ORDER BY rowid DESC LIMIT 200`).all(input.sessionId, input.sourceUserSeq) as Array<{ callId: string }>;
  const evidence: SettledCallEvidence[] = [];
  for (const row of rows) {
    const binding = loadHostCallCapabilityBinding({ db, ...input, logicalToolCallId: row.callId });
    if (binding.status !== 'ok' || binding.binding.accountId !== input.accountId) continue;
    const redeemed = redeemSuccessfulSettlementResultForHost({ ...input,
      acceptedTaskId: evidenceAcceptedTaskId(input.sessionId, input.sourceUserSeq), logicalToolCallId: row.callId });
    if (redeemed.status !== 'ok' || redeemed.value.rawByteCount > MAX_PAYLOAD_CHARS) continue;
    const request = loadPhysicalRequestEvidence({ ...input, logicalToolCallId: row.callId,
      physicalDispatchId: redeemed.value.physicalDispatchId });
    if (!request) continue;
    const effective = unwrapRuntimeEffectiveToolIdentity(redeemed.value.toolName, request.args);
    evidence.push({ operation: redeemed.value.toolName, accountId: input.accountId,
      args: effective.args, result: redeemed.value.rawPayload });
  }
  return evidence;
}

/** One approval batch's asked label questions, keyed by the exact question. */
export type ApprovalLabelMemo = Map<string, Promise<string | null>>;

/** The answer to one exact label question, asked at most once per memo. The
 * key is the whole question, candidates in order: a different value, field,
 * operation or candidate list is a different question. An ask that fails
 * answers null, as it does unmemoized. */
export function labelAskedOnce(
  memo: ApprovalLabelMemo | undefined,
  question: { operation: string; field: string; value: string; candidates: readonly string[] },
  ask: () => Promise<string | null | undefined>,
): Promise<string | null> {
  const key = JSON.stringify([question.operation, question.field, question.value, question.candidates]);
  const known = memo?.get(key);
  if (known) return known;
  const asked = Promise.resolve().then(ask).then((answer) => answer ?? null).catch(() => null);
  memo?.set(key, asked);
  return asked;
}

/** value -> the name Jev is sure of, for each identifier on the card. */
export async function approvalPreviewLabels(input: {
  sessionId: string;
  sourceUserSeq: number;
  preview: ApprovalCallPreview | null;
  nowMs?: number;
  accountId?: string | null;
  /** Accepted for callers that pass it; no rule here reads an operation's name. */
  operationId?: string;
  /** Answers already asked for within one approval batch. The members of a
   * batch often carry the same identifier beside the same results; the same
   * question has the same answer, so it is asked once. Never reuse a memo
   * across batches: a later batch reads later results. */
  memo?: ApprovalLabelMemo;
}): Promise<Record<string, string> | undefined> {
  const fields = (input.preview?.fields ?? []).filter((field) => identifierValue(field.value));
  const values = [...new Set(fields.map((field) => field.value))].slice(0, MAX_LABELLED_VALUES);
  if (!input.preview || values.length === 0) return undefined;
  let payloads: unknown[] | undefined;
  const evidence = input.accountId ? settledDestinationEvidence({ ...input, accountId: input.accountId }) : [];
  const aliases = input.accountId ? listAccountAliases().filter(row => row.connectionId === input.accountId) : [];
  const accountLabels = [...new Set(aliases.map(row => row.label))];
  const operation = input.preview.operation;
  const named = async (field: string, value: string, records: readonly unknown[]): Promise<string | null> => {
    const candidates = labelCandidatesFor(records, value);
    if (candidates.length === 0) return null;
    const question = { operation, field, value, candidates };
    return labelAskedOnce(input.memo, question,
      () => labelIdentifierWithJev(question, { sessionId: input.sessionId }));
  };
  const labelled = await Promise.all(values.map(async (value) => {
    const field = fields.find((row) => row.value === value)?.name ?? '';
    const direct = await named(field, value, payloads ??= recentSettledPayloads(input));
    if (direct) return [value, direct] as const;
    // The record that carries the value names nothing. Name what the value
    // was made from instead, on this account only, and say which account.
    const source = input.accountId ? producedFromIdentifier({ accountId: input.accountId, value, evidence }) : undefined;
    if (!source) return null;
    const through = await named(field, source, [...(payloads ??= recentSettledPayloads(input)), ...evidence.map((row) => row.result)]);
    return through ? [value, `${through}${accountLabels.length === 1 ? ` · ${accountLabels[0]}` : ''}`] as const : null;
  }));
  const entries = labelled.filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
