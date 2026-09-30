/** Rebuild and check the retained model, tool surface and execution route.
 * This is an unwired prerequisite, not a complete execution restore. Durable
 * agent/project/memory identity, connection activation, leases, cancellation,
 * delivery ownership and per-call consent remain separate requirements. */
import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@openai/agents';
import type { BuildOrchestratorAgentOptions } from '../../agents/orchestrator.js';
import { boundAgentCapabilityEnvelope } from '../../agents/capability-envelope.js';
import { boundAgentRebuildContext } from '../../agents/agent-rebuild-context.js';
import { boundAgentMcpToolScope } from '../mcp-tool-authority.js';
import { mcpToolScopeAuthority } from '../mcp-tool-scope.js';
import { acceptedPlanExecutionText } from './accepted-plan-execution.js';
import { readSourceConnectionCheckpoint } from './source-connection-checkpoints.js';
import type { primePrimaryModelPlanningCatalog } from '../semantic-boundary/admit-and-compile-accepted-source.js';
import type { revalidateReviewedPlanPreparation } from './reviewed-plan-runtime.js';

interface RebuildPorts {
  prime: typeof primePrimaryModelPlanningCatalog;
  revalidate: typeof revalidateReviewedPlanPreparation;
  build: (options: BuildOrchestratorAgentOptions) => Promise<Agent<any, any>>;
}

export async function rebuildSourceConnectionAgent(
  input: { sessionId: string; requestId: string; assertOwned: () => void },
  /** Recording/injected test ports. Production uses the existing builder and
   * reviewed-plan revalidation; never pass these from a browser or model. */
  ports?: RebuildPorts,
): Promise<Agent<any, any>> {
  input.assertOwned();
  const checkpoint = readSourceConnectionCheckpoint(input);
  if (!checkpoint?.agent || !checkpoint.agent.modelId) {
    throw new Error('The paused execution has no retained tool context and replayable model identity.');
  }
  const context = checkpoint.agent;
  const userInput = acceptedPlanExecutionText(input.sessionId, checkpoint.sourceUserSeq);
  if (!userInput) throw new Error('The paused execution has no original reviewed request.');
  const runtime = ports ?? {
    prime: (await import('../semantic-boundary/admit-and-compile-accepted-source.js')).primePrimaryModelPlanningCatalog,
    revalidate: (await import('./reviewed-plan-runtime.js')).revalidateReviewedPlanPreparation,
    build: (await import('../../agents/orchestrator.js')).buildOrchestratorAgent,
  };
  input.assertOwned();
  const primed = await runtime.prime({ sessionId: input.sessionId, sourceUserSeq: checkpoint.sourceUserSeq });
  input.assertOwned();
  if (!primed.ok) throw new Error(primed.reason);
  // A successful sign-in is not permission to replace the reviewed provider,
  // account, capability or schema. The ordinary Execute check remains binding.
  await runtime.revalidate(primed.planning);
  input.assertOwned();
  const agent = await runtime.build({
    ...context.rebuildContext,
    sessionId: input.sessionId, sourceUserSeq: checkpoint.sourceUserSeq,
    userInput, model: context.modelId, hostFreshPlanning: primed.planning,
    mcpToolScope: context.mcpToolScope ?? {
      reason: 'The retained execution explicitly denied external MCP tools.',
      authority: 'none', allowedServerSlugs: [], maxTools: 0,
    },
  });
  input.assertOwned();
  // Bind freshly compiled definitions only. The historical envelope must
  // never be attached to the newly constructed tools as an authority shortcut.
  if (boundAgentCapabilityEnvelope(agent)?.envelopeDigest !== context.envelope.envelopeDigest) {
    throw new Error('The paused execution tool definitions or policy changed and require review.');
  }
  const currentScope = boundAgentMcpToolScope(agent);
  if (!currentScope.bound || currentScope.scope === undefined
    || (context.mcpToolScope === null
      ? currentScope.scope !== null && mcpToolScopeAuthority(currentScope.scope) !== 'none'
      : !isDeepStrictEqual(currentScope.scope, context.mcpToolScope))) {
    throw new Error('The rebuilt execution changed its retained external tool scope.');
  }
  if (agent.model !== context.modelId) throw new Error('The rebuilt execution did not preserve its selected model.');
  const rebuiltContext = boundAgentRebuildContext(agent);
  if (!rebuiltContext || !isDeepStrictEqual(rebuiltContext, context.rebuildContext)) {
    throw new Error('The rebuilt execution changed its retained construction context or accepted route.');
  }
  return agent;
}
