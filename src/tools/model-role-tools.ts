import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import { getRuntimeEnv } from '../config.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { ModelRoleSettingError, persistModelRoleSetting } from '../runtime/harness/model-role-settings.js';
import { resetHarnessRuntimeConfig } from '../runtime/harness/codex-client.js';
import { resetClaudeModelCache } from '../runtime/harness/claude-model.js';
import { resetByoModelCache } from '../runtime/harness/byo-model.js';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';

/**
 * model-role tools — Clem's chat interface to the role→model registry, so a user
 * can steer worker routing in plain language ("use DeepSeek for the workers",
 * "put the workers back on the default"). They write through the same owner the
 * Models UI and the phone use (source:'chat-rule'), so a chat rule shows up in
 * the panel and vice-versa.
 *
 * Chat routes WORKERS only, role-wide or scoped to one kind of work ("use Claude
 * for design"). The brain, the writer and the judge are chosen only in Settings →
 * Models: who writes the answer and who checks the work are the owner's
 * decisions, and nothing a conversation reads may change them. Kill-switch
 * CLEMMY_CHAT_MODEL_ROUTING (default on).
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

export function registerModelRoleTools(server: McpServer): void {
  server.tool(
    'set_model_role',
    [
      'Route the WORKER model, or revert it to the default, when the user asks in chat (e.g. "use DeepSeek for the workers", "put the workers back to normal").',
      'role = worker (delegated run_worker/grunt labor). The BRAIN, the WRITER and the JUDGE are chosen only in Settings → Models, so the owner controls who writes and who checks the work — do NOT set them here; point the user there.',
      'modelId is an exact id the user is logged into, e.g. claude-opus-4-8, claude-sonnet-4-6, gpt-5.4, gpt-5.5, deepseek-chat, minimax-01. Takes effect on the next turn, no restart.',
      'reset=true reverts the role to its provider-derived default instead of setting a model ("put the workers back to normal"). Pass EITHER modelId OR reset:true, not both.',
      'whenIntent (optional) scopes the rule to ONE kind of work in the user\'s OWN words: "use Claude Opus for design" → role:"worker", modelId:"claude-opus-4-8", whenIntent:"design". With reset it clears only that one intent-scoped rule; omit it for the role-wide rule. When you later fan a sub-task of that kind out to a worker, tag the worker with the same intent word and it routes to this model.',
      'This persists as a durable rule and shows in the Models panel.',
    ].join('\n'),
    {
      role: z.enum(['worker']).describe('worker = delegated labor model. The brain, writer and judge are Settings-only.'),
      modelId: z.string().min(1).max(60).optional().describe('Exact model id the user has access to (e.g. claude-opus-4-8, gpt-5.4, deepseek-chat). Omit when reset=true.'),
      reset: z.boolean().optional().describe('Revert the role (or the named intent rule) to its provider-derived default. Mutually exclusive with modelId.'),
      whenIntent: z.string().min(1).max(80).optional().describe('Optional free-form category, in the user\'s OWN words, to scope this rule to one kind of work ("design", "legal", "research"). Omit for a role-wide rule.'),
    },
    async ({ role, modelId, reset, whenIntent }) => {
      if (!chatModelRoutingEnabled()) return textResult('Chat model routing is disabled (CLEMMY_CHAT_MODEL_ROUTING=off).');
      const clean = modelId?.trim();
      if (reset && clean) return textResult('Pass either modelId (to set a model) or reset:true (to revert to default), not both.');
      if (!reset && !clean) return textResult('Provide a modelId to set the role, or reset:true to revert it to the default.');
      try {
        persistModelRoleSetting({ role, modelId: reset ? undefined : clean, clear: reset === true, whenIntent, source: 'chat-rule' });
      } catch (err) {
        if (err instanceof ModelRoleSettingError) return textResult(`I can't set that model role: ${err.message}`);
        throw err;
      }
      bustModelCaches();
      if (reset) {
        const scope = whenIntent ? ` "${whenIntent.trim()}" rule` : '';
        const r = resolveRoleModel(role, whenIntent);
        return textResult(`Cleared the ${role}${scope}. ${role} now resolves to ${r.modelId} (${r.provider}).`);
      }
      const scope = whenIntent ? ` for "${whenIntent.trim()}"` : '';
      return textResult(
        `Done — ${role}${scope} now routes to ${clean}.` +
          (whenIntent ? ` I'll send "${whenIntent.trim()}" sub-tasks to ${clean}; everything else stays on the default.` : ''),
      );
    },
  );
}
