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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { Agent, Runner } from '@openai/agents';
import { BASE_DIR } from '../config.js';
import { dispatchBatchItemTool, READ_ONLY_TOOLS, isMcpNamespacedTool } from '../tools/code-mode-tool.js';
import { ToolCallsCounter } from '../runtime/harness/brackets.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
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
  /** Per-item idempotency key: sha1(operation-scope :: id :: JSON(args)). Persisted
   *  so a later run can skip an already-succeeded identical item. */
  idempotencyKey?: string;
  /** True when this item was SKIPPED because an identical item already succeeded in
   *  a recent batch (counts as succeeded, never dispatched). */
  deduped?: boolean;
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
  // PLAIN-TEXT verdict, parsed deterministically. Structured output was a
  // load-bearing dependency on this safety path and it flaked twice live on
  // 2026-07-07/08 (".max() overflow" then provider-shape validation failures)
  // — each flake failing a WRITE plan closed. A one-line text contract has no
  // schema to fail: first line "ALLOW: <reason>" or "DENY: <reason>"; any
  // response without that marker throws → retry → fail-closed. Deterministic
  // checks stay primary (validateBatchPlan); the judge is a second opinion.
  const runJudgeOnce = async (): Promise<BatchCertification> => {
    const agent = new Agent({
      name: 'Batch Plan Judge',
      model: resolveRoleModel('judge').modelId,
      instructions: [
        'You certify a BATCH PLAN before deterministic execution: one tool, N pre-baked payloads, executed with no further review.',
        'ALLOW only when the sampled payloads actually accomplish the stated objective and nothing in them looks misdirected: wrong recipients/targets for the objective, placeholder or template-variable text left in ({{name}}, TODO, lorem), payloads inconsistent with each other, or a scope wider than the objective states.',
        'You are the ONLY review these payloads get — when unsure on a write/send plan, DENY and say why.',
        'Reply with EXACTLY ONE LINE and nothing else: either "ALLOW: <one-sentence reason>" or "DENY: <one-sentence reason>".',
      ].join(' '),
      tools: [],
    });
    const runner = new Runner({ workflowName: 'clementine-batch-certify' });
    const result = await runner.run(agent, input);
    const raw = String((result as { finalOutput?: unknown }).finalOutput ?? '').trim();
    const match = /^\s*(ALLOW|DENY)\s*:?\s*(.*)$/im.exec(raw);
    if (!match) throw new Error(`judge returned no ALLOW/DENY verdict (got: ${raw.slice(0, 120)})`);
    return {
      allow: match[1].toUpperCase() === 'ALLOW',
      reason: (match[2] || '').slice(0, 400),
      concerns: [],
      judged: true,
    };
  };
  try {
    try {
      return await runJudgeOnce();
    } catch (firstErr) {
      // ONE retry before any fail-closed: a schema/transport blip on a single
      // call must not park an entire approved batch (live 2026-07-07: five
      // consecutive verdict-shape rejections parked 5 emails).
      logger.warn({ err: firstErr instanceof Error ? firstErr.message : String(firstErr) }, 'batch certify judge attempt 1 failed — retrying once');
      return await runJudgeOnce();
    }
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

/** A rate-limit / throttling error is handled DISTINCTLY from other transients: it
 *  pauses the WHOLE batch with back-off rather than burning the item's single retry
 *  or counting toward the consecutive-failure halt. Returns the parsed Retry-After
 *  (ms, capped) when the provider gave one, else undefined. */
function detectRateLimit(message: string): { error: string; retryAfterMs?: number } | null {
  if (!/\b429\b|rate.?limit|too many requests|quota exceeded|throttl/i.test(message)) return null;
  let retryAfterMs: number | undefined;
  // "Retry-After: 12", "retry after 12s", "retry_after":"30" — seconds → ms.
  const m = /retry[-_\s]?after["':\s]+(\d+)/i.exec(message);
  if (m) retryAfterMs = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, Math.max(0, Number.parseInt(m[1], 10) * 1000));
  return { error: message.slice(0, 200), retryAfterMs };
}

const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFFS = 5;

/** Base back-off delay (ms). Env-overridable so tests keep the real timer SHORT
 *  without mocking the clock (CLEMMY_BATCH_BACKOFF_BASE_MS). Default 2s. */
function batchBackoffBaseMs(): number {
  const raw = Number.parseInt(process.env.CLEMMY_BATCH_BACKOFF_BASE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

/** Exponential back-off with jitter, capped; honors a server Retry-After when larger. */
function backoffDelayMs(backoffCount: number, retryAfterMs: number): number {
  const base = batchBackoffBaseMs();
  const exp = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, base * Math.pow(2, Math.max(0, backoffCount - 1)));
  const jitter = Math.random() * Math.min(1000, exp * 0.25);
  const computed = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, exp + jitter);
  return Math.max(computed, Math.min(RATE_LIMIT_BACKOFF_CAP_MS, retryAfterMs || 0));
}

/** Sleep seam — real timer in prod; tests inject a no-wait fn that captures delays. */
let batchSleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
export function _setBatchSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  batchSleep = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

// ─── Per-item idempotency (safe re-run of a partially-failed batch) ───────────

const IDEMPOTENCY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
const IDEMPOTENCY_SCAN_MAX_FILES = 200;

/** Stable operation scope for a plan — tool + slug + side-effect. The item id +
 *  args make the rest of the key, so the SAME item re-run under the same operation
 *  (e.g. retrying a halted batch) resolves to the same key even if the plan's item
 *  set or objective wording changed. */
function planScopeHash(plan: BatchPlan): string {
  return createHash('sha1').update(`${plan.tool}::${plan.composioSlug ?? ''}::${plan.sideEffect}`).digest('hex');
}

function itemIdempotencyKey(scope: string, item: BatchPlanItem): string {
  return createHash('sha1').update(`${scope}::${item.id}::${JSON.stringify(item.args)}`).digest('hex');
}

/** Map of idempotencyKey → sourceBatchId for every SUCCEEDED item across the recent
 *  ledgers (last 200 files by mtime, finished within 48h). Best-effort; never throws.
 *  Deduped items themselves count as succeeded, so they chain (A→B re-run stays safe). */
function loadRecentSucceededKeys(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (!existsSync(BATCH_RUNS_DIR)) return map;
    const now = Date.now();
    const files = readdirSync(BATCH_RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return { f, mtime: statSync(path.join(BATCH_RUNS_DIR, f)).mtimeMs }; } catch { return { f, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, IDEMPOTENCY_SCAN_MAX_FILES);
    for (const { f } of files) {
      try {
        const led = JSON.parse(readFileSync(path.join(BATCH_RUNS_DIR, f), 'utf-8')) as BatchRunLedger;
        const finishedMs = Date.parse(led.finishedAt ?? '');
        if (Number.isFinite(finishedMs) && now - finishedMs > IDEMPOTENCY_WINDOW_MS) continue;
        for (const o of led.outcomes ?? []) {
          if (o.ok && o.idempotencyKey && !map.has(o.idempotencyKey)) map.set(o.idempotencyKey, led.batchId);
        }
      } catch { /* skip a corrupt ledger */ }
    }
  } catch { /* best-effort */ }
  return map;
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

  // Idempotency: a key per item + the set of keys that already SUCCEEDED recently,
  // so re-running a partially-failed batch (the exact post-halt scenario) skips the
  // items that already went through instead of double-executing them.
  const scope = planScopeHash(plan);
  const succeededKeys = loadRecentSucceededKeys();

  // runItem returns EITHER a terminal outcome OR a rate-limit signal (the whole
  // batch backs off and the item is re-run fresh — its single transient retry is
  // NOT consumed and it does NOT count toward the consecutive-failure halt).
  type ItemResult = { outcome: BatchItemOutcome } | { rateLimit: { error: string; retryAfterMs?: number } };

  const runItem = async (item: BatchPlanItem): Promise<ItemResult> => {
    const t0 = Date.now();
    const key = itemIdempotencyKey(scope, item);
    // Dedup BEFORE any dispatch — an identical item already succeeded recently.
    const priorBatch = succeededKeys.get(key);
    if (priorBatch) {
      return { outcome: { id: item.id, ok: true, attempts: 0, ms: 0, deduped: true, idempotencyKey: key, resultPreview: `deduped: already executed in batch ${priorBatch}` } };
    }
    // composio_execute_tool's schema is strict nullable-but-REQUIRED: every key
    // must be present (null allowed, absent NOT). Omitting connected_account_id
    // failed ALL items of the 2026-07-08 sheet batch in milliseconds with
    // InvalidToolInputError — before any network call.
    const args = plan.tool === 'composio_execute_tool'
      ? { tool_slug: plan.composioSlug, arguments: JSON.stringify(item.args), connected_account_id: null }
      : item.args;
    let attempts = 0;
    let lastError = '';
    while (attempts < 2) {
      attempts += 1;
      try {
        const out = await dispatchBatchItemTool(plan.tool, args, sessionId, counter);
        const text = previewOf(out);
        // A "polite failure" comes back as a NORMAL result whose text is an
        // error banner — composio's ⚠️ banners AND the @openai/agents SDK's
        // defaultToolErrorFunction ("An error occurred while running the
        // tool…"), which swallowed InvalidToolInputError for all 5 items of the
        // 2026-07-08 sheet batch while the ledger said 5/5 succeeded. Anchored
        // at the START of the text so results merely MENTIONING errors pass.
        if (/^⚠️|^An error occurred while running the tool|^\s*(Error|InvalidToolInputError)\b|FAILED \(slug=|NOT CONNECTED/i.test(text)) {
          lastError = text.slice(0, 200);
          const rl = detectRateLimit(text);
          if (rl) return { rateLimit: rl };
          if (attempts < 2 && errorLooksTransient(text)) continue;
          return { outcome: { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError, idempotencyKey: key } };
        }
        return { outcome: { id: item.id, ok: true, attempts, ms: Date.now() - t0, resultPreview: text, idempotencyKey: key } };
      } catch (err) {
        lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        const rl = detectRateLimit(lastError);
        if (rl) return { rateLimit: rl };
        if (attempts < 2 && errorLooksTransient(lastError)) continue;
        return { outcome: { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError, idempotencyKey: key } };
      }
    }
    return { outcome: { id: item.id, ok: false, attempts, ms: Date.now() - t0, error: lastError, idempotencyKey: key } };
  };

  const emitProgress = (outcome: BatchItemOutcome): void => {
    const done = outcomes.length;
    const failedSoFar = outcomes.filter((o) => !o.ok).length;
    if (plan.items.length <= 60 || !outcome.ok || done % 5 === 0 || done === plan.items.length) {
      try {
        appendEvent({
          sessionId, turn: 0, role: 'system', type: 'batch_progress',
          data: { batchId, done, total: plan.items.length, failed: failedSoFar, itemId: outcome.id, ok: outcome.ok, ...(outcome.deduped ? { deduped: true } : {}) },
        });
      } catch { /* telemetry never blocks */ }
    }
  };

  // Queue-based loop so rate-limited items can be re-queued at the FRONT after a
  // batch-level back-off pause without losing their place or their retry.
  const queue: BatchPlanItem[] = [...plan.items];
  let backoffCount = 0;
  while (queue.length > 0 && !halted) {
    const wave = queue.splice(0, concurrency);
    const results = await Promise.all(wave.map((item) => runItem(item)));
    const requeue: BatchPlanItem[] = [];
    let maxRetryAfterMs = 0;
    let sawRateLimit = false;
    for (let i = 0; i < wave.length; i += 1) {
      const r = results[i];
      if ('rateLimit' in r) {
        sawRateLimit = true;
        requeue.push(wave[i]);
        if (r.rateLimit.retryAfterMs) maxRetryAfterMs = Math.max(maxRetryAfterMs, r.rateLimit.retryAfterMs);
        continue;
      }
      const outcome = r.outcome;
      outcomes.push(outcome);
      emitProgress(outcome);
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
    if (halted) break;
    if (sawRateLimit) {
      backoffCount += 1;
      if (backoffCount > MAX_RATE_LIMIT_BACKOFFS) {
        halted = true;
        const notRun = queue.length + requeue.length;
        haltReason = `provider rate-limiting persisted through ${MAX_RATE_LIMIT_BACKOFFS} back-off pauses — halting so the throttled provider is not hammered (${notRun} item(s) not executed; re-run is idempotent-safe)`;
        break;
      }
      const delayMs = backoffDelayMs(backoffCount, maxRetryAfterMs);
      // Tell the UI meter we're throttled + backing off (not a per-item update).
      try {
        appendEvent({
          sessionId, turn: 0, role: 'system', type: 'batch_progress',
          data: { batchId, done: outcomes.length, total: plan.items.length, failed: outcomes.filter((o) => !o.ok).length, throttled: true, backoffMs: delayMs, backoffCount, ok: true },
        });
      } catch { /* telemetry never blocks */ }
      await batchSleep(delayMs);
      // Re-queue the throttled items at the FRONT so they run next.
      queue.unshift(...requeue);
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

/** Compact model-facing summary: honest counts + every failed item id.
 *  READ batches also return per-item result previews inline — without them the
 *  model re-fetched every item to get the data it just batched (live Claude-lane
 *  validation 2026-07-08: "run_batch only surfaces success/fail counts"). */
export function formatBatchLedger(ledger: BatchRunLedger): string {
  const lines = [
    `Batch ${ledger.batchId}: ${ledger.succeeded}/${ledger.total} succeeded, ${ledger.failed} failed`
    + (ledger.halted ? `, HALTED (${ledger.total - ledger.outcomes.length} never attempted)` : '')
    + ` · ${ledger.sideEffect} · ${ledger.tool}${ledger.composioSlug ? `/${ledger.composioSlug}` : ''}`,
  ];
  if (ledger.sideEffect === 'read') {
    const ok = ledger.outcomes.filter((o) => o.ok && o.resultPreview);
    if (ok.length > 0) {
      lines.push('Results (preview per item; full payloads via tool_output_query on the item call ids):');
      for (const o of ok.slice(0, 60)) lines.push(`- ${o.id}: ${o.resultPreview}`);
      if (ok.length > 60) lines.push(`- … ${ok.length - 60} more in the ledger (${ledger.batchId})`);
    }
  }
  const deduped = ledger.outcomes.filter((o) => o.deduped);
  if (deduped.length > 0) {
    const sources = [...new Set(deduped.map((o) => (o.resultPreview ?? '').replace(/^deduped: already executed in batch /, '')).filter(Boolean))];
    lines.push(`${deduped.length} deduped (already executed in a prior batch${sources.length ? `: ${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ', …' : ''}` : ''}) — counted as succeeded, not re-dispatched.`);
  }
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
