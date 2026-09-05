/** Completion projection, not an execution gate: an accepted, typed item
 * declaration does not disappear because its coordinator never entered. */
import type { AgentInputItem } from '@openai/agents';
import { WorkerToolCallSchema, workerCallItems, workerPacketKey } from '../../agents/worker-job-packet.js';
import { acceptedModelBatchHistoryDigest } from './accepted-model-batch-checkpoint.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import { listEvents, openEventLog, type EventRow } from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { summarizeWorkManifest, type WorkEvidenceRef } from './work-manifest.js';
import { chatAutoContinueCap, chatAutoContinueDecision } from './continue-directive.js';

export interface PendingLocalWork {
  reason: string;
  missing: string[];
}

/** The existing event ledger owns continuation expenditure, including across
 * checkpoint/daemon re-entry. Failed calls cannot count as item progress once
 * the host has already returned the exact missing-item repair. */
export function pendingLocalWorkContinuation(input: {
  sessionId: string;
  sourceUserSeq: number;
  autoContinueOnLimit: boolean;
  toolCalls: number;
  pending: PendingLocalWork;
}): { resume: true; attempt: number } | { resume: false; reason: string } {
  const prior = listEvents(input.sessionId, { types: ['guardrail_tripped'], sinceSeq: input.sourceUserSeq })
    .filter((event) => event.role === 'system' && event.data.kind === 'local_work_continuation'
      && event.data.sourceUserSeq === input.sourceUserSeq);
  const lastMissing = prior.at(-1)?.data.missing;
  const remaining = new Set(input.pending.missing);
  const itemProgress = Array.isArray(lastMissing)
    ? lastMissing.filter((id) => typeof id === 'string' && !remaining.has(id)).length
    : input.toolCalls;
  const decision = chatAutoContinueDecision({
    autoContinueOnLimit: input.autoContinueOnLimit,
    attempts: prior.length,
    cap: chatAutoContinueCap(),
    stepsThisActivation: itemProgress,
  });
  return decision.resume ? { resume: true, attempt: prior.length + 1 } : decision;
}

/** Only existing accepted call bytes and host-owned receipts are consulted.
 * Ordinary conversation, speculative tool attempts and count-only prose never
 * create a demand. No manifest is declared or compiled by this projection. */
export function pendingAcceptedLocalWork(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PendingLocalWork | null {
  const db = openEventLog();
  const admissions = db.prepare(`
    SELECT a.frame_history_json, a.frame_history_digest
      FROM accepted_model_batch_admissions a
      JOIN accepted_turn_call_authorities root
        ON root.session_id = a.session_id AND root.source_user_seq = a.source_user_seq
       AND root.authority_digest = a.authority_digest
       AND root.source_event_digest = a.source_event_digest
     WHERE a.session_id = ? AND a.source_user_seq = ?
     ORDER BY a.batch_ordinal
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    frame_history_json: string; frame_history_digest: string;
  }>;
  if (admissions.length === 0) return null;
  const sourceEvents = listEvents(input.sessionId, { sinceSeq: input.sourceUserSeq - 1 });
  const nextSource = sourceEvents.find((event) => event.seq > input.sourceUserSeq && event.type === 'user_input_received');
  const ownedEvents = sourceEvents.filter((event) => event.seq > input.sourceUserSeq
    && (event.data.sourceUserSeq === input.sourceUserSeq
      || (event.data.sourceUserSeq === undefined && (!nextSource || event.seq < nextSource.seq))));
  const eventBySeq = new Map(ownedEvents.map((event) => [event.seq, event]));
  const missing = new Set<string>();
  for (const row of admissions) {
    const frame = JSON.parse(row.frame_history_json) as AgentInputItem[];
    if (acceptedModelBatchHistoryDigest(frame) !== row.frame_history_digest) continue;
    for (const item of frame) {
      const call = item as { type?: string; name?: string; arguments?: string };
      if (call.type !== 'function_call' || !call.name || typeof call.arguments !== 'string') continue;
      let args: unknown;
      try { args = JSON.parse(call.arguments); } catch { continue; }
      const effective = unwrapRuntimeEffectiveToolIdentity(call.name, args);
      if (effective.toolName !== 'run_worker') continue;
      const parsed = WorkerToolCallSchema.safeParse(effective.args);
      if (!parsed.success || !parsed.data.workManifest || (parsed.data.externalMcpToolNames?.length ?? 0) > 0) continue;
      const packet = parsed.data;
      const descriptor = packet.workManifest!;
      const items = workerCallItems(packet);
      if (!items || descriptor.mode !== 'declare') continue;
      const declaration = ownedEvents.find((event) => event.type === 'work_manifest_declared'
        && event.data.sourceUserSeq === input.sourceUserSeq && event.data.manifestId === descriptor.id);
      const manifest = declaration ? summarizeWorkManifest(input.sessionId, descriptor.id) : null;
      for (const item of items) {
        const packetKey = workerPacketKey({ ...packet, item });
        const latestWorker = [...ownedEvents].reverse().find((event) => event.type === 'worker_result'
          && event.role === 'system' && event.data.packetKey === packetKey && event.data.item === item);
        if (latestWorker?.data.ok === true) continue;
        const itemId = descriptor.aliases?.find((entry) => entry.alias === item)?.itemId ?? item;
        const state = manifest?.contractVersion === descriptor.contractVersion
          ? manifest.items.find((entry) => entry.id === itemId)?.phases[descriptor.phase]
          : undefined;
        // An inline repair may discharge the exact same canonical item through
        // its existing manifest checkpoint and a real result receipt. Mere later
        // preflight/read handles, or successful prose, cannot discharge it.
        if (state?.status === 'succeeded' && state.evidence.some((ref) => settledItemEvidence(input, ref, eventBySeq))) continue;
        missing.add(`${descriptor.id}/${descriptor.phase}/${itemId}`);
      }
    }
  }
  return missing.size > 0 ? {
    reason: `${missing.size} accepted local work item(s) have no successful item result. Retained partial results remain available; resume the remaining items.`,
    missing: [...missing],
  } : null;
}

function settledItemEvidence(
  input: { sessionId: string; sourceUserSeq: number },
  ref: WorkEvidenceRef,
  events: ReadonlyMap<number, EventRow>,
): boolean {
  const seq = /^event:(\d+)$/.exec(ref.ref);
  if (seq) {
    const event = events.get(Number(seq[1]));
    if (!event || event.role !== 'system') return false;
    if (ref.kind === 'worker_result') return event.type === 'worker_result' && event.data.ok === true;
    return ref.kind === 'tool_result' && event.type === 'tool_returned'
      && event.data.sourceUserSeq === input.sourceUserSeq && event.data.accounting === 'top_level'
      && (event.data.successfulBusinessResult === true || event.data.successfulAuthoringResult === true);
  }
  if (ref.kind !== 'tool_result') return false;
  const settled = redeemSuccessfulSettlementResultForHost({
    ...input, acceptedTaskId: acceptedTaskIdFor(input.sessionId, input.sourceUserSeq), logicalToolCallId: ref.ref,
  });
  return settled.status === 'ok';
}
