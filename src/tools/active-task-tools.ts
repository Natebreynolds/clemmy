import { z } from 'zod';
import { tool, type Tool } from '@openai/agents';
import type { RuntimeContextValue } from '../types.js';
import { sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import {
  writeActiveTaskSection,
  parseActiveTaskSection,
  dropActiveTaskSection,
  type ActiveTaskSpec,
} from '../memory/working-memory.js';

export interface ActiveTaskToolInput {
  action: 'set' | 'update' | 'clear';
  list_reference?: string | null;
  recipients?: string[] | null;
  count?: number | null;
  exclusivity?: string | null;
  note?: string | null;
}

/**
 * Core logic of the `active_task` tool, extracted so it is unit-testable
 * without constructing an SDK RunContext. Set/update/clear the per-session
 * Active Task scratchpad and return a short confirmation. `update` merges with
 * whatever is already pinned (parsed back from the section). Best-effort writes
 * via the working-memory store — never throws into a tool call.
 */
export function applyActiveTaskAction(sessionId: string, input: ActiveTaskToolInput): string {
  const { action, list_reference, recipients, count, exclusivity, note } = input;

  if (action === 'clear') {
    dropActiveTaskSection(sessionId);
    return 'Active task cleared.';
  }

  const existing = action === 'update' ? parseActiveTaskSection(sessionId) : undefined;
  const spec: ActiveTaskSpec = {
    capturedAt: new Date().toISOString(),
    verb: existing?.verb,
    count: count ?? existing?.count ?? undefined,
    recipients: recipients ?? existing?.recipients ?? [],
    resourceRef: list_reference ?? existing?.resourceRef ?? undefined,
    exclusivity: exclusivity ?? existing?.exclusivity ?? undefined,
    constraintText: (note?.trim() || existing?.constraintText || 'pinned via active_task').slice(0, 1500),
  };

  // Require a concrete target so the tool can't pin an empty/ambiguous task.
  if (!spec.resourceRef && spec.recipients.length === 0 && spec.count === undefined) {
    return 'Nothing concrete to pin — provide a list_reference, recipients, or a count.';
  }

  writeActiveTaskSection(sessionId, spec);
  const target = spec.resourceRef
    ? `reference ${spec.resourceRef}`
    : spec.recipients.length
      ? `${spec.recipients.length} recipient(s)`
      : `count ${spec.count}`;
  return `Active task ${action === 'update' ? 'updated' : 'pinned'}: ${target}. I'll use this exact target when I act — no re-discovery.`;
}

/**
 * The `active_task` tool — the model-driven layer over the deterministic
 * Active Task scratchpad. The harness ALWAYS pins a stated constraint
 * deterministically at turn start (detectActiveTask), so this tool is the
 * additive hybrid: it lets the model capture or correct task parameters the
 * regex detector missed (novel phrasings, a target named across several turns,
 * a mid-conversation change), and clear the pin when the task is done. It
 * writes to the SAME per-session store, so the pin is injected verbatim every
 * turn and read at action time — Clem uses the pinned reference instead of
 * re-discovering and pulling the wrong list.
 */
export function getActiveTaskTools(): Tool<RuntimeContextValue>[] {
  const active_task = tool({
    name: 'active_task',
    description: [
      'Pin / update / clear the CURRENT task\'s operational parameters (the working scratchpad).',
      'Use action="set" the moment the user names a concrete target for a pending action — a list/sheet/doc URL or id, an explicit recipient set, a count, or an "only these" scope — especially one you must hold across a long conversation about other things (e.g. drafting the email copy).',
      'Use action="update" to add/correct parameters as the task evolves (merges with what is already pinned).',
      'Use action="clear" once the task is done or the user pivots, so a stale target never carries into the next task.',
      'The pinned task is shown to you every turn under "Active Task". When you execute, act on THESE exact values — pull from the pinned reference; do NOT re-discover or search for a list.',
    ].join(' '),
    parameters: z.object({
      action: z.enum(['set', 'update', 'clear']),
      list_reference: z.string().nullable(),
      recipients: z.array(z.string()).nullable(),
      count: z.number().int().nullable(),
      exclusivity: z.string().nullable(),
      note: z.string().nullable(),
    }),
    execute: async (input, context) => {
      const sessionId = sessionIdFromRunContext(context);
      if (!sessionId) return 'No active session — cannot pin the task.';
      return applyActiveTaskAction(sessionId, input);
    },
  });

  return [active_task];
}
