import { z } from 'zod';
import { renderToolChoicesForContext } from '../memory/tool-choice-store.js';
import { canonicalMcpToolIdentity } from '../runtime/mcp-tool-authority.js';

const ExternalMcpToolNamesSchema = z
  .array(z.string().regex(
    /^(?:mcp__)?[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/,
    'must be one exact server__tool or mcp__server__tool identity',
  ))
  .max(32);

// Field descriptions are advertised on every model step of every turn that
// can fan out; they name the contract of each field and nothing more. The
// zod constraints (not the prose) are what admit or refuse a packet.
export const WorkerManifestDescriptorSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Stable id of this logical work set across waves.'),
  contractVersion: z
    .string()
    .min(1),
  phase: z
    .string()
    .min(1)
    .describe('Current phase id.'),
  mode: z
    .enum(['declare', 'reconcile', 'extend'])
    .nullable()
    .optional()
    .describe('declare on the first wave; reconcile later; extend only when scope grows.'),
  phases: z
    .array(z.object({
      id: z.string().min(1),
      label: z.string().min(1).nullable().optional(),
      dependsOn: z.array(z.string().min(1)).nullable().optional(),
    }))
    .max(32)
    .nullable()
    .optional()
    .describe('Ordered per-item phase graph (no parent-only merge/synthesis); declaration wave only.'),
  aliases: z
    .array(z.object({
      alias: z
        .string()
        .min(1),
      itemId: z
        .string()
        .min(1),
    }))
    .max(256)
    .nullable()
    .optional()
    .describe('Changed label -> canonical item id; null when labels match.'),
});

export const WorkerToolInputSchema = z.object({
  objective: z
    .string()
    .min(8)
    .describe('Objective for this fan-out, scoped to one item.'),
  item: z
    .string()
    .min(1)
    .describe('The single item to process: id, name, domain, row, record, URL, or other concrete identifier.'),
  resolvedTools: z
    .string()
    .min(1)
    .describe('Exact tool slugs/CLI commands/schemas the worker uses, or "none needed".'),
  externalMcpToolNames: ExternalMcpToolNamesSchema
    .nullable()
    .optional()
    .describe('Typed exact external MCP lease (`server__tool`); null when none. Prose in resolvedTools never widens it.'),
  context: z
    .string()
    .min(1)
    .describe('Every source fact the isolated worker needs.'),
  instructions: z
    .string()
    .min(1)
    .describe('Rules, approval scope, safety boundaries, style.'),
  expectedOutput: z
    .string()
    .min(1)
    .describe('Compact output shape to aggregate, incl. failure format.'),
  intent: z
    .string()
    .min(1)
    .nullable()
    .describe('Worker category in the user\'s word ("design", "research"); null for ordinary workers.'),
  model: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('Exact model id; null uses routing (an unroutable id falls back, never refuses).'),
  workManifest: WorkerManifestDescriptorSchema
    .nullable()
    .optional()
    .describe('Durable multi-wave binding of canonical items to per-item phases; null otherwise.'),
  expectedWork: z
    .object({
      requirementId: z
        .string()
        .min(1)
        .describe('Requirement id from your work_call plan.'),
      universeId: z
        .string()
        .min(1)
        .nullable()
        .optional(),
    })
    .nullable()
    .optional()
    .describe('Frozen-contract requirement each item discharges; the harness fills it when unambiguous.'),
});

export type WorkerToolInput = z.infer<typeof WorkerToolInputSchema>;

/**
 * The run_worker CALL schema: one packet that covers either ONE item (`item`)
 * or a deterministic parallel batch (`items`). The batch form exists because
 * "call this tool N times in parallel" is a prompt-level contract some brains
 * never honor — they serialize the calls and a 5-item fan-out takes 5× wall
 * time (live 2026-07-21). With `items`, the harness runs the pool itself:
 * wall time follows the slowest concurrency waves, regardless of which brain
 * is driving.
 */
export const WorkerToolCallSchema = WorkerToolInputSchema.extend({
  // New live calls must state external authority explicitly. The base packet
  // remains optional for durable pre-upgrade packets recovered from disk.
  externalMcpToolNames: ExternalMcpToolNamesSchema
    .nullable()
    .describe('Required typed exact external MCP lease (`server__tool`); [] or null for none.'),
  item: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe('One concrete item identifier; omit when passing `items`.'),
  items: z
    .array(z.string().min(1))
    .max(256)
    .nullable()
    .optional()
    .describe('PREFERRED for 2+ items: the full list (up to 256), run as one pool.'),
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
 * Why `workerCallItems` found no work, in the terms the model must repair:
 * every entry it dropped, grouped by the shape that disqualified it, and
 * which of `item` / `items` was absent altogether. The packet may have PASSED
 * its schema (`items: []`, `items: ["null"]`, `items: ["   "]` are all valid
 * `string[]`), so a schema digest cannot name this — only the body can, and
 * a refusal that does not say which entries were dropped and why leaves the
 * model to guess (live: the same empty batch re-sent as 'succeeded'). Pure.
 */
export function describeMissingWorkerItems(call: Pick<WorkerToolCall, 'item' | 'items'>): {
  reason: string;
  /** Value-free shape tags of what went wrong, for a stable repair key. */
  shapes: string[];
} {
  const blank: string[] = [];
  const absentLiterals: string[] = [];
  const placeholders: string[] = [];
  const classify = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) blank.push(raw);
    else if (JUNK_ITEM_RE.test(trimmed)) absentLiterals.push(trimmed);
    else if (TEMPLATE_PLACEHOLDER_RE.test(trimmed)) placeholders.push(trimmed);
  };
  for (const entry of call.items ?? []) classify(entry);
  const hasItemsField = Array.isArray(call.items);
  const hasItemField = typeof call.item === 'string';
  if (hasItemField) classify(call.item as string);
  const quote = (values: string[]): string => values.slice(0, 5).map((value) => JSON.stringify(value)).join(', ');
  const dropped = [
    absentLiterals.length ? `${absentLiterals.length} absent-value literal${absentLiterals.length === 1 ? '' : 's'} (${quote(absentLiterals)})` : '',
    placeholders.length ? `${placeholders.length} unresolved template placeholder${placeholders.length === 1 ? '' : 's'} (${quote(placeholders)})` : '',
    blank.length ? `${blank.length} blank entr${blank.length === 1 ? 'y' : 'ies'}` : '',
  ].filter(Boolean);
  const shapes = [
    ...(hasItemField ? [] : ['item:absent']),
    ...(hasItemsField ? (call.items!.length === 0 ? ['items:empty'] : []) : ['items:absent']),
    ...(absentLiterals.length ? ['items:absent_value_literal'] : []),
    ...(placeholders.length ? ['items:template_placeholder'] : []),
    ...(blank.length ? ['items:blank'] : []),
  ];
  const itemsPart = hasItemsField
    ? call.items!.length === 0
      ? '`items` was an empty list'
      : `every one of the ${call.items!.length} \`items\` entr${call.items!.length === 1 ? 'y' : 'ies'} was dropped`
    : '`items` was absent';
  // Only reached when `item` named no work either: absent, blank, or junk.
  const itemPart = !hasItemField
    ? '`item` was absent'
    : (call.item as string).trim()
      ? '`item` was dropped'
      : '`item` was blank';
  const reason = `run_worker named no dispatchable work: ${itemsPart} and ${itemPart}`
    + (dropped.length ? ` — ${dropped.join('; ')}` : '')
    + '. Retry once with `item` (one concrete identifier) or `items` (the full list of concrete identifiers: ids, names, domains, rows, records or URLs). '
    + 'Placeholders, absent-value words and blanks are never work.';
  return { reason, shapes };
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
  const typedExternalNames = input.externalMcpToolNames ?? [];
  const externalMcpLeaseKey = typedExternalNames.length === 0
    ? 'external-mcp:typed-none'
    : `external-mcp:typed:${JSON.stringify([...new Set(typedExternalNames
        .map((name) => canonicalMcpToolIdentity(name) ?? `invalid:${name.trim().toLowerCase()}`))]
        .sort())}`;
  const fields = [
    input.objective,
    input.item,
    input.resolvedTools,
    // Migration invariant: packets persisted before typed leases existed have
    // `externalMcpToolNames === undefined`. Their packet key is durable
    // idempotency authority, so preserve the historical byte serialization
    // exactly (no placeholder field). New typed calls add an explicit
    // discriminator; null/[] are intentionally equivalent local-only leases.
    ...(input.externalMcpToolNames === undefined ? [] : [externalMcpLeaseKey]),
    input.context,
    input.instructions,
    input.expectedOutput,
    input.intent ?? '',
    input.workManifest ? JSON.stringify(input.workManifest) : '',
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
  // Provider prompt caches are prefix-based. Keep every batch-shared field in
  // its existing order and append the one per-item value last, independent of
  // the model/tool decoder's object-property order. Replacing an early `item`
  // property with object spread preserves its early slot in JavaScript and
  // made a 100-worker batch diverge before 30% of each wire was cacheable.
  const { item, ...sharedPacket } = input;
  const cacheCanonicalPacket = { ...sharedPacket, item };
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
    '- externalMcpToolNames is the exact external MCP capability lease. Use only those names; []/null means no external MCP. Tool names mentioned only in prose, examples, or prohibitions are not authority.',
    '- If this packet names a target list / recipient set / sheet / doc / resource (in item, context, or instructions), that is the parent-pinned binding target. Act on EXACTLY those values — do NOT re-discover, search for, or substitute a different list (e.g. do not run a "find/search/list" tool to locate a list the parent already named).',
    '- Use the exact resolvedTools when they are listed. Do not call composio_search_tools, composio_list_tools, local_cli_list, or broad discovery for a capability already resolved by the parent.',
    '- If resolvedTools says "none needed" or omits a capability that is truly required, do the smallest possible discovery for that missing capability only.',
    '- If a listed tool call fails or returns missing data, fix and retry that call once. After one genuine retry fails, return ERROR with the specific reason.',
    '- Do not ask the user, notify the user, mutate shared task/execution state, or perform work outside this single item.',
    '- Preserve evidence strength in your answer: distinguish directly observed facts, claims made by a source, your inferences, and unknowns. Include the supporting source or tool result and its limitations. Search-result order or a summary is not a measured ranking, market share, or performance result.',
    '- Return only the requested expectedOutput. If the item failed, the final line must start with ERROR:',
    ...(input.expectedWork
      ? [
          // Live 2026-08-11: a contracted worker saw no first-class write tool,
          // concluded the capability was unavailable, and quit with ZERO tool
          // calls. Under a contract, business capabilities exist ONLY behind
          // work_call — say so, and hand the worker its exact binding.
          `- CONTRACTED ITEM: your business call is made through work_call with requirement_id "${input.expectedWork.requirementId}" and universe_item_id set to this packet's canonical item id (the contract is already frozen). Use only fields in the callable schema. File writes, provider actions, and every other business capability in this worker are reachable ONLY through that bound work_call — they are deliberately not first-class tools here. Never conclude a capability is unavailable without attempting the bound call; a refusal returns the frozen plan to correct against.`,
        ]
      : []),
    ...(remembered
      ? [
          '',
          'Proven tool choices for this objective (only if resolvedTools does not already cover a needed capability — prefer these over fresh discovery):',
          remembered,
        ]
      : []),
    '',
    'Packet JSON:',
    JSON.stringify(cacheCanonicalPacket, null, 2),
  ].join('\n');
}
