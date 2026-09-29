/**
 * What an agent is on: the projects it is assigned to with what it answers
 * for in each, the tasks it owns now, and how the ones it owned ended.
 *
 * This is the persistent agent's own work. The one-off helper runs its
 * threads spin up for a single step are listed apart (AgentWorkspace).
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { DelegatedTaskCard } from '@/components/projects/DelegatedTaskCard';
import { Skeleton } from '@/components/ui/Skeleton';
import type { AgentRecord } from '@/lib/agents';
import { usePoll } from '@/lib/poll';
import { getAgentAssignments, projectKeys } from '@/lib/projects';

const HEADING = 'text-caption font-semibold text-faint';

export function AgentAssignments({ agent }: { agent: AgentRecord }) {
  const qc = useQueryClient();
  const work = usePoll(projectKeys.agentAssignments(agent.id), () => getAgentAssignments(agent.id), 10_000);
  const reread = () => { void qc.invalidateQueries({ queryKey: projectKeys.agentAssignments(agent.id) }); };

  if (work.isLoading && !work.data) {
    return (
      <section aria-label={`${agent.name}'s projects and tasks`} role="status">
        <span className="sr-only">Loading projects and tasks</span>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-12 w-full" />
      </section>
    );
  }
  if (work.isError && !work.data) {
    return (
      <section aria-label={`${agent.name}'s projects and tasks`}>
        <div className={HEADING}>Projects and tasks</div>
        <p className="mt-1 text-caption text-muted" role="alert">
          These couldn’t be read just now. Nothing has changed.{' '}
          <button type="button" onClick={() => { void work.refetch(); }} className="font-semibold text-primary hover:underline cursor-pointer">Try again</button>
        </p>
      </section>
    );
  }

  const { projects, currentTasks, recentOutcomes } = work.data ?? { projects: [], currentTasks: [], recentOutcomes: [] };
  const everyTask = [...currentTasks, ...recentOutcomes];

  return (
    <>
      <section>
        <div className={HEADING}>Projects</div>
        {projects.length === 0 ? (
          <p className="mt-1 text-caption text-muted">
            Not assigned to a project yet. Assign it from a <Link to="/projects" className="font-semibold text-primary hover:underline">project’s page</Link>.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {projects.map((project) => (
              <li key={project.projectId}>
                <Link
                  to={`/projects/${encodeURIComponent(project.projectId)}`}
                  className="block rounded-lg border border-border/60 bg-surface px-2.5 py-2 transition-colors hover:border-border-strong hover:bg-hover"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{project.projectName}</span>
                    {project.activeTasks > 0 && (
                      <span className="shrink-0 text-caption text-muted">{project.activeTasks} active</span>
                    )}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-caption text-muted">
                    {project.responsibility || 'Nothing written yet about what it answers for here.'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className={HEADING}>Tasks it owns now</div>
        {currentTasks.length === 0 ? (
          <p className="mt-1 text-caption text-muted">Nothing in hand.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {currentTasks.map((task) => (
              <li key={task.taskId}><DelegatedTaskCard task={task} beside={everyTask} onChanged={reread} hideOwner compact className="px-3 py-2.5" /></li>
            ))}
          </ul>
        )}
      </section>

      {recentOutcomes.length > 0 && (
        <section>
          <div className={HEADING}>How its tasks ended</div>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {recentOutcomes.slice(0, 6).map((task) => (
              <li key={task.taskId}><DelegatedTaskCard task={task} beside={everyTask} onChanged={reread} hideOwner compact className="px-3 py-2.5" /></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
