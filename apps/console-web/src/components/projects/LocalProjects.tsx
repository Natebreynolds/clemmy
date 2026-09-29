/**
 * The local projects a project's work happens in: code folders on this Mac,
 * from the roster Connect keeps as "Code folders".
 *
 * A project links to local projects; it never becomes one. Linking records
 * where the work is and grants nothing. A row says its name first and its
 * path second, says when the folder is gone, and says when coding work
 * cannot run in it yet. A folder that says how it is worked in shows the
 * commands it offers and the tools it expects, with the ones Clem is not
 * connected to marked. Unlinking leaves the folder exactly where it is.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleAlert, FolderGit2, FolderX } from 'lucide-react';
import {
  PROJECT_LOCAL_COMMANDS_HINT, PROJECT_LOCAL_COMMANDS_LABEL, PROJECT_LOCAL_TOOL_SERVERS_LABEL,
  middleTruncatePath, projectLinkedLocalProject, projectLocalProjectChoices, projectLocalProjectCommands,
  projectLocalProjectGitLine, projectLocalProjectMissingLine, projectLocalProjectRefusal, projectLocalProjectToolServers,
} from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
// cn() keeps only the later of a size and a colour class (it reads both as
// one kind), so a name's size and colour are joined as plain strings here.
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import {
  getLocalProjects, linkLocalProject, projectKeys, refusalText, removeResource,
  type ProjectLocalProject, type ProjectOverview, type ProjectResourceView,
} from '@/lib/projects';

export function LocalProjectRow({ projectId, resource, readOnly, onSaved }: {
  projectId: string;
  resource: ProjectResourceView;
  readOnly: boolean;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = projectLinkedLocalProject(resource);
  if (!local) return null;
  const missing = projectLocalProjectMissingLine(local);
  const noGit = projectLocalProjectGitLine(local);
  const commands = missing ? [] : projectLocalProjectCommands(local);
  const tools = projectLocalProjectToolServers(missing ? {} : local);

  const remove = async () => {
    setBusy(true);
    setError('');
    try { onSaved(await removeResource(projectId, resource.id)); }
    catch (failure) { setError(refusalText(failure, 'It could not be removed. Try again.')); setBusy(false); }
  };

  return (
    <li className="border-t border-border px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {missing
          ? <FolderX className="mt-1 h-4 w-4 shrink-0 text-warning" aria-hidden />
          : <FolderGit2 className="mt-1 h-4 w-4 shrink-0 text-faint" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className={`truncate text-body font-semibold ${missing ? 'text-muted' : 'text-fg'}`}>{local.name}</div>
          {local.path && (
            <p className="truncate font-mono text-caption text-faint" title={local.path}>
              <span className="sr-only">Folder: </span>
              {middleTruncatePath(local.path, 64)}
            </p>
          )}
          {missing && <p className="mt-1 text-small text-warning" role="status">{missing}</p>}
          {noGit && <p className="mt-1 text-caption text-muted">{noGit}</p>}
          {commands.length > 0 && (
            <div className="mt-2">
              <p className="text-caption text-muted">{PROJECT_LOCAL_COMMANDS_LABEL}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`${PROJECT_LOCAL_COMMANDS_LABEL} in ${local.name}`}>
                {commands.map((name) => (
                  <li key={name} className="rounded-md border border-border bg-subtle px-2 py-0.5 font-mono text-caption text-fg">{name}</li>
                ))}
              </ul>
              <p className="mt-1 text-caption text-faint">{PROJECT_LOCAL_COMMANDS_HINT}</p>
            </div>
          )}
          {tools.servers.length > 0 && (
            <div className="mt-2">
              <p className="text-caption text-muted">{PROJECT_LOCAL_TOOL_SERVERS_LABEL}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`${PROJECT_LOCAL_TOOL_SERVERS_LABEL} in ${local.name}`}>
                {tools.servers.map((server) => (
                  <li
                    key={server.name}
                    className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-caption ${server.connected ? 'border-border bg-subtle text-fg' : 'border-warning/40 bg-warning-tint text-fg'}`}
                  >
                    {server.connected
                      ? <CheckCircle2 className="h-3 w-3 shrink-0 text-success" aria-hidden />
                      : <CircleAlert className="h-3 w-3 shrink-0 text-warning" aria-hidden />}
                    <span className="font-mono">{server.name}</span>
                    <span className="sr-only">{server.connected ? 'connected' : 'not connected'}</span>
                  </li>
                ))}
              </ul>
              {tools.missingLine && (
                <p className="mt-1 text-caption text-muted" role="status">
                  {tools.missingLine}{' '}
                  <Link to="/connect" className="font-semibold text-primary hover:underline">Open Connect</Link>
                </p>
              )}
            </div>
          )}
        </div>
        {!readOnly && !confirming && (
          <Button
            variant={missing ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Remove the local project ${local.name} from this project`}
          >
            Remove
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7" role="group" aria-label={`Confirm removing ${local.name}`}>
          <span className="text-small text-fg">
            {missing
              ? 'Remove this local project from the project?'
              : 'Remove this local project from the project? The folder and everything in it stay where they are.'}
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { void remove(); }}>{busy ? 'Removing…' : 'Remove'}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 pl-7 text-caption text-danger">{error}</p>}
    </li>
  );
}

export function LinkLocalProject({ projectId, resources, onSaved, onClose }: {
  projectId: string;
  /** What the project already holds, so a linked folder is marked and not offered again. */
  resources: readonly ProjectResourceView[];
  onSaved: (overview: ProjectOverview) => void;
  onClose: () => void;
}) {
  // The machine's own roster, read each time the picker opens.
  const roster = usePoll(projectKeys.localProjects, getLocalProjects, 0);
  // The folders a refusal sent back to choose from replace what was read.
  const [offered, setOffered] = useState<ProjectLocalProject[] | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choices = projectLocalProjectChoices(offered ?? roster.data ?? [], resources);
  const open = choices.filter((choice) => !choice.linked);

  const link = async () => {
    if (!path || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await linkLocalProject(projectId, path);
      if (result.kind === 'linked') { onSaved(result.overview); onClose(); return; }
      setOffered(result.localProjects);
      setPath('');
      setError(projectLocalProjectRefusal(result.kind === 'choose' ? 'LOCAL_PROJECT_CHOICE_REQUIRED' : 'LOCAL_PROJECT_NOT_FOUND', result.named)
        ?? 'Choose which local project to link.');
    } catch (failure) {
      setError(refusalText(failure, 'The local project could not be linked. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const footer = (canLink: boolean) => (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
      {canLink && (
        <Button type="submit" size="sm" disabled={busy || !path}>{busy ? 'Linking…' : 'Link local project'}</Button>
      )}
    </div>
  );

  if (roster.isLoading && !offered) {
    return (
      <div>
        <div role="status" className="mb-4 space-y-2">
          <p className="text-small text-muted">Looking through the code folders on this Mac. The first time can take a few seconds.</p>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        {footer(false)}
      </div>
    );
  }
  if (roster.isError && !roster.data && !offered) {
    return (
      <div>
        <p role="alert" className="mb-4 text-small text-danger">
          The code folders on this Mac could not be read.{' '}
          <button type="button" className="font-semibold text-primary hover:underline cursor-pointer" onClick={() => { void roster.refetch(); }}>Try again</button>
        </p>
        {footer(false)}
      </div>
    );
  }
  if (choices.length === 0) {
    return (
      <div>
        <p className="mb-4 text-small text-muted">
          No code folders are set up on this Mac yet.{' '}
          <Link to="/connect" className="font-semibold text-primary hover:underline">Add one in Connect</Link>, then link it here.
        </p>
        {footer(false)}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void link(); }}>
      <fieldset className="mb-4" disabled={busy}>
        <legend className="mb-1 text-label text-fg">Link a local project</legend>
        <p className="mb-2 text-caption text-muted">
          The code folders on this Mac. Linking one says where this project’s work happens; it changes nothing in the folder.
        </p>
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {choices.map(({ localProject, linked }) => (
            <label
              key={localProject.path}
              className={cn(
                'flex items-start gap-2.5 rounded-md border border-border px-3 py-2 transition-colors',
                linked ? 'cursor-default bg-subtle' : 'cursor-pointer hover:bg-hover has-[:checked]:border-primary has-[:checked]:bg-primary-tint',
              )}
            >
              {linked ? (
                <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-success" aria-hidden />
              ) : (
                <input
                  type="radio"
                  name="local-project"
                  value={localProject.path}
                  checked={path === localProject.path}
                  onChange={() => { setPath(localProject.path); setError(''); }}
                  className="mt-1 h-4 w-4 shrink-0 accent-primary"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className={`truncate text-small font-semibold ${linked ? 'text-muted' : 'text-fg'}`}>{localProject.name}</span>
                  {localProject.type && <span className="text-caption text-faint">{localProject.type}</span>}
                  {linked && <span className="text-caption font-semibold text-success">Already linked</span>}
                  {!linked && !localProject.git && <span className="text-caption text-faint">not a git repository</span>}
                </span>
                <span className="block truncate font-mono text-caption text-faint" title={localProject.path}>
                  {middleTruncatePath(localProject.path, 60)}
                </span>
              </span>
            </label>
          ))}
        </div>
        {open.length === 0 && (
          <p className="mt-2 text-small text-muted">
            Every code folder on this Mac is already linked. <Link to="/connect" className="font-semibold text-primary hover:underline">Add another in Connect</Link>.
          </p>
        )}
      </fieldset>
      {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
      {footer(open.length > 0)}
    </form>
  );
}
