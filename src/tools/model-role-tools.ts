import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, updateEnvKey } from './shared.js';
import { getRuntimeEnv } from '../config.js';
import {
  readDurableBindings,
  resolveRoleModel,
  type ModelRole,
  type RoleBinding,
} from '../runtime/harness/model-roles.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { resetHarnessRuntimeConfig } from '../runtime/harness/codex-client.js';
import { resetClaudeModelCache } from '../runtime/harness/claude-model.js';
import { resetByoModelCache } from '../runtime/harness/byo-model.js';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';

/**
 * model-role tools — Clem's chat interface to the role→model registry, so a user
 * can steer model routing in plain language ("use DeepSeek for the workers",
 * "make the judge Opus", "put the workers back on the default"). These write the
 * SAME CLEMMY_MODEL_ROLES bindings the Models UI writes (source:'chat-rule'), so
 * a chat rule shows up in the panel and vice-versa.
 *
 * v1 sets ROLE-WIDE bindings (worker/judge). The brain is a provider LOGIN switch
 * (handled in Settings → Models), and intent-scoped routing ("use Claude for
 * design") is the next step. Kill-switch CLEMMY_CHAT_MODEL_ROUTING (default on).
 */
function chatModelRoutingEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CHAT_MODEL_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off';
}

function bustModelCaches(): void {
  resetHarnessRuntimeConfig();
  resetClaudeModelCache();
  resetByoModelCache();
  clearAutonomyAgentCache();
}

/** Upsert (or clear) a role-wide binding + keep the judge branch in sync. */
function applyRoleBinding(role: ModelRole, modelId: string, clear: boolean): void {
  const current = readDurableBindings();
  const next: RoleBinding[] = current.filter((b) => !(b.role === role && !b.whenIntent));
  if (!clear) next.push({ role, modelId, scope: 'durable', source: 'chat-rule' });
  updateEnvKey('CLEMMY_MODEL_ROLES', JSON.stringify(next));
  if (role === 'judge') {
    const branch = clear ? 'claude' : resolveProvider(modelId) === 'codex' ? 'codex' : 'claude';
    updateEnvKey('CLEMMY_DEBATE_JUDGE', branch);
    process.env.CLEMMY_DEBATE_JUDGE = branch;
  }
  bustModelCaches();
}

export function registerModelRoleTools(server: McpServer): void {
  server.tool(
    'set_model_role',
    [
      'Route a model ROLE to a specific model, when the user asks in chat (e.g. "use DeepSeek for the workers", "make the judge Opus", "run the checker on Sonnet").',
      'role = worker (delegated run_worker/grunt labor) or judge (the fusion verify checker). The BRAIN is a provider login switch — do NOT set it here; point the user to Settings → Models.',
      'modelId is an exact id the user is logged into, e.g. claude-opus-4-8, claude-sonnet-4-6, gpt-5.4, gpt-5.5, deepseek-chat, minimax-01. Takes effect on the next turn, no restart.',
      'This persists as a durable rule and shows in the Models panel. To revert, use clear_model_role.',
    ].join('\n'),
    {
      role: z.enum(['worker', 'judge']).describe('worker = delegated labor model; judge = fusion checker model.'),
      modelId: z.string().min(1).max(60).describe('Exact model id the user has access to (e.g. claude-opus-4-8, gpt-5.4, deepseek-chat).'),
    },
    async ({ role, modelId }) => {
      if (!chatModelRoutingEnabled()) return textResult('Chat model routing is disabled (CLEMMY_CHAT_MODEL_ROUTING=off).');
      applyRoleBinding(role as ModelRole, modelId.trim(), false);
      const w = resolveRoleModel('worker');
      const j = resolveRoleModel('judge');
      return textResult(
        `Done — ${role} now routes to ${modelId.trim()}.\n` +
          `Current roles: worker=${w.modelId} (${w.provider}), judge=${j.modelId} (${j.provider}).`,
      );
    },
  );

  server.tool(
    'clear_model_role',
    [
      'Revert a model ROLE to its default (the model derived from whichever provider the user is on).',
      'Use when the user says e.g. "put the workers back to normal" or "stop using Opus for the judge".',
    ].join('\n'),
    {
      role: z.enum(['worker', 'judge']).describe('The role to reset to its provider-derived default.'),
    },
    async ({ role }) => {
      if (!chatModelRoutingEnabled()) return textResult('Chat model routing is disabled (CLEMMY_CHAT_MODEL_ROUTING=off).');
      applyRoleBinding(role as ModelRole, '', true);
      const r = resolveRoleModel(role as ModelRole);
      return textResult(`Reverted ${role} to its default: ${r.modelId} (${r.provider}).`);
    },
  );
}
