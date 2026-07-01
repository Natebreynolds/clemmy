import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkerToolInputSchema, type WorkerToolInput } from '../agents/worker-job-packet.js';
import { runClaudeAgentSdkWorker } from '../runtime/harness/claude-agent-worker.js';
import { acquireWorkerSlot } from '../agents/worker-concurrency.js';
import { workerItemAlreadyCapped } from '../agents/worker-respawn-guard.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { getClaudeBrainModel, getRuntimeEnv } from '../config.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

/**
 * `run_worker` for the CLAUDE AGENT SDK BRAIN.
 *
 * The orchestrator (Codex) lane has its own inline `run_worker` (an @openai/agents
 * tool). The Claude SDK brain calls LOCAL tools through this MCP server child and had
 * NO fan-out primitive — so a Claude brain (e.g. Sonnet 5) processed N independent
 * items SEQUENTIALLY and blew its per-query turn budget (2026-07-01 stress: 5-firm SEO
 * stopped at 2/5). This exposes the same fan-out to the SDK brain: spawn a stateless
 * Claude SDK worker on ONE item, reusing the shared substrate — the per-session
 * concurrency cap (P6, so parallel calls can't storm a provider), the respawn guard
 * (a re-spawn of an already-capped item is refused), and the durable worker_result
 * ledger. The worker runs on the WORKER role model when it's a Claude model, else the
 * Claude brain model (this lane can only spawn Claude workers), so "brain + workers =
 * Sonnet 5" fans out. Kill-switch CLEMMY_SDK_BRAIN_RUN_WORKER (default on).
 */
function enabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SDK_BRAIN_RUN_WORKER', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** The Claude model this lane spawns the worker on: the worker role if it's a Claude
 *  model (honors "workers = Sonnet 5"), else the Claude brain model (the SDK worker
 *  lane can only run Claude models). */
export function resolveClaudeWorkerModel(): string {
  try {
    const role = resolveRoleModel('worker').modelId;
    if (typeof role === 'string' && role.startsWith('claude-')) return role;
  } catch { /* fall through to the brain model */ }
  return getClaudeBrainModel();
}

const firstLine = (v: unknown): string => {
  const raw = v instanceof Error ? v.message : typeof v === 'string' ? v : String(v ?? '');
  return raw.split('\n')[0].slice(0, 300);
};

export function registerWorkerTools(server: McpServer): void {
  server.tool(
    'run_worker',
    [
      'Spawn a stateless Worker on ONE item using a structured parent-planned job packet. Call this MULTIPLE TIMES IN PARALLEL when you have N independent items to process (scrape, classify, summarize, fetch, transform, create/enrich N records).',
      'Each worker runs in its own isolated context — keeps YOUR context from ballooning over many items, and runs the work concurrently instead of one-at-a-time (which blows your turn budget).',
      'Pass a structured packet for ONE item: the item identifier, exact resolved tool slugs, source facts/context, instructions, and expected output shape. Workers cannot see your prior tool outputs — paste the details they need into the packet.',
      'When to use: 3+ independent items of the same kind. Aggregate the tight results the workers return.',
      'CRITICAL: a worker result beginning with "ERROR:" means that item FAILED — it was NOT done. Never report a batch complete if any worker returned ERROR; report exactly which items succeeded and which failed.',
    ].join(' '),
    WorkerToolInputSchema.shape,
    async (params) => {
      if (!enabled()) return textResult('run_worker is disabled (CLEMMY_SDK_BRAIN_RUN_WORKER=off).');
      const input = params as WorkerToolInput;
      const sessionId = getToolOutputContext()?.sessionId;
      if (!sessionId) {
        return textResult('ERROR: run_worker needs a live session context. Do this item inline instead.');
      }
      const recordResult = (ok: boolean, reason?: string, model?: string): void => {
        try {
          appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: input.item, ok, ...(reason ? { reason } : {}), ...(model ? { model } : {}), lane: 'sdk_brain' } });
        } catch { /* durable trace is best-effort */ }
      };

      // HARD respawn guard: if THIS item already hit its turn cap earlier this run,
      // refuse to re-spawn it (a re-run with the same packet just caps again — the
      // non-converging loop). Fail-open so it can never block a first spawn.
      try {
        if (workerItemAlreadyCapped(sessionId, input.item)) {
          const msg = `ERROR: worker for "${input.item}" already exhausted its turn budget on a prior attempt this run and was NOT re-spawned. Report this item as failed / needs-attention; do not retry it.`;
          recordResult(false, firstLine(msg));
          return textResult(msg);
        }
      } catch { /* fail-open */ }

      const workerModel = resolveClaudeWorkerModel();
      // P6 concurrency cap: at most K workers in flight per session; excess queue.
      const release = await acquireWorkerSlot(sessionId);
      try {
        const result = await runClaudeAgentSdkWorker(input, workerModel, sessionId);
        const ok = !/^\s*ERROR:/i.test(result.text ?? '');
        recordResult(ok, ok ? undefined : firstLine(result.text), result.model ?? workerModel);
        return textResult(result.text);
      } catch (err) {
        recordResult(false, firstLine(err), workerModel);
        return textResult(`ERROR: worker for "${input.item}" failed: ${firstLine(err)}`);
      } finally {
        release();
      }
    },
  );
}
