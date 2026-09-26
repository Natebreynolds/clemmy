/**
 * Who answers a conversation, as the composer's agent chip shows it.
 *
 * The chip can change at any time. The server learns of the choice just
 * before the next message goes out, so a pick nobody sends to never moves
 * the conversation, and a reply still running keeps the agent it started
 * with (a message sent while busy steers that reply; the choice waits for
 * the next one). The call is repeated before every message: it is a no-op
 * when nothing changed, and it keeps what the chip shows true even after
 * another device switched the same conversation.
 */
import { useCallback, useRef, useState } from 'react';
import { setConversationAgent, type ConversationAgent } from './agents';

export interface AddressedMessage {
  /** A brand-new conversation opens inside this agent. */
  agentId?: string;
  /** Who the message is addressed to: an agent's name, null for Clem. */
  agentName?: string | null;
}

export function useConversationAgent(initial: ConversationAgent | null, opts?: { onSwitched?: () => void }) {
  const [chosen, setChosen] = useState<ConversationAgent | null>(initial);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const onSwitched = opts?.onSwitched;

  const choose = useCallback((agent: ConversationAgent | null) => setChosen(agent), []);

  /** Apply the choice to `sessionId` (null = the conversation is not created
   *  yet) and say who the outgoing message is addressed to. */
  const prepare = useCallback(async (sessionId: string | null, busy: boolean): Promise<AddressedMessage> => {
    if (busy) return {};
    const agent = chosenRef.current;
    if (!sessionId) return agent ? { agentId: agent.id, agentName: agent.name } : { agentName: null };
    try {
      const result = await setConversationAgent(sessionId, agent?.id ?? null);
      if (result.changed) onSwitched?.();
      // The server's answer is who actually replies (a deleted agent falls
      // back to Clem); the chip follows it.
      if ((result.agentId ?? null) !== (agent?.id ?? null)) {
        setChosen(result.agentId ? { id: result.agentId, name: result.agentName ?? '' } : null);
      }
      return { agentName: result.agentName };
    } catch (error) {
      // A conversation that takes no agent (a Space dock) still takes a plain
      // message; only a real choice it cannot honor stops the send.
      if (!agent && (error as { status?: number }).status === 409) return {};
      throw error;
    }
  }, [onSwitched]);

  return { chosen, choose, prepare };
}
