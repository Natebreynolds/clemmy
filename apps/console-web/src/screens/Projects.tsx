/**
 * Projects: the bodies of work Clem and her agents are on. Each row answers
 * what the project is for, who is on it, how much is moving and whether it
 * is waiting on the owner. A row opens the project's own page.
 *
 * These are not the code folders Connect lists, and not Spaces.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Plus } from 'lucide-react';
import { arrangeProjects, projectAgentsLine, projectNeedsYouLabel, projectWorkLine } from '@clem/chat-engine';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { listProjects, projectKeys, refusalText, restoreProject, type ProjectSummary } from '@/lib/projects';

const ARCHIVED_OPEN_KEY = 'clem.projects.archived-open';

function readArchivedOpen(): boolean {
  try { return localStorage.getItem(ARCHIVED_OPEN_KEY) === 'open'; } catch { return false; }
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const needsYou = projectNeedsYouLabel(project);
  return (
    <li className="border-t border-border first:border-t-0">
      <Link
        to={`/projects/${encodeURIComponent(project.id)}`}
        className="group flex items-start gap-3 px-5 py-4 transition-colors duration-fast hover:bg-hover"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="min-w-0 truncate text-body-lg font-semibold text-fg">{project.name}</span>
            {needsYou && <StatusPill tone="warning">{needsYou}</StatusPill>}
          </div>
          {project.purpose
            ? <p className="mt-0.5 line-clamp-2 text-body text-muted">{project.purpose}</p>
            : <p className="mt-0.5 text-body text-faint">No purpose written yet.</p>}
          <p className="mt-1.5 text-small text-muted">
            <span className={project.agents.length > 0 ? 'text-fg' : undefined}>{projectAgentsLine(project)}</span>
            {' · '}
            {projectWorkLine(project)}
          </p>
        </div>
        <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-faint transition-transform duration-fast group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
      </Link>
    </li>
  );
}

function ArchivedRow({ project, onRestored }: { project: ProjectSummary; onRestored: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restore = async () => {
    setBusy(true);
    setError('');
    try { await restoreProject(project.id); onRestored(); }
    catch (failure) { setError(refusalText(failure, 'It could not be restored. Try again.')); }
    finally { setBusy(false); }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-5 py-3 first:border-t-0">
      <Link to={`/projects/${encodeURIComponent(project.id)}`} className="min-w-0 flex-1 truncate text-body text-muted hover:text-fg hover:underline">
        {project.name}
      </Link>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void restore(); }} aria-label={`Restore ${project.name}`}>
        {busy ? 'Restoring…' : 'Restore'}
      </Button>
      {error && <p role="alert" className="basis-full text-caption text-danger">{error}</p>}
    </li>
  );
}

export function Projects() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // One read, archived included: the screen says how many are put away
  // without asking twice.
  const projectsQ = usePoll(projectKeys.list(true), () => listProjects(true), 15_000);
  const [creating, setCreating] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(readArchivedOpen);

  const { active, archived } = arrangeProjects(projectsQ.data ?? []);
  const loading = projectsQ.isLoading && !projectsQ.data;
  const refetch = () => { void qc.invalidateQueries({ queryKey: projectKeys.all }); };
  const toggleArchived = () => setArchivedOpen((open) => {
    try { localStorage.setItem(ARCHIVED_OPEN_KEY, open ? 'closed' : 'open'); } catch { /* preference only */ }
    return !open;
  });

  const newProject = (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus className="h-4 w-4" aria-hidden /> New project
    </Button>
  );

  return (
    <Page
      title="Projects"
      subtitle="What you are working on, who is on it, and what it needs from you."
      actions={newProject}
      width="reading"
    >
      {loading ? (
        <div className="space-y-3" role="status">
          <span className="sr-only">Loading your projects</span>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : projectsQ.isError && !projectsQ.data ? (
        <QueryUnavailable
          title="Your projects are unavailable"
          description="Clementine couldn’t load them just now. Nothing has been removed."
          onRetry={() => { void projectsQ.refetch(); }}
        />
      ) : active.length === 0 && archived.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="A project keeps one body of work together: what it is for, the agents on it, the accounts it uses and what it has learned."
          action={newProject}
        />
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="overflow-hidden rounded-lg border border-border bg-surface" aria-label="Active projects">
              {active.map((project) => <ProjectRow key={project.id} project={project} />)}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-5 py-6 text-body text-muted">
              Every project is archived. Restore one below, or start a new one.
            </p>
          )}

          {archived.length > 0 && (
            <div className="mt-8">
              <button
                type="button"
                onClick={toggleArchived}
                aria-expanded={archivedOpen}
                aria-controls="archived-projects"
                className="inline-flex items-center gap-1.5 rounded-sm px-1 py-1 text-small font-semibold text-muted transition-colors hover:text-fg cursor-pointer"
              >
                <ChevronRight className={cn('h-4 w-4 transition-transform duration-fast motion-reduce:transition-none', archivedOpen && 'rotate-90')} aria-hidden />
                Archived ({archived.length})
              </button>
              {archivedOpen && (
                <ul id="archived-projects" className="mt-2 overflow-hidden rounded-lg border border-border bg-surface" aria-label="Archived projects">
                  {archived.map((project) => <ArchivedRow key={project.id} project={project} onRestored={refetch} />)}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {creating && (
        <ProjectForm
          onClose={() => setCreating(false)}
          onCreated={(overview) => {
            qc.setQueryData(projectKeys.overview(overview.project.id), overview);
            refetch();
            setCreating(false);
            navigate(`/projects/${encodeURIComponent(overview.project.id)}`);
          }}
        />
      )}
    </Page>
  );
}
