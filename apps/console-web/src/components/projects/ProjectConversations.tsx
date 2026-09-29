/**
 * The conversations that worked in this project, newest first. Each opens in
 * Chat. A new one opens already inside the project: its first message
 * carries the project, and the server keeps it there.
 */
import { Link, useNavigate } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { relativeTime } from '@/lib/inbox';
import { conversationPath, type ProjectOverview } from '@/lib/projects';
import { ProjectSection, QuietNote } from './ProjectSection';

/** Open Chat on a new conversation that starts inside the project. */
export function useStartProjectConversation(project: { id: string; name: string }) {
  const navigate = useNavigate();
  return () => navigate('/chat', { state: { newChat: Date.now(), project: { id: project.id, name: project.name } } });
}

export function ProjectConversations({ overview }: { overview: ProjectOverview }) {
  const { project, conversations } = overview;
  const archived = project.status === 'archived';
  const start = useStartProjectConversation(project);

  return (
    <ProjectSection
      title="Conversations"
      action={!archived && (
        <Button variant="secondary" size="sm" onClick={start}>
          <MessageSquarePlus className="h-4 w-4" aria-hidden /> New conversation in this project
        </Button>
      )}
    >
      {conversations.length === 0 ? (
        <QuietNote>No conversation has worked in this project yet.</QuietNote>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {conversations.map((conversation) => {
            const when = relativeTime(conversation.updatedAt);
            return (
              <li key={conversation.sessionId} className="border-t border-border first:border-t-0">
                <Link
                  to={conversationPath(conversation.sessionId)}
                  className="flex items-center gap-3 px-5 py-3 transition-colors duration-fast hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-fg">{conversation.title?.trim() || 'Untitled conversation'}</span>
                    <span className="block truncate text-caption text-muted">
                      {conversation.agentName ? `With ${conversation.agentName}` : 'With Clem'}
                      {!conversation.current && <span> · moved on to other work since</span>}
                    </span>
                  </span>
                  {when && <span className="shrink-0 text-caption text-faint">{when === 'now' ? 'now' : `${when} ago`}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </ProjectSection>
  );
}
