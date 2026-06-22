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
