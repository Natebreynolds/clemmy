import { z } from 'zod';
import { renderToolChoicesForContext } from '../memory/tool-choice-store.js';

export const WorkerToolInputSchema = z.object({
  objective: z
    .string()
    .min(8)
    .describe('The parent-planned objective for this fan-out batch, scoped to the one item this worker handles.'),
  item: z
    .string()
    .min(1)
    .describe('The single item to process: id, name, domain, row, record, URL, or other concrete identifier.'),
  resolvedTools: z
    .string()
    .min(1)
    .describe('Exact tool slugs, CLI commands, schemas, or "none needed". The parent must resolve shared tools before fan-out.'),
  context: z
    .string()
    .min(1)
    .describe('All source facts this isolated worker needs: URLs, rows, memory facts, skill excerpts, prior outputs, and constraints.'),
  instructions: z
    .string()
    .min(1)
    .describe('Rules to follow, approval scope, safety boundaries, style rules, and what not to do.'),
  expectedOutput: z
    .string()
    .min(1)
    .describe('The compact output shape the parent will aggregate. Include required fields and failure format.'),
  intent: z
    .string()
    .min(1)
    .nullable()
    .describe('Model-routing intent/category for this item, using the user\'s own word such as "design", "writing", or "research". Pass null for ordinary workers.'),
});

export type WorkerToolInput = z.infer<typeof WorkerToolInputSchema>;

/**
 * The run_worker CALL schema: one packet that covers either ONE item (`item`)
 * or a deterministic parallel batch (`items`). The batch form exists because
 * "call this tool N times in parallel" is a prompt-level contract some brains
 * never honor — they serialize the calls and a 5-item fan-out takes 5× wall
 * time (live 2026-07-21). With `items`, the harness runs the pool itself:
 * wall time ≈ the slowest item, regardless of which brain is driving.
 */
export const WorkerToolCallSchema = WorkerToolInputSchema.extend({
  item: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('The single item to process: id, name, domain, row, record, URL, or other concrete identifier. Omit when passing `items`.'),
  items: z
    .array(z.string().min(1))
    .max(64)
    .nullable()
    .optional()
    .describe('PREFERRED for 2+ independent same-shape items: the full list of item identifiers. The harness runs them as one bounded parallel pool (wall time ≈ slowest item) with a per-item honest ledger — no need to call run_worker once per item.'),
});

export type WorkerToolCall = z.infer<typeof WorkerToolCallSchema>;

/** A model can serialize an absent item as the LITERAL string "null" (the
 *  connected_account_id:"null" Apify class) — or pass an UNRESOLVED TEMPLATE
 *  placeholder ("{{single site host}}", "<site>", "${HOST}") straight from its
 *  own prompt scaffolding (live 2026-07-22: a kimi fan-out ran a worker for
 *  the literal item "{{single site host}}"). Both waste a slot, pollute the
 *  coverage ledger, and produce nonsense results. Shapes, not word lists:
 *  absent-value literals + anything that is ENTIRELY a template placeholder. */
const JUNK_ITEM_RE = /^(null|undefined|none|n\/a|nil|tbd|todo|placeholder)$/i;
const TEMPLATE_PLACEHOLDER_RE = /^(\{\{.*\}\}|<[^<>]+>|\$\{.*\}|%[A-Z_]+%)$/;

function isJunkWorkerItem(item: string): boolean {
  return JUNK_ITEM_RE.test(item) || TEMPLATE_PLACEHOLDER_RE.test(item);
}

/** Normalize a run_worker call into its per-item list. Returns null when the
 *  call names no work at all. */
export function workerCallItems(call: Pick<WorkerToolCall, 'item' | 'items'>): string[] | null {
  const items = (call.items ?? []).map((i) => i.trim()).filter((i) => i && !isJunkWorkerItem(i));
  if (items.length > 0) {
    // `item` alongside `items` is treated as part of the batch when novel —
    // dropping it silently would lose work the model asked for.
    const single = call.item?.trim();
    if (single && !isJunkWorkerItem(single) && !items.includes(single)) items.unshift(single);
    return [...new Set(items)];
  }
  const single = call.item?.trim();
  return single && !isJunkWorkerItem(single) ? [single] : null;
}

/**
 * Normalized failure signature for uniform-failure detection: strip ids,
 * numbers, and item names so "worker for X failed: 400 Unknown Model" and
 * "worker for Y failed: 400 Unknown Model" collapse to one signature. Pure.
 */
export function workerFailureSignature(text: string | null | undefined): string {
  const firstLine = (text ?? '').trim().split('\n')[0] ?? '';
  return firstLine
    .toLowerCase()
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b[a-f0-9-]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);
}

/**
 * When EVERY item of a multi-item fan-out fails with the SAME signature, the
 * failure is infrastructural (dead worker model, missing credentials, provider
 * outage) — retrying more workers is pure waste (live 2026-07-22: two full
 * rounds, 12 dead workers, ~8 wasted minutes before the model pivoted inline).
 * Returns the shared signature, or null when failures are absent or diverse.
 */
export function uniformFailureSignature(texts: Array<string | null | undefined>): string | null {
  if (texts.length < 2) return null;
  const signatures = texts.map(workerFailureSignature);
  const first = signatures[0];
  if (!first) return null;
  return signatures.every((s) => s === first) ? first : null;
}

/**
 * True when a worker's returned text indicates the item FAILED. The historical
 * gate was only the "ERROR:" prefix, but a tool error thrown inside the
 * @openai/agents runner surfaces as "An error occurred while running the
 * tool…" with no prefix — live 2026-07-22, five workers died on a provider
 * 400 and were all counted ok (a no-hollow-done violation). Hollow/empty
 * output is failure for the same reason.
 */
export function workerResultIndicatesFailure(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (/^\s*ERROR:/i.test(t)) return true;
  return /an error occurred while running the tool/i.test(t);
}

/**
 * Stable, deterministic key identifying THIS worker's exact job packet — used by
 * the durable-resume idempotency guard (worker-respawn-guard.ts) so a worker that
 * already completed successfully in an interrupted run is NOT re-executed (and its
 * external writes not re-issued) when the run resumes and replays the same call.
 * Hashes the MATERIAL packet fields (no timestamp/nonce), so an identical replay
 * maps to the same key while a genuinely DIFFERENT re-processing of the same item
 * (new instructions/tools/context/expectedOutput) gets a distinct key and runs
 * normally. djb2 → base36; pure + total (never throws).
 */
export function workerPacketKey(input: WorkerToolInput): string {
  // LENGTH-PREFIX each field before hashing so the serialization is INJECTIVE — a
  // plain separator join is not: objective='Summarize the' item='company Acme'
  // and objective='Summarize the company' item='Acme' would collide and cause a
  // false-skip (adversarial review F2). Two independent rolling hashes (djb2 +
  // FNV-1a) concatenated give a ~64-bit digest — a 32-bit key is too thin an
  // identity for an idempotency-of-external-writes decision across 100s of items.
  const fields = [
    input.objective,
    input.item,
    input.resolvedTools,
    input.context,
    input.instructions,
    input.expectedOutput,
    input.intent ?? '',
  ];
  let serialized = '';
  for (const f of fields) serialized += `${f.length} ${f} `;
  let h1 = 5381; // djb2
  let h2 = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < serialized.length; i += 1) {
    const c = serialized.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0; // h1*33 + c
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0; // FNV-1a prime
  }
  return (h1 >>> 0).toString(36) + '-' + h2.toString(36);
}

const HEAVY_WORKER_INTENTS = ['research', 'analysis', 'analyze', 'code', 'coding', 'design'];

/**
 * Intent-aware worker turn ceiling. Heavy, multi-step intents (e.g. a DataForSEO
 * discover -> per-keyword pull -> synthesize research item) need headroom to
 * FINISH on the first attempt instead of capping and triggering a respawn loop
 * (observed live 2026-06-22: an N=3 per-client research fan-out where every
 * worker hit the 8/12-turn cap and the orchestrator re-spawned them forever).
 * `intent` is free-form (z.string().min(1).nullable()), so match by
 * case-insensitive substring, never an enum switch. Pure + total: an unknown or
 * null intent keeps `base`; widening only ever RAISES, never lowers, so the env
 * knob (CLEMMY_WORKER_MAX_TURNS / CLEMMY_CLAUDE_AGENT_SDK_WORKER_MAX_TURNS) still
 * floors the value. The loop-guard + duplicate gates bound runaways inside the
 * larger budget; this is the outer ceiling, not the precise thrash control.
 */
export function resolveWorkerMaxTurns(intent: string | null | undefined, base: number): number {
  const word = (intent ?? '').trim().toLowerCase();
  if (!word) return base;
  const heavy = HEAVY_WORKER_INTENTS.some((k) => word.includes(k));
  return heavy ? Math.max(base, 18) : base;
}

type WorkerToolInputBuilderOptions = {
  params: WorkerToolInput;
};

function resolveWorkerToolInput(inputOrOptions: WorkerToolInput | WorkerToolInputBuilderOptions): WorkerToolInput {
  if ('params' in inputOrOptions) return inputOrOptions.params;
  return inputOrOptions;
}

export function buildWorkerJobPrompt(inputOrOptions: WorkerToolInput | WorkerToolInputBuilderOptions): string {
  const input = resolveWorkerToolInput(inputOrOptions);
  // Recall, for workers: a worker runs the same nested-agent loop but never saw
  // the parent's "Remembered Tool Choices" block, so it re-discovered tools the
  // user has already proven. Inject the learned choices RELEVANT to this
  // worker's objective so a worker that must do its own smallest-discovery
  // reaches for a proven tool instead of searching from scratch. Best-effort +
  // bounded + scoped; rides the existing context-inject flag (renders '' when
  // empty/disabled). resolvedTools stays authoritative — this only supplements.
  let remembered = '';
  try {
    remembered = renderToolChoicesForContext(8, undefined, input.objective);
  } catch {
    remembered = '';
  }
  return [
    '[WORKER JOB PACKET]',
    'You are executing ONE item from a parent-planned fan-out. Treat this packet as authoritative.',
    '',
    'Execution rules:',
    '- If this packet names a target list / recipient set / sheet / doc / resource (in item, context, or instructions), that is the parent-pinned binding target. Act on EXACTLY those values — do NOT re-discover, search for, or substitute a different list (e.g. do not run a "find/search/list" tool to locate a list the parent already named).',
    '- Use the exact resolvedTools when they are listed. Do not call composio_search_tools, composio_list_tools, local_cli_list, or broad discovery for a capability already resolved by the parent.',
    '- If resolvedTools says "none needed" or omits a capability that is truly required, do the smallest possible discovery for that missing capability only.',
    '- If a listed tool call fails or returns missing data, fix and retry that call once. After one genuine retry fails, return ERROR with the specific reason.',
    '- Do not ask the user, notify the user, mutate shared task/execution state, or perform work outside this single item.',
    '- Return only the requested expectedOutput. If the item failed, the final line must start with ERROR:',
    ...(remembered
      ? [
          '',
          'Proven tool choices for this objective (only if resolvedTools does not already cover a needed capability — prefer these over fresh discovery):',
          remembered,
        ]
      : []),
    '',
    'Packet JSON:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}
