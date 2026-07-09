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
  getPendingAction,
  queuePendingAction,
  recordPendingActionResult,
} from '../runtime/harness/pending-actions.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

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
    ].join(' '),
    {
      action: z.enum(['propose', 'execute', 'status']),
      plan: z.object({
        tool: z.string().describe('composio_execute_tool, an MCP <server>__<tool>, or a local read tool.'),
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
            return textResult(`Plan invalid after harness normalization — fix and re-propose:\n${prepared.errors.map((e) => `- ${e}`).join('\n')}`);
          }
          const planForExecution = prepared.plan;
          const errors = validateBatchPlan(planForExecution);
          if (errors.length > 0) return textResult(`Plan invalid — DO NOT re-propose the identical plan; change what the errors name first:\n${errors.map((e) => `- ${e}`).join('\n')}`);
          const repairNote = prepared.repairs.length > 0
            ? ` Harness normalized ${prepared.repairs.length} batch item shape(s) before certification.`
            : '';
          const cert = await certifyBatchPlan(planForExecution);
          if (!cert.allow) {
            return textResult(
              `Plan REFUSED by certification: ${cert.reason}`
              + (cert.concerns.length ? `\nConcerns:\n${cert.concerns.map((c) => `- ${c}`).join('\n')}` : '')
              + '\nFix the payloads and re-propose; do NOT retry the identical plan.',
            );
          }
          if (planForExecution.sideEffect === 'read') {
            const ledger = await runBatchPlan(planForExecution, sessionId);
            return textResult(`Certified (${cert.reason || 'ok'}).${repairNote} Executed.\n${formatBatchLedger(ledger)}`);
          }
          // Kind anchors on the SLUG, not only the model-declared sideEffect —
          // an OUTLOOK_*_SEND_* plan labeled 'write' must still queue as an
          // external_send so the YOLO send gate sees it (adversarial-review
          // blocker, 2026-07-09).
          const { IRREVERSIBLE_VERBS } = await import('../runtime/harness/confirm-first-gate.js');
          const slugIsSend = typeof planForExecution.composioSlug === 'string'
            && planForExecution.composioSlug.split('_').some((p) => IRREVERSIBLE_VERBS.has(p.toUpperCase()));
          const record = queuePendingAction({
            title: `Batch ${planForExecution.sideEffect}: ${planForExecution.objective.slice(0, 80)}`,
            summary: `run_batch plan · ${planForExecution.tool}${planForExecution.composioSlug ? `/${planForExecution.composioSlug}` : ''} · ${planForExecution.items.length} item(s), executed deterministically after approval. Certification: ${cert.reason || 'allowed'}${repairNote}`,
            kind: planForExecution.sideEffect === 'send' || slugIsSend ? 'external_send' : 'external_write',
            toolName: 'run_batch',
            payload: planForExecution,
            targetSummary: `${planForExecution.items.length} item(s): ${planForExecution.items.map((i) => i.id).slice(0, 12).join(', ')}${planForExecution.items.length > 12 ? ' …' : ''}`,
            preview: JSON.stringify(planForExecution.items[0]?.args ?? {}).slice(0, 400),
            risk: `Executes ${planForExecution.items.length} ${planForExecution.sideEffect} call(s) with no further review; per-call gates and consecutive-failure halt remain active.`,
            rollback: planForExecution.sideEffect === 'send' ? 'Sends are irreversible once delivered.' : 'Depends on the target tool; the ledger lists every executed item.',
            sessionId,
            createdBy: 'run_batch',
          });
          return textResult(
            `Certified (${cert.reason || 'allowed'}).${repairNote} Queued for approval as pending action ${record.id} (${planForExecution.items.length} ${planForExecution.sideEffect} item(s)). `
            + `Once it is APPROVED, call run_batch action=execute pending_action_id=${record.id}. Do not execute items yourself.`,
          );
        }
        if (action === 'execute') {
          if (!pending_action_id) return textResult('run_batch execute needs pending_action_id.');
          const record = getPendingAction(pending_action_id);
          if (!record) return textResult(`No pending action ${pending_action_id}.`);
          if (record.toolName !== 'run_batch') return textResult(`Pending action ${pending_action_id} is not a run_batch plan.`);
          if (record.status !== 'approved') {
            return textResult(`Pending action ${pending_action_id} is ${record.status} — it must be APPROVED before execution.`);
          }
          const prepared = prepareBatchPlanForExecution(record.payload as BatchPlan);
          if (prepared.errors.length > 0) return textResult(`Stored plan failed normalization (${prepared.errors.join('; ')}) — do not execute; re-propose.`);
          const plan = prepared.plan;
          const errors = validateBatchPlan(plan);
          if (errors.length > 0) return textResult(`Stored plan failed re-validation (${errors.join('; ')}) — do not execute; re-propose.`);
          // Certified + approved: clean stored plans passed ONE certification
          // judge over these exact payloads and approval byte-pins them by
          // payloadHash, so the per-item LLM boundary judges are skipped. If an
          // older stored plan needed rescue normalization at execute time, do
          // NOT claim exact-payload certification; let the per-item judges run.
          const certified = prepared.repairs.length === 0 ? { payloadHash: record.payloadHash } : undefined;
          const ledger = await runBatchPlan(plan, sessionId, certified ? { certified } : undefined);
          try {
            recordPendingActionResult(record.id, ledger.failed === 0 && !ledger.halted ? 'executed' : 'failed',
              `${ledger.succeeded}/${ledger.total} succeeded, ${ledger.failed} failed${ledger.halted ? ', HALTED' : ''} (ledger ${ledger.batchId})`);
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
