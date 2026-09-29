/**
 * One project's page, in the order the owner needs it: what the project is,
 * what is waiting on them, the work moving in it, who is on it, what it
 * uses, the conversations that worked in it, and what was learned there.
 *
 * Every section is drawn from the project's one overview record, and every
 * change shows the record the server answered with.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Archive, ArchiveRestore, ChevronRight, MessageSquarePlus } from 'lucide-react';
import { delegatedTaskOpen, orderDelegatedTasks } from '@clem/chat-engine';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { ScopedFacts } from '@/components/memory/ScopedFacts';
import { DelegatedTaskCard } from '@/components/projects/DelegatedTaskCard';
import { ProjectAgents } from '@/components/projects/ProjectAgents';
import { ProjectConversations, useStartProjectConversation } from '@/components/projects/ProjectConversations';
import { ProjectDecisions } from '@/components/projects/ProjectDecisions';
import { ProjectIdentity } from '@/components/projects/ProjectIdentity';
import { ProjectResources } from '@/components/projects/ProjectResources';
import { ProjectSection, QuietNote } from '@/components/projects/ProjectSection';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import {
  apiErrorCode, archiveProject, getProjectOverview, projectKeys, refusalText, restoreProject, type ProjectOverview as Overview,
} from '@/lib/projects';

export function ProjectOverview() {
  const { id = '' } = useParams();
  return <ProjectPage key={id} projectId={id} />;
}

function BackToProjects() {
  return (
    <Link to="/projects" className="mb-3 inline-flex items-center gap-1 text-small font-semibold text-muted hover:text-fg">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Projects
    </Link>
  );
}

function ProjectPage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const overviewQ = usePoll(projectKeys.overview(projectId), () => getProjectOverview(projectId), 10_000, { enabled: Boolean(projectId) });
  const overview = overviewQ.data;

  /** Show the record a change came back with, and let the list catch up. */
  const settle = (next: Overview) => {
    qc.setQueryData(projectKeys.overview(projectId), next);
    void qc.invalidateQueries({ queryKey: ['project-records', 'list'] });
  };
  const reread = () => { void qc.invalidateQueries({ queryKey: projectKeys.overview(projectId) }); };

  if (overviewQ.isLoading && !overview) {
    return (
      <Page width="reading">
        <div role="status">
          <span className="sr-only">Loading this project</span>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="mt-6 h-32 w-full" />
          <Skeleton className="mt-6 h-20 w-full" />
          <Skeleton className="mt-6 h-20 w-full" />
        </div>
      </Page>
    );
  }
  if (!overview) {
    const gone = apiErrorCode(overviewQ.error) === 'PROJECT_NOT_FOUND';
    return (
      <Page width="reading">
        <BackToProjects />
        <QueryUnavailable
          title={gone ? 'This project no longer exists' : 'This project could not be opened'}
          description={gone ? 'It may have been removed. Your other projects are untouched.' : 'Clementine couldn’t reach it just now. Nothing has been changed.'}
          onRetry={() => { void overviewQ.refetch(); }}
        />
      </Page>
    );
  }

  return <ProjectBody overview={overview} onSettled={settle} onReread={reread} />;
}

function ProjectBody({ overview, onSettled, onReread }: {
  overview: Overview;
  onSettled: (overview: Overview) => void;
  onReread: () => void;
}) {
  const { project } = overview;
  const archived = project.status === 'archived';
  const start = useStartProjectConversation(project);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [endedOpen, setEndedOpen] = useState(false);

  const tasks = orderDelegatedTasks(overview.tasks);
  const open = tasks.filter(delegatedTaskOpen);
  const ended = tasks.filter((task) => !delegatedTaskOpen(task));

  const setArchived = async (archive: boolean) => {
    setBusy(true);
    setError('');
    try {
      onSettled(await (archive ? archiveProject(project.id) : restoreProject(project.id)));
      setConfirmArchive(false);
    } catch (failure) {
      setError(refusalText(failure, archive ? 'It could not be archived. Try again.' : 'It could not be restored. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width="reading" className="pb-16">
      <BackToProjects />
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="min-w-0 break-words text-h1 text-fg">{project.name}</h2>
            {archived && <StatusPill tone="neutral">Archived</StatusPill>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {archived ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void setArchived(false); }}>
              <ArchiveRestore className="h-4 w-4" aria-hidden /> {busy ? 'Restoring…' : 'Restore'}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={start}>
                <MessageSquarePlus className="h-4 w-4" aria-hidden /> New conversation
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} aria-expanded={confirmArchive} onClick={() => setConfirmArchive((value) => !value)}>
                <Archive className="h-4 w-4" aria-hidden /> Archive
              </Button>
            </>
          )}
        </div>
      </header>

      {confirmArchive && !archived && (
        <div className="-mt-4 mb-8 rounded-md border border-border bg-subtle px-4 py-3" role="group" aria-label="Confirm archiving this project">
          <p className="text-small text-fg">
            Archive {project.name}? It leaves your list and takes no new work. Everything in it is kept, and you can restore it any time.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => { void setArchived(true); }}>{busy ? 'Archiving…' : 'Archive'}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>Keep it active</Button>
          </div>
        </div>
      )}
      {archived && (
        <p className="-mt-4 mb-8 rounded-md border border-border bg-subtle px-4 py-3 text-small text-muted">
          This project is archived: it takes no new work and cannot be changed. Restore it to pick it back up.
        </p>
      )}
      {error && <p role="alert" className="-mt-4 mb-8 text-small text-danger">{error}</p>}

      <div className="flex flex-col gap-10">
        <ProjectIdentity overview={overview} onSaved={onSettled} />

        {!archived && <ProjectDecisions overview={overview} onDecided={onReread} />}

        <ProjectSection title="Current work" count={open.length}>
          {open.length === 0 ? (
            <QuietNote>
              {ended.length === 0
                ? 'No work has been handed off in this project yet. Ask for something in a conversation here and it shows up as a task.'
                : 'Nothing is running right now.'}
            </QuietNote>
          ) : (
            <ul className="space-y-2">
              {open.map((task) => (
                <li key={task.taskId}>
                  {/* A question is answered once, under Needs you above. */}
                  <DelegatedTaskCard task={task} beside={tasks} onChanged={onReread} hideProject hideQuestion />
                </li>
              ))}
            </ul>
          )}
          {ended.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setEndedOpen((value) => !value)}
                aria-expanded={endedOpen}
                aria-controls="project-ended-work"
                className="inline-flex items-center gap-1.5 rounded-sm px-1 py-1 text-small font-semibold text-muted transition-colors hover:text-fg cursor-pointer"
              >
                <ChevronRight className={cn('h-4 w-4 transition-transform duration-fast motion-reduce:transition-none', endedOpen && 'rotate-90')} aria-hidden />
                Earlier work ({ended.length})
              </button>
              {endedOpen && (
                <ul id="project-ended-work" className="mt-2 space-y-2">
                  {ended.map((task) => (
                    <li key={task.taskId}><DelegatedTaskCard task={task} beside={tasks} onChanged={onReread} hideProject /></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </ProjectSection>

        <ProjectAgents overview={overview} onSaved={onSettled} />
        <ProjectResources overview={overview} onSaved={onSettled} />
        <ProjectConversations overview={overview} />

        <ProjectSection title="What was learned here" hint="What Clem and the agents on this project keep for it. It is used in this project and nowhere else.">
          <ScopedFacts
            filter={{ kind: 'project', projectId: project.id }}
            empty="Nothing has been learned in this project yet."
            unavailableTitle="What was learned here is unavailable"
          />
        </ProjectSection>
      </div>
    </Page>
  );
}
