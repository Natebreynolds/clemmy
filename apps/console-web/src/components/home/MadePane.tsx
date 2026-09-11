import { Link } from 'react-router-dom';
import { FileText, Mail, Table2, Globe } from 'lucide-react';
import { usePoll } from '@/lib/poll';
import { artifactCountLabel, dayHeading, folderHref, groupKinds, listDelivered, type DeliveredGroup } from '@/lib/delivered';
import { LoadFailedLine, PaneCard, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

const MAX_ROWS = 6;

function FolderGlyph({ group }: { group: DeliveredGroup }) {
  const kinds = groupKinds(group);
  const Icon = kinds.has('draft') || kinds.has('send')
    ? Mail
    : kinds.has('external_doc')
      ? Table2
      : group.url
        ? Globe
        : FileText;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />;
}

/**
 * MADE — finished work from the deliverable index, as folders you can open.
 * Distinct from While you were away (notifications). One row per piece of
 * work; click through to the drafts, files, and URLs inside.
 */
export function MadePane({ headingId }: { headingId: string }) {
  const delivered = usePoll(['delivered'], () => listDelivered(24), 30_000);
  const groups = delivered.data ?? [];
  const visible = groups.slice(0, MAX_ROWS);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="Made"
        count={groups.length}
        aside={
          <Link to="/made" className="rounded-sm font-semibold text-primary hover:underline">
            All made
          </Link>
        }
      />
      <PaneCard>
        {delivered.isLoading ? (
          <RowSkeleton rows={3} />
        ) : delivered.isError ? (
          <LoadFailedLine what="finished work" onRetry={() => { void delivered.refetch(); }} />
        ) : visible.length === 0 ? (
          <QuietLine>Nothing made yet — drafts, files, and sheets land here.</QuietLine>
        ) : (
          visible.map((group) => (
            <Link
              key={group.id}
              to={folderHref(group)}
              className="flex items-center gap-3 border-t border-border px-4 py-3 transition-colors first:border-t-0 hover:bg-hover"
            >
              <FolderGlyph group={group} />
              <span className="min-w-0 shrink-0 max-w-[55%] truncate text-body font-medium text-fg" title={group.title}>
                {group.title}
              </span>
              <span className="min-w-0 flex-1 truncate text-body text-muted">
                {artifactCountLabel(group)}
              </span>
              <span className="ml-auto shrink-0 text-caption text-faint">{dayHeading(group.createdAt)}</span>
            </Link>
          ))
        )}
      </PaneCard>
    </section>
  );
}
