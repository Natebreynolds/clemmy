import { z } from 'zod';

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
});

export type WorkerToolInput = z.infer<typeof WorkerToolInputSchema>;

type WorkerToolInputBuilderOptions = {
  params: WorkerToolInput;
};

function resolveWorkerToolInput(inputOrOptions: WorkerToolInput | WorkerToolInputBuilderOptions): WorkerToolInput {
  if ('params' in inputOrOptions) return inputOrOptions.params;
  return inputOrOptions;
}

export function buildWorkerJobPrompt(inputOrOptions: WorkerToolInput | WorkerToolInputBuilderOptions): string {
  const input = resolveWorkerToolInput(inputOrOptions);
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
    '',
    'Packet JSON:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}
