/** Both composer carriers project the same agent/session/default precedence.
 * Reading a picker never starts a turn or changes its model affinity. */
import { nextAnsweringAgentModel } from './session-agent-model.js';
import { resolvedBrainForSession } from '../runtime/harness/model-roles.js';
import { resolveEffectiveProviderForModel } from '../runtime/harness/byo-providers.js';

export function nextAnsweringModel(sessionId: string | null, agentId: string | null | undefined) {
  const agent = nextAnsweringAgentModel(sessionId, agentId);
  const brain = agent
    ? { modelId: agent.modelId, provider: resolveEffectiveProviderForModel(agent.modelId), source: 'agent' as const }
    : resolvedBrainForSession(sessionId);
  const selector = brain.provider === 'codex' ? 'codex_oauth' : brain.provider === 'claude' ? 'claude_oauth' : 'api_key';
  return { agent, brain, effectiveValue: `${selector}:${brain.modelId}` };
}
