import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';
import type { SpaceRecord } from '@/lib/spaces';
import { cn } from '@/lib/cn';
import { currentProject, homeProjects, projectSubtitle } from './home-model';
import { LoadFailedLine, PaneCard, SectionHeader } from './HomeSection';

const TILE =
  'flex min-h-[72px] flex-col gap-1 rounded-md border px-4 py-3.5 text-left transition-all duration-fast';

/**
 * PROJECTS — the user's live workspaces, the one they are in the middle of
 * first. "New project" hands off to the Workspaces screen's create flow.
 */
export function ProjectsPane({
  spaces,
  loading,
  error,
  onRetry,
  headingId,
}: {
  spaces: readonly SpaceRecord[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  headingId: string;
}) {
  const tiles = homeProjects(spaces);
  const current = currentProject(spaces);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label="Projects"
        aside={
          <Link to="/workspaces" className="rounded-sm font-semibold text-primary hover:underline">
            All projects
          </Link>
        }
      />
      {error ? (
        <PaneCard><LoadFailedLine what="your projects" onRetry={onRetry} /></PaneCard>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {loading
            ? [0, 1, 2].map((i) => (
                <div key={i} className={cn(TILE, 'border-border bg-surface')} aria-hidden>
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))
            : tiles.map((space) => {
                const active = current?.id === space.id;
                return (
                  <Link
                    key={space.id}
                    to={`/workspaces/${encodeURIComponent(space.id)}`}
                    className={cn(
                      TILE,
                      'bg-surface hover:-translate-y-0.5 hover:shadow-md',
                      active ? 'border-primary shadow-warm-halo' : 'border-border hover:border-border-strong',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg" title={space.title}>
                        {space.title}
                      </span>
                      {active ? (
                        <span className="shrink-0 text-caption font-semibold text-primary">Active</span>
                      ) : space.status === 'paused' ? (
                        <span className="shrink-0 text-caption font-semibold text-warning">Paused</span>
                      ) : null}
                    </span>
                    <span className="truncate text-small text-muted">{projectSubtitle(space)}</span>
                  </Link>
                );
              })}
          {!loading && tiles.length === 0 && (
            <p className="flex items-center text-small text-faint sm:col-span-2 lg:col-span-3">
              No projects yet — start one and Clementine keeps it live.
            </p>
          )}
          <Link
            to="/workspaces?new=1"
            className={cn(
              TILE,
              'items-center justify-center border-dashed border-border bg-transparent text-small font-semibold text-faint hover:border-border-strong hover:text-fg',
            )}
          >
            <span className="inline-flex items-center gap-2">
              <Plus className="h-4 w-4" aria-hidden />
              New project
            </span>
          </Link>
        </div>
      )}
    </section>
  );
}
