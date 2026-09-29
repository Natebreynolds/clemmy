/**
 * The project chip beside the composer: which project the next message works
 * in, or none. It sits beside the agent chip and behaves the same way: it can
 * change at any point, and the change takes effect on the next message
 * (lib/conversation-project). A project brings its purpose, its standing
 * context and its accounts; it does not change who answers.
 */
import { Link } from 'react-router-dom';
import { FolderKanban } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import { listProjects, projectKeys, type ConversationProject, type ProjectSummary } from '@/lib/projects';
import { ChoiceChip } from './ChoiceChip';

export function ProjectPicker({
  value,
  onChange,
  started,
  className,
}: {
  /** The project the next message works in, or null for none. */
  value?: ConversationProject | null;
  onChange?: (project: ConversationProject | null) => void;
  /** The conversation already has messages: a pick applies from the next one. */
  started?: boolean;
  className?: string;
}) {
  const roster = usePoll(projectKeys.list(false), () => listProjects(false), 30_000);
  const projects: ProjectSummary[] = (roster.data ?? []).filter((project) => project.status !== 'archived');
  // Nothing to choose from yet: the composer stays as it was.
  if (projects.length === 0 && !value) return null;
  // A chosen project that is no longer listed still shows by name until changed.
  const listed = value ? projects.find((project) => project.id === value.id) : undefined;
  const current = value ? { id: value.id, name: listed?.name ?? value.name } : null;

  return (
    <ChoiceChip
      icon={FolderKanban}
      label={current?.name || 'No project'}
      chosen={Boolean(current)}
      title={started ? 'Which project your next message works in' : 'Which project this conversation works in'}
      heading="Project"
      note={started ? 'Change any time. Takes effect on your next message.' : 'Change any time in the conversation.'}
      rows={[
        { key: 'none', name: 'No project', note: 'As usual, nothing added', on: !current, onPick: () => onChange?.(null) },
        ...projects.map((project) => ({
          key: project.id, name: project.name, note: project.purpose || undefined, on: project.id === current?.id,
          onPick: () => onChange?.({ id: project.id, name: project.name }),
        })),
      ]}
      footer={<Link to="/projects" className="underline underline-offset-2 hover:text-muted">All projects</Link>}
      className={className}
    />
  );
}
