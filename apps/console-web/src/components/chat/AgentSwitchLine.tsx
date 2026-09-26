/**
 * The line a thread draws where the conversation moved to another agent (or
 * back to Clem). Placed above the message that started the change; the words
 * come from the shared chat engine so the phone says the same thing.
 */
import { Users } from 'lucide-react';
import { agentSwitchLabel } from '@clem/chat-engine';

export function AgentSwitchLine({ name }: { name: string | null }) {
  return (
    <div role="separator" aria-label={agentSwitchLabel(name)} className="flex items-center gap-3 py-1 text-caption text-faint">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="inline-flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5" aria-hidden />
        {agentSwitchLabel(name)}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
