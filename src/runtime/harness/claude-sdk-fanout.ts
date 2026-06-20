/**
 * Phase 1 — run_worker fan-out for the Claude Agent SDK brain.
 *
 * The SDK brain (native Claude tool-calling) had NO run_worker, so it did multi-item
 * work SEQUENTIALLY in its own loop (piling every item's payload into one context).
 * This exposes a run_worker tool to the brain via an IN-PROCESS SDK MCP server
 * (createSdkMcpServer) — which runs in the DAEMON, where configureHarnessRuntime has
 * registered the model provider. (The stdio clementine-local subprocess is the WRONG
 * home: a Codex worker spawned there has no provider — verified in the design pass.)
 *
 * The handler reuses the EXISTING worker primitive (runClaudeAgentSdkWorker) with the
 * PARENT session id, so the gates + plan-scope + execution lane aggregate across the
 * fan-out — one batch approval covers all workers, and a worker never self-prompts.
 * The Anthropic SDK runs parallel tool_use blocks concurrently, so N run_worker calls
 * fan out for real.
 *
 * PHASE 1 spawns CLAUDE workers only. A configured Codex (gpt-*) worker model needs the
 * @openai/agents runContext (not available in an SDK MCP handler) and is Phase 2 — for
 * now a non-claude worker falls back to a claude worker so fan-out still works.
 *
 * Default OFF: CLEMMY_CLAUDE_SDK_FANOUT. Off → the server isn't built, run_worker isn't
 * exposed, the brain behaves byte-identically (sequential).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { getRuntimeEnv } from '../../config.js';
import { WorkerToolInputSchema, type WorkerToolInput } from '../../agents/worker-job-packet.js';
import { runClaudeAgentSdkWorker } from './claude-agent-worker.js';
import { resolveRoleModel } from './model-roles.js';
import { appendEvent } from './eventlog.js';

const logger = pino({ name: 'clementine-next.claude-sdk-fanout' });

export const CLAUDE_SDK_FANOUT_SERVER = 'clementine-fanout';
export const CLAUDE_SDK_FANOUT_TOOL = 'run_worker';
/** SDK-namespaced tool id the model sees + the permission layer must allow. */
export const CLAUDE_SDK_FANOUT_TOOL_FQN = `mcp__${CLAUDE_SDK_FANOUT_SERVER}__${CLAUDE_SDK_FANOUT_TOOL}`;

/** Phase-1 fallback worker when the configured worker is a non-claude (Codex) model. */
const PHASE1_FALLBACK_CLAUDE_WORKER = 'claude-sonnet-4-6';

export function claudeSdkFanoutEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_CLAUDE_SDK_FANOUT', '') || '').trim());
}

const RUN_WORKER_DESCRIPTION =
  'Fan out ONE independent item of a same-shape batch to an isolated worker that runs it end-to-end and returns a ' +
  'tight result you aggregate. Call it MULTIPLE TIMES IN PARALLEL (one per item) for 3+ independent items — ' +
  'ESPECIALLY multi-step per-item work (e.g. "research these 10 prospects"): the worker gets a fresh ~10K context so ' +
  'each item\'s raw payload never piles into yours. PARENT-PLANNED: resolve the shared tools/slugs/schema ONCE and ' +
  'pass each worker a complete packet. For external writes, open the execution lane + get ONE batch approval FIRST; ' +
  'the workers ride that scope (they never re-approve or self-prompt).';

/** Build the in-process fan-out MCP server, closing over the PARENT session id so the
 *  worker spawn aggregates under it. Returns the SDK server config to add to query()'s
 *  mcpServers. Only call when claudeSdkFanoutEnabled() and a sessionId is present. */
export function buildClaudeSdkFanoutServer(sessionId: string) {
  const runWorker = tool(
    CLAUDE_SDK_FANOUT_TOOL,
    RUN_WORKER_DESCRIPTION,
    WorkerToolInputSchema.shape,
    async (args) => {
      const input = args as unknown as WorkerToolInput;
      // Resolve the configured worker model; Phase 1 runs CLAUDE workers, so a non-claude
      // (Codex) worker model falls back to a claude worker (Codex spawn = Phase 2).
      const configured = resolveRoleModel('worker', input.intent ?? undefined).modelId;
      const isClaude = typeof configured === 'string' && configured.startsWith('claude-');
      const workerModel = isClaude ? configured : PHASE1_FALLBACK_CLAUDE_WORKER;
      try {
        const result = await runClaudeAgentSdkWorker(input, workerModel, sessionId);
        try {
          appendEvent({
            sessionId, turn: 0, role: 'system', type: 'worker_model_routed',
            data: {
              seam: 'claude_sdk_fanout', item: input.item, attemptedIntent: input.intent ?? null,
              modelId: workerModel, provider: 'claude', transport: 'claude_agent_sdk_worker',
              codexFallbackPending: !isClaude, configuredWorker: configured,
              sdkSessionId: result.sdkSessionId ?? null, toolUses: result.toolUses,
            },
          });
        } catch { /* routing telemetry must never block fan-out */ }
        return { content: [{ type: 'text' as const, text: result.text || `(worker for "${input.item}" returned no text)` }] };
      } catch (err) {
        logger.warn({ err, item: input.item }, 'claude-sdk fan-out worker failed');
        return {
          content: [{ type: 'text' as const, text: `Worker for "${input.item}" failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
  return createSdkMcpServer({ name: CLAUDE_SDK_FANOUT_SERVER, version: '0.1.0', tools: [runWorker] });
}
