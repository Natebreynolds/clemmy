/** Provider-neutral Agents adapter for the sealed terminal presentation pass. */
import { Agent, Runner } from '@openai/agents';
import type { Model } from '@openai/agents-core';
import type {
  TerminalPresentationRepairPacketV1,
  TerminalPresentationRepairPort,
} from './terminal-presentation-repair.js';

export function terminalPresentationRepairPrompt(
  packet: TerminalPresentationRepairPacketV1,
): string {
  return [
    'Accepted user request:',
    packet.acceptedRequest,
    '',
    'Reply that was unsafe to publish as a completed result:',
    packet.proposedReply,
    '',
    'Host-verified gaps:',
    ...packet.gaps.map((gap) => `- ${gap.fact}`),
    '',
    'Write only the final response to the user.',
  ].join('\n');
}

/**
 * A fresh Agent and one-turn Runner intentionally receive no tools, handoffs,
 * transcript, memory primer, discovery surface, or mutation context. The only
 * dynamic input is the controller's bounded user-safe packet.
 */
export function createAgentsTerminalPresentationRepairPort(input: {
  model: string | Model;
}): TerminalPresentationRepairPort {
  return {
    async render(packet) {
      const agent = new Agent({
        name: 'Clementine Terminal Presentation Repair',
        model: input.model,
        instructions: packet.instruction,
        modelSettings: { reasoning: { effort: 'low' } },
        tools: [],
      });
      const runner = new Runner({ workflowName: 'clementine-terminal-presentation-repair' });
      const result = await runner.run(agent, terminalPresentationRepairPrompt(packet), { maxTurns: 1 });
      const finalOutput = (result as { finalOutput?: unknown }).finalOutput;
      return typeof finalOutput === 'string' ? finalOutput : String(finalOutput ?? '');
    },
  };
}
