/**
 * The agent chip beside the composer: who answers the next message — Clem,
 * or one of the owner's saved agents. Like the model chip it can change at
 * any point in a conversation; the switch takes effect on the next message
 * (lib/conversation-agent). Inside an agent's own page the chip is a plain
 * label: that page is the agent.
 */
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { listAgents, type AgentRecord, type ConversationAgent } from '@/lib/agents';
import { CHOICE_CHIP, ChoiceChip } from './ChoiceChip';

export function AgentPicker({
  value,
  onChange,
  started,
  bound,
  className,
}: {
  /** Who answers the next message, or null for Clem. */
  value?: ConversationAgent | null;
  onChange?: (agent: ConversationAgent | null) => void;
  /** The conversation already has messages: a pick changes who answers next. */
  started?: boolean;
  /** Inside an agent's own page: the chip only names it. */
  bound?: string | null;
  className?: string;
}) {
  // Read only while a choice can be made; a locked chip has no roster to fetch.
  const roster = usePoll(['agents'], listAgents, 30_000, { enabled: !bound });

  if (bound) {
    return (
      <span className={cn(CHOICE_CHIP, 'min-w-0 max-w-full cursor-default', className)} title="This conversation works inside this agent">
        <Users className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 max-w-[150px] truncate">{bound}</span>
      </span>
    );
  }

  const agents: AgentRecord[] = roster.data ?? [];
  // Nothing to choose from yet: the composer stays as it was.
  if (agents.length === 0 && !value) return null;
  // A chosen agent that is no longer saved still shows by name until changed.
  const current = value ? agents.find((a) => a.id === value.id) ?? value : null;

  return (
    <ChoiceChip
      icon={Users}
      label={current?.name ?? 'Clem'}
      chosen={Boolean(current)}
      title={started ? 'Who answers your next message' : 'Who answers this conversation'}
      heading="Who answers"
      note={started ? 'Switch any time. Takes effect on your next message.' : 'Switch any time in the conversation.'}
      rows={[
        { key: 'clem', name: 'Clem', note: 'As usual, no agent’s instructions', on: !current, onPick: () => onChange?.(null) },
        ...agents.map((a) => ({
          key: a.id, name: a.name, note: agentNote(a), on: a.id === current?.id,
          onPick: () => onChange?.({ id: a.id, name: a.name }),
        })),
      ]}
      footer={<Link to="/agents" className="underline underline-offset-2 hover:text-muted">All agents</Link>}
      className={className}
    />
  );
}

/** What the agent handles, and the model its helpers run on when it names one
 *  (the conversation itself keeps the model chip's choice). */
function agentNote(agent: AgentRecord): string {
  const helpers = agent.model ? `helpers on ${agent.model}` : '';
  return [agent.handles, helpers].filter(Boolean).join(' · ');
}
