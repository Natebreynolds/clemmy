/**
 * The line a thread draws where the conversation changed: it moved into or
 * out of a project, to another agent, or both at once. One line per place,
 * above the message that started the change, so two changes made together
 * read as one event. The words come from the shared chat engine.
 */
import { FolderKanban, Users } from 'lucide-react';
import { agentSwitchLabel, projectSwitchLabel } from '@clem/chat-engine';

export function ConversationChangeLine({ agent, project }: {
  /** Set where the conversation moved to another agent (null = Clem). */
  agent?: { name: string | null };
  /** Set where the conversation changed project (null = none). */
  project?: { name: string | null; from: string | null };
}) {
  if (!agent && !project) return null;
  const projectLabel = project ? projectSwitchLabel(project.name, project.from) : '';
  const agentLabel = agent ? agentSwitchLabel(agent.name) : '';
  return (
    <div
      role="separator"
      aria-label={[projectLabel, agentLabel].filter(Boolean).join('. ')}
      className="flex items-center gap-3 py-1 text-caption text-faint"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {project && (
          <span className="inline-flex items-center gap-1.5">
            <FolderKanban className="h-3.5 w-3.5" aria-hidden />
            {projectLabel}
          </span>
        )}
        {agent && (
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {agentLabel}
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
