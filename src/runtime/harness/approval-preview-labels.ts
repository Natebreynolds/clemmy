import { composioApprovalDestinationLabel, type ApprovalDestinationEvidence } from '../../integrations/composio/approval-destination-label.js';
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

/** Exact source/account-scoped relations, with no inference or model calls. */
export function settledDestinationEvidence(input: {
  sessionId: string; sourceUserSeq: number; accountId: string;
}): ApprovalDestinationEvidence[] {
  const db = openEventLog();
  const rows = db.prepare(`SELECT logical_tool_call_id AS callId FROM logical_call_settlements
    WHERE session_id = ? AND source_user_seq = ? AND outcome_kind = 'succeeded'
    ORDER BY rowid DESC LIMIT 200`).all(input.sessionId, input.sourceUserSeq) as Array<{ callId: string }>;
  const evidence: ApprovalDestinationEvidence[] = [];
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

/** value -> the name Jev is sure of, for each identifier on the card. */
export async function approvalPreviewLabels(input: {
  sessionId: string;
  sourceUserSeq: number;
  preview: ApprovalCallPreview | null;
  nowMs?: number;
  accountId?: string | null;
  operationId?: string;
}): Promise<Record<string, string> | undefined> {
  const fields = (input.preview?.fields ?? []).filter((field) => identifierValue(field.value));
  const values = [...new Set(fields.map((field) => field.value))].slice(0, MAX_LABELLED_VALUES);
  if (!input.preview || values.length === 0) return undefined;
  let payloads: unknown[] | undefined;
  const evidence = input.accountId ? settledDestinationEvidence({ ...input, accountId: input.accountId }) : [];
  const aliases = input.accountId ? listAccountAliases().filter(row => row.connectionId === input.accountId) : [];
  const accountLabels = [...new Set(aliases.map(row => row.label))];
  const operation = input.preview.operation;
  const labelled = await Promise.all(values.map(async (value) => {
    const exact = input.operationId && input.accountId ? composioApprovalDestinationLabel({
      operation: input.operationId, accountId: input.accountId, value, evidence,
    }) : undefined;
    if (exact) return [value, `${exact}${accountLabels.length === 1 ? ` · ${accountLabels[0]}` : ''}`] as const;
    const candidates = labelCandidatesFor(payloads ??= recentSettledPayloads(input), value);
    if (candidates.length === 0) return null;
    const field = fields.find((row) => row.value === value)?.name ?? '';
    const label = await labelIdentifierWithJev(
      { operation, field, value, candidates },
      { sessionId: input.sessionId },
    ).catch(() => null);
    return label ? [value, label] as const : null;
  }));
  const entries = labelled.filter((entry): entry is readonly [string, string] => entry !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
