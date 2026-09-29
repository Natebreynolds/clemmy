/**
 * Says which project a waiting item belongs to, and the agent on it when
 * there is one. A category, not a state: neutral, with its own icon and
 * words a screen reader gets in full.
 */
import { Link } from 'react-router-dom';
import { FolderKanban } from 'lucide-react';
import { sessionProjectLabelText } from '@clem/chat-engine';
import { cn } from '@/lib/cn';
import type { SessionProjectLabel } from '@/lib/project-labels';

const TAG = 'inline-flex max-w-full items-center gap-1 rounded-sm bg-subtle px-2 py-0.5 text-caption font-semibold text-muted';

export function ProjectLabelTag({ label, link, className }: {
  label?: SessionProjectLabel;
  /** Open the project. Left off where the tag sits inside another control. */
  link?: boolean;
  className?: string;
}) {
  if (!label) return null;
  const body = (
    <>
      <FolderKanban className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">Project: </span>
      <span className="truncate">{sessionProjectLabelText(label)}</span>
    </>
  );
  return link ? (
    <Link to={`/projects/${encodeURIComponent(label.projectId)}`} className={cn(TAG, 'transition-colors hover:bg-hover hover:text-fg', className)}>
      {body}
    </Link>
  ) : (
    <span className={cn(TAG, className)}>{body}</span>
  );
}
