/**
 * Batch Runner — the deterministic execution primitive for same-shape work:
 * "reason ONCE, certify ONCE, execute N times with ZERO model calls in the loop."
 *
 * Live 2026-07-07: sending 18 approved first-touch emails cost a full model
 * round-trip (~10s on a 50–90K context) + per-send judging + housekeeping —
 * ~18s per item for work that was mechanical after the drafts were written.
 * The same shape recurs across the whole composio/MCP surface (thousands of
 * tools): update N records, create N tasks, pull N reports.
 *
 * Contract:
 *   1. PLAN — the model materializes a BatchPlan: one tool, N items with
 *      fully-baked args, declared side-effect, objective. The plan IS the
 *      artifact: what gets certified is byte-for-byte what executes.
 *   2. CERTIFY — deterministic validation (shape, duplicate args, caps) plus
 *      ONE judge pass over the plan (objective vs sampled payloads).
 *      Fail-CLOSED for write/send plans; advisory for reads.
 *   3. APPROVE — write/send plans queue as ONE pending action whose payload
 *      is the plan (payloadHash pins the exact items). YOLO auto-approve and
 *      the approval UI both work unchanged. Reads skip straight to execute.
 *   4. LOOP — deterministic iteration through the SAME gated tool dispatch
 *      the rest of the harness uses (write boundary, guardrails, telemetry
 *      all fire per call). Writes run serial; reads run in small waves.
 *      Per-item one retry on transient failure; halt after K consecutive
 *      failures; honest per-item ledger persisted to state/batch-runs/.
 *   5. VERIFY — compact summary (sent/failed/halted + failed ids) returned
 *      to the model, which must relay failures honestly; failed items are
 *      the ONLY place model reasoning re-enters (repair pass).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { dispatchBatchItemTool, READ_ONLY_TOOLS, isMcpNamespacedTool } from '../tools/code-mode-tool.js';
import { ToolCallsCounter } from '../runtime/harness/brackets.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { appendEvent } from '../runtime/harness/eventlog.js';

const logger = pino({ name: 'clementine-next.batch-runner' });

const BATCH_RUNS_DIR = path.join(BASE_DIR, 'state', 'batch-runs');

export type BatchSideEffect = 'read' | 'write' | 'send';

export interface BatchPlanItem {
  /** Stable per-item id the ledger reports on (e.g. the recipient domain). */
  id: string;
  /** FULLY materialized tool arguments for this item — nothing resolved later. */
  args: Record<string, unknown>;
}

export interface BatchPlan {
  /** Tool every item calls: `composio_execute_tool`, an MCP `<server>__<tool>`, or a local read tool. */
  tool: string;
  /** When tool is composio_execute_tool: ONE fixed slug for the whole batch (per-item args exclude it). */
  composioSlug?: string;
  sideEffect: BatchSideEffect;
  /** What this batch accomplishes — judged against the payloads. */
  objective: string;
  items: BatchPlanItem[];
  /** Reads only; writes/sends always run serial. Clamped 1..8. */
  concurrency?: number;
  haltAfterConsecutiveFailures?: number;
}

export interface BatchItemOutcome {
  id: string;
  ok: boolean;
  attempts: number;
  ms: number;
  error?: string;
  resultPreview?: string;
}

export interface BatchRunLedger {
  batchId: string;
  sessionId: string;
  tool: string;
  composioSlug?: string;
  sideEffect: BatchSideEffect;
  objective: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  halted: boolean;
  haltReason?: string;
  outcomes: BatchItemOutcome[];
}

const MAX_ITEMS = 500;

// ─── Validation (pure, deterministic) ────────────────────────────────────────

export function validateBatchPlan(plan: BatchPlan): string[] {
  const errors: string[] = [];
  if (!plan || typeof plan !== 'object') return ['plan must be an object'];
  if (typeof plan.tool !== 'string' || !plan.tool.trim()) errors.push('tool is required');
  if (!['read', 'write', 'send'].includes(plan.sideEffect)) errors.push('sideEffect must be read | write | send');
  if (typeof plan.objective !== 'string' || plan.objective.trim().length < 8) errors.push('objective is required (≥8 chars)');
  if (!Array.isArray(plan.items) || plan.items.length === 0) errors.push('items must be a non-empty array');
  if (Array.isArray(plan.items) && plan.items.length > MAX_ITEMS) errors.push(`items exceeds the ${MAX_ITEMS} cap`);
  const tool = (plan.tool ?? '').trim();
  if (tool === 'composio_execute_tool') {
    if (typeof plan.composioSlug !== 'string' || !plan.composioSlug.trim()) {
      errors.push('composio batches must pin ONE composioSlug for every item');
    }
  } else if (!isMcpNamespacedTool(tool) && !READ_ONLY_TOOLS.has(tool)) {
    errors.push(`tool "${tool}" is not batchable — allowed: composio_execute_tool, MCP <server>__<tool>, or a local read tool`);
  }
  if (tool !== 'composio_execute_tool' && !isMcpNamespacedTool(tool) && plan.sideEffect !== 'read') {
    errors.push('local tools are batchable as READ plans only');
  }
  if (Array.isArray(plan.items)) {
    const seenIds = new Set<string>();
    const seenArgs = new Set<string>();
    plan.items.forEach((item, index) => {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) errors.push(`items[${index}] needs a stable string id`);
      else if (seenIds.has(item.id)) errors.push(`duplicate item id "${item.id}"`);
      else seenIds.add(item.id);
      if (!item || typeof item.args !== 'object' || item.args === null || Array.isArray(item.args)) {
        errors.push(`items[${index}].args must be an object of fully-materialized arguments`);
      } else if (Object.keys(item.args).length === 0) {
        // The most common model mistake: putting the value in `id` and leaving
        // args empty. Name it precisely so it's a one-shot fix, not a loop.
        errors.push(`items[${index}] ("${item.id ?? ''}") has EMPTY args — put this item's real tool arguments in args (the id is only a label), e.g. {"keywords":["${item.id ?? 'value'}"], …}`);
      } else {
        const sig = JSON.stringify(item.args);
        if (seenArgs.has(sig)) errors.push(`items[${index}] duplicates another item's exact args — a batch must not repeat identical calls`);
        else seenArgs.add(sig);
      }
    });
  }
  return errors;
}

// ─── Certification judge (ONE model call for the whole plan) ────────────────

const BatchVerdictSchema = z.object({
  allow: z.boolean(),
  reason: z.string().max(400),
  concerns: z.array(z.string().max(200)).max(8).nullable().optional(),
});

export interface BatchCertification {
  allow: boolean;
  reason: string;
  concerns: string[];
  judged: boolean;
}

export async function certifyBatchPlan(plan: BatchPlan): Promise<BatchCertification> {
  const sample = plan.items.slice(0, 10);
  const input = [
    `OBJECTIVE: ${plan.objective}`,
    `TOOL: ${plan.tool}${plan.composioSlug ? ` (slug ${plan.composioSlug})` : ''} · side-effect: ${plan.sideEffect} · items: ${plan.items.length}`,
    `ITEM IDS: ${plan.items.map((i) => i.id).slice(0, 60).join(', ')}${plan.items.length > 60 ? ` … +${plan.items.length - 60}` : ''}`,
    `SAMPLED PAYLOADS (${sample.length} of ${plan.items.length}):`,
    JSON.stringify(sample, null, 1).slice(0, 12_000),
  ].join('\n');
  try {
    const agent = new Agent<unknown, typeof BatchVerdictSchema>({
      name: 'Batch Plan Judge',
      model: resolveRoleModel('judge').modelId,
      instructions: [
        'You certify a BATCH PLAN before deterministic execution: one tool, N pre-baked payloads, executed with no further review.',
        'ALLOW only when the sampled payloads actually accomplish the stated objective and nothing in them looks misdirected: wrong recipients/targets for the objective, placeholder or template-variable text left in ({{name}}, TODO, lorem), payloads inconsistent with each other, or a scope wider than the objective states.',
        'You are the ONLY review these payloads get — when unsure on a write/send plan, set allow=false and say why.',
      ].join(' '),
      outputType: normalizeZodForCodexStrict(BatchVerdictSchema) as typeof BatchVerdictSchema,
    });
    const runner = new Runner({ workflowName: 'clementine-batch-certify' });
    const result = await runner.run(agent, input);
    const final = (result as { finalOutput?: z.infer<typeof BatchVerdictSchema> }).finalOutput;
    if (!final || typeof final.allow !== 'boolean') throw new Error('judge returned no verdict');
    return { allow: final.allow, reason: final.reason ?? '', concerns: (final.concerns ?? []).filter((c): c is string => typeof c === 'string'), judged: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fail-CLOSED for irreversible plans, advisory for reads (Wave 0 semantics).
    if (plan.sideEffect === 'read') {
      logger.warn({ err: message }, 'batch certify judge unavailable — READ plan proceeds advisory');
      return { allow: true, reason: `judge unavailable (${message}) — read plan proceeds without certification`, concerns: [], judged: false };
    }
    return { allow: false, reason: `certification judge unavailable for a ${plan.sideEffect} plan — refusing (fail-closed): ${message}`, concerns: [], judged: false };
  }
}

// ─── Deterministic loop ──────────────────────────────────────────────────────

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return (s ?? '').slice(0, 200);
}

function errorLooksTransient(message: string): boolean {
  return /timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|429|rate.?limit|5\d\d|socket hang up|network/i.test(message);
}

export async function runBatchPlan(plan: BatchPlan, sessionId: string): Promise<BatchRunLedger> {
  const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const serial = plan.sideEffect !== 'read';
  const concurrency = serial ? 1 : Math.max(1, Math.min(8, plan.concurrency ?? 4));
  const haltAfter = Math.max(1, Math.min(20, plan.haltAfterConsecutiveFailures ?? 3));
  // One counter across the whole batch so loop-guard windows see it as one turn.
  const counter = new ToolCallsCounter(Math.max(1000, plan.items.length * 4));
  const outcomes: BatchItemOutcome[] = [];
  let consecutiveFailures = 0;
  let halted = false;
  let haltReason: string | undefined;

  try {
    appendEvent({ sessionId, turn: 0, role: 'system', type: 'batch_started', data: { batchId, tool: plan.tool, slug: plan.composioSlug ?? null, sideEffect: plan.sideEffect, items: plan.items.length, concurrency } });
  } catch { /* telemetry never blocks */ }

  const runItem = async (item: BatchPlanItem): Promise<BatchItemOutcome> => {
    const t0 = Date.now();
    const args = plan.tool === 'composio_execute_tool'
      ? { tool_slug: plan.composioSlug, arguments: JSON.stringify(item.args) }
      : item.args;
    let attempts = 0;
    let lastError = '';
    while (attempts < 2) {
      attempts += 1;
      try {
        const out = await dispatchBatchItemTool(plan.tool, args, sessionId, counter);
        const text = previewOf(out);
        // A composio "polite failure" comes back as a normal result whose text
        // is an error banner — do not count those as success.
        if (/^⚠️|FAILED \(slug=|NOT CONNECTED/i.test(text)) {
          lastError = text.slice(0, 200);
          if (attempts < 2 && errorLooksTransient(text)) continue;
          return { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError };
        }
        return { id: item.id, ok: true, attempts, ms: Date.now() - t0, resultPreview: text };
      } catch (err) {
        lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        if (attempts < 2 && errorLooksTransient(lastError)) continue;
        return { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError };
      }
    }
    return { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError };
  };

  let index = 0;
  while (index < plan.items.length && !halted) {
    const wave = plan.items.slice(index, index + concurrency);
    index += wave.length;
    const results = await Promise.all(wave.map((item) => runItem(item)));
    for (const outcome of results) {
      outcomes.push(outcome);
      // Live progress for the chat activity strip: authoritative counts so the
      // UI renders a real meter, not a guess. Every item for normal batches;
      // throttled to every 5th (plus failures + the final item) on huge ones.
      const done = outcomes.length;
      const failedSoFar = outcomes.filter((o) => !o.ok).length;
      if (plan.items.length <= 60 || !outcome.ok || done % 5 === 0 || done === plan.items.length) {
        try {
          appendEvent({
            sessionId, turn: 0, role: 'system', type: 'batch_progress',
            data: { batchId, done, total: plan.items.length, failed: failedSoFar, itemId: outcome.id, ok: outcome.ok },
          });
        } catch { /* telemetry never blocks */ }
      }
      if (outcome.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'batch_item_failed', data: { batchId, itemId: outcome.id, error: outcome.error, consecutiveFailures } });
        } catch { /* best-effort */ }
        if (consecutiveFailures >= haltAfter) {
          halted = true;
          haltReason = `${consecutiveFailures} consecutive failures (last: ${outcome.error ?? 'unknown'}) — halting so a systemic problem is not replayed across the remaining ${plan.items.length - outcomes.length} item(s)`;
          break;
        }
      }
    }
  }

  const ledger: BatchRunLedger = {
    batchId,
    sessionId,
    tool: plan.tool,
    composioSlug: plan.composioSlug,
    sideEffect: plan.sideEffect,
    objective: plan.objective,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: plan.items.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    halted,
    haltReason,
    outcomes,
  };
  try {
    mkdirSync(BATCH_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(BATCH_RUNS_DIR, `${batchId}.json`), JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'batch ledger write failed (run outcomes still returned inline)');
  }
  try {
    appendEvent({ sessionId, turn: 0, role: 'system', type: 'batch_completed', data: { batchId, total: ledger.total, succeeded: ledger.succeeded, failed: ledger.failed, halted, notExecuted: ledger.total - outcomes.length } });
  } catch { /* best-effort */ }
  logger.info({ batchId, tool: plan.tool, slug: plan.composioSlug, total: ledger.total, succeeded: ledger.succeeded, failed: ledger.failed, halted }, 'batch run finished');
  return ledger;
}

export function readBatchLedger(batchId: string): BatchRunLedger | null {
  try {
    const file = path.join(BATCH_RUNS_DIR, `${path.basename(batchId)}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8')) as BatchRunLedger;
  } catch {
    return null;
  }
}

/** Compact model-facing summary: honest counts + every failed item id. */
export function formatBatchLedger(ledger: BatchRunLedger): string {
  const lines = [
    `Batch ${ledger.batchId}: ${ledger.succeeded}/${ledger.total} succeeded, ${ledger.failed} failed`
    + (ledger.halted ? `, HALTED (${ledger.total - ledger.outcomes.length} never attempted)` : '')
    + ` · ${ledger.sideEffect} · ${ledger.tool}${ledger.composioSlug ? `/${ledger.composioSlug}` : ''}`,
  ];
  if (ledger.haltReason) lines.push(`Halt reason: ${ledger.haltReason}`);
  const failures = ledger.outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    lines.push('FAILED items (report these to the user honestly; repair or retry ONLY these):');
    for (const f of failures.slice(0, 20)) lines.push(`- ${f.id}: ${f.error ?? 'unknown error'}`);
    if (failures.length > 20) lines.push(`- … ${failures.length - 20} more (ledger ${ledger.batchId})`);
  }
  if (ledger.halted) {
    const notRun = ledger.total - ledger.outcomes.length;
    if (notRun > 0) lines.push(`${notRun} item(s) were never attempted after the halt — decide with the user before re-running them.`);
  }
  return lines.join('\n');
}
