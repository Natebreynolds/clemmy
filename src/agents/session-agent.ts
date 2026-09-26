/**
 * Which saved agent answers a conversation.
 *
 * A conversation has one current agent, or none (Clem as usual), and it can
 * change at any time, the way the model can. The change takes effect on the
 * next turn: an agent's context is read when a turn starts, so a turn already
 * running keeps the agent it started with. Who answered each turn is recorded
 * on that turn's own route marker; this module only moves the pointer and
 * remembers which agents have taken part, so each agent's page can list the
 * conversations it worked in.
 *
 * The owner switches from the composer; Clem may switch the same way before a
 * turn starts. Both go through `setSessionAgent`, which never widens what a
 * turn may do — every gate downstream runs as it does for an unbound turn.
 */
import { getSession, openEventLog } from '../runtime/harness/eventlog.js';
import { composeSession } from '../runtime/harness/session-composition.js';
import { getAgentRecord } from './agent-record.js';
import { sessionAgentState, type SessionAgentState } from './session-agent-state.js';

export { sessionAgentState, type SessionAgentState };

export type SessionAgentSetBy = 'owner' | 'clem';

export type SetSessionAgentResult =
  | { ok: true; changed: boolean; agentId: string | null; agentName: string | null }
  | { ok: false; reason: 'session_not_found' | 'agent_not_found' | 'not_a_conversation' };

/**
 * Point a conversation at a saved agent (by id), or back at Clem with null.
 * Setting the agent it already has is a no-op that still answers ok, so a
 * client may repeat the call safely before a send.
 */
export function setSessionAgent(
  sessionId: string,
  agentId: string | null,
  opts: { by: SessionAgentSetBy },
): SetSessionAgentResult {
  const row = getSession(sessionId);
  if (!row) return { ok: false, reason: 'session_not_found' };
  // Only a plain conversation takes an agent: a Space dock, a workflow step
  // or a background execution has its own composition, which ignores one.
  if (composeSession({ sessionId, sessionKind: row.kind, metadata: row.metadata }).kind !== 'chat') {
    return { ok: false, reason: 'not_a_conversation' };
  }
  const wanted = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
  const agent = wanted ? getAgentRecord(wanted) : null;
  if (wanted && !agent) return { ok: false, reason: 'agent_not_found' };

  const current = sessionAgentState(row.metadata);
  if ((agent?.id ?? null) === current.agentId) {
    return { ok: true, changed: false, agentId: current.agentId, agentName: agent?.name ?? current.agentName };
  }

  const db = openEventLog();
  const now = new Date().toISOString();
  // Touch only these keys, atomically: a running turn may be writing its own
  // bookkeeping into the same metadata column.
  if (agent) {
    const agentIds = current.agentIds.includes(agent.id) ? current.agentIds : [...current.agentIds, agent.id];
    db.prepare(
      `UPDATE sessions SET
         metadata_json = json_set(COALESCE(metadata_json, '{}'),
           '$.agentId', ?, '$.agentName', ?, '$.agentIds', json(?), '$.agentSetBy', ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(agent.id, agent.name, JSON.stringify(agentIds), opts.by, now, sessionId);
  } else {
    db.prepare(
      `UPDATE sessions SET
         metadata_json = json_set(
           json_remove(COALESCE(metadata_json, '{}'), '$.agentId', '$.agentName'),
           '$.agentIds', json(?), '$.agentSetBy', ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(current.agentIds), opts.by, now, sessionId);
  }
  return { ok: true, changed: true, agentId: agent?.id ?? null, agentName: agent?.name ?? null };
}

/**
 * One line for a turn after the conversation moved between agents: earlier
 * replies were written under other standing instructions, which no longer
 * apply. Empty when no other agent has taken part. Per-turn text: it belongs
 * after the cache boundary, never in the stable prefix.
 */
export function agentHandoffNote(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  let state: SessionAgentState;
  try {
    state = sessionAgentState(getSession(sessionId)?.metadata);
  } catch {
    return '';
  }
  const earlier = state.agentIds
    .filter((id) => id !== state.agentId)
    .map((id) => getAgentRecord(id)?.name ?? null)
    .filter((name): name is string => Boolean(name));
  if (earlier.length === 0) return '';
  const now = state.agentId
    ? `You are now working as ${state.agentName ?? 'the agent named above'}; its standing instructions above apply from here.`
    : 'You are now answering as Clem, without an agent\'s standing instructions.';
  return `[agent-handoff] Earlier replies in this conversation may have been written while working as ${earlier.join(', ')}. ${now} Keep the facts and decisions already established; do not carry over an earlier agent's instructions.`;
}
