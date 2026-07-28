/**
 * Durable-evidence footer under a report-back message in chat. The prose above
 * it is the model's narration; this row is the harness's ledger — status in
 * plain language, counted work, verified artifacts, send receipts, and the
 * exact next action when something still needs the user. One lazy fetch per
 * task per view (no polling); silently absent when no structure exists, so
 * ordinary chat stays uncluttered.
 */
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import { getBackgroundTaskDetail } from '@/lib/board';
import { humanStatusLabel, evidenceChips, blockerSummary } from '@/lib/work-status';
import { StatusPill } from '@/components/ui/StatusPill';

export function TaskEvidenceFooter({ taskRef }: { taskRef: { id: string; label?: string } }) {
  // Only durable background tasks have a detail endpoint; other sources
  // (workflow runs) still get the board deep-link below.
  const isBackground = taskRef.id.startsWith('bg-');
  const detail = usePoll(
    ['chat-task-evidence', taskRef.id],
    () => getBackgroundTaskDetail(taskRef.id),
    0,
    { enabled: isBackground },
  );

  const task = detail.data?.task;
  const snapshot = task?.outcomeSnapshot ?? null;
  const chips = evidenceChips(snapshot);
  const blocked = blockerSummary(snapshot);
  const statusLabel = task?.status ? humanStatusLabel(task.status) : null;
  const tone = task?.status && /fail|error|block/i.test(task.status)
    ? 'danger' as const
    : task?.status && /await|park|input|attention/i.test(task.status)
      ? 'warning' as const
      : 'success' as const;

  // Nothing verifiable and nothing to link? Stay out of the conversation.
  if (!isBackground && !taskRef.id) return null;

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {statusLabel && <StatusPill tone={tone}>{statusLabel}</StatusPill>}
        {chips.map((chip) => (
          <span key={chip} className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-medium text-fg">
            {chip}
          </span>
        ))}
        <Link
          to={`/tasks?select=${encodeURIComponent(taskRef.id)}`}
          className="ml-auto inline-flex items-center gap-1 text-caption font-semibold text-faint transition-colors hover:text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" aria-hidden /> Open evidence
        </Link>
      </div>
      {blocked && (
        <div className="mt-1.5 space-y-0.5 rounded-sm bg-warning-tint px-2 py-1.5">
          <p className="text-caption font-medium text-warning">{blocked.blocker}</p>
          {blocked.nextAction && <p className="text-caption text-fg">{blocked.nextAction}</p>}
          {blocked.resumable && (
            <p className="text-caption text-faint">Completed work is saved — Clementine resumes from here.</p>
          )}
        </div>
      )}
    </div>
  );
}
