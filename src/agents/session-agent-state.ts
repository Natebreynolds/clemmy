/**
 * The agent pointer a conversation's metadata carries, read without touching
 * any store — safe to import from the lowest runtime layers.
 */
export interface SessionAgentState {
  /** The agent answering from the next turn on; null = Clem without an agent. */
  agentId: string | null;
  agentName: string | null;
  /** Every agent that has been current in this conversation, oldest first. */
  agentIds: string[];
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function sessionAgentState(metadata: Record<string, unknown> | null | undefined): SessionAgentState {
  const agentId = cleanId(metadata?.agentId);
  const agentName = agentId ? cleanId(metadata?.agentName) : null;
  const listed = Array.isArray(metadata?.agentIds)
    ? (metadata!.agentIds as unknown[]).map(cleanId).filter((id): id is string => id !== null)
    : [];
  // A conversation opened in an agent before switching existed carries only
  // its agentId; that agent took part all the same.
  const agentIds = [...new Set(agentId && !listed.includes(agentId) ? [...listed, agentId] : listed)];
  return { agentId, agentName, agentIds };
}

