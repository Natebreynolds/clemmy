import { z } from 'zod';
import { parseTaskMode } from '../../src/runtime/harness/task-mode.js';

export const LiveTurnExpectationSchema = z.object({
  maxArgumentRepairs: z.number().int().min(0).optional(),
  /** Fixture-only intermediate outcomes. Completion remains the default. */
  terminalStatuses: z.array(z.enum(['done', 'needs_input'])).nonempty().optional(),
  replyIncludes: z.array(z.string().min(1)).optional(),
  replyExcludes: z.array(z.string().min(1)).optional(),
  /** Fixture-only response contract, never a runtime/model output limit. */
  maxReplyChars: z.number().int().positive().optional(),
  maxModelRequests: z.number().int().nonnegative().optional(),
  maxToolSearches: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
  minToolCalls: z.number().int().positive().optional(),
  maxWallMs: z.number().positive().optional(),
  successfulMutations: z.number().int().nonnegative().optional(),
  activatedPlans: z.number().int().nonnegative().optional(),
  providerAcknowledgements: z.number().int().nonnegative().optional(),
  forbiddenTools: z.array(z.string().min(1)).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one task assertion is required');

export const LiveProofMessageSchema = z.union([
  z.string().trim().min(1).transform((message) => ({ message, expect: undefined, taskMode: undefined })),
  z.object({ message: z.string().trim().min(1), expect: LiveTurnExpectationSchema,
    taskMode: z.unknown().optional().transform((value, context) => {
      try { return parseTaskMode(value); } catch {
        context.addIssue({ code: 'custom', message: 'Invalid explicit task mode or reviewed revision.' });
        return z.NEVER;
      }
    }),
  }).strict(),
]);

export interface LiveTurnFacts {
  reply: string;
  terminalStatus: string | null;
  modelRequests: number;
  toolSearches: number;
  toolCalls: number;
  wallMs: number | null;
  perTool: Record<string, number>;
  activatedPlans?: number;
  providerAcknowledgements?: number;
  settlements: Array<{
    logical_tool_call_id?: string; mutating: number; outcome_kind: string; requires_reconciliation: number;
    execution_kind?: string; outcome_detail?: string | null;
    physical_crossing_count: number; host_crossing_count: number;
  }>;
}

/** A final "done" answer is not proof of a completed task. Check payload and
 * journal evidence independently; provider readback remains a separate leg. */
export function checkLiveTurn(expect: z.infer<typeof LiveTurnExpectationSchema>, facts: LiveTurnFacts): string[] {
  const failures: string[] = [];
  const terminalStatuses = expect.terminalStatuses ?? ['done'];
  if (!terminalStatuses.some((status) => status === facts.terminalStatus)) {
    failures.push(`terminal: expected ${terminalStatuses.join(' or ')}, got ${facts.terminalStatus}`);
  }
  for (const value of expect.replyIncludes ?? []) {
    if (!facts.reply.includes(value)) failures.push(`reply missing exact text: ${JSON.stringify(value)}`);
  }
  for (const value of expect.replyExcludes ?? []) {
    if (facts.reply.includes(value)) failures.push(`reply contains forbidden text: ${JSON.stringify(value)}`);
  }
  if (expect.maxReplyChars !== undefined && facts.reply.trim().length > expect.maxReplyChars) {
    failures.push(`reply length: ${facts.reply.trim().length} exceeds requested ${expect.maxReplyChars}`);
  }
  for (const [label, actual, maximum] of [
    ['model requests', facts.modelRequests, expect.maxModelRequests],
    ['tool searches', facts.toolSearches, expect.maxToolSearches],
    ['tool calls', facts.toolCalls, expect.maxToolCalls],
    ['wall time', facts.wallMs, expect.maxWallMs],
  ] as const) {
    if (maximum !== undefined && (actual === null || actual > maximum)) failures.push(`${label}: ${actual} exceeds ${maximum}`);
  }
  if (expect.minToolCalls !== undefined && facts.toolCalls < expect.minToolCalls) failures.push(`tool calls: ${facts.toolCalls} below ${expect.minToolCalls}`);
  // Count durable path evidence, not plan_task attempts or completion prose.
  // The separate receipt audit still authenticates individual proof bytes.
  for (const [label, actual, expected] of [
    ['activated plans', facts.activatedPlans, expect.activatedPlans],
    ['provider acknowledgements', facts.providerAcknowledgements, expect.providerAcknowledgements],
  ] as const) {
    if (expected !== undefined && actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual ?? 'unavailable'}`);
  }
  // A sibling the host deliberately stopped at an activation boundary carries
  // mutating INTENT but proves zero crossings and the host's typed reason; it
  // is a checkpoint, not a failed or uncertain effect. Every other mutating
  // settlement must be a clean success. (The boundary rows are still audited
  // below: zero crossings, the exact typed reason.)
  const boundaryStopped = facts.settlements.filter((row) => row.mutating === 1
    && row.execution_kind === 'refused_pre_dispatch'
    && /activation_budget_stopped_before_dispatch/.test(row.outcome_detail ?? ''));
  // A model slip the host refused before dispatch (zero crossings, typed
  // invalid_arguments, or a policy_denial such as a write attempted through
  // the wrong door and then replanned — GLM 5.3 live 2026-09-09, 1 of 51) is
  // a correctable repair, not an effect. It is counted and bounded separately
  // (maxArgumentRepairs, default 0), never silently ignored, so a
  // clean-attempt fixture stays strict.
  const argumentRepairs = facts.settlements.filter((row) => row.mutating === 1
    && row.execution_kind === 'refused_pre_dispatch'
    && (row.outcome_kind === 'invalid_arguments' || row.outcome_kind === 'policy_denial')
    && row.physical_crossing_count + row.host_crossing_count === 0 && row.requires_reconciliation === 0);
  if (argumentRepairs.length > (expect.maxArgumentRepairs ?? 0)) {
    failures.push(`argument repairs: ${argumentRepairs.length} exceeds ${expect.maxArgumentRepairs ?? 0}`);
  }
  const mutations = facts.settlements.filter((row) => row.mutating === 1 && !boundaryStopped.includes(row)
    && !(argumentRepairs.includes(row) && argumentRepairs.length <= (expect.maxArgumentRepairs ?? 0)));
  if (expect.successfulMutations !== undefined) {
    const successful = mutations.filter((row) => row.outcome_kind === 'succeeded'
      && row.requires_reconciliation === 0 && row.physical_crossing_count + row.host_crossing_count > 0);
    if (successful.length !== expect.successfulMutations || mutations.length !== successful.length) {
      failures.push(`mutations: expected exactly ${expect.successfulMutations} successful settled effects; got ${successful.length} successful / ${mutations.length} total`);
    }
    for (const row of boundaryStopped) {
      if (row.physical_crossing_count + row.host_crossing_count !== 0 || row.requires_reconciliation !== 0) {
        failures.push(`an activation-boundary stop crossed its execution boundary (${row.logical_tool_call_id})`);
      }
    }
    if (mutations.some((row) => row.physical_crossing_count > 1 || row.host_crossing_count > 1)) {
      failures.push('a mutating logical call crossed its execution boundary more than once');
    }
  }
  for (const tool of expect.forbiddenTools ?? []) {
    if ((facts.perTool[tool] ?? 0) > 0) failures.push(`forbidden tool used: ${tool}`);
  }
  return failures;
}
