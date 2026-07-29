/**
 * run_batch — the deterministic batch primitive on the chat surface.
 *
 * propose → validate + certify (ONE judge pass) → reads execute immediately;
 * write/send plans queue as ONE pending action whose payload is the exact
 * plan (approval pins the payload hash; YOLO auto-approve works unchanged) →
 * execute runs the SERVER-STORED approved plan (the model cannot swap
 * payloads between approval and execution) → honest ledger comes back.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  certifyBatchPlan,
  formatBatchLedger,
  prepareBatchPlanForExecution,
  readBatchLedger,
  runBatchPlan,
  validateBatchPlan,
  type BatchPlan,
} from '../execution/batch-runner.js';
import {
  cancelPendingActionIfQueuedUnlinked,
  claimPendingActionExecution,
  getPendingAction,
  pendingActionPayloadHash,
  queuePendingAction,
  recordPendingActionResult,
} from '../runtime/harness/pending-actions.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { maybeBounceMassExecution } from '../agents/fanout-alignment-gate.js';
import { pendingActionRequiresHumanApproval } from '../runtime/harness/pending-action-policy.js';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

type BatchPlanRunner = typeof runBatchPlan;
let batchPlanRunner: BatchPlanRunner = runBatchPlan;

function currentBatchRequestAttribution(): {
  sourceUserSeq?: number;
  runScopeId?: string;
  callId?: string;
} {
  const outputContext = getToolOutputContext();
  const runContext = harnessRunContextStorage.getStore();
  const sourceUserSeq = runContext?.sourceUserSeq;
  return {
    ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? { sourceUserSeq: sourceUserSeq as number }
      : {}),
    ...((outputContext?.runScopeId ?? runContext?.behaviorScopeId)
      ? { runScopeId: outputContext?.runScopeId ?? runContext?.behaviorScopeId }
      : {}),
    ...(outputContext?.callId ? { callId: outputContext.callId } : {}),
  };
}

function requestOwnedBatchRetry(input: {
  sessionId: string;
  sourceUserSeq: number;
  payloadHash: string;
  kind: 'external_write' | 'external_send';
}) {
  try {
    const events = listEvents(input.sessionId, {
      types: ['autonomy_note'],
      sinceSeq: input.sourceUserSeq,
    });
    for (const event of events) {
      if (
        event.data.kind !== 'pending_action_queued'
        || event.data.sourceUserSeq !== input.sourceUserSeq
        || event.data.payloadHash !== input.payloadHash
        || event.data.actionKind !== input.kind
        || event.data.approvalRequired !== true
        || event.data.autoMaterialize !== true
        || event.data.toolName !== 'run_batch'
        || typeof event.data.pendingActionId !== 'string'
      ) continue;
      const record = getPendingAction(event.data.pendingActionId);
      if (
        record
        && record.sessionId === input.sessionId
        && record.toolName === 'run_batch'
        && record.payloadHash === input.payloadHash
        && record.kind === input.kind
      ) return record;
    }
  } catch {
    // The graph edge below remains the only path that can make this batch
    // executable. If dedupe state is unavailable, its durable write will fail
    // closed and cancel the newly queued record.
  }
  return null;
}

/** Test seam for proving approval consumption without a live provider call. */
export function _setBatchPlanRunnerForTests(fn: BatchPlanRunner | null): void {
  batchPlanRunner = fn ?? runBatchPlan;
}

function batchExecutionSkipText(id: string, status: string | undefined, claimUncertain = false): string {
  if (claimUncertain || status === 'executing') {
    return `Pending action ${id} already has an execution claim. It may be in progress or its outcome may be uncertain — no second batch was started, and it must not be retried automatically.`;
  }
  if (status === 'executed') return `Pending action ${id} was already executed — no second batch was started.`;
  if (status === 'failed') return `Pending action ${id} already has a failed or uncertain result — no automatic retry was started.`;
  return `Pending action ${id} is ${status ?? 'not available'} — it must be APPROVED before execution.`;
}

const BatchItemSchema = z.object({
  id: z.string().min(1).max(120).describe('Stable per-item id the ledger reports on (e.g. the recipient domain or record id).'),
  // A JSON STRING (not an open object) — the same shape composio_execute_tool
  // uses. An open z.record does not survive Codex strict-mode structured output
  // (it serializes to {}), which silently emptied every item's args and looped
  // the model on a duplicate-empty-args rejection (live 2026-07-07).
  args: z.string().min(2).describe('This item\'s FULLY materialized tool arguments as a JSON object STRING, e.g. {"keywords":["executive coaching"],"location_name":"United States"}. Nothing is resolved later — exactly what you write here executes.'),
});

export function registerBatchTools(server: McpServer): void {
  server.tool(
    'run_batch',
    [
      'Deterministic batch executor for N same-shape tool calls: reason ONCE (bake every item\'s args into a plan), certify ONCE (one judge pass over the plan), then the harness executes ALL items in a code loop with ZERO model calls between them — ~10x faster than calling the tool N times yourself, with an honest per-item ledger.',
      'USE THIS instead of calling the same tool item-by-item whenever you have 3+ items whose arguments you can fully materialize up front (send N emails, update N records, create N tasks, pull N reports). Use run_worker instead when each item needs its own REASONING.',
      'action=propose: submit the full plan. READ plans certify + execute immediately. WRITE/SEND plans queue as ONE pending action for approval — after it is approved, call action=execute with the pending_action_id.',
      'Writes/sends execute serially with per-call runtime gates intact; the loop halts after consecutive failures instead of replaying a systemic error. The ledger lists every failed item — report failures to the user honestly.',
      'HARD LIMITS (visible by design): max 500 items per plan (split larger jobs into consecutive plans); read concurrency max 8. Provider rate-limits auto-back-off (batch pauses, no items lost); re-running a partial batch is idempotent-safe — already-succeeded items are skipped, never re-executed.',
      'Plain public GET batches may use the bounded aliases http_fetch, web_fetch, web_fetch_simple, or fetch_url with item args {"url":"https://..."}; the harness resolves them to its real allowed curl path.',
    ].join(' '),
    {
      action: z.enum(['propose', 'execute', 'status']),
      plan: z.object({
        tool: z.string().describe('composio_execute_tool, an MCP <server>__<tool>, a local read tool, or bounded GET alias http_fetch/web_fetch/web_fetch_simple/fetch_url.'),
        composioSlug: z.string().nullable().optional().describe('Required when tool=composio_execute_tool: ONE slug for every item.'),
        sideEffect: z.enum(['read', 'write', 'send']),
        objective: z.string().min(8).max(400).describe('What this batch accomplishes — judged against the payloads.'),
        items: z.array(BatchItemSchema).min(1).max(500),
        concurrency: z.number().int().min(1).max(8).nullable().optional().describe('Reads only; writes always run serial.'),
        haltAfterConsecutiveFailures: z.number().int().min(1).max(20).nullable().optional(),
      }).nullable().optional().describe('Required for action=propose.'),
      pending_action_id: z.string().nullable().optional().describe('Required for action=execute (an APPROVED run_batch pending action).'),
      batch_id: z.string().nullable().optional().describe('Required for action=status.'),
    },
    async ({ action, plan: rawPlan, pending_action_id, batch_id }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) return textResult('ERROR: run_batch needs a live session context.');
      try {
        if (action === 'propose') {
          if (!rawPlan) return textResult('run_batch propose needs a plan.');
          // First-contact plan beat (armed at the policy classifier): the
          // code-mode batch door gets the same one conversational beat as
          // run_worker (2026-07-22: an inline batch bypassed the fan-out gate).
          const alignmentBounce = maybeBounceMassExecution(sessionId, {
            itemCount: rawPlan.items.length,
            sideEffect: rawPlan.sideEffect,
          });
          if (alignmentBounce.bounce && alignmentBounce.steer) return textResult(alignmentBounce.steer);
          // Parse each item's JSON-string args into an object up front, with a
          // precise per-item error so a malformed item is fixable, not a loop.
          const parsedItems: Array<{ id: string; args: Record<string, unknown> }> = [];
          const parseErrors: string[] = [];
          for (const it of rawPlan.items) {
            let obj: unknown;
            try { obj = JSON.parse(it.args); } catch { parseErrors.push(`item "${it.id}": args is not valid JSON`); continue; }
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { parseErrors.push(`item "${it.id}": args must be a JSON object`); continue; }
            parsedItems.push({ id: it.id, args: obj as Record<string, unknown> });
          }
          if (parseErrors.length > 0) return textResult(`Plan items have malformed args — fix and re-propose:\n${parseErrors.map((e) => `- ${e}`).join('\n')}`);
          const plan: BatchPlan = {
            tool: rawPlan.tool.trim(),
            composioSlug: rawPlan.composioSlug ?? undefined,
            sideEffect: rawPlan.sideEffect,
            objective: rawPlan.objective,
            items: parsedItems,
            concurrency: rawPlan.concurrency ?? undefined,
            haltAfterConsecutiveFailures: rawPlan.haltAfterConsecutiveFailures ?? undefined,
          };
          const prepared = prepareBatchPlanForExecution(plan);
          if (prepared.errors.length > 0) {
            // Actionable rejection (autopsy A8): a lazy plan that references a
            // prepared batch instead of materializing every payload (live
            // 2026-07-09 → a 5-minute chunked-recall spiral) gets the fastest
            // remediation named, not just "invalid".
            const missingFields = prepared.errors.some((e) => /missing required field/i.test(e));
            const remedy = missingFields
              ? '\n\nFASTEST FIX: each item\'s `args` must be the FULLY MATERIALIZED JSON for the tool — every required field present (the harness already normalizes to_email/subject/body and to→to_email, so do NOT hand-map). If the payloads already exist in a saved artifact, read that file ONCE and inline each item\'s complete args; do not reference the batch by name.'
              : '';
            return textResult(`Plan invalid after harness normalization — fix and re-propose:\n${prepared.errors.map((e) => `- ${e}`).join('\n')}${remedy}`);
          }
          const planForExecution = prepared.plan;
          const errors = validateBatchPlan(planForExecution);
          if (errors.length > 0) return textResult(`Plan invalid — DO NOT re-propose the identical plan; change what the errors name first:\n${errors.map((e) => `- ${e}`).join('\n')}`);
          const repairNote = prepared.repairs.length > 0
            ? ` Harness normalized ${prepared.repairs.length} batch item shape(s) before certification.`
            : '';
          const cert = await certifyBatchPlan(planForExecution);
          // A REAL denial (the judge RAN and flagged the payloads) is terminal —
          // fix + re-propose. But a judge that could NOT run (chain exhausted /
          // single-provider with no acceptable judge) must NOT strand the batch:
          // cert.judgeUnavailable routes it to the human as the fallback judge
          // (send/write → approval card; read → proceed, labeled unverified).
          if (!cert.allow && !cert.judgeUnavailable) {
            return textResult(
              `Plan REFUSED by certification: ${cert.reason}`
              + (cert.concerns.length ? `\nConcerns:\n${cert.concerns.map((c) => `- ${c}`).join('\n')}` : '')
              + '\nFix the payloads and re-propose; do NOT retry the identical plan.',
            );
          }
          const unverified = cert.judgeUnavailable === true;
          if (planForExecution.sideEffect === 'read') {
            const ledger = await batchPlanRunner(planForExecution, sessionId);
            const label = unverified
              ? `Unverified (judge unavailable — ${cert.reason}).`
              : `Certified (${cert.reason || 'ok'}).`;
            return textResult(`${label}${repairNote} Executed.\n${formatBatchLedger(ledger)}`);
          }
          // Kind anchors on the SLUG, not only the model-declared sideEffect —
          // an OUTLOOK_*_SEND_* plan labeled 'write' must still queue as an
          // external_send so the YOLO send gate sees it (adversarial-review
          // blocker, 2026-07-09).
          const { isIrreversibleSendSlug } = await import('../runtime/harness/confirm-first-gate.js');
          const slugIsSend = typeof planForExecution.composioSlug === 'string'
            && isIrreversibleSendSlug(planForExecution.composioSlug);
          const certNote = unverified
            ? `I can't independently verify this batch right now (${cert.reason}) — your approval IS the verification.`
            : `Certification: ${cert.reason || 'allowed'}`;
          const kind = planForExecution.sideEffect === 'send' || slugIsSend
            ? 'external_send' as const
            : 'external_write' as const;
          const attribution = currentBatchRequestAttribution();
          if (!attribution.sourceUserSeq) {
            return textResult(
              'run_batch refused this write proposal safely because the active user request could not be durably identified. '
              + 'No approval or executable batch was created; retry once from the live task so the exact batch can own one approval card.',
            );
          }
          const payloadHash = pendingActionPayloadHash('run_batch', planForExecution);
          let record = requestOwnedBatchRetry({
            sessionId,
            sourceUserSeq: attribution.sourceUserSeq,
            payloadHash,
            kind,
          });
          const reused = Boolean(record);
          if (!record) {
            record = queuePendingAction({
              title: unverified
                ? `Review & approve (unverified) — batch ${planForExecution.sideEffect}: ${planForExecution.objective.slice(0, 60)}`
                : `Batch ${planForExecution.sideEffect}: ${planForExecution.objective.slice(0, 80)}`,
              summary: `run_batch plan · ${planForExecution.tool}${planForExecution.composioSlug ? `/${planForExecution.composioSlug}` : ''} · ${planForExecution.items.length} item(s), executed deterministically after approval. ${certNote}${repairNote}`,
              kind,
              toolName: 'run_batch',
              payload: planForExecution,
              targetSummary: `${planForExecution.items.length} item(s): ${planForExecution.items.map((i) => i.id).slice(0, 12).join(', ')}${planForExecution.items.length > 12 ? ' …' : ''}`,
              preview: JSON.stringify(planForExecution.items[0]?.args ?? {}).slice(0, 400),
              risk: `Executes ${planForExecution.items.length} ${planForExecution.sideEffect} call(s) with no further review; per-call gates and consecutive-failure halt remain active.`
                + (unverified ? ' NOTE: automated certification was unavailable — this batch was not machine-verified, so review the payloads before approving.' : ''),
              rollback: planForExecution.sideEffect === 'send' ? 'Sends are irreversible once delivered.' : 'Depends on the target tool; the ledger lists every executed item.',
              sessionId,
              createdBy: 'run_batch',
            });
            try {
              appendEvent({
                sessionId,
                turn: 0,
                role: 'Clem',
                type: 'autonomy_note',
                data: {
                  kind: 'pending_action_queued',
                  pendingActionId: record.id,
                  toolName: record.toolName,
                  actionKind: record.kind,
                  approvalRequired: true,
                  autoMaterialize: true,
                  payloadHash: record.payloadHash,
                  targetSummary: record.targetSummary,
                  sourceUserSeq: attribution.sourceUserSeq,
                  ...(attribution.runScopeId ? { runScopeId: attribution.runScopeId } : {}),
                  ...(attribution.callId ? { callId: attribution.callId } : {}),
                },
              });
            } catch {
              cancelPendingActionIfQueuedUnlinked(
                record.id,
                record.id,
                'Approval-bound batch was cancelled because its durable request edge could not be recorded.',
              );
              return textResult(
                'run_batch failed safely: the exact batch could not be linked to its one approval card. '
                + 'Nothing is authorized or executable; retry the proposal once.',
              );
            }
          }
          return textResult(
            (unverified
              ? `I couldn't independently verify this batch (${cert.reason}). Rather than block it, I've queued it for YOUR review — the human is the fallback judge.${repairNote} `
              : `Certified (${cert.reason || 'allowed'}).${repairNote} `)
            + `${reused ? 'Reused the request-owned' : 'Queued for approval as'} pending action ${record.id} (${planForExecution.items.length} ${planForExecution.sideEffect} item(s)). `
            + 'The harness will surface exactly one approval card for this stored batch. '
            + `Once it is APPROVED, call run_batch action=execute pending_action_id=${record.id}. Do not execute items yourself.`,
          );
        }
        if (action === 'execute') {
          if (!pending_action_id) return textResult('run_batch execute needs pending_action_id.');
          const record = getPendingAction(pending_action_id);
          if (!record) return textResult(`No pending action ${pending_action_id}.`);
          if (record.toolName !== 'run_batch') return textResult(`Pending action ${pending_action_id} is not a run_batch plan.`);
          if (!record.sessionId || record.sessionId !== sessionId) {
            return textResult(
              `Pending action ${pending_action_id} belongs to a different session and was not executed.`,
            );
          }
          if (record.status !== 'approved') {
            return textResult(batchExecutionSkipText(pending_action_id, record.status));
          }
          // GRANT INVARIANT I1 (Phase 1): an irreversible send batch executes
          // only on HUMAN consent. A policy-minted approval (YOLO auto-approve,
          // Exhibit A's forgery point) is inert here — the honest path is the
          // approval card, which this refusal names.
          if (pendingActionRequiresHumanApproval(record) && record.approvedBy !== 'human') {
            return textResult(
              `Pending action ${pending_action_id} is an irreversible send batch approved by POLICY, not by the user. `
              + 'It requires the user\'s explicit approval card before execution — file it with request_approval '
              + `(pendingActionId=${pending_action_id}) and wait for their decision.`,
            );
          }
          const prepared = prepareBatchPlanForExecution(record.payload as BatchPlan);
          if (prepared.errors.length > 0) return textResult(`Stored plan failed normalization (${prepared.errors.join('; ')}) — do not execute; re-propose.`);
          const plan = prepared.plan;
          const errors = validateBatchPlan(plan);
          if (errors.length > 0) return textResult(`Stored plan failed re-validation (${errors.join('; ')}) — do not execute; re-propose.`);
          // Atomically consume APPROVED immediately before the external loop.
          // Concurrent chat/console/process callers that lose this claim see
          // EXECUTING (or terminal truth) and never start a second batch.
          const claim = claimPendingActionExecution(record.id, 'run_batch', {
            expectedSessionId: sessionId,
            requireResolvedHumanCard: pendingActionRequiresHumanApproval(record),
          });
          if (!claim.claimed || !claim.record || !claim.claimToken) {
            if (
              claim.reason === 'payload_integrity_failed'
              || claim.reason === 'approval_authority_invalid'
            ) {
              return textResult(
                claim.record?.resultSummary
                ?? `Pending action ${pending_action_id} failed its pre-dispatch authorization integrity check. No batch was started.`,
              );
            }
            return textResult(batchExecutionSkipText(
              pending_action_id,
              claim.record?.status,
              claim.reason === 'claim_in_progress_or_uncertain',
            ));
          }
          const claimedRecord = claim.record;
          const claimToken = claim.claimToken;
          // Execute only the snapshot returned by the claim. Re-validation
          // fails safe if a record was manually edited between the first read
          // and the compare-and-swap.
          const claimedPrepared = prepareBatchPlanForExecution(claimedRecord.payload as BatchPlan);
          if (claimedPrepared.errors.length > 0) {
            const reason = `Claimed stored plan failed normalization (${claimedPrepared.errors.join('; ')}). No provider call was made.`;
            recordPendingActionResult(claimedRecord.id, 'failed', reason, 'run_batch', claimToken);
            return textResult(`${reason} Re-propose a corrected plan; do not retry this action.`);
          }
          const claimedPlan = claimedPrepared.plan;
          const claimedErrors = validateBatchPlan(claimedPlan);
          if (claimedErrors.length > 0) {
            const reason = `Claimed stored plan failed re-validation (${claimedErrors.join('; ')}). No provider call was made.`;
            recordPendingActionResult(claimedRecord.id, 'failed', reason, 'run_batch', claimToken);
            return textResult(`${reason} Re-propose a corrected plan; do not retry this action.`);
          }
          // Certified + approved: clean stored plans passed ONE certification
          // judge over these exact payloads and approval byte-pins them by
          // payloadHash, so the per-item LLM boundary judges are skipped. If an
          // older stored plan needed rescue normalization at execute time, do
          // NOT claim exact-payload certification; let the per-item judges run.
          const certified = claimedPrepared.repairs.length === 0 ? { payloadHash: claimedRecord.payloadHash } : undefined;
          let ledger: Awaited<ReturnType<BatchPlanRunner>>;
          try {
            ledger = await batchPlanRunner(claimedPlan, sessionId, certified ? { certified } : undefined);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const uncertain = `Batch execution failed or became uncertain after dispatch began: ${message}. Do not retry automatically.`;
            recordPendingActionResult(claimedRecord.id, 'failed', uncertain, 'run_batch', claimToken);
            return textResult(`run_batch failed or is uncertain: ${message}. No automatic retry is safe.`);
          }
          try {
            recordPendingActionResult(
              claimedRecord.id,
              ledger.failed === 0 && !ledger.halted ? 'executed' : 'failed',
              `${ledger.succeeded}/${ledger.total} succeeded, ${ledger.failed} failed${ledger.halted ? ', HALTED' : ''} (ledger ${ledger.batchId})`,
              'run_batch',
              claimToken,
            );
          } catch { /* result note is best-effort */ }
          return textResult(formatBatchLedger(ledger));
        }
        if (!batch_id) return textResult('run_batch status needs batch_id.');
        const ledger = readBatchLedger(batch_id);
        if (!ledger) return textResult(`No batch ledger ${batch_id}.`);
        return textResult(formatBatchLedger(ledger));
      } catch (err) {
        return textResult(`run_batch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
