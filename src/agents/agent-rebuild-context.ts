import type { BuildOrchestratorAgentOptions } from './orchestrator.js';

/** Serializable inputs to the original surface construction. Definitions,
 * connections and authority must still be rebuilt and checked at recovery. */
export type AgentRebuildContext = Pick<BuildOrchestratorAgentOptions,
  'allowedToolNames' | 'excludeToolNames' | 'allowToolJit' | 'taskContinuation'
  | 'taskContinuationResolved' | 'turnCandidates'>;

const contexts = new WeakMap<object, AgentRebuildContext>();
const clone = (value: AgentRebuildContext): AgentRebuildContext => JSON.parse(JSON.stringify(value));

export function bindAgentRebuildContext(agent: object, options: BuildOrchestratorAgentOptions): void {
  const context: AgentRebuildContext = {
    allowedToolNames: options.allowedToolNames,
    excludeToolNames: options.excludeToolNames,
    allowToolJit: options.allowToolJit,
    taskContinuation: options.taskContinuation,
    taskContinuationResolved: options.taskContinuationResolved,
    turnCandidates: options.turnCandidates,
  };
  contexts.set(agent, clone(context));
}

export function boundAgentRebuildContext(agent: object): AgentRebuildContext | undefined {
  const context = contexts.get(agent);
  return context ? clone(context) : undefined;
}
