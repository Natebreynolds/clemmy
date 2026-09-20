import type { AgentInputItem } from '@openai/agents';

/** Replay one already-chosen historical projection without moving its boundary
 * as the turn grows. A changed prefix (recovery, archival, or another filter)
 * keeps the original input; current-source frames are never candidates here. */
export function retainedHistoryPrefixProjection(
  original: readonly AgentInputItem[],
  projected: readonly AgentInputItem[],
): (input: AgentInputItem[]) => AgentInputItem[] {
  const signature = JSON.stringify(original);
  const length = original.length;
  const replacement = [...projected];
  return (input) => {
    if (!length || input.length < length
      || JSON.stringify(input.slice(0, length)) !== signature) return input;
    return [...replacement, ...input.slice(length)];
  };
}
