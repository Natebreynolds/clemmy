/**
 * Claude Code as a delegated coding agent, driven through the Agent SDK.
 *
 * The opposite profile of Clem's own Claude lanes (claude-agent-sdk.ts runs the
 * CLI tool-less in Clem's package directory as a model): here Claude Code keeps
 * its full coding toolset and works in the run's worktree, with the project's
 * CLAUDE.md, commands and skills loaded. What it may not do is decided by
 * Clem's policy at the PreToolUse hook, which fires for every tool call even
 * when the user's own settings would pre-allow it. The user's personal
 * settings layer is not loaded, so their "always allow" rules and MCP servers
 * do not ride along; connectors go through Clem.
 *
 * Streaming input keeps one session open for the whole run: a steer lands in
 * the current turn, a follow-up starts the next, and the session id Clem minted
 * before the start makes a restart resumable.
 */
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  HookCallback,
  Options as ClaudeAgentOptions,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCliPath } from '../runtime/harness/claude-headless-model.js';
import { assertLiveModelTransportAllowed } from '../runtime/harness/live-model-guard.js';
import {
  AsyncQueue,
  describeToolInput,
  type CodingAgentBridge,
  type CodingAgentEvent,
  type CodingAgentSession,
  type CodingAgentStartInput,
  type CodingAgentUsage,
  type CodingPlanItem,
} from './coding-agent-bridge.js';

type QueryFn = typeof claudeQuery;
let queryImpl: QueryFn = claudeQuery;
/** Test seam — every test that can reach a coding run stubs the SDK here. */
export function setClaudeCodingQueryForTests(fn: QueryFn | null): void {
  queryImpl = fn ?? claudeQuery;
}

const STEP_OUTPUT_MAX = 1_500;

function userMessage(text: string, priority: 'now' | 'next'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    priority,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .filter(Boolean)
    .join('\n');
}

function planItems(input: unknown): CodingPlanItem[] | null {
  const todos = input && typeof input === 'object' ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return null;
  const items: CodingPlanItem[] = [];
  for (const todo of todos) {
    if (!todo || typeof todo !== 'object') continue;
    const text = String((todo as { content?: unknown }).content ?? '').trim();
    const raw = (todo as { status?: unknown }).status;
    const status = raw === 'completed' || raw === 'in_progress' ? raw : 'pending';
    if (text) items.push({ text: text.slice(0, 200), status });
  }
  return items;
}

function usageFrom(modelUsage: unknown): CodingAgentUsage[] {
  if (!modelUsage || typeof modelUsage !== 'object') return [];
  const out: CodingAgentUsage[] = [];
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const u = raw as Record<string, unknown>;
    const n = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    out.push({
      model,
      inputTokens: n(u.inputTokens),
      cachedInputTokens: n(u.cacheReadInputTokens),
      cacheCreationInputTokens: n(u.cacheCreationInputTokens),
      outputTokens: n(u.outputTokens),
    });
  }
  return out;
}

/** Map one SDK message to the shared event vocabulary. */
export function claudeMessageEvents(message: SDKMessage): CodingAgentEvent[] {
  if (message.type === 'system' && (message as { subtype?: unknown }).subtype === 'init') {
    const init = message as { session_id?: unknown; model?: unknown };
    return typeof init.session_id === 'string'
      ? [{ kind: 'session', agentSessionId: init.session_id, model: typeof init.model === 'string' ? init.model : null }]
      : [];
  }
  if (message.type === 'assistant') {
    const nested = Boolean(message.parent_tool_use_id);
    const events: CodingAgentEvent[] = [];
    const content = (message.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return events;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'message', text: block.text, nested });
      } else if (block?.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
        const plan = block.name === 'TodoWrite' ? planItems(block.input) : null;
        if (plan) events.push({ kind: 'plan', items: plan });
        else events.push({ kind: 'step_started', stepId: block.id, tool: block.name, detail: describeToolInput(block.input), nested });
      }
    }
    return events;
  }
  if (message.type === 'user') {
    const content = (message.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const events: CodingAgentEvent[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      events.push({
        kind: 'step_finished',
        stepId: block.tool_use_id,
        ok: block.is_error !== true,
        output: toolResultText(block.content).slice(0, STEP_OUTPUT_MAX),
      });
    }
    return events;
  }
  if (message.type === 'result') {
    const result = message as {
      subtype?: unknown; is_error?: unknown; result?: unknown; errors?: unknown;
      modelUsage?: unknown; total_cost_usd?: unknown;
    };
    const ok = result.subtype === 'success' && result.is_error !== true;
    const finalMessage = typeof result.result === 'string'
      ? result.result
      : Array.isArray(result.errors) ? result.errors.map(String).join('\n') : '';
    return [{
      kind: 'turn_completed',
      ok,
      finalMessage,
      usage: usageFrom(result.modelUsage),
      costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    }];
  }
  return [];
}

export const claudeCodingAgent: CodingAgentBridge = {
  id: 'claude',
  start(input: CodingAgentStartInput): CodingAgentSession {
    if (queryImpl === claudeQuery) assertLiveModelTransportAllowed('coding-agent:claude');
    const prompts = new AsyncQueue<SDKUserMessage>();
    const events = new AsyncQueue<CodingAgentEvent>();
    prompts.push(userMessage(input.message, 'next'));

    const gate = (tool: string, toolInput: Record<string, unknown>, stepId: string | null) => {
      const decision = input.decide(tool, toolInput);
      if (decision.decision === 'deny') {
        events.push({
          kind: 'permission',
          stepId,
          tool,
          detail: describeToolInput(toolInput),
          decision: decision.decision,
          effect: decision.effect,
          reason: decision.reason,
        });
      }
      return decision;
    };

    const preToolUse: HookCallback = async (hookInput) => {
      const pre = hookInput as { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown };
      const tool = typeof pre.tool_name === 'string' ? pre.tool_name : '';
      const toolInput = pre.tool_input && typeof pre.tool_input === 'object' ? pre.tool_input as Record<string, unknown> : {};
      const decision = gate(tool, toolInput, typeof pre.tool_use_id === 'string' ? pre.tool_use_id : null);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      };
    };

    // Backstop for anything that still reaches a permission prompt after the
    // hook allowed it (the CLI's own safety checks): the same policy answers.
    const canUseTool: CanUseTool = async (tool, toolInput, options) => {
      const decision = input.decide(tool, toolInput);
      return decision.decision === 'allow'
        ? { behavior: 'allow', updatedInput: toolInput, toolUseID: (options as { toolUseID?: string }).toolUseID }
        : { behavior: 'deny', message: decision.reason, toolUseID: (options as { toolUseID?: string }).toolUseID };
    };

    const pathToClaudeCodeExecutable = resolveClaudeCliPath() ?? undefined;
    const options: ClaudeAgentOptions = {
      cwd: input.cwd,
      env: input.env,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.resume ? { resume: input.agentSessionId } : { sessionId: input.agentSessionId }),
      persistSession: true,
      settingSources: ['project', 'local'],
      tools: { type: 'preset', preset: 'claude_code' },
      strictMcpConfig: true,
      mcpServers: {},
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions },
      settings: { autoCompactEnabled: true },
    };

    const run = queryImpl({ prompt: prompts, options });
    let closed = false;
    void (async () => {
      try {
        for await (const message of run) {
          for (const event of claudeMessageEvents(message)) events.push(event);
        }
      } catch (error) {
        if (!closed) events.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        prompts.close();
        events.close();
      }
    })();

    return {
      events,
      send(text: string, mode: 'steer' | 'follow_up'): void {
        prompts.push(userMessage(text, mode === 'steer' ? 'now' : 'next'));
      },
      async interrupt(): Promise<void> {
        try { await run.interrupt(); } catch { /* already finished */ }
      },
      close(): void {
        if (closed) return;
        closed = true;
        prompts.close();
        try { run.close(); } catch { /* already closed */ }
      },
    };
  },
};
